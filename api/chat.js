const OpenAI = require('openai');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY 
});

const generateOrderId = () => {
    return "ZYRO" + Date.now() + Math.random().toString(16).slice(2,6).toUpperCase();
};

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        // These values come directly from your HTML button clicks
        const { message, sessionId, phone, email, name, selectedService, amount } = req.body;

        // --- THE BRAIN: SYNCED WITH YOUR HTML ---
        const systemPrompt = `You are the lead project manager at ZyroEditz. 
        A client has expressed interest in: ${selectedService || 'our premium services'} priced at ₹${amount || 'custom'}.
        
        YOUR MISSION:
        1. Acknowledge the specific service they clicked (Short Form, Long Form, Color Grading, Sound Design, or Thumbnails).
        2. Briefly pitch the high-end quality of that specific service.
        3. Enforce the 100% upfront payment policy professionally.
        4. Mention the 100% refund guarantee to build trust.
        
        TONE: 
        - Strictly human, professional, and cinematic. 
        - DO NOT mention being an AI or a bot.
        
        TRIGGER: End your reply with INITIATE_CHECKOUT_NOW only when the client is ready to pay.`;

        const aiResponse = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile", 
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: message }
            ],
            temperature: 0.6
        });

        let replyText = aiResponse.choices[0].message.content;

        if (replyText.includes("INITIATE_CHECKOUT_NOW")) {
            replyText = replyText.replace("INITIATE_CHECKOUT_NOW", "").trim();
            const orderId = generateOrderId();

            // Save to Supabase
            await supabase.from('orders').insert([{
                order_id: orderId,
                client_name: name || "Zyro Client",
                client_email: email,
                client_phone: phone,
                service: selectedService,
                amount: amount, 
                status: 'pending'
            }]);

            // --- CASHFREE 2025-01-01 API ---
            const cashfreeResponse = await axios.post(
                'https://api.cashfree.com/pg/orders',
                {
                    order_id: orderId,
                    order_amount: parseFloat(amount).toFixed(2), 
                    order_currency: "INR",
                    customer_details: {
                        customer_id: sessionId || "CUST_" + Date.now(),
                        customer_name: name || "Zyro Client",
                        customer_email: email || "zyroeditz.official@gmail.com",
                        customer_phone: phone || "9999999999"
                    },
                    order_meta: {
                        return_url: "https://zyroeditz.vercel.app/payment-success?order_id={order_id}"
                    }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-version': '2025-01-01', 
                        'x-client-id': process.env.CASHFREE_APP_ID,
                        'x-client-secret': process.env.CASHFREE_SECRET_KEY
                    }
                }
            );

            return res.json({ 
                reply: replyText + "\n\nSecuring your project slot and opening the secure payment portal...", 
                paymentSessionId: cashfreeResponse.data.payment_session_id 
            });
        }

        return res.json({ reply: replyText });

    } catch (error) {
        console.error("Chat Error:", error);
        return res.status(500).json({ reply: "Our production studio is currently handling high volume. Please try again in a moment." });
    }
};
