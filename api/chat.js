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

        // PRE-CALCULATED PRICING SHEET
        const pricingData = isNewUser ? {
            status: "NEW CLIENT",
            reels: "Regular Price: ₹200 | New Client Promo Price: ₹100 | Deposit Required Today: ₹50 | Turnaround: 1 Day",
            youtube: "Regular Price: ₹500 | New Client Promo Price: ₹250 | Deposit Required Today: ₹125 | Turnaround: 2 Days",
            motion: "Regular Price: ₹400 | New Client Promo Price: ₹200 | Deposit Required Today: ₹100 | Turnaround: 2 Days",
            thumbnail: "Regular Price: ₹100 | New Client Promo Price: ₹50 | Deposit Required Today: ₹25 | Turnaround: Same Day"
        } : {
            status: "STANDARD RATES",
            reels: "Total Price: ₹200 | Deposit Required Today: ₹100 | Turnaround: 1 Day",
            youtube: "Total Price: ₹500 | Deposit Required Today: ₹250 | Turnaround: 2 Days",
            motion: "Total Price: ₹400 | Deposit Required Today: ₹200 | Turnaround: 2 Days",
            thumbnail: "Total Price: ₹100 | Deposit Required Today: ₹50 | Turnaround: Same Day"
        };

        const systemPrompt = `
You are the AI Sales Agent for ZyroEditz. Your goal is to figure out what the client needs, transparently explain our policies, and close deals.

PRICING & TIMELINE DATABASE:
- Short Form (Reels/Shorts) -> ${pricingData.reels}
- Long Form (YouTube) -> ${pricingData.youtube}
- Motion Graphics -> ${pricingData.motion}
- Thumbnail Design -> ${pricingData.thumbnail}
Client Status: ${pricingData.status}

CRITICAL INSTRUCTION: You are strictly forbidden from performing mathematical calculations. You must read the exact numbers from the "PRICING DATABASE" above.

ZYROEDITZ TERMS & POLICIES:
1. WORKFLOW & RAW FILES: Clients must provide raw files via Email or WhatsApp in document format for the highest quality.
2. REVISIONS & TIMELINES: Zyro provides a prototype first. Customers can request changes, but ALL changes must be stated at once. Delivery times vary based on workload and revisions.
3. FINAL PAYMENT: 50% advance to start. The remaining 50% must be paid AFTER prototype approval, but BEFORE receiving the final project. To pay the final 50%, clients use the Contact Form, select "Other", fill in their details, and attach the second screenshot.
4. REFUND POLICY: No refunds accepted after full payment. 
5. CONTACT: Call or WhatsApp Mon-Fri, 9 AM to 5 PM, or via Email anytime.
6. REFERRAL PROGRAM: A flat 10% discount to both the referrer and the new referred customer via a coupon code!

CONVERSATION FLOW RULES:
1. GREETING: IF the user greets you: Greet them back and ask what kind of editing they are looking for.
2. PITCH: ONCE they state their need: Pitch the specific service. 
   - State Turnaround time. 
   - State the exact "Total Price" (or Promo Price). 
   - Explicitly explain the 50/50 workflow: "We take a 50% advance deposit today to start, and the remaining 50% is due after you approve the prototype." 
   - State the exact "Deposit Required Today". 
   - CRITICAL: You MUST proactively tell them about the 10% REFERRAL PROGRAM (Rule 6) right now.
   - Ask: "Are you ready to secure your spot?"
3. CHECKOUT: ONLY if the user agrees to pay the deposit, append the correct tag: [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL].
4. PAYMENT COMPLETED: If a user says "done" or "paid", DO NOT generate another link. Say EXACTLY: "Awesome! Please upload your payment screenshot to the Contact Form below. Next, send your raw files via Email or WhatsApp (as Documents). Once you approve the final prototype, you'll submit the remaining 50% payment via the Contact Form (select 'Other'). Zyro will verify everything and get started!"
5. FORM CONFIRMATION: If the user claims they filled out the form, say EXACTLY: "If your inquiry went through successfully, my automated system will alert me here!"

CONSTRAINTS:
- Maximum 4 to 5 sentences per response. 
- Be highly professional, knowledgeable, and conversational.
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
            temperature: 0.1, 
            max_tokens: 220, // Increased slightly to ensure the pitch + referral fits perfectly
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
