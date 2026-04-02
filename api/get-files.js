const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase client — used for JWT auth (same pattern as all other admin APIs) ─
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Backblaze B2 S3-compatible client ────────────────────────────────────────
const B2_ENDPOINT = process.env.B2_ENDPOINT || '';
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

module.exports = async function (req, res) {
    // Method check BEFORE auth — prevents leaking that the endpoint exists
    // when a non-GET request arrives without credentials.
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed.' });
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
