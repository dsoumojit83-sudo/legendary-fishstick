// No 'require' needed for AI libraries! We use the built-in 'fetch'
const chatMemory = {};

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

        // Pricing logic for ZyroEditz
        const pricing = isNewUser ? {
            reels: "₹100", youtube: "₹250", motion: "₹200", thumbnail: "₹50",
            adv: { short: 50, long: 125, motion: 100, thumb: 25 }
        } : {
            reels: "₹200", youtube: "₹500", motion: "₹400", thumbnail: "₹100",
            adv: { short: 100, long: 250, motion: 200, thumb: 50 }
        };

        const systemPrompt = `You are the AI for ZyroEditz. 
        CONTACT: WhatsApp +91 7602679995 or Email zyroeditz.official@gmail.com.
        PRICING: Reels (${pricing.reels}), YT (${pricing.youtube}), Motion (${pricing.motion}), Thumbnails (${pricing.thumbnail}).
        RULES: 50% advance to start. Use [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL] only if they agree to pay.`;

        // The URL using your GEMINI_API_KEY environment variable
        const apiKey = process.env.GEMINI_API_KEY;
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${userMessage}` }] }]
            })
        });

        const data = await response.json();
        
        // Error handling if the API Key is missing or invalid
        if (data.error) {
            return res.status(500).json({ error: "Gemini API Error", details: data.error.message });
        }

        let reply = data.candidates[0].content.parts[0].text;

        // Map tags to UPI data
        let finalPaymentData = null;
        const tags = {
            "[PAY_SHORT]": generateUpiData(pricing.adv.short),
            "[PAY_LONG]": generateUpiData(pricing.adv.long),
            "[PAY_MOTION]": generateUpiData(pricing.adv.motion),
            "[PAY_THUMBNAIL]": generateUpiData(pricing.adv.thumb)
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
        console.error("Server Error:", error);
        res.status(500).json({ error: "Check Vercel Environment Variables for GEMINI_API_KEY" });
    }
};
