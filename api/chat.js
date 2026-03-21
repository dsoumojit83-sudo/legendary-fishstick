const OpenAI = require('openai');

const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY 
});

// Memory stores
const chatMemory = {};
const userState = {};

// UPI generator
const generateUpiData = (amount) => {     
    const upiId = "7602679995-5@ybl";     
    const name = "Soumojit Das";      
    const transactionNote = "ZyroEditz Advance Payment";            

    const upiString = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&tn=${encodeURIComponent(transactionNote)}&am=${amount}&cu=INR`;     
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiString)}`;          

    return { upiString, qrUrl }; 
};  

module.exports = async function(req, res) {     
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { message: userMessage, clientId = "default_user" } = req.body;
        const msg = userMessage.toLowerCase();

        const isNewUser = clientId?.startsWith('NEW_');

        // Pricing
        const pricingData = isNewUser ? {             
            reels: { full: 100, advance: 50 },
            youtube: { full: 250, advance: 125 },
            motion: { full: 200, advance: 100 },
            thumbnail: { full: 50, advance: 25 }
        } : {             
            reels: { full: 200, advance: 100 },
            youtube: { full: 500, advance: 250 },
            motion: { full: 400, advance: 200 },
            thumbnail: { full: 100, advance: 50 }
        };

        // Init state
        if (!userState[clientId]) {
            userState[clientId] = {
                step: "start",
                service: null
            };
        }

        const state = userState[clientId];

        // -----------------------------
        // 1. GREETING HANDLER
        // -----------------------------
        if (["hi", "hello", "hii", "hey"].some(w => msg.includes(w))) {
            return res.json({
                reply: "Hey! What service do you need? (Reels / YouTube / Motion / Thumbnails)"
            });
        }

        // -----------------------------
        // 2. PRICING REQUEST
        // -----------------------------
        if (msg.includes("price")) {
            return res.json({
                reply: `Pricing:\nReels ₹${pricingData.reels.full}\nYouTube ₹${pricingData.youtube.full}\nMotion ₹${pricingData.motion.full}\nThumbnails ₹${pricingData.thumbnail.full}`
            });
        }

        // -----------------------------
        // 3. SERVICE SELECTION
        // -----------------------------
        if (msg.includes("thumbnail")) {
            state.service = "thumbnail";
        } else if (msg.includes("reel")) {
            state.service = "reels";
        } else if (msg.includes("youtube")) {
            state.service = "youtube";
        } else if (msg.includes("motion")) {
            state.service = "motion";
        }

        if (state.service && state.step === "start") {
            state.step = "selected";

            const data = pricingData[state.service];

            return res.json({
                reply: `You've selected ${state.service}. Price ₹${data.full}, Advance ₹${data.advance}. Type "pay" to proceed.`
            });
        }

        // -----------------------------
        // 4. PAYMENT STEP
        // -----------------------------
        if (msg.includes("pay") && state.step === "selected") {
            state.step = "payment";

            const advanceAmount = pricingData[state.service].advance;
            const payment = generateUpiData(advanceAmount);

            return res.json({
                reply: `Pay ₹${advanceAmount} advance using the options below 👇`,
                paymentUrl: payment.upiString,
                qrUrl: payment.qrUrl
            });
        }

        // -----------------------------
        // 5. AFTER PAYMENT
        // -----------------------------
        if (
            ["done", "paid", "payment done", "what next"].some(w => msg.includes(w)) &&
            state.step === "payment"
        ) {
            state.step = "completed";

            return res.json({
                reply: `Upload your screenshot to the Contact Form. Send raw files as DOCUMENTS to WhatsApp: 7602679995 AND Email: zyroeditz@gmail.com.\n\nDelivery: Same day (Thumbnails) / 24–48h others.\nOne revision allowed.`
            });
        }

        // -----------------------------
        // 6. FALLBACK → AI RESPONSE
        // -----------------------------
        if (!chatMemory[clientId]) {
            chatMemory[clientId] = [
                {
                    role: "system",
                    content: `You are a friendly assistant for ZyroEditz. Keep replies under 2 sentences. Do not repeat pricing unless asked.`
                }
            ];
        }

        chatMemory[clientId].push({ role: "user", content: userMessage });

        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: chatMemory[clientId],
            temperature: 0.3,
            max_tokens: 100
        });

        const reply = completion.choices[0].message.content;

        chatMemory[clientId].push({ role: "assistant", content: reply });

        // Trim memory safely
        if (chatMemory[clientId].length > 10) {
            chatMemory[clientId] = [
                chatMemory[clientId][0],
                ...chatMemory[clientId].slice(-8)
            ];
        }

        return res.json({ reply });

    } catch (error) {
        console.error("Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
