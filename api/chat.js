const OpenAI = require('openai');

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

const generateUpiData = (amount) => {     
    const upiId = "7602679995-5@ybl";     
    const name = "Soumojit Das";      
    const note = "ZyroEditz Full Payment";            

    const upiString = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&tn=${encodeURIComponent(note)}&am=${amount}&cu=INR`;     
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiString)}`;          

    return { upiString, qrUrl }; 
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
                    reply: `Order ID: ${state.orderId}\n\nYou've selected *${name}* 🎯\n\n💰 Total Price: ₹${data.full}\n*(Full payment required upfront. 100% refund if not satisfied)*\n🎁 *Apply referral code on the website form for 10% cashback!*\n\n⏱ Delivery:\n• Thumbnails – Same day\n• Others – 24–48 hours\n\n🔁 Revisions included\n\nType "pay" to proceed.`
                });
            }

            // Fallback if they type something unrelated
            return res.json({
                reply: "Please choose a service from the options above to continue."
            });
        }

        // STEP 2: STRICT "PAY" TRIGGER ONLY
        if (state.step === "confirm" && msg.includes("pay")) {

            state.step = "payment_pending";

            const data = pricing[state.service];
            const payment = generateUpiData(data.full);

            return res.json({
                reply: `Order ID: ${state.orderId}\n\nPay the full upfront amount of ₹${data.full} 👇\n\nAfter payment, please type "done" or "paid" here.`,
                paymentUrl: payment.upiString,
                qrUrl: payment.qrUrl
            });
        } else if (state.step === "confirm") {
            return res.json({ reply: 'To secure your spot and generate the payment QR, please type "pay".' });
        }

        // STEP 3: PAYMENT CONFIRM
        if (state.step === "payment_pending") {

            if (["yes", "done", "paid", "ok", "sent"].some(w => msg.includes(w))) {
                state.step = "form";

                return res.json({
                    reply: `Order ID: ${state.orderId}\n\nGreat! ✅\n\n📌 Fill the Contact Form on the website\n💸 Apply your referral code for 10% cashback (sent to your original payment source in 2 business days)\n📸 Attach your full payment screenshot\n\n🧾 Invoice will be sent to your email shortly.`
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
