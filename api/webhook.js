const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const sendInvoice = require('./sendInvoice');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Disable Vercel's auto body-parser so we can capture the raw body ──
// Cashfree signs the EXACT raw HTTP body bytes. If Vercel parses JSON first and we
// re-stringify it, key order / whitespace may differ → HMAC mismatch → false 401.
// With bodyParser:false the handler receives the raw stream and parses JSON manually.
// NOTE: config is exported AFTER the handler assignment below to avoid being overwritten.

// Read the full raw body from the request stream
function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// ── Cashfree Webhook Signature Verification ───────────────────────────────────
// Cashfree signs every webhook using HMAC-SHA256 with your CASHFREE_SECRET_KEY.
// Message format: timestamp + rawBody (Cashfree's official specification)
function verifyWebhookSignature(timestamp, rawBody, receivedSig) {
    if (!timestamp || !receivedSig || !process.env.CASHFREE_SECRET_KEY) return false;

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

const _handler = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // Read raw body FIRST (before any parsing) — required for correct HMAC verification
    const rawBody = await readRawBody(req);
    const timestamp = req.headers['x-webhook-timestamp'];
    const receivedSig = req.headers['x-webhook-signature'];

    // 🔒 Replay attack protection — reject stale webhooks older than 5 minutes.
    // Cashfree always sends a fresh timestamp; replayed payloads will be stale.
    const webhookAge = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!timestamp || isNaN(webhookAge) || webhookAge > 300) {
        console.warn(`[ZYRO][webhook][SECURITY] ${new Date().toISOString()} | Stale or missing timestamp (age: ${webhookAge}s). Rejecting.`);
        return res.status(401).json({ error: 'Webhook timestamp expired or missing.' });
    }

    // 🔒 Verify the webhook came from Cashfree — reject spoofed payloads
    if (!verifyWebhookSignature(timestamp, rawBody, receivedSig)) {
        console.warn(`[ZYRO][webhook][SECURITY] ${new Date().toISOString()} | Signature verification FAILED. Rejecting request.`);
        return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    // Parse the raw body JSON manually (bodyParser is disabled)
    let parsedBody;
    try {
        parsedBody = JSON.parse(rawBody);
    } catch {
        return res.status(400).json({ error: 'Invalid JSON body.' });
    }
    req.body = parsedBody;

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
            // H-02 FIX: verify-payment.js creates retry orders with suffix _R<digits>
            // (e.g. ZYRO123_R4521). Cashfree fires the webhook with the retry order_id,
            // but only the base order_id exists in our orders table.
            // Strip the suffix so both paths (original + retry) map to the same DB record.
            const baseOrderId = orderId.replace(/_R\d+$/, '');
            if (baseOrderId !== orderId) {
                console.log(`[ZYRO][webhook][INFO] ${new Date().toISOString()} | Retry order detected: ${orderId} → mapping to base order ${baseOrderId}`);
            }

            // Fetch current status to prevent duplicate processing
            const { data: orderData, error: fetchError } = await supabase
                .from('orders')
                .select('order_id, client_name, client_email, client_phone, service, amount, status, deadline_date, project_notes')
                .eq('order_id', baseOrderId)
                .single();

            if (fetchError || !orderData) {
                console.error(`[ZYRO][webhook][ERROR] ${new Date().toISOString()} | order=${baseOrderId} | Could not fetch order from DB:`, fetchError?.message);
            } else if (orderData.status === 'paid' || orderData.status === 'completed') {
                console.log(`[ZYRO][webhook][INFO] ${new Date().toISOString()} | order=${baseOrderId} | Already '${orderData.status}' in DB. Skipping update + invoice.`);
            } else {
                // Status is 'pending' — we are first. Atomically update to 'paid'.
                // RACE FIX: .eq('status','pending') ensures only one process wins.
                const { data: updateData, error: dbError } = await supabase
                    .from('orders')
                    .update({ status: 'paid' })
                    .eq('order_id', baseOrderId)
                    .eq('status', 'pending')
                    .select('order_id');

                if (dbError) {
                    console.error(`[ZYRO][webhook][ERROR] ${new Date().toISOString()} | order=${baseOrderId} | DB update to 'paid' FAILED:`, dbError.message);
                } else if (!updateData || updateData.length === 0) {
                    // Another process (verify-payment.js) already flipped it — skip invoice
                    console.log(`[ZYRO][webhook][INFO] ${new Date().toISOString()} | order=${baseOrderId} | Atomic update matched 0 rows — verify-payment already handled this. Skipping invoice.`);
                } else {
                    console.log(`[ZYRO][webhook][INFO] ${new Date().toISOString()} | order=${baseOrderId} | DB updated to 'paid'. Firing sendInvoice()...`);
                    try {
                        await sendInvoice({ ...orderData, status: 'paid' });
                        console.log(`[ZYRO][webhook][INFO] ${new Date().toISOString()} | order=${baseOrderId} | Invoice email sent successfully.`);
                    } catch (invoiceErr) {
                        console.error(`[ZYRO][webhook][ERROR] ${new Date().toISOString()} | order=${baseOrderId} | sendInvoice() FAILED:`, invoiceErr.message);
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

// FIX C3: Use the reliable Vercel config export pattern.
// Vercel's bundler scans for `module.exports.config` OR a named `config` export.
// Assigning config as a property on the function object works, but can be fragile
// across bundler versions. This pattern is explicitly documented by Vercel.
_handler.config = { api: { bodyParser: false } };
module.exports = _handler;
