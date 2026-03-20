const { GoogleGenAI } = require('@google/genai');

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const generateUpiData = (amount) => {
    const upiId = "7602679995-5@ybl";
    const name = "Soumojit Das"; 
    const transactionNote = "ZyroEditz 50% Advance Payment";
    const upiString = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&tn=${encodeURIComponent(transactionNote)}&am=${amount}&cu=INR`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiString)}`;
    return { upiString, qrUrl };
};

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    try {
        const { message: userMessage, clientId = "default_user" } = req.body;
        const isNewUser = clientId?.startsWith('NEW_');

        const pricing = isNewUser ? 
            { r: "100", y: "250", m: "200", t: "50", adv: { s: 50, l: 125, m: 100, t: 25 } } : 
            { r: "200", y: "500", m: "400", t: "100", adv: { s: 100, l: 250, m: 200, t: 50 } };

        const systemPrompt = `You are the AI for ZyroEditz. 
        Contact: WhatsApp +91 7602679995. 
        Prices: Reels (₹${pricing.r}), YT (₹${pricing.y}), Motion (₹${pricing.m}), Thumbnails (₹${pricing.t}). 
        Use tags [PAY_SHORT], [PAY_LONG], [PAY_MOTION], [PAY_THUMBNAIL] only if they agree to pay.`;

        // Using the new Gemini 3 Flash model (Stable & Free)
        const response = await genAI.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nUser: ${userMessage}` }] }]
        });

        let reply = response.text;

        let finalPaymentData = null;
        const tags = {
            "[PAY_SHORT]": generateUpiData(pricing.adv.s),
            "[PAY_LONG]": generateUpiData(pricing.adv.l),
            "[PAY_MOTION]": generateUpiData(pricing.adv.m),
            "[PAY_THUMBNAIL]": generateUpiData(pricing.adv.t)
        };

        for (const [tag, payment] of Object.entries(tags)) {
            if (reply.includes(tag)) {
                finalPaymentData = payment;
                reply = reply.replace(tag, "").trim();
                break;
            }
        }

        res.status(200).json({ 
            reply, 
            paymentUrl: finalPaymentData?.upiString || null, 
            qrUrl: finalPaymentData?.qrUrl || null 
        });

    } catch (error) {
        console.error("SDK Error:", error);
        res.status(500).json({ error: "Check GEMINI_API_KEY and Node version in Vercel." });
    }
};
