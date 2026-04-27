const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const sendInvoice = require('./sendInvoice');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─── RATE LIMITER (Bug Fix A8) ────────────────────────────────────────────────
// Prevents polling attacks that exhaust Cashfree API quota.
// Simple sliding-window: 20 requests per IP per 60 seconds.
// NOTE: Resets on Vercel cold starts — best-effort, stops naive abusers.
const _rateLimitMap = {};
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
let _rateLimitGcCounter = 0;

function isRateLimited(ip) {
    const now = Date.now();
    // Step 1: Evict all timestamps older than the sliding window
    const recent = (_rateLimitMap[ip] || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    // Step 2: GC — if all old timestamps expired, drop the key entirely (memory cleanup)
    if (recent.length === 0) {
        delete _rateLimitMap[ip];
    }
    // Step 3: If this IP is at or over the limit, reject without recording the attempt
    if (recent.length >= RATE_LIMIT_MAX) {
        _rateLimitMap[ip] = recent;
        return true;
    }
    // Step 4: Record this request and store back
    recent.push(now);
    _rateLimitMap[ip] = recent;
    // GC: Every 100 requests, evict all stale IPs to prevent memory leak
    if (++_rateLimitGcCounter % 100 === 0) {
        Object.keys(_rateLimitMap).forEach(k => {
            if (_rateLimitMap[k].every(t => now - t >= RATE_LIMIT_WINDOW_MS)) delete _rateLimitMap[k];
        });
    }
    return false;
}

// Add retry rate limiter
const _retryRateMap = {};
const RETRY_RATE_MAX = 5;
const RETRY_RATE_WINDOW_MS = 60 * 1000;
function isRetryRateLimited(ip) {
    const now = Date.now();
    const recent = (_retryRateMap[ip] || []).filter(t => now - t < RETRY_RATE_WINDOW_MS);
    if (recent.length >= RETRY_RATE_MAX) { _retryRateMap[ip] = recent; return true; }
    recent.push(now);
    _retryRateMap[ip] = recent;
    // Shares GC counter with main limiter
    if (_rateLimitGcCounter % 100 === 0) {
        Object.keys(_retryRateMap).forEach(k => {
            if (_retryRateMap[k].every(t => now - t >= RETRY_RATE_WINDOW_MS)) delete _retryRateMap[k];
        });
    }
    return false;
}

// ─── STRUCTURED LOGGER ───────────────────────────────────────────────────────
function log(level, orderId, message, extra) {
    const ts = new Date().toISOString();
    const orderTag = orderId ? `order=${orderId}` : 'order=UNKNOWN';
    const prefix = `[ZYRO][verify-payment][${level}] ${ts} | ${orderTag} |`;
    if (level === 'ERROR' && extra) {
        console.error(prefix, message);
        console.error(prefix, 'Error name   :', extra.name);
        console.error(prefix, 'Error message:', extra.message);
        console.error(prefix, 'Error code   :', extra.code);
        console.error(prefix, 'Error stack  :', extra.stack);
        if (extra.response?.data) console.error(prefix, 'API response :', JSON.stringify(extra.response.data));
    } else if (level === 'ERROR') {
        console.error(prefix, message);
    } else {
        console.log(prefix, message);
    }
}

module.exports = async function (req, res) {
    // CORS — locked to known production origins; localhost for development
    const allowedOrigins = [
        'https://zyroeditz.xyz',
        'https://www.zyroeditz.xyz',
        'https://zyroeditz.vercel.app',
    ];
    const requestOrigin = req.headers.origin || '';
    const originOk = allowedOrigins.includes(requestOrigin) ||
                     requestOrigin.startsWith('http://localhost') ||
                     requestOrigin.startsWith('http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Origin', originOk ? requestOrigin : allowedOrigins[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // M-02 FIX: GET ?config=true — returns only the PUBLIC Supabase anon key + URL
    // so payment-success can initialise a Supabase client for cart cleanup.
    // Never exposes the service-role key or any secret. Safe to call from the browser.
    if (req.method === 'GET' && req.query.config === 'true') {
        return res.status(200).json({
            supabaseUrl: process.env.SUPABASE_URL,
            supabaseAnonKey: process.env.SUPABASE_ANON_KEY
        });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const action = req.body?.action;

    if (action === 'retry') {
        if (isRetryRateLimited(clientIp)) {
            return res.status(429).json({ error: 'Too many retry attempts. Please wait a moment.' });
        }
    } else {
        // Rate limit by IP to prevent Cashfree quota exhaustion (verify calls)
        if (isRateLimited(clientIp)) {
            log('WARN', null, `Rate limit hit for IP: ${clientIp}`);
            return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
        }
    }

    try {
        const { order_id } = req.body;

        if (!order_id) {
            log('ERROR', null, 'Request arrived with missing order_id.');
            return res.status(400).json({ error: 'Missing order_id.' });
        }

        if (action === 'retry') {
            log('INFO', order_id, 'Retry payment request received.');

            // 1. Verify this order actually exists in our DB and is still pending
            const { data: order, error: dbErr } = await supabase
                .from('orders')
                .select('order_id, status, amount, client_name, client_email, client_phone, service')
                .eq('order_id', order_id)
                .single();

            if (dbErr || !order) return res.status(404).json({ error: 'Order not found.' });

            // If already paid, no retry needed — send them to success
            if (order.status === 'paid' || order.status === 'completed') {
                return res.status(200).json({ already_paid: true });
            }

            // 2. Try to reuse the existing Cashfree order's payment_session_id.
            // FIX: Only create a new CF order as last resort, and use the SAME DB order_id
            // to prevent orphan orders that never get verified.
            let paymentSessionId = null;
            try {
                const cfRes = await axios.get(`https://api.cashfree.com/pg/orders/${order_id}`, {
                    headers: {
                        'x-api-version': '2025-01-01',
                        'x-client-id': process.env.CASHFREE_APP_ID,
                        'x-client-secret': process.env.CASHFREE_SECRET_KEY
                    }
                });
                // If the order is still ACTIVE, reuse its session
                if (cfRes.data.order_status === 'ACTIVE') {
                    paymentSessionId = cfRes.data.payment_session_id || null;
                }
            } catch (cfErr) {
                // Cashfree order doesn't exist or errored — will create new below
            }

            // If we couldn't get a session (order expired/paid/404), create a fresh CF order
            // with a unique ID, but keep our DB order_id the same for verification continuity.
            if (!paymentSessionId) {
                const cleanPhone = order.client_phone
                    ? String(order.client_phone).replace(/\D/g, '').slice(-10)
                    : '9999999999';

                // Use dynamic origin for return URL (same pattern as chat.js)
                const allowedReturnOrigins = ['https://zyroeditz.xyz', 'https://zyroeditz.vercel.app'];
                const incomingOrigin = req.headers.origin || req.headers.referer || '';
                const matchedOrigin = allowedReturnOrigins.find(o => incomingOrigin.startsWith(o));
                const base = matchedOrigin || 'https://zyroeditz.xyz';

                const retryOrderId = order_id + '_R' + Date.now().toString().slice(-4);
                const freshRes = await axios.post('https://api.cashfree.com/pg/orders', {
                    order_id: retryOrderId,
                    order_amount: parseFloat(Number(order.amount).toFixed(2)),
                    order_currency: 'INR',
                    customer_details: {
                        customer_id: order_id,
                        customer_name: order.client_name || 'Zyro Client',
                        customer_email: order.client_email || 'zyroeditz.official@gmail.com',
                        customer_phone: cleanPhone
                    },
                    order_meta: {
                        return_url: `${base}/payment-success?order_id=${order_id}`
                    }
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-version': '2025-01-01',
                        'x-client-id': process.env.CASHFREE_APP_ID,
                        'x-client-secret': process.env.CASHFREE_SECRET_KEY
                    }
                });
                paymentSessionId = freshRes.data.payment_session_id;

                // Store the retry CF order ID so webhook can map it back to the original
                await supabase.from('orders')
                    .update({ retry_cf_order_id: retryOrderId })
                    .eq('order_id', order_id);
            }

            if (!paymentSessionId) {
                return res.status(500).json({ error: 'Could not retrieve payment session from gateway.' });
            }

            return res.status(200).json({ paymentSessionId, order_id });
        }

        log('INFO', order_id, 'Verification request received. Calling Cashfree API...');

        // 1. Fetch the authoritative status directly from Cashfree (Server-to-Server)
        let orderStatus;
        try {
            const cashfreeResponse = await axios.get(
                `https://api.cashfree.com/pg/orders/${order_id}`,
                {
                    headers: {
                        'x-api-version': '2025-01-01',
                        'x-client-id': process.env.CASHFREE_APP_ID,
                        'x-client-secret': process.env.CASHFREE_SECRET_KEY
                    }
                }
            );
            orderStatus = cashfreeResponse.data.order_status; // e.g. "PAID", "ACTIVE"
            log('INFO', order_id, `Orders API returned order_status: ${orderStatus}`);
        } catch (cfErr) {
            throw cfErr; // re-throw for any error (auth, network, 404, etc.)
        }

        // 2. Only proceed if the payment actually cleared on Cashfree
        if (orderStatus === 'PAID') {

            // Fetch current order details from your database
            const { data: orderData, error: fetchError } = await supabase
                .from('orders')
                .select('order_id, client_name, client_email, client_phone, service, amount, status, deadline_date, created_at, project_notes')
                .eq('order_id', order_id)
                .single();

            if (fetchError) {
                log('ERROR', order_id, 'Supabase fetch failed — cannot retrieve order data for invoice.', fetchError);
                throw new Error("Could not fetch order data for invoice.");
            }

            log('INFO', order_id, `DB record fetched. Current status in DB: '${orderData.status}'`);

            // --- CRITICAL FIX: PREVENT DOUBLE EMAILS ---
            // If it's already marked as paid in our DB, the user just refreshed the page. 
            // Return success to the frontend, but DO NOT send another invoice.
            if (orderData.status === 'paid' || orderData.status === 'completed') {
                log('INFO', order_id, `Duplicate call detected (DB status='${orderData.status}'). Skipping invoice. Returning 200.`);
                return res.status(200).json({ success: true, status: 'paid' });
            }

            // If it hasn't been marked as paid yet, atomically update the Database now.
            // RACE FIX: Use .eq('status', 'pending') so only the FIRST caller (webhook OR
            // verify-payment) wins. The loser gets count=0 and skips the invoice.
            const { data: updateData, error: dbError } = await supabase
                .from('orders')
                .update({ status: 'paid' })
                .eq('order_id', order_id)
                .eq('status', 'pending')
                .select('order_id');

            if (dbError) {
                log('ERROR', order_id, 'Supabase status update to "paid" FAILED.', dbError);
                throw new Error("Database update failed");
            }

            // If no rows were updated, another process already flipped it — skip invoice
            if (!updateData || updateData.length === 0) {
                log('INFO', order_id, 'Atomic update matched 0 rows — another process already handled this. Skipping invoice.');
                return res.status(200).json({ success: true, status: 'paid' });
            }

            // Cart cleanup is handled client-side (payment-success page clears localStorage + Supabase cart)

            log('INFO', order_id, 'DB status updated to "paid". Triggering sendInvoice()...');

            // Fire the invoice system with the client's data ONE TIME
            try {
                await sendInvoice(orderData);
                log('INFO', order_id, 'sendInvoice() resolved successfully.');
            } catch (invoiceErr) {
                log('ERROR', order_id, 'sendInvoice() FAILED after payment was confirmed. Client did NOT receive invoice email.', invoiceErr);
            }

            return res.status(200).json({ success: true, status: 'paid' });
        }

        // If it's still pending or failed, return the status
        log('INFO', order_id, `Order is not yet PAID. Returning status: ${String(orderStatus).toLowerCase()}`);
        return res.status(200).json({ success: true, status: String(orderStatus).toLowerCase() });

    } catch (error) {
        const order_id_ctx = req.body?.order_id || 'UNKNOWN';
        log('ERROR', order_id_ctx, 'Unhandled exception in verify-payment handler.', error);
        const action = req.body?.action;
        if (action === 'retry') {
            return res.status(500).json({ error: 'Retry failed. Please try again or contact support.' });
        }
        return res.status(500).json({ error: "Failed to verify payment status with gateway." });
    }
};
