const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const generateOrderId = () => {
    return "ZYRO" + Date.now() + Math.random().toString(16).slice(2,6).toUpperCase();
};

// --- DEADLINE TIMETABLE ---
const deadlineMap = {
    "Short Form": 2,
    "Long Form": 4,
    "Motion Graphics": 4,
    "Thumbnails": 1,
    "Sound Design": 3,
    "Coloring": 1 
};

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { sessionId, phone, email, name, selectedService, amount } = req.body;

        if (!selectedService || !amount) {
            return res.status(400).json({ reply: "Please select a valid service and pricing to proceed." });
        }

        const orderId = generateOrderId();
        const numericAmount = parseFloat(amount);

        // --- CALCULATE DYNAMIC DEADLINE DATE ---
        const daysToAdd = deadlineMap[selectedService] || 3;
        const deadlineDate = new Date();
        deadlineDate.setDate(deadlineDate.getDate() + daysToAdd);
        const formattedDeadline = deadlineDate.toISOString().split('T')[0];

        // --- FIX: CREATE CASHFREE SESSION FIRST ---
        // Only save to DB after Cashfree confirms a valid session.
        // This prevents zombie orders when Cashfree is down or misconfigured.
        const cashfreeResponse = await axios.post(
            'https://api.cashfree.com/pg/orders',
            {
                order_id: orderId,
                order_amount: numericAmount.toFixed(2),
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

        const paymentSessionId = cashfreeResponse.data.payment_session_id;

        // --- SAVE TO SUPABASE ONLY AFTER CASHFREE SUCCEEDS ---
        const { error: dbError } = await supabase.from('orders').insert([{
            order_id: orderId,
            client_name: name || "Zyro Client",
            client_email: email || "zyroeditz.official@gmail.com",
            client_phone: phone || "9999999999",
            service: selectedService,
            amount: numericAmount || 0,
            status: 'pending',
            deadline_date: formattedDeadline
        }]);

        if (dbError) {
            console.error("Supabase Insert Failed:", dbError);
            throw new Error("Database insertion failed");
        }

        const replyText = `Excellent choice. Our studio is ready to deliver premium, cinematic quality for your ${selectedService} project.\n\nPlease note: We require full payment before starting a project. However, we offer a 100% refund if you are not satisfied with the final result.\n\nSecuring your project slot and opening the secure payment portal...`;

        return res.json({
            reply: replyText,
            paymentSessionId
        });

    } catch (error) {
        console.error("Chat Checkout Error:", error.response?.data || error.message);
        return res.status(500).json({ reply: "Our payment gateway is currently handling high volume. Please try again in a moment." });
    }
};
