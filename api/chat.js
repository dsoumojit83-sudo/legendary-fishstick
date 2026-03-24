const OpenAI = require('openai');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// 1. Initialize Supabase Client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY 
});

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
                    customer_phone: "9999999999" 
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
        const { message, clientId = "default_user", stepOverride } = req.body;
        const msg = message.toLowerCase().trim();

        const pricing = {
            short: { full: 200 },
            long: { full: 500 },
            motion: { full: 400 },
            thumbnail: { full: 100 },
            sound: { full: 200 },
            color: { full: 175 }
        };

        // 2. Fetch or Create Client State in Database
        let { data: clientData, error: fetchError } = await supabase
            .from('client_states')
            .select('*')
            .eq('client_id', clientId)
            .single();

        // If the table doesn't exist yet, we fallback to memory, but try to use DB
        let state;
        if (fetchError || !clientData) {
            state = {
                client_id: clientId,
                step: "select",
                service: null,
                order_id: generateOrderId()
            };
            // Attempt to insert, ignore if it fails due to table missing
            await supabase.from('client_states').upsert(state).catch(()=>console.log("State save failed"));
        } else {
            state = clientData;
        }

        // Allow frontend to force a reset
        if (stepOverride === "select") {
            state.step = "select";
            state.service = null;
            state.order_id = generateOrderId();
            await supabase.from('client_states').upsert(state).catch(()=>{});
        }

        // MEMORY WIPE & RESTART
        if (state.step === "done") {
            state.step = "select";
            state.service = null;
            state.order_id = generateOrderId();
            await supabase.from('client_states').upsert(state).catch(()=>{});
            
            return res.json({
                reply: `Hey!👋 Zyro Assistant is here. What kind of project can I help you with today?\nJust type the service you need from the options below:\n• Short Form\n• Long Form\n• Motion Graphics\n• Thumbnails\n• Sound Design\n• Color Correction & Grade`,
                clearHistory: true,
                currentStep: state.step
            });
        }

        // EXIT INTENT
        if (["no", "cancel", "don't", "dont", "not interested", "stop"].some(w => msg.includes(w)) && state.step !== "form") {
            state.step = "done";
            await supabase.from('client_states').upsert(state).catch(()=>{});
            return res.json({
                reply: `I’m a bit sad we couldn’t create something this time 😔\nFeel free to come back anytime when you're ready.`,
                clearHistory: true,
                currentStep: state.step
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
                
                // 3. Save Order to Supabase Database
                await supabase.from('orders').upsert({
                    order_id: state.order_id,
                    client_id: clientId,
                    service: state.service,
                    amount: data.full,
                    status: 'pending'
                });

                await supabase.from('client_states').upsert(state).catch(()=>{});

                return res.json({
                    reply: `Order ID: ${state.order_id}\n\nYou've selected *${name}* 🎯\n\n💰 Total Price: ₹${data.full}\n*(Full payment required upfront. 100% refund if not satisfied)*\n🎁 *Apply coupon code on the website form for 10% cashback!*\n\n⏱ Delivery:\n• Thumbnails – Same day\n• Others – 24–48 hours\n\n🔁 Revisions included\n\nType "pay" to proceed.`,
                    currentStep: state.step
                });
            }

            return res.json({ reply: "Please choose a service from the options above to continue.", currentStep: state.step });
        }

        // STEP 2: STRICT "PAY" TRIGGER ONLY (CASHFREE INTEGRATED)
        if (state.step === "confirm" && msg.includes("pay")) {
            state.step = "payment_pending";
            await supabase.from('client_states').upsert(state).catch(()=>{});

            const data = pricing[state.service];
            const sessionId = await createCashfreeOrder(data.full, state.order_id, clientId);

            if (!sessionId) {
                return res.json({ reply: "⚠️ Payment gateway error. Please try again in a few seconds.", currentStep: state.step });
            }

            return res.json({
                reply: `Order ID: ${state.order_id}\n\nSecure payment link generated! Opening the professional checkout now... 👇\n\nAfter completing the payment, please type "done" or "paid" here.`,
                paymentSessionId: sessionId,
                currentStep: state.step
            });
        } else if (state.step === "confirm") {
            return res.json({ reply: 'To secure your spot and open the payment gateway, please type "pay".', currentStep: state.step });
        }

        // STEP 3: PAYMENT CONFIRM
        if (state.step === "payment_pending") {
            
            // NOTE: In a fully automated system, the webhook handles this state change.
            // But we keep this for the chatbot conversational flow.
            if (["yes", "done", "paid", "ok", "sent"].some(w => msg.includes(w))) {
                state.step = "form";
                await supabase.from('client_states').upsert(state).catch(()=>{});

                return res.json({
                    reply: `Order ID: ${state.order_id}\n\nGreat! ✅\n\n📌 Fill the Contact Form on the website\n💸 Apply your coupon code for 10% cashback\n\n🧾 Our system will verify the payment automatically and send your invoice shortly.`,
                    currentStep: state.step
                });
            }

            return res.json({ reply: "Please complete the payment and confirm by typing 'done' here.", currentStep: state.step });
        }

        // FINAL FORM SUBMIT STEP
        if (state.step === "form") {
            if (message !== "FORM_SUBMITTED") {
                return res.json({ reply: "Please submit the Contact Form on the website to finalize your order.", currentStep: state.step });
            }

            state.step = "done";
            await supabase.from('client_states').upsert(state).catch(()=>{});

            return res.json({
                reply: `Order ID: ${state.order_id}\n\nOrder Confirmed! ✅\n\n📂 Send your raw files as DOCUMENTS to begin:\n\nWhatsApp: +91 7602679995\nOR\nEmail: zyroeditz.official@gmail.com\n\n📞 Support:\nPHONE: +91 7602679995\nEMAIL: zyroeditz.official@gmail.com\nMon–Fri, 9 AM – 5 PM`,
                clearHistory: true,
                currentStep: state.step
            });
        }

        return res.json({ reply: "Please choose a service from the options above to continue.", currentStep: state.step });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server Error" });
    }
};
