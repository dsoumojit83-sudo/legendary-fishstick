const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'zyroeditz.official@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ── Status-Change Email Notification Engine ──────────────────────────────────
// Sends branded transactional emails to clients when their order status changes.
// Fire-and-forget — does NOT block the status update response.
async function sendStatusEmail(orderId, newStatus) {
    if (!process.env.RESEND_API_KEY) return;

    try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);

        // Fetch order details for the email
        const { data: order, error } = await supabase
            .from('orders')
            .select('order_id, client_name, client_email, service, amount, deadline_date')
            .eq('order_id', orderId)
            .single();

        if (error || !order || !order.client_email) return;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(order.client_email)) return;

        const clientName = order.client_name || 'there';
        const year = new Date().getFullYear();

        // Format deadline
        let deadlineStr = 'TBD';
        if (order.deadline_date) {
            const [dy, dm, dd] = order.deadline_date.split('-').map(Number);
            deadlineStr = new Date(dy, dm - 1, dd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        }

        let subject, heading, body, accentColor, statusLabel;

        if (newStatus === 'working') {
            subject = `🎬 Your ZyroEditz™ project is now in production — Order #${orderId}`;
            heading = 'Project In Production 🎬';
            accentColor = '#3b82f6';
            statusLabel = 'IN PROGRESS';
            body = `
                <p style="color:#ccc;font-size:15px;line-height:1.6;">Hi <strong>${clientName}</strong>,</p>
                <p style="color:#ccc;font-size:15px;line-height:1.6;">Great news — our editing team has started working on your <strong>${order.service}</strong> project. Here's what's happening:</p>
                <div style="background:#111;border:1px solid #333;border-radius:8px;padding:20px;margin:20px 0;">
                    <table style="width:100%;border-collapse:collapse;">
                        <tr>
                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Order ID</td>
                            <td style="padding:8px 0;color:#3b82f6;font-weight:bold;text-align:right;font-family:monospace;">${orderId}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Service</td>
                            <td style="padding:8px 0;color:#fff;font-weight:bold;text-align:right;border-top:1px solid #222;">${order.service}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Est. Delivery</td>
                            <td style="padding:8px 0;color:#fff;font-weight:bold;text-align:right;border-top:1px solid #222;">${deadlineStr}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Status</td>
                            <td style="padding:8px 0;text-align:right;border-top:1px solid #222;">
                                <span style="background:rgba(59,130,246,0.15);color:#3b82f6;padding:4px 12px;border-radius:99px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;">In Progress</span>
                            </td>
                        </tr>
                    </table>
                </div>
                <p style="color:#ccc;font-size:14px;line-height:1.6;">If you haven't uploaded your raw footage yet, please do so now via your order dashboard. Our team will reach out if we need any clarifications on your brief.</p>`;
        } else if (newStatus === 'completed') {
            subject = `✅ Your ZyroEditz™ project is ready! — Order #${orderId}`;
            heading = 'Project Complete! ✅';
            accentColor = '#22c55e';
            statusLabel = 'DELIVERED';
            body = `
                <p style="color:#ccc;font-size:15px;line-height:1.6;">Hi <strong>${clientName}</strong>,</p>
                <p style="color:#ccc;font-size:15px;line-height:1.6;">Your <strong>${order.service}</strong> project has been completed and is ready for you! 🎉</p>
                <div style="background:#111;border:1px solid #333;border-radius:8px;padding:20px;margin:20px 0;">
                    <table style="width:100%;border-collapse:collapse;">
                        <tr>
                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Order ID</td>
                            <td style="padding:8px 0;color:#ff1a1a;font-weight:bold;text-align:right;font-family:monospace;">${orderId}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Service</td>
                            <td style="padding:8px 0;color:#fff;font-weight:bold;text-align:right;border-top:1px solid #222;">${order.service}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Amount Paid</td>
                            <td style="padding:8px 0;color:#fff;font-weight:bold;text-align:right;border-top:1px solid #222;">Rs.${parseFloat(order.amount).toFixed(0)}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Status</td>
                            <td style="padding:8px 0;text-align:right;border-top:1px solid #222;">
                                <span style="background:rgba(34,197,94,0.15);color:#22c55e;padding:4px 12px;border-radius:99px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;">Delivered</span>
                            </td>
                        </tr>
                    </table>
                </div>
                <p style="color:#ccc;font-size:14px;line-height:1.6;">Your deliverables will be shared with you shortly. If you're happy with the result, we'd love a quick review — it helps us grow!</p>
                <div style="text-align:center;margin:25px 0;">
                    <a href="https://zyroeditz.xyz" style="display:inline-block;padding:14px 32px;background:#ff1a1a;color:#000;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:0.12em;border-radius:8px;text-decoration:none;">Leave a Review</a>
                </div>`;
        } else {
            return; // Only send emails for working/completed transitions
        }

        await resend.emails.send({
            from: 'ZyroEditz™ <billing@zyroeditz.xyz>',
            to: order.client_email,
            reply_to: 'zyroeditz.official@gmail.com',
            subject,
            html: `
                <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#050505;color:#fff;border:1px solid #222;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.8);">
                    <div style="background:#111;padding:40px 30px;text-align:center;border-bottom:2px solid ${accentColor};">
                        <h1 style="margin:0;font-size:32px;font-weight:900;letter-spacing:-1px;">Zyro<span style="color:#ff1a1a;">Editz</span>&trade;</h1>
                        <p style="margin:5px 0 0;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:4px;">Speed. Motion. Precision.</p>
                    </div>
                    <div style="padding:40px 30px;">
                        <h2 style="margin-top:0;color:#fff;font-size:24px;">${heading}</h2>
                        ${body}
                    </div>
                    <div style="background:#0a0a0a;padding:25px 30px;text-align:center;border-top:1px solid #1a1a1a;">
                        <p style="margin:0;color:#666;font-size:12px;">© ${year} ZyroEditz&trade;. All rights reserved.</p>
                        <p style="margin:5px 0 0;color:#444;font-size:11px;">Reply to this email with any questions.</p>
                    </div>
                </div>`
        });
        console.log(`[ZYRO][update-status][INFO] Status email (${newStatus}) sent to ${order.client_email} for order ${orderId}`);
    } catch (emailErr) {
        // Log but don't fail the status update — email is best-effort
        console.error(`[ZYRO][update-status][WARN] Status email failed for ${orderId}:`, emailErr.message);
    }
}

module.exports = async function(req, res) {
    // M-02 FIX: Add CORS headers — update-status.js was the only admin API without them.
    // Without these, browser preflight (OPTIONS) requests return 405, blocking the real POST.
    const _usAllowed = ['https://zyroeditz.xyz','https://www.zyroeditz.xyz','https://admin.zyroeditz.xyz','https://zyroeditz.vercel.app'];
    const _usOrigin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', _usAllowed.includes(_usOrigin) ? _usOrigin : _usAllowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    // 🔒 JWT Auth
    const authH = req.headers['authorization'];
    if (!authH?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user: u }, error: uErr } = await supabase.auth.getUser(authH.slice(7));
    if (uErr || !u) return res.status(401).json({ error: 'Unauthorized' });
    if (!ADMIN_EMAILS.includes((u.email || '').toLowerCase())) return res.status(403).json({ error: 'Forbidden: Admin access required.' });

    try {
        const { action, orderId, status, is_online } = req.body;

        // ── ACTION: Toggle studio online/offline status ──────────────────────
        if (action === 'set_studio_status') {
            if (typeof is_online !== 'boolean') {
                return res.status(400).json({ error: 'is_online must be a boolean.' });
            }
            const { error } = await supabase
                .from('studio_config')
                .upsert({ id: 1, is_online }, { onConflict: 'id' });

            if (error) throw error;
            return res.status(200).json({ success: true, is_online });
        }

        // ── ACTION: Update order status ───────────────────────────────────────
        if (!orderId || !status) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }

        const normalizedStatus = status === 'in_progress' ? 'working' : status;
        const validStatuses = ['pending', 'working', 'paid', 'completed', 'refunded', 'cancelled'];
        if (!validStatuses.includes(normalizedStatus)) {
            return res.status(400).json({ error: 'Invalid status value.' });
        }

        let updatePayload = { status: normalizedStatus };
        if (normalizedStatus === 'completed') updatePayload.completed_at = new Date().toISOString();

        const { error } = await supabase
            .from('orders')
            .update(updatePayload)
            .eq('order_id', orderId);

        if (error) throw error;

        // ── Fire-and-forget: Send status notification email ──────────────────
        // Non-blocking — the 200 response is returned immediately.
        // Only triggers for 'working' and 'completed' transitions.
        if (normalizedStatus === 'working' || normalizedStatus === 'completed') {
            sendStatusEmail(orderId, normalizedStatus).catch(() => {});
        }

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error('Update Status Error:', err);
        return res.status(500).json({ error: 'Failed to update.' });
    }
};
