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

const B2_ENDPOINT = process.env.B2_ENDPOINT || '';
const extractedRegion = (B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || 'us-west-004';

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
    // CORS configuration
    const origin = req.headers.origin;
    const allowedOrigins = [
        'https://zyroeditz.xyz',
        'https://www.zyroeditz.xyz',
        'https://admin.zyroeditz.xyz',
        'https://zyroeditz.vercel.app'
    ];
    
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { prompt, sessionId = 'default', attachment } = req.body;
        if (!prompt && !attachment) return res.status(400).json({ error: 'No input' });

        // 🔒 JWT Auth — same guard as admin-data.js and settlements.js
        const authHeader = req.headers['authorization'];
        if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
        const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7));
        if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

        const now = Date.now();
        const SESSION_TTL = 30 * 60 * 1000;

        // Session memory management
        if (!memoryStore[sessionId]) memoryStore[sessionId] = [];
        const sessionMemory = memoryStore[sessionId].filter(m => now - m.timestamp < SESSION_TTL);

        // B-09 FIX: Evict fully-expired sessions from all in-memory stores to prevent
        // unbounded memory growth on warm Vercel instances with many unique sessions.
        Object.keys(memoryStore).forEach(id => {
            if (id === sessionId) return; // skip active session
            const msgs = memoryStore[id];
            if (!msgs.length || now - msgs[msgs.length - 1].timestamp > SESSION_TTL) {
                delete memoryStore[id];
            }
        });

        // ── Fetch data ─────────────────────────────────────────────────────────
        const { data: allOrders, error: fetchError } = await supabase
            .from('orders')
            .select('order_id, client_name, client_email, client_phone, service, amount, status, created_at, deadline_date, completed_at')
            .order('created_at', { ascending: false });

        if (fetchError) throw new Error(`Database error: ${fetchError.message}`);

        const orders = allOrders || [];
        const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

        // Fetch live services for system prompt
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

        // BUG FIX D+E: Only count paid/completed orders as real revenue.
        const paidOrders = orders.filter(o => o.status === 'paid' || o.status === 'completed');
        const totalRev = paidOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0).toFixed(2);
        const currentMonth = new Date().getMonth();
        const monthRev = paidOrders
            .filter(o => o.created_at && new Date(o.created_at).getMonth() === currentMonth)
            .reduce((s, o) => s + (Number(o.amount) || 0), 0)
            .toFixed(2);

        const activeOrders = orders.filter(o => o.status && !['completed', 'refunded', 'cancelled'].includes(o.status));
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
        const pendingClearance = 0; // all counted revenue is already settled

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
            return orderTime < twoDaysAgo && o.status === 'pending';
        });

        // ────────────────────────────────────────────────────────────────────────
        // SYSTEM PROMPT — Enhanced with enforced confirmation flow
        // ────────────────────────────────────────────────────────────────────────
        const systemPrompt = `You are Zyro, a smart, friendly assistant built specifically for Soumojit Das who runs ZyroEditz — a video editing studio.

You talk like a real person, not a robot. You're helpful, a bit casual, and genuinely invested in making the studio run well. You know everything about the business in real-time.

Today's date (IST): ${todayStr}

---

BUSINESS SNAPSHOT:
- Lifetime revenue: Rs.${totalRev}
- This month: Rs.${monthRev}
- Avg revenue per client: Rs.${arpu}
- Client retention rate: ${retentionRate}%
- Cleared to bank: Rs.${totalSettled.toFixed(2)} | Locked in gateway: Rs.${Math.max(0, pendingClearance).toFixed(2)}
- Profit margin after Cashfree fees: ${profitMargin}
- High-value clients: ${whaleClients.length > 0 ? whaleClients.join(', ') : 'None yet'}
- Stale leads (no action 48h+): ${ghostLeads.length > 0 ? ghostLeads.map(o => `${o.client_name} - ${o.service} (${o.order_id})`).join(', ') : 'None'}

ACTIVE PIPELINE:
${activePipeline.length > 0 ? activePipeline.join('\n') : 'No active projects right now.'}

---

NOTE: You are a read-only assistant. You CANNOT modify the database, update statuses, cancel orders, or process refunds. You can only query and summarize data. If Soumojit asks you to update an order or create a new one, explain that you can only view data and he must use the admin dashboard or direct the client to zyroeditz.xyz.

--- 
INSTANT ACTIONS:
If you need to query the database, you can emit an ACTION block bypassing confirmation. The system will intercept it and give you the data to answer the user!

Search Orders:
<<<ACTION: {"type": "search_orders", "query": "client name or id or email"} >>>
---

ADDITIONAL RULES:

1. RESTRICTIONS:
   - You CANNOT edit financial amounts (amount field)
   - If asked, direct Soumojit to use the main interface for proper invoice generation

2. SMART CONTEXT:
   - If asked about "the last order" or a client name without an ID, find the exact match first
   
3. DATA PRECISION:
   - Always prioritize information provided in the LATEST user message over session memory.
   - Capture the Client's Email EXACTLY as they provide it. Do not guess or use old emails if a new one is shared.

---

PERSONALITY & STYLE:
- Talk like a knowledgeable friend, not a computer terminal
- Keep it short and direct unless Soumojit asks for detail
- Use natural language ("here's what I found", "looks like", "yeah", "sure") — avoid formal filler
- Call him Soumojit or just skip the name — never "Sir" or "Boss" repeatedly
- If you don't know something, say so honestly
- When giving lists, use bullet points — keep each line tight
- Don't start every message the same way — vary your tone naturally
- Use emojis naturally where they add personality or clarity. Don't spam them — 1-2 per message max, only where they genuinely fit.

SERVICES & PRICING:
${liveServicesBlock}

Revision policy: 1 free revision included with every order.
Refund policy: Full refund if client isn't happy with the final cut.
  
PORTFOLIO: Hosted at '/portfolio/' — direct clients there for samples or past work.`;

        // ── Build messages with memory ────────────────────────────────────────
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

        // ── Check for instantaneous database SEARCH action ──
        const searchRegex = /<<<ACTION:\s*(\{.*?type.*?search_orders.*?\})\s*>>>/i;
        const searchMatch = searchRegex.exec(rawContent);
        if (searchMatch) {
            try {
                const searchObj = JSON.parse(searchMatch[1]);
                if (searchObj.query) {
                    const { data: searchResults } = await supabase
                        .from('orders')
                        .select('*')
                        .or(`client_name.ilike.%${searchObj.query}%,order_id.eq.${searchObj.query},client_email.ilike.%${searchObj.query}%`)
                        .limit(10);
                    
                    const resultsText = searchResults && searchResults.length > 0 
                        ? searchResults.map(o => `[ID:${o.order_id} | Client:${o.client_name} | Email:${o.client_email} | Phone:${o.client_phone} | Service:${o.service} | Status:${o.status} | Amount:${o.amount}]`).join('\n')
                        : 'No matching orders found.';

                    currentMessages.push({ role: 'assistant', content: rawContent });
                    currentMessages.push({ role: 'system', content: `[Database Search Results for "${searchObj.query}"]:\n${resultsText}\n\nContinue responding to the user using these results without using the search_orders action again.` });

                    aiResponse = await groq.chat.completions.create({
                        model: selectedModel,
                        messages: currentMessages,
                        temperature: 0.55,
                        max_tokens: 600
                    });
                    rawContent = aiResponse.choices[0].message.content;
                }
            } catch (e) {
                console.log("Search parsing error:", e);
            }
        }

        // ── Clean up ACTION tags from final response just in case ──
        let cleanText = rawContent.replace(/<<<ACTION:\s*\{[\s\S]*?\}\s*>>>/g, '').trim();
        cleanText = cleanText.replace(/\n{3,}/g, '\n\n');

        // ── Update memory ─────────────────────────────────────────────────────
        sessionMemory.push({ 
            role: 'user', 
            content: finalPrompt + (hasImage ? ` [Attached Image: ${attachment.name}]` : ''), 
            timestamp: now 
        });
        sessionMemory.push({ 
            role: 'assistant', 
            content: cleanText, 
            timestamp: now 
        });
        
        if (sessionMemory.length > 20) sessionMemory.splice(0, 2);
        memoryStore[sessionId] = sessionMemory;

        return res.status(200).json({
            reply: cleanText
        });

    } catch (err) {
        console.error('Admin Chat Error:', err);
        return res.status(500).json({ error: 'Something went wrong on my end.' });
    }
};
