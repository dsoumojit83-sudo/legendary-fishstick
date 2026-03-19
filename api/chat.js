const OpenAI = require('openai');
const groq = new OpenAI({ 
    apiKey: process.env.GROQ_API_KEY, 
    baseURL: "https://api.groq.com/openai/v1" 
});

// HELPER: Generates both the clickable UPI link and a scannable QR code image URL
const generateUpiData = (amount) => {
    const upiId = "7602679995-5@ybl";
    const name = "Soumojit Das"; 
    const transactionNote = "ZyroEditz Payment - Indusind Bank";
    
    // encodeURIComponent ensures spaces in your name and note don't break the link
    const upiString = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&tn=${encodeURIComponent(transactionNote)}&am=${amount}&cu=INR`;
    
    // Uses a free, fast API to instantly generate a 250x250 QR code from the UPI string
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiString)}`;
    
    return { upiString, qrUrl };
};

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    try {
        const { message: userMessage, clientId } = req.body;
        const isNewUser = clientId?.startsWith('NEW_');

        // THE BRAIN: Dynamic UPI Links & QR Codes based on User Status
        const paymentData = isNewUser ? {
            thumbnail: generateUpiData(50),
            motion: generateUpiData(200),
            short: generateUpiData(100),
            long: generateUpiData(250)
        } : {
            thumbnail: generateUpiData(100),
            motion: generateUpiData(400),
            short: generateUpiData(200),
            long: generateUpiData(500)
        };

        // PRE-CALCULATED PRICING SHEET (No-Math Rule)
        const pricingData = isNewUser ? {
            status: "NEW CLIENT PROMO ACTIVE (FINAL PRICES)",
            reels: "₹100",
            youtube: "₹250",
            motion: "₹200",
            thumbnail: "₹50"
        } : {
            status: "STANDARD RATES",
            reels: "₹200",
            youtube: "₹500",
            motion: "₹400",
            thumbnail: "₹100"
        };

        const systemPrompt = `
You are the AI Sales Agent for ZyroEditz. Your goal is to figure out what the client needs and close deals.
PRICING SHEET (THESE ARE FINAL PRICES, DO NOT DO ANY MATH):
- Short Form (Reels/Shorts): ${pricingData.reels}
- Long Form (YouTube): ${pricingData.youtube}
- Motion Graphics: ${pricingData.motion}
- Thumbnail Design: ${pricingData.thumbnail}
Client Status: ${pricingData.status}

CONVERSATION FLOW RULES:
1. IF the user just greets you (e.g., "Hi"): Greet them back and ask what kind of editing they are looking for. DO NOT pitch prices yet.
2. ONCE they tell you what they need: Pitch that specific service, give them the price, and ask: "Are you ready to secure your spot?"
3. ONLY if the user agrees to pay, append the correct tag: [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL].
4. Maximum 3 sentences per response. Never use robotic titles.

MANDATORY OVERRIDES:
- If the user claims they filled out a form/email: "If your inquiry went through successfully, my automated system will alert me here. If you don't see a confirmation soon, please double-check that you hit send!"
- If the user claims they paid: "Got it! I have logged this transaction. Zyro will manually verify the payment before we begin."
        `;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.2,
            max_tokens: 150,
        });

        let reply = chatCompletion.choices[0].message.content;
        let finalPaymentData = null;

        // Tag Interception: Maps the AI's tag to the correct UPI data
        const tags = {
            "[PAY_THUMBNAIL]": paymentData.thumbnail,
            "[PAY_LONG]": paymentData.long,
            "[PAY_SHORT]": paymentData.short,
            "[PAY_MOTION]": paymentData.motion
        };

        for (const [tag, data] of Object.entries(tags)) {
            if (reply.includes(tag)) {
                finalPaymentData = data;
                reply = reply.replace(tag, "").trim();
                break; // Ensure only one payment option is sent per interaction
            }
        }

        // Return the reply, the clickable link, AND the QR code image URL
        res.status(200).json({ 
            reply, 
            paymentUrl: finalPaymentData?.upiString || null,
            qrUrl: finalPaymentData?.qrUrl || null
        });

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};
