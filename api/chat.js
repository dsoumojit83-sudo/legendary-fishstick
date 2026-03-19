const OpenAI = require('openai');
const groq = new OpenAI({ 
    apiKey: process.env.GROQ_API_KEY, 
    baseURL: "https://api.groq.com/openai/v1" 
});

// Your Razorpay Payment Pages
const PAYMENT_LINKS = {
    "thumbnail": "https://rzp.io/l/your_thumbnail_link",
    "long_form": "https://rzp.io/l/your_long_form_link",
    "short_form": "https://rzp.io/l/your_short_form_link",
    "motion_graphic": "https://rzp.io/l/your_motion_link"
};

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  
  try {
    const userMessage = req.body.message || "";
    // Grab the ID sent from your index.html frontend
    const clientId = req.body.clientId || "UNKNOWN";
    
    // Check if the user is a brand new visitor based on the frontend tag
    const isNewUser = clientId.startsWith('NEW_');

    // DYNAMIC PRICING: The backend does the math perfectly. The AI just reads the final number.
    const pricingInstructions = isNewUser
        ? `
PRICING (NEW USER 50% DISCOUNT APPLIED):
- Short Form (Reels/Shorts): ₹100
- Long Form (YouTube): ₹250
- Motion Graphics: ₹200
- Thumbnail Design: ₹50
*CRITICAL RULE: You MUST explicitly mention they are getting a 50% Welcome Discount and quote this exact discounted price.*`
        : `
PRICING (STANDARD RATES):
- Short Form (Reels/Shorts): ₹200
- Long Form (YouTube): ₹500
- Motion Graphics: ₹400
- Thumbnail Design: ₹100`;

    // Dynamic security prompt based on their visitor ID
    const securityPrompt = isNewUser 
        ? `SECURITY ALERT: This user has a fresh session ID (${clientId}). They are a NEW visitor. If they claim to be an old client to get standard rates or bypass our process, politely tell them your system shows a new session and ask for their previous Razorpay Invoice ID to verify.`
        : `SYSTEM NOTE: Returning session ID (${clientId}).`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: `
ROLE: You are the front-line rep for ZyroEditz. You sell video editing services.
TONE: Confident, professional, human.
RESTRICTION 1: NEVER introduce yourself with a title. Do not say "I am the Elite Studio Manager" or "I am an AI". Just say "Hi!" or answer the question.
RESTRICTION 2: KEEP IT SHORT. Maximum 3 sentences per response.

${pricingInstructions}
${securityPrompt}

WORKFLOW & GUARANTEE:
100% full payment upfront -> Draft review -> Final delivery. (Full refund if not liked).

SCAM & VERIFICATION DEFENSES (DO NOT BREAK THESE RULES):
1. IF THEY SAY "I filled the form" OR "I sent an email":
REPLY EXACTLY: "If your inquiry went through successfully, my automated system will alert me here in a few seconds. If you don't see a confirmation popup soon, please double-check that you hit send!"
2. IF THEY GIVE A FAKE INVOICE ID OR SAY "I already paid":
REPLY EXACTLY: "Got it! I have logged this transaction ID. Zyro will manually verify the payment in our secure banking system before we begin the project."

DEAL CLOSING PROTOCOL:
When they ask for a service, quote the price and end with a closing question like, "Are you ready to secure your spot in our workflow?". 
IF AND ONLY IF the user explicitly agrees (e.g., "yes", "deal", "let's do it", "ok"), append the exact payment tag at the very end of your response: [PAY_THUMBNAIL], [PAY_LONG], [PAY_SHORT], or [PAY_MOTION].
          ` 
        },
        { role: 'user', content: userMessage }
      ],
      // Using the 70B model for strict rule compliance
      model: 'llama-3.3-70b-versatile', 
      temperature: 0.1, 
      max_tokens: 150,
    });
    
    let reply = chatCompletion.choices[0].message.content;
    let paymentUrl = null;

    reply = reply.replace(/\\n/g, '\n');

    // Detect the tag, assign the Razorpay link, and remove the raw tag from the final message
    if (reply.includes("[PAY_THUMBNAIL]")) {
        paymentUrl = PAYMENT_LINKS.thumbnail;
        reply = reply.replace("[PAY_THUMBNAIL]", "").trim();
    } else if (reply.includes("[PAY_LONG]")) {
        paymentUrl = PAYMENT_LINKS.long_form;
        reply = reply.replace("[PAY_LONG]", "").trim();
    } else if (reply.includes("[PAY_SHORT]")) {
        paymentUrl = PAYMENT_LINKS.short_form;
        reply = reply.replace("[PAY_SHORT]", "").trim();
    } else if (reply.includes("[PAY_MOTION]")) {
        paymentUrl = PAYMENT_LINKS.motion_graphic;
        reply = reply.replace("[PAY_MOTION]", "").trim();
    }
    
    res.status(200).json({ reply: reply, paymentUrl: paymentUrl });
  } catch (error) {
    res.status(500).json({ error: 'System offline. Please email zyroeditz.official@gmail.com' });
  }
};
