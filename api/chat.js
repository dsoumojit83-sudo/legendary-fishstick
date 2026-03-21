const OpenAI = require('openai');

// Initialize OpenAI client pointing to OpenRouter
const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY 
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

        const paymentData = isNewUser ? {             
            thumbnail: generateUpiData(25),             
            motion: generateUpiData(100),             
            short: generateUpiData(50),             
            long: generateUpiData(125)         
        } : {             
            thumbnail: generateUpiData(50),             
            motion: generateUpiData(200),             
            short: generateUpiData(100),             
            long: generateUpiData(250)         
        };          

        const pricingData = isNewUser ? {             
            reels: "₹100 (50% Promo) | Advance: ₹50",             
            youtube: "₹250 (50% Promo) | Advance: ₹125",             
            motion: "₹200 (50% Promo) | Advance: ₹100",             
            thumbnail: "₹50 (50% Promo) | Advance: ₹25"         
        } : {             
            reels: "₹200 | Advance: ₹100",             
            youtube: "₹500 | Advance: ₹250",             
            motion: "₹400 | Advance: ₹200",             
            thumbnail: "₹100 | Advance: ₹50"         
        };          

        const systemPrompt = `You are the AI Sales Agent for ZyroEditz. Professional and concise. 
        PRICING: Reels: ${pricingData.reels}, YouTube: ${pricingData.youtube}, Motion: ${pricingData.motion}, Thumbnails: ${pricingData.thumbnail}. 
        FLOW: Greet -> Pitch -> When they agree to pay, provide instructions and end with the tag: [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL].`;          

        if (!chatMemory[clientId]) {             
            chatMemory[clientId] = [{ role: 'system', content: systemPrompt }];         
        }          

        chatMemory[clientId].push({ role: 'user', content: userMessage });          

        // Calling the /auto router to guarantee uptime
        const completion = await openai.chat.completions.create({             
            model: 'openrouter/auto', 
            messages: chatMemory[clientId],             
            temperature: 0.1,             
            max_tokens: 300
        });          

        let reply = completion.choices[0].message.content;
        let finalPaymentData = null;          
        
        const tags = {             
            "[PAY_THUMBNAIL]": paymentData.thumbnail,             
            "[PAY_LONG]": paymentData.long,             
            "[PAY_SHORT]": paymentData.short,             
            "[PAY_MOTION]": paymentData.motion         
        };          

        for (const [tag, data] of Object.entries(tags)) {             
            if (reply.includes(tag)) {                 
                finalPaymentData = data;                 
                reply = reply.replace(tag, "options below! 👇").trim();                 
                break;             
            }         
        }          

        chatMemory[clientId].push({ role: 'assistant', content: reply });          
        if (chatMemory[clientId].length > 10) chatMemory[clientId].splice(1, 2);

        res.status(200).json({             
            reply,             
            paymentUrl: finalPaymentData?.upiString || null,             
            qrUrl: finalPaymentData?.qrUrl || null         
        });     
    } catch (error) {         
        console.error("Auto-Router Error:", error);         
        res.status(500).json({ error: "Internal Server Error" });     
    } 
};
