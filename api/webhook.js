const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend'); // 📦 Added Resend

// Connect to the Supabase "Brain"
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Connect to the Resend "Messenger"
const resend = new Resend(process.env.RESEND_API_KEY);

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
            
            // 🔥 The Magic: Update the order status AND grab the client's email
            const { data: order, error } = await supabase
                .from('orders')
                .update({ status: 'paid' })
                .eq('order_id', orderId)
                .select() // Grab the updated row
                .single(); // Ensure we only get one object

            if (error) {
                console.error("Supabase Database Error:", error);
                return res.status(500).send("Failed to update database");
            }

            console.log(`✅ SUCCESS: Order ${orderId} marked as PAID in database.`);
            
            // 📧 The Delivery: Send the MEGA.nz link via Resend
            if (order && order.client_email) {
                await resend.emails.send({
                    from: 'ZyroEditz <onboarding@resend.dev>', // Change to hello@zyroeditz.com when you get a custom domain
                    to: order.client_email,
                    subject: `Project Started: Order #${orderId}`,
                    html: `
                        <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
                            <h2>Payment Received! Let's get to work.</h2>
                            <p>Hey there, I've received your full payment for order <strong>#${orderId}</strong>.</p>
                            <p>As per the ZyroEditz policy: full payment upfront before we start, but a 100% refund if you aren't satisfied with the first draft.</p>
                            <p><strong>Next Step:</strong> Please upload your raw footage, assets, and project brief to my MEGA folder below:</p>
                            <br/>
                            <a href="YOUR_MEGA_FILE_REQUEST_LINK" style="display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Upload to MEGA</a>
                            <br/><br/>
                            <p>I'll notify you as soon as the first draft is ready for review.</p>
                            <hr />
                            <p>Best,<br /><strong>Soumojit Das</strong><br />Founder, ZyroEditz</p>
                        </div>
                    `
                });
                console.log(`📧 SUCCESS: MEGA link sent to ${order.client_email}.`);
            }

            // Tell Cashfree we received the message successfully
            return res.status(200).send("OK");
        }

        // If it's a different event (like a failed payment), just acknowledge receipt
        return res.status(200).send("Event received but not processed");

    } catch (error) {
        console.error("Webhook Server Error:", error);
        return res.status(500).send("Server Error");
    }
};
