const OpenAI = require('openai');
const axios = require('axios'); // Added for Cashfree API calls

const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY 
});

const userState = {};

const serviceNames = {
    short: "Short Form",
    long: "Long Form",
    motion: "Motion Graphics",
    thumbnail: "Thumbnails",
    sound: "Sound Design",
    color: "Color Correction & Grade"
};

const generateOrderId = () => {
    return "ZYRO" + Date.now() + Math.random().toString(16).slice(2,6).toUpperCase();
};

// --- NEW: CASHFREE ORDER GENERATOR ---
const createCashfreeOrder = async (amount, orderId, customerId) => {
    try {
        const response = await axios.post(
            'https://api.cashfree.com/pg/orders',
            {
                order_id: orderId,
                order_amount: amount,
                order_currency: "INR",
                customer_details: {
                    customer_id: customerId,
                    customer_phone: "9999999999" // Placeholder: replace with user input if collected
                },
                order_meta: {
                    return_url: "https://zyroeditz.vercel.app/order-status?order_id={order_id}",
                    notify_url: "https://zyroeditz.vercel.app/api/webhook"
                }
            },
            {
                headers: {
                    'x-api-version': '2023-08-01',
                    'x-client-id': process.env.CASHFREE_APP_ID,
                    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data.payment_session_id; // This is the key to the OG payment page
    } catch (error) {
        console.error("Cashfree Error:", error.response ? error.response.data : error.message);
        return null;
    }
};

module.exports = async function(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { message, clientId = "default_user" } = req.body;
        const msg = message.toLowerCase().trim();

        const pricing = {
            short: { full: 200 },
            long: { full: 500 },
            motion: { full: 400 },
            thumbnail: { full: 100 },
            sound: { full: 200 },
            color: { full: 175 }
        };

        if (!userState[clientId]) {
            userState[clientId] = {
                step: "select", 
                service: null,
                orderId: generateOrderId()
            };
        }

        const state = userState[clientId];

        if (state.step === "done") {
            state.step = "select";
            state.service = null;
            state.orderId = generateOrderId();
            
            return res.json({
                reply: `Hey!👋 Zyro Assistant is here. What kind of project can I help you with today?\nJust type the service you need:\n• Short Form\n• Long Form\n• Motion Graphics\n• Thumbnails\n• Sound Design\n• Color Correction & Grade`,
                clearHistory: true
            });
        }

        if (["no", "cancel", "don't", "not interested", "stop"].some(w => msg.includes(w)) && state.step !== "form") {
            state.step = "done";
            return res.json({
                reply: `I’m a bit sad we couldn’t create something this time 😔\nFeel free to come back anytime.`,
                clearHistory: true
            });
        }

        if (state.step === "select") {
            if (msg.includes("short")) state.service = "short";
            else if (msg.includes("long")) state.service = "long";
            else if (msg.includes("motion")) state.service = "motion";
            else if (msg.includes("thumbnail")) state.service = "thumbnail";
            else if (msg.includes("sound")) state.service = "sound";
            else if (msg.includes("color") || msg.includes("grade")) state.service = "color";

            if (state.service) {
                const data = pricing[state.service];
                const name = serviceNames[state.service];
                state.step = "confirm";

                return res.json({
                    reply: `Order ID: ${state.orderId}\n\nYou've selected *${name}* 🎯\n\n💰 Total Price: ₹${data.full}\n*(Full payment required upfront. 100% refund if not satisfied)*\n🎁 *Apply coupon code on the website form for 10% cashback!*\n\nType "pay" to proceed.`
                });
            }
            return res.json({ reply: "Please choose a service from the options above to continue." });
        }

        // --- UPDATED: STEP 2 GENERATES REAL CASHFREE LINK ---
        if (state.step === "confirm" && msg.includes("pay")) {
            const data = pricing[state.service];
            const session_id = await createCashfreeOrder(data.full, state.orderId, clientId);

            if (!session_id) {
                return res.json({ reply: "⚠️ Sorry Boss, there was an issue connecting to the payment gateway. Please try again in a moment." });
            }

            state.step = "payment_pending";

            return res.json({
                reply: `Order ID: ${state.orderId}\n\nReady to start the project? Click the button below to pay ₹${data.full} securely via Card, UPI, or NetBanking. 👇\n\nAfter payment, type "done".`,
                paymentSessionId: session_id // Frontend uses this to launch the OG Checkout
            });
        }

        if (state.step === "payment_pending") {
            if (["yes", "done", "paid", "ok", "sent"].some(w => msg.includes(w))) {
                state.step = "form";
                return res.json({
                    reply: `Order ID: ${state.orderId}\n\nGreat! ✅\n\n📌 Fill the Contact Form on the website.\n📸 Our system is verifying the payment now. Once confirmed, your invoice will be sent to your email automatically.`
                });
            }
            return res.json({ reply: "Please complete the payment and confirm by typing 'done' here." });
        }

        // Final Form Step remains for capturing details
        if (state.step === "form") {
            if (message !== "FORM_SUBMITTED") {
                return res.json({ reply: "Please submit the Contact Form on the website to finalize your order." });
            }
            state.step = "done";
            return res.json({
                reply: `Order ID: ${state.orderId}\n\nOrder Confirmed! ✅\n\n📂 Send your raw files to begin:\n\nWhatsApp: +91 7602679995\nEmail: zyroeditz.official@gmail.com`,
                clearHistory: true 
            });
        }

        return res.json({ reply: "Please choose a service from the options above to continue." });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server Error" });
    }
};
