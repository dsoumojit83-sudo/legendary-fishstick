const { GoogleGenerativeAI } = require("@google/generative-ai");

// Setup Gemini 3 Flash
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Using 1.5-flash for maximum stability during testing

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { message: userMessage } = req.body;

        // SIMPLE TEST PROMPT
        const prompt = `You are the ZyroEditz Assistant. 
        If the user says hi or hello, greet them warmly and mention that the bot is in TEST MODE. 
        User message: ${userMessage}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        return res.status(200).json({ 
            reply: text.trim(),
            status: "Success: Gemini is Connected!" 
        });

    } catch (error) {
        console.error("Gemini Test Error:", error);
        return res.status(500).json({ 
            error: "Connection Failed", 
            details: error.message 
        });
    }
};
