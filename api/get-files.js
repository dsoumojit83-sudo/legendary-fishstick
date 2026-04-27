const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase client — used for JWT auth (same pattern as all other admin APIs) ─
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'zyroeditz.official@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ── Backblaze B2 S3-compatible client ────────────────────────────────────────
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

const B2_BUCKET = process.env.B2_BUCKET_NAME; // orders1
const B2_PORTFOLIO_BUCKET = process.env.B2_PORTFOLIO_BUCKET || 'zyroeditz-portfolio';

// M-04 FIX: Rate limiter for the delivery endpoint.
// Without this, a valid token holder could hammer the endpoint and generate thousands
// of 24h pre-signed B2 URLs, inflating Backblaze request costs and API logs.
// Sliding window: 10 requests per (order_id+token) per 60 seconds.
const _deliveryRateMap = {};
const DELIVERY_RATE_MAX = 10;
const DELIVERY_RATE_WINDOW_MS = 60 * 1000;
let _deliveryGcCounter = 0;
function isDeliveryRateLimited(key) {
    const now = Date.now();
    const recent = (_deliveryRateMap[key] || []).filter(t => now - t < DELIVERY_RATE_WINDOW_MS);
    if (recent.length >= DELIVERY_RATE_MAX) { _deliveryRateMap[key] = recent; return true; }
    recent.push(now);
    _deliveryRateMap[key] = recent;
    if (++_deliveryGcCounter % 200 === 0) {
        Object.keys(_deliveryRateMap).forEach(k => {
            if (_deliveryRateMap[k].every(t => now - t >= DELIVERY_RATE_WINDOW_MS)) delete _deliveryRateMap[k];
        });
    }
    return false;
}

// ALLOWED_PORTFOLIO_FILES removed — now validated dynamically from portfolio_items table (see BUG-7 fix)


