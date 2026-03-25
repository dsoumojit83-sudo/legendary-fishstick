const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({ 
    baseURL: 'https://api.groq.com/openai/v1', 
    apiKey: process.env.GROQ_API_KEY 
});

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    // Security check
    const authHeader = req.headers['x-admin-password'];
    if (authHeader !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized Access. Core Locked.' });
    }

    try {
        const { prompt } = req.body;
        
        // Fetch ALL data from the studio
        const { data: orders } = await supabase.from('orders').select('*');
        
        let totalRev = 0;
        let activePipeline = [];
        let crmMap = {}; // To build the Client Database
        
        const currentMonth = new Date().getMonth();
        let monthRev = 0;

        if (orders) {
            orders.forEach(o => {
                const amount = Number(o.amount) || 0;
                const clientName = o.client_name || "Unknown Client";
                const date = new Date(o.created_at);

                // --- 1. GLOBAL METRICS ---
                if(o.status === 'paid' || o.status === 'completed') {
                    totalRev += amount;
                    if (date.getMonth() === currentMonth) monthRev += amount;
                }
                
                // --- 2. ACTIVE PIPELINE LOGISTICS ---
                if(o.status === 'pending' || o.status === 'in_progress' || o.status === 'paid') {
                    activePipeline.push(`[Order: ${o.order_id} | Client: ${clientName} | Service: ${o.service} | Status: ${o.status} | Due: ${o.deadline_date || 'None'} | Notes: ${o.project_notes || 'None'}]`);
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
                if(o.status === 'paid' || o.status === 'completed') {
                    crmMap[clientName].totalSpent += amount;
                }
            });
        }

        // Format the CRM data for the AI to read easily
        let crmList = Object.keys(crmMap).map(name => {
            let c = crmMap[name];
            return `- ${name}: Email [${c.email}], Phone [${c.phone}], Lifetime Value [₹${c.totalSpent}], Services Bought [${c.projects.join(', ')}]`;
        });

        // --- THE MASTER PROMPT ---
        const systemPrompt = `You are Zyro Core, the ultra-advanced AI studio manager for Soumojit Das (Founder of ZyroEditz).
        You have FULL access to the studio's database.
        
        [GLOBAL METRICS]
        - Total Lifetime Revenue: ₹${totalRev}
        - Revenue This Month: ₹${monthRev}
        - Total Orders Logged: ${orders ? orders.length : 0}
        
        [ACTIVE PRODUCTION PIPELINE]
        ${activePipeline.length > 0 ? activePipeline.join('\n') : "No active projects."}
        
        [CLIENT CRM DATABASE (Contact Info & Lifetime Value)]
        ${crmList.join('\n')}
        
        MISSION: 
        Answer Soumojit's question using ONLY the provided data.
        - If asked for contact info (email/phone), provide it exactly as written in the CRM.
        - If asked who the top clients are, analyze the "Lifetime Value" in the CRM.
        - If asked about deadlines or briefs, look at the Active Pipeline.
        - Maintain a highly analytical, crisp, professional "JARVIS-like" tone. Always address the user as "Soumojit".`;

        const aiResponse = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            temperature: 0.1 // Kept exceptionally low so it strictly reads the data and doesn't hallucinate
        });

        return res.status(200).json({ reply: aiResponse.choices[0].message.content });

    } catch (err) {
        console.error("Admin Chat Error:", err);
        return res.status(500).json({ error: "Core Processing Failure." });
    }
};
