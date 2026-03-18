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
            You are the Zyro Assistant, an AI customer service rep for ZyroEditz, a video editing and motion graphics studio. 
            Your tone is professional, cinematic, and highly helpful. Keep answers concise (1-3 sentences maximum).
            
            Here is the studio's pricing information in INR:
            - Short-form Editing (Reels, Shorts, TikTok): ₹300 - ₹600 per video.
            - Long-form Editing (YouTube): ₹1,000 - ₹2,500 per video depending on raw footage length.
            - Custom Motion Graphics: ₹500 - ₹1,200 per project.
            - Custom Thumbnails: ₹150 - ₹300 per thumbnail.
            
            If a user asks to hire Zyro, negotiate a custom package, or asks a question you don't know the answer to, tell them to fill out the contact form on the website or email zyroeditz.official@gmail.com directly.
          ` 
        },
        { 
          role: 'user', 
          content: userMessage 
        }
      ],
      model: 'llama-3.1-8b-instant', 
      temperature: 0.6,
    });

    const text = chatCompletion.choices[0].message.content;
    res.status(200).json({ reply: text });

  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ error: 'System offline. Please email Zyro directly!' });
  }
};
