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

function isRateLimited(ip) {
    const now = Date.now();
    if (!_rateLimitMap[ip]) _rateLimitMap[ip] = [];
    // Evict timestamps older than the window
    _rateLimitMap[ip] = _rateLimitMap[ip].filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (_rateLimitMap[ip].length >= RATE_LIMIT_MAX) return true;
    _rateLimitMap[ip].push(now);
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
    // CORS headers — payment-success page may be served from a different origin
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // Rate limit by IP to prevent Cashfree quota exhaustion
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (isRateLimited(clientIp)) {
        log('WARN', null, `Rate limit hit for IP: ${clientIp}`);
        return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
    }

    try {
        const { order_id } = req.body;

        if (!order_id) {
            log('ERROR', null, 'Request arrived with missing order_id.');
            return res.status(400).json({ error: 'Missing order_id for verification.' });
        }

        log('INFO', order_id, 'Verification request received. Calling Cashfree API...');

        // 1. Fetch the authoritative status directly from Cashfree (Server-to-Server)
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

        const orderStatus = cashfreeResponse.data.order_status; // e.g., "PAID", "ACTIVE"
        log('INFO', order_id, `Cashfree returned order_status: ${orderStatus}`);

        // 2. Only proceed if the payment actually cleared on Cashfree
        if (orderStatus === 'PAID') {

            // Fetch current order details from your database
            const { data: orderData, error: fetchError } = await supabase
                .from('orders')
                .select('*')
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

            // If it hasn't been marked as paid yet, update the Database now
            const { error: dbError } = await supabase
                .from('orders')
                .update({ status: 'paid' })
                .eq('order_id', order_id);

            if (dbError) {
                log('ERROR', order_id, 'Supabase status update to "paid" FAILED.', dbError);
                throw new Error("Database update failed");
            }

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
        log('INFO', order_id, `Order is not yet PAID. Returning status: ${orderStatus.toLowerCase()}`);
        return res.status(200).json({ success: true, status: orderStatus.toLowerCase() });

    } catch (error) {
        const order_id_ctx = req.body?.order_id || 'UNKNOWN';
        log('ERROR', order_id_ctx, 'Unhandled exception in verify-payment handler.', error);
        return res.status(500).json({ error: "Failed to verify payment status with gateway." });
    }
};
