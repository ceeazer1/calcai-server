import express from "express";
import cors from "cors";
import openai from "openai";

const app = express();
app.use(cors("*"));
app.use(express.json());

// Root route
app.get("/", (req, res) => {
  res.json({
    status: "CalcAI Server is running",
    timestamp: new Date().toISOString(),
    endpoints: ["/gpt/ask"]
  });
});

// GPT route
app.get("/gpt/ask", async (req, res) => {
  const question = req.query.question ?? "";
  if (Array.isArray(question)) {
    res.sendStatus(400);
    return;
  }

  try {
    const gpt = new openai.OpenAI();
    const result = await gpt.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "Do not use emojis. ",
        },
        { role: "user", content: question },
      ],
      model: "gpt-4o",
    });

    res.send(result.choices[0]?.message?.content ?? "no response");
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// Export for Vercel
export default app;