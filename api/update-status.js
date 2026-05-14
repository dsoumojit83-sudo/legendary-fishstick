const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Resend } = require('resend');
const axios = require('axios');
const { getSupabase } = require('../lib/supabase');
const { getB2, B2_BUCKET } = require('../lib/b2');
const { setCors } = require('../lib/cors');
const { requireAdmin } = require('../lib/auth');

const supabase = getSupabase();
const b2 = getB2();

module.exports = async function(req, res) {
    if (setCors(req, res)) return res.status(200).end();

    // ── GET: Read studio online/offline status (no auth, no cache for admin) ──
    if (req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        try {
            const { data, error } = await supabase
                .from('studio_config')
                .select('is_online')
                .eq('id', 1)
                .maybeSingle();
            if (error) throw error;
            return res.status(200).json({ is_online: data ? data.is_online : true });
        } catch (err) {
            console.error('[update-status] GET studio_config error:', err.message);
            return res.status(200).json({ is_online: true });
        }
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const u = await requireAdmin(req, res);
    if (!u) return;

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
        if (status === 'canceled') normalizedStatus = 'cancelled'; // normalize legacy spelling
        
        const validStatuses = ['created', 'in_progress', 'paid', 'delivered', 'refunded', 'cancelled'];
        if (!validStatuses.includes(normalizedStatus)) {
            return res.status(400).json({ error: 'Invalid status value.' });
        }

        // S24 FIX: State-machine enforcement — prevent nonsensical status transitions
        // that would cause accounting chaos (e.g. delivered→created, refunded→paid).
        const allowedTransitions = {
            'created':     ['paid', 'cancelled'],
            'paid':        ['in_progress', 'delivered', 'refunded', 'cancelled'],
            'in_progress': ['delivered', 'refunded', 'cancelled'],
            'delivered':   ['refunded'],
            'refunded':    [],
            'cancelled':   [],
        };
        const { data: currentOrder } = await supabase.from('orders').select('status').eq('order_id', orderId).single();
        if (currentOrder) {
            const currentStatus = currentOrder.status || 'created';
            const allowed = allowedTransitions[currentStatus] || [];
            if (!allowed.includes(normalizedStatus) && normalizedStatus !== currentStatus) {
                return res.status(400).json({ error: `Cannot change status from '${currentStatus}' to '${normalizedStatus}'.` });
            }
        }

        let updatePayload = { status: normalizedStatus };
        if (normalizedStatus === 'delivered' || normalizedStatus === 'refunded') updatePayload.completed_at = new Date().toISOString();

        // Fetch order details BEFORE updating (needed for completion email & refund amount)
        let orderRecord = null;
        if (normalizedStatus === 'delivered' || normalizedStatus === 'refunded') {
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

        // ── CASHFREE AUTOMATIC REFUND ──────────────────────────────────────────
        // S5/S6 FIX: Use a deterministic refund_id based on orderId (not Date.now())
        // to prevent double-refunds if admin double-clicks or Vercel retries.
        if (normalizedStatus === 'refunded' && orderRecord && orderRecord.amount) {
            try {
                await axios.post(
                    `https://api.cashfree.com/pg/orders/${orderId}/refunds`,
                    {
                        refund_amount: parseFloat(orderRecord.amount),
                        refund_id: `REF_${orderId}`,
                        refund_note: "Admin initiated refund via Dashboard"
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-version': '2025-01-01',
                            'x-client-id': process.env.CASHFREE_APP_ID,
                            'x-client-secret': process.env.CASHFREE_SECRET_KEY
                        }
                    }
                );
                console.log(`Cashfree refund initiated for ${orderId} (Amount: ${orderRecord.amount})`);
            } catch (cfErr) {
                // Cashfree returns 409 if refund_id already exists — safe to ignore (idempotent)
                const cfStatus = cfErr.response?.status;
                if (cfStatus === 409) {
                    console.log(`[update-status] Refund already processed for ${orderId} (idempotent 409). Skipping.`);
                } else {
                    console.error("Cashfree Refund Failed:", cfErr.response?.data || cfErr.message);
                }
                // We do not throw here so the DB status remains 'refunded' even if CF fails
            }
        }

        // ── STORE DELIVERY FILE IN DELIVERIES TABLE (portal access only) ─────
        // If deliveryKey is missing (e.g. status update via AI or manual toggle), 
        // we attempt to find the latest uploaded file for this order in B2.
        // S15 FIX: Sync ALL files from B2 to the deliveries table, not just the latest one.
        // Previously only objects[0] was synced, meaning clients missed 4 out of 5 deliverables.
        if (normalizedStatus === 'delivered') {
            try {
                if (deliveryKey && deliveryFileName) {
                    // Explicit file passed — insert just that one
                    let fileType = 'unknown';
                    const mime = deliveryMimeType || 'application/octet-stream';
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
                    console.log(`[update-status] Delivery record created for ${orderId}: ${deliveryFileName}`);
                } else {
                    // AUTO-SYNC: Grab ALL files from B2 for this order
                    const listResp = await b2.send(new ListObjectsV2Command({
                        Bucket: B2_BUCKET,
                        Prefix: `${orderId}/`,
                        MaxKeys: 100
                    }));
                    const objects = listResp.Contents || [];

                    if (objects.length > 0) {
                        // Check which keys are already in the deliveries table to avoid duplicates
                        const { data: existingDeliveries } = await supabase
                            .from('deliveries')
                            .select('b2_key')
                            .eq('order_id', orderId);
                        const existingKeys = new Set((existingDeliveries || []).map(d => d.b2_key));

                        const newRecords = objects
                            .filter(obj => !existingKeys.has(obj.Key))
                            .map(obj => {
                                const fileName = obj.Key.split('/').pop().replace(/^\d+-/, '');
                                return {
                                    order_id: orderId,
                                    file_name: fileName,
                                    mime_type: 'application/octet-stream',
                                    file_type: 'unknown',
                                    b2_key: obj.Key
                                };
                            });

                        if (newRecords.length > 0) {
                            await supabase.from('deliveries').insert(newRecords);
                            console.log(`[update-status] ${newRecords.length} delivery record(s) created for ${orderId}`);
                        }
                    }
                }
            } catch (dlErr) {
                console.error('[update-status] Deliveries table sync error:', dlErr.message);
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
