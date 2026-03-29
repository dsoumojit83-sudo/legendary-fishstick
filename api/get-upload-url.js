const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Connect to MinIO
const s3 = new S3Client({
    region: "us-east-1",
    endpoint: process.env.MINIO_ENDPOINT,
    credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY,
        secretAccessKey: process.env.MINIO_SECRET_KEY,
    },
    forcePathStyle: true // Required for MinIO
});

const BUCKET = process.env.MINIO_BUCKET || 'orders';

module.exports = async function(req, res) {
    // Note: No admin password check here, because your CLIENTS will be calling this from the public website to upload their footage.
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { orderId, fileName, fileType } = req.body;

        if (!orderId || !fileName) {
            return res.status(400).json({ error: 'Missing orderId or fileName' });
        }

        // Create the command to save the file inside the specific client's folder
        const command = new PutObjectCommand({
            Bucket: BUCKET,
            Key: `${orderId}/${fileName}`,
            ContentType: fileType || 'application/octet-stream'
        });

        // Generate a highly secure, temporary upload link valid for exactly 1 hour
        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

        return res.status(200).json({ 
            success: true, 
            uploadUrl: uploadUrl, 
            filePath: `${orderId}/${fileName}` 
        });

    } catch (err) {
        console.error("MinIO Upload Presign Error:", err);
        return res.status(500).json({ error: "Failed to generate secure upload gateway." });
    }
};
