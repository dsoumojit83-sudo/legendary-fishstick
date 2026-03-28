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
    "Coloring": 1 // Note: This matches the data-service="Coloring" in your frontend
};

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { sessionId, phone, email, name, selectedService, amount } = req.body;

        // 1. Data Validation
        if (!name || name.trim().length < 2) return res.status(400).json({ error: "Please provide a valid name.", field: "name" });
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) return res.status(400).json({ error: "Invalid email format.", field: "email" });
        const phoneRegex = /^\+?[0-9]{10,15}$/;
        const cleanPhone = phone ? phone.replace(/\s+/g, '') : '';
        if (!phone || !phoneRegex.test(cleanPhone)) return res.status(400).json({ error: "Please provide a valid 10-digit phone number.", field: "phone" });
        if (!selectedService || isNaN(parseFloat(amount))) return res.status(400).json({ error: "Invalid pricing data. Please restart the wizard.", field: "system" });

        // 2. Calculate Dynamic Deadline (IST = UTC+5:30)
        const daysToAdd = deadlineMap[selectedService] || 3; // Default to 3 if unknown
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in ms
        const nowIST = new Date(Date.now() + IST_OFFSET_MS); // Current time in IST
        nowIST.setUTCDate(nowIST.getUTCDate() + daysToAdd); // Add days in IST context
        const formattedDeadline = nowIST.toISOString().split('T')[0]; // Format as YYYY-MM-DD (IST date)

        const orderId = generateOrderId();
        const numericAmount = parseFloat(amount);

        // 3. Database Insertion (Now includes deadline_date)
        const { error: dbError } = await supabase.from('orders').insert([{
            order_id: orderId,
            client_name: name.trim(),
            client_email: email.trim(),
            client_phone: cleanPhone,
            service: selectedService,
            amount: numericAmount, 
            status: 'pending',
            deadline_date: formattedDeadline
        }]);

        if (dbError) {
            console.error("Supabase Insert Failed:", dbError);
            return res.status(500).json({ error: "Database error. Could not save order.", field: "system" });
        }

        // 4. Secure Cashfree Session
        const cashfreeResponse = await axios.post(
            'https://api.cashfree.com/pg/orders',
            {
                order_id: orderId,
                order_amount: numericAmount.toFixed(2), 
                order_currency: "INR",
                customer_details: {
                    customer_id: sessionId || "CUST_" + Date.now(),
                    customer_name: name.trim(),
                    customer_email: email.trim(),
                    customer_phone: cleanPhone
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

        return res.status(200).json({ 
            paymentSessionId: cashfreeResponse.data.payment_session_id,
            orderId: orderId
        });

    } catch (error) {
        console.error("Checkout System Error:", error.response?.data || error.message);
        return res.status(500).json({ error: "Payment gateway unavailable. Please try again.", field: "system" });
    }
};