module.exports = async function (req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed.' });
    }

    // ── Portfolio items listing (no auth — drives public /portfolio page) ─────────
    // GET /api/get-files?portfolio_items=true
    if (req.query.portfolio_items === 'true') {
        const { data, error } = await supabase
            .from('portfolio_items')
            .select('id, title, category, filename, thumbnail_url, accent_color, grid_cols, grid_rows, display_order')
            .eq('active', true)
            .order('display_order');
        if (error) {
            console.error('[get-files] portfolio_items error:', error);
            return res.status(500).json({ error: 'Failed to fetch portfolio items.' });
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ items: data });
    }
    // GET /api/get-files?portfolio=true&file=neon-nights.mp4
    if (req.query.portfolio === 'true') {
        const file = req.query.file;
        if (!file) return res.status(400).json({ error: 'Missing file parameter.' });

        // Allow hardcoded landing page featured videos
        const landingPageVideos = ['high-impact-shorts.mp4', 'cinematic-shorts.mp4'];

        if (!landingPageVideos.includes(file)) {
            // BUG-7 FIX: Validate against portfolio_items DB instead of hardcoded whitelist.
            try {
                const { data: item, error: dbErr } = await supabase
                    .from('portfolio_items')
                    .select('filename')
                    .eq('filename', file)
                    .maybeSingle();

                if (dbErr) throw dbErr;
                if (!item) return res.status(400).json({ error: 'Invalid or unknown file.' });
            } catch (dbErr) {
                console.error('[get-files] DB whitelist check error:', dbErr);
                return res.status(500).json({ error: 'Failed to validate file.' });
            }
        }

        try {
            const ext = file.split('.').pop().toLowerCase();
            const mimeType = ext === 'webm' ? 'video/webm' 
                           : ext === 'mov' ? 'video/quicktime' 
                           : ext === 'mkv' ? 'video/x-matroska'
                           : 'video/mp4';

            const signedUrl = await getSignedUrl(
                b2,
                new GetObjectCommand({ 
                    Bucket: B2_PORTFOLIO_BUCKET, 
                    Key: file,
                    ResponseContentType: mimeType,
                    ResponseContentDisposition: 'inline'
                }),
                { expiresIn: 3600 } // 1 hour
            );
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({ url: signedUrl });
        } catch (err) {
            console.error('[get-files] Portfolio B2 error:', err);
            return res.status(500).json({ error: 'Failed to generate video URL.' });
        }
    }

    // ── Delivery download (token-based auth — no JWT needed) ─────────────────────
    // GET /api/get-files?delivery=true&order_id=ZYRO123&token=abc123
    if (req.query.delivery === 'true') {
        const { order_id, token } = req.query;
        if (!order_id || !token) {
            return res.status(400).json({ error: 'Missing order_id or token.' });
        }

        // M-04 FIX: Rate-limit by order_id+token to prevent unlimited signed-URL generation.
        const rateKey = `${order_id}:${token}`;
        if (isDeliveryRateLimited(rateKey)) {
            return res.status(429).json({ error: 'Too many requests. Please wait a moment before trying again.' });
        }

        try {
            // Verify delivery token
            const { data: delivery, error: dErr } = await supabase
                .from('deliveries')
                .select('*')
                .eq('order_id', order_id)
                .eq('token', token)
                .single();

            if (dErr || !delivery) {
                return res.status(404).json({ error: 'Delivery not found or link is invalid.' });
            }

            // Check expiry
            if (delivery.expires_at && new Date(delivery.expires_at) < new Date()) {
                return res.status(410).json({ error: 'This delivery link has expired. Please contact us for a new one.' });
            }

            // List files in deliveries/<order_id>/
            const prefix = `deliveries/${order_id}/`;
            const listResp = await b2.send(new ListObjectsV2Command({
                Bucket: B2_BUCKET,
                Prefix: prefix,
                MaxKeys: 50,
            }));

            const objects = listResp.Contents || [];
            if (objects.length === 0) {
                return res.status(200).json({ files: [], message: 'No files delivered yet.' });
            }

            // Generate download URLs (24h expiry)
            const files = await Promise.all(
                objects.map(async (obj) => {
                    const name = obj.Key.replace(prefix, '');
                    if (!name) return null;
                    const signedUrl = await getSignedUrl(
                        b2,
                        new GetObjectCommand({
                            Bucket: B2_BUCKET,
                            Key: obj.Key,
                            ResponseContentDisposition: `attachment; filename="${encodeURIComponent(name)}"`
                        }),
                        { expiresIn: 86400 }
                    );
                    return { name, url: signedUrl, size: obj.Size || null };
                })
            );

            // Track download count
            await supabase
                .from('deliveries')
                .update({ download_count: (delivery.download_count || 0) + 1 })
                .eq('id', delivery.id);

            return res.status(200).json({
                order_id,
                files: files.filter(Boolean),
                expires_at: delivery.expires_at
            });

        } catch (err) {
            console.error('[get-files] Delivery download error:', err);
            return res.status(500).json({ error: 'Failed to retrieve delivery files.' });
        }
    }

    // ── POST: Admin triggers delivery email ──────────────────────────────────
    if (req.method === 'POST') {
        // JWT Auth (admin only)
        const _authH = req.headers['authorization'];
        if (!_authH?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized.' });
        const { data: { user: _u }, error: _uErr } = await supabase.auth.getUser(_authH.slice(7));
        if (_uErr || !_u) return res.status(401).json({ error: 'Unauthorized.' });
        if (!ADMIN_EMAILS.includes((_u.email || '').toLowerCase())) return res.status(403).json({ error: 'Forbidden.' });

        const { action, orderId } = req.body;

        if (action === 'send_delivery') {
            if (!orderId) return res.status(400).json({ error: 'Missing orderId.' });

            const { data: order, error: oErr } = await supabase
                .from('orders')
                .select('*')
                .eq('order_id', orderId)
                .single();

            if (oErr || !order) return res.status(404).json({ error: 'Order not found.' });
            if (!order.client_email) return res.status(400).json({ error: 'No client email on order.' });

            // Generate delivery token
            const crypto = require('crypto');
            const token = crypto.randomBytes(24).toString('hex');
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

            const { error: upsertErr } = await supabase
                .from('deliveries')
                .upsert({
                    order_id: orderId,
                    token,
                    expires_at: expiresAt,
                    download_count: 0,
                    delivered_by: _u.email,
                    delivered_at: new Date().toISOString()
                }, { onConflict: 'order_id' });

            if (upsertErr) throw upsertErr;

            const downloadLink = `https://zyroeditz.xyz/payment-success?order_id=${orderId}&token=${token}`;
            const clientName = order.client_name || 'there';
            const year = new Date().getFullYear();

            // Send delivery email
            if (process.env.RESEND_API_KEY) {
                const { Resend } = require('resend');
                const resend = new Resend(process.env.RESEND_API_KEY);

                await resend.emails.send({
                    from: 'ZyroEditz™ <billing@zyroeditz.xyz>',
                    to: order.client_email,
                    reply_to: 'zyroeditz.official@gmail.com',
                    subject: `📦 Your ZyroEditz™ project is ready for download — Order #${orderId}`,
                    html: `
                        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#050505;color:#fff;border:1px solid #222;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.8);">
                            <div style="background:#111;padding:40px 30px;text-align:center;border-bottom:2px solid #22c55e;">
                                <h1 style="margin:0;font-size:32px;font-weight:900;letter-spacing:-1px;">Zyro<span style="color:#ff1a1a;">Editz</span>&trade;</h1>
                                <p style="margin:5px 0 0;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:4px;">Speed. Motion. Precision.</p>
                            </div>
                            <div style="padding:40px 30px;">
                                <h2 style="margin-top:0;color:#fff;font-size:24px;">Your Project is Ready! 📦</h2>
                                <p style="color:#ccc;font-size:15px;line-height:1.6;">Hi <strong>${clientName}</strong>,</p>
                                <p style="color:#ccc;font-size:15px;line-height:1.6;">Your <strong>${order.service}</strong> project has been delivered. Click below to download.</p>
                                <div style="text-align:center;margin:30px 0;">
                                    <a href="${downloadLink}" style="display:inline-block;padding:16px 40px;background:#ff1a1a;color:#000;font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:0.12em;border-radius:8px;text-decoration:none;">Download Your Files</a>
                                </div>
                                <div style="background:#111;border:1px solid #333;border-radius:8px;padding:20px;margin:20px 0;">
                                    <table style="width:100%;border-collapse:collapse;">
                                        <tr>
                                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Order ID</td>
                                            <td style="padding:8px 0;color:#ff1a1a;font-weight:bold;text-align:right;font-family:monospace;">${orderId}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Link Expires</td>
                                            <td style="padding:8px 0;color:#eab308;font-weight:bold;text-align:right;border-top:1px solid #222;">7 days</td>
                                        </tr>
                                    </table>
                                </div>
                                <p style="color:#888;font-size:13px;">This link expires in 7 days. Reply to this email if you need a new one.</p>
                            </div>
                            <div style="background:#0a0a0a;padding:25px 30px;text-align:center;border-top:1px solid #1a1a1a;">
                                <p style="margin:0;color:#666;font-size:12px;">© ${year} ZyroEditz&trade;. All rights reserved.</p>
                            </div>
                        </div>`
                });
                console.log(`[get-files] Delivery email sent to ${order.client_email} for ${orderId}`);
            }

            return res.status(200).json({ success: true, downloadLink, token, expiresAt });
        }

        return res.status(400).json({ error: 'Unknown action.' });
    }

    // 🔒 SECURITY FIX: Replaced static ADMIN_PASSWORD header (never expires, single point of
    // failure if leaked) with Supabase JWT Bearer token — the same pattern used by every other
    // admin endpoint (admin-data.js, admin-chat.js, payments.js, settlements.js, update-status.js).
    // JWT tokens expire automatically and are invalidated on logout.
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7));
    if (authError || !user) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    if (!ADMIN_EMAILS.includes((user.email || '').toLowerCase())) {
        return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }

    const { orderId } = req.query;

    if (!orderId) {
        return res.status(400).json({ error: 'Missing orderId query parameter.' });
    }

    try {
        // List all files inside orders1/<orderId>/ folder in B2
        const listResp = await b2.send(new ListObjectsV2Command({
            Bucket: B2_BUCKET,
            Prefix: `${orderId}/`,
            MaxKeys: 100,
        }));

        const objects = listResp.Contents || [];

        if (objects.length === 0) {
            return res.status(200).json({ files: [] });
        }

        // Generate pre-signed URLs (1-hour expiry) for each file
        const files = await Promise.all(
            objects.map(async (obj) => {
                const name = obj.Key.replace(`${orderId}/`, ''); // strip prefix → just filename
                const signedUrl = await getSignedUrl(
                    b2,
                    new GetObjectCommand({ Bucket: B2_BUCKET, Key: obj.Key }),
                    { expiresIn: 7200 } // 2 hours — gives comfortable window for large file downloads
                );
                return {
                    name,
                    url: signedUrl,
                    size: obj.Size || null,
                    created_at: obj.LastModified ? obj.LastModified.toISOString() : null,
                };
            })
        );

        return res.status(200).json({ files });

    } catch (err) {
        console.error('[get-files] B2 Storage error:', err);
        return res.status(500).json({ error: 'Failed to fetch files from storage.' });
    }
};
