import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  const { orderId } = req.query;

  if (!orderId) {
    return res.status(400).json({ error: "Missing orderId" });
  }

  try {
    const { data, error } = await supabase
      .storage
      .from('orders')
      .list(orderId);

    if (error) throw error;

    const files = data.map(file => ({
      name: file.name,
      url: `${process.env.SUPABASE_URL}/storage/v1/object/public/orders/${orderId}/${file.name}`
    }));

    return res.status(200).json(files);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch files" });
  }
}
