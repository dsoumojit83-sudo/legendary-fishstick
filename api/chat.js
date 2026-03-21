const OpenAI = require('openai');

const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY 
});

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

        const pricingData = isNewUser ? {             
            reels: "₹100 (50% Off) | Advance: ₹50", youtube: "₹250 (50% Off) | Advance: ₹125",             
            motion: "₹200 (50% Off) | Advance: ₹100", thumbnail: "₹50 (50% Off) | Advance: ₹25"         
        } : {             
            reels: "₹200 | Advance: ₹100", youtube: "₹500 | Advance: ₹250",             
            motion: "₹400 | Advance: ₹200", thumbnail: "₹100 | Advance: ₹50"         
        };          

        const systemPrompt = `You are the AI Sales Agent for ZyroEditz. Be concise (max 2 sentences).
        PRICING: Reels: ${pricingData.reels}, YouTube: ${pricingData.youtube}, Motion: ${pricingData.motion}, Thumbnails: ${pricingData.thumbnail}. 

        ONBOARDING STEPS (ONLY say this after they say "done/paid/what next"):
        "Upload your screenshot to the Contact Form. Send raw files as DOCUMENTS to WhatsApp: 7602679995 AND Email: zyroeditz@gmail.com."

        TERMS & CONDITIONS:
        - Delivery: Reels (24h), YouTube/Motion (48h), Thumbnails (Same day).
        - Revisions: One-time revision allowed (state all changes at once).
        - Final Payment: Remaining 50% is due after you approve the prototype.

        STRICT RULES:
        1. Once they say "done", "paid", or "what next", switch to ONBOARDING mode and mention the TERMS.
        2. If they ask anything after onboarding, say: "For further queries, contact us directly on WhatsApp at 7602679995."`;          

        if (!chatMemory[clientId]) {             
            chatMemory[clientId] = [{ role: 'system', content: systemPrompt }];         
        } else {
            chatMemory[clientId][0] = { role: 'system', content: systemPrompt };
        }

        chatMemory[clientId].push({ role: 'user', content: userMessage });          

        const completion = await groq.chat.completions.create({             
            model: 'llama-3.3-70b-versatile', 
            messages: chatMemory[clientId],             
            temperature: 0.1,             
            max_tokens: 150 
        });          

        let reply = completion.choices[0].message.content;
        let finalPaymentData = null;          
        
        const amounts = isNewUser ? { short: 50, long: 125, motion: 100, thumb: 25 } : { short: 100, long: 250, motion: 200, thumb: 50 };
        const tags = {             
            "[PAY_THUMBNAIL]": amounts.thumb, "[PAY_LONG]": amounts.long,             
            "[PAY_SHORT]": amounts.short, "[PAY_MOTION]": amounts.motion         
        };          

        for (const [tag, amt] of Object.entries(tags)) {             
            if (reply.includes(tag)) {                 
                finalPaymentData = generateUpiData(amt);                 
                reply = reply.replace(tag, "options below! 👇").trim();                 
                break;             
            }         
        }          

        chatMemory[clientId].push({ role: 'assistant', content: reply });          
        if (chatMemory[clientId].length > 6) chatMemory[clientId].splice(1, 2);

        res.status(200).json({             
            reply,             
            paymentUrl: finalPaymentData?.upiString || null,             
            qrUrl: finalPaymentData?.qrUrl || null         
        });     
    } catch (error) {         
        console.error("Groq Error:", error);
        res.status(500).json({ error: "Internal Server Error" });     
    } 
};
