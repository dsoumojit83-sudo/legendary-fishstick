const axios = require("axios");

module.exports = async function (req, res) {
    // Allow only POST
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    // Admin security
    const authHeader = req.headers["x-admin-password"];
    if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: "Unauthorized Access. Core Locked." });
    }

    try {
        const { startDate, endDate, cursor = null } = req.body;

        // Validate input
        if (!startDate || !endDate) {
            return res.status(400).json({ error: "startDate and endDate required" });
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
        console.error("Settlement Error:", err.response?.data || err.message);

        return res.status(500).json({
            success: false,
            error: "Failed to fetch settlements",
            details: err.response?.data || err.message
        });
    }
};
