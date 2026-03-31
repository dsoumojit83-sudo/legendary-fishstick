const { S3Client, PutObjectCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ── Backblaze B2 S3-compatible client ────────────────────────────────────────
// NOTE: B2 requires the actual region (e.g. 'us-west-004'), not 'auto'.
// Extract it from the endpoint: https://s3.us-west-004.backblazeb2.com → us-west-004
const B2_ENDPOINT = process.env.B2_ENDPOINT || '';
const extractedRegion = (B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || 'us-west-004';

const b2 = new S3Client({
    region: extractedRegion,
    endpoint: B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
    forcePathStyle: true, // B2 requires path-style addressing
});

const B2_BUCKET = process.env.B2_BUCKET_NAME;

// ── Apply CORS rules on cold start so browsers can PUT files directly to B2 ──
// This runs once per serverless instance. It is idempotent — safe to repeat.
let corsApplied = false;
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
                    // B2 requires explicit header names for preflight — wildcard may not work
                    AllowedHeaders: [
                        'content-type',
                        'Content-Type',
                        'authorization',
                        'Authorization',
                        'x-amz-content-sha256',
                        'x-amz-date',
                        'x-amz-security-token',
                        'x-amz-user-agent',
                        'x-bz-content-sha1',
                        'x-bz-file-name',
                        '*',
                    ],
                    AllowedMethods: ['PUT', 'POST', 'GET', 'HEAD', 'DELETE'],
                    ExposeHeaders:  ['ETag', 'x-amz-request-id', 'x-bz-content-sha1'],
                    MaxAgeSeconds:  86400,
                }],
            },
        }));
        corsApplied = true;
        console.log('[upload-files] ✅ B2 CORS rules applied via S3 API.');
    } catch (err) {
        // Common: bucket may already have native B2 CORS rules, which conflict
        // with S3-compatible CORS. Log full error for debugging.
        console.warn('[upload-files] ⚠️ S3 CORS setup failed:', err.Code || err.name, err.message);
        console.warn('[upload-files] ℹ️ If uploads fail with CORS errors, set CORS via B2 CLI:');
        console.warn('  b2 bucket update --cors-rules \'[{"corsRuleName":"allow-uploads","allowedOrigins":["https://zyroeditz.vercel.app","https://www.zyroeditz.com","https://zyroeditz.com"],"allowedOperations":["s3_put","s3_get","s3_head"],"allowedHeaders":["*"],"exposeHeaders":["ETag","x-amz-request-id"],"maxAgeSeconds":86400}]\' ' + (B2_BUCKET || '<bucket-name>'));
    }
})();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload-files
// Body: { orderId: string, fileName: string, contentType: string }
// Returns: { uploadUrl: string } — a pre-signed PUT URL valid for 3 hours
// The client uploads the file DIRECTLY to B2 using this URL, bypassing Vercel
// entirely. This removes the 4.5MB Vercel body limit for video uploads.
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function (req, res) {
    // Cache-control headers
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    // ── Handle CORS preflight from the browser ──────────────────────────
    // This is for the /api/upload-files endpoint itself (Vercel function),
    // NOT for B2. Vercel usually handles this, but explicit is safer.
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Only POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // 🔒 Auth — same header used by all admin APIs
    // NOTE: Clients on payment-success use their orderId as the auth token
    // instead of the admin password so they can upload their own files only.
    // We validate the orderId is present and non-empty as a lightweight guard.
    const { orderId, fileName, contentType } = req.body || {};

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
