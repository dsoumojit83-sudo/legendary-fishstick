const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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
    // 🔒 Admin-only — same password header as other admin APIs
    if (!process.env.ADMIN_PASSWORD || req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed.' });
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
                    { expiresIn: 3600 } // 1 hour
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
