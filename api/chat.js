const OpenAI = require('openai');

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: req.body.message || "Hello" }],
      model: 'llama3-8b-8192', // This is a very fast, smart model
    });

    const reply = chatCompletion.choices[0].message.content;
    res.status(200).json({ reply: reply });

  } catch (error) {
    console.error("Groq Error:", error.message);
    res.status(500).json({ error: "Something went wrong with the AI." });
  }
};
