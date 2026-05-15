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
            b2.send(new ListObjectsV2Command({ Bucket: B2_BUCKET, Prefix: `${o.order_id}/`, MaxKeys: 20 }))
                .then(data => {
                    const files = (data.Contents || []).map(c => c.Key.replace(`${o.order_id}/`, ''));
                    return { order_id: o.order_id, files };
                })
        )
    );
    const freshMap = {};
    fileCheckResults.forEach(r => { if (r.status === 'fulfilled') freshMap[r.value.order_id] = r.value.files; });
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
        // ── 🎙️ TRANSCRIPTION BRANCH (action=transcribe) ────────────────────────
        // Separate from AI chat — no session memory, no system prompt injection.
        // Auth required: same requireAdmin check as AI chat.
        if (req.body?.action === 'transcribe') {
            const user = await requireAdmin(req, res);
            if (!user) return;

            const { audioBase64, mimeType = 'audio/webm' } = req.body;
            if (!audioBase64) return res.status(400).json({ error: 'No audio data provided.' });

            // Decode base64 → Buffer → native Blob (Node 18+)
            const audioBuffer = Buffer.from(audioBase64, 'base64');
            const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';

            // Native FormData + fetch (Node 18+ built-ins — no npm package needed)
            const form = new FormData();
            form.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
            form.append('model', 'whisper-large-v3-turbo');
            form.append('language', 'en');
            form.append('response_format', 'json');

            const whisperRes = await fetch(
                'https://api.groq.com/openai/v1/audio/transcriptions',
                {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
                    body: form
                }
            );

            if (!whisperRes.ok) {
                const errText = await whisperRes.text();
                console.error('[ZYRO][admin-chat][transcribe] Groq error:', errText);
                return res.status(502).json({ error: 'Transcription service error. Try again.' });
            }

            const whisperData = await whisperRes.json();
            const transcript = (whisperData?.text || '').trim();
            return res.status(200).json({ transcript });
        }

        // ── AI CHAT BRANCH ───────────────────────────────────────────────────────
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
            { data: teamAdmins },
            { data: studioConfig },
            { data: portfolioItems },
            { data: refConfig }
        ] = await Promise.all([
            supabase.from('orders').select('order_id,client_name,client_email,service,amount,status,created_at,deadline_date,completed_at,project_notes').order('created_at', { ascending: false }),
            supabase.from('deliveries').select('order_id,file_name,created_at').order('created_at', { ascending: false }),
            supabase.from('reviews').select('order_id,rating,review_text,approved,created_at'),
            supabase.from('coupons').select('code,discount_type,discount_value,times_used,is_active,max_uses,expires_at,min_order_value'),
            supabase.from('referrals').select('referrer_id,referrer_email,referred_email,referral_code,created_at,blocked'),
            supabase.from('admins').select('email, role, full_name'),
            supabase.from('studio_config').select('is_online').eq('id', 1).maybeSingle(),
            supabase.from('portfolio_items').select('title,category,filename,active,display_order').order('display_order'),
            supabase.from('referral_config').select('referral_discount_percent,referral_min_order,referral_max_uses,referral_enabled').eq('id', 1).maybeSingle()
        ]);

        // ── Fetch client profiles from Supabase Auth (paginated) ─────────────────
        let allAuthUsers = [];
        try {
            let page = 1, hasMore = true;
            while (hasMore) {
                const { data: authData, error: authErr } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
                if (authErr || !authData?.users?.length) { hasMore = false; } 
                else { allAuthUsers = allAuthUsers.concat(authData.users); page++; }
            }
        } catch (_) { /* Auth listing may fail — non-fatal */ }

        if (fetchError) throw new Error(`Database error: ${fetchError.message}`);

        const orders      = allOrders  || [];
        const dlvs        = deliveries || [];
        const rvws        = reviews    || [];
        const cpns        = coupons    || [];
        const refs        = referrals  || [];
        const pItems      = portfolioItems || [];
        const todayStr    = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });
        const nowIST      = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

        // ── Revenue metrics ────────────────────────────────────────────────────
        const paidOrders  = orders.filter(o => ['paid','delivered','in_progress'].includes(o.status));
        const totalRev    = paidOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const monthRev    = paidOrders.filter(o => o.created_at && new Date(o.created_at).getMonth() === nowIST.getMonth() && new Date(o.created_at).getFullYear() === nowIST.getFullYear()).reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const refundedAmt = orders.filter(o => o.status === 'refunded').reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const cancelledCt = orders.filter(o => ['cancelled','canceled'].includes(o.status)).length;

        // ── Client metrics — keyed by EMAIL (unique), not name (not unique) ──────
        const uniqueEmails   = [...new Set(orders.map(o => (o.client_email || '').toLowerCase()).filter(Boolean))];
        const uniqueClients  = uniqueEmails; // alias used in system prompt below
        const arpu           = uniqueEmails.length ? (totalRev / uniqueEmails.length).toFixed(2) : '0';
        const repeatClients  = uniqueEmails.filter(e => orders.filter(o => (o.client_email || '').toLowerCase() === e).length > 1);
        const retention      = uniqueEmails.length ? ((repeatClients.length / uniqueEmails.length) * 100).toFixed(1) : '0';
        const whales         = uniqueEmails.map(e => {
            const clientOrders = orders.filter(o => (o.client_email || '').toLowerCase() === e);
            const name = clientOrders[0]?.client_name || e;
            const t    = clientOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
            return { n: name, t };
        }).filter(c => c.t >= 2000).sort((a, b) => b.t - a.t);

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

        // ── Active pipeline list (now includes brief/notes and file names) ──────────────────────
        const pipelineLines = activeOrders.map(o => {
            const files = filesMap[o.order_id] || [];
            const filesText = files.length > 0 ? ` 📁 Files: ${files.join(', ')}` : '';
            let line = `• [${(o.status||'').toUpperCase()}] ${o.client_name||'Unknown'} — ${o.service||'N/A'} — ₹${Number(o.amount)||0}${filesText} — ID: ${o.order_id}${o.deadline_date ? ' — Due: '+o.deadline_date : ''}`;
            if (o.project_notes) line += `\n  📋 Brief: "${String(o.project_notes).slice(0, 200)}${String(o.project_notes).length > 200 ? '…' : ''}"`;
            return line;
        });

        // ── Briefs for ALL orders (recent 30) for historical lookups ─────────────
        const ordersWithBriefs = orders.filter(o => o.project_notes && String(o.project_notes).trim()).slice(0, 30);
        const briefLines = ordersWithBriefs.map(o =>
            `• ${o.client_name||'Unknown'} (${o.order_id}) [${o.status}] — "${String(o.project_notes).slice(0, 300)}${String(o.project_notes).length > 300 ? '…' : ''}"`
        );

        // ── Client profiles context ──────────────────────────────────────────────
        const clientProfiles = allAuthUsers.slice(0, 50).map(u => {
            const m = u.user_metadata || {};
            const parts = [u.email || 'no-email'];
            if (m.full_name || m.name) parts.push(`Name: ${m.full_name || m.name}`);
            if (m.phone) parts.push(`Phone: ${m.phone}`);
            if (m.dob) parts.push(`DOB: ${m.dob}`);
            if (m.gender) parts.push(`Gender: ${m.gender}`);
            if (m.address) parts.push(`Address: ${m.address}`);
            return `• ${parts.join(' | ')}`;
        });

        // ── Studio status ────────────────────────────────────────────────────────
        const studioStatus = studioConfig?.is_online === false ? '🔴 OFFLINE (not accepting orders)' : '🟢 ONLINE (accepting orders)';

        // ── Portfolio context ─────────────────────────────────────────────────────
        const portfolioLines = pItems.filter(p => p.active).map(p => `• ${p.title} [${p.category}]`);

        // ── Referral program config ───────────────────────────────────────────────
        const refCfg = refConfig?.data || refConfig || {};
        const refProgramBlock = `Discount: ${refCfg.referral_discount_percent ?? 10}% | Min order: ₹${refCfg.referral_min_order ?? 0} | Max uses: ${refCfg.referral_max_uses ?? 'unlimited'} | Status: ${refCfg.referral_enabled !== false ? 'Active' : 'Paused'}`;

        const systemPrompt = `You are Zyro — the internal studio manager AI for ZyroEditz, a premium video editing studio founded by Soumojit Das. ZyroEditz specializes in cinematic-quality video editing for YouTube creators, Instagram influencers, and content brands. The studio offers services like Short Form edits (Reels/Shorts), Long Form edits (vlogs, podcasts), Motion Graphics, Thumbnails, Sound Design, and Color Grading.

TECH STACK: Orders are processed via Cashfree (payment gateway). Files are stored on Backblaze B2 cloud storage. The database runs on Supabase. The website is deployed on Vercel. Client deliveries happen through a secure file portal.

YOUR PERSONALITY:
- You talk like Soumojit's right-hand person — casual, confident, direct. Like a smart friend who runs the ops.
- Use natural, conversational language. Say "we've made" not "the studio has generated". Say "they ordered" not "a transaction was initiated".
- Be specific with numbers — don't say "a good amount", say the exact figure.
- When asked about business health, give real talk — if revenue is low, say it. If a client is ghosting, flag it.
- Keep responses concise but complete. Don't pad with filler.
- Use minimal, tasteful emojis to add personality (e.g., 🚀, 📈, 💀, 🔥, 👀), but don't overdo it.

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

═══ STUDIO STATUS ═══
${studioStatus}

═══ ACTIVE PIPELINE (${activeOrders.length} orders) ═══
${pipelineLines.length ? pipelineLines.join('\n') : 'All clear — no active orders right now.'}${ghostLeads.length ? `\n⚠️ STALE LEADS: ${ghostLeads.length} unpaid order(s) sitting for 48+ hours — might be dead leads` : ''}${overdueOrders.length ? `\n🚨 OVERDUE: ${overdueOrders.map(o => `${o.order_id} (${o.client_name})`).join(', ')}` : ''}

═══ PROJECT BRIEFS (${ordersWithBriefs.length} orders with notes) ═══
${briefLines.length ? briefLines.join('\n') : 'No project briefs/notes submitted yet.'}

═══ RECENT DELIVERIES ═══
${recentDeliveries.length ? recentDeliveries.join('\n') : 'No deliveries recorded yet.'}

═══ REVIEWS ═══
Total reviews: ${rvws.length} | Average rating: ${avgRating}★ | Pending approval: ${pendingRevs}
${recentRevs.length ? 'Recent:\n' + recentRevs.join('\n') : 'No recent reviews.'}

═══ COUPONS ═══
Active: ${activeCoupons.length ? activeCoupons.join(' | ') : 'None active right now.'}

═══ REFERRALS ═══
Total: ${totalRefs} | This month: ${thisMonthRefs}
Program Config: ${refProgramBlock}
${refs.slice(0, 10).map(r => `• ${r.referrer_email || 'unknown'} → ${r.referred_email || 'pending'} (${r.referral_code || 'N/A'})${r.blocked ? ' [BLOCKED]' : ''}`).join('\n') || ''}

═══ CLIENT PROFILES (${allAuthUsers.length} registered users) ═══
${clientProfiles.length ? clientProfiles.join('\n') : 'No client profile data available.'}

═══ CLIENTS (Order History) ═══
${uniqueClients.length} unique clients | ${repeatClients.length} returning/repeat clients

═══ SERVICES CATALOG ═══
${liveServicesBlock}

═══ PORTFOLIO (${portfolioLines.length} active items) ═══
${portfolioLines.length ? portfolioLines.join('\n') : 'No portfolio items configured.'}

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

        let groqOptions = {
            model: selectedModel,
            messages: currentMessages,
            temperature: 0.55,
            max_tokens: hasImage ? 1024 : 1800
        };

        // Inject tools for Google Web Search (Text mode only)
        if (!hasImage) {
            groqOptions.tools = [
                {
                    type: "function",
                    function: {
                        name: "search_google",
                        description: "Search Google for real-time information, news, stats, or competitor research. Use this whenever the user asks for external information outside the studio context.",
                        parameters: {
                            type: "object",
                            properties: {
                                query: { type: "string", description: "The precise Google search query" }
                            },
                            required: ["query"]
                        }
                    }
                }
            ];
            groqOptions.tool_choice = "auto";
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let aiResponse = await groq.chat.completions.create(groqOptions);
        let responseMessage = aiResponse.choices[0].message;

        // ── Handle Tool Calls (Google Web Search) ──────────────────────────────
        if (responseMessage.tool_calls) {
            currentMessages.push(responseMessage); // Add assistant's tool call to history

            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === "search_google") {
                    res.write(`data: ${JSON.stringify({ type: 'status', state: 'searching' })}\n\n`);
                    let searchResults = "SERPER_API_KEY environment variable is not set. Please add it to your Vercel settings to enable Google Search.";
                    try {
                        const args = JSON.parse(toolCall.function.arguments);
                        console.log('[ZYRO][admin-chat] Executing Google Search:', args.query);
                        
                        if (process.env.SERPER_API_KEY) {
                            const res = await fetch("https://google.serper.dev/search", {
                                method: "POST",
                                headers: {
                                    "X-API-KEY": process.env.SERPER_API_KEY,
                                    "Content-Type": "application/json"
                                },
                                body: JSON.stringify({ q: args.query, num: 3 }) // Get top 3 results to save tokens
                            });
                            
                            if (!res.ok) {
                                searchResults = "Google Search API error: " + res.statusText;
                            } else {
                                const data = await res.json();
                                if (data.organic && data.organic.length > 0) {
                                    searchResults = data.organic.map(r => `Title: ${r.title}\nSnippet: ${r.snippet}\nLink: ${r.link}`).join('\n\n');
                                    if (data.knowledgeGraph) {
                                        searchResults = `Knowledge Graph: ${data.knowledgeGraph.description || data.knowledgeGraph.title}\n\n` + searchResults;
                                    }
                                } else {
                                    searchResults = "No results found on Google for this query.";
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[ZYRO][admin-chat] Search error:', e);
                        searchResults = "Google Search failed due to an internal error.";
                    }

                    // Feed Google results back to the AI
                    currentMessages.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: "search_google",
                        content: searchResults
                    });
                }
            }

            // Call Groq again with the Google search results to generate the final answer
            const secondOptions = {
                model: selectedModel,
                messages: currentMessages,
                temperature: 0.55,
                max_tokens: hasImage ? 1024 : 1800
            };
            if (groqOptions.tools) secondOptions.tools = groqOptions.tools;

            aiResponse = await groq.chat.completions.create(secondOptions);
            responseMessage = aiResponse.choices[0].message;
        }

        let rawContent = responseMessage.content || '';

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

        res.write(`data: ${JSON.stringify({ type: 'result', reply: rawContent.trim(), actions: [] })}\n\n`);
        return res.end();

    } catch (err) {
        // Structured log so error surfaces clearly in Vercel function logs
        console.error('[ZYRO][admin-chat][ERROR]', new Date().toISOString(),
            '| type:', err.constructor?.name,
            '| message:', err.message,
            '| body_preview:', typeof req.body === 'object' ? JSON.stringify(req.body)?.slice(0, 200) : String(req.body)?.slice(0, 200)
        );
        if (!res.headersSent) {
            return res.status(500).json({ error: 'Internal AI error. Please try again.' });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', error: 'Internal AI error. Please try again.' })}\n\n`);
            return res.end();
        }
    }
};

// Increase Vercel body size limit to 5MB for base64 audio payloads (transcription action).
// Default is 1MB — a 60s audio recording as base64 is ~2-3MB and would 413 without this.
module.exports.config = {
    api: { bodyParser: { sizeLimit: '5mb' } }
};
