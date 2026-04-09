const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const axios = require('axios');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY
});

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

const B2_BUCKET = process.env.B2_BUCKET_NAME;

// Short-term memory store — keyed per session, TTL 30 mins
const memoryStore = {};

// ── NEW: Pending actions store — requires confirmation before execution ──
// Stores proposed actions per session that need user approval
const pendingActionsStore = {};

// ── NEW: Action history for undo functionality ──
// Stores last 5 executed actions per session with original state
const actionHistoryStore = {};
const MAX_HISTORY_PER_SESSION = 5;

// ── Cache B2 file-check results (5-min TTL) ───────────────────────
let _filesMapCache = { data: {}, expiresAt: 0 };
const FILES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getFilesMap(activeOrders) {
    const now = Date.now();
    if (now < _filesMapCache.expiresAt) {
        return _filesMapCache.data;
    }
    const fileCheckResults = await Promise.allSettled(
        activeOrders.map(o =>
            b2.send(new ListObjectsV2Command({ Bucket: B2_BUCKET, Prefix: `${o.order_id}/`, MaxKeys: 1 }))
                .then(data => ({ order_id: o.order_id, has_files: (data.KeyCount || 0) > 0 }))
        )
    );
    const freshMap = {};
    fileCheckResults.forEach(r => { if (r.status === 'fulfilled') freshMap[r.value.order_id] = r.value.has_files; });
    _filesMapCache = { data: freshMap, expiresAt: now + FILES_CACHE_TTL_MS };
    return freshMap;
}

const formatDate = (dateStr) => {
    if (!dateStr) return 'None';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return 'Invalid Date';
        const day = d.getUTCDate();
        const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const suffix = [11, 12, 13].includes(day) ? 'th' : ['st', 'nd', 'rd'][((day % 10) - 1)] || 'th';
        return `${day}${suffix} ${months[d.getUTCMonth()]}, ${d.getUTCFullYear()}`;
    } catch { return 'Error'; }
};

// ── NEW: Save state before action for undo capability ────────────────────
async function saveActionHistory(sessionId, action, originalData) {
    if (!actionHistoryStore[sessionId]) {
        actionHistoryStore[sessionId] = [];
    }
    
    actionHistoryStore[sessionId].push({
        action,
        originalData,
        timestamp: new Date().toISOString()
    });
    
    // Keep only last N actions
    if (actionHistoryStore[sessionId].length > MAX_HISTORY_PER_SESSION) {
        actionHistoryStore[sessionId].shift();
    }
}

