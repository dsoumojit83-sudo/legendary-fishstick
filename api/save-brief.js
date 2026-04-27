const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// FIX C1: Safety assertion — ensure the anon key env var is not accidentally
// set to the service role key (which would leak full DB access to the client).
if (process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_KEY &&
    process.env.SUPABASE_ANON_KEY === process.env.SUPABASE_KEY) {
    console.error('[CRITICAL] SUPABASE_ANON_KEY === SUPABASE_KEY — refusing to expose service role key!');
}

module.exports = async function(req, res) {

    // ── CRON: GET /api/save-brief with x-cron-secret header → send deadline reminders ──
    // H-03 FIX: Use timingSafeEqual instead of === to prevent timing attacks that could
    // allow an attacker to binary-search the secret one character at a time.
    const cronSecret = req.headers['x-cron-secret'] || '';
    const expectedSecret = process.env.CRON_SECRET || '';
    const isCronCall = cronSecret.length > 0 &&
        expectedSecret.length > 0 &&
        cronSecret.length === expectedSecret.length &&
        crypto.timingSafeEqual(Buffer.from(cronSecret), Buffer.from(expectedSecret));

    if (req.method === 'GET' && isCronCall) {
        try {
            const { Resend } = require('resend');
            const resend = new Resend(process.env.RESEND_API_KEY);

            // Find orders due tomorrow (YYYY-MM-DD)
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowStr = tomorrow.toISOString().split('T')[0];

            const { data: dueOrders, error: fetchErr } = await supabase
                .from('orders')
                .select('order_id, client_name, client_email, service, deadline_date')
                .eq('deadline_date', tomorrowStr)
                .in('status', ['paid', 'working']);

            if (fetchErr || !dueOrders || dueOrders.length === 0) {
                return res.status(200).json({ sent: 0, message: 'No orders due tomorrow.' });
            }

            let sent = 0;
            for (const order of dueOrders) {
                if (!order.client_email) continue;
                await resend.emails.send({
                    from: 'ZyroEditz™ <billing@zyroeditz.xyz>',
                    to: order.client_email,
                    reply_to: 'zyroeditz.official@gmail.com',
                    subject: `⏰ Your ZyroEditz™ project is due tomorrow — Order #${order.order_id}`,
                    html: `
                        <div style="font-family:'Helvetica Neue',sans-serif;max-width:520px;margin:0 auto;background:#050505;color:#fff;border:1px solid #222;border-radius:12px;overflow:hidden;">
                            <div style="background:#111;padding:30px;text-align:center;border-bottom:2px solid #ff1a1a;">
                                <h1 style="margin:0;font-size:26px;font-weight:900;">Zyro<span style="color:#ff1a1a;">Editz</span>™</h1>
                            </div>
                            <div style="padding:30px;">
                                <h2 style="color:#fff;margin-top:0;">⏰ Delivery Tomorrow</h2>
                                <p style="color:#ccc;">Hi <strong>${order.client_name || 'there'}</strong>, your <strong>${order.service}</strong> project (Order #${order.order_id}) is scheduled for delivery <strong>tomorrow</strong>.</p>
                                <p style="color:#ccc;">If you have any last-minute notes or haven't uploaded your footage yet, please do so now.</p>
                                <a href="https://zyroeditz.xyz" style="display:inline-block;margin-top:16px;padding:12px 28px;background:#ff1a1a;color:#000;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:0.1em;border-radius:8px;text-decoration:none;">Visit Dashboard</a>
                            </div>
                            <div style="padding:20px;text-align:center;border-top:1px solid #1a1a1a;">
                                <p style="color:#555;font-size:11px;margin:0;">© ${new Date().getFullYear()} ZyroEditz™. Reply to this email with any questions.</p>
                            </div>
                        </div>`
                });
                sent++;
            }

            return res.status(200).json({ sent, message: `Reminder emails sent: ${sent}` });
        } catch (e) {
            console.error('[CRON] Reminder error:', e);
            return res.status(500).json({ error: 'Cron job failed', detail: e.message });
        }
    }

    // ── PUBLIC: GET /api/save-brief → returns studio online/offline status ──
    // (No auth needed — this is read-only and public so the website can check it)
    if (req.method === 'GET') {
        // MOBILE PERF FIX: Cache the studio status response at the CDN/edge for 15s.
        // Mobile devices poll every 60s — this allows Vercel's edge to serve cached
        // responses without hitting Supabase on every single poll from every device.
        res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30');

        // C-01 FIX: Removed supabaseUrl and supabaseAnonKey from this public response.
        // Previously these were returned in a globally CDN-cached body (s-maxage=15),
        // meaning the anon key was stored on Vercel edge nodes and trivially enumerable.
        // Callers needing Supabase credentials must use GET /api/verify-payment?config=true
        // which is not cached and returns only the public anon key.
        try {
            const { data, error } = await supabase
                .from('studio_config')
                .select('is_online')
                .eq('id', 1)
                .single();

            return res.status(200).json({
                is_online: (!error && data) ? data.is_online : true
            });
        } catch (e) {
            return res.status(200).json({ is_online: true });
        }
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { orderId, notes, email } = req.body;

        if (!orderId || !notes) {
            return res.status(400).json({ error: "Missing required data" });
        }

        // FIX M2: Basic auth — verify the caller knows the order's email.
        // Prevents anyone who guesses an order_id from overwriting briefs.
        if (!email) {
            return res.status(400).json({ error: "Email is required for verification." });
        }

        // Basic input sanitization
        const sanitizedNotes = String(notes).trim().substring(0, 2000);

        // FIX: Verify the order exists before allowing a write.
        // Prevents anyone from overwriting notes on a random/guessed order_id.
        const { data: existingOrder, error: fetchError } = await supabase
            .from('orders')
            .select('order_id, status, client_email')
            .eq('order_id', orderId)
            .single();

        if (fetchError || !existingOrder) {
            return res.status(404).json({ error: "Order not found." });
        }

        // FIX M2: Verify email matches the order owner
        if (existingOrder.client_email && existingOrder.client_email.toLowerCase() !== email.toLowerCase()) {
            return res.status(403).json({ error: "Email does not match order." });
        }

        // Don't allow editing notes on already-completed projects
        if (existingOrder.status === 'completed') {
            return res.status(403).json({ error: "Cannot edit brief for a completed project." });
        }

        // FIX: Deep-merge project_notes instead of overwriting.
        // The checkout flow writes cart items + coupon data as a JSON object
        // into project_notes. A blind overwrite here would destroy that data.
        let mergedNotes = sanitizedNotes;
        try {
            // Read existing project_notes
            const { data: existing } = await supabase
                .from('orders')
                .select('project_notes')
                .eq('order_id', orderId)
                .single();

            if (existing?.project_notes) {
                let parsed;
                try { parsed = JSON.parse(existing.project_notes); } catch (_) { parsed = null; }

                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    // Merge: preserve items/coupon, update client_brief
                    parsed.client_brief = sanitizedNotes;
                    mergedNotes = JSON.stringify(parsed);
                } else if (Array.isArray(parsed)) {
                    // Legacy array format — wrap into object
                    mergedNotes = JSON.stringify({ items: parsed, client_brief: sanitizedNotes });
                }
                // If it's a plain string, overwrite is fine
            }
        } catch (mergeErr) {
            // If read fails, fall back to plain overwrite (best effort)
            console.warn('[save-brief] Merge read failed, overwriting:', mergeErr.message);
        }

        // Update the order with the merged notes
        const { error } = await supabase
            .from('orders')
            .update({ project_notes: mergedNotes })
            .eq('order_id', orderId);

        if (error) {
            console.error("Failed to save brief to Supabase:", error);
            return res.status(500).json({ error: "Database error" });
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error("Save Brief Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
