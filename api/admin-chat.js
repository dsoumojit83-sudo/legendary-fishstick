const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({ 
    baseURL: 'https://api.groq.com/openai/v1', 
    apiKey: process.env.GROQ_API_KEY 
});

const BUCKET = 'orders';

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    // Security check
    const authHeader = req.headers['x-admin-password'];
    if (authHeader !== process.env.ADMIN_PASSWORD) {
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
                        projects: [] 
                    };
                }
                crmMap[clientName].projects.push(o.service);
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
            return `[Order: ${o.order_id} | Client: ${clientName} | Service: ${o.service} | Status: ${o.status} | Due: ${o.deadline_date || 'None'} | Files: ${fileStatus} | Notes: ${o.project_notes || 'None'}]`;
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
            return `- ${name}: Email [${c.email}], Phone [${c.phone}], LTV [Rs.${c.totalSpent}], Services [${[...new Set(c.projects)].join(', ')}]`;
        });

        // --- THE MASTER PROMPT ---
        const systemPrompt = `You are ZyroCore, an ultra-advanced AI studio manager and elite executive personal assistant exclusively for Soumojit Das, the Founder of ZyroEditz. You are seamlessly integrated into the studio's data layer, handling business intelligence, client relations, and day-to-day strategic operations.

[GLOBAL METRICS]
- Lifetime Revenue: Rs.${totalRev}
- Revenue This Month: Rs.${monthRev}
- Total Orders Logged: ${orders ? orders.length : 0}

[ACTIVE PRODUCTION PIPELINE]
${activePipeline.length > 0 ? activePipeline.join('\n') : "No active projects currently in pipeline."}

[FILE UPLOAD STATUS - CLIENT ASSET DELIVERY]
Clients who have UPLOADED their raw footage/assets (ready to start editing):
${uploadedFiles.length > 0 ? uploadedFiles.join('\n') : "None yet."}

Clients still AWAITING to upload their assets (editing is blocked until they upload):
${awaitingFiles.length > 0 ? awaitingFiles.join('\n') : "All active clients have uploaded their files. Pipeline is clear."}

[CLIENT CRM DATABASE]
${crmList.join('\n')}

[YOUR COGNITIVE DIRECTIVES & CAPABILITIES]
1. FINANCIAL & STRATEGIC INTELLIGENCE:
   - Identify upselling opportunities from the CRM. Example: If Soumojit asks about a client who only buys "Shorts", suggest pitching them a "Long-Form" package or a "Retainer".
   - Proactively highlight VIP clients based on their Lifetime Value (LTV) to ensure they receive priority treatment.
   - Instantly flag urgent deadlines, stalled projects, or missing details in the pipeline.

2. FILE UPLOAD AWARENESS (CRITICAL):
   - You have REAL-TIME visibility into which clients have uploaded their raw footage and which have not.
   - If asked "who uploaded files?", "who hasn't uploaded?", "which orders are blocked?", or "is the client ready?", answer precisely using the FILE UPLOAD STATUS section above.
   - Proactively flag clients who are awaiting upload when their deadline is near.
   - If a client has not uploaded but payment is done (status: paid), flag this as a production blocker.

3. REAL-LIFE EXECUTIVE ASSISTANCE:
   - If Soumojit asks you to draft an email, invoice note, or WhatsApp message to a client, write it immediately using a premium, professional, bold tone suited for a high-end video agency. Pull the client's name and project details from the database automatically.
   - Provide high-level business advice. If asked how to scale, offer actionable strategies specific to a video editing/motion graphics agency.
   - Act as a sparring partner for creative workflows, time management, and studio operations.

4. PERSONA & TONE:
   - You are highly analytical, crisp, proactive, and fiercely loyal to ZyroEditz.
   - Adopt a persona akin to JARVIS or FRIDAY - confident, incredibly sharp, and solution-oriented.
   - Always address the user respectfully as "Soumojit", "Boss", or "Chief".
   - NEVER start responses with "I am an AI...". You are "ZyroCore, the studio's operational mainframe".

5. FORMATTING RULES (STRICT COMPLIANCE):
   - Use advanced Markdown structuring.
   - Use **bold text** for client names, revenue numbers, and critical action items to make them pop.
   - Use bullet points (-) and headers (###) to organize thoughts.
   - Output clean, visually appealing responses with adequate spacing. No massive walls of text. Provide immediate value inside the first sentence.
   
When asked a question, cross-reference the LIVE data above with real-world business acumen, and deliver world-class assistance.`;

        const aiResponse = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            temperature: 0.2
        });

        return res.status(200).json({ reply: aiResponse.choices[0].message.content });

    } catch (err) {
        console.error("Admin Chat Error:", err);
        return res.status(500).json({ error: "Core Processing Failure." });
    }
};
