const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ── Backblaze B2 S3-compatible client ────────────────────────────────────────
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
    // Disable SDK v3 automatic CRC32 checksums — B2 rejects them
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
});

const B2_BUCKET = process.env.B2_BUCKET_NAME;

// ── CORS SETUP — stored as a promise so the handler can AWAIT it ────────────
// This guarantees CORS is set BEFORE we return any presigned URL to the browser.
// Without this, a race condition can occur: the presigned URL is returned but
// B2 hasn't finished applying the CORS rules yet, causing the PUT to fail.
const corsReady = (async () => {
    try {
        const keyId = process.env.B2_KEY_ID;
        const appKey = process.env.B2_APPLICATION_KEY;
        if (!keyId || !appKey || !B2_BUCKET) {
            console.warn('[upload-files] ⚠️ Missing B2 env vars — CORS setup skipped.');
            return false;
        }

        // Step 1: Authorize with B2 native API
        const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(keyId + ':' + appKey).toString('base64')
            }
        });
        if (!authRes.ok) {
            const body = await authRes.text();
            throw new Error('b2_authorize_account HTTP ' + authRes.status + ' — ' + body);
        }
        const auth = await authRes.json();
        console.log('[upload-files] B2 auth OK. apiUrl:', auth.apiUrl);

        // Step 2: Get bucket ID
        const listRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
            method: 'POST',
            headers: { 'Authorization': auth.authorizationToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId: auth.accountId, bucketName: B2_BUCKET })
        });
        if (!listRes.ok) {
            const body = await listRes.text();
            throw new Error('b2_list_buckets HTTP ' + listRes.status + ' — ' + body);
        }
        const buckets = await listRes.json();
        const bucket = (buckets.buckets || []).find(b => b.bucketName === B2_BUCKET);
        if (!bucket) throw new Error('Bucket "' + B2_BUCKET + '" not found in account.');
        console.log('[upload-files] Bucket found: id=' + bucket.bucketId);

        // Step 3: Set CORS rules via b2_update_bucket (native API)
        // IMPORTANT: Only use operations from B2's valid list:
        //   s3_delete, s3_get, s3_head, s3_put  (NO s3_post — that's invalid!)
        //   b2_download_file_by_name, b2_download_file_by_id, b2_upload_file, b2_upload_part
        const updateRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_update_bucket`, {
            method: 'POST',
            headers: { 'Authorization': auth.authorizationToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accountId: auth.accountId,
                bucketId: bucket.bucketId,
                corsRules: [{
                    corsRuleName: 'allow-browser-uploads',
                    allowedOrigins: [
                        'https://zyroeditz.vercel.app',
                        'https://www.zyroeditz.com',
                        'https://zyroeditz.com',
                    ],
                    allowedOperations: [
                        's3_put',
                        's3_get',
                        's3_head',
                        's3_delete',
                    ],
                    allowedHeaders: ['*'],
                    exposeHeaders: ['ETag', 'x-amz-request-id'],
                    maxAgeSeconds: 86400,
                }],
            })
        });

        if (!updateRes.ok) {
            const errBody = await updateRes.text();
            throw new Error('b2_update_bucket HTTP ' + updateRes.status + ' — ' + errBody);
        }

        console.log('[upload-files] ✅ B2 CORS rules applied successfully via native API.');
        return true;
    } catch (err) {
        console.error('[upload-files] ❌ CORS setup FAILED:', err.message);
        return false;
    }
})();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload-files
// Body: { orderId: string, fileName: string, contentType: string }
// Returns: { uploadUrl: string, key: string }
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function (req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── Block until CORS is confirmed set on B2 ─────────────────────────
    // On cold start, the first request waits here until b2_update_bucket finishes.
    // Subsequent requests in the same instance resolve instantly (promise is cached).
    const corsOk = await corsReady;

    const { orderId, fileName, contentType } = req.body || {};
    if (!orderId || !fileName) {
        return res.status(400).json({ error: 'Missing orderId or fileName' });
    }

    const safe = fileName.replace(/[^\w.\-]/g, '_').substring(0, 200);
    const key = `${orderId}/${Date.now()}-${safe}`;

    try {
        const command = new PutObjectCommand({
            Bucket: B2_BUCKET,
            Key: key,
            ContentType: contentType || 'application/octet-stream',
        });

        const uploadUrl = await getSignedUrl(b2, command, { expiresIn: 10800 });

        return res.status(200).json({ uploadUrl, key, corsConfigured: corsOk });

    } catch (err) {
        console.error('[upload-files] Pre-sign error:', err);
        return res.status(500).json({ error: 'Failed to generate upload URL' });
    }
};
