const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const axios = require('axios');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY
});

// Fetch live services from DB for system prompt injection
async function fetchServicesForPrompt() {
    try {
        const { data, error } = await supabase
            .from('services')
            .select('name, price, delivery_days, description')
            .eq('is_active', true)
            .order('price');
        if (error || !data || !data.length) return null;
        return data.map(s => {
            const days = s.delivery_days || 'varies';
            const desc = s.description || '';
            return `- ${s.name}: Rs.${s.price} — ${desc}${desc ? ' ' : ''}(Delivery: ${days})`;
        }).join('\n');
    } catch { return null; }
}

const rawEndpoint = process.env.B2_ENDPOINT || '';
const B2_ENDPOINT = rawEndpoint.startsWith('http') ? rawEndpoint : `https://${rawEndpoint || 's3.us-east-005.backblazeb2.com'}`;
const extractedRegion = (B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || 'us-east-005';

const b2 = new S3Client({
    region: extractedRegion,
    endpoint: B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
});

const B2_BUCKET = process.env.B2_BUCKET_NAME;

// Short-term memory store — keyed per session, TTL 30 mins
const memoryStore = {};

// ── NEW: Action history for undo functionality ──
// Stores last 5 executed actions per session with original state
const actionHistoryStore = {};
const MAX_HISTORY_PER_SESSION = 5;

// ── Cache B2 file-check results (5-min TTL) ───────────────────────
let _filesMapCache = { data: {}, expiresAt: 0 };
const FILES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getFilesMap(activeOrders) {
    const now = Date.now();
    if (now < _filesMapCache.expiresAt) {
        return _filesMapCache.data;
    }
    const fileCheckResults = await Promise.allSettled(
        activeOrders.map(o =>
            b2.send(new ListObjectsV2Command({ Bucket: B2_BUCKET, Prefix: `${o.order_id}/`, MaxKeys: 1 }))
                .then(data => ({ order_id: o.order_id, has_files: (data.KeyCount || 0) > 0 }))
        )
    );
    const freshMap = {};
    fileCheckResults.forEach(r => { if (r.status === 'fulfilled') freshMap[r.value.order_id] = r.value.has_files; });
    _filesMapCache = { data: freshMap, expiresAt: now + FILES_CACHE_TTL_MS };
    return freshMap;
}

const formatDate = (dateStr) => {
    if (!dateStr) return 'None';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return 'Invalid Date';
        const day = d.getUTCDate();
        const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const suffix = [11, 12, 13].includes(day) ? 'th' : ['st', 'nd', 'rd'][((day % 10) - 1)] || 'th';
        return `${day}${suffix} ${months[d.getUTCMonth()]}, ${d.getUTCFullYear()}`;
    } catch { return 'Error'; }
};

