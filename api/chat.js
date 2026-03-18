const OpenAI = require('openai');
const groq = new OpenAI({ 
    apiKey: process.env.GROQ_API_KEY, 
    baseURL: "https://api.groq.com/openai/v1" 
});

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  
  try {
    const userMessage = req.body.message || "";
    
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: `
STRICT OPERATING RULES (CRITICAL):
1. NO INTRODUCTIONS: DO NOT say "Hello", "I am an AI", or "I am the Zyro Assistant". Start answering immediately.
2. NO FLUFF: Zero conversational filler. Output raw, sharp facts only. Maximum 3 sentences.
3. FORMATTING: You MUST use DOUBLE LINE BREAKS (\n\n) between different points.

CONTACT PROTOCOL (SECURITY LOCK):
- Default: Tell users to use the website form or email zyroeditz.official@gmail.com.
- TRIGGER "WhatsApp/Number/Phone": ONLY IF the user types these exact words, output -> WhatsApp: +91 7602679995.
- TRIGGER "Instagram/Social/Portfolio": ONLY IF asked, output -> Instagram: @zyroeditz.clips.

HARD-CODED BUSINESS LOGIC:
- PRICING: Short-form (Reels/Shorts) is ₹300-₹600. Long-form (YouTube) is ₹1,000-₹2,500.
- OFFERS: 25% OFF first project only. ZERO free trials.
- WORKFLOW: 1. 50% upfront deposit. 2. Draft review (batch all feedback). 3. Final 1080p60 delivery.
- TECH: DaVinci Resolve, Premiere Pro, After Effects. 
- FILE TRANSFER: Raw footage via EMAIL ONLY to preserve quality. No WhatsApp/Telegram files.
- REJECTIONS: We DO NOT edit Wedding or 18+ videos. Reject these immediately.

FALLBACK:
If the user asks something not covered here, output EXACTLY: "Please email zyroeditz.official@gmail.com with your specific requirements."
          ` 
        },
        { role: 'user', content: userMessage }
      ],
      model: 'llama-3.1-8b-instant', 
      temperature: 0.0, // Set to ZERO. No creativity, no hallucinations, just strict rules.
      max_tokens: 150,  // Forces the bot to shut up quickly.
    });
    
    res.status(200).json({ reply: chatCompletion.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ error: 'System offline. Email zyroeditz.official@gmail.com' });
  }
};
