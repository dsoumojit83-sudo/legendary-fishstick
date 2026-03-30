import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import formidable from 'formidable';
import fs from 'fs';

export const config = {
  api: {
    bodyParser: false,
  },
};

// ── Backblaze B2 S3-compatible client ────────────────────────────────────────
const b2 = new S3Client({
  region: 'auto',
  endpoint: process.env.B2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});

const B2_BUCKET = process.env.B2_BUCKET_NAME; // orders1

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const form = formidable({ multiples: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(500).json({ error: 'File parsing failed' });
    }

    const orderId = Array.isArray(fields.orderId) ? fields.orderId[0] : fields.orderId;

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId' });
    }

    try {
      const fileArray = Array.isArray(files.files) ? files.files : [files.files];

      // Upload all files in parallel to B2
      const uploadResults = await Promise.all(
        fileArray.map(async (file) => {
          const data = fs.readFileSync(file.filepath);
          const fileName = `${Date.now()}-${file.originalFilename}`;
          const key = `${orderId}/${fileName}`;

          await b2.send(new PutObjectCommand({
            Bucket: B2_BUCKET,
            Key: key,
            Body: data,
            ContentType: file.mimetype || 'application/octet-stream',
          }));

          return fileName;
        })
      );

      return res.status(200).json({ success: true, files: uploadResults });

    } catch (e) {
      console.error('[upload-files] B2 upload error:', e);
      return res.status(500).json({ error: 'Upload failed' });
    }
  });
}
