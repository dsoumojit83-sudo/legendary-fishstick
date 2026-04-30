const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const axios = require('axios');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const rawEndpoint = process.env.B2_ENDPOINT || '';
const B2_ENDPOINT = rawEndpoint.startsWith('http') ? rawEndpoint : `https://${rawEndpoint || 's3.us-west-004.backblazeb2.com'}`;
const extractedRegion = (B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || 'us-west-004';

const b2 = new S3Client({
    region: extractedRegion,
    endpoint: B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
});
const B2_BUCKET = process.env.B2_BUCKET_NAME;

const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_API_URL = process.env.NODE_ENV === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    // 🔒 JWT Auth
    const authH = req.headers['authorization'];
    if (!authH?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user: u }, error: uErr } = await supabase.auth.getUser(authH.slice(7));
    if (uErr || !u) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { action, orderId, status, is_online, deliveryMessage, deliveryFiles } = req.body;
<<<<<<< HEAD

        // ── ADMIN ONLY GATE (except for get_delivery) ─────────────────────────
        if (action !== 'get_delivery') {
            const userEmail = u.email.toLowerCase();
            if (userEmail !== 'zyroeditz.official@gmail.com') {
                const { data: adminRecord, error: adminErr } = await supabase.from('admins').select('email').eq('email', userEmail).maybeSingle();
                if (adminErr || !adminRecord) return res.status(403).json({ error: 'Forbidden: Admin access required' });
            }
        }
