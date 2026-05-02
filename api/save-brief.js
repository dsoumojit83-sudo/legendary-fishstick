const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

module.exports = async function(req, res) {
    const _allowed = ['https://zyroeditz.xyz','https://www.zyroeditz.xyz','https://admin.zyroeditz.xyz','https://zyroeditz.vercel.app'];
    const _origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', _allowed.includes(_origin) ? _origin : _allowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    // ── PUBLIC: GET /api/save-brief → returns studio online/offline status ──
    // (No auth needed — this is read-only and public so the website can check it)
    if (req.method === 'GET') {
        // MOBILE PERF FIX: Cache the studio status response at the CDN/edge for 15s.
        // Mobile devices poll every 60s — this allows Vercel's edge to serve cached
        // responses without hitting Supabase on every single poll from every device.
        res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30');
        try {
            const { data, error } = await supabase
                .from('studio_config')
                .select('is_online')
                .eq('id', 1)
                .single();

            return res.status(200).json({
                is_online: (!error && data) ? data.is_online : true,
                supabaseUrl: process.env.SUPABASE_URL || null,
                supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null
            });
        } catch (e) {
            return res.status(200).json({
                is_online: true,
                supabaseUrl: process.env.SUPABASE_URL || null,
                supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null
            });
        }
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { orderId, notes } = req.body;
        if (!orderId || !notes) return res.status(400).json({ error: "Missing required data" });

        // 🔒 JWT Auth & Role Check
        const authHeader = req.headers['authorization'];
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized. Authentication required.' });
        }
        const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7));
        if (authError || !user) return res.status(401).json({ error: 'Unauthorized. Session expired.' });

        // Basic input sanitization
        const sanitizedNotes = String(notes).trim().substring(0, 2000);

        // Verify the order exists and check ownership
        const { data: existingOrder, error: fetchError } = await supabase
            .from('orders')
            .select('order_id, status, client_email')
            .eq('order_id', orderId)
            .single();

        if (fetchError || !existingOrder) {
            return res.status(404).json({ error: "Order not found." });
        }

        // RBAC: Admin OR Owner
        const isSuperAdmin = user.email.toLowerCase() === 'zyroeditz.official@gmail.com';
        let isAdmin = isSuperAdmin;
        if (!isSuperAdmin) {
            const { data: adminRecord } = await supabase.from('admins').select('role').eq('email', user.email).maybeSingle();
            if (adminRecord) isAdmin = true;
        }

        const isOwner = user.email.toLowerCase() === existingOrder.client_email.toLowerCase();
        if (!isAdmin && !isOwner) {
            return res.status(403).json({ error: "Forbidden. You do not own this order." });
        }

        // Don't allow editing notes on already-completed projects
        if (existingOrder.status === 'completed') {
            return res.status(403).json({ error: "Cannot edit brief for a completed project." });
        }

        // Update the order with the client's notes
        const { error } = await supabase
            .from('orders')
            .update({ project_notes: sanitizedNotes })
            .eq('order_id', orderId);

        if (error) {
            console.error("Failed to save brief to Supabase:", error);
            return res.status(500).json({ error: "Database error" });
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error("Save Brief Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
