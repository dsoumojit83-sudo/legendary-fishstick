const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ── Backblaze B2 S3-compatible client ────────────────────────────────────────
// NOTE: B2 requires the actual region (e.g. 'us-east-005'), not 'auto'.
const B2_ENDPOINT = process.env.B2_ENDPOINT || '';
const extractedRegion = (B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || 'us-east-005';

const b2 = new S3Client({
    region: extractedRegion,
    endpoint: B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
    forcePathStyle: true,
    // ── CRITICAL: Disable SDK v3 automatic CRC32 checksums ──────────────
    // AWS SDK v3 adds x-amz-checksum-crc32 and x-amz-sdk-checksum-algorithm
    // to presigned URLs by default. B2 does NOT support these — they cause
    // signature mismatches and upload failures. Setting to WHEN_REQUIRED
    // prevents the SDK from injecting them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
});

const B2_BUCKET = process.env.B2_BUCKET_NAME;

// ── Apply CORS via B2 NATIVE API (not S3-compatible PutBucketCors) ──────────
// The S3-compatible PutBucketCorsCommand silently fails on B2 when native CORS
// rules already exist, or when the application key lacks writeBucketCors.
// The native B2 API (b2_update_bucket) is far more reliable.
// Runs once per cold start. Idempotent — safe to repeat.
(async () => {
    try {
        const keyId = process.env.B2_KEY_ID;
        const appKey = process.env.B2_APPLICATION_KEY;
        if (!keyId || !appKey || !B2_BUCKET) {
            console.warn('[upload-files] ⚠️ Missing B2 credentials — skipping CORS setup.');
            return;
        }

        // Step 1: Authorize with B2 native API
        const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(keyId + ':' + appKey).toString('base64')
            }
        });
        if (!authRes.ok) throw new Error('b2_authorize_account HTTP ' + authRes.status);
        const auth = await authRes.json();

        // Step 2: Get bucket ID
        const listRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
            method: 'POST',
            headers: { 'Authorization': auth.authorizationToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId: auth.accountId, bucketName: B2_BUCKET })
        });
        if (!listRes.ok) throw new Error('b2_list_buckets HTTP ' + listRes.status);
        const buckets = await listRes.json();
        const bucket = (buckets.buckets || []).find(b => b.bucketName === B2_BUCKET);
        if (!bucket) throw new Error('Bucket "' + B2_BUCKET + '" not found');

        // Step 3: Set CORS rules via b2_update_bucket
        const updateRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_update_bucket`, {
            method: 'POST',
            headers: { 'Authorization': auth.authorizationToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accountId: auth.accountId,
                bucketId: bucket.bucketId,
                corsRules: [{
                    corsRuleName: 'allowBrowserUploads',
                    allowedOrigins: [
                        'https://zyroeditz.vercel.app',
                        'https://www.zyroeditz.com',
                        'https://zyroeditz.com',
                    ],
                    allowedOperations: [
                        's3_put',
                        's3_get',
                        's3_head',
                        's3_post',
                        's3_delete',
                    ],
                    allowedHeaders: ['*'],
                    exposeHeaders: ['ETag', 'x-amz-request-id', 'x-bz-content-sha1'],
                    maxAgeSeconds: 86400,
                }],
            })
        });

        if (!updateRes.ok) {
            const errBody = await updateRes.text();
            throw new Error('b2_update_bucket HTTP ' + updateRes.status + ': ' + errBody);
        }

        console.log('[upload-files] ✅ B2 CORS configured via native API.');
    } catch (err) {
        console.warn('[upload-files] ⚠️ Native CORS setup failed:', err.message);
        console.warn('[upload-files] ℹ️ Manual fix — run this once via B2 CLI:');
        console.warn(`  b2 bucket update --cors-rules '[{"corsRuleName":"allowBrowserUploads","allowedOrigins":["https://zyroeditz.vercel.app","https://www.zyroeditz.com","https://zyroeditz.com"],"allowedOperations":["s3_put","s3_get","s3_head"],"allowedHeaders":["*"],"exposeHeaders":["ETag","x-amz-request-id"],"maxAgeSeconds":86400}]' ${B2_BUCKET || '<bucket>'}`);
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

        // Pre-signed URL valid for 3 hours — covers large uploads on slow connections
        const uploadUrl = await getSignedUrl(b2, command, { expiresIn: 10800 });

        return res.status(200).json({ uploadUrl, key });

    } catch (err) {
        console.error('[upload-files] Pre-sign error:', err);
        return res.status(500).json({ error: 'Failed to generate upload URL' });
    }
};
