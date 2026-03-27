import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'fs';

export const config = {
  api: {
    bodyParser: false,
  },
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const form = formidable({ multiples: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(500).json({ error: 'File parsing failed' });
    }

    const orderId = fields.orderId;

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId' });
    }

    try {
      const uploaded = [];
      const fileArray = Array.isArray(files.files) ? files.files : [files.files];

      for (const file of fileArray) {
        const data = fs.readFileSync(file.filepath);
        const fileName = `${Date.now()}-${file.originalFilename}`;

        const { error } = await supabase.storage
          .from('orders')
          .upload(`${orderId}/${fileName}`, data);

        if (error) throw error;

        uploaded.push(fileName);
      }

      return res.status(200).json({ success: true, files: uploaded });

    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Upload failed' });
    }
  });
}
