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
        const msg = message.toLowerCase().trim();

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

        // 🛠 MEMORY WIPE & RESTART: If they finished an order and come back to chat again later
        if (state.step === "done" && message !== "FINAL_PAYMENT_DONE") {
            state.step = "start";
            state.service = null;
            state.orderId = generateOrderId();
            
            // Sends the clearHistory flag to the frontend to wipe the local storage
            return res.json({
                reply: `Hey! 👋 What kind of project can I help you with today? We handle Video Editing, Thumbnails, Motion Graphics, and Sound Design!\n\n• Short Form\n• Long Form\n• Motion Graphics\n• Thumbnails\n• Sound Design\n• Color Correction & Grade`,
                clearHistory: true
            });
        }

        // 🔥 SECURITY LOCK: Final Payment can ONLY be triggered if they are in the "upload" step
        if (message === "FINAL_PAYMENT_DONE") {
            if (state.step === "upload") {
                state.step = "done";
                return res.json({
                    reply: `Order ID: ${state.orderId}\n\nThanks for fulfilling the payment and giving us a chance to serve you 🙌\n\nYour final bill will be emailed shortly.`,
                    clearHistory: true // Wipes their chat so they can start a new order next time
                });
            } else {
                return res.json({
                    reply: "You can only submit a remaining payment for an active order that is currently in progress."
                });
            }
        }

        // FINAL LOCK (Bot stays silent if order is complete and they haven't said a new greeting yet)
        if (state.step === "done") {
            return res.json({ reply: "" });
        }

        // EXIT INTENT (Prevent cancelling if they are currently uploading files or paying)
        if (["no", "cancel", "don't", "dont", "not interested", "stop"].some(w => msg.includes(w)) && state.step !== "upload" && state.step !== "form") {
            state.step = "done";
            return res.json({
                reply: `I’m a bit sad we couldn’t create something this time 😔\nFeel free to come back anytime when you're ready.`,
                clearHistory: true
            });
        }

        // STEP 1
        if (state.step === "start") {
            state.step = "select";

            return res.json({
                reply: `Hey! 👋 What service do you need?\n\n• Short Form\n• Long Form\n• Motion Graphics\n• Thumbnails\n• Sound Design\n• Color Correction & Grade`
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
                    reply: `Order ID: ${state.orderId}\n\nYou've selected *${name}* 🎯\n\n💰 Price: ₹${data.full}\n💳 Advance: ₹${data.adv}\n\n${isNewUser ? "🎉 New user discount applied\n\n" : ""}⏱ Delivery:\n• Thumbnails – Same day\n• Others – 24–48 hours\n\n🔁 One revision allowed\n\nType "pay" to proceed.`
                });
            }

            return res.json({
                reply: "Please choose a service from the options above to continue."
            });
        }

        // STEP 3: STRICT "PAY" TRIGGER ONLY
        if (state.step === "confirm" && msg.includes("pay")) {

            state.step = "payment_pending";

            const data = pricing[state.service];
            const payment = generateUpiData(data.adv);

            return res.json({
                reply: `Order ID: ${state.orderId}\n\nPay ₹${data.adv} advance 👇\n\nAfter payment, please type "done" or "paid" here.`,
                paymentUrl: payment.upiString,
                qrUrl: payment.qrUrl
            });
        } else if (state.step === "confirm") {
            return res.json({ reply: 'To secure your spot and generate the payment QR, please type "pay".' });
        }

        // PAYMENT CONFIRM
        if (state.step === "payment_pending") {

            if (["yes", "done", "paid", "ok", "sent"].some(w => msg.includes(w))) {
                state.step = "form";

                return res.json({
                    reply: `Order ID: ${state.orderId}\n\nGreat! ✅\n\n📌 Fill the Contact Form on the website\n📸 Attach payment screenshot\n🎟 Apply referral code (10% off on remaining payment)\n\n🧾 Invoice will be sent to your email shortly.`
                });
            }

            return res.json({
                reply: "Please complete the payment and confirm by typing 'done' here."
            });
        }

        // FORM LOOP
        if (state.step === "form") {
            if (message !== "FORM_SUBMITTED") {
                return res.json({
                    reply: "Please submit the Contact Form on the website to continue the process."
                });
            }

            state.step = "upload";

            return res.json({
                reply: `Order ID: ${state.orderId}\n\nGreat! ✅\n\n📂 Send your raw files as DOCUMENTS:\n\nWhatsApp: 7602679995\nOR\nEmail: zyroeditz.official@gmail.com\n\n💰 When the project is complete, you can pay the remaining amount using the form's "Remaining Payment" option.\n\n📞 Support:\nPHONE: +917602679995\nEMAIL: zyroeditz.official@gmail.com\nMon–Fri, 9 AM – 5 PM`
            });
        }

        // STEP FINAL BEFORE PAYMENT COMPLETE
        if (state.step === "upload") {
            if (message === "FORM_SUBMITTED") return res.json({ reply: "You've already submitted the details. Send your raw files to WhatsApp!" });
            return res.json({
                reply: "Your order is in progress! 🎬\n\nWhen you're ready to make the final payment, please select 'Remaining Payment' in the Contact Form."
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
