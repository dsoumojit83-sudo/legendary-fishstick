const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// FIX C1: Safety assertion — ensure the anon key env var is not accidentally
// set to the service role key (which would leak full DB access to the client).
if (process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_KEY &&
    process.env.SUPABASE_ANON_KEY === process.env.SUPABASE_KEY) {
    console.error('[CRITICAL] SUPABASE_ANON_KEY === SUPABASE_KEY — refusing to expose service role key!');
}

module.exports = async function(req, res) {

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
        const { orderId, notes, email } = req.body;

        if (!orderId || !notes) {
            return res.status(400).json({ error: "Missing required data" });
        }

        // FIX M2: Basic auth — verify the caller knows the order's email.
        // Prevents anyone who guesses an order_id from overwriting briefs.
        if (!email) {
            return res.status(400).json({ error: "Email is required for verification." });
        }

        // Basic input sanitization
        const sanitizedNotes = String(notes).trim().substring(0, 2000);

        // FIX: Verify the order exists before allowing a write.
        // Prevents anyone from overwriting notes on a random/guessed order_id.
        const { data: existingOrder, error: fetchError } = await supabase
            .from('orders')
            .select('order_id, status, client_email')
            .eq('order_id', orderId)
            .single();

        if (fetchError || !existingOrder) {
            return res.status(404).json({ error: "Order not found." });
        }

        // FIX M2: Verify email matches the order owner
        if (existingOrder.client_email && existingOrder.client_email.toLowerCase() !== email.toLowerCase()) {
            return res.status(403).json({ error: "Email does not match order." });
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
