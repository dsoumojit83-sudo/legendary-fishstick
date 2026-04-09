const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const generateOrderId = () => {
    return "ZYRO" + Date.now() + Math.random().toString(16).slice(2, 6).toUpperCase();
};

// B-04 FIX: Rate limiter — prevents bots from spamming order creation.
// Sliding window: 10 requests per IP per 60 seconds (tighter than verify-payment
// because each request hits both Cashfree AND Supabase).
const _chatRateMap = {};
const CHAT_RATE_MAX = 10;
const CHAT_RATE_WINDOW_MS = 60 * 1000;
function isChatRateLimited(ip) {
    const now = Date.now();
    const recent = (_chatRateMap[ip] || []).filter(t => now - t < CHAT_RATE_WINDOW_MS);
    if (recent.length >= CHAT_RATE_MAX) { _chatRateMap[ip] = recent; return true; }
    recent.push(now);
    _chatRateMap[ip] = recent;
    return false;
}

// --- DEADLINE TIMETABLE ---
const deadlineMap = {
    "Short Form": 2,
    "Long Form": 4,
    "Motion Graphics": 4,
    "Thumbnails": 1,
    "Sound Design": 3,
    "Coloring": 1
};

module.exports = async function (req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // B-04 FIX: Reject abusive IPs before hitting Cashfree or Supabase
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (isChatRateLimited(clientIp)) {
        return res.status(429).json({ reply: 'Too many requests. Please wait a moment before trying again.' });
    }

    try {
        const { sessionId, phone, email, name, selectedService, amount } = req.body;

        if (!selectedService || !amount) {
            return res.status(400).json({ reply: "Please select a valid service and pricing to proceed." });
        }

        // ── Validate user-supplied fields before sending to Cashfree / Supabase ──
        // Cashfree strictly requires a valid 10-digit phone number.
        const phoneRegex = /^[0-9]{10}$/;
        // B5 FIX: phone is now REQUIRED — reject if missing, not just if malformed.
        // A fake default (9999999999) creates junk customer records in Cashfree.
        if (!phone || !phoneRegex.test(String(phone).trim())) {
            return res.status(400).json({ reply: "Please provide a valid 10-digit phone number (no spaces or country code)." });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (email && !emailRegex.test(String(email).trim())) {
            return res.status(400).json({ reply: "Please provide a valid email address." });
        }
        if (name && String(name).trim().length > 100) {
            return res.status(400).json({ reply: "Name is too long. Please use a shorter name." });
        }

        const safeName  = name  ? String(name).trim().substring(0, 100)  : "Zyro Client";
        const safeEmail = email ? String(email).trim().substring(0, 200) : "zyroeditz.official@gmail.com";
        const safePhone = String(phone).trim(); // always valid — guarded above

        const orderId = generateOrderId();
        const numericAmount = parseFloat(amount);

        // ── BUG FIX #9: Safer IST deadline — compute using explicit UTC year/month/day ──
        // Avoids setUTCDate() month-rollover edge cases when adding days near month boundaries.
        const daysToAdd = deadlineMap[selectedService] || 3;
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const nowIST = new Date(Date.now() + IST_OFFSET_MS);
        // Extract IST calendar date components, then add daysToAdd cleanly via a new Date constructor
        const [istYear, istMonth, istDay] = nowIST.toISOString().split('T')[0].split('-').map(Number);
        const deadlineIST = new Date(Date.UTC(istYear, istMonth - 1, istDay + daysToAdd));
        const formattedDeadline = deadlineIST.toISOString().split('T')[0]; // YYYY-MM-DD

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
                    customer_name: safeName,
                    customer_email: safeEmail,
                    customer_phone: safePhone
                },
                order_meta: {
                    // Build return_url from request origin so payment redirects back to
                    // whichever domain the user initiated from (zyroeditz.xyz OR zyroeditz.vercel.app)
                    return_url: (function() {
                        const allowedReturnOrigins = [
                            'https://zyroeditz.xyz',
                            'https://zyroeditz.vercel.app',
                        ];
                        const incomingOrigin = req.headers.origin || req.headers.referer || '';
                        const matchedOrigin = allowedReturnOrigins.find(o => incomingOrigin.startsWith(o));
                        const base = matchedOrigin || process.env.SITE_URL || 'https://zyroeditz.xyz';
                        return `${base}/payment-success?order_id={order_id}`;
                    })()
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
            client_name: safeName,
            client_email: safeEmail,
            client_phone: safePhone,
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
