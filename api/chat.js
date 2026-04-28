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

// --- DEADLINE TIMETABLE (fallback if DB unreachable) ---
const _defaultDeadlineMap = {
    "Short Form": 2,
    "Long Form": 4,
    "Motion Graphics": 4,
    "Thumbnails": 1,
    "Sound Design": 3,
    "Coloring": 1
};

// Fetch live services from DB — returns { name → delivery_days_int }
async function fetchDeadlineMap() {
    try {
        const { data, error } = await supabase
            .from('services')
            .select('name, delivery_days, price')
            .eq('is_active', true);
        if (error || !data || !data.length) return _defaultDeadlineMap;
        const map = {};
        data.forEach(s => {
            // delivery_days may be "3-5 Days" or "3" — extract first integer
            const days = parseInt(String(s.delivery_days || '').match(/\d+/)?.[0] || '3');
            map[s.name] = days;
        });
        return map;
    } catch { return _defaultDeadlineMap; }
}

module.exports = async function (req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // B-04 FIX: Reject abusive IPs before hitting Cashfree or Supabase
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (isChatRateLimited(clientIp)) {
        return res.status(429).json({ reply: 'Too many requests. Please wait a moment before trying again.' });
    }

    try {
        const { sessionId, phone, email, name, cartItems, couponCode, action } = req.body;

        if (!cartItems || !cartItems.length) {
            return res.status(400).json({ reply: "Your cart is empty. Please add items to proceed." });
        }

        // FIX #14: Server-side studio Away check — the frontend check can be bypassed
        // by calling this API directly. Enforce the studio status gate at the API level.
        try {
            const { data: studioConfig } = await supabase
                .from('studio_config')
                .select('is_online')
                .eq('id', 1)
                .single();
            if (studioConfig && studioConfig.is_online === false) {
                return res.status(503).json({ reply: 'ZyroEditz\u2122 Studio is currently closed and not accepting new orders. Please check back soon or reach out via email.' });
            }
        } catch { /* If studio_config table doesn't exist, allow order creation */ }

        // Load live deadline map from DB
        const deadlineMap = await fetchDeadlineMap();

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

        // ── Compute Total Amount from Cart ──
        let subtotal = 0;
        let selectedService = '';
        const serviceNames = [];

        cartItems.forEach(item => {
            const itemTotal = (parseFloat(item.price) || 0) * (parseInt(item.qty) || 1);
            subtotal += itemTotal;
            serviceNames.push(`${item.name} (x${item.qty || 1})`);
        });
        selectedService = serviceNames.join(', ').substring(0, 500);

        let numericAmount = subtotal;

        // Apply Coupon Logic
        if (couponCode && typeof couponCode === 'string') {
            const { data: coupon, error: couponError } = await supabase
                .from('coupons')
                .select('*')
                .eq('code', couponCode.toUpperCase().trim())
                .eq('is_active', true)
                .single();

            if (!couponError && coupon) {
                // Validate min order value
                if (coupon.min_order_value && subtotal < coupon.min_order_value) {
                    return res.status(400).json({ reply: `Coupon requires a minimum order value of ₹${coupon.min_order_value}` });
                }
                // Validate usage limits
                if (coupon.max_uses > 0 && coupon.times_used >= coupon.max_uses) {
                    return res.status(400).json({ reply: `Coupon has reached its maximum usage limit.` });
                }
                // Validate expiry
                if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
                    return res.status(400).json({ reply: `Coupon has expired.` });
                }

                // Apply discount
                if (coupon.discount_type === 'fixed') {
                    numericAmount = Math.max(0, subtotal - parseFloat(coupon.discount_value));
                } else if (coupon.discount_type === 'percent') {
                    const discount = subtotal * (parseFloat(coupon.discount_value) / 100);
                    numericAmount = Math.max(0, subtotal - discount);
                }
            } else {
                return res.status(400).json({ reply: `Invalid or inactive coupon code.` });
            }
        }

        if (action === 'validateCoupon') {
            return res.status(200).json({
                valid: true,
                finalAmount: numericAmount,
                discount: subtotal - numericAmount
            });
        }

        // Guard: reject invalid amounts before hitting Cashfree
        if (numericAmount <= 0 || !Number.isFinite(numericAmount)) {
            return res.status(400).json({ reply: "Final amount must be greater than zero." });
        }

        // ── BUG FIX #9: Safer IST deadline — compute using explicit UTC year/month/day ──
        // Extract longest delivery days from the cart
        let maxDays = 3;
        cartItems.forEach(item => {
            const days = deadlineMap[item.name] || 3;
            if (days > maxDays) maxDays = days;
        });
        const daysToAdd = maxDays;
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
                order_amount: parseFloat(numericAmount.toFixed(2)),
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
