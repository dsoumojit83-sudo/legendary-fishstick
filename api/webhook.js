const { createClient } = require('@supabase/supabase-js');

// Connect to the Supabase "Brain"
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

module.exports = async function(req, res) {
    // Only accept POST requests from Cashfree
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const payload = req.body;
        console.log("Webhook received from Cashfree:", JSON.stringify(payload));

        // Extract the event type and order ID from Cashfree's data structure
        const eventType = payload.type;
        const orderId = payload.data?.order?.order_id;

        // Check if this is a successful payment signal
        if (eventType && (eventType.includes('SUCCESS') || eventType === 'PAYMENT_SUCCESS_WEBHOOK') && orderId) {
            
            // 🔥 The Magic: Update the order status in Supabase
            const { error } = await supabase
                .from('orders')
                .update({ status: 'paid' })
                .eq('order_id', orderId);

            if (error) {
                console.error("Supabase Database Error:", error);
                return res.status(500).send("Failed to update database");
            }

            console.log(`✅ SUCCESS: Order ${orderId} marked as PAID in database.`);
            
            // Tell Cashfree we received the message successfully
            return res.status(200).send("OK");
        }

        // If it's a different event (like a failed payment), just acknowledge receipt so Cashfree doesn't keep retrying
        return res.status(200).send("Event received but not processed");

    } catch (error) {
        console.error("Webhook Server Error:", error);
        return res.status(500).send("Server Error");
    }
};
