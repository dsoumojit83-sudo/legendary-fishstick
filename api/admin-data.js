const { createClient } = require('@supabase/supabase-js');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Connect to Supabase (DB only)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Backblaze B2 S3-compatible client ────────────────────────────────────────
const B2_ENDPOINT = process.env.B2_ENDPOINT || '';
const extractedRegion = (B2_ENDPOINT.match(/s3\.([^.]+)\.backblazeb2\.com/) || [])[1] || 'us-west-004';

const b2 = new S3Client({
    region: extractedRegion,
    endpoint: B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
});

const B2_BUCKET = process.env.B2_BUCKET_NAME; // orders1

// ── B2 file-check cache (60s TTL) ────────────────────────────────────────────
// MEDIUM FIX #5: admin-data.js was firing N concurrent ListObjectsV2 calls per
// dashboard load with zero caching. This is the same pattern as admin-chat.js
// (which uses a 5-min cache). 60s is appropriate here since the dashboard auto-refreshes
// and admins need to see recent uploads faster than the AI assistant does.
let _adminDataFilesCache = { data: {}, expiresAt: 0 };
const ADMIN_DATA_CACHE_TTL_MS = 60 * 1000; // 60 seconds

async function getCachedFilesMap(activeOrders) {
    const now = Date.now();
    if (now < _adminDataFilesCache.expiresAt) return _adminDataFilesCache.data;
    const results = await Promise.allSettled(
        activeOrders.map(o =>
            b2.send(new ListObjectsV2Command({ Bucket: B2_BUCKET, Prefix: `${o.order_id}/`, MaxKeys: 1 }))
              .then(data => ({ order_id: o.order_id, has_files: (data.KeyCount || 0) > 0 }))
        )
    );
    const fresh = {};
    results.forEach(r => { if (r.status === 'fulfilled') fresh[r.value.order_id] = r.value.has_files; });
    _adminDataFilesCache = { data: fresh, expiresAt: now + ADMIN_DATA_CACHE_TTL_MS };
    return fresh;
}