=======
>>>>>>> 7090901b4a55de26c47e41642cd7ca393c108093

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

        // ── ACTION: Get delivery files for client ─────────────────────────────
        if (action === 'get_delivery') {
            if (!orderId) return res.status(400).json({ error: 'Missing orderId' });
            
            // Verify ownership
            const { data: order } = await supabase.from('orders').select('client_email').eq('order_id', orderId).single();
            if (!order || order.client_email !== u.email) {
                return res.status(403).json({ error: 'Unauthorized to access this order' });
            }

            const { data: deliveries } = await supabase.from('deliveries').select('file_key').eq('order_id', orderId);
            if (!deliveries || deliveries.length === 0) {
                return res.status(404).json({ error: 'No files found for this order' });
            }

            const links = await Promise.all(deliveries.map(async (d) => {
                const url = await getSignedUrl(
                    b2,
                    new GetObjectCommand({ Bucket: B2_BUCKET, Key: d.file_key, ResponseContentDisposition: 'attachment' }),
                    { expiresIn: 24 * 60 * 60 } // 24 hours
                );
                const filename = d.file_key.split('/').pop().replace(/^\d+-/, '').replace(/^delivery_/, '');
                return { filename, url };
            }));

            return res.status(200).json({ success: true, links });
        }

        // ── ADMIN ONLY GATE ───────────────────────────────────────────────────

        // ── ACTION: Update order status ───────────────────────────────────────
        if (!orderId || !status) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }

        // Normalize 'in_progress' alias → 'working' (single source of truth)
        const normalizedStatus = status === 'in_progress' ? 'working' : status;
        const validStatuses = ['pending', 'working', 'paid', 'completed', 'refunded', 'cancelled'];
        if (!validStatuses.includes(normalizedStatus)) {
            return res.status(400).json({ error: 'Invalid status value.' });
        }

        let updatePayload = { status: normalizedStatus };
        if (normalizedStatus === 'paid') updatePayload.paid_at = new Date().toISOString();
        if (normalizedStatus === 'working') updatePayload.working_at = new Date().toISOString();
        if (normalizedStatus === 'completed') updatePayload.completed_at = new Date().toISOString();

        // Fetch order details BEFORE updating (needed for completion email and refunds)
        let orderRecord = null;
        if (normalizedStatus === 'completed' || normalizedStatus === 'refunded') {
            const { data } = await supabase
                .from('orders')
                .select('order_id, client_name, client_email, service, amount')
                .eq('order_id', orderId)
                .single();
            orderRecord = data;
        }

        // ── FIX: Add Cashfree Refund Logic ────────────────────────────────────
        if (normalizedStatus === 'refunded' && orderRecord) {
            try {
                // Determine order amount for full refund
                const orderAmount = parseFloat(orderRecord.amount || 0);
                if (orderAmount > 0) {
                    const refundId = `REFUND_${orderId}_${Date.now().toString().slice(-6)}`;
                    
                    const cfRefundRes = await axios.post(
                        `https://api.cashfree.com/pg/orders/${orderId}/refunds`,
                        {
                            refund_amount: orderAmount,
                            refund_id: refundId.substring(0, 40),
                            refund_note: 'Refund processed by admin',
                            refund_speed: 'STANDARD'
                        },
                        {
                            headers: {
                                'x-api-version': '2023-08-01',
                                'x-client-id': CASHFREE_APP_ID,
                                'x-client-secret': CASHFREE_SECRET_KEY,
                                'Content-Type': 'application/json'
                            }
                        }
                    );
                    console.log(`[update-status] Refund initiated for ${orderId}:`, cfRefundRes.data?.refund_status);
                }
            } catch (refErr) {
                const refundError = refErr.response?.data?.message || refErr.message;
                console.error(`[update-status] Cashfree refund FAILED for ${orderId}:`, refundError);
                return res.status(400).json({ error: `Cashfree refund failed: ${refundError}. Order NOT refunded.` });
            }
        }

        const { error } = await supabase
            .from('orders')
            .update(updatePayload)
            .eq('order_id', orderId);

        if (error) throw error;

        // FIX #12: Send completion notification email to client ────────────────
        if (normalizedStatus === 'completed' && orderRecord?.client_email) {
            try {
                // Generate download links if files were provided
                let filesHtml = '';
                if (deliveryFiles && Array.isArray(deliveryFiles) && deliveryFiles.length > 0) {
                    const links = await Promise.all(deliveryFiles.map(async (key) => {
                        const url = await getSignedUrl(
                            b2,
                            new GetObjectCommand({ Bucket: B2_BUCKET, Key: key, ResponseContentDisposition: 'attachment' }),
                            { expiresIn: 7 * 24 * 60 * 60 } // 7 days
                        );
                        // Extract just the filename for display (remove order folder prefix and timestamp)
                        const filename = key.split('/').pop().replace(/^\\d+-/, '').replace(/^delivery_/, '');
                        return { filename, url };
                    }));
                    
<<<<<<< HEAD
                    // Insert keys into deliveries table for persistent dashboard downloads
                    const deliveryRecords = deliveryFiles.map(key => ({
                        order_id: orderId,
                        file_key: key
                    }));
                    await supabase.from('deliveries').upsert(deliveryRecords).catch(e => console.error("Deliveries insert error:", e));
                    
=======
>>>>>>> 7090901b4a55de26c47e41642cd7ca393c108093
                    filesHtml = `
                        <div style="background:#1a1a1a; border:1px solid #ff1a1a; border-radius:8px; padding:20px; margin:30px 0;">
                            <h3 style="color:#fff; margin-top:0; font-size:16px;">\uD83D\uDCE5 Final Deliverables</h3>
                            <p style="color:#aaa; font-size:12px; margin-bottom:15px;">Secure download links (valid for 7 days)</p>
                            ${links.map(l => `
                                <a href="${l.url}" style="display:block; background:#ff1a1a; color:#000; text-decoration:none; padding:12px 15px; border-radius:6px; font-weight:bold; font-size:14px; margin-bottom:10px; text-align:center;">
                                    \u2B07\uFE0F Download: ${l.filename}
                                </a>
                            `).join('')}
                        </div>
                    `;
                }

                const customMsgHtml = deliveryMessage ? `
                    <div style="background:#111; border-left:4px solid #ff1a1a; padding:15px 20px; margin:20px 0; font-style:italic; color:#ddd; font-size:15px; line-height:1.6;">
                        "${deliveryMessage.replace(/\\n/g, '<br>')}"
                    </div>
                ` : '';

<<<<<<< HEAD
                // --- GENERATE REFERRAL & REVIEW HTML ---
                const referralCode = `ZYRO-${orderId.slice(-5)}`;
                
                // Create a 10% coupon for this referral code so it actually works at checkout
                await supabase.from('coupons').upsert([{
                    code: referralCode,
                    discount_type: 'percent',
                    discount_value: 10,
                    min_order_value: 0,
                    max_uses: 10,
                    times_used: 0,
                    is_active: true
                }], { onConflict: 'code' }).catch(() => {});

                // Log it in the referrals table
                await supabase.from('referrals').insert([{
                    referrer_email: orderRecord.client_email,
                    referrer_code: referralCode
                }]).catch(() => {});

                const extrasHtml = `
                    <div style="background:#111;border:1px solid #333;border-radius:8px;padding:20px;margin:30px 0;text-align:center;">
                        <h3 style="color:#22c55e;margin-top:0;font-size:18px;">⭐ How did we do?</h3>
                        <p style="color:#ccc;font-size:14px;line-height:1.5;margin-bottom:15px;">Your feedback helps us create better videos. Leave a quick review!</p>
                        <a href="https://zyroeditz.xyz/review?order_id=${orderId}" style="display:inline-block;background:#22c55e;color:#000;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:bold;font-size:14px;">Leave a Review</a>
                        
                        <hr style="border:none;border-top:1px solid #222;margin:20px 0;">
                        
                        <h3 style="color:#ff1a1a;margin-top:0;font-size:18px;">🎁 Refer a Friend</h3>
                        <p style="color:#ccc;font-size:14px;line-height:1.5;">Share your exclusive code with friends. They get <strong>10% OFF</strong> their first order, and you get rewarded!</p>
                        <div style="background:#000;border:1px dashed #ff1a1a;color:#ff1a1a;font-size:20px;font-weight:bold;padding:10px;border-radius:6px;letter-spacing:2px;margin-top:10px;">
                            ${referralCode}
                        </div>
                    </div>
                `;

=======
>>>>>>> 7090901b4a55de26c47e41642cd7ca393c108093
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
                                <p style="color:#ccc;font-size:15px;line-height:1.6;">Your <strong>${orderRecord.service}</strong> project has been completed and is ready for delivery!</p>
                                
                                ${customMsgHtml}
                                
                                <div style="background:#111;border:1px solid #333;border-radius:8px;padding:20px;margin:30px 0;">
                                    <table style="width:100%;border-collapse:collapse;">
                                        <tr><td style="padding:10px 0;color:#888;font-size:12px;text-transform:uppercase;">Order ID</td><td style="padding:10px 0;color:#ff1a1a;font-weight:bold;text-align:right;font-family:monospace;">${orderId}</td></tr>
                                        <tr><td style="padding:10px 0;color:#888;font-size:12px;text-transform:uppercase;border-top:1px solid #222;">Service</td><td style="padding:10px 0;color:#fff;font-weight:bold;text-align:right;border-top:1px solid #222;">${orderRecord.service}</td></tr>
                                    </table>
                                </div>
                                
                                ${filesHtml}
                                
                                ${!filesHtml ? '<p style="color:#ccc;font-size:14px;line-height:1.6;">Our team will deliver your files shortly. If you have any questions or need revisions, please reply to this email.</p>' : '<p style="color:#ccc;font-size:14px;line-height:1.6;">If you have any questions or need revisions, simply reply to this email.</p>'}
<<<<<<< HEAD
                                
                                ${extrasHtml}
                                
=======
>>>>>>> 7090901b4a55de26c47e41642cd7ca393c108093
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
