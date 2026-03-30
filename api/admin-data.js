const { createClient } = require('@supabase/supabase-js');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Connect to Supabase (DB only)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

module.exports = async function (req, res) {
    // Prevent 304 Browser/Vercel Caching
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // 🔒 SECURITY PROTOCOL: Password Verification
    const authHeader = req.headers['x-admin-password'];
    if (!process.env.ADMIN_PASSWORD || authHeader !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized Access. Core Locked.' });
    }

    try {
        // Fetch all orders to compute metrics
        const { data: orders, error } = await supabase
            .from('orders')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        let totalRevenue = 0;
        let mrr = 0;
        let activeProjects = 0;
        let urgentTasks = 0;

        // Setup Chart Data (Last 6 Months)
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const chartDataMap = {};
        for (let i = 5; i >= 0; i--) {
            let d = new Date(currentYear, currentMonth - i, 1);
            chartDataMap[`${monthNames[d.getMonth()]} ${d.getFullYear()}`] = 0;
        }

        // Process Database Rows
        orders.forEach(order => {
            const orderDate = new Date(order.created_at);
            const orderMonthLabel = `${monthNames[orderDate.getMonth()]} ${orderDate.getFullYear()}`;
            const amount = Number(order.amount) || 0;

            // Revenue Logistics
            if (order.status === 'paid' || order.status === 'completed') {
                totalRevenue += amount;

                // Calculate MRR
                if (orderDate.getMonth() === currentMonth && orderDate.getFullYear() === currentYear) {
                    mrr += amount;
                }

                // Populate Chart Data
                if (chartDataMap[orderMonthLabel] !== undefined) {
                    chartDataMap[orderMonthLabel] += amount;
                }
            }

            // Active Pipeline & Urgent Tasks Logistics
            if (order.status === 'pending' || order.status === 'in_progress' || order.status === 'paid') {
                activeProjects++;

                // Calculate Urgent Tasks (Due in <= 2 days)
                if (order.deadline_date) {
                    // Strip the time from 'now' to ensure accurate day-diff calculation
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    // Parse YYYY-MM-DD as local date (not UTC midnight) to avoid IST off-by-one
                    const [dy, dm, dd] = order.deadline_date.split('-').map(Number);
                    const deadline = new Date(dy, dm - 1, dd);

                    const diffTime = deadline - today;
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                    if (diffDays <= 2 && diffDays >= 0) {
                        urgentTasks++;
                    }
                }
            }
        });

        // Check B2 for ACTIVE orders only (pending/in_progress/paid) — not every historical order.
        // This prevents a Vercel timeout as the total order count grows over time.
        const activeOrders = orders.filter(o =>
            o.status === 'pending' || o.status === 'in_progress' || o.status === 'paid'
        );

        const fileCheckResults = await Promise.allSettled(
            activeOrders.map(o =>
                b2.send(new ListObjectsV2Command({
                    Bucket: B2_BUCKET,
                    Prefix: `${o.order_id}/`,
                    MaxKeys: 1,
                }))
                .then(data => ({
                    order_id: o.order_id,
                    has_files: (data.KeyCount || 0) > 0
                }))
            )
        );

        // Build a quick lookup map: order_id -> has_files
        const filesMap = {};
        fileCheckResults.forEach(result => {
            if (result.status === 'fulfilled') {
                filesMap[result.value.order_id] = result.value.has_files;
            }
        });

        // Secure Payload Delivery
        return res.status(200).json({
            totalRevenue,
            mrr,
            activeProjects,
            urgentTasks,
            recentOrders: orders.map(o => ({
                id: o.order_id,
                client: o.client_name || 'Zyro Client',
                email: o.client_email,
                phone: o.client_phone,
                service: o.service || 'Custom Edit',
                amount: o.amount,
                status: o.status,
                created_at: o.created_at,
                completed_at: o.completed_at,
                deadline: o.deadline_date,
                notes: o.project_notes,
                has_files: filesMap[o.order_id] || false  // true = green Files button, false = grey
            })),
            chartData: {
                labels: Object.keys(chartDataMap),
                values: Object.values(chartDataMap)
            }
        });

    } catch (err) {
        console.error("Admin Data Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
