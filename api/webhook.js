const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const sendInvoice = require('./sendInvoice');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Cashfree Webhook Signature Verification ───────────────────────────────────
// Cashfree signs every webhook using HMAC-SHA256 with your CASHFREE_SECRET_KEY.
// Message format: timestamp + rawBody (Cashfree's official specification)
// We re-stringify the parsed body since Vercel auto-parses JSON bodies.
function verifyWebhookSignature(req) {
    const timestamp = req.headers['x-webhook-timestamp'];
    const receivedSig = req.headers['x-webhook-signature'];

    if (!timestamp || !receivedSig || !process.env.CASHFREE_SECRET_KEY) return false;

    const rawBody = JSON.stringify(req.body);
    const message = timestamp + rawBody;

    const computedSig = crypto
        .createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
        .update(message)
        .digest('base64');

    try {
        // Timing-safe comparison prevents timing attacks
        return crypto.timingSafeEqual(
            Buffer.from(computedSig),
            Buffer.from(receivedSig)
        );
    } catch {
        return false; // Buffer length mismatch = definitely invalid
    }
}

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // 🔒 Verify the webhook came from Cashfree — reject spoofed payloads
    if (!verifyWebhookSignature(req)) {
        console.warn(`[ZYRO][webhook][SECURITY] ${new Date().toISOString()} | Signature verification FAILED. Rejecting request.`);
        return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    try {
        // --- CASHFREE WEBHOOK HANDLER ---
        // Ensure payload has the expected Cashfree webhook structure
        if (!req.body.data || !req.body.type) {
            return res.status(400).json({ error: 'Invalid Webhook Payload Structure' });
        }

        const eventType = req.body.type;
        const orderId = req.body.data.order?.order_id;
        const pmStatus = req.body.data.payment?.payment_status;

        console.log(`[Webhook] Received ${eventType} for Order: ${orderId}`);

        if (pmStatus === 'SUCCESS' && orderId) {
            // Fetch current status to prevent duplicate processing
            const { data: orderData, error: fetchError } = await supabase
                .from('orders')
                .select('*')
                .eq('order_id', orderId)
                .single();

            if (fetchError || !orderData) {
                console.error(`[ZYRO][webhook][ERROR] ${new Date().toISOString()} | order=${orderId} | Could not fetch order from DB:`, fetchError?.message);
            } else if (orderData.status === 'paid' || orderData.status === 'completed') {
                console.log(`[ZYRO][webhook][INFO] ${new Date().toISOString()} | order=${orderId} | Already '${orderData.status}' in DB. Skipping update + invoice.`);
            } else {
                // Status is 'pending' — we are first. Update to 'paid'.
                const { error: dbError } = await supabase
                    .from('orders')
                    .update({ status: 'paid' })
                    .eq('order_id', orderId);

                if (dbError) {
                    console.error(`[ZYRO][webhook][ERROR] ${new Date().toISOString()} | order=${orderId} | DB update to 'paid' FAILED:`, dbError.message);
                } else {
                    console.log(`[ZYRO][webhook][INFO] ${new Date().toISOString()} | order=${orderId} | DB updated to 'paid'. Firing sendInvoice()...`);
                    try {
                        await sendInvoice(orderData);
                        console.log(`[ZYRO][webhook][INFO] ${new Date().toISOString()} | order=${orderId} | Invoice email sent successfully.`);
                    } catch (invoiceErr) {
                        console.error(`[ZYRO][webhook][ERROR] ${new Date().toISOString()} | order=${orderId} | sendInvoice() FAILED:`, invoiceErr.message);
                    }
                }
            }
        }

        // Always return 200 OK so Cashfree stops retrying
        return res.status(200).send('Webhook Processed');

    } catch (error) {
        console.error("Webhook System Error:", error.message);
        return res.status(500).json({ error: "Webhook processing encountered a fatal error." });
    }
};

