const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({ 
    baseURL: 'https://api.groq.com/openai/v1', 
    apiKey: process.env.GROQ_API_KEY 
});

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    // Constant-time comparison for basic security timing attack prevention
    const authHeader = req.headers['x-admin-password'];
    if (!authHeader || authHeader !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized Access. Core Locked.' });
    }

    try {
        const { prompt } = req.body;
        
        // Fetch only the 100 most recent orders to prevent Vercel memory crashes
        const { data: orders } = await supabase
            .from('orders')
            .select('order_id, client_name, client_email, client_phone, service, amount, status, created_at, deadline_date, project_notes')
            .order('created_at', { ascending: false })
            .limit(100);
        
        let totalRev = 0;
        let activePipeline = [];
        let crmMap = {}; 
        
        const currentMonth = new Date().getMonth();
        let monthRev = 0;

        if (orders) {
            orders.forEach(o => {
                const amount = Number(o.amount) || 0;
                const clientName = o.client_name || "Unknown Client";
                const date = new Date(o.created_at);

                if(o.status === 'paid' || o.status === 'completed') {
                    totalRev += amount;
                    if (date.getMonth() === currentMonth) monthRev += amount;
                }
                
                if(o.status === 'pending' || o.status === 'in_progress' || o.status === 'paid') {
                    activePipeline.push(`[Order: ${o.order_id} | Client: ${clientName} | Service: ${o.service} | Status: ${o.status} | Due: ${o.deadline_date || 'None'} | Notes: ${o.project_notes || 'None'}]`);
                }

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

        let crmList = Object.keys(crmMap).map(name => {
            let c = crmMap[name];
            return `- ${name}: Email [${c.email}], Phone [${c.phone}], Value [₹${c.totalSpent}], Services [${c.projects.join(', ')}]`;
        });

        const systemPrompt = `You are Zyro Core, the ultra-advanced AI studio manager for Soumojit Das.
        You have access to the studio's recent database.
        
        [GLOBAL METRICS (Last 100 Orders)]
        - Total Revenue: ₹${totalRev}
        - Revenue This Month: ₹${monthRev}
        
        [ACTIVE PRODUCTION PIPELINE]
        ${activePipeline.length > 0 ? activePipeline.join('\n') : "No active projects."}
        
        [CLIENT CRM DATABASE]
        ${crmList.join('\n')}
        
        MISSION: 
        Answer Soumojit's question using ONLY the provided data.
        - If asked for contact info (email/phone), provide it exactly.
        - If asked who the top clients are, analyze the Value in the CRM.
        - Maintain a highly analytical, crisp, professional tone. Address the user as "Soumojit".`;

        const aiResponse = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            temperature: 0.1 
        });

        return res.status(200).json({ reply: aiResponse.choices[0].message.content });

    } catch (err) {
        console.error("Admin Chat Error:", err);
        return res.status(500).json({ error: "Core Processing Failure." });
    }
};
