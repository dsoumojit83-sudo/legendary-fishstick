const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { order_id } = req.body;
        
        if (!order_id) {
            return res.status(400).json({ error: 'Missing order_id for verification.' });
        }

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

        // 2. Only update Supabase if the payment actually cleared
        if (orderStatus === 'PAID') {
            const { error: dbError } = await supabase
                .from('orders')
                .update({ status: 'paid' })
                .eq('order_id', order_id);

            if (dbError) {
                console.error("Supabase Status Update Failed:", dbError);
                throw new Error("Database update failed");
            }
            
            return res.status(200).json({ success: true, status: 'paid' });
        } 
        
        // If it's still pending or failed, return the status without updating the database to 'paid'
        return res.status(200).json({ success: true, status: orderStatus.toLowerCase() });

    } catch (error) {
        console.error("Payment Verification System Error:", error.response?.data || error.message);
        return res.status(500).json({ error: "Failed to verify payment status with gateway." });
    }
};
