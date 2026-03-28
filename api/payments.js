const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function (req, res) {
    // Prevent 304 Browser/Vercel Caching
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Allow GET or POST
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Security Check
    const authHeader = req.headers['x-admin-password'];
    if (authHeader !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized Access. Core Locked.' });
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
        const ledger = await Promise.all(orders.map(async (order) => {
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

                // Find the successful transaction (ignores failed attempts by the client)
                const payments = cfRes.data || [];
                const successfulPayment = payments.find(p => p.payment_status === 'SUCCESS');

                let paymentMethod = "Unknown";
                let networkOrApp = "N/A";
                
                // Decode Cashfree's nested payment method object
                if (successfulPayment && successfulPayment.payment_method) {
                    const pm = successfulPayment.payment_method;
                    if (pm.upi) { 
                        paymentMethod = "UPI"; 
                        networkOrApp = pm.upi.channel || "GPay/PhonePe"; 
                    } else if (pm.card) { 
                        paymentMethod = "Card"; 
                        networkOrApp = pm.card.card_network || "Visa/Mastercard"; 
                    } else if (pm.netbanking) { 
                        paymentMethod = "Netbanking"; 
                        networkOrApp = pm.netbanking.bank_name; 
                    } else if (pm.app) { 
                        paymentMethod = "Wallet"; 
                        networkOrApp = pm.app.provider; 
                    }
                }

                return {
                    order_id: order.order_id,
                    client: order.client_name || "Zyro Client",
                    amount: order.amount,
                    date: order.created_at,
                    payment_type: paymentMethod,             // e.g., "UPI" or "Card"
                    payment_network: networkOrApp,           // e.g., "Visa" or "GPay"
                    bank_reference: successfulPayment ? successfulPayment.bank_reference : 'N/A',
                    gateway_status: successfulPayment ? 'SUCCESS' : 'MANUAL/PENDING'
                };

            } catch (cfError) {
                // If the order wasn't found in Cashfree (e.g. manually marked paid by you)
                return {
                    order_id: order.order_id,
                    client: order.client_name,
                    amount: order.amount,
                    date: order.created_at,
                    payment_type: "Manual Entry",
                    payment_network: "N/A",
                    bank_reference: "N/A",
                    gateway_status: "MANUAL"
                };
            }
        }));

        // Calculate a quick summary for the top of your ledger
        let totalUPI = 0;
        let totalCard = 0;
        let totalNetbanking = 0;
        let totalWallet = 0;
        
        ledger.forEach(l => {
            if (l.payment_type === 'UPI') totalUPI += l.amount;
            if (l.payment_type === 'Card') totalCard += l.amount;
            if (l.payment_type === 'Netbanking') totalNetbanking += l.amount;
            if (l.payment_type === 'Wallet') totalWallet += l.amount;
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
