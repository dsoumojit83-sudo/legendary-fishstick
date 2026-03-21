const OpenAI = require('openai');

// Connect to OpenRouter but look for the DEEPSEEK_API_KEY name!
const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.DEEPSEEK_API_KEY 
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
            reels: "Total Price: ₹100 (50% Promo Applied) | Advance Deposit: ₹50 | Turnaround: 1 Day",             
            youtube: "Total Price: ₹250 (50% Promo Applied) | Advance Deposit: ₹125 | Turnaround: 2 Days",             
            motion: "Total Price: ₹200 (50% Promo Applied) | Advance Deposit: ₹100 | Turnaround: 2 Days",             
            thumbnail: "Total Price: ₹50 (50% Promo Applied) | Advance Deposit: ₹25 | Turnaround: Same Day"         
        } : {             
            reels: "Total Price: ₹200 | Advance Deposit: ₹100 | Turnaround: 1 Day",             
            youtube: "Total Price: ₹500 | Advance Deposit: ₹250 | Turnaround: 2 Days",             
            motion: "Total Price: ₹400 | Advance Deposit: ₹200 | Turnaround: 2 Days",             
            thumbnail: "Total Price: ₹100 | Advance Deposit: ₹50 | Turnaround: Same Day"         
        };          

        const systemPrompt = `You are the AI Sales Agent for ZyroEditz. You are highly intelligent, friendly, and professional. Keep responses concise (under 4 sentences). DO NOT perform math.  

=== KNOWLEDGE BASE === 
- WORKFLOW & FILES: We take a 50% advance to start. Clients send raw files via Email/WhatsApp as Documents. 
- PROTOTYPE & CHANGES: We deliver a prototype. ALL changes must be stated at once. 
- FINAL PAYMENT: Remaining 50% is paid AFTER prototype approval. Client uses Contact Form's 'Remaining Payment' option. 
- REFERRALS: Flat 10% discount for referring a friend! Enter the code in the 'Referral Code' box in the form.

=== PRICING === 
- Short Form (Reels/Shorts): ${pricingData.reels} 
- Long Form (YouTube): ${pricingData.youtube} 
- Motion Graphics: ${pricingData.motion} 
- Thumbnail Design: ${pricingData.thumbnail}  

=== CONVERSATION FLOW (Follow strictly) === 
STEP 1 - GREETING: If they say hi, ask what editing they need. 
STEP 2 - PITCH: Give Total Price, Turnaround, and 50% Advance. Ask: "Are you ready to secure your spot?" 
STEP 3 - PAYMENT: ONLY AFTER they agree to pay, tell them to scan the QR/UPI and type "done". THEN, on a completely NEW BLANK LINE at the very end of your response, write the tag: [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL].
STEP 4 - ONBOARDING: When they say "done/paid", tell them: "Awesome! Please upload your payment screenshot to the Contact Form below. Next, send your raw files via Email or WhatsApp. Once we send the prototype, you can request changes. After approval, you'll pay the final 50% via the Contact Form's 'Remaining Payment' option."`;          

        if (!chatMemory[clientId]) {             
            chatMemory[clientId] = [{ role: 'system', content: systemPrompt }];         
        } else {             
            chatMemory[clientId][0] = { role: 'system', content: systemPrompt };         
        }          

        chatMemory[clientId].push({ role: 'user', content: userMessage });          

        if (chatMemory[clientId].length > 7) {             
            chatMemory[clientId].splice(1, 2);         
        }          

        // Connecting strictly to DeepSeek V3 (Chat) Free Node via OpenRouter
        const completion = await openai.chat.completions.create({             
            model: 'deepseek/deepseek-chat:free', 
            messages: chatMemory[clientId],             
            temperature: 0.1,             
            max_tokens: 250         
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

        res.status(200).json({             
            reply,             
            paymentUrl: finalPaymentData?.upiString || null,             
            qrUrl: finalPaymentData?.qrUrl || null         
        });     
        
    } catch (error) {         
        console.error("OpenRouter API Error:", error);
        
        // THE SAFETY NET: Catches 404 (Server Full), 402 (No Credits), and 429 (Rate Limit)
        if (error.status === 402 || error.status === 429 || error.status === 404) {
            return res.status(200).json({ 
                reply: "Our AI agent is currently assisting other clients. Please reach out to us via the contact form or WhatsApp so we can get your edit started.",
                paymentUrl: null, qrUrl: null
            });
        }
                 
        res.status(500).json({ error: "Internal Server Error" });     
    } 
};
