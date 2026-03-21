const OpenAI = require('openai');

const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY 
});

const userState = {};

// UPI generator
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

        // Pricing
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

        // Init state
        if (!userState[clientId]) {
            userState[clientId] = {
                step: "start",
                service: null
            };
        }

        const state = userState[clientId];

        // ---------------- FINAL LOCK ----------------
        if (state.step === "done") {
            return res.json({ reply: "" }); // no reply after final
        }

        // ---------------- STEP 1: OPTIONS ----------------
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

        // ---------------- STEP 2: SELECTION ----------------
        if (state.step === "select") {

            if (msg.includes("short")) state.service = "short";
            else if (msg.includes("long")) state.service = "long";
            else if (msg.includes("motion")) state.service = "motion";
            else if (msg.includes("thumbnail")) state.service = "thumbnail";
            else if (msg.includes("sound")) state.service = "sound";
            else if (msg.includes("color") || msg.includes("grade")) state.service = "color";

            if (state.service) {
                const data = pricing[state.service];
                state.step = "confirm";

                return res.json({
                    reply: `You've selected *${state.service}* 🎯

💰 Price: ₹${data.full}
💳 Advance: ₹${data.adv}

${isNewUser ? "🎉 New user discount applied!\n" : ""}

⏱ Delivery:
• Thumbnails – Same day  
• Others – 24–48 hours  

🔁 One revision allowed  

Type "pay" to proceed.`
                });
            }
        }

        // ---------------- STEP 3: PAYMENT ----------------
        if (state.step === "confirm" && msg.includes("pay")) {

            state.step = "form";

            const data = pricing[state.service];
            const payment = generateUpiData(data.adv);

            return res.json({
                reply: `Pay ₹${data.adv} advance 👇

After payment:

📌 Fill the Contact Form  
📸 Attach payment screenshot  
🎟 Apply referral code (10% off on remaining)

🧾 Bill will be sent to your email shortly.`,
                paymentUrl: payment.upiString,
                qrUrl: payment.qrUrl
            });
        }

        // ---------------- STEP 3 LOCK ----------------
        if (state.step === "form") {
            if (!msg.includes("submitted")) {
                return res.json({
                    reply: "Please submit the form to continue the process."
                });
            }

            state.step = "upload";

            return res.json({
                reply: `Great! ✅

📂 Send your raw files as DOCUMENTS:

WhatsApp: 7602679995  
OR  
Email: zyroeditz.official@gmail.com  

💰 Pay remaining amount by selecting remaining payment option  
📸 Attach payment screenshot  

📞 Need help?  
Call/Email (Mon–Fri, 9 AM – 5 PM)`
            });
        }

        // ---------------- STEP 5 FINAL ----------------
        if (state.step === "upload") {
            state.step = "done";

            return res.json({
                reply: `Thank you for choosing us to serve you 🙌  
We appreciate your patience.`
            });
        }

        return res.json({ reply: "Please follow the steps." });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Server Error" });
    }
};
