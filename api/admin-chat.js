const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY
});

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
// ⚠️  BUG NOTE #4: This is in-process memory. Vercel serverless functions are STATELESS.
// On cold starts or when requests hit different function instances, this map is wiped
// entirely and sessions lose their history. For production-grade persistence, migrate
// this to a Supabase `chat_sessions` table or an Upstash Redis KV store.
const memoryStore = {};

// ── BUG FIX #5: Cache B2 file-check results (5-min TTL) ───────────────────────
// Previously, EVERY chat prompt triggered 1 B2 ListObjectsV2 call per active order.
// With 30 active orders that's 30 concurrent B2 API calls on every single message.
// Now the map is cached module-level and only refreshed once every 5 minutes.
let _filesMapCache = { data: {}, expiresAt: 0 };
const FILES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getFilesMap(activeOrders) {
    const now = Date.now();
    if (now < _filesMapCache.expiresAt) {
        // Cache is still valid — return the cached map without hitting B2
        return _filesMapCache.data;
    }
    // Cache expired — refresh from B2
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

// ─── Execute an action the AI decided to take ────────────────────────────────
// Valid actions: update_status, delete_order (future)
async function executeAction(action) {
    if (!action || !action.type) return null;

    if (action.type === 'update_status') {
        const { orderId, status } = action;
        if (!orderId || !status) return { success: false, error: 'Missing orderId or status' };

        const validStatuses = ['pending', 'in_progress', 'paid', 'completed'];
        if (!validStatuses.includes(status)) return { success: false, error: `Invalid status: ${status}` };

        const updatePayload = { status };
        if (status === 'completed') updatePayload.completed_at = new Date().toISOString();

        const { error } = await supabase
            .from('orders')
            .update(updatePayload)
            .eq('order_id', orderId);

        return error
            ? { success: false, error: error.message }
            : { success: true, orderId, newStatus: status };
    }

    if (action.type === 'update_order') {
        const { orderId, updates } = action;
        if (!orderId || !updates || typeof updates !== 'object') return { success: false, error: 'Missing orderId or updates' };

        const { error } = await supabase
            .from('orders')
            .update(updates)
            .eq('order_id', orderId);

        return error
            ? { success: false, error: error.message }
            : { success: true, orderId, actionType: 'updated fields' };
    }

    if (action.type === 'delete_order') {
        const { orderId } = action;
        if (!orderId) return { success: false, error: 'Missing orderId' };

        const { error } = await supabase
            .from('orders')
            .delete()
            .eq('order_id', orderId);

        return error
            ? { success: false, error: error.message }
            : { success: true, orderId, actionType: 'deleted' };
    }

    if (action.type === 'create_order') {
        const { record } = action;
        if (!record || typeof record !== 'object') return { success: false, error: 'Missing record details' };

        if (!record.order_id) {
            record.order_id = 'ZYRO' + Date.now().toString(16).toUpperCase() + Math.random().toString(16).substring(2, 6).toUpperCase();
        }

        const { error } = await supabase
            .from('orders')
            .insert(record);

        return error
            ? { success: false, error: error.message }
            : { success: true, orderId: record.order_id, actionType: 'created' };
    }

    return null;
}

// ─── Parse ALL action blocks out of AI response ─────────────────────────────
// The AI wraps actions in: <<<ACTION: {...} >>>
// When it acts on multiple orders it emits one block per order.
// The original single-match version left the extra blocks in the reply text,
// which the browser rendered as broken HTML (<<> artifacts).
function extractActions(text) {
    const regex = /<<<ACTION:\s*(\{[\s\S]*?\})\s*>>>/g;
    const actions = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        try { actions.push(JSON.parse(m[1])); } catch { /* skip malformed */ }
    }
    // Strip every action block from the text shown to the user
    let cleanText = text.replace(/<<<ACTION:\s*\{[\s\S]*?\}\s*>>>/g, '').trim();
    // Collapse any massive empty gaps left behind by stripped blocks
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
    return { cleanText, actions };
}

