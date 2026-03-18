const OpenAI = require('openai');
const groq = new OpenAI({ 
    apiKey: process.env.GROQ_API_KEY, 
    baseURL: "https://api.groq.com/openai/v1" 
});

// Your Instamojo Smart Links
const PAYMENT_LINKS = {
    "thumbnail": "https://imjo.in/55uD3H",
    "long_form": "https://imjo.in/MnEsyX",
    "short_form": "https://imjo.in/4wRGH9",
    "motion_graphic": "https://imjo.in/bY4QMt"
};

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  
  try {
    const userMessage = req.body.message || "";
    
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: `
You are the Elite Studio Manager for ZyroEditz. 
TONE: Professional, premium, and polite. Never be rude, aggressive, or robotic. Do not introduce yourself as an AI. Just answer the question directly but gracefully.

FORMATTING RULES:
1. Keep answers concise (1-3 sentences maximum).
2. Press "Enter" twice between separate points to create clean paragraph spacing.
3. Do NOT type literal "\\n" characters, random brackets, or weird punctuation. Keep text clean and simple.

BUSINESS KNOWLEDGE:
- PRICING: Short Form Editing (Reels/Shorts): ₹200. Long Form Editing (YouTube): ₹500. Motion Graphics: ₹400. Thumbnail Design: ₹100.
- OFFERS: 25% OFF the first project. (We do not offer free trials).
- WORKFLOW: 100% full payment upfront before starting the project -> Draft review (batch feedback) -> Final 1080p60 delivery. (We offer a full refund if the client is not satisfied with the work).
- FILE TRANSFER: Raw footage must be sent via email or secure drive link. We do not accept files via WhatsApp/Telegram to preserve visual quality.
- CONTENT POLICY: If asked about 18+ or wedding videos, politely decline by saying: "We specialize exclusively in commercial and YouTube content, and unfortunately do not offer editing services for wedding or 18+ videos."

CONTACT POLICY:
- For general inquiries or starting a project: Direct them to the website form or zyroeditz.official@gmail.com.
- IF explicitly asked for a WhatsApp/Phone Number: +91 7602679995.
- IF explicitly asked for Instagram/Portfolio: @zyroeditz.clips.

PAYMENT TRIGGER RULE (CRITICAL):
When a customer agrees to start a project, agrees to a price, or explicitly asks for a payment link, you MUST include ONE of these exact tags at the very end of your message:
- For Thumbnails: [PAY_THUMBNAIL]
- For YouTube/Long Form: [PAY_LONG]
- For Reels/Short Form: [PAY_SHORT]
- For Motion Graphics: [PAY_MOTION]

Example: "Excellent! I'll get started right away. [PAY_SHORT]"
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

    // Safety net: Force any literal '\n' text into actual line breaks
    reply = reply.replace(/\\n/g, '\n');

    // Detect the tag, assign the link, and hide the tag from the customer
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