module.exports = async function (req, res) {
    const _allowed = ['https://zyroeditz.xyz','https://www.zyroeditz.xyz','https://admin.zyroeditz.xyz','https://zyroeditz.vercel.app'];
    const _origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', _allowed.includes(_origin) ? _origin : _allowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { prompt, sessionId = 'default', attachment } = req.body;
        if (!prompt && !attachment) return res.status(400).json({ error: 'No input' });

        // 🔒 JWT Auth
        const authHeader = req.headers['authorization'];
        if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
        const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7));
        if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

        const now = Date.now();
        const SESSION_TTL = 30 * 60 * 1000;

        // Session memory management
        if (!memoryStore[sessionId]) memoryStore[sessionId] = [];
        const sessionMemory = memoryStore[sessionId].filter(m => now - m.timestamp < SESSION_TTL);

        // ── Fetch all data in parallel for full studio context ─────────────────
        const [
            { data: allOrders, error: fetchError },
            { data: deliveries },
            { data: reviews },
            { data: coupons },
            { data: referrals }
        ] = await Promise.all([
            supabase.from('orders').select('order_id,client_name,client_email,service,amount,status,created_at,deadline_date,completed_at').order('created_at', { ascending: false }),
            supabase.from('deliveries').select('order_id,file_name,created_at').order('created_at', { ascending: false }),
            supabase.from('reviews').select('order_id,rating,review_text,approved,created_at'),
            supabase.from('coupons').select('code,discount_type,discount_value,times_used,is_active'),
            supabase.from('referrals').select('referrer_id,referred_email,created_at')
        ]);

        if (fetchError) throw new Error(`Database error: ${fetchError.message}`);

        const orders      = allOrders  || [];
        const dlvs        = deliveries || [];
        const rvws        = reviews    || [];
        const cpns        = coupons    || [];
        const refs        = referrals  || [];
        const todayStr    = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });
        const nowIST      = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

        // ── Revenue metrics ────────────────────────────────────────────────────
        const paidOrders  = orders.filter(o => ['paid','delivered','in_progress'].includes(o.status));
        const totalRev    = paidOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const monthRev    = paidOrders.filter(o => o.created_at && new Date(o.created_at).getMonth() === nowIST.getMonth() && new Date(o.created_at).getFullYear() === nowIST.getFullYear()).reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const refundedAmt = orders.filter(o => o.status === 'refunded').reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const cancelledCt = orders.filter(o => ['cancelled','canceled'].includes(o.status)).length;

        // ── Client metrics ─────────────────────────────────────────────────────
        const uniqueClients  = [...new Set(orders.map(o => o.client_name).filter(Boolean))];
        const arpu           = uniqueClients.length ? (totalRev / uniqueClients.length).toFixed(2) : '0';
        const repeatClients  = uniqueClients.filter(n => orders.filter(o => o.client_name === n).length > 1);
        const retention      = uniqueClients.length ? ((repeatClients.length / uniqueClients.length) * 100).toFixed(1) : '0';
        const whales         = uniqueClients.map(n => ({ n, t: orders.filter(o => o.client_name === n).reduce((s, o) => s + (Number(o.amount)||0), 0) })).filter(c => c.t >= 2000).sort((a,b) => b.t - a.t);

        // ── Pipeline ───────────────────────────────────────────────────────────
        const activeOrders   = orders.filter(o => !['delivered','refunded','cancelled','canceled','completed'].includes(o.status));
        const filesMap       = await getFilesMap(activeOrders);
        const ghostLeads     = activeOrders.filter(o => o.status === 'created' && o.created_at && (Date.now() - new Date(o.created_at).getTime()) > 48*3600*1000);

        // ── Overdue check ──────────────────────────────────────────────────────
        const overdueOrders  = activeOrders.filter(o => {
            if (!o.deadline_date) return false;
            const [dy,dm,dd] = o.deadline_date.split('-').map(Number);
            return new Date(dy, dm-1, dd) < nowIST;
        });

        // ── Deliveries context ─────────────────────────────────────────────────
        const deliveredOrderIds = new Set(orders.filter(o => o.status === 'delivered').map(o => o.order_id));
        const recentDeliveries  = dlvs.slice(0, 10).map(d => `• ${d.file_name} (Order: ${d.order_id}) — ${formatDate(d.created_at)}`);

        // ── Reviews context ────────────────────────────────────────────────────
        const avgRating    = rvws.length ? (rvws.reduce((s,r) => s + (r.rating||0), 0) / rvws.length).toFixed(1) : 'N/A';
        const pendingRevs  = rvws.filter(r => !r.approved).length;
        const recentRevs   = rvws.slice(0,5).map(r => `• ${r.rating}★ — "${(r.review_text||'').slice(0,60)}…" [${r.approved ? 'approved' : 'pending'}]`);

        // ── Coupons context ────────────────────────────────────────────────────
        const activeCoupons = cpns.filter(c => c.is_active).map(c => `${c.code} (${c.discount_type === 'percent' ? c.discount_value+'%' : 'Rs.'+c.discount_value} off, used ${c.times_used}x)`);

        // ── Referrals context ──────────────────────────────────────────────────
        const totalRefs     = refs.length;
        const thisMonthRefs = refs.filter(r => r.created_at && new Date(r.created_at).getMonth() === nowIST.getMonth()).length;

        // ── Services ──────────────────────────────────────────────────────────
        const liveServicesBlock = (await fetchServicesForPrompt()) || [
            '- Short Form: Rs.200 — YouTube Shorts, Reels (2 Days)',
            '- Long Form: Rs.500 — Full YouTube videos, vlogs (4 Days)',
            '- Motion Graphics: Rs.400 — Effects, branding (4 Days)',
            '- Thumbnails: Rs.100 — Standalone designs (1 Day)',
            '- Sound Design: Rs.200 — Audio editing, SFX, music sync (3 Days)',
            '- Color Grading & Correction: Rs.175 — Cinematic color work (1 Day)',
        ].join('\n');

        // ── Active pipeline list ───────────────────────────────────────────────
        const pipelineLines = activeOrders.map(o =>
            `• [${(o.status||'').toUpperCase()}] ${o.client_name||'Unknown'} — ${o.service||'N/A'} — Rs.${Number(o.amount)||0}${filesMap[o.order_id] ? ' 📁' : ''} — ID: ${o.order_id}${o.deadline_date ? ' — Due: '+o.deadline_date : ''}`
        );

        const systemPrompt = `You are Zyro, the studio manager AI for ZyroEditz. You know everything about the business — orders, money, clients, deliveries, reviews. You're chill, sharp, and straight to the point. No fluff, no corporate speak. Talk like a smart colleague who knows the numbers cold.

Read-only: you can see everything but can't touch the DB. If someone asks you to do something, tell them to use the dashboard. Don't make up data — only use what's below.

${todayStr}
Revenue: Rs.${totalRev.toFixed(2)} lifetime | Rs.${monthRev.toFixed(2)} this month | Refunded: Rs.${refundedAmt.toFixed(2)} | Cancelled: ${cancelledCt} | ARPU: Rs.${arpu} | Retention: ${retention}% | Margin: ~97%${whales.length ? ` | Top clients: ${whales.map(c=>`${c.n} Rs.${c.t}`).join(', ')}` : ''}

Pipeline (${activeOrders.length} active):
${pipelineLines.length ? pipelineLines.join('\n') : 'Clear.'}${ghostLeads.length ? `\n⚠️ ${ghostLeads.length} stale unpaid lead(s) >48h` : ''}${overdueOrders.length ? `\n🚨 Overdue: ${overdueOrders.map(o=>`${o.order_id} — ${o.client_name}`).join(', ')}` : ''}

Deliveries (last 10): ${recentDeliveries.length ? '\n'+recentDeliveries.join('\n') : 'None yet'}

Reviews: ${rvws.length} total | ${avgRating}★ avg | ${pendingRevs} pending approval${recentRevs.length ? '\n'+recentRevs.join('\n') : ''}

Coupons active: ${activeCoupons.length ? activeCoupons.join(' | ') : 'None'}
Referrals: ${totalRefs} total | ${thisMonthRefs} this month
Clients: ${uniqueClients.length} unique | ${repeatClients.length} repeat

Services:
${liveServicesBlock}`;

        let finalPrompt = prompt || '';
        let hasImage = false;
        let selectedModel = 'llama-3.3-70b-versatile';
        let userMessageContent = finalPrompt;

        if (attachment) {
            if (attachment.type === 'pdf') {
                finalPrompt = `[Attached Document: ${attachment.name}]\n\n${attachment.data}\n\nUser Message:\n${finalPrompt}`;
                userMessageContent = finalPrompt;
            } else if (attachment.type === 'image') {
                hasImage = true;
                selectedModel = 'meta-llama/llama-4-scout-17b-16e-instruct';
                userMessageContent = [
                    { type: 'text', text: finalPrompt || 'Please describe this image.' },
                    { type: 'image_url', image_url: { url: attachment.data } }
                ];
            }
        }

        const currentMessages = [
            { role: 'system', content: systemPrompt },
            ...sessionMemory.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: userMessageContent }
        ];

        let aiResponse = await groq.chat.completions.create({
            model: selectedModel,
            messages: currentMessages,
            temperature: 0.45,
            max_tokens: hasImage ? 1024 : 900
        });

        let rawContent = aiResponse.choices[0].message.content;

        // ── Update memory (Strict Read-Only) ────────────────────────────────
        sessionMemory.push({ 
            role: 'user', 
            content: finalPrompt + (hasImage ? ` [Attached Image]` : ''), 
            timestamp: now 
        });
        sessionMemory.push({ 
            role: 'assistant', 
            content: rawContent, 
            timestamp: now 
        });
        
        if (sessionMemory.length > 10) sessionMemory.splice(0, 2);
        memoryStore[sessionId] = sessionMemory;

        return res.status(200).json({
            reply: rawContent.trim(),
            actions: [] // No actions allowed
        });

    } catch (err) {
        console.error('Admin Chat Critical Error:', err);
        return res.status(500).json({ error: 'System error in Zyro AI Terminal' });
    }
};
