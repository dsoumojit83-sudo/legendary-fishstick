// No dependencies needed. Works out of the box with Node 18+ on Vercel.
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

        // Professional Pricing Logic
        const pricing = isNewUser ? 
            { r: "₹100", y: "₹250", m: "₹200", t: "₹50", adv: { s: 50, l: 125, m: 100, t: 25 } } : 
            { r: "₹200", y: "₹500", m: "₹400", t: "₹100", adv: { s: 100, l: 250, m: 200, t: 50 } };

        const systemPrompt = `You are the AI Sales Agent for ZyroEditz. 
        Contact: WhatsApp +91 7602679995. 
        Pricing: Reels (${pricing.r}), YouTube (${pricing.y}), Motion Graphics (${pricing.m}), Thumbnails (${pricing.t}). 
        Rules: 50% advance required. Use [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL] tags only when they agree to pay.`;

        // FIXED URL: Using v1 stable and gemini-3-flash-preview
        const apiKey = process.env.GEMINI_API_KEY;
        const apiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${userMessage}` }] }]
            })
        });

        const data = await response.json();

        // Handle possible 404 or Key errors from Google
        if (data.error) {
            console.error("Gemini Error:", data.error);
            return res.status(data.error.code || 500).json({ error: data.error.message });
        }

        let reply = data.candidates[0].content.parts[0].text;

        // Payment Tag Logic
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
        console.error("Server Error:", error);
        res.status(500).json({ error: "Check your GEMINI_API_KEY in Vercel settings." });
    }
};
