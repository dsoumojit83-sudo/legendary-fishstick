// No libraries needed! Using standard fetch to stay "No-Install"
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

        // Pricing logic from your provided file
        const pricingData = isNewUser ? {
            status: "NEW CLIENT PROMO ACTIVE",
            reels: "₹100", youtube: "₹250", motion: "₹200", thumbnail: "₹50",
            pay: { short: 50, long: 125, motion: 100, thumb: 25 }
        } : {
            status: "STANDARD RATES",
            reels: "₹200", youtube: "₹500", motion: "₹400", thumbnail: "₹100",
            pay: { short: 100, long: 250, motion: 200, thumb: 50 }
        };

        const systemPrompt = `You are the AI Sales Agent for ZyroEditz. 
        CONTACT: WhatsApp +91 7602679995 or Email zyroeditz.official@gmail.com.
        PRICING: Reels (${pricingData.reels}), YT (${pricingData.youtube}), Motion (${pricingData.motion}), Thumbnails (${pricingData.thumbnail}).
        RULES: 1. Greet. 2. Pitch price/time. 3. If they say "yes/ok", use [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL]. 4. After "done", tell them to send raw files via WhatsApp/Email.`;

        // Prepare the payload for Gemini API
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${userMessage}` }] }]
            })
        });

        const data = await response.json();
        let reply = data.candidates[0].content.parts[0].text;

        // Payment Tag Interception
        let finalPaymentData = null;
        const upiMap = {
            "[PAY_SHORT]": generateUpiData(pricingData.pay.short),
            "[PAY_LONG]": generateUpiData(pricingData.pay.long),
            "[PAY_MOTION]": generateUpiData(pricingData.pay.motion),
            "[PAY_THUMBNAIL]": generateUpiData(pricingData.pay.thumb)
        };

        for (const [tag, payment] of Object.entries(upiMap)) {
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
        console.error("Error:", error);
        res.status(500).json({ error: "Check your GEMINI_API_KEY in Vercel settings." });
    }
};
