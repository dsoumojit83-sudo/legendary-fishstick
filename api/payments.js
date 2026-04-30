const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
module.exports = async function (req, res) {
    // CORS — same pattern as all other admin APIs (settlements, admin-data, etc.)
    const _pAllowed = ['https://zyroeditz.xyz','https://www.zyroeditz.xyz','https://admin.zyroeditz.xyz','https://zyroeditz.vercel.app'];
    const _pOrigin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', _pAllowed.includes(_pOrigin) ? _pOrigin : _pAllowed[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Prevent 304 Browser/Vercel Caching
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Allow GET or POST
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 🔒 JWT Auth
    const authH = req.headers['authorization'];
    if (!authH?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user: u }, error: uErr } = await supabase.auth.getUser(authH.slice(7));
    if (uErr || !u) return res.status(401).json({ error: 'Unauthorized' });

    const userEmail = u.email ? u.email.toLowerCase() : '';
    if (userEmail !== 'zyroeditz.official@gmail.com') {
        const { data: adminRecord, error: adminErr } = await supabase.from('admins').select('email').eq('email', userEmail).maybeSingle();
        if (adminErr || !adminRecord) return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    try {
        // 1. Fetch the latest 30 successful/paid orders from Supabase
        const { data: orders, error } = await supabase
            .from('orders')
            .select('order_id, client_name, amount, created_at')
            .in('status', ['paid', 'completed'])
            .order('created_at', { ascending: false })
            .limit(30);

        if (error) throw error;

        // 2. Cross-reference with Cashfree to get the exact Payment Methods
        const fetchOrderDetails = async (order) => {
            try {
                // Ask Cashfree for the payment details of this specific order
                const cfRes = await axios.get(
                    `https://api.cashfree.com/pg/orders/${order.order_id}/payments`,
                    {
                        headers: {
                            "x-client-id": process.env.CASHFREE_APP_ID,
                            "x-client-secret": process.env.CASHFREE_SECRET_KEY,
                            "x-api-version": "2025-01-01",
                            "Content-Type": "application/json"
                        }
                    }
                );

                const payments = cfRes.data || [];
                const successfulPayment = payments
                    .filter(p => p.payment_status === 'SUCCESS')
                    .sort((a,b)=> new Date(b.payment_completion_time) - new Date(a.payment_completion_time))[0];

                let paymentMethod = "MANUAL";
                let networkOrApp = "N/A";
                let utr = "N/A";
                let cfPaymentId = "N/A";
                let gatewayAmount = order.amount;
                let paymentTime = null;
                let gatewayStatus = "MANUAL/PENDING";

                if (successfulPayment) {
                    let extractedGroup = (successfulPayment.payment_group || "unknown").toUpperCase();
                    
                    if (extractedGroup.includes("UPI")) paymentMethod = "UPI";
                    else if (extractedGroup.includes("CARD")) paymentMethod = "CARD";
                    else if (extractedGroup.includes("NET")) paymentMethod = "NETBANKING";
                    else if (extractedGroup.includes("WALLET")) paymentMethod = "WALLET";
                    else if (extractedGroup.includes("BANK")) paymentMethod = "BANK_TRANSFER";
                    else paymentMethod = extractedGroup;

                    utr = 
                        successfulPayment.bank_reference ||
                        successfulPayment.authorization?.action_reference ||
                        successfulPayment.payment_gateway_details?.gateway_reference_name ||
                        "N/A";
                    
                    cfPaymentId = successfulPayment.cf_payment_id || "N/A";
                    gatewayAmount = successfulPayment.payment_amount || order.amount;
                    paymentTime = successfulPayment.payment_completion_time || null;
                    gatewayStatus = "SUCCESS";

                    const pm = successfulPayment.payment_method || {};

                    if (pm.upi) {
                        networkOrApp = pm.upi.channel || pm.upi.upi_id || "UPI";
                    } 
                    else if (pm.card) {
                        networkOrApp = pm.card.card_network || pm.card.card_bank_name || "CARD";
                    } 
                    else if (pm.netbanking) {
                        networkOrApp = pm.netbanking.bank_name || "NETBANKING";
                    }
                    else if (pm.app) {
                        networkOrApp = pm.app.provider || "WALLET";
                    }
                }

                return {
                    order_id: order.order_id,
                    client: order.client_name || "Zyro Client",
                    amount: order.amount,
                    gateway_amount: gatewayAmount,
                    payment_type: paymentMethod,
                    payment_network: networkOrApp,
                    bank_reference: utr,
                    cf_payment_id: cfPaymentId,
                    payment_time: paymentTime,
                    gateway_status: gatewayStatus
                };

            } catch (cfError) {
                console.error(`Cashfree Ledger Error for ${order.order_id}:`, cfError.response?.data || cfError.message);
                
                return {
                    order_id: order.order_id,
                    client: order.client_name || "Zyro Client",
                    amount: order.amount,
                    gateway_amount: order.amount,
                    payment_type: "MANUAL",
                    payment_network: "N/A",
                    bank_reference: "N/A",
                    cf_payment_id: "N/A",
                    payment_time: null,
                    gateway_status: "MANUAL/PENDING"
                };
            }
        };

        const ledger = [];
        const CHUNK_SIZE = 5;
        for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
            const chunk = orders.slice(i, i + CHUNK_SIZE);
            const chunkResults = await Promise.all(chunk.map(fetchOrderDetails));
            ledger.push(...chunkResults);
        }

        let totalUPI = 0;
        let totalCard = 0;
        let totalNetbanking = 0;
        let totalWallet = 0;
        
        ledger.forEach(l => {
            const pType = String(l.payment_type).toUpperCase();
            // BUG FIX #10: Use gateway_amount (actual Cashfree charge) not DB amount
            // to ensure the summary totals match real gateway receipts.
            const amt = l.gateway_amount || l.amount;
            if (pType.includes('UPI')) totalUPI += amt;
            else if (pType.includes('CARD')) totalCard += amt;
            else if (pType.includes('NET')) totalNetbanking += amt;
            else if (pType.includes('WALLET') || pType.includes('APP')) totalWallet += amt;
        });

        // 3. Deliver payload back to admin panel
        return res.status(200).json({
            success: true,
            summary: {
                total_upi_revenue: totalUPI,
                total_card_revenue: totalCard,
                total_netbanking_revenue: totalNetbanking,
                total_wallet_revenue: totalWallet
            },
            ledger: ledger
        });

    } catch (err) {
        console.error("Ledger Build Error:", err);
        return res.status(500).json({ 
            success: false, 
            error: "Failed to sync bank ledger" 
        });
    }
};
