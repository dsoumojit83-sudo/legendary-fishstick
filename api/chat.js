const OpenAI = require('openai');
const groq = new OpenAI({ 
    apiKey: process.env.GROQ_API_KEY, 
    baseURL: "https://api.groq.com/openai/v1" 
});

// LINK MAPPING FOR NON-DISCOUNTED USERS
const STANDARD_LINKS = {
    "thumbnail": "https://rzp.io/rzp/bHAbZoh",      // ₹100
    "motion_graphic": "https://rzp.io/rzp/kdE5KohQ", // ₹400
    "short_form": "https://rzp.io/rzp/YVxVRMgA",    // ₹200
    "long_form": "https://rzp.io/rzp/rK3UnkW"       // ₹500
};

// LINK MAPPING FOR DISCOUNTED USERS
const DISCOUNT_LINKS = {
    "thumbnail": "https://rzp.io/rzp/Vp5EEtkP",      // ₹50
    "motion_graphic": "https://rzp.io/rzp/vC6eCvWp", // ₹200
    "short_form": "https://rzp.io/rzp/NZSjgn4U",    // ₹100
    "long_form": "https://rzp.io/rzp/YVxVRMgA"      // ₹250
};

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    try {
        const { message: userMessage, clientId } = req.body;
        const isNewUser = clientId?.startsWith('NEW_');

        // Select correct link set and pricing based on user status
        const activeLinks = isNewUser ? DISCOUNT_LINKS : STANDARD_LINKS;
        
        // PRE-CALCULATED PRICING SHEET (Matches your provided links)
        const pricingData = isNewUser ? {
            status: "50% NEW CLIENT DISCOUNT APPLIED",
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
You are the ZyroEditz AI Sales Agent. Your goal is to pitch video editing services and close deals.
PRICING SHEET (USE THESE EXACT NUMBERS, DO NOT CALCULATE):
- Short Form (Reels/Shorts): ${pricingData.reels}
- Long Form (YouTube): ${pricingData.youtube}
- Motion Graphics: ${pricingData.motion}
- Thumbnail Design: ${pricingData.thumbnail}
Pricing Status: ${pricingData.status}

RULES:
1. Maximum 3 sentences per response. 
2. Never introduce yourself with robotic titles like "Elite Studio Manager." 
3. Pitch the service and ask: "Are you ready to secure your spot?"
4. ONLY if the user agrees, append one of these tags: [PAY_SHORT], [PAY_LONG], [PAY_MOTION], [PAY_THUMBNAIL].

MANDATORY OVERRIDES:
- If the user claims they filled out a form/email: "If your inquiry went through successfully, my automated system will alert me here. If you don't see a confirmation soon, please double-check that you hit send!"
- If the user provides a fake receipt or claims they paid: "Got it! I have logged this transaction. Zyro will manually verify the payment in our secure banking system before we begin."
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
        let paymentUrl = null;

        // Tag Interception using the contextually active links
        const tags = {
            "[PAY_THUMBNAIL]": activeLinks.thumbnail,
            "[PAY_LONG]": activeLinks.long_form,
            "[PAY_SHORT]": activeLinks.short_form,
            "[PAY_MOTION]": activeLinks.motion_graphic
        };

        for (const [tag, url] of Object.entries(tags)) {
            if (reply.includes(tag)) {
                paymentUrl = url;
                reply = reply.replace(tag, "").trim();
                break; // Stop after finding the first tag
            }
        }

        res.status(200).json({ reply, paymentUrl });
    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};
