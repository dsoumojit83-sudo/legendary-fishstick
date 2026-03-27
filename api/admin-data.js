const { createClient } = require('@supabase/supabase-js');

// Connect to Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BUCKET = 'orders'; // Supabase Storage bucket name

module.exports = async function (req, res) {
    // 🔒 SECURITY PROTOCOL: Password Verification
    const authHeader = req.headers['x-admin-password'];
    if (authHeader !== process.env.ADMIN_PASSWORD) {
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
                    const deadline = new Date(order.deadline_date);

                    const diffTime = deadline - today;
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                    if (diffDays <= 2 && diffDays >= 0) {
                        urgentTasks++;
                    }
                }
            }
        });

        // Check Supabase Storage for each order to set has_files flag
        // This is batched in parallel for speed
        const fileCheckResults = await Promise.allSettled(
            orders.map(o =>
                supabase.storage
                    .from(BUCKET)
                    .list(o.order_id, { limit: 1 })
                    .then(({ data }) => ({
                        order_id: o.order_id,
                        has_files: Array.isArray(data) && data.filter(f => f.name !== '.emptyFolderPlaceholder').length > 0
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
