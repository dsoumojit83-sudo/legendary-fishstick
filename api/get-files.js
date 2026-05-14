const { ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getSupabase } = require('../lib/supabase');
const { getB2, B2_BUCKET } = require('../lib/b2');
const { setCors } = require('../lib/cors');

const supabase = getSupabase();
const b2 = getB2();

const B2_PORTFOLIO_BUCKET = process.env.B2_PORTFOLIO_BUCKET || 'zyroeditz-portfolio';

module.exports = async function (req, res) {
    if (setCors(req, res)) return res.status(200).end();


    if (req.method !== 'GET') {
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

    const { orderId } = req.query;

    if (!orderId) {
        return res.status(400).json({ error: 'Missing orderId query parameter.' });
    }

    try {
        // 🔒 SECURITY FIX: Prevent IDOR (Insecure Direct Object Reference)
        // Ensure the authenticated user actually owns the orderId they are requesting,
        // or ensure they have Admin privileges.
        const isSuperAdmin = user.email.toLowerCase() === (process.env.SUPER_ADMIN_EMAIL || 'zyroeditz.official@gmail.com').toLowerCase();
        let isAdmin = isSuperAdmin;
        
        if (!isSuperAdmin) {
            const { data: adminRecord } = await supabase.from('admins').select('role').eq('email', user.email).maybeSingle();
            if (adminRecord) isAdmin = true;
        }

        const { data: orderData, error: orderErr } = await supabase
            .from('orders')
            .select('client_email')
            .eq('order_id', orderId)
            .maybeSingle();

        if (orderErr || !orderData) {
            return res.status(404).json({ error: 'Order not found.' });
        }

        const isOwner = user.email.toLowerCase() === (orderData.client_email || '').toLowerCase();

        if (!isAdmin && !isOwner) {
            return res.status(403).json({ error: 'Forbidden. You do not have permission to view files for this order.' });
        }

        // List all files inside orders1/<orderId>/ folder in B2
        const listResp = await b2.send(new ListObjectsV2Command({
            Bucket: B2_BUCKET,
            Prefix: `${orderId}/`,
            MaxKeys: 1000,
        }));

        const objects = listResp.Contents || [];
        const isTruncated = listResp.IsTruncated || false;

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
                    key: obj.Key,
                    url: signedUrl,
                    size: obj.Size || null,
                    created_at: obj.LastModified ? obj.LastModified.toISOString() : null,
                };
            })
        );

        return res.status(200).json({ files, isTruncated });

    } catch (err) {
        console.error('[get-files] B2 Storage error:', err);
        return res.status(500).json({ error: 'Failed to fetch files from storage.' });
    }
};
