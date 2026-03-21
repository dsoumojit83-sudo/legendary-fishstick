const OpenAI = require('openai');

// Directly connecting to Groq Cloud using your GROQ_API_KEY
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY 
});

const chatMemory = {};  

// Helper to generate UPI links and QR codes
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

        // Define pricing and advance amounts
        const pricingData = isNewUser ? {             
            reels: "₹100 (50% Off) | Advance: ₹50", youtube: "₹250 (50% Off) | Advance: ₹125",             
            motion: "₹200 (50% Off) | Advance: ₹100", thumbnail: "₹50 (50% Off) | Advance: ₹25"         
        } : {             
            reels: "₹200 | Advance: ₹100", youtube: "₹500 | Advance: ₹250",             
            motion: "₹400 | Advance: ₹200", thumbnail: "₹100 | Advance: ₹50"         
        };          

        // IMPROVED SYSTEM PROMPT: Forces the AI to transition from Payment to Onboarding
        const systemPrompt = `You are the AI Sales Agent for ZyroEditz. Be ultra-concise (max 2 sentences).
        
        PRICING: Reels: ${pricingData.reels}, YouTube: ${pricingData.youtube}, Motion: ${pricingData.motion}, Thumbnails: ${pricingData.thumbnail}. 

        CONVERSATION FLOW:
        1. If they ask for a service, give the price and ask to secure the spot.
        2. If they agree to pay, provide the relevant tag: [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL].
        3. IMPORTANT: Once the user says "done", "paid", or "what next", STOP using payment tags. 
        4. ONBOARDING: After payment, tell them to upload the screenshot to the Contact Form and send raw files via WhatsApp as Documents.`;          

        if (!chatMemory[clientId]) {             
            chatMemory[clientId] = [{ role: 'system', content: systemPrompt }];         
        } else {
            // Refresh system prompt in case of price/logic updates
            chatMemory[clientId][0] = { role: 'system', content: systemPrompt };
        }

        chatMemory[clientId].push({ role: 'user', content: userMessage });          

        // MEMORY OPTIMIZATION for 100+ clients/day: Keep only recent context to save tokens
        if (chatMemory[clientId].length > 5) {             
            chatMemory[clientId].splice(1, 2);         
        }          

        const completion = await groq.chat.completions.create({             
            model: 'llama-3.3-70b-versatile', 
            messages: chatMemory[clientId],             
            temperature: 0.1,             
            max_tokens: 150 
        });          

        let reply = completion.choices[0].message.content;
        let finalPaymentData = null;          
        
        // Match response tags to payment data
        const amounts = isNewUser ? { short: 50, long: 125, motion: 100, thumb: 25 } : { short: 100, long: 250, motion: 200, thumb: 50 };
        const tags = {             
            "[PAY_THUMBNAIL]": amounts.thumb,             
            "[PAY_LONG]": amounts.long,             
            "[PAY_SHORT]": amounts.short,             
            "[PAY_MOTION]": amounts.motion         
        };          

        for (const [tag, amt] of Object.entries(tags)) {             
            if (reply.includes(tag)) {                 
                finalPaymentData = generateUpiData(amt);                 
                reply = reply.replace(tag, "options below! 👇").trim();                 
                break;             
            }         
        }          

        chatMemory[clientId].push({ role: 'assistant', content: reply });          

        res.status(200).json({             
            reply,             
            paymentUrl: finalPaymentData?.upiString || null,             
            qrUrl: finalPaymentData?.qrUrl || null         
        });     
    } catch (error) {         
        console.error("Groq Cloud Error:", error);
        if (error.status === 429) {
            return res.status(200).json({ 
                reply: "We are currently experiencing high traffic. Please try again in a minute or message us on WhatsApp!",
                paymentUrl: null, qrUrl: null
            });
        }
        res.status(500).json({ error: "Internal Server Error" });     
    } 
};
