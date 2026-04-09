const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Rate limit: 5 retries per IP per 60s — retrying payment is not a bulk operation
const _retryRateMap = {};
const RETRY_RATE_MAX = 5;
const RETRY_RATE_WINDOW_MS = 60 * 1000;
function isRetryRateLimited(ip) {
    const now = Date.now();
    const recent = (_retryRateMap[ip] || []).filter(t => now - t < RETRY_RATE_WINDOW_MS);
    if (recent.length >= RETRY_RATE_MAX) { _retryRateMap[ip] = recent; return true; }
    recent.push(now);
    _retryRateMap[ip] = recent;
    return false;
}

module.exports = async function (req, res) {
    const allowed = ['https://zyroeditz.xyz', 'https://www.zyroeditz.xyz', 'https://zyroeditz.vercel.app'];
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (isRetryRateLimited(clientIp)) {
        return res.status(429).json({ error: 'Too many retry attempts. Please wait a moment.' });
    }

    try {
        const { order_id } = req.body;
        if (!order_id) return res.status(400).json({ error: 'Missing order_id.' });

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

        // 2. Fetch the existing Cashfree order to get its payment_session_id.
        //    Cashfree preserves the session for ACTIVE orders — no new order needed.
        let paymentSessionId = null;
        try {
            const cfRes = await axios.get(`https://api.cashfree.com/pg/orders/${order_id}`, {
                headers: {
                    'x-api-version': '2025-01-01',
                    'x-client-id': process.env.CASHFREE_APP_ID,
                    'x-client-secret': process.env.CASHFREE_SECRET_KEY
                }
            });
            paymentSessionId = cfRes.data.payment_session_id || null;
        } catch (cfErr) {
            // Cashfree order doesn't exist (admin-created via payment links, or expired)
            // Fall back: create a fresh Cashfree order with the same order_id
            if (cfErr.response?.status === 404 || !paymentSessionId) {
                const cleanPhone = order.client_phone
                    ? String(order.client_phone).replace(/\D/g, '').slice(-10)
                    : '9999999999';

                const freshRes = await axios.post('https://api.cashfree.com/pg/orders', {
                    order_id: order_id + '_R' + Date.now().toString().slice(-4),
                    order_amount: Number(order.amount).toFixed(2),
                    order_currency: 'INR',
                    customer_details: {
                        customer_id: order_id,
                        customer_name: order.client_name || 'Zyro Client',
                        customer_email: order.client_email || 'zyroeditz.official@gmail.com',
                        customer_phone: cleanPhone
                    },
                    order_meta: {
                        return_url: `https://zyroeditz.xyz/payment-success?order_id=${order_id}`
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
            } else {
                throw cfErr;
            }
        }

        if (!paymentSessionId) {
            return res.status(500).json({ error: 'Could not retrieve payment session from gateway.' });
        }

        return res.status(200).json({ paymentSessionId, order_id });

    } catch (err) {
        console.error('[retry-payment] Error:', err.response?.data || err.message);
        return res.status(500).json({ error: 'Retry failed. Please try again or contact support.' });
    }
};
