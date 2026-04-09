const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const axios = require('axios');
const { Resend } = require('resend');

// Initialize Services
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY
});
const resend = new Resend(process.env.RESEND_API_KEY);

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

// In-Memory Stores
const memoryStore = {};
const pendingActionsStore = {};
const actionHistoryStore = {};
const MAX_HISTORY_PER_SESSION = 5;

// Cache
let _filesMapCache = { data: {}, expiresAt: 0 };
const FILES_CACHE_TTL_MS = 5 * 60 * 1000;

// Utilities
const generateOrderId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

async function getFilesMap(activeOrders) {
    const now = Date.now();
    if (now < _filesMapCache.expiresAt) return _filesMapCache.data;
    
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

// Undo Management
async function saveActionHistory(sessionId, action, originalData) {
    if (!actionHistoryStore[sessionId]) actionHistoryStore[sessionId] = [];
    actionHistoryStore[sessionId].push({ action, originalData, timestamp: new Date().toISOString() });
    if (actionHistoryStore[sessionId].length > MAX_HISTORY_PER_SESSION) actionHistoryStore[sessionId].shift();
}

async function undoLastAction(sessionId) {
    const history = actionHistoryStore[sessionId];
    if (!history || history.length === 0) return { success: false, error: 'No actions to undo' };
    
    const lastAction = history.pop();
    const { action, originalData } = lastAction;
    
    try {
        if (action.type === 'delete_order') {
            const { error } = await supabase.from('orders').insert(originalData);
            return error ? { success: false, error: error.message } : { success: true, actionType: 'restored deleted order', orderId: originalData.order_id };
        }
        if (action.type === 'create_order') {
            const { error } = await supabase.from('orders').delete().eq('order_id', action.orderId);
            return error ? { success: false, error: error.message } : { success: true, actionType: 'removed created order', orderId: action.orderId };
        }
        if (action.type === 'update_status' || action.type === 'update_order') {
            const { error } = await supabase.from('orders').update(originalData).eq('order_id', action.orderId);
            return error ? { success: false, error: error.message } : { success: true, actionType: 'reverted changes', orderId: action.orderId };
        }
        return { success: false, error: 'Unknown action type' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// Action Execution Workflow
async function executeAction(action, sessionId) {
    if (!action || !action.type) return null;

    let originalData = null;
    if (action.orderId && action.type !== 'create_order') {
        const { data } = await supabase.from('orders').select('*').eq('order_id', action.orderId).single();
        originalData = data;
    }

    // 1. CREATE ORDER (Cashfree + Resend Auto-Billing)
    if (action.type === 'create_order') {
        const orderId = generateOrderId();
        const { client_name, email, service, amount, deadline_date } = action;
        
        // Insert DB
        const { error: dbError } = await supabase.from('orders').insert({
            order_id: orderId, client_name, email, service, amount, deadline_date, status: 'pending'
        });
        if (dbError) return { success: false, error: dbError.message };

        // Generate Cashfree Link
        let paymentLink = null;
        try {
            const cashfreeResponse = await axios.post('https://api.cashfree.com/pg/orders', {
                order_amount: amount,
                order_currency: 'INR',
                order_id: orderId,
                customer_details: {
                    customer_id: orderId + '_C',
                    customer_name: client_name,
                    customer_email: email,
                    customer_phone: '9999999999' // Dummy placeholder if missing
                }
            }, {
                headers: {
                    'x-client-id': process.env.CASHFREE_APP_ID,
                    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
                    'x-api-version': '2023-08-01'
                }
            });
            paymentLink = cashfreeResponse.data.payment_link;
        } catch (cfError) {
            console.error('Cashfree Error:', cfError.response?.data || cfError.message);
        }

        // Send Email via Resend
        if (email) {
            await resend.emails.send({
                from: 'ZyroEditz™ <billing@zyroeditz.xyz>',
                to: email,
                subject: `New Invoice for ${service} - ZyroEditz™`,
                html: `
                    <h2>Hello ${client_name},</h2>
                    <p>Your order for <strong>${service}</strong> has been created.</p>
                    <p>Total Amount: <strong>Rs. ${amount}</strong></p>
                    ${paymentLink ? `<p><a href="${paymentLink}" style="padding: 10px 20px; background-color: #ff1a1a; color: white; text-decoration: none; border-radius: 5px;">Pay Now</a></p>` : ''}
                    <hr/>
                    <p><em>Speed. Motion. Precision.</em></p>
                    <p>ZyroEditz™ Studio</p>
                `
            });
        }

        if (sessionId) await saveActionHistory(sessionId, { ...action, orderId }, null);
        return { success: true, orderId, actionType: 'created order and emailed invoice' };
    }

    // 2. UPDATE STATUS (Status Notifications via Resend)
    if (action.type === 'update_status') {
        let { orderId, status } = action;
        if (!orderId || !status) return { success: false, error: 'Missing parameters' };

        if (status === 'in_progress') status = 'working'; // Fallback
        const validStatuses = ['pending', 'working', 'paid', 'completed'];
        if (!validStatuses.includes(status)) return { success: false, error: `Invalid status: ${status}` };

        const updatePayload = { status };
        if (status === 'completed') updatePayload.completed_at = new Date().toISOString();

        const { error } = await supabase.from('orders').update(updatePayload).eq('order_id', orderId);

        if (!error) {
            if (sessionId) await saveActionHistory(sessionId, action, originalData);
            
            // Trigger Email Notifications
            if (originalData?.email && (status === 'working' || status === 'completed')) {
                const subject = status === 'working' ? 'Project Update: Now in Production' : 'Project Completed! Delivery Inside';
                const bodyMsg = status === 'working' 
                    ? `<p>Great news! We've begun working on your project: <strong>${originalData.service}</strong>.</p>`
                    : `<p>Your project <strong>${originalData.service}</strong> is complete!</p><p>Please check your client portal for the final delivery link.</p>`;

                await resend.emails.send({
                    from: 'ZyroEditz™ <zyroeditz.official@gmail.com>',
                    to: originalData.email,
                    subject: subject,
                    html: `
                        <h2>Hello ${originalData.client_name},</h2>
                        ${bodyMsg}
                        <hr/>
                        <p><em>Speed. Motion. Precision.</em></p>
                        <p>ZyroEditz™ Studio</p>
                    `
                });
            }
        }
        return error ? { success: false, error: error.message } : { success: true, orderId, newStatus: status };
    }

    // 3. UPDATE ORDER
    if (action.type === 'update_order') {
        const { orderId, updates } = action;
        if (!orderId || !updates || typeof updates !== 'object') return { success: false, error: 'Missing parameters' };
        if ('amount' in updates) {
            delete updates.amount;
            if (Object.keys(updates).length === 0) return { success: false, error: 'Cannot update amounts directly' };
        }
        const { error } = await supabase.from('orders').update(updates).eq('order_id', orderId);
        if (!error && sessionId) await saveActionHistory(sessionId, action, originalData);
        return error ? { success: false, error: error.message } : { success: true, orderId, actionType: 'updated fields' };
    }

    // 4. DELETE ORDER
    if (action.type === 'delete_order') {
        const { orderId } = action;
        if (!orderId) return { success: false, error: 'Missing orderId' };
        const { error } = await supabase.from('orders').delete().eq('order_id', orderId);
        if (!error && sessionId) await saveActionHistory(sessionId, action, originalData);
        return error ? { success: false, error: error.message } : { success: true, orderId, actionType: 'deleted' };
    }

    return null;
}

// Extraction Utilities
function extractActions(text) {
    const regex = /<<<ACTION:\s*(\{[\s\S]*?\})\s*>>>/g;
    const actions = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        try { actions.push(JSON.parse(m[1])); } catch { /* skip */ }
    }
    let cleanText = text.replace(/<<<ACTION:\s*\{[\s\S]*?\}\s*>>>/g, '').trim().replace(/\n{3,}/g, '\n\n');
    return { cleanText, actions };
}

function extractPendingProposals(text) {
    const regex = /<<<PENDING:\s*(\{[\s\S]*?\})\s*>>>/g;
    const proposals = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        try { proposals.push(JSON.parse(m[1])); } catch { /* skip */ }
    }
    let cleanText = text.replace(/<<<PENDING:\s*\{[\s\S]*?\}\s*>>>/g, '').trim().replace(/\n{3,}/g, '\n\n');
    return { cleanText, proposals };
}

const isConfirmation = (msg) => ['yes', 'yeah', 'yep', 'confirm', 'go ahead', 'do it', 'proceed', 'sure', 'ok', 'okay', 'correct', 'right'].some(w => msg.toLowerCase().trim().match(new RegExp(`^${w}\\b|\\b${w}$|^${w}$`)));
const isUndoRequest = (msg) => ['undo', 'revert', 'cancel that', 'go back', 'restore', 'rollback'].some(w => msg.toLowerCase().trim().includes(w));

module.exports = async function (req, res) {
    const origin = req.headers.origin;
    if (['https://zyroeditz.com', 'https://www.zyroeditz.com'].includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { prompt, sessionId = 'default', attachment } = req.body;
        if (!prompt && !attachment) return res.status(400).json({ error: 'No input' });

        const now = Date.now();
        if (!memoryStore[sessionId]) memoryStore[sessionId] = [];
        const sessionMemory = memoryStore[sessionId].filter(m => now - m.timestamp < 30 * 60 * 1000);
        
        // Handle Undo
        if (prompt && isUndoRequest(prompt)) {
            const undoResult = await undoLastAction(sessionId);
            return res.status(200).json({
                reply: undoResult.success ? `Done. I've ${undoResult.actionType} for order ${undoResult.orderId}.` : (undoResult.error === 'No actions to undo' ? "There's nothing to undo right now." : `Couldn't undo: ${undoResult.error}`),
                actions: undoResult.success ? [undoResult] : [], undone: undoResult.success
            });
        }

        // Handle Confirmations
        if (prompt && isConfirmation(prompt) && pendingActionsStore[sessionId]) {
            const pendingActions = pendingActionsStore[sessionId];
            delete pendingActionsStore[sessionId];
            
            const actionResults = await Promise.allSettled(pendingActions.map(a => executeAction(a, sessionId)));
            const results = actionResults.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
            
            return res.status(200).json({
                reply: "Done. All confirmed actions executed successfully. (Type 'undo' if you need to revert).",
                actions: results
            });
        }
        
        // Handle Rejections
        if (prompt && (prompt.toLowerCase().includes('no') || prompt.toLowerCase().includes('cancel')) && pendingActionsStore[sessionId]) {
            delete pendingActionsStore[sessionId];
            return res.status(200).json({ reply: "Got it, canceled those actions.", actions: [] });
        }

        // Dashboard Analytics Fetch (Token Optimized)
        const { data: activeOrdersList } = await supabase.from('orders').select('*').in('status', ['pending', 'working']);
        const activeOrders = activeOrdersList || [];
        const filesMap = await getFilesMap(activeOrders);
        const activePipeline = activeOrders.map(o => `• ${o.client_name || 'Unknown'} - ${o.service || 'N/A'} (Rs.${Number(o.amount)||0}) [${o.status}] ${filesMap[o.order_id] ? '📁' : ''} - ID: ${o.order_id}`);

        const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

        // System Prompt Build
        const systemPrompt = `You are Prabhas, the personal assistant for Soumojit Das, managing the database for ZyroEditz™ Studio.
Phone: +91 8900229800 | Billing: billing@zyroeditz.xyz | Tagline: "Speed. Motion. Precision."

Today's date (IST): ${todayStr}

ACTIVE PIPELINE:
${activePipeline.length > 0 ? activePipeline.join('\n') : 'No active projects right now.'}

CRITICAL: You are an agent. You have IMMEDIATE ACTIONS and PENDING ACTIONS. 

--- ⚡ IMMEDIATE ACTIONS (Data Retrieval & Links) ---
Output these if you need data BEFORE answering Soumojit. The system will intercept, fetch the data, and prompt you again to formulate your final answer.
DO NOT combine with PENDING actions in the same response.

1. Search Database:
<<<ACTION: {"type": "search_orders", "query": "John Doe"}>>>

2. Generate Client B2 Upload Link:
<<<ACTION: {"type": "generate_upload_link", "orderId": "XYZ123"}>>>

--- 📝 PENDING ACTIONS (Database Mutations - 2-Step Confirmation) ---
If Soumojit asks to create, update, or delete data, you MUST outline the changes and ask for confirmation.
Use the <<<PENDING: {...} >>> tag. 

Valid Formats:
1. Create Order:
<<<PENDING: {"type": "create_order", "client_name": "Name", "email": "client@mail.com", "service": "Short Form", "amount": 200, "deadline_date": "2024-12-31"} >>>
*(Note: Creating an order automatically emails the Cashfree payment link to the client via Resend).*

2. Update Status (Valid: 'pending', 'working', 'completed', 'paid'):
<<<PENDING: {"type": "update_status", "orderId": "exact_order_id", "status": "working"} >>>
*(Note: Updating to 'working' or 'completed' auto-sends a notification email to the client).*

3. Update Fields:
<<<PENDING: {"type": "update_order", "orderId": "exact_order_id", "updates": {"project_notes": "Urgent"}} >>>

4. Delete Order (Add ⚠️ warning to your text):
<<<PENDING: {"type": "delete_order", "orderId": "exact_order_id"} >>>

SERVICES & PRICING:
Short Form: Rs.200 | Long Form: Rs.500 | Motion Graphics: Rs.400 | Thumbnails: Rs.100 | Sound Design: Rs.200 | Color Grading: Rs.175
Brand Colors: Black (#050505) & Red (#ff1a1a).
Portfolio: Hosted at '/portfolio/' with categories Ads, Reels, Short Films.

RULES:
- Be concise, conversational, and direct.
- Never execute without showing a PENDING tag and asking "Should I proceed?".
- If a client name isn't in the active pipeline, ALWAYS use the 'search_orders' action first to find their Order ID before creating a pending update.`;

        let finalPrompt = prompt || '';
        let hasImage = !!(attachment && attachment.type === 'image');
        let selectedModel = hasImage ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';
        let userMessageContent = finalPrompt;

        if (attachment) {
            if (attachment.type === 'pdf') userMessageContent = `[Attached PDF: ${attachment.name}]\n\n${attachment.data}\n\nUser: ${finalPrompt}`;
            if (hasImage) userMessageContent = [{ type: 'text', text: finalPrompt }, { type: 'image_url', image_url: { url: attachment.data } }];
        }

        const currentMessages = [
            { role: 'system', content: systemPrompt },
            ...sessionMemory.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: userMessageContent }
        ];

        // AGENT LOOP
        let finalOutputText = "";
        let finalProposals = [];
        let executionLimit = 3; 

        while (executionLimit > 0) {
            executionLimit--;
            
            const aiResponse = await groq.chat.completions.create({
                model: selectedModel,
                messages: currentMessages,
                temperature: 0.55,
                max_tokens: hasImage ? 1024 : 600
            });

            const rawContent = aiResponse.choices[0].message.content;
            const { cleanText: textAfterImmediate, actions } = extractActions(rawContent);

            // If AI triggers an immediate tool call (search or S3)
            if (actions.length > 0) {
                let toolFeedback = "";
                
                for (const act of actions) {
                    if (act.type === 'search_orders') {
                        const { data } = await supabase.from('orders').select('*').ilike('client_name', `%${act.query}%`).limit(5);
                        toolFeedback += `[Search Results for "${act.query}"]: ${data && data.length > 0 ? JSON.stringify(data) : 'No matches found.'}\n`;
                    }
                    if (act.type === 'generate_upload_link') {
                        const command = new PutObjectCommand({ Bucket: B2_BUCKET, Key: `${act.orderId}/upload-${Date.now()}` });
                        const signedUrl = await getSignedUrl(b2, command, { expiresIn: 3600 });
                        toolFeedback += `[Generated Upload Link for ${act.orderId}]: ${signedUrl}\n`;
                    }
                }

                currentMessages.push({ role: 'assistant', content: rawContent });
                currentMessages.push({ role: 'user', content: `SYSTEM AUTOMATION RESULT:\n${toolFeedback}\nBased on this, reply to Soumojit's original request.` });
                continue; // Loop back for final reasoning
            }

            // No immediate actions, this is the final response string. Extract Pending and Exit.
            const { cleanText: finalText, proposals } = extractPendingProposals(textAfterImmediate);
            finalOutputText = finalText;
            finalProposals = proposals;
            break; 
        }

        if (finalProposals.length > 0) pendingActionsStore[sessionId] = finalProposals;

        sessionMemory.push({ role: 'user', content: typeof userMessageContent === 'string' ? userMessageContent : finalPrompt, timestamp: now });
        sessionMemory.push({ role: 'assistant', content: finalOutputText, timestamp: now });
        
        if (sessionMemory.length > 16) sessionMemory.splice(0, 2);
        memoryStore[sessionId] = sessionMemory;

        return res.status(200).json({
            reply: finalOutputText,
            pendingActions: finalProposals.length,
            hasPendingActions: finalProposals.length > 0
        });

    } catch (err) {
        console.error('Admin Chat Error:', err);
        return res.status(500).json({ error: 'Something went wrong on my end.' });
    }
};
