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
    const _allowed = ['https://zyroeditz.xyz','https://www.zyroeditz.xyz','https://admin.zyroeditz.xyz','https://zyroeditz.vercel.app'];
    const _origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', _allowed.includes(_origin) ? _origin : _allowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'GET' && req.query.action === 'getTestimonials') {
        try {
            const { data, error } = await supabase.from('reviews')
                .select('client_name, rating, review_text')
                .eq('is_approved', true)
                .order('created_at', { ascending: false })
                .limit(2);
            if (error) throw error;
            return res.status(200).json({ testimonials: data });
        } catch(e) { return res.status(500).json({ error: 'Failed to fetch testimonials' }); }
    }

    // ── GET /api/chat?action=getStats — public stats for homepage ────────────
    if (req.method === 'GET' && req.query.action === 'getStats') {
        try {
            const { data: orders, error } = await supabase.from('orders')
                .select('client_email, created_at')
                .in('status', ['paid','working','completed','delivered']);
            if (error) throw error;
            const now = Date.now();
            let years = 1, clients = 0, projects = 0;
            if (orders && orders.length) {
                const earliest = Math.min(...orders.map(o => new Date(o.created_at).getTime()));
                years = Math.max(1, Math.floor((now - earliest) / (365.25 * 24 * 60 * 60 * 1000)));
                clients = new Set(orders.map(o => (o.client_email || '').toLowerCase())).size;
                projects = orders.length;
            }
            res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
            return res.status(200).json({ years, clients, projects });
        } catch(e) { return res.status(500).json({ error: 'Failed to fetch stats' }); }
    }

    // ── GET /api/chat?action=applyCoupon&code=X&amount=Y — public coupon validation ─
    if (req.method === 'GET' && req.query.action === 'applyCoupon') {
        const code = (req.query.code || '').toUpperCase().trim();
        const orderAmount = parseFloat(req.query.amount) || 0;
        if (!code) return res.status(400).json({ error: 'Coupon code is required.' });
        try {
            const { data: coupon, error } = await supabase.from('coupons')
                .select('*').eq('code', code).eq('is_active', true).maybeSingle();
            if (error) throw error;
            if (!coupon) {
                if (code.startsWith('ZYRO-') && code.length >= 10) {
                    let discount = Math.round(orderAmount * 10 / 100); // 10% discount for referrals
                    return res.status(200).json({ discount, code, type: 'referral', value: 10 });
                }
                return res.status(404).json({ error: 'Invalid coupon or referral code.' });
            }
            if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) return res.status(400).json({ error: 'Coupon has expired.' });
            if (coupon.max_uses > 0 && coupon.times_used >= coupon.max_uses) return res.status(400).json({ error: 'Coupon usage limit reached.' });
            if (coupon.min_order_value && orderAmount < coupon.min_order_value) return res.status(400).json({ error: 'Minimum order ₹' + coupon.min_order_value + ' required.' });
            let discount = 0;
            if (coupon.discount_type === 'percent') {
                discount = Math.round(orderAmount * coupon.discount_value / 100);
            } else {
                discount = Math.min(coupon.discount_value, orderAmount);
            }
            return res.status(200).json({ discount, code: coupon.code, type: coupon.discount_type, value: coupon.discount_value });
        } catch(e) { return res.status(500).json({ error: 'Failed to validate coupon.' }); }
    }

    // ── GET /api/chat?action=getBill&orderId=X&email=Y ──────────────────────────
    // Client-side invoice download. No JWT — ownership proven by email+orderId pair.
    // Ref: OWASP Broken Object Level Authorization: https://owasp.org/API-Security/
    if (req.method === 'GET' && req.query.action === 'getBill') {
        const { orderId, email } = req.query;
        if (!orderId || !email) return res.status(400).json({ error: 'Missing orderId or email.' });
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email.' });

        // Fetch order — parameterized query (Supabase SDK always parameterizes .eq() calls)
        const { data: order, error: dbErr } = await supabase
            .from('orders')
            .select('order_id, client_name, client_email, client_phone, service, amount, deadline_date, status')
            .eq('order_id', orderId)
            .maybeSingle();

        if (dbErr || !order) return res.status(404).json({ error: 'Order not found.' });

        // SECURITY: verify ownership
        if (email.toLowerCase() !== (order.client_email || '').toLowerCase()) {
            return res.status(403).json({ error: 'Email does not match order records.' });
        }

        // Only allow download after payment confirmed
        const paidStatuses = ['paid', 'working', 'completed'];
        if (!paidStatuses.includes(order.status)) {
            return res.status(403).json({ error: 'Invoice not available until payment is confirmed.' });
        }

        try {
            const { buildPdfBuffer } = require('./sendInvoice');
            const pdfBuffer = await buildPdfBuffer(order);
            res.setHeader('Content-Type',        'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="ZyroEditz_Invoice_${order.order_id}.pdf"`);
            res.setHeader('Content-Length',      pdfBuffer.length);
            res.setHeader('Cache-Control',       'no-store');
            return res.status(200).end(pdfBuffer);
        } catch (err) {
            console.error('[chat][getBill] PDF error:', err.message);
            return res.status(500).json({ error: 'Failed to generate invoice.' });
        }
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });


    // B-04 FIX: Reject abusive IPs before hitting Cashfree or Supabase
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (isChatRateLimited(clientIp)) {
        return res.status(429).json({ reply: 'Too many requests. Please wait a moment before trying again.' });
    }

    try {
        const { action, rating, review_text, order_id, sessionId, phone, email, name, selectedService, amount } = req.body;

        if (action === 'submitReview') {
            if (!rating || !review_text) return res.status(400).json({ error: 'Rating and review text are required.' });
            const { error: dbError } = await supabase.from('reviews').insert([{
                order_id: order_id || null,
                client_name: name || 'Anonymous',
                rating: parseInt(rating),
                review_text: review_text,
                is_approved: false
            }]);
            if (dbError) throw dbError;
            return res.status(200).json({ success: true });
        }

        if (!selectedService || !amount) {
            return res.status(400).json({ reply: "Please select a valid service and pricing to proceed." });
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
        const numericAmount = parseFloat(amount);

        // Guard: reject invalid amounts before hitting Cashfree
        // Negative, zero, or NaN amounts cause a confusing 422 from Cashfree's API.
        if (!numericAmount || numericAmount <= 0 || !Number.isFinite(numericAmount)) {
            return res.status(400).json({ reply: "Invalid payment amount. Please contact support." });
        }

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
                        return `${base}/checkout/?order_id={order_id}`;
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
            status: 'created',
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
