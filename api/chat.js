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
    const note = "ZyroEditz Advance Payment";            

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
        const msg = message.toLowerCase();

        const isNewUser = clientId.startsWith("NEW_");

        const pricing = isNewUser ? {
            short: { full: 100, adv: 50 },
            long: { full: 250, adv: 125 },
            motion: { full: 200, adv: 100 },
            thumbnail: { full: 50, adv: 25 },
            sound: { full: 100, adv: 50 },
            color: { full: 88, adv: 44 }
        } : {
            short: { full: 200, adv: 100 },
            long: { full: 500, adv: 250 },
            motion: { full: 400, adv: 200 },
            thumbnail: { full: 100, adv: 50 },
            sound: { full: 200, adv: 100 },
            color: { full: 175, adv: 88 }
        };

        if (!userState[clientId]) {
            userState[clientId] = {
                step: "start",
                service: null,
                orderId: generateOrderId()
            };
        }

        const state = userState[clientId];

        // FINAL LOCK
        if (state.step === "done") {
            return res.json({ reply: "" });
        }

        // EXIT INTENT
        if (["no", "cancel", "don't", "dont", "not interested"].some(w => msg.includes(w))) {
            state.step = "done";
            return res.json({
                reply: `I’m a bit sad we couldn’t create something this time 😔  
Feel free to come back anytime when you're ready.`
            });
        }

        // STEP 1
        if (state.step === "start") {
            state.step = "select";

            return res.json({
                reply: `Hey! 👋 What service do you need?

• Short Form  
• Long Form  
• Motion Graphics  
• Thumbnails  
• Sound Design  
• Color Correction & Grade`
            });
        }

        // STEP 2
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
                    reply: `Order ID: ${state.orderId}

You've selected *${name}* 🎯

💰 Price: ₹${data.full}
💳 Advance: ₹${data.adv}

${isNewUser ? "🎉 New user discount applied\n" : ""}

⏱ Delivery:
• Thumbnails – Same day  
• Others – 24–48 hours  

🔁 One revision allowed  

Type "pay" to proceed.`
                });
            }
        }

        // STEP 3 PAYMENT
        if (state.step === "confirm" && msg.includes("pay")) {

            state.step = "payment_pending";

            const data = pricing[state.service];
            const payment = generateUpiData(data.adv);

            return res.json({
                reply: `Order ID: ${state.orderId}

Pay ₹${data.adv} advance 👇

After payment, confirm here.`,
                paymentUrl: payment.upiString,
                qrUrl: payment.qrUrl
            });
        }

        // CONFIRM PAYMENT
        if (state.step === "payment_pending") {

            if (["yes", "done", "paid"].some(w => msg.includes(w))) {
                state.step = "form";

                return res.json({
                    reply: `Order ID: ${state.orderId}

Great! ✅

📌 Fill the Contact Form  
📸 Attach payment screenshot  
🎟 Apply referral code (10% off on remaining)

🧾 Invoice will be sent to your email shortly.`
                });
            }

            return res.json({
                reply: "Please complete the payment and confirm here."
            });
        }

        // FORM LOOP
        if (state.step === "form") {
            if (message !== "FORM_SUBMITTED") {
                return res.json({
                    reply: "Please submit the form to continue the process."
                });
            }

            state.step = "upload";

            return res.json({
                reply: `Order ID: ${state.orderId}

Great! ✅

📂 Send raw files as DOCUMENTS:

WhatsApp: 7602679995  
OR  
Email: zyroeditz.official@gmail.com  

💰 Pay remaining amount  
📸 Attach payment screenshot  

📞 Support:
Mon–Fri, 9 AM – 5 PM`
            });
        }

        // FINAL STEP
        if (state.step === "upload") {
            state.step = "done";

            return res.json({
                reply: `Order ID: ${state.orderId}

Thank you for choosing us 🙌  
We appreciate your patience.`
            });
        }

        return res.json({ reply: "Please follow the steps." });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server Error" });
    }
};
