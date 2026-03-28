const axios = require("axios");

module.exports = async function (req, res) {
    // Allow only POST
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    // Admin security
    const authHeader = req.headers["x-admin-password"];
    if (authHeader !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: "Unauthorized Access. Core Locked." });
    }

    try {
        const { startDate, endDate, cursor = null } = req.body;

        // Validate input
        if (!startDate || !endDate) {
            return res.status(400).json({ error: "startDate and endDate required" });
        }

        // Debug logs (check in Vercel logs)
        console.log("APP_ID:", process.env.CASHFREE_APP_ID);
        console.log("SECRET:", process.env.CASHFREE_SECRET_KEY);

        // Call Cashfree API
        const response = await axios.post(
            "https://sandbox.cashfree.com/pg/settlements",
            {
                pagination: {
                    limit: 10,
                    cursor: cursor
                },
                filters: {
                    start_date: startDate,
                    end_date: endDate
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

        const settlements = response.data?.data || [];
        const nextCursor = response.data?.cursor || null;

        // Map response
        const mapped = settlements.map(item => ({
            order_id: item.order_id,
            payment_id: item.cf_payment_id,
            settlement_id: item.cf_settlement_id,
            order_amount: item.order_amount,
            service_charge: item.service_charge,
            service_tax: item.service_tax,
            settlement_amount: item.settlement_amount,
            transfer_utr: item.transfer_utr,
            transfer_time: item.transfer_time,
            currency: item.settlement_currency
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
