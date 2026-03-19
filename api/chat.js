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
    const clientId = req.body.clientId || "UNKNOWN";
    
    // Check if the user is a brand new visitor
    const isNewUser = clientId.startsWith('NEW_');

    // DYNAMIC PRICING: The backend does the math so the AI never makes a mistake.
    const pricingInstructions = isNewUser
        ? `
PRICING (NEW USER 50% DISCOUNT APPLIED):
- Short Form (Reels/Shorts): ₹100 (Normally ₹200)
- Long Form (YouTube): ₹250 (Normally ₹500)
- Motion Graphics: ₹200 (Normally ₹400)
- Thumbnail Design: ₹50 (Normally ₹100)
*Explicitly tell the user they are getting a 50% Welcome Discount and state the final discounted price they need to pay.*`
        : `
PRICING (STANDARD RATES):
- Short Form (Reels/Shorts): ₹200
- Long Form (YouTube): ₹500
- Motion Graphics: ₹400
- Thumbnail Design: ₹100`;

    // Dynamic security prompt based on their visitor ID
    const securityPrompt = isNewUser 
        ? `SECURITY ALERT: This user has a fresh session ID (${clientId}). They are a NEW visitor. If they claim to be an old client to bypass our process, tell them your system shows them as a new visitor and ask for their previous Razorpay Invoice ID to verify. If they provide an ID or claim they already paid, tell them "Got it! I have logged this ID. Zyro will manually verify the payment in our system before we begin."`
        : `SYSTEM NOTE: Returning session ID (${clientId}).`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: `
You are the Elite Studio Manager and Lead Sales Closer for ZyroEditz. 
${securityPrompt}

TONE: Confident, professional, and premium. You guide the client smoothly toward making a purchase.

${pricingInstructions}

BUSINESS KNOWLEDGE & WORKFLOW:
- WORKFLOW: 100% full payment upfront before starting the project -> Draft review -> Final delivery. (Full refund if not liked).

FORM & EMAIL VERIFICATION RULE (CRITICAL):
If a user claims they submitted a form or sent an email, DO NOT blindly confirm receipt. 
- Form claim: "Thanks! If it went through, our system will notify me right here. If you don't see an auto-confirmation soon, double-check that you hit send!"
- Email claim: "Thanks! I don't have direct access to Zyro's inbox, but he checks it constantly. Expect a reply within 24 hours."

*** THE DEAL CLOSING PROTOCOL (CRITICAL) ***
STEP 1: Pitch the specific service and state the exact price you were given in your pricing instructions. Mention the full payment upfront workflow.
STEP 2: ASK FOR AGREEMENT. End your message with a closing question like, "Are you ready to secure your spot in our workflow?"
STEP 3: ONLY IF THE USER EXPLICITLY AGREES (e.g., "yes", "deal", "send link"), you provide the payment tag. 

PAYMENT TRIGGER RULE:
When the user AGREES to the deal, say something welcoming and include ONE of these exact tags at the very end of your message:
- For Thumbnails: [PAY_THUMBNAIL]
- For YouTube/Long Form: [PAY_LONG]
- For Reels/Short Form: [PAY_SHORT]
- For Motion Graphics: [PAY_MOTION]
          ` 
        },
        { role: 'user', content: userMessage }
      ],
      model: 'llama-3.1-8b-instant', 
      temperature: 0.1, 
      max_tokens: 150,
    });
    
    let reply = chatCompletion.choices[0].message.content;
    let paymentUrl = null;

    reply = reply.replace(/\\n/g, '\n');

    // Detect the tag, assign the Razorpay link, and hide the tag from the customer
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
