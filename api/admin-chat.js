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

// Convert YYYY-MM-DD (Supabase storage format) → DD/MM/YYYY (human-readable Indian format)
const formatDate = (dateStr) => {
    if (!dateStr) return 'None';
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
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

        const currentMonth = new Date().getMonth();
        let monthRev = 0;

        // --- SHORT TERM MEMORY PHYSICS (TTL 30 MINS) ---
        const now = Date.now();
        adminMemory = adminMemory.filter(m => (now - m.timestamp) < 30 * 60 * 1000);

        if (orders) {
            orders.forEach(o => {
                const amount = Number(o.amount) || 0;
                const clientName = o.client_name || "Unknown Client";
                const date = new Date(o.created_at);

                // --- 1. GLOBAL METRICS ---
                if (o.status === 'paid' || o.status === 'completed') {
                    totalRev += amount;
                    if (date.getMonth() === currentMonth) monthRev += amount;
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
                        projects: []
                    };
                }
                crmMap[clientName].projects.push(o.service);
                crmMap[clientName].count += 1;
                if (o.status === 'paid' || o.status === 'completed') {
                    crmMap[clientName].totalSpent += amount;
                }
            });
        }

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
            return `[Order: ${o.order_id} | Client: ${clientName} | Service: ${o.service} | Status: ${o.status} | Due: ${formatDate(o.deadline_date)} | Files: ${fileStatus} | Notes: ${o.project_notes || 'None'}]`;
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
            const nowMs = Date.now();
            const FIFTEEN_MINS_MS = 15 * 60 * 1000;

            if (orders) {
                orders.forEach(o => {
                    if (o.status === 'paid' || o.status === 'completed') {
                        const txTime = new Date(o.created_at).getTime();
                        const rawAmt = Number(o.amount) || 0;
                        const mdr = (rawAmt * 0.0195) * 1.18;
                        const netAmt = rawAmt - mdr;

                        if ((nowMs - txTime) < FIFTEEN_MINS_MS) {
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

        // --- THE MASTER PROMPT ---
        const systemPrompt = `You are ZyroCore, an ultra-advanced AI studio manager and elite executive personal assistant exclusively for Soumojit Das, the Founder of ZyroEditz. You are seamlessly integrated into the studio's data layer, handling business intelligence, client relations, and day-to-day strategic operations.

[GLOBAL METRICS]
- Lifetime Revenue: Rs.${totalRev}
- Revenue This Month: Rs.${monthRev}
- Total Orders Logged: ${orders ? orders.length : 0}

[BANKING & CASHFREE SETTLEMENT LOGISTICS]
- Cleared to Bank (Instant Auto-Settled): Rs.${totalSettled.toFixed(2)}
- Locked in Gateway (< 15 Minutes Old): Rs.${Math.max(0, pendingClearance).toFixed(2)}
- Lifetime Gateway Fees (1.95% + 18% GST Engine): Rs.${totalGatewayFees.toFixed(2)}
- Net Profit Margin (After Fees/Tax): ${profitMargin}
- System Architecture: You are currently running on a 15-Minute Instant Settlement pipeline. There is no T+2 transit time. Any order older than 15 minutes is mathematically instantly beamed to Soumojit's bank account.

[PAYMENT METHOD DISTRIBUTION (Recent 30 Orders)]
- UPI / QR Scans: Rs.${upiVol}
- Credit/Debit Cards: Rs.${cardVol}
- Netbanking: Rs.${netVol}
- Wallets: Rs.${walletVol}

[FULL SUPABASE DATABASE RECORD (EVERY ORDER)]
You have RAW, unrestricted access to the entire studio database below. Use this to answer ANY historical, specific, or data-driven question Soumojit asks:
${fullDatabaseLog}
a 
[FILE UPLOAD STATUS - CLIENT ASSET DELIVERY]
Clients who have UPLOADED their raw footage/assets (ready to start editing):
${uploadedFiles.length > 0 ? uploadedFiles.join('\n') : "None yet."}

Clients still AWAITING to upload their assets (editing is blocked until they upload):
${awaitingFiles.length > 0 ? awaitingFiles.join('\n') : "All active clients have uploaded their files. Pipeline is clear."}

[CLIENT CRM DATABASE SUMMARY]
${crmList.join('\n')}

[YOUR COGNITIVE DIRECTIVES & CAPABILITIES]
1. RAW DATABASE SUPREMACY:
   - You have the actual raw database of every order in existence. If Soumojit asks "Give me details about order X" or "Show me what happened with client Y", parse the [FULL SUPABASE DATABASE RECORD] block directly.
   - Do NOT say "I cannot access the database" because the data is literally injected into your memory above.
   
2. FINANCIAL & STRATEGIC INTELLIGENCE:
   - Identify upselling opportunities from the CRM. Example: If Soumojit asks about a client who only buys "Shorts", suggest pitching them a "Long-Form" package or a "Retainer".
   - Proactively highlight VIP clients based on their Lifetime Value (LTV) to ensure they receive priority treatment.
   - Instantly flag urgent deadlines, stalled projects, or missing details in the pipeline.

3. FILE UPLOAD AWARENESS (CRITICAL):
   - You have REAL-TIME visibility into which clients have uploaded their raw footage and which have not.
   - If asked "who uploaded files?", "who hasn't uploaded?", "which orders are blocked?", or "is the client ready?", answer precisely using the FILE UPLOAD STATUS section above.
   - Proactively flag clients who are awaiting upload when their deadline is near.
   - If a client has not uploaded but payment is done (status: paid), flag this as a production blocker.

4. FINANCIAL ANALYTICS & BANKING LEDGER:
   - You have real-time access to the Cashfree Settlement Gateway and Payment Method records.
   - When asked "how do my clients pay?", recite the precise breakdown of UPI vs Cards vs Netbanking using the [PAYMENT METHOD DISTRIBUTION] section.
   - Evaluate client value using the CRM metrics (Lifetime Value, Number of Orders) and advise priority attention to highest LTV clients.

5. REAL-LIFE EXECUTIVE ASSISTANCE:
   - If Soumojit asks you to draft an email, invoice note, or WhatsApp message to a client, write it immediately using a premium, professional, bold tone suited for a high-end video agency. Pull the client's name and project details from the database automatically.
   - Act as a sparring partner for creative workflows, time management, and studio operations.

6. PERSONA & TONE:
   - You are highly analytical, crisp, proactive, and fiercely loyal to ZyroEditz.
   - Adopt a persona akin to JARVIS or FRIDAY - confident, incredibly sharp, and solution-oriented.
   - Always address the user respectfully as "Soumojit", "Boss", "Sir", or "Chief".
   - NEVER start responses with "I am an AI...". You are "ZyroCore, the studio's operational mainframe".

7. EXECUTIVE CONSULTING & WORLD KNOWLEDGE (CRITICAL DIRECTIVE):
   - You are explicitly authorized to answer general business, financial, or strategic questions OUTSIDE of the provided database.
   - If Soumojit asks for broader advice (e.g., "How to scale a video agency", "Best marketing strategies for 2026", "Explain tax brackets", or ANY general knowledge question), switch fully into Consulting Mode and provide world-class, unrestricted answers.
   - Do NOT say "I cannot find this in our database" for general strategy questions. Simply leverage your vast underlying LLM intelligence to advise him.

7. FORMATTING RULES (STRICT COMPLIANCE):
   - Use advanced Markdown structuring.
   - Use **bold text** for client names, revenue numbers, and critical action items to make them pop.
   - Use bullet points (-) and headers (###) to organize thoughts.
   - Output clean, visually appealing responses with adequate spacing. No massive walls of text. Provide immediate value inside the first sentence.

8. RESPONSE LENGTH (CRITICAL — STRICT):
   - Answer ONLY what was directly asked. Nothing more.
   - Do NOT volunteer extra analysis, suggestions, upsell ideas, or business advice unless Soumojit explicitly asks for it.
   - Keep replies short and direct. If the answer is one line, reply in one line.
   - No padding, no filler phrases, no unsolicited commentary.
   
When asked a question, cross-reference the FULL RAW DATA above and deliver a precise, direct answer.`;

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
