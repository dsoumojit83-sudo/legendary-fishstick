const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    // Security check to ensure only YOU can complete projects
    if (!process.env.ADMIN_PASSWORD || req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized Access.' });
    }

    try {
        const { orderId, status } = req.body;
        
        if (!orderId || !status) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }

        let updatePayload = { status: status };

        // If the admin is marking the project as completed, generate the timestamp
        if (status === 'completed') {
            updatePayload.completed_at = new Date().toISOString(); // <--- THIS POPULATES COMPLETED_AT
        }

        const { error } = await supabase
            .from('orders')
            .update(updatePayload)
            .eq('order_id', orderId);

        if (error) {
            console.error("Status Update Failed:", error);
            throw error;
        }

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error("Update Status Error:", err);
        return res.status(500).json({ error: "Failed to update project status." });
    }
};
