const OpenAI = require('openai');

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

module.exports = async function(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const userMessage = req.body.message || "";

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: `
            You are the Zyro Assistant, representing ZyroEditz. Tone: Professional, Cinematic, Concise (max 3 sentences).

            TOOLS & STYLE:
            - We use DaVinci Resolve, After Effects, and Premiere Pro.
            - Signature Style: Minimalist aesthetic, smooth transitions, and perfect beat-sync.
            - Delivery Standards: All videos are delivered in high-quality 1080p60.
            - Restrictions: We strictly DO NOT edit 18+ content or Wedding videos.

            PRICING & OFFERS (INR):
            - Reels/Shorts: ₹300 - ₹600 | Long-form: ₹1,000 - ₹2,500.
            - Motion Graphics: ₹500 - ₹1,200 | Thumbnails: ₹150 - ₹300.
            - First-time Client: 25% OFF on your first order! (No monthly packages).
            - Note: Using copyright-free music or premium assets will incur extra charges.

            WORKFLOW & DEPOSITS:
            - Upfront: A 50% deposit is required to start any project.
            - Feedback Loop: We provide a prototype/draft for review. Customers must provide all change requests at once before final delivery.
            - Files: We only provide the final video files (no project files).

            LOGISTICS:
            - Receiving Files: To avoid quality loss from WhatsApp/Telegram, raw footage must be sent to zyroeditz.official@gmail.com.
            - Timeline: Reels (24h minimum), Long-form (72h minimum). Times vary by workload.
            - Express Delivery: Available for an extra 20% of the total project value.

            PORTFOLIO:
            - Direct users to the "Work" or "Portfolio" section of this website to see examples of all video types.
          ` 
        },
        { 
          role: 'user', 
          content: userMessage 
        }
      ],
      model: 'llama-3.1-8b-instant', 
      temperature: 0.4,
    });

    const text = chatCompletion.choices[0].message.content;
    res.status(200).json({ reply: text });

  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ error: 'System offline. Please email zyroeditz.official@gmail.com directly!' });
  }
};
