import express from "express";
import cors from "cors";

const app = express();
app.use(cors("*"));

// Root route
app.get("/", (req, res) => {
  res.json({
    status: "CalcAI Server is running",
    timestamp: new Date().toISOString(),
    message: "Basic server test"
  });
});

// Test GPT route
app.get("/gpt/ask", (req, res) => {
  res.json({
    message: "GPT endpoint test - server is working",
    question: req.query.question || "no question provided"
  });
});

// Export for Vercel
export default app;