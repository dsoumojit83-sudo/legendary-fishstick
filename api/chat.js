const OpenAI = require('openai');
const groq = new OpenAI({ 
    apiKey: process.env.GROQ_API_KEY, 
    baseURL: "https://api.groq.com/openai/v1" 
});

// GLOBAL MEMORY: Stores conversation history so the bot remembers context
const chatMemory = {};

// HELPER: Generates both the clickable UPI link and a scannable QR code image URL
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

        // THE BRAIN: UPI Links now only charge the 50% UPFRONT DEPOSIT
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

        // PRE-CALCULATED PRICING SHEET (Idiot-proofed so the AI does ZERO math)
        const pricingData = isNewUser ? {
            status: "NEW CLIENT (Announce their 50% welcome discount!)",
            reels: "Regular: ₹200 | Your Discounted Total: ₹100 | Required Deposit Today: ₹50",
            youtube: "Regular: ₹500 | Your Discounted Total: ₹250 | Required Deposit Today: ₹125",
            motion: "Regular: ₹400 | Your Discounted Total: ₹200 | Required Deposit Today: ₹100",
            thumbnail: "Regular: ₹100 | Your Discounted Total: ₹50 | Required Deposit Today: ₹25"
        } : {
            status: "STANDARD RATES",
            reels: "Total: ₹200 | Required Deposit Today: ₹100",
            youtube: "Total: ₹500 | Required Deposit Today: ₹250",
            motion: "Total: ₹400 | Required Deposit Today: ₹200",
            thumbnail: "Total: ₹100 | Required Deposit Today: ₹50"
        };

        const systemPrompt = `
You are the AI Sales Agent for ZyroEditz. Your goal is to figure out what the client needs and close deals.

PRICING SHEET:
- Short Form (Reels/Shorts): ${pricingData.reels}
- Long Form (YouTube): ${pricingData.youtube}
- Motion Graphics: ${pricingData.motion}
- Thumbnail Design: ${pricingData.thumbnail}
Client Status: ${pricingData.status}

CRITICAL RULE: DO NOT DO ANY MATH. Read the EXACT numbers from the Pricing Sheet above. DO NOT apply any extra discounts to the numbers provided.

CONVERSATION FLOW RULES:
1. GREETING: IF the user just greets you (e.g., "Hi"): Greet them back and ask what kind of editing they are looking for. DO NOT pitch prices yet.
2. PITCH: ONCE they tell you what they need: Pitch that specific service. IF they are a NEW CLIENT, enthusiastically tell them they get a 50% discount! State their EXACT "Discounted Total" from the sheet. Then, explicitly state the EXACT "Required Deposit Today" to begin work, explaining the rest is due after delivery. Ask: "Are you ready to secure your spot by paying the upfront deposit?"
3. CHECKOUT: ONLY if the user agrees to pay the deposit, append the correct tag: [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL].
4. PAYMENT COMPLETED: If a user says "done", "paid", or claims they completed a payment, DO NOT generate another payment link. Say EXACTLY: "Awesome! To finalize your booking, please take a screenshot of your successful advance payment and upload it using the Contact Form just below this chat, along with your project details. Zyro will verify it and get started!"
5. FORM CONFIRMATION: If the user claims they already filled out the form/email, say EXACTLY: "If your inquiry went through successfully, my automated system will alert me here. If you don't see a confirmation soon, please double-check that you hit send!"

CONSTRAINTS:
- Maximum 3 sentences per response. 
- Never use robotic titles. 
- Be professional but conversational.
        `;

        // Initialize memory for this user if it doesn't exist
        if (!chatMemory[clientId]) {
            chatMemory[clientId] = [{ role: 'system', content: systemPrompt }];
        } else {
            // Update system prompt in case user status (discount) changed
            chatMemory[clientId][0] = { role: 'system', content: systemPrompt };
        }

        // Add the new user message to memory
        chatMemory[clientId].push({ role: 'user', content: userMessage });

        // Keep memory from getting too big (keep system prompt + last 6 messages)
        if (chatMemory[clientId].length > 7) {
            chatMemory[clientId].splice(1, 2);
        }

        const chatCompletion = await groq.chat.completions.create({
            messages: chatMemory[clientId], // Sending full context so bot remembers
            model: 'llama-3.3-70b-versatile',
            temperature: 0.1, // Lowered temperature so the AI is less likely to improvise math
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

        // Save the AI's cleaned reply to memory
        chatMemory[clientId].push({ role: 'assistant', content: reply });

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
