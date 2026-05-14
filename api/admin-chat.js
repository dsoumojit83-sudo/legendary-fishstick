const OpenAI = require('openai');
const { getSupabase } = require('../lib/supabase');
const { getB2, B2_BUCKET } = require('../lib/b2');
const { setCors } = require('../lib/cors');
const { requireAdmin } = require('../lib/auth');
const { ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const axios = require('axios');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = getSupabase();
const b2 = getB2();
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
            return `- ${s.name}: ₹${s.price} — ${desc}${desc ? ' ' : ''}(Delivery: ${days})`;
        }).join('\n');
    } catch { return null; }
}


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
    if (setCors(req, res)) return res.status(200).end();

    try {
        const { prompt, sessionId = 'default', attachment } = req.body;
        if (!prompt && !attachment) return res.status(400).json({ error: 'No input' });
        if (prompt && String(prompt).length > 2000) return res.status(400).json({ error: 'Message too long. Max 2000 characters.' });

        // 🔒 JWT Auth + Admin RBAC
        const user = await requireAdmin(req, res);
        if (!user) return;

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
            { data: referrals },
            { data: teamAdmins }
        ] = await Promise.all([
            supabase.from('orders').select('order_id,client_name,client_email,service,amount,status,created_at,deadline_date,completed_at').order('created_at', { ascending: false }),
            supabase.from('deliveries').select('order_id,file_name,created_at').order('created_at', { ascending: false }),
            supabase.from('reviews').select('order_id,rating,review_text,approved,created_at'),
            supabase.from('coupons').select('code,discount_type,discount_value,times_used,is_active'),
            supabase.from('referrals').select('referrer_id,referred_email,created_at'),
            supabase.from('admins').select('email, role, full_name')
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
            '- Short Form: ₹200 — YouTube Shorts, Reels (2 Days)',
            '- Long Form: ₹500 — Full YouTube videos, vlogs (4 Days)',
            '- Motion Graphics: ₹400 — Effects, branding (4 Days)',
            '- Thumbnails: ₹100 — Standalone designs (1 Day)',
            '- Sound Design: ₹200 — Audio editing, SFX, music sync (3 Days)',
            '- Color Grading & Correction: ₹175 — Cinematic color work (1 Day)',
        ].join('\n');

        // ── Active pipeline list ───────────────────────────────────────────────
        const pipelineLines = activeOrders.map(o =>
            `• [${(o.status||'').toUpperCase()}] ${o.client_name||'Unknown'} — ${o.service||'N/A'} — ₹${Number(o.amount)||0}${filesMap[o.order_id] ? ' 📁' : ''} — ID: ${o.order_id}${o.deadline_date ? ' — Due: '+o.deadline_date : ''}`
        );

        const systemPrompt = `You are Zyro — the internal studio manager AI for ZyroEditz, a premium video editing studio founded by Soumojit Das. ZyroEditz specializes in cinematic-quality video editing for YouTube creators, Instagram influencers, and content brands. The studio offers services like Short Form edits (Reels/Shorts), Long Form edits (vlogs, podcasts), Motion Graphics, Thumbnails, Sound Design, and Color Grading.

TECH STACK: Orders are processed via Cashfree (payment gateway). Files are stored on Backblaze B2 cloud storage. The database runs on Supabase. The website is deployed on Vercel. Client deliveries happen through a secure file portal.

YOUR PERSONALITY:
- You talk like Soumojit's right-hand person — casual, confident, direct. Like a smart friend who runs the ops.
- Use natural, conversational language. Say "we've made" not "the studio has generated". Say "they ordered" not "a transaction was initiated".
- Be specific with numbers — don't say "a good amount", say the exact figure.
- When asked about business health, give real talk — if revenue is low, say it. If a client is ghosting, flag it.
- Keep responses concise but complete. Don't pad with filler.

BANNED WORDS & PHRASES — NEVER use these:
"snapshot", "overview", "breakdown", "let me break this down", "here's a quick", "as of now", "based on the data", "it appears that", "I'd be happy to", "certainly", "absolutely", "great question", "let me provide", "in terms of", "with respect to", "it's worth noting", "as per", "facilitate", "leverage", "utilize", "streamline", "robust", "comprehensive", "paradigm", "synergy", "stakeholder", "actionable insights", "moving forward", "at this point in time", "circle back"

Instead say things naturally like: "right now we've got...", "so here's the deal...", "yeah that order is...", "nah, nothing overdue", "heads up though —"

RULES:
- Read-only — you can see everything but can NOT modify the database. If someone asks to change something, tell them to do it from the dashboard directly.
- Never make up data. Only reference what's provided below. If you don't have info on something, just say you don't have it.
- When listing orders or clients, include the actual names, amounts, and statuses — don't summarize into vague categories.
- Format currency as ₹ (not Rs.). Example: ₹500, not Rs.500.

TODAY: ${todayStr}

═══ REVENUE ═══
Total lifetime: ₹${totalRev.toFixed(2)}
This month: ₹${monthRev.toFixed(2)}
Refunded: ₹${refundedAmt.toFixed(2)}
Cancelled orders: ${cancelledCt}
Average revenue per client (ARPU): ₹${arpu}
Client retention rate: ${retention}%
Profit margin: ~97% (digital service, near-zero COGS)${whales.length ? `\nTop spending clients: ${whales.map(c => `${c.n} (₹${c.t})`).join(', ')}` : ''}

═══ ACTIVE PIPELINE (${activeOrders.length} orders) ═══
${pipelineLines.length ? pipelineLines.join('\n') : 'All clear — no active orders right now.'}${ghostLeads.length ? `\n⚠️ STALE LEADS: ${ghostLeads.length} unpaid order(s) sitting for 48+ hours — might be dead leads` : ''}${overdueOrders.length ? `\n🚨 OVERDUE: ${overdueOrders.map(o => `${o.order_id} (${o.client_name})`).join(', ')}` : ''}

═══ RECENT DELIVERIES ═══
${recentDeliveries.length ? recentDeliveries.join('\n') : 'No deliveries recorded yet.'}

═══ REVIEWS ═══
Total reviews: ${rvws.length} | Average rating: ${avgRating}★ | Pending approval: ${pendingRevs}
${recentRevs.length ? 'Recent:\n' + recentRevs.join('\n') : 'No recent reviews.'}

═══ COUPONS ═══
Active: ${activeCoupons.length ? activeCoupons.join(' | ') : 'None active right now.'}

═══ REFERRALS ═══
Total: ${totalRefs} | This month: ${thisMonthRefs}

═══ CLIENTS ═══
${uniqueClients.length} unique clients | ${repeatClients.length} returning/repeat clients

═══ SERVICES CATALOG ═══
${liveServicesBlock}

═══ TEAM (Admins with Command Center access) ═══
- Soumojit Das (zyroeditz.official@gmail.com) — Super Admin / Founder
${(teamAdmins || []).filter(a => a.email.toLowerCase() !== 'zyroeditz.official@gmail.com').map(a => `- ${a.full_name || a.email} (${a.email}) — ${a.role || 'admin'}`).join('\n') || 'No additional admins.'}
You are currently talking to: ${user.email}`;

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
            temperature: 0.55,
            max_tokens: hasImage ? 1024 : 1200
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
        // Structured log so error surfaces clearly in Vercel function logs
        console.error('[ZYRO][admin-chat][ERROR]', new Date().toISOString(),
            '| type:', err.constructor?.name,
            '| message:', err.message,
            '| body_preview:', typeof req.body === 'object' ? JSON.stringify(req.body)?.slice(0, 200) : String(req.body)?.slice(0, 200)
        );
        return res.status(500).json({ error: 'Internal AI error. Please try again.' });
    }
};
