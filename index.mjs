import express from "express";
import cors from "cors";
import { chatgpt } from "./routes/chatgpt.mjs";
import { devicesIngest } from "./routes/devices_ingest.mjs";
import { devicesLogs } from "./routes/devices_logs.mjs";

const app = express();
app.use(cors("*"));
app.use(express.json());

// Root route
app.get("/", (req, res) => {
  res.json({
    status: "CalcAI Server is running",
    timestamp: new Date().toISOString(),
    endpoints: ["/gpt/ask", "/gpt/ask-image"],
  });
});

// Mount ChatGPT routes (includes /gpt/ask and /gpt/ask-image)
app.use("/gpt", chatgpt());

// Device ingest routes
app.use("/api/devices", devicesIngest());
app.use("/api/devices", devicesLogs());

// Start server when not on Vercel (e.g., Fly.io, local)
const port = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`CalcAI Server listening on port ${port}`);
  });
}

// Export default for Vercel compatibility
export default app;