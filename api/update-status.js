const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function(req, res) {
    const _allowed = ['https://zyroeditz.xyz','https://www.zyroeditz.xyz','https://admin.zyroeditz.xyz','https://zyroeditz.vercel.app'];
    const _origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', _allowed.includes(_origin) ? _origin : _allowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // 🔒 JWT Auth
    const authH = req.headers['authorization'];
    if (!authH?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user: u }, error: uErr } = await supabase.auth.getUser(authH.slice(7));
    if (uErr || !u) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { action, orderId, status, is_online, deliveryFileName, deliveryMimeType, deliveryKey } = req.body;

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

        // Normalize status to match new DB constraint: ['created', 'paid', 'in_progress', 'delivered', 'refunded']
        let normalizedStatus = status;
        if (status === 'working') normalizedStatus = 'in_progress';
        if (status === 'completed') normalizedStatus = 'delivered';
        if (status === 'pending') normalizedStatus = 'created';
        
        const validStatuses = ['created', 'in_progress', 'paid', 'delivered', 'refunded', 'cancelled', 'canceled'];
        if (!validStatuses.includes(normalizedStatus)) {
            return res.status(400).json({ error: 'Invalid status value.' });
        }

        let updatePayload = { status: normalizedStatus };
        if (normalizedStatus === 'delivered') updatePayload.completed_at = new Date().toISOString();

        // Fetch order details BEFORE updating (needed for completion email)
        let orderRecord = null;
        if (normalizedStatus === 'delivered') {
            const { data } = await supabase
                .from('orders')
                .select('order_id, client_name, client_email, service, amount')
                .eq('order_id', orderId)
                .single();
            orderRecord = data;
        }

        const { error } = await supabase
            .from('orders')
            .update(updatePayload)
            .eq('order_id', orderId);

        if (error) throw error;

        // ── STORE DELIVERY FILE IN DELIVERIES TABLE (portal access only) ─────
        // No download link is emailed — clients retrieve files via the Orders
        // section of the client portal at zyroeditz.xyz
        if (normalizedStatus === 'delivered' && deliveryKey && deliveryFileName) {
            try {
                const mime = deliveryMimeType || 'application/octet-stream';
                let fileType = 'unknown';
                if (mime.startsWith('image/')) fileType = 'photo';
                else if (mime.startsWith('video/')) fileType = 'video';
                else if (mime.startsWith('audio/')) fileType = 'sound';

                await supabase.from('deliveries').insert([{
                    order_id: orderId,
                    file_name: deliveryFileName,
                    mime_type: mime,
                    file_type: fileType,
                    b2_key: deliveryKey
                }]);
            } catch (dlErr) {
                // Non-fatal — log but don't block the status update
                console.error('[update-status] Deliveries table insert error:', dlErr.message);
            }
        }

        // ── SEND COMPLETION NOTIFICATION EMAIL (no download link) ────────────
        // Delivery files are accessed ONLY via the client portal Order Tracking section.
        if (normalizedStatus === 'delivered' && orderRecord?.client_email) {
            try {
                const resend = new Resend(process.env.RESEND_API_KEY);
                await resend.emails.send({
                    from: 'ZyroEditz\u2122 <billing@zyroeditz.xyz>',
                    to: orderRecord.client_email,
                    reply_to: 'zyroeditz.official@gmail.com',
                    subject: `\u26a1 Your ZyroEditz\u2122 Project is Ready! [${orderId}]`,
                    html: `
                        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#050505;color:#fff;border:1px solid #222;border-radius:12px;overflow:hidden;">
                            <div style="background:#111;padding:40px 30px;text-align:center;border-bottom:2px solid #ff1a1a;">
                                <h1 style="margin:0;font-size:32px;font-weight:900;">Zyro<span style="color:#ff1a1a;">Editz</span>&trade;</h1>
                                <p style="margin:5px 0 0;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:4px;">Speed. Motion. Precision.</p>
                            </div>
                            <div style="padding:40px 30px;">
                                <h2 style="color:#22c55e;margin-top:0;">\u2705 Your Project is Complete!</h2>
                                <p style="color:#ccc;font-size:15px;line-height:1.6;">Hi <strong>${orderRecord.client_name || 'there'}</strong>,</p>
                                <p style="color:#ccc;font-size:15px;line-height:1.6;">Your <strong>${orderRecord.service}</strong> project has been completed and your delivery files are ready to download!</p>
                                <div style="background:#111;border:1px solid #333;border-radius:8px;padding:20px;margin:30px 0;">
                                    <table style="width:100%;border-collapse:collapse;">
                                        <tr><td style="padding:10px 0;color:#888;font-size:12px;text-transform:uppercase;">Order ID</td><td style="padding:10px 0;color:#ff1a1a;font-weight:bold;text-align:right;font-family:monospace;">${orderId}</td></tr>
                                        <tr><td style="padding:10px 0;color:#888;font-size:12px;text-transform:uppercase;border-top:1px solid #222;">Service</td><td style="padding:10px 0;color:#fff;font-weight:bold;text-align:right;border-top:1px solid #222;">${orderRecord.service}</td></tr>
                                    </table>
                                </div>
                                <div style="background:#0d1f0d;border:1px solid #1a3a1a;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
                                    <p style="color:#22c55e;font-size:14px;font-weight:bold;margin:0 0 8px;">\ud83d\udcc2 Access Your Delivery Files</p>
                                    <p style="color:#aaa;font-size:13px;margin:0;">Log in to your account at <a href="https://zyroeditz.xyz" style="color:#ff1a1a;text-decoration:none;font-weight:bold;">zyroeditz.xyz</a> and go to <strong style="color:#fff;">Order Tracking</strong> to download your completed project files securely.</p>
                                </div>
                                <p style="color:#ccc;font-size:14px;line-height:1.6;">If you have any questions or need revisions, please reply to this email.</p>
                                <p style="color:#ccc;font-size:14px;line-height:1.6;">Thank you for choosing ZyroEditz\u2122!</p>
                            </div>
                            <div style="background:#0a0a0a;padding:25px 30px;text-align:center;border-top:1px solid #1a1a1a;">
                                <p style="margin:0;color:#666;font-size:12px;">&copy; ${new Date().getFullYear()} ZyroEditz&trade;. All rights reserved.</p>
                            </div>
                        </div>
                    `
                });
                console.log(`[update-status] Completion email sent to ${orderRecord.client_email} for order ${orderId}`);
            } catch (emailErr) {
                // Non-fatal: log but don't fail the status update
                console.error(`[update-status] Completion email FAILED for ${orderId}:`, emailErr.message);
            }
        }

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error('Update Status Error:', err);
        return res.status(500).json({ error: 'Failed to update.' });
    }
};
