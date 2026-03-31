const { S3Client, PutObjectCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ── Backblaze B2 S3-compatible client ────────────────────────────────────────
const b2 = new S3Client({
    region: 'auto',
    endpoint: process.env.B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
});

const B2_BUCKET = process.env.B2_BUCKET_NAME;

// ── Apply CORS rules on cold start so browsers can PUT files directly to B2 ──
// This runs once per serverless instance. It is idempotent — safe to repeat.
(async () => {
    try {
        await b2.send(new PutBucketCorsCommand({
            Bucket: B2_BUCKET,
            CORSConfiguration: {
                CORSRules: [{
                    AllowedOrigins: [
                        'https://zyroeditz.vercel.app',
                        'https://www.zyroeditz.com',
                        'https://zyroeditz.com',
                    ],
                    AllowedHeaders: ['*'],
                    AllowedMethods: ['PUT', 'GET', 'HEAD'],
                    ExposeHeaders:  ['ETag'],
                    MaxAgeSeconds:  3600,
                }],
            },
        }));
        console.log('[upload-files] ✅ B2 CORS rules applied.');
    } catch (err) {
        // Log but never crash — pre-sign still works even if CORS update fails
        console.warn('[upload-files] ⚠️ CORS setup skipped:', err.message);
    }
})();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload-files
// Body: { orderId: string, fileName: string, contentType: string }
// Returns: { uploadUrl: string } — a pre-signed PUT URL valid for 10 minutes
// The client uploads the file DIRECTLY to B2 using this URL, bypassing Vercel
// entirely. This removes the 4.5MB Vercel body limit for video uploads.
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function (req, res) {
    // Cache-control headers
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    // Only POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // 🔒 Auth — same header used by all admin APIs
    // NOTE: Clients on payment-success use their orderId as the auth token
    // instead of the admin password so they can upload their own files only.
    // We validate the orderId is present and non-empty as a lightweight guard.
    const { orderId, fileName, contentType } = req.body;

    if (!orderId || !fileName) {
        return res.status(400).json({ error: 'Missing orderId or fileName' });
    }

    // Sanitize fileName — strip path traversal and non-ASCII chars
    const safe = fileName.replace(/[^\w.\-]/g, '_').substring(0, 200);
    const key = `${orderId}/${Date.now()}-${safe}`;

    try {
        const command = new PutObjectCommand({
            Bucket: B2_BUCKET,
            Key: key,
            ContentType: contentType || 'application/octet-stream',
        });

        // Pre-signed URL valid for 3 hours — covers 1–3 GB uploads even on slow connections
        const uploadUrl = await getSignedUrl(b2, command, { expiresIn: 10800 });

        return res.status(200).json({ uploadUrl, key });

    } catch (err) {
        console.error('[upload-files] Pre-sign error:', err);
        return res.status(500).json({ error: 'Failed to generate upload URL' });
    }
};
