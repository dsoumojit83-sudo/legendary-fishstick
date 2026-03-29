const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Supabase Storage bucket name — must match what upload-files uses
const BUCKET = 'orders';

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
        // List all files inside orders/<orderId>/ folder in Supabase Storage
        const { data: fileList, error } = await supabase.storage
            .from(BUCKET)
            .list(orderId, { limit: 100, offset: 0 });

        if (error) throw error;

        if (!fileList || fileList.length === 0) {
            return res.status(200).json({ files: [] });
        }

        // Build public URLs for each file so admin can open/download directly
        const files = fileList
            .filter(f => f.name !== '.emptyFolderPlaceholder') // skip Supabase placeholder files
            .map(f => {
                const { data: publicUrlData } = supabase.storage
                    .from(BUCKET)
                    .getPublicUrl(`${orderId}/${f.name}`);

                return {
                    name: f.name,
                    url: publicUrlData.publicUrl,
                    size: f.metadata?.size || null,
                    created_at: f.created_at || null
                };
            });

        return res.status(200).json({ files });

    } catch (err) {
        console.error('[get-files] Supabase Storage error:', err);
        return res.status(500).json({ error: 'Failed to fetch files from storage.' });
    }
};
