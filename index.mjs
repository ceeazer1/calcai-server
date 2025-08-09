import express from "express";
import cors from "cors";
import { chatgpt } from "./routes/chatgpt.mjs";

const app = express();
app.use(cors("*"));
app.use(express.json());

// Root route
app.get("/", (req, res) => {
  res.json({
    status: "CalcAI Server is running",
    timestamp: new Date().toISOString(),
    endpoints: ["/gpt/ask", "/gpt/ask-image", "/gpt/solve"],
  });
});

// Mount ChatGPT routes (includes /gpt/ask, /gpt/ask-image, /gpt/solve)
app.use("/gpt", chatgpt());

// Export for Vercel
export default app;