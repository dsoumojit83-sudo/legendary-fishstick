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

        // ── Fetch data ─────────────────────────────────────────────────────────
        const { data: allOrders, error: fetchError } = await supabase
            .from('orders')
            .select('order_id, client_name, client_email, client_phone, service, amount, status, created_at, deadline_date, completed_at')
            .order('created_at', { ascending: false });

        if (fetchError) throw new Error(`Database error: ${fetchError.message}`);

        const orders = allOrders || [];
        const todayStr = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

        const fetchedServicesBlock = await fetchServicesForPrompt();
        const _fallbackServices = [
            '- Short Form: Rs.200 — YouTube Shorts, Reels (Delivery: 2 Days)',
            '- Long Form: Rs.500 — Full YouTube videos, vlogs (Delivery: 4 Days)',
            '- Motion Graphics: Rs.400 — Effects, branding (Delivery: 4 Days)',
            '- Thumbnails: Rs.100 — Standalone designs (Delivery: 1 Day)',
            '- Sound Design: Rs.200 — Audio editing, SFX, music sync (Delivery: 3 Days)',
            '- Color Grading & Correction: Rs.175 — Cinematic color work (Delivery: 1 Day)',
        ].join('\n');
        const liveServicesBlock = fetchedServicesBlock || _fallbackServices;

        const paidOrders = orders.filter(o => o.status === 'paid' || o.status === 'delivered' || o.status === 'in_progress');
        const totalRev = paidOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0).toFixed(2);
        const currentMonth = new Date().getMonth();
        const monthRev = paidOrders
            .filter(o => o.created_at && new Date(o.created_at).getMonth() === currentMonth)
            .reduce((s, o) => s + (Number(o.amount) || 0), 0)
            .toFixed(2);

        const refundedOrders = orders.filter(o => o.status === 'refunded');
        const totalRefunded = refundedOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0).toFixed(2);
        const activeOrders = orders.filter(o => o.status && !['completed', 'delivered', 'refunded', 'cancelled', 'canceled'].includes(o.status));
        const filesMap = await getFilesMap(activeOrders);

        const activePipeline = activeOrders.map(o => {
            const amt = Number(o.amount) || 0;
            const hasFiles = filesMap[o.order_id] ? '📁' : '';
            return `• ${o.client_name || 'Unknown'} - ${o.service || 'N/A'} (Rs.${amt}) [${o.status}] ${hasFiles} - Order: ${o.order_id}`;
        });

        const uniqueClients = [...new Set(orders.map(o => o.client_name).filter(Boolean))];
        const arpu = uniqueClients.length > 0 ? (Number(totalRev) / uniqueClients.length).toFixed(2) : '0.00';
        const repeatClients = uniqueClients.filter(name => orders.filter(o => o.client_name === name).length > 1);
        const retentionRate = uniqueClients.length > 0 ? ((repeatClients.length / uniqueClients.length) * 100).toFixed(1) : '0.0';
        const totalSettled = Number(totalRev);
        const profitMargin = totalSettled > 0 ? `97.0% (after 3% Cashfree gateway fee)` : 'N/A';

        const whaleClients = uniqueClients
            .map(name => ({
                name,
                total: orders.filter(o => o.client_name === name).reduce((s, o) => s + (Number(o.amount) || 0), 0)
            }))
            .filter(c => c.total >= 2000)
            .sort((a, b) => b.total - a.total)
            .map(c => c.name);

        const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
        const ghostLeads = activeOrders.filter(o => {
            if (!o.created_at) return false;
            const orderTime = new Date(o.created_at).getTime();
            return orderTime < twoDaysAgo && o.status === 'created';
        });

        const systemPrompt = `You are Zyro, a smart, friendly, READ-ONLY data assistant for ZyroEditz. You cannot change, update, cancel, or delete anything in the database. Your job is only to provide insights and answer questions based on the provided data.

Today: ${todayStr}

SNAPSHOT:
- Lifetime revenue: Rs.${totalRev}
- This month: Rs.${monthRev}
- Avg revenue per client: Rs.${arpu}
- Retention: ${retentionRate}%
- Cleared to bank: Rs.${totalSettled.toFixed(2)}
- Profit margin after fees: ${profitMargin}
- Refunded: Rs.${totalRefunded}
- Whales: ${whaleClients.join(', ') || 'None'}
- Stale leads: ${ghostLeads.length}

ACTIVE PIPELINE:
${activePipeline.join('\n') || 'None'}

RULES:
1. READ-ONLY: You are a data-analysis tool. You cannot modify, update, or delete any data.
2. If asked to perform an action, politely state that you are in read-only mode for security and that the admin must use the dashboard buttons.
3. Personality: Friendly, direct, helpful assistant. Avoid formalities. Use emojis sparingly.

SERVICES:
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
            temperature: 0.55,
            max_tokens: hasImage ? 1024 : 600
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
