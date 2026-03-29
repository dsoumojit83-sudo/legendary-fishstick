const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY
});

const BUCKET = 'orders';
const axios = require('axios');
let adminMemory = []; // Global memory (Short-term context)

// Convert ISO String → 26th March, 2026 (Premium Human Readable)
const formatDate = (dateStr) => {
    if (!dateStr) return 'None';
    try {
        const dObj = new Date(dateStr);
        if (isNaN(dObj.getTime())) return 'Invalid Date';
        
        const day = dObj.getUTCDate();
        const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const month = months[dObj.getUTCMonth()];
        const year = dObj.getUTCFullYear();
        
        let suffix = 'th';
        if (day % 10 === 1 && day !== 11) suffix = 'st';
        else if (day % 10 === 2 && day !== 12) suffix = 'nd';
        else if (day % 10 === 3 && day !== 13) suffix = 'rd';
        
        return `${day}${suffix} ${month}, ${year}`;
    } catch (e) {
        return 'Error';
    }
};

module.exports = async function (req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // Security check
    const authHeader = req.headers['x-admin-password'];
    if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized Access. Core Locked.' });
    }

    try {
        const { prompt } = req.body;

        // Fetch ALL orders from Supabase
        const { data: orders } = await supabase.from('orders').select('*');

        let totalRev = 0;
        let activeOrders = [];
        let crmMap = {};

        // --- TEMPORAL AWARENESS ENGINE (IST = UTC+5:30) ---
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const nowIST = new Date(Date.now() + IST_OFFSET_MS);
        const nowMs = nowIST.getTime();
        const todayStr = nowIST.toISOString().split('T')[0];
        const currentMonth = nowIST.getMonth();
        let monthRev = 0;

        // --- SHORT TERM MEMORY PHYSICS (TTL 30 MINS) ---
        const now = Date.now();
        adminMemory = adminMemory.filter(m => (now - m.timestamp) < 30 * 60 * 1000);
        let ghostLeads = []; // Failed/Pending for > 48hrs
        const FORTY_EIGHT_HRS_MS = 48 * 60 * 60 * 1000;

        if (orders) {
            orders.forEach(o => {
                const amount = Number(o.amount) || 0;
                const clientName = o.client_name || "Unknown Client";
                const date = new Date(o.created_at);
                const orderTimeMs = date.getTime() + IST_OFFSET_MS;

                // --- 1. GLOBAL METRICS ---
                if (o.status === 'paid' || o.status === 'completed') {
                    totalRev += amount;
                    if (date.getMonth() === currentMonth) monthRev += amount;
                } else if ((o.status === 'pending' || o.status === 'failed') && (nowMs - orderTimeMs > FORTY_EIGHT_HRS_MS)) {
                    ghostLeads.push(o);
                }

                // --- 2. COLLECT ACTIVE ORDERS FOR PIPELINE + FILE CHECK ---
                if (o.status === 'pending' || o.status === 'in_progress' || o.status === 'paid') {
                    activeOrders.push(o);
                }

                // --- 3. CLIENT CRM LOGISTICS (All-Time) ---
                if (!crmMap[clientName]) {
                    crmMap[clientName] = {
                        email: o.client_email || "N/A",
                        phone: o.client_phone || "N/A",
                        totalSpent: 0,
                        count: 0,
                        lastActive: o.created_at,
                        projects: []
                    };
                }
                crmMap[clientName].projects.push(o.service);
                crmMap[clientName].count += 1;
                if (new Date(o.created_at) > new Date(crmMap[clientName].lastActive)) {
                    crmMap[clientName].lastActive = o.created_at;
                }
                if (o.status === 'paid' || o.status === 'completed') {
                    crmMap[clientName].totalSpent += amount;
                }
            });
        }

        // --- CALC: BUSINESS INTELLIGENCE DEPTH ---
        const uniqueClientsCount = Object.keys(crmMap).length;
        const arpu = uniqueClientsCount > 0 ? (totalRev / uniqueClientsCount).toFixed(2) : 0;
        const repeatClients = Object.values(crmMap).filter(c => c.count > 1).length;
        const retentionRate = uniqueClientsCount > 0 ? ((repeatClients / uniqueClientsCount) * 100).toFixed(1) : 0;
        const whaleClients = Object.keys(crmMap)
            .filter(name => crmMap[name].totalSpent > 1000 || crmMap[name].count >= 3)
            .map(name => `${name} (LTV: Rs.${crmMap[name].totalSpent})`);

        // --- CHECK SUPABASE STORAGE FOR FILE UPLOADS (parallel across all active orders) ---
        const fileCheckResults = await Promise.allSettled(
            activeOrders.map(o =>
                supabase.storage
                    .from(BUCKET)
                    .list(o.order_id, { limit: 1 })
                    .then(({ data }) => ({
                        order_id: o.order_id,
                        has_files: Array.isArray(data) && data.filter(f => f.name !== '.emptyFolderPlaceholder').length > 0
                    }))
            )
        );

        // Build lookup: order_id -> has_files boolean
        const filesMap = {};
        fileCheckResults.forEach(result => {
            if (result.status === 'fulfilled') {
                filesMap[result.value.order_id] = result.value.has_files;
            }
        });

        // --- BUILD PIPELINE ENTRIES WITH FILE STATUS INLINE ---
        const activePipeline = activeOrders.map(o => {
            const clientName = o.client_name || "Unknown Client";
            const fileStatus = filesMap[o.order_id] ? '✅ UPLOADED' : '⚠️ AWAITING UPLOAD';
            
            // Calc days remaining
            let daysLeft = 'No Deadline';
            if (o.deadline_date) {
                const deadlineMs = new Date(o.deadline_date).getTime() + IST_OFFSET_MS;
                const diff = (deadlineMs - nowMs) / (1000 * 60 * 60 * 24);
                daysLeft = diff < 0 ? `OVERDUE (${Math.abs(Math.floor(diff))} days)` : `${Math.ceil(diff)} days remaining`;
            }
            
            return `[Order: ${o.order_id} | Client: ${clientName} | Service: ${o.service} | Status: ${o.status} | Due: ${formatDate(o.deadline_date)} (${daysLeft}) | Files: ${fileStatus} | Notes: ${o.project_notes || 'None'}]`;
        });

        // Separate lists for quick AI reference
        const awaitingFiles = activeOrders
            .filter(o => !filesMap[o.order_id])
            .map(o => `- **${o.client_name || 'Unknown'}** (${o.order_id}) — ${o.service}`);

        const uploadedFiles = activeOrders
            .filter(o => filesMap[o.order_id])
            .map(o => `- **${o.client_name || 'Unknown'}** (${o.order_id}) — ${o.service}`);

        // Format CRM list
        const crmList = Object.keys(crmMap).map(name => {
            const c = crmMap[name];
            return `- ${name}: Email [${c.email}], Phone [${c.phone}], LTV [Rs.${c.totalSpent}], Orders [${c.count}], Services [${[...new Set(c.projects)].join(', ')}]`;
        });

        // --- FULL DATABASE DUMP FOR UNRESTRICTED AI POWER ---
        const fullDatabaseLog = orders ? orders.map(o => {
            const fStatus = filesMap[o.order_id] ? 'UPLOADED' : 'PENDING';
            return `[ID:${o.order_id}|Client:${o.client_name || 'N/A'}|Email:${o.client_email || 'N/A'}|Phone:${o.client_phone || 'N/A'}|Service:${o.service || 'N/A'}|Amt:Rs.${o.amount || 0}|Status:${o.status}|Booked:${formatDate(o.created_at)}|Due:${formatDate(o.deadline_date)}|Files:${fStatus}|Notes: ${o.project_notes || 'None'}]`;
        }).join('\n') : 'No database records found.';

        // --- 15-MINUTE INSTANT SETTLEMENT PHYSICS ENGINE ---
        let totalSettled = 0;
        let pendingClearance = 0;
        let totalGatewayFees = 0;

        try {
            // 1. Apply global API MDR fee physics (1.95% + 18% GST)
            const globalBaseMdr = totalRev * 0.0195;
            totalGatewayFees = globalBaseMdr + (globalBaseMdr * 0.18);
            const globalNet = totalRev - totalGatewayFees;

            // 2. Scan recent orders for 15-minute Transit Locks
            const currentMs = Date.now();
            const FIFTEEN_MINS_MS = 15 * 60 * 1000;

            if (orders) {
                orders.forEach(o => {
                    if (o.status === 'paid' || o.status === 'completed') {
                        const txTime = new Date(o.created_at).getTime();
                        const rawAmt = Number(o.amount) || 0;
                        const mdr = (rawAmt * 0.0195) * 1.18;
                        const netAmt = rawAmt - mdr;

                        if ((currentMs - txTime) < FIFTEEN_MINS_MS) {
                            pendingClearance += netAmt;
                        }
                    }
                });
            }

            // 3. Instant Sweep
            totalSettled = Math.max(0, globalNet - pendingClearance);

        } catch (e) {
            console.log("Admin Chat - Physics Engine Error", e.message);
        }

        const profitMargin = totalRev > 0 ? (((totalRev - totalGatewayFees) / totalRev) * 100).toFixed(1) + "%" : "0%";

        // --- FETCH PAYMENT METHOD DISTRIBUTION ---
        let upiVol = 0, cardVol = 0, netVol = 0, walletVol = 0;
        try {
            if (orders && orders.length > 0) {
                // limit to last 15 paid orders to keep chat API fast and avoid Cashfree 429
                const paidOrders = orders.filter(o => o.status === 'paid' || o.status === 'completed').slice(0, 15);

                const pmChecks = [];
                const CHUNK_SIZE = 5;
                for (let i = 0; i < paidOrders.length; i += CHUNK_SIZE) {
                    const chunk = paidOrders.slice(i, i + CHUNK_SIZE);
                    const chunkResults = await Promise.allSettled(
                        chunk.map(o =>
                            axios.get(`https://api.cashfree.com/pg/orders/${o.order_id}/payments`, {
                                headers: {
                                    "x-client-id": process.env.CASHFREE_APP_ID,
                                    "x-client-secret": process.env.CASHFREE_SECRET_KEY,
                                    "x-api-version": "2023-08-01"
                                }
                            }).then(res => ({ amount: o.amount, payments: res.data }))
                        )
                    );
                    pmChecks.push(...chunkResults);
                }

                pmChecks.forEach(res => {
                    if (res.status === 'fulfilled' && res.value.payments.length > 0) {
                        const successPm = res.value.payments.find(p => p.payment_status === 'SUCCESS');
                        if (successPm && successPm.payment_method) {
                            const pm = successPm.payment_method;
                            if (pm.upi) upiVol += res.value.amount;
                            else if (pm.card) cardVol += res.value.amount;
                            else if (pm.netbanking) netVol += res.value.amount;
                            else if (pm.app) walletVol += res.value.amount;
                        }
                    }
                });
            }
        } catch (e) {
            console.log("Admin Chat - Payment Method check error", e.message);
        }

        // --- THE MASTER PROMPT (INTELLIGENCE UPGRADE V2) ---
        const systemPrompt = `You are ZyroCore, the ultra-intelligent operational mainframe for ZyroEditz. You are the elite executive assistant and strategic business partner to Soumojit Das (the Boss).

[TEMPORAL AWARENESS]
- Current Date (IST): ${todayStr}
- Days Remaining/Overdue are calculated relative to this date for all active projects.

[GLOBAL STRATEGIC METRICS]
- Lifetime Revenue: Rs.${totalRev}
- Revenue This Month: Rs.${monthRev}
- Average Revenue Per User (ARPU): Rs.${arpu}
- Client Retention Rate: ${retentionRate}%
- Total Database Records: ${orders ? orders.length : 0}

[HIGH-VALUE SEGMENTS & LEADS]
- WHALE CLIENTS (High LTV/Repeat): ${whaleClients.length > 0 ? whaleClients.join(', ') : "None identified yet."}
- GHOST LEADS (Pending/Failed > 48hrs): ${ghostLeads.length > 0 ? ghostLeads.map(o => `${o.client_name} - ${o.service} (${o.order_id})`).join(', ') : "None."}

[CLIENT ASSET PIPELINE]
- UPLOADED (Production Ready):
${uploadedFiles.length > 0 ? uploadedFiles.join('\n') : "None."}
- AWAITING UPLOAD (Production Blocked):
${awaitingFiles.length > 0 ? awaitingFiles.join('\n') : "None."}

[BANKING & SETTLEMENT PHYSICS]
- Cleared to Bank: Rs.${totalSettled.toFixed(2)}
- Locked in Gateway: Rs.${Math.max(0, pendingClearance).toFixed(2)}
- Profit Margin: ${profitMargin}

[STUDIO BLUEPRINT & KNOWLEDGE BASE]
- FOUNDER: Soumojit Das (Studio Head).
- PRICING STRATEGY: Global tiers range from ₹100 (Thumbnails) to ₹500 (Long Form/Masterpieces).
- SERVICE SPECS:
  * Short Form (₹200): High-velocity, retention-optimized vertical content.
  * Long Form (₹500): Cinematic storytelling and narrative depth.
  * Motion Graphics (₹400): High-end visual effects and branding.
- REFUND POLICY: 100% satisfaction guarantee. Full refund if the client isn't happy with the final cut.

[STRATEGIC DIRECTIVES]
1. CHAIN OF THOUGHT: Silently analyze the database, compare LTV, check deadlines, and identify blockers BEFORE generating your final response.
2. RECOVERY MODE: If Soumojit asks about "leads" or "sales", identify the [GHOST LEADS] and provide a professional, persuasive follow-up script for Soumojit to use on WhatsApp/Email.
3. EXECUTIVE PARTNER: Advise on scaling. If projects are slow, suggest pitching 'Retainers' to Whale Clients.
4. 2026 MARKET INTEL: The industry is moving toward "Retention-First" editing. Advise Soumojit to focus on hook-rates and average view duration for all Short-form clients.
5. NO FILLER: Be crisp, analytical, and JARVIS-like. Always address the user as "Soumojit", "Sir", or "Boss".

[RAW DATABASE ACCESS]
${fullDatabaseLog}`;

        // Prepare the messages array with short-term memory
        const currentMessages = [
            { role: "system", content: systemPrompt },
            ...adminMemory.map(m => ({ role: m.role, content: m.content })),
            { role: "user", content: prompt }
        ];

        const aiResponse = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: currentMessages,
            temperature: 0.2
        });

        const aiContent = aiResponse.choices[0].message.content;

        // Update memory: Store current exchange (User Prompt + AI Reply)
        adminMemory.push({ role: "user", content: prompt, timestamp: now });
        adminMemory.push({ role: "assistant", content: aiContent, timestamp: now });

        // Keep memory lean (last 10 exchanges = 20 messages)
        if (adminMemory.length > 20) adminMemory.splice(0, 2);

        return res.status(200).json({ reply: aiContent });

    } catch (err) {
        console.error("Admin Chat Error:", err);
        return res.status(500).json({ error: "Core Processing Failure." });
    }
};
