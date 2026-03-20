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

        const systemPrompt = `
You are the AI Sales Agent for ZyroEditz. You are highly intelligent, friendly, and professional. 
Talk to the user like a real human studio manager. Keep responses concise (under 4 sentences). DO NOT perform math, just read the exact numbers provided.

=== KNOWLEDGE BASE (ZYROEDITZ POLICIES) ===
Use this information to answer user questions, but do not dump it all at once:
- WORKFLOW & FILES: We take a 50% advance to start. Clients must send raw files via Email or WhatsApp as highest-quality Documents.
- PROTOTYPE & CHANGES: We deliver a prototype first. The client can request changes, but ALL changes must be stated at once. Final submission time may vary depending on workload and the changes requested.
- FINAL PAYMENT: The remaining 50% is paid AFTER the prototype is approved. The client goes to the Contact Form, selects "Other", fills in valid name/email, and attaches the final payment screenshot. We deliver the final video after full payment.
- REFUNDS: No refund requests are accepted after full payment.
- REFERRALS: We offer a flat 10% discount to anyone who refers a friend, AND the referred friend gets 10% off via a coupon code!
- CONTACT: Call or WhatsApp (Mon-Fri, 9am-5pm) or Email us anytime.

=== PRICING & TIMELINE ===
- Short Form (Reels/Shorts): ${pricingData.reels}
- Long Form (YouTube): ${pricingData.youtube}
- Motion Graphics: ${pricingData.motion}
- Thumbnail Design: ${pricingData.thumbnail}

=== CONVERSATION FLOW (Follow these steps strictly) ===
STEP 1 - GREETING: If they say hi, greet them and ask what kind of editing they need.
STEP 2 - THE PITCH: When they tell you what they need, give them the Total Price, the Turnaround Time, and the 50% Advance Deposit required today. Add a friendly reminder that they can get 10% off their next project by referring a friend! Ask: "Are you ready to secure your spot with the advance deposit?"
-> CRITICAL RULE: DO NOT generate the payment link yet. You are STRICTLY FORBIDDEN from using any [PAY] tags in this step. You MUST wait for the user to reply "yes" or "ok" first.
STEP 3 - THE PAYMENT: ONLY AFTER the user agrees to pay, append the correct tag to your message: [PAY_SHORT], [PAY_LONG], [PAY_MOTION], or [PAY_THUMBNAIL]. Tell them to scan the QR/UPI and type "done" when finished.
STEP 4 - ONBOARDING (When they say "done" or "paid"): DO NOT generate a payment link. Naturally explain the next steps: "Awesome! Please upload your payment screenshot to the Contact Form below. Next, send your raw files via Email or WhatsApp (as Documents). Once we send the prototype, you can request changes. After approval, you'll pay the final 50% via the Contact Form's 'Other' option to receive the final project!"
        `;

        if (!chatMemory[clientId]) {
            chatMemory[clientId] = [{ role: 'system', content: systemPrompt }];
        } else {
            chatMemory[clientId][0] = { role: 'system', content: systemPrompt };
        }

        chatMemory[clientId].push({ role: 'user', content: userMessage });

        if (chatMemory[clientId].length > 7) {
            chatMemory[clientId].splice(1, 2);
        }

        const chatCompletion = await groq.chat.completions.create({
            messages: chatMemory[clientId], 
            model: 'llama-3.3-70b-versatile',
            temperature: 0.1, // Lowered temperature slightly to enforce the strict rule obedience
            max_tokens: 200,
        });

        let reply = chatCompletion.choices[0].message.content;
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
                reply = reply.replace(tag, "").trim();
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
        console.error("Backend Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};
