const OpenAI = require('openai');
const axios = require('axios'); // Added for Cashfree

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
                    customer_phone: "9999999999" // Default filler
                },
                order_meta: {
                    return_url: "https://zyroeditz.vercel.app/?order_id={order_id}",
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
        return response.data.payment_session_id;
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

        // Flat pricing for ALL users
        const pricing = {
            short: { full: 200 },
            long: { full: 500 },
            motion: { full: 400 },
            thumbnail: { full: 100 },
            sound: { full: 200 },
            color: { full: 175 }
        };

        // Initialize state directly to 'select' since frontend already sent the greeting
        if (!userState[clientId]) {
            userState[clientId] = {
                step: "select", 
                service: null,
                orderId: generateOrderId()
            };
        }

        const state = userState[clientId];

        // MEMORY WIPE & RESTART
        if (state.step === "done") {
            state.step = "select"; // Reset directly to 'select'
            state.service = null;
            state.orderId = generateOrderId();
            
            return res.json({
                reply: `Hey!👋 Zyro Assistant is here. What kind of project can I help you with today? We handle everything from Video Editing to Motion Graphics and Sound Design!\nJust type the service you need from the options below:\n• Short Form\n• Long Form\n• Motion Graphics\n• Thumbnails\n• Sound Design\n• Color Correction & Grade`,
                clearHistory: true
            });
        }

        // EXIT INTENT
        if (["no", "cancel", "don't", "dont", "not interested", "stop"].some(w => msg.includes(w)) && state.step !== "form") {
            state.step = "done";
            return res.json({
                reply: `I’m a bit sad we couldn’t create something this time 😔\nFeel free to come back anytime when you're ready.`,
                clearHistory: true
            });
        }

        // STEP 1: SERVICE SELECTION
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
                    reply: `Order ID: ${state.orderId}\n\nYou've selected *${name}* 🎯\n\n💰 Total Price: ₹${data.full}\n*(Full payment required upfront. 100% refund if not satisfied)*\n🎁 *Apply coupon code on the website form for 10% cashback!*\n\n⏱ Delivery:\n• Thumbnails – Same day\n• Others – 24–48 hours\n\n🔁 Revisions included\n\nType "pay" to proceed.`
                });
            }

            // Fallback if they type something unrelated
            return res.json({
                reply: "Please choose a service from the options above to continue."
            });
        }

        // STEP 2: GENERATE CASHFREE CHECKOUT
        if (state.step === "confirm" && msg.includes("pay")) {

            const data = pricing[state.service];
            const sessionId = await createCashfreeOrder(data.full, state.orderId, clientId);

            if (!sessionId) {
                return res.json({ reply: "⚠️ Payment gateway error. Please try again in a few seconds." });
            }

            state.step = "payment_pending";

            return res.json({
                reply: `Order ID: ${state.orderId}\n\nSecure payment link generated! Opening the professional checkout now... 👇\n\nAfter completing the payment, please type "done" or "paid" here.`,
                paymentSessionId: sessionId
            });

        } else if (state.step === "confirm") {
            return res.json({ reply: 'To secure your spot and open the payment gateway, please type "pay".' });
        }

        // STEP 3: PAYMENT CONFIRM
        if (state.step === "payment_pending") {

            if (["yes", "done", "paid", "ok", "sent"].some(w => msg.includes(w))) {
                state.step = "form";

                return res.json({
                    reply: `Order ID: ${state.orderId}\n\nGreat! ✅\n\n📌 Fill the Contact Form on the website\n💸 Apply your coupon code for 10% cashback\n\n🧾 Our system will verify the payment automatically and send your invoice shortly.`
                });
            }

            return res.json({
                reply: "Please complete the payment and confirm by typing 'done' here."
            });
        }

        // FINAL FORM SUBMIT STEP
        if (state.step === "form") {
            if (message !== "FORM_SUBMITTED") {
                return res.json({
                    reply: "Please submit the Contact Form on the website to finalize your order."
                });
            }

            state.step = "done";

            return res.json({
                reply: `Order ID: ${state.orderId}\n\nOrder Confirmed! ✅\n\n📂 Send your raw files as DOCUMENTS to begin:\n\nWhatsApp: +91 7602679995\nOR\nEmail: zyroeditz.official@gmail.com\n\n📞 Support:\nPHONE: +91 7602679995\nEMAIL: zyroeditz.official@gmail.com\nMon–Fri, 9 AM – 5 PM`,
                clearHistory: true 
            });
        }

        return res.json({
            reply: "Please choose a service from the options above to continue."
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server Error" });
    }
};
