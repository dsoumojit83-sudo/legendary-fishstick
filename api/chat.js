const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async function(req, res) {
  // Only allow POST requests from your chat window
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // This grabs your secure key from Vercel's Environment Variables!
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

    const userMessage = req.body.message || "";

    // The AI's personality and knowledge base
    const systemPrompt = `
      You are the Zyro Assistant, an AI customer service rep for ZyroEditz, a video editing and motion graphics studio. 
      Your tone is professional, cinematic, and highly helpful. Keep answers concise (1-3 sentences maximum).
      
      Here is the studio's pricing information in INR:
      - Short-form Editing (Reels, Shorts, TikTok): ₹300 - ₹600 per video.
      - Long-form Editing (YouTube): ₹1,000 - ₹2,500 per video depending on raw footage length.
      - Custom Motion Graphics: ₹500 - ₹1,200 per project.
      - Custom Thumbnails: ₹150 - ₹300 per thumbnail.
      
      If a user asks to hire Zyro, negotiate a custom package, or asks a question you don't know the answer to, tell them to fill out the contact form on the website or email zyroeditz.official@gmail.com directly.
      
      User's message: "${userMessage}"
    `;

    // Ask the AI for a response
    const result = await model.generateContent(systemPrompt);
    const response = await result.response;
    const text = response.text();

    // Send the response back to your website
    res.status(200).json({ reply: text });

  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ error: 'System offline. Please email Zyro directly!' });
  }
};