// ── NEW: Undo last action ────────────────────────────────────────────────
async function undoLastAction(sessionId) {
    const history = actionHistoryStore[sessionId];
    if (!history || history.length === 0) {
        return { success: false, error: 'No actions to undo' };
    }
    
    const lastAction = history.pop();
    const { action, originalData } = lastAction;
    
    try {
        if (action.type === 'delete_order') {
            // Restore deleted order
            const { error } = await supabase
                .from('orders')
                .insert(originalData);
            
            return error
                ? { success: false, error: error.message }
                : { success: true, actionType: 'restored deleted order', orderId: originalData.order_id };
        }
        
        if (action.type === 'update_status' || action.type === 'update_order') {
            // Restore previous values
            const { error } = await supabase
                .from('orders')
                .update(originalData)
                .eq('order_id', action.orderId);
            
            return error
                ? { success: false, error: error.message }
                : { success: true, actionType: 'reverted changes', orderId: action.orderId };
        }
        
        return { success: false, error: 'Unknown action type' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ── Execute an action the AI decided to take ────────────────────────────────
async function executeAction(action, sessionId) {
    if (!action || !action.type) return null;

    // Fetch original data for undo capability
    let originalData = null;
    if (action.orderId) {
        const { data } = await supabase
            .from('orders')
            .select('*')
            .eq('order_id', action.orderId)
            .single();
        originalData = data;
    }

    if (action.type === 'update_status') {
        let { orderId, status } = action;
        if (!orderId || !status) return { success: false, error: 'Missing orderId or status' };

        if (status === 'in_progress') status = 'working';

        const validStatuses = ['pending', 'working', 'paid', 'completed'];
        if (!validStatuses.includes(status)) return { success: false, error: `Invalid status: ${status}` };

        const updatePayload = { status };
        if (status === 'completed') updatePayload.completed_at = new Date().toISOString();

        const { error } = await supabase
            .from('orders')
            .update(updatePayload)
            .eq('order_id', orderId);

        if (!error && sessionId) {
            await saveActionHistory(sessionId, action, originalData);
        }

        if (!error && originalData && originalData.client_email) {
            if (status === 'working') {
                await resend.emails.send({
                    from: 'updates@zyroeditz.xyz',
                    to: originalData.client_email,
                    subject: `Status Update: ${originalData.service}`,
                    html: `<p>Hi there,</p><p>Your project is now being worked on.</p><p>Best regards,<br>ZyroEditz™</p>`
                }).catch(e => console.log('Resend error:', e));
            } else if (status === 'completed') {
                // B-18 FIX: Removed [Insert Final Link Here] placeholder — never send
                // a placeholder to a real client. Delivery link must be shared manually
                // via the admin panel's file-sharing feature or a separate message.
                if (originalData.client_email) {
                    await resend.emails.send({
                        from: 'updates@zyroeditz.xyz',
                        to: originalData.client_email,
                        subject: `Project Completed: ${originalData.service}`,
                        html: `<p>Hi there,</p><p>Your <strong>${originalData.service}</strong> project is now complete! Our team will share the final delivery link with you shortly via email or WhatsApp.</p><p>Your Order ID for reference: <strong>${originalData.order_id}</strong></p><p>If you have any questions, reply to this email or reach us at zyroeditz.official@gmail.com.</p><p>Best regards,<br>ZyroEditz&#8482;</p>`
                    }).catch(e => console.log('Resend error:', e));
                }
            }
        }

        return error
            ? { success: false, error: error.message }
            : { success: true, orderId, newStatus: status };
    }

    if (action.type === 'update_order') {
        const { orderId, updates } = action;
        if (!orderId || !updates || typeof updates !== 'object') return { success: false, error: 'Missing orderId or updates' };

        // SECURITY: Block AI from updating financial amounts to prevent gateway desync
        if ('amount' in updates) {
            delete updates.amount;
            if (Object.keys(updates).length === 0) return { success: false, error: 'Cannot update financial amounts' };
        }

        const { error } = await supabase
            .from('orders')
            .update(updates)
            .eq('order_id', orderId);

        if (!error && sessionId) {
            await saveActionHistory(sessionId, action, originalData);
        }

        return error
            ? { success: false, error: error.message }
            : { success: true, orderId, actionType: 'updated fields' };
    }

    if (action.type === 'delete_order') {
        const { orderId } = action;
        if (!orderId) return { success: false, error: 'Missing orderId' };

        const { error } = await supabase
            .from('orders')
            .delete()
            .eq('order_id', orderId);

        if (!error && sessionId) {
            await saveActionHistory(sessionId, action, originalData);
        }

        return error
            ? { success: false, error: error.message }
            : { success: true, orderId, actionType: 'deleted' };
    }

    if (action.type === 'create_order') {
        const { client_name, phone, email, service, amount, deadline_date } = action;
        if (!client_name || !email || !service || !amount) return { success: false, error: 'Missing required fields' };

        const orderId = 'ZYRO' + Date.now().toString().slice(-6) + Math.random().toString(36).substring(2, 6).toUpperCase();
        const payload = {
            order_id: orderId,
            client_name,
            client_phone: phone || 'N/A',
            client_email: email,
            service,
            amount,
            deadline_date: deadline_date || null,
            status: 'pending'
        };

        const { error } = await supabase.from('orders').insert(payload);
        if (error) return { success: false, error: error.message };

        let payment_link = null;
        try {
            const cleanPhone = phone && String(phone).replace(/\D/g, '').length >= 10
                ? String(phone).replace(/\D/g, '').slice(-10)
                : '9999999999';

            // ── Use Cashfree Payment Links API (/pg/links) ─────────────────────
            // This returns a real shareable `link_url` the admin can send to the client.
            // The Order API (/pg/orders) only returns a session token for SDK checkout.
            const cfResponse = await axios.post('https://api.cashfree.com/pg/links', {
                link_amount: Number(amount),
                link_currency: 'INR',
                link_purpose: `${service} — ZyroEditz™`,
                link_id: orderId,
                customer_details: {
                    customer_name: client_name,
                    customer_email: email,
                    customer_phone: cleanPhone
                },
                link_meta: {
                    return_url: `https://zyroeditz.xyz/payment-success?order_id=${orderId}`
                },
                link_notify: {
                    send_sms: false,
                    send_email: false  // We handle our own emails via sendInvoice on webhook
                }
            }, {
                headers: {
                    'x-client-id': process.env.CASHFREE_APP_ID,
                    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
                    'x-api-version': '2025-01-01'
                }
            });

            // Payment Links API returns link_url directly
            payment_link = cfResponse.data.link_url || cfResponse.data.link_id || null;
        } catch (e) {
            console.log('Cashfree Payment Link error:', e.response?.data || e.message);
            return { success: false, error: `Order created in DB but Cashfree link generation failed: ${e.response?.data?.message || e.message}` };
        }

        return { success: true, actionType: 'created order', orderId, payment_link };
    }

    if (action.type === 'generate_upload_link') {
        const { orderId } = action;
        if (!orderId) return { success: false, error: 'Missing orderId' };
        
        try {
            const key = `${orderId}/client_upload_${Date.now()}.zip`;
            const command = new PutObjectCommand({ Bucket: B2_BUCKET, Key: key });
            const url = await getSignedUrl(b2, command, { expiresIn: 3600 * 24 * 7 });
            return { success: true, actionType: 'upload link generated', orderId, url };
        } catch (e) {
            console.log('Presigner error:', e.message);
            return { success: false, error: 'Failed to generate upload link.' };
        }
    }

    // ── CANCEL ORDER: Full refund + email + DB status update ─────────────────
    if (action.type === 'cancel_order') {
        const { orderId, reason } = action;
        if (!orderId) return { success: false, error: 'Missing orderId' };

        // Must fetch original data (already fetched above if orderId present)
        if (!originalData) return { success: false, error: 'Order not found in database.' };

        const orderStatus = originalData.status;
        const orderAmount = Number(originalData.amount) || 0;
        const hasBeenPaid = orderStatus === 'paid' || orderStatus === 'completed';

        let refundResult = null;
        let refundError = null;

        // ── Step 1: Trigger Cashfree Refund (only if payment was received) ──
        if (hasBeenPaid && orderAmount > 0) {
            try {
                // Cashfree refund needs the ORDERS API order_id.
                // If order was created via Payment Links, the link_id === orderId,
                // but we need to find the underlying cf_payment_id first.
                // Strategy: try Orders API refund directly first (works for chat.js orders).
                // If it fails with 404, the order was a Payment Link — look up via links API.
                let refundOrderId = orderId;

                try {
                    // Check if a direct order exists in Cashfree
                    await axios.get(`https://api.cashfree.com/pg/orders/${orderId}`, {
                        headers: {
                            'x-api-version': '2025-01-01',
                            'x-client-id': process.env.CASHFREE_APP_ID,
                            'x-client-secret': process.env.CASHFREE_SECRET_KEY
                        }
                    });
                    // Order exists via Orders API — use orderId directly for refund
                } catch (lookupErr) {
                    if (lookupErr.response?.status === 404) {
                        // Payment Link order — Cashfree auto-creates an internal order ID.
                        // Fetch it from the Payment Links API.
                        const linkRes = await axios.get(`https://api.cashfree.com/pg/links/${orderId}`, {
                            headers: {
                                'x-api-version': '2025-01-01',
                                'x-client-id': process.env.CASHFREE_APP_ID,
                                'x-client-secret': process.env.CASHFREE_SECRET_KEY
                            }
                        });
                        // The link's linked order_id is in link_orders[0].order_id
                        const linkedOrders = linkRes.data.link_orders || [];
                        if (linkedOrders.length > 0) {
                            refundOrderId = linkedOrders[0].order_id;
                        } else {
                            throw new Error('No completed payment found for this Payment Link.');
                        }
                    } else {
                        throw lookupErr;
                    }
                }

                const refundId = `REFUND_${orderId}_${Date.now().toString().slice(-6)}`;
                const cfRefundRes = await axios.post(
                    `https://api.cashfree.com/pg/orders/${refundOrderId}/refunds`,
                    {
                        refund_amount: orderAmount,
                        refund_id: refundId.substring(0, 40), // Cashfree max 40 chars
                        refund_note: reason ? reason.substring(0, 100) : 'Order cancelled by merchant',
                        refund_speed: 'STANDARD'
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-version': '2025-01-01',
                            'x-client-id': process.env.CASHFREE_APP_ID,
                            'x-client-secret': process.env.CASHFREE_SECRET_KEY
                        }
                    }
                );

                refundResult = cfRefundRes.data;
                console.log(`[cancel_order] Refund initiated for ${orderId}:`, refundResult?.refund_status);

            } catch (refErr) {
                // Refund failed — DON'T cancel the order, surface the error
                refundError = refErr.response?.data?.message || refErr.message;
                console.error(`[cancel_order] Cashfree refund FAILED for ${orderId}:`, refundError);
                return {
                    success: false,
                    error: `Cashfree refund failed: ${refundError}. Order NOT cancelled to prevent financial discrepancy.`
                };
            }
        }

        // ── Step 2: Update DB status to 'refunded' ────────────────────────────
        const { error: dbError } = await supabase
            .from('orders')
            .update({ status: 'refunded', completed_at: new Date().toISOString() })
            .eq('order_id', orderId);

        if (dbError) {
            return { success: false, error: `DB update failed: ${dbError.message}. Refund was already submitted to Cashfree — contact support.` };
        }

        await saveActionHistory(sessionId, action, originalData);

        // ── Step 3: Send cancellation email to client ─────────────────────────
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (originalData.client_email && emailRegex.test(originalData.client_email)) {
            const refundArn = refundResult?.refund_arn || null;
            const refundStatus = refundResult?.refund_status || (hasBeenPaid ? 'PENDING' : 'N/A');
            const refundNote = hasBeenPaid
                ? `<p>A full refund of <strong>Rs.${orderAmount.toFixed(2)}</strong> has been initiated to your original payment method. Refunds typically reflect in <strong>5–7 business days</strong> (STANDARD speed).</p>
                   ${refundArn ? `<p style="color:#888;font-size:12px;">Refund Reference (ARN): <code>${refundArn}</code></p>` : ''}`
                : `<p>Since payment had not been collected for this order, no refund transaction is applicable.</p>`;

            await resend.emails.send({
                from: 'ZyroEditz\u2122 <billing@zyroeditz.xyz>',
                to: originalData.client_email,
                reply_to: 'zyroeditz.official@gmail.com',
                subject: `Order Cancellation Confirmed \u2014 ${originalData.service} | ZyroEditz\u2122`,
                html: `
                    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#050505;color:#fff;border:1px solid #222;border-radius:12px;overflow:hidden;">
                        <div style="background:#111;padding:36px 30px;text-align:center;border-bottom:2px solid #ff1a1a;">
                            <h1 style="margin:0;font-size:30px;font-weight:900;">Zyro<span style="color:#ff1a1a;">Editz</span>&#8482;</h1>
                            <p style="margin:5px 0 0;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:4px;">Speed. Motion. Precision.</p>
                        </div>
                        <div style="padding:36px 30px;">
                            <h2 style="margin-top:0;color:#fff;">Order Cancellation Confirmed</h2>
                            <p style="color:#ccc;font-size:15px;line-height:1.6;">Hi <strong>${(originalData.client_name || 'there').replace(/[<>"'&]/g, '')}</strong>,</p>
                            <p style="color:#ccc;font-size:15px;line-height:1.6;">We're sorry to inform you that your order has been cancelled${reason ? ` — <em style="color:#ff6666;">${reason.replace(/[<>"'&]/g, '')}</em>` : ''}.</p>
                            <div style="background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:20px;margin:24px 0;">
                                <table style="width:100%;border-collapse:collapse;">
                                    <tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Order ID</td><td style="padding:8px 0;color:#ff1a1a;font-weight:bold;text-align:right;font-family:monospace;">${originalData.order_id}</td></tr>
                                    <tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Service</td><td style="padding:8px 0;color:#fff;text-align:right;border-top:1px solid #222;">${(originalData.service || 'N/A').replace(/[<>"'&]/g, '')}</td></tr>
                                    <tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Amount</td><td style="padding:8px 0;color:#fff;text-align:right;border-top:1px solid #222;">Rs.${orderAmount.toFixed(2)}</td></tr>
                                    <tr><td style="padding:8px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #222;">Refund Status</td><td style="padding:8px 0;color:${refundStatus === 'SUCCESS' ? '#22c55e' : '#ffcc00'};font-weight:bold;text-align:right;border-top:1px solid #222;">${refundStatus}</td></tr>
                                </table>
                            </div>
                            ${refundNote}
                            <p style="color:#ccc;font-size:14px;line-height:1.6;">We hope to work with you again in the future. If you have any questions, reply to this email or reach us at <a href="mailto:zyroeditz.official@gmail.com" style="color:#ff1a1a;">zyroeditz.official@gmail.com</a>.</p>
                        </div>
                        <div style="background:#0a0a0a;padding:20px 30px;text-align:center;border-top:1px solid #1a1a1a;">
                            <p style="margin:0;color:#666;font-size:12px;">&copy; ${new Date().getFullYear()} ZyroEditz&#8482;. All rights reserved.</p>
                        </div>
                    </div>
                `
            }).catch(e => console.error('[cancel_order] Resend email error:', e.message));
        }

        return {
            success: true,
            orderId,
            actionType: 'cancelled_and_refunded',
            refundStatus: refundResult?.refund_status || (hasBeenPaid ? 'PENDING' : 'N/A (unpaid)'),
            refundArn: refundResult?.refund_arn || null,
            amountRefunded: hasBeenPaid ? orderAmount : 0
        };
    }

    return null;
}

// ── Parse ALL action blocks out of AI response ─────────────────────────────
function extractActions(text) {
    const regex = /<<<ACTION:\s*(\{[\s\S]*?\})\s*>>>/g;
    const actions = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        try { actions.push(JSON.parse(m[1])); } catch { /* skip malformed */ }
    }
    let cleanText = text.replace(/<<<ACTION:\s*\{[\s\S]*?\}\s*>>>/g, '').trim();
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
    return { cleanText, actions };
}

// ── NEW: Extract pending proposals from AI response ────────────────────────
function extractPendingProposals(text) {
    const regex = /<<<PENDING:\s*(\{[\s\S]*?\})\s*>>>/g;
    const proposals = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        try { proposals.push(JSON.parse(m[1])); } catch { /* skip malformed */ }
    }
    let cleanText = text.replace(/<<<PENDING:\s*\{[\s\S]*?\}\s*>>>/g, '').trim();
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
    return { cleanText, proposals };
}

// ── NEW: Check if user message is a confirmation ───────────────────────────
function isConfirmation(message) {
    const confirmWords = ['yes', 'yeah', 'yep', 'confirm', 'go ahead', 'do it', 'proceed', 'sure', 'ok', 'okay', 'correct', 'right', 'affirmative'];
    const lowerMsg = message.toLowerCase().trim();
    return confirmWords.some(word => lowerMsg === word || lowerMsg.startsWith(word + ' ') || lowerMsg.endsWith(' ' + word));
}

// ── NEW: Check if user wants to undo ───────────────────────────────────────
function isUndoRequest(message) {
    const undoWords = ['undo', 'revert', 'cancel that', 'go back', 'restore', 'rollback'];
    const lowerMsg = message.toLowerCase().trim();
    return undoWords.some(word => lowerMsg.includes(word));
}

module.exports = async function (req, res) {
    // CORS configuration
    const origin = req.headers.origin;
    const allowedOrigins = [
        'https://zyroeditz.xyz',
        'https://www.zyroeditz.xyz',
        'https://admin.zyroeditz.xyz',
        'https://zyroeditz.vercel.app'
    ];
    
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { prompt, sessionId = 'default', attachment } = req.body;
        if (!prompt && !attachment) return res.status(400).json({ error: 'No input' });

        const now = Date.now();
        const SESSION_TTL = 30 * 60 * 1000;

        // Session memory management
        if (!memoryStore[sessionId]) memoryStore[sessionId] = [];
        const sessionMemory = memoryStore[sessionId].filter(m => now - m.timestamp < SESSION_TTL);

        // B-09 FIX: Evict fully-expired sessions from all in-memory stores to prevent
        // unbounded memory growth on warm Vercel instances with many unique sessions.
        Object.keys(memoryStore).forEach(id => {
            if (id === sessionId) return; // skip active session
            const msgs = memoryStore[id];
            if (!msgs.length || now - msgs[msgs.length - 1].timestamp > SESSION_TTL) {
                delete memoryStore[id];
                delete pendingActionsStore[id];
                delete actionHistoryStore[id];
            }
        });
        
        // ── NEW: Handle undo requests ──────────────────────────────────────────
        if (prompt && isUndoRequest(prompt)) {
            const undoResult = await undoLastAction(sessionId);
            
            if (undoResult.success) {
                return res.status(200).json({
                    reply: `Done. I've ${undoResult.actionType} for order ${undoResult.orderId}.`,
                    actions: [undoResult],
                    undone: true
                });
            } else {
                return res.status(200).json({
                    reply: undoResult.error === 'No actions to undo' 
                        ? "There's nothing to undo right now."
                        : `Couldn't undo: ${undoResult.error}`,
                    actions: []
                });
            }
        }

        // ── NEW: Handle confirmations for pending actions ──────────────────────
        if (prompt && isConfirmation(prompt) && pendingActionsStore[sessionId]) {
            const pendingActions = pendingActionsStore[sessionId];
            delete pendingActionsStore[sessionId]; // Clear pending state
            
            // Execute all pending actions
            const actionResults = await Promise.allSettled(
                pendingActions.map(action => executeAction(action, sessionId))
            );
            
            const results = actionResults
                .map(r => r.status === 'fulfilled' ? r.value : null)
                .filter(Boolean);
            
            const successCount = results.filter(r => r.success).length;
            const totalCount = pendingActions.length;
            
            let summaryMsg = '';
            if (successCount === totalCount) {
                if (totalCount === 1) {
                    const action = pendingActions[0];
                    const r = results[0];
                    if (action.type === 'delete_order') {
                        summaryMsg = `Deleted order ${action.orderId}.`;
                    } else if (action.type === 'update_status') {
                        summaryMsg = `Updated ${action.orderId} to ${action.status}.`;
                    } else if (action.type === 'create_order') {
                        summaryMsg = `Order **${r.orderId}** created for **${action.client_name}** (${action.service}).`;
                    } else if (action.type === 'generate_upload_link') {
                        summaryMsg = `Generated upload link for ${results[0].orderId}.`;
                    } else if (action.type === 'cancel_order') {
                        const refunded = r.amountRefunded > 0;
                        summaryMsg = `Order **${r.orderId}** cancelled.${refunded ? ` Refund of **Rs.${r.amountRefunded}** initiated to Cashfree (status: ${r.refundStatus}).${r.refundArn ? ` ARN: \`${r.refundArn}\`` : ''} Cancellation email sent to client.` : ' No payment was on record, so no refund was required.'}`;
                    } else {
                        summaryMsg = `Updated order ${action.orderId}.`;
                    }
                } else {
                    summaryMsg = `All ${totalCount} actions completed successfully.`;
                }
            } else {
                summaryMsg = `Completed ${successCount} out of ${totalCount} actions. ${totalCount - successCount} failed.`;
            }
            
            // Append generated links dynamically
            let linkAppendix = '';
            results.forEach(r => {
                if (r && r.payment_link) {
                    linkAppendix += `\n\n💳 **Payment Link** (send to client):\n${r.payment_link}`;
                    linkAppendix += `\n\n✅ **Payment Success URL** (share after payment or use internally):\nhttps://zyroeditz.xyz/payment-success?order_id=${r.orderId}`;
                }
                if (r && r.url) linkAppendix += `\n\n📁 **B2 Upload Link** (7-day expiry):\n${r.url}`;
            });

            return res.status(200).json({
                reply: summaryMsg + " (Type 'undo' if you need to revert this)" + linkAppendix,
                actions: results
            });
        }
        
        // ── NEW: Handle rejection of pending actions ───────────────────────────
        // IMPORTANT: We only treat 'cancel' as a rejection if there's NO orderId context in the message.
        // Otherwise "cancel order ZYRO123" would abort the pending action instead of starting a new cancel flow.
        if (prompt && pendingActionsStore[sessionId]) {
            const lp = prompt.toLowerCase();
            const isExplicitRejection =
                (lp === 'no' || lp === 'nope' || lp === 'nah' || lp === 'abort' || lp === 'stop' || lp === 'dont' || lp === "don't") ||
                (lp.includes('cancel') && !lp.match(/cancel\s+(order|zyro|#)/i));

            if (isExplicitRejection) {
                delete pendingActionsStore[sessionId];
                return res.status(200).json({
                    reply: "Got it, I've dropped those pending actions.",
                    actions: []
                });
            }
        }

        // ── Fetch data ─────────────────────────────────────────────────────────
        const { data: allOrders, error: fetchError } = await supabase
            .from('orders')
            .select('*')
            .order('created_at', { ascending: false });

        if (fetchError) throw new Error(`Database error: ${fetchError.message}`);

        const orders = allOrders || [];
        const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

        const totalRev = orders.reduce((s, o) => s + (Number(o.amount) || 0), 0).toFixed(2);
        const currentMonth = new Date().getMonth();
        const monthRev = orders
            .filter(o => o.created_at && new Date(o.created_at).getMonth() === currentMonth)
            .reduce((s, o) => s + (Number(o.amount) || 0), 0)
            .toFixed(2);

        const activeOrders = orders.filter(o => o.status && !['completed', 'canceled', 'refunded'].includes(o.status));
        const filesMap = await getFilesMap(activeOrders);

        const activePipeline = activeOrders.map(o => {
            const amt = Number(o.amount) || 0;
            const hasFiles = filesMap[o.order_id] ? '📁' : '';
            return `• ${o.client_name || 'Unknown'} - ${o.service || 'N/A'} (Rs.${amt}) [${o.status}] ${hasFiles} - Order: ${o.order_id}`;
        });

        const uniqueClients = [...new Set(orders.map(o => o.client_name).filter(Boolean))];
        const arpu = uniqueClients.length > 0 ? (Number(totalRev) / uniqueClients.length).toFixed(2) : '0.00';

        const repeatClients = uniqueClients.filter(name => orders.filter(o => o.client_name === name).length > 1);
        const retentionRate = uniqueClients.length > 0 ? ((repeatClients.length / uniqueClients.length) * 100).toFixed(1) : '0.0';

        const totalSettled = orders
            .filter(o => o.status === 'completed' || o.status === 'paid')
            .reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const pendingClearance = Number(totalRev) - totalSettled;

        // B-08 FIX: Previous formula (grossProfit - totalSettled) / totalSettled always
        // evaluated to -3% — it was subtracting the fee from itself. Now correctly
        // reports Cashfree's 3% gateway fee as a cost against settled revenue.
        const profitMargin = totalSettled > 0 ? `97.0% (after 3% Cashfree gateway fee)` : 'N/A';

        const whaleClients = uniqueClients
            .map(name => ({
                name,
                total: orders.filter(o => o.client_name === name).reduce((s, o) => s + (Number(o.amount) || 0), 0)
            }))
            .filter(c => c.total >= 2000)
            .sort((a, b) => b.total - a.total)
            .map(c => c.name);

        const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
        const ghostLeads = activeOrders.filter(o => {
            if (!o.created_at) return false;
            const orderTime = new Date(o.created_at).getTime();
            return orderTime < twoDaysAgo && o.status === 'pending';
        });

        // ────────────────────────────────────────────────────────────────────────
        // SYSTEM PROMPT — Enhanced with enforced confirmation flow
        // ────────────────────────────────────────────────────────────────────────
        const systemPrompt = `You are Zyro, a smart, friendly assistant built specifically for Soumojit Das who runs ZyroEditz — a video editing studio.

You talk like a real person, not a robot. You're helpful, a bit casual, and genuinely invested in making the studio run well. You know everything about the business in real-time and you can propose actions — but you NEVER execute them immediately unless it is a search explicitly designed to get context.

Today's date (IST): ${todayStr}

---

BUSINESS SNAPSHOT:
- Lifetime revenue: Rs.${totalRev}
- This month: Rs.${monthRev}
- Avg revenue per client: Rs.${arpu}
- Client retention rate: ${retentionRate}%
- Cleared to bank: Rs.${totalSettled.toFixed(2)} | Locked in gateway: Rs.${Math.max(0, pendingClearance).toFixed(2)}
- Profit margin after Cashfree fees: ${profitMargin}
- High-value clients: ${whaleClients.length > 0 ? whaleClients.join(', ') : 'None yet'}
- Stale leads (no action 48h+): ${ghostLeads.length > 0 ? ghostLeads.map(o => `${o.client_name} - ${o.service} (${o.order_id})`).join(', ') : 'None'}

ACTIVE PIPELINE:
${activePipeline.length > 0 ? activePipeline.join('\n') : 'No active projects right now.'}

---

CRITICAL ACTION WORKFLOW (TWO-STEP CONFIRMATION SYSTEM):

When Soumojit asks you to modify the database, you MUST follow this exact workflow:

STEP 1 — PROPOSE (Never execute directly):
- Summarize EXACTLY what you'll do in plain English
- Ask "Should I go ahead?" or similar
- Output a PENDING block (not ACTION block)

STEP 2 — EXECUTE (Only after Soumojit confirms):
- The system will automatically execute when Soumojit says "yes"/"confirm"/etc
- You don't need to do anything in step 2 — just wait for confirmation

Valid Pending Proposal Formats:

1. Propose New Order Creation:
- You MUST automatically determine the 'amount' based on the requested service using the SERVICES & PRICING menu below.
- You MUST automatically set 'deadline_date' to 24-48 hours from today unless the user specifies otherwise.
- Only ask the user for missing details if they haven't provided Name, Phone, Email, or Service.
<<<PENDING: {"type": "create_order", "client_name": "...", "phone": "...", "email": "...", "service": "...", "amount": "...", "deadline_date": "YYYY-MM-DD"} >>>

2. Propose Status Update (working, completed, pending, paid):
<<<PENDING: {"type": "update_status", "orderId": "exact_order_id", "status": "completed"} >>>

3. Propose Field Update:
<<<PENDING: {"type": "update_order", "orderId": "exact_order_id", "updates": {"project_notes": "Urgent"}} >>>

4. Propose Generating B2 Upload Link:
<<<PENDING: {"type": "generate_upload_link", "orderId": "exact_order_id"} >>>

5. Propose Deletion (⚠️ Extra warning required):
<<<PENDING: {"type": "delete_order", "orderId": "exact_order_id"} >>>

6. Propose Order Cancellation + Full Refund:
   - Use this when Soumojit says "cancel", "refund", "cancel and refund", etc.
   - For paid orders: triggers Cashfree refund + email to client
   - For unpaid orders: just marks as cancelled + sends cancellation email
   - You MUST include a reason (use "Client request" if none given)
   - ⚠️ This is IRREVERSIBLE — add an explicit warning in your message before the PENDING block
<<<PENDING: {"type": "cancel_order", "orderId": "exact_order_id", "reason": "e.g. Client requested cancellation"} >>>

--- 
INSTANT ACTIONS:
If you need to query the database, you can emit an ACTION block bypassing confirmation. The system will intercept it and give you the data to answer the user!

Search Orders:
<<<ACTION: {"type": "search_orders", "query": "client name or id or email"} >>>
---

ADDITIONAL RULES:

1. RESTRICTIONS:
   - You CANNOT edit financial amounts (amount field)
   - If asked, direct Soumojit to use the main interface for proper invoice generation

2. SMART CONTEXT:
   - If asked about "the last order" or a client name without an ID, find the exact match first
   - Show the order ID in your proposal to prevent wrong-target execution
   
3. UNDO SUPPORT:
   - After executing actions, remind Soumojit they can type "undo" to revert
   - Keep responses natural — don't make it sound robotic

4. WORKFLOW DISTINCTION:
   - "Mark as done"/"completed" = status='completed' (creative workflow)
   - "working" = status='working' (creative workflow in progress)
   - "Mark as paid" = status='paid' (finance workflow)
   - These are different states — never confuse them

5. BULK OPERATIONS:
   - For bulk changes, output one PENDING block per order
   - Summarize all changes clearly before asking for confirmation
   - Add extra warning for bulk deletions

---

PERSONALITY & STYLE:
- Talk like a knowledgeable friend, not a computer terminal
- Keep it short and direct unless Soumojit asks for detail
- Use natural language ("here's what I found", "looks like", "yeah", "sure") — avoid formal filler
- Call him Soumojit or just skip the name — never "Sir" or "Boss" repeatedly
- If you don't know something, say so honestly
- When giving lists, use bullet points — keep each line tight
- Don't start every message the same way — vary your tone naturally

SERVICES & PRICING:
- Short Form: Rs.200 — YouTube Shorts, Reels
- Long Form: Rs.500 — Full YouTube videos, vlogs
- Motion Graphics: Rs.400 — Effects, branding
- Thumbnails: Rs.100 — Standalone designs
- Sound Design: Rs.200 — Audio editing, SFX, music sync
- Color Grading & Correction: Rs.175 — Cinematic color work, correction

Revision policy: 1 free revision included with every order.
Refund policy: Full refund if client isn't happy with the final cut.
  
PORTFOLIO KNOWLEDGE:
The portfolio is hosted at '/portfolio/' — a cinematic, dark-themed single-page gallery. It's the studio's premium showcase.

INTRO EXPERIENCE:
- Cinematic shutter-reveal: eyebrow text "ZyroEditz™ — Director's Vault" fades in, then a gradient line accent draws across, then hero text "Welcome to a new era of Editing." reveals word-by-word, a tagline "Cinematic Edits · Unmatched Retention · Built for Impact" appears, and a progress bar fills before dual shutters split open to reveal the main page.

PORTFOLIO ITEMS (5 live entries):
- NEON NIGHTS — Commercial Ad (Ads category, 2×2 featured card)
- URBAN ECHO — Short Film (Short Film category, 1×1 card)
- RHYTHM — Music Reel (Reels category, 1×1 card)
- SPEED DYNAMICS — Automotive Ad (Ads category, 2×1 wide card)
- VIRAL CUTS — Social Shorts (Reels category, 1×1 card)
Categories: Commercials (Ads), Reels & Shorts, Narrative (Short Films). Users can filter by category.

SECTIONS:
1. Director's Cut — Bento grid gallery with hover effects (sibling blur/dimming, glare)
2. Behind the Timeline — About section with stats: 100+ Projects, 50M+ Views, 4K Master Exports, 24h Turnaround
3. The Process — 4 steps: Raw Intake → Story Mapping → Precision Edit → Final Delivery
4. Client Testimonials — 4 reviews: Vikram Sharma, Priya Desai, Arjun Malhotra, Neha Krishnan (all "Valuable Client", all ★★★★★)

DESIGN DETAILS:
- Colors: dark ink (#06060b), electric blue (#49c6ff), violet (#7a5cff), haze (#9db4ff). Red (#ff1a1a) ONLY used in "Editz" logo text.
- Brand name is always "ZyroEditz™" (mixed case with trademark), NEVER all-caps "ZYROEDITZ".
- Desktop: spotlight cursor, sibling blur on hover, vanilla-tilt glare on cards
- Mobile: optimized with no heavy hover effects, compact grid, hidden marquee

Always direct people to '/portfolio/' to see the curated gallery if they ask for samples or past work.`;

        // ── Build messages with memory ────────────────────────────────────────
        let finalPrompt = prompt || '';
        let hasImage = false;
        let selectedModel = 'llama-3.3-70b-versatile';
        let userMessageContent = finalPrompt;

        if (attachment) {
            if (attachment.type === 'pdf') {
                finalPrompt = `[Attached Document: ${attachment.name}]\n\n${attachment.data}\n\nUser Message:\n${finalPrompt}`;
                userMessageContent = finalPrompt;
            } else if (attachment.type === 'image') {
                hasImage = true;
                selectedModel = 'meta-llama/llama-4-scout-17b-16e-instruct';
                userMessageContent = [
                    { type: 'text', text: finalPrompt || 'Please describe this image.' },
                    { type: 'image_url', image_url: { url: attachment.data } }
                ];
            }
        }

        const currentMessages = [
            { role: 'system', content: systemPrompt },
            ...sessionMemory.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: userMessageContent }
        ];

        let aiResponse = await groq.chat.completions.create({
            model: selectedModel,
            messages: currentMessages,
            temperature: 0.55,
            max_tokens: hasImage ? 1024 : 600
        });

        let rawContent = aiResponse.choices[0].message.content;

        // ── Check for instantaneous database SEARCH action ──
        const searchRegex = /<<<ACTION:\s*(\{.*?type.*?search_orders.*?\})\s*>>>/i;
        const searchMatch = searchRegex.exec(rawContent);
        if (searchMatch) {
            try {
                const searchObj = JSON.parse(searchMatch[1]);
                if (searchObj.query) {
                    const { data: searchResults } = await supabase
                        .from('orders')
                        .select('*')
                        .or(`client_name.ilike.%${searchObj.query}%,order_id.eq.${searchObj.query},client_email.ilike.%${searchObj.query}%`)
                        .limit(10);
                    
                    const resultsText = searchResults && searchResults.length > 0 
                        ? searchResults.map(o => `[ID:${o.order_id} | Client:${o.client_name} | Email:${o.client_email} | Phone:${o.client_phone} | Service:${o.service} | Status:${o.status} | Amount:${o.amount}]`).join('\n')
                        : 'No matching orders found.';

                    currentMessages.push({ role: 'assistant', content: rawContent });
                    currentMessages.push({ role: 'system', content: `[Database Search Results for "${searchObj.query}"]:\n${resultsText}\n\nContinue responding to the user using these results without using the search_orders action again.` });

                    aiResponse = await groq.chat.completions.create({
                        model: selectedModel,
                        messages: currentMessages,
                        temperature: 0.55,
                        max_tokens: 600
                    });
                    rawContent = aiResponse.choices[0].message.content;
                }
            } catch (e) {
                console.log("Search parsing error:", e);
            }
        }

        // ── Extract pending proposals and store them ───────────────────────────
        const { cleanText, proposals } = extractPendingProposals(rawContent);
        
        if (proposals.length > 0) {
            pendingActionsStore[sessionId] = proposals;
        }

        // ── Update memory ─────────────────────────────────────────────────────
        sessionMemory.push({ 
            role: 'user', 
            content: finalPrompt + (hasImage ? ` [Attached Image: ${attachment.name}]` : ''), 
            timestamp: now 
        });
        sessionMemory.push({ 
            role: 'assistant', 
            content: rawContent, 
            timestamp: now 
        });
        
        if (sessionMemory.length > 20) sessionMemory.splice(0, 2);
        memoryStore[sessionId] = sessionMemory;

        return res.status(200).json({
            reply: cleanText,
            pendingActions: proposals.length,
            hasPendingActions: proposals.length > 0
        });

    } catch (err) {
        console.error('Admin Chat Error:', err);
        return res.status(500).json({ error: 'Something went wrong on my end.' });
    }
};