module.exports = async function (req, res) {
    const _allowed = ['https://zyroeditz.xyz','https://www.zyroeditz.xyz','https://admin.zyroeditz.xyz','https://zyroeditz.vercel.app'];
    const _origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', _allowed.includes(_origin) ? _origin : _allowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Prevent 304 Browser/Vercel Caching
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // 🔒 JWT Auth: validate Supabase session token
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7));
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

    // 🔒 ENFORCE ADMIN ROLE: Only admins can access this API
    const isSuperAdmin = user.email.toLowerCase() === 'zyroeditz.official@gmail.com';
    if (!isSuperAdmin) {
        const { data: adminRecord, error: adminErr } = await supabase.from('admins').select('role').eq('email', user.email).maybeSingle();
        if (adminErr || !adminRecord) {
            return res.status(403).json({ error: 'Forbidden. Admin access required.' });
        }
    }

    try {
        // ── Services catalog (GET ?action=getServices) ──────────────────────────
        if (req.method === 'GET' && req.query.action === 'getServices') {
            const { data, error } = await supabase.from('services').select('*').order('price');
            if (error) throw error;
            return res.status(200).json({ services: data });
        }

        // ── Coupons listing (GET ?action=getCoupons) ──────────────────────────────
        if (req.method === 'GET' && req.query.action === 'getCoupons') {
            const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ coupons: data });
        }

        // ── Admins listing (GET ?action=getAdmins) ────────────────────────────────
        if (req.method === 'GET' && req.query.action === 'getAdmins') {
            const { data: dbAdmins, error: dbErr } = await supabase.from('admins').select('email, role');
            if (dbErr) throw dbErr;
            const adminEmails = dbAdmins.map(a => a.email.toLowerCase());
            
            const { data: authData, error: authErr } = await supabase.auth.admin.listUsers();
            if (authErr) throw authErr;

            const adminUsers = authData.users
                .filter(u => adminEmails.includes(u.email.toLowerCase()) || u.email.toLowerCase() === 'zyroeditz.official@gmail.com')
                .map(u => ({
                    email: u.email,
                    role: u.email.toLowerCase() === 'zyroeditz.official@gmail.com' ? 'superadmin' : 'admin',
                    created_at: u.created_at,
                    last_sign_in_at: u.last_sign_in_at,
                    banned: !!u.banned_until
                }));

            return res.status(200).json({ admins: adminUsers });
        }

        // ── Reviews listing (GET ?action=getReviews) ──────────────────────────────
        if (req.method === 'GET' && req.query.action === 'getReviews') {
            const { data, error } = await supabase.from('reviews').select('*').order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ reviews: data });
        }

        // ── Referrals listing (GET ?action=getReferrals) ──────────────────────────
        if (req.method === 'GET' && req.query.action === 'getReferrals') {
            const { data, error } = await supabase.from('referrals').select('*').order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ referrals: data });
        }

        // ── Portfolio admin listing (GET ?type=portfolio) ────────────────────────
        if (req.method === 'GET' && req.query.type === 'portfolio') {
            const { data, error } = await supabase
                .from('portfolio_items')
                .select('*')
                .order('display_order');
            if (error) throw error;
            return res.status(200).json({ items: data });
        }

        // ── Download Invoice PDF (GET ?action=getBill&orderId=X) ─────────────────
        // Admin JWT already validated above. Generates branded PDF via sendInvoice.buildPdfBuffer().
        // Ref: https://supabase.com/docs/reference/javascript/select (parameterized .eq())
        if (req.method === 'GET' && req.query.action === 'getBill') {
            const { orderId } = req.query;
            if (!orderId) return res.status(400).json({ error: 'Missing orderId.' });

            const { data: order, error: dbErr } = await supabase
                .from('orders')
                .select('order_id, client_name, client_email, client_phone, service, amount, deadline_date, status')
                .eq('order_id', orderId)
                .maybeSingle();

            if (dbErr || !order) return res.status(404).json({ error: 'Order not found.' });

            try {
                const { buildPdfBuffer } = require('./sendInvoice');
                const pdfBuffer = await buildPdfBuffer(order);
                res.setHeader('Content-Type',        'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="ZyroEditz_Invoice_${order.order_id}.pdf"`);
                res.setHeader('Content-Length',      pdfBuffer.length);
                res.setHeader('Cache-Control',       'no-store');
                return res.status(200).end(pdfBuffer);
            } catch (err) {
                console.error('[admin-data][getBill] PDF error:', err.message);
                return res.status(500).json({ error: 'Failed to generate invoice PDF.' });
            }
        }

        // ── Portfolio CRUD (POST) ──────────────────────────────────────────
        if (req.method === 'POST') {
            const body = req.body || {};
            const { action } = body;

            if (action === 'portfolio_add') {
                const { title, category, filename, thumbnail_url, accent_color, grid_cols, grid_rows, display_order } = body;
                if (!title || !category || !filename) return res.status(400).json({ error: 'title, category, filename are required.' });
                const { data, error } = await supabase.from('portfolio_items').insert([{
                    title, category, filename,
                    thumbnail_url: thumbnail_url || null,
                    accent_color: accent_color || 'rgba(73,198,255,0.5)',
                    grid_cols: grid_cols || 1,
                    grid_rows: grid_rows || 1,
                    display_order: display_order || 99,
                    active: true
                }]).select().single();
                if (error) throw error;
                return res.status(201).json({ item: data });
            }

            if (action === 'portfolio_update') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                // BUG-5 FIX: whitelist allowed fields — never pass raw body to Supabase
                const allowed = ['title','category','filename','thumbnail_url','accent_color','grid_cols','grid_rows','display_order','active'];
                const updates = {};
                allowed.forEach(k => { if (k in body) updates[k] = body[k]; });
                if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });
                const { data, error } = await supabase.from('portfolio_items').update(updates).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ item: data });
            }

            if (action === 'portfolio_delete') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { error } = await supabase.from('portfolio_items').delete().eq('id', id);
                if (error) throw error;
                return res.status(200).json({ ok: true });
            }

            if (action === 'portfolio_toggle') {
                const { id, active } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { data, error } = await supabase.from('portfolio_items').update({ active }).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ item: data });
            }

            if (action === 'portfolio_reorder') {
                const { items } = body; // [{id, display_order}]
                if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] required.' });
                await Promise.all(items.map(({ id, display_order }) =>
                    supabase.from('portfolio_items').update({ display_order }).eq('id', id)
                ));
                return res.status(200).json({ ok: true });
            }

            // ── Services CRUD ────────────────────────────────────────────────────
            if (action === 'createService') {
                const { name, price, delivery_days, description, is_active } = body;
                if (!name || price == null) return res.status(400).json({ error: 'name and price are required.' });
                const { data, error } = await supabase.from('services').insert([{
                    name: name.trim(),
                    price: parseFloat(price),
                    delivery_days: delivery_days || null,
                    description: description || null,
                    is_active: is_active !== false
                }]).select().single();
                if (error) throw error;
                return res.status(201).json({ service: data });
            }

            if (action === 'updateService') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const allowed = ['name','price','delivery_days','description','is_active'];
                const updates = {};
                allowed.forEach(k => { if (k in body) updates[k] = body[k]; });
                if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields.' });
                if (updates.name) updates.name = updates.name.trim();
                if (updates.price != null) updates.price = parseFloat(updates.price);
                const { data, error } = await supabase.from('services').update(updates).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ service: data });
            }

            if (action === 'deleteService') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { error } = await supabase.from('services').delete().eq('id', id);
                if (error) throw error;
                return res.status(200).json({ ok: true });
            }

            // ── Coupons CRUD ─────────────────────────────────────────────────────
            if (action === 'createCoupon') {
                const { code, discount_type, discount_value, min_order_value, max_uses, expires_at, is_active } = body;
                if (!code || !discount_value) return res.status(400).json({ error: 'code and discount_value are required.' });
                const { data, error } = await supabase.from('coupons').insert([{
                    code: code.toUpperCase().trim(),
                    discount_type: discount_type || 'percent',
                    discount_value: parseFloat(discount_value),
                    min_order_value: parseFloat(min_order_value) || 0,
                    max_uses: parseInt(max_uses) || 0,
                    times_used: 0,
                    expires_at: expires_at || null,
                    is_active: is_active !== false
                }]).select().single();
                if (error) throw error;
                return res.status(201).json({ coupon: data });
            }

            if (action === 'updateCoupon') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const allowed = ['code','discount_type','discount_value','min_order_value','max_uses','expires_at','is_active'];
                const updates = {};
                allowed.forEach(k => { if (k in body) updates[k] = body[k]; });
                if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields.' });
                if (updates.code) updates.code = updates.code.toUpperCase().trim();
                if (updates.discount_value != null) updates.discount_value = parseFloat(updates.discount_value);
                if (updates.min_order_value != null) updates.min_order_value = parseFloat(updates.min_order_value);
                if (updates.max_uses != null) updates.max_uses = parseInt(updates.max_uses);
                const { data, error } = await supabase.from('coupons').update(updates).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ coupon: data });
            }

            if (action === 'deleteCoupon') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { error } = await supabase.from('coupons').delete().eq('id', id);
                if (error) throw error;
                return res.status(200).json({ ok: true });
            }

            if (action === 'addAdmin') {
                const { email, password } = body;
                if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
                
                // Create or update user in Supabase Auth (requires SERVICE_ROLE_KEY or anon key with right settings)
                const adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
                const { error: authError } = await adminClient.auth.admin.createUser({
                    email,
                    password,
                    email_confirm: true
                });
                if (authError && authError.message !== 'User already registered') throw authError;

                // Add to admins table with role
                const { error: dbError } = await supabase.from('admins').upsert({ email, role: 'admin' }, { onConflict: 'email' }).select().single();
                if (dbError) throw dbError;

                return res.status(200).json({ ok: true });
            }

            if (action === 'deleteAdmin') {
                const { email } = body;
                if (!email) return res.status(400).json({ error: 'Email required.' });
                
                // Remove from admins table (we don't delete from auth to preserve their normal account)
                const { error: dbError } = await supabase.from('admins').delete().eq('email', email);
                if (dbError) throw dbError;
                
                return res.status(200).json({ ok: true });
            }

            // ── Reviews: approve/reject toggle ───────────────────────────────────
            if (action === 'toggleReview') {
                const { id, approved } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { data, error } = await supabase.from('reviews').update({ approved }).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ review: data });
            }

            if (action === 'deleteReview') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { error } = await supabase.from('reviews').delete().eq('id', id);
                if (error) throw error;
                return res.status(200).json({ ok: true });
            }

            return res.status(400).json({ error: 'Unknown action.' });
        }

        // ── Existing dashboard/orders GET logic below ───────────────────────
        // Fetch all orders to compute metrics
        const { data: orders, error } = await supabase
            .from('orders')
            .select('order_id, client_name, client_email, client_phone, service, amount, status, created_at, deadline_date, completed_at, project_notes')
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
            if (order.status === 'paid' || order.status === 'delivered') {
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
            // FIX #5: Only count genuinely active (paid/in_progress) orders — 'created' means
            // payment not received yet, so no real work has started. Excluding 'created'
            // from activeProjects gives an accurate count of in-flight projects.
            if (order.status === 'in_progress' || order.status === 'paid') {
                activeProjects++;

                // Flag as urgent if deadline is within 2 days
                if (order.deadline_date) {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const [dy, dm, dd] = order.deadline_date.split('-').map(Number);
                    const deadline = new Date(dy, dm - 1, dd);
                    const diffDays = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
                    if (diffDays <= 2 && diffDays >= 0) urgentTasks++;
                }
            }
        });

        // Check B2 for ACTIVE orders only (created/in_progress/paid) — not every historical order.
        // This prevents a Vercel timeout as the total order count grows over time.
        // Uses the 60s module-level cache to avoid N concurrent B2 calls per dashboard refresh.
        // FIX #5: Only check B2 for genuinely active (paid/in_progress) orders — not unpaid created
        const activeOrders = orders.filter(o =>
            o.status === 'in_progress' || o.status === 'paid'
        );

        // Build a quick lookup map: order_id -> has_files (result from cache or fresh B2 calls)
        const filesMap = await getCachedFilesMap(activeOrders);

        // CHECK DELIVERIES TABLE: Determine if any delivery record exists for these orders
        // This is used to enable/disable the status update button in the UI.
        const { data: deliveryRecords } = await supabase
            .from('deliveries')
            .select('order_id')
            .in('order_id', activeOrders.map(o => o.order_id));
        const deliveryMap = {};
        if (deliveryRecords) {
            deliveryRecords.forEach(d => { deliveryMap[d.order_id] = true; });
        }

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
                has_files: filesMap[o.order_id] || false, // true = green Files button, false = grey
                has_delivery: deliveryMap[o.order_id] || false // true = delivery record exists in DB
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
