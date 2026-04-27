const { createClient } = require('@supabase/supabase-js');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Connect to Supabase (DB only)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 🔒 Admin email whitelist — only these users can access admin endpoints
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'zyroeditz.official@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ── Backblaze B2 S3-compatible client ────────────────────────────────────────
// FIX C2: Normalize endpoint — if env var is bare hostname (no scheme), prepend https://
const _rawB2Endpoint = process.env.B2_ENDPOINT || '';
const B2_ENDPOINT = _rawB2Endpoint.startsWith('http') ? _rawB2Endpoint : `https://${_rawB2Endpoint || 's3.us-west-004.backblazeb2.com'}`;
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
    // B-14 FIX: Restrict CORS to known trusted origins only.
    // admin-data returns sensitive revenue, client names, emails, and phone numbers.
    // Reflecting any Origin allows cross-origin abuse with a stolen JWT token.
    const _adAllowed = ['https://zyroeditz.xyz','https://www.zyroeditz.xyz','https://admin.zyroeditz.xyz','https://zyroeditz.vercel.app'];
    const _adOrigin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', _adAllowed.includes(_adOrigin) ? _adOrigin : _adAllowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    if (!ADMIN_EMAILS.includes((user.email || '').toLowerCase())) return res.status(403).json({ error: 'Forbidden: Admin access required.' });

    try {
        // ── Portfolio admin listing (GET ?type=portfolio) ────────────────────────
        if (req.method === 'GET' && req.query.type === 'portfolio') {
            const { data, error } = await supabase
                .from('portfolio_items')
                .select('*')
                .order('display_order');
            if (error) throw error;
            return res.status(200).json({ items: data });
        }

        // ── Services listing (GET ?type=services) ───────────────────────────────
        if (req.method === 'GET' && req.query.type === 'services') {
            const { data, error } = await supabase
                .from('services')
                .select('*')
                .order('display_order');
            if (error) throw error;
            return res.status(200).json({ services: data || [] });
        }

        // ── Coupons listing (GET ?type=coupons) ─────────────────────────────────
        if (req.method === 'GET' && req.query.type === 'coupons') {
            const { data, error } = await supabase
                .from('coupons')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ coupons: data || [] });
        }

        // ── Reviews listing (GET ?type=reviews) ─────────────────────────────────
        if (req.method === 'GET' && req.query.type === 'reviews') {
            const { data, error } = await supabase
                .from('reviews')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ reviews: data || [] });
        }

        // ── Referrals listing (GET ?type=referrals) ─────────────────────────────
        if (req.method === 'GET' && req.query.type === 'referrals') {
            const { data, error } = await supabase
                .from('referrals')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ referrals: data || [] });
        }

        // ── All POST actions ──────────────────────────────────────────────────
        if (req.method === 'POST') {
            const body = req.body || {};
            const { action } = body;

            // ═══════════════ PORTFOLIO CRUD ═══════════════
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
                const { error } = await supabase.from('portfolio_items').update({ active: false }).eq('id', id);
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
                const { items } = body;
                if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] required.' });
                await Promise.all(items.map(({ id, display_order }) =>
                    supabase.from('portfolio_items').update({ display_order }).eq('id', id)
                ));
                return res.status(200).json({ ok: true });
            }

            // ═══════════════ SERVICES CRUD ═══════════════
            if (action === 'service_add') {
                const { name, base_price, rush_multiplier, description, display_order, active } = body;
                if (!name || !base_price) return res.status(400).json({ error: 'name and base_price are required.' });
                const { data, error } = await supabase.from('services').insert([{
                    name, base_price: Number(base_price),
                    rush_multiplier: Number(rush_multiplier) || 1.5,
                    description: description || '',
                    display_order: display_order || 99,
                    active: active !== false
                }]).select().single();
                if (error) throw error;
                return res.status(201).json({ service: data });
            }

            if (action === 'service_update') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const allowed = ['name','base_price','rush_multiplier','description','display_order','active'];
                const updates = {};
                allowed.forEach(k => { if (k in body) updates[k] = body[k]; });
                if (updates.base_price) updates.base_price = Number(updates.base_price);
                if (updates.rush_multiplier) updates.rush_multiplier = Number(updates.rush_multiplier);
                const { data, error } = await supabase.from('services').update(updates).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ service: data });
            }

            if (action === 'service_delete') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { error } = await supabase.from('services').update({ active: false }).eq('id', id);
                if (error) throw error;
                return res.status(200).json({ ok: true });
            }

            // ═══════════════ COUPONS CRUD ═══════════════
            if (action === 'coupon_add') {
                const { code, discount_percent, max_uses, expires_at } = body;
                if (!code || !discount_percent) return res.status(400).json({ error: 'code and discount_percent are required.' });
                const { data, error } = await supabase.from('coupons').insert([{
                    code: code.toUpperCase().trim(),
                    discount_percent: Number(discount_percent),
                    max_uses: max_uses ? Number(max_uses) : null,
                    uses_count: 0,
                    expires_at: expires_at || null,
                    active: true
                }]).select().single();
                if (error) throw error;
                return res.status(201).json({ coupon: data });
            }

            if (action === 'coupon_update') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const allowed = ['code','discount_percent','max_uses','expires_at','active'];
                const updates = {};
                allowed.forEach(k => { if (k in body) updates[k] = body[k]; });
                if (updates.code) updates.code = updates.code.toUpperCase().trim();
                if (updates.discount_percent) updates.discount_percent = Number(updates.discount_percent);
                if (updates.max_uses !== undefined) updates.max_uses = updates.max_uses ? Number(updates.max_uses) : null;
                const { data, error } = await supabase.from('coupons').update(updates).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ coupon: data });
            }

            if (action === 'coupon_toggle') {
                const { id, active } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { data, error } = await supabase.from('coupons').update({ active }).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ coupon: data });
            }

            if (action === 'coupon_delete') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { error } = await supabase.from('coupons').delete().eq('id', id);
                if (error) throw error;
                return res.status(200).json({ ok: true });
            }

            // ═══════════════ REVIEWS MODERATION ═══════════════
            if (action === 'review_approve') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { data, error } = await supabase.from('reviews').update({ approved: true }).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ review: data });
            }

            if (action === 'review_reject') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { data, error } = await supabase.from('reviews').update({ approved: false }).eq('id', id).select().single();
                if (error) throw error;
                return res.status(200).json({ review: data });
            }

            if (action === 'review_delete') {
                const { id } = body;
                if (!id) return res.status(400).json({ error: 'id is required.' });
                const { error } = await supabase.from('reviews').delete().eq('id', id);
                if (error) throw error;
                return res.status(200).json({ ok: true });
            }

            // ═══════════════ DEADLINE UPDATE ═══════════════
            if (action === 'set_deadline') {
                const { orderId, deadline_date } = body;
                if (!orderId) return res.status(400).json({ error: 'orderId is required.' });
                const { error } = await supabase.from('orders').update({ deadline_date: deadline_date || null }).eq('order_id', orderId);
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
            if (order.status === 'pending' || order.status === 'working' || order.status === 'paid') {
                activeProjects++;

                // BUG FIX #8: Only count real, paid/in-progress projects as urgent.
                // 'pending' = payment not received yet, so deadline pressure isn't real yet.
                if ((order.status === 'working' || order.status === 'paid') && order.deadline_date) {
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
        // Uses the 60s module-level cache to avoid N concurrent B2 calls per dashboard refresh.
        const activeOrders = orders.filter(o =>
            o.status === 'pending' || o.status === 'working' || o.status === 'paid'
        );

        // Build a quick lookup map: order_id -> has_files (result from cache or fresh B2 calls)
        const filesMap = await getCachedFilesMap(activeOrders);

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