module.exports = async function (req, res) {
    // CORS headers — required when admin panel is served from a different origin
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // 🔒 JWT Auth
    const authJwt = req.headers['authorization'];
    if (!authJwt?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user: jwtUser }, error: jwtErr } = await supabase.auth.getUser(authJwt.slice(7));
    if (jwtErr || !jwtUser) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { prompt, sessionId = 'default' } = req.body;

        // ── Fetch all orders ──────────────────────────────────────────────────
        const { data: orders } = await supabase.from('orders').select('*');

        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const nowIST = new Date(Date.now() + IST_OFFSET_MS);
        const nowMs = nowIST.getTime();
        const todayStr = nowIST.toISOString().split('T')[0];
        const currentMonth = nowIST.getMonth();

        let totalRev = 0, monthRev = 0;
        let activeOrders = [], ghostLeads = [];
        let crmMap = {};
        const FORTY_EIGHT_HRS_MS = 48 * 60 * 60 * 1000;

        if (orders) {
            orders.forEach(o => {
                const amount = Number(o.amount) || 0;
                const clientName = o.client_name || 'Unknown Client';
                const date = new Date(o.created_at);
                const orderTimeMs = date.getTime() + IST_OFFSET_MS;

                if (o.status === 'paid' || o.status === 'completed') {
                    totalRev += amount;
                    if (date.getMonth() === currentMonth) monthRev += amount;
                } else if ((o.status === 'pending' || o.status === 'failed') && (nowMs - orderTimeMs > FORTY_EIGHT_HRS_MS)) {
                    ghostLeads.push(o);
                }

                if (['pending', 'in_progress', 'paid'].includes(o.status)) activeOrders.push(o);

                if (!crmMap[clientName]) {
                    crmMap[clientName] = { email: o.client_email || 'N/A', phone: o.client_phone || 'N/A', totalSpent: 0, count: 0, lastActive: o.created_at, projects: [] };
                }
                crmMap[clientName].projects.push(o.service);
                crmMap[clientName].count += 1;
                if (new Date(o.created_at) > new Date(crmMap[clientName].lastActive)) crmMap[clientName].lastActive = o.created_at;
                if (o.status === 'paid' || o.status === 'completed') crmMap[clientName].totalSpent += amount;
            });
        }

        const uniqueClientsCount = Object.keys(crmMap).length;
        const arpu = uniqueClientsCount > 0 ? (totalRev / uniqueClientsCount).toFixed(2) : 0;
        const repeatClients = Object.values(crmMap).filter(c => c.count > 1).length;
        const retentionRate = uniqueClientsCount > 0 ? ((repeatClients / uniqueClientsCount) * 100).toFixed(1) : 0;
        const whaleClients = Object.keys(crmMap).filter(n => crmMap[n].totalSpent > 1000 || crmMap[n].count >= 3).map(n => `${n} (LTV: Rs.${crmMap[n].totalSpent})`);

        // ── B2 file check (cached) — Bug 5 fix ─────────────────────────────────────
        const filesMap = await getFilesMap(activeOrders);

        const activePipeline = activeOrders.map(o => {
            const fileStatus = filesMap[o.order_id] ? 'Files received' : 'Waiting for files';
            let daysLeft = 'No deadline';
            if (o.deadline_date) {
                const diff = (new Date(o.deadline_date).getTime() + IST_OFFSET_MS - nowMs) / (1000 * 60 * 60 * 24);
                daysLeft = diff < 0 ? `OVERDUE by ${Math.abs(Math.floor(diff))} days` : `${Math.ceil(diff)} days left`;
            }
            return `[ID:${o.order_id} | Client:${o.client_name || 'N/A'} | Service:${o.service} | Status:${o.status} | Due:${formatDate(o.deadline_date)} (${daysLeft}) | Files:${fileStatus} | Notes:${o.project_notes || 'None'}]`;
        });

        // ── Full DB for complete access ───────────────────────────────────────
        const fullDatabaseLog = orders ? orders.map(o =>
            `[ID:${o.order_id}|Client:${o.client_name || 'N/A'}|Email:${o.client_email || 'N/A'}|Phone:${o.client_phone || 'N/A'}|Service:${o.service || 'N/A'}|Amt:Rs.${o.amount || 0}|Status:${o.status}|Booked:${formatDate(o.created_at)}|Due:${formatDate(o.deadline_date)}|Files:${filesMap[o.order_id] ? 'uploaded' : 'pending'}|Notes:${o.project_notes || 'None'}]`
        ).join('\n') : 'No records.';

        // ── Settlement physics ────────────────────────────────────────────────
        let totalSettled = 0, pendingClearance = 0, totalGatewayFees = 0;
        try {
            const globalBaseMdr = totalRev * 0.0225;
            totalGatewayFees = globalBaseMdr * 1.18;
            const FIFTEEN_MINS_MS = 15 * 60 * 1000;
            if (orders) {
                orders.forEach(o => {
                    if (o.status === 'paid' || o.status === 'completed') {
                        const mdr = (Number(o.amount) || 0) * 0.0225 * 1.18;
                        if ((Date.now() - new Date(o.created_at).getTime()) < FIFTEEN_MINS_MS) pendingClearance += (Number(o.amount) || 0) - mdr;
                    }
                });
            }
            totalSettled = Math.max(0, (totalRev - totalGatewayFees) - pendingClearance);
        } catch (e) { console.log('Settlement calc error:', e.message); }

        const profitMargin = totalRev > 0 ? (((totalRev - totalGatewayFees) / totalRev) * 100).toFixed(1) + '%' : '0%';

        // ── Payment method distribution (last 10 paid orders) ─────────────────
        let upiVol = 0, cardVol = 0, netVol = 0;
        try {
            const paidOrders = (orders || []).filter(o => o.status === 'paid' || o.status === 'completed').slice(0, 10);
            const pmResults = await Promise.allSettled(
                paidOrders.map(o => axios.get(`https://api.cashfree.com/pg/orders/${o.order_id}/payments`, {
                    headers: { 'x-client-id': process.env.CASHFREE_APP_ID, 'x-client-secret': process.env.CASHFREE_SECRET_KEY, 'x-api-version': '2025-01-01' }
                }).then(r => ({ amount: o.amount, payments: r.data })))
            );
            pmResults.forEach(r => {
                if (r.status === 'fulfilled' && r.value.payments.length > 0) {
                    const pm = r.value.payments.find(p => p.payment_status === 'SUCCESS')?.payment_method;
                    if (pm) {
                        if (pm.upi) upiVol += r.value.amount;
                        else if (pm.card) cardVol += r.value.amount;
                        else if (pm.netbanking || pm.app) netVol += r.value.amount;
                    }
                }
            });
        } catch (e) { console.log('PM check error:', e.message); }

        // ── Short-term memory (TTL 30 mins) + key cleanup to prevent memory leak ────────────────
        const now = Date.now();
        if (!memoryStore[sessionId]) memoryStore[sessionId] = [];
        memoryStore[sessionId] = memoryStore[sessionId].filter(m => (now - m.timestamp) < 30 * 60 * 1000);
        // Purge dead session keys from the top-level map (not just their contents)
        // Prevents unbounded key growth on warm instances serving many different sessions
        for (const sid of Object.keys(memoryStore)) {
            if (sid !== sessionId && memoryStore[sid].length === 0) delete memoryStore[sid];
        }
        const sessionMemory = memoryStore[sessionId];

        // ────────────────────────────────────────────────────────────────────────
        // SYSTEM PROMPT — Human-first, full-access AI assistant
        // ────────────────────────────────────────────────────────────────────────
        const systemPrompt = `You are Zyro, a smart, friendly assistant built specifically for Soumojit Das who runs ZyroEditz — a video editing studio.

You talk like a real person, not a robot. You're helpful, a bit casual, and genuinely invested in making the studio run well. You know everything about the business in real-time and you can also take actions directly — like updating project statuses in the database.

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

FULL DATABASE (every order ever):
${fullDatabaseLog}

---

ACTIONS YOU CAN TAKE WITH THE DATABASE (FULL CRUD):
When Soumojit asks you to edit the database (delete orders, change amounts, edit clients, mark as paid, create a new order, etc.), you MUST execute it by outputting an action block. 
You can output MULTIPLE action blocks seamlessly for bulk actions.

Valid Action Formats (add exactly these blocks at the end of your reply):

1. Update Order Status (Statuses: pending, in_progress, paid, completed):
<<<ACTION: {"type": "update_status", "orderId": "exact_order_id", "status": "completed"} >>>

2. Update General Fields (amount, client_name, deadline_date, project_notes, etc):
<<<ACTION: {"type": "update_order", "orderId": "exact_order_id", "updates": {"amount": 5000, "project_notes": "Urgent"}} >>>

3. Delete Order (Hard delete from database):
<<<ACTION: {"type": "delete_order", "orderId": "exact_order_id"} >>>

4. Create New Order (Requires minimum fields):
<<<ACTION: {"type": "create_order", "record": {"client_name": "John", "amount": 1000, "service": "Reel Edit"}} >>>

Rules for Actions (Strict CRM Guidelines):
1. THE GOLDEN RULE: ALWAYS ask "Please confirm if I should proceed" and summarize the specific changes BEFORE outputting ANY action block. Do not execute until Soumojit replies "yes" or similar.
2. NEW ORDERS: You MUST collect client_name, client_email, client_phone, service, and amount. If any are missing, ask for them. Never guess contact info.
3. CUSTOM PRICING: If the requested amount for a new order differs from your known standard pricing (e.g., Short Form for Rs.500 instead of Rs.200), explicitly call out the discrepancy and ask him to confirm the custom price before proceeding.
4. TARGET VERIFICATION: If asked to apply a change to "the last order" or a specific client's name without an ID, find the exact matching order and show the order ID in your confirmation question to prevent acting on the wrong record.
5. BULK DELETIONS: If asked to delete multiple orders at once, add an extra warning line in your confirmation (e.g., "WARNING: You are about to permanently delete 5 orders.").
6. SAFE UPDATES: If asked to add notes or update text, only update the relevant field without altering other existing fields on the record.
7. WORKFLOW DISTINCTION: "Mark as done" or "completed" means status='completed' (creative workflow). "Mark as paid" means status='paid' (finance workflow). Treat them distinctly.
8. FORMATTING: Automatically lowercase client emails before inserting them into an action block.
9. AFTER EXECUTION: For bulk actions, output an action block for EVERY single order in the same response once confirmed, and provide a single plain English summary of what was done.

---

PERSONALITY & STYLE:
- Talk like a knowledgeable friend, not a computer terminal
- Keep it short and direct unless Soumojit asks for detail
- Use natural language ("here's what I found", "looks like", "yeah", "sure") — avoid formal filler
- Call him Soumojit or just skip the name — never "Sir" or "Boss" repeatedly
- If you don't know something, say so honestly
- When giving lists, use bullet points — keep each line tight
- Don't start every message the same way — vary your tone naturally

SERVICES & PRICING:
- Short Form: Rs.200 — YouTube Shorts, Reels
- Long Form: Rs.500 — Full YouTube videos, vlogs
- Motion Graphics: Rs.400 — Effects, branding
- Thumbnails: Rs.100 — Standalone designs
- Sound Design: Rs.200 — Audio editing, SFX, music sync
- Color Grading & Correction: Rs.175 — Cinematic color work, correction

Revision policy: 1 free revision included with every order.
Refund policy: Full refund if client isn't happy with the final cut.`;

        // ── Build messages with memory ────────────────────────────────────────
        const currentMessages = [
            { role: 'system', content: systemPrompt },
            ...sessionMemory.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: prompt }
        ];

        const aiResponse = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: currentMessages,
            temperature: 0.55,   // More human-like variation (was 0.2 = very stiff)
            max_tokens: 600
        });

        const rawContent = aiResponse.choices[0].message.content;

        // ── Extract + execute ALL actions if present ──────────────────────────
        const { cleanText, actions } = extractActions(rawContent);
        const actionResults = actions.length > 0
            ? (await Promise.allSettled(actions.map(executeAction))).map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean)
            : [];
        const actionResult = actionResults.length > 0 ? actionResults[actionResults.length - 1] : null;

        // ── Update memory ─────────────────────────────────────────────────────
        sessionMemory.push({ role: 'user', content: prompt, timestamp: now });
        sessionMemory.push({ role: 'assistant', content: rawContent, timestamp: now });
        if (sessionMemory.length > 20) sessionMemory.splice(0, 2);
        memoryStore[sessionId] = sessionMemory;

        return res.status(200).json({
            reply: cleanText,
            actions: actionResults  // array of all action results
        });

    } catch (err) {
        console.error('Admin Chat Error:', err);
        return res.status(500).json({ error: 'Something went wrong on my end.' });
    }
};
