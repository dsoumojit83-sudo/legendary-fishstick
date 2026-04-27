const axios = require("axios");
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'zyroeditz.official@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

module.exports = async function (req, res) {
    // B-20 FIX: Browser sends an OPTIONS preflight before the POST.
    // Without handling OPTIONS, it returned 405 → the real POST never fired
    // → settlements tab silently failed to load on first open.
    const _sAllowed = ['https://zyroeditz.xyz','https://www.zyroeditz.xyz','https://admin.zyroeditz.xyz','https://zyroeditz.vercel.app'];
    const _sOrigin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', _sAllowed.includes(_sOrigin) ? _sOrigin : _sAllowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Allow only POST
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    // 🔒 JWT Auth
    const authH = req.headers['authorization'];
    if (!authH?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user: u }, error: uErr } = await supabase.auth.getUser(authH.slice(7));
    if (uErr || !u) return res.status(401).json({ error: 'Unauthorized' });
    if (!ADMIN_EMAILS.includes((u.email || '').toLowerCase())) return res.status(403).json({ error: 'Forbidden: Admin access required.' });

    try {
        const { startDate, endDate, cursor = null } = req.body;

        // Validate input — both fields required
        if (!startDate || !endDate) {
            return res.status(400).json({ error: "startDate and endDate required" });
        }
        // MEDIUM FIX #8: Validate date format before forwarding to Cashfree API.
        // Without this, malformed input (e.g. SQL-like strings, wrong format) propagates
        // to Cashfree and returns a confusing 400/422 gateway error instead of a clean local one.
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
            return res.status(400).json({ error: "Dates must be in YYYY-MM-DD format." });
        }
        if (new Date(startDate) > new Date(endDate)) {
            return res.status(400).json({ error: "startDate must be before or equal to endDate." });
        }

        // Call Cashfree LIVE API
        const response = await axios.post(
            "https://api.cashfree.com/pg/settlements",
            {
                pagination: {
                    limit: 10,
                    cursor: cursor
                },
                filters: {
                    start_date: `${startDate}T00:00:00Z`,
                    end_date: `${endDate}T23:59:59Z`
                }
            },
            {
                headers: {
                    "x-client-id": process.env.CASHFREE_APP_ID,
                    "x-client-secret": process.env.CASHFREE_SECRET_KEY,
                    "x-api-version": "2025-01-01",
                    "Content-Type": "application/json"
                }
            }
        );

        // ✅ Correct extraction (FIXED)
        const settlements = response.data?.data?.content || [];
        const nextCursor = response.data?.data?.cursor || null;

        // Map properly
        const mapped = settlements.map(item => ({
            order_id: item.order_id || null,
            payment_id: item.cf_payment_id || null,
            settlement_id: item.cf_settlement_id || null,
            order_amount: item.order_amount || 0,
            service_charge: item.service_charge || 0,
            service_tax: item.service_tax || 0,
            settlement_amount: item.settlement_amount || 0,
            transfer_utr: item.transfer_utr || null,
            transfer_time: item.transfer_time || null,
            currency: item.settlement_currency || null
        }));

        return res.status(200).json({
            success: true,
            data: mapped,
            cursor: nextCursor,
            hasMore: !!nextCursor
        });

    } catch (err) {
        // Log full error server-side (Vercel logs) — do NOT expose gateway internals to browser
        console.error("Settlement Error:", err.response?.data || err.message);

        return res.status(500).json({
            success: false,
            error: "Failed to fetch settlements. Please try again or check your date range.",
        });
    }
};
