const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY 
});

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // 🔒 SECURITY PROTOCOL: Password Verification
    const authHeader = req.headers['x-admin-password'];
    if (authHeader !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized Access. Core Locked.' });
    }

    try {
        const { prompt } = req.body;

        // 1. Fetch real-time snapshot for the AI to analyze
        const { data: orders } = await supabase.from('orders').select('client_name, service, amount, status, deadline_date');
        
        let totalRev = 0;
        let activePipeline = [];
        
        if (orders) {
            orders.forEach(o => {
                if(o.status === 'paid' || o.status === 'completed') totalRev += Number(o.amount);
                if(o.status === 'pending' || o.status === 'in_progress') {
                    activePipeline.push(`Client: ${o.client_name}, Service: ${o.service}, Status: ${o.status}, Deadline: ${o.deadline_date || 'None'}`);
                }
            });
        }

        // 2. The Core Prompt Engineering
        const systemPrompt = `You are Zyro Core, the ultra-advanced AI studio manager for Soumojit Das (Founder of ZyroEditz).
        
        LIVE STUDIO DATA OVERVIEW:
        - Total Realized Revenue: ₹${totalRev}
        - Active Projects Count: ${activePipeline.length}
        - Active Projects Pipeline: \n${activePipeline.join('\n')}
        
        YOUR MISSION:
        1. Answer Soumojit's specific question using ONLY the provided data.
        2. Speak in a highly analytical, crisp, and professional "JARVIS-like" tone. 
        3. Always address him as "Soumojit".
        4. If asked about revenue, give exact numbers. If asked about projects, list the client names and status.`;

        // 3. Generate Response via Llama 3
        const aiResponse = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            temperature: 0.3 // Kept low for strictly analytical, accurate responses
        });

        return res.status(200).json({ reply: aiResponse.choices[0].message.content });

    } catch (err) {
        console.error("Admin Chat Error:", err);
        return res.status(500).json({ error: "Core Processing Failure." });
    }
};
