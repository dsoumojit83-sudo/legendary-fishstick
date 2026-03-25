const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

module.exports = async function(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { orderId, notes } = req.body;

        if (!orderId || !notes) {
            return res.status(400).json({ error: "Missing required data" });
        }

        // Update the specific order row in Supabase with the client's notes
        const { error } = await supabase
            .from('orders')
            .update({ project_notes: notes })
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
