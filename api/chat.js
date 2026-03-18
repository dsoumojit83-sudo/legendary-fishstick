const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async function(req, res) {
  // DEBUG: Check if the key exists and how long it is
  const key = process.env.GEMINI_API_KEY || "";
  console.log("DEBUG - Key Length:", key.length);
  console.log("DEBUG - Key Starts With:", key.substring(0, 4));

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    if (!key) throw new Error("API Key is missing from Vercel Environment Variables");

    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const result = await model.generateContent(req.body.message || "Hello");
    const response = await result.response;
    res.status(200).json({ reply: response.text() });

  } catch (error) {
    console.error("AI Error:", error.message);
    res.status(500).json({ error: error.message });
  }
};
