const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const sendInvoice = require('./sendInvoice'); // Connecting the missing invoice engine

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { order_id } = req.body;
        
        if (!order_id) {
            return res.status(400).json({ error: 'Missing order_id for verification.' });
        }

        // 1. Fetch current order status from our DB first to prevent duplicate emails
        const { data: currentOrder, error: fetchError } = await supabase
            .from('orders')
            .select('*')
            .eq('order_id', order_id)
            .single();

        if (fetchError || !currentOrder) {
            return res.status(404).json({ error: 'Order not found in system.' });
        }

        // If already paid, just return success (prevents duplicate invoice sending on page reload)
        if (currentOrder.status === 'paid' || currentOrder.status === 'completed') {
            return res.status(200).json({ success: true, status: currentOrder.status });
        }

        // 2. Fetch authoritative status directly from Cashfree
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

        const orderStatus = cashfreeResponse.data.order_status;

        // 3. Verify and Trigger Automation
        if (orderStatus === 'PAID') {
            // A. Update Database
            const { error: dbError } = await supabase
                .from('orders')
                .update({ status: 'paid' })
                .eq('order_id', order_id);

            if (dbError) {
                console.error("Supabase Status Update Failed:", dbError);
                throw new Error("Database update failed");
            }

            // B. Fire off the automated invoice silently in the background
            try {
                await sendInvoice(currentOrder);
            } catch (emailErr) {
                console.error("Invoice generation failed, but payment secured:", emailErr);
                // We don't fail the whole request if just the email fails
            }
            
            return res.status(200).json({ success: true, status: 'paid' });
        } 
        
        return res.status(200).json({ success: true, status: orderStatus.toLowerCase() });

    } catch (error) {
        console.error("Payment Verification System Error:", error.response?.data || error.message);
        return res.status(500).json({ error: "Failed to verify payment status with gateway." });
    }
};
