const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

module.exports = async function(req, res) {

    // ── PUBLIC: GET /api/save-brief → returns studio online/offline status ──
    // (No auth needed — this is read-only and public so the website can check it)
    if (req.method === 'GET') {
        try {
            const { data, error } = await supabase
                .from('studio_config')
                .select('is_online')
                .eq('id', 1)
                .single();

            if (error || !data) {
                // Default to online if table not set up yet
                return res.status(200).json({ is_online: true });
            }
            return res.status(200).json({ is_online: data.is_online });
        } catch (e) {
            return res.status(200).json({ is_online: true });
        }
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { orderId, notes } = req.body;

        if (!orderId || !notes) {
            return res.status(400).json({ error: "Missing required data" });
        }

        // Basic input sanitization
        const sanitizedNotes = String(notes).trim().substring(0, 2000);

        // FIX: Verify the order exists before allowing a write.
        // Prevents anyone from overwriting notes on a random/guessed order_id.
        const { data: existingOrder, error: fetchError } = await supabase
            .from('orders')
            .select('order_id, status')
            .eq('order_id', orderId)
            .single();

        if (fetchError || !existingOrder) {
            return res.status(404).json({ error: "Order not found." });
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
