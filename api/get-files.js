const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase client — used for JWT auth (same pattern as all other admin APIs) ─
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
const B2_PORTFOLIO_BUCKET = process.env.B2_PORTFOLIO_BUCKET || process.env.B2_BUCKET_NAME || 'zyroeditz-portfolio';

// ALLOWED_PORTFOLIO_FILES removed — now validated dynamically from portfolio_items table (see BUG-7 fix)


module.exports = async function (req, res) {
    // Enable CORS for allowed origins (e.g., admin subdomains)
    const allowedOrigins = ['https://zyroeditz.xyz', 'https://www.zyroeditz.xyz', 'https://admin.zyroeditz.xyz', 'https://zyroeditz.vercel.app'];
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

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
