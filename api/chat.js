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

    // DYNAMIC PRICING
    const pricingInstructions = isNewUser
        ? `
PRICING (NEW USER 50% DISCOUNT):
- Short Form: ₹100
- Long Form: ₹250
- Motion Graphics: ₹200
- Thumbnail: ₹50
*Rule: Tell them they get a 50% welcome discount and quote this exact final price.*`
        : `
PRICING (STANDARD):
- Short Form: ₹200
- Long Form: ₹500
- Motion Graphics: ₹400
- Thumbnail: ₹100`;

    // Dynamic security prompt based on their visitor ID
    const securityPrompt = isNewUser 
        ? `SECURITY: This is a NEW user. Do not give them returning client privileges.`
        : `SECURITY: Returning user.`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: `
ROLE: You represent ZyroEditz. You sell video editing services.
TONE: Casual, professional, human. 
RESTRICTION 1: NEVER introduce yourself with a title. Do not say "I am the Elite Studio Manager". Just say "Hi!" or answer the question.
RESTRICTION 2: NEVER write more than 3 sentences. Keep it extremely short.

${pricingInstructions}
WORKFLOW: 100% upfront payment -> Draft review -> Final delivery. (Full refund if not liked).
${securityPrompt}

CRITICAL BEHAVIOR RULES (DO NOT BREAK):

1. IF USER SAYS "I filled the form" OR "I sent an email":
DO NOT thank them. DO NOT say "We received it."
REPLY EXACTLY: "If your form or email went through successfully, our automated system will notify me here in a few seconds. If you don't see a confirmation popup, please double-check that you hit send!"

2. IF USER SAYS "I paid" OR GIVES A FAKE INVOICE ID:
REPLY EXACTLY: "Got it! Zyro will manually verify this payment ID in our secure system before we begin."

3. TO CLOSE A DEAL:
When they ask for a service, quote the price and say "Are you ready to proceed?". 
IF AND ONLY IF they say yes/ok/deal, append the correct payment tag at the very end of your response: [PAY_THUMBNAIL], [PAY_LONG], [PAY_SHORT], or [PAY_MOTION].
          ` 
        },
        { role: 'user', content: userMessage }
      ],
      model: 'llama-3.3-70b-versatile', 
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
