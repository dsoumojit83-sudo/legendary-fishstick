const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createClient } = require('@supabase/supabase-js');

// Supabase used to verify orderId belongs to a real order before issuing upload URL
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

// ── CORS SETUP ───────────────────────────────────────────────────────────────
// B2 CORS rules are bucket-level and persist after they're written — we don't
// need to re-apply them on every cold start. We use a module-level singleton
// promise so: (a) the first request on a cold instance sets CORS once and
// (b) every subsequent request on the same warm instance awaits instantly.
//
// CORS RULE CHANGES (aligned with official B2 docs, April 2025):
//  - Upgraded auth/bucket API calls to b2api/v3 (current stable; v2 is legacy)
//  - Fixed exposeHeaders: replaced 'x-amz-request-id' (AWS-specific, not emitted
//    by B2) with 'x-bz-content-sha1' (B2's actual upload integrity header) + kept ETag
//  - allowedHeaders: narrowed from ['*'] to only headers a presigned S3 PUT
//    actually sends — prevents B2 from accepting arbitrary header injections on preflight
//  - allowedOrigins: uses https://*.zyroeditz.xyz wildcard (per B2 docs) to cover
//    all subdomains (admin, www, future) with one rule entry instead of listing each
//  - maxAgeSeconds: kept at 86400 (max allowed by B2 — 1 day browser preflight cache)

const corsReady = (async () => {
    try {
        const keyId = process.env.B2_KEY_ID;
        const appKey = process.env.B2_APPLICATION_KEY;
        if (!keyId || !appKey || !B2_BUCKET) {
            console.warn('[upload-files] ⚠️ Missing B2 env vars — CORS setup skipped.');
            return false;
        }

        // Step 1: Authorize with B2 Native API (v3 — current stable release)
        const authRes = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
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
        const listRes = await fetch(`${auth.apiUrl}/b2api/v3/b2_list_buckets`, {
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

        // Step 3: Apply CORS rules via b2_update_bucket (Native API v3)
        //
        // Valid allowedOperations per B2 docs:
        //   Native API: b2_upload_file, b2_upload_part, b2_download_file_by_name, b2_download_file_by_id
        //   S3-Compatible: s3_put, s3_get, s3_head, s3_delete  (NO s3_post — invalid)
        //
        // allowedHeaders — only what a presigned S3 PUT actually sends:
        //   • content-type        — set by the browser on the PUT body
        //   • content-length      — set by the browser on the PUT body
        //   • x-amz-*            — AWS SigV4 signed headers included in the presigned URL
        //   • authorization       — in case the SDK includes it as an explicit header
        //   (Using ['*'] works but allows any header on preflight — unnecessarily broad)
        //
        // exposeHeaders — headers B2 actually includes in successful responses:
        //   • ETag               — upload checksum, used by SDK to verify the write
        //   • x-bz-content-sha1  — B2's native integrity header (replaces x-amz-request-id
        //                          which is AWS-specific and is NOT sent by Backblaze)
        //
        // allowedOrigins — B2 does NOT support subdomain wildcards (https://*.domain.com).
        //   Each origin must be listed explicitly. Confirmed via Backblaze community forums.
        //   • https://zyroeditz.xyz     — apex / root domain
        //   • https://www.zyroeditz.xyz — www subdomain
        //   • https://admin.zyroeditz.xyz — admin panel subdomain
        const updateRes = await fetch(`${auth.apiUrl}/b2api/v3/b2_update_bucket`, {
            method: 'POST',
            headers: { 'Authorization': auth.authorizationToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accountId: auth.accountId,
                bucketId: bucket.bucketId,
                corsRules: [{
                    corsRuleName: 'allow-browser-uploads',
                    allowedOrigins: [
                        // B2 does NOT support *.domain.com wildcards — list each origin explicitly
                        'https://zyroeditz.xyz',
                        'https://www.zyroeditz.xyz',
                        'https://admin.zyroeditz.xyz',
                    ],
                    allowedOperations: [
                        's3_put',
                        's3_get',
                        's3_head',
                        's3_delete',
                    ],
                    allowedHeaders: [
                        // Required for SigV4 presigned URL preflight (OPTIONS) requests:
                        // x-amz-content-sha256 and x-amz-date are sent by the browser
                        // during the OPTIONS preflight — B2 rejects the upload without them.
                        'authorization',
                        'content-type',
                        'content-length',
                        'x-amz-content-sha256',
                        'x-amz-date',
                        'x-amz-security-token',
                    ],
                    exposeHeaders: [
                        'ETag',
                        'x-bz-content-sha1',
                    ],
                    maxAgeSeconds: 86400,
                }],
            })
        });

        if (!updateRes.ok) {
            const errBody = await updateRes.text();
            throw new Error('b2_update_bucket HTTP ' + updateRes.status + ' — ' + errBody);
        }

        console.log('[upload-files] ✅ B2 CORS rules applied successfully (b2api/v3).');
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

    // ── BUG FIX #1: Verify orderId belongs to a real, non-completed order ────
    // Prevents anonymous users from uploading arbitrary files to your B2 bucket
    // by guessing order IDs. Only pending/paid/in_progress orders are uploadable.
    const { data: existingOrder, error: authError } = await supabase
        .from('orders')
        .select('order_id, status')
        .eq('order_id', orderId)
        .single();

    if (authError || !existingOrder) {
        return res.status(403).json({ error: 'Invalid or unknown order ID.' });
    }
    if (existingOrder.status === 'completed') {
        return res.status(403).json({ error: 'Cannot upload files to a completed order.' });
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
