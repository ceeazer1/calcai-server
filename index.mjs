import express from "express";
import cors from "cors";
import { chatgpt } from "./routes/chatgpt.mjs";
import { devicesIngest } from "./routes/devices_ingest.mjs";
import { devicesLogs } from "./routes/devices_logs.mjs";
import { otaProxy } from "./routes/ota_proxy.mjs";

const app = express();
app.use(cors("*"));
// Normalize multiple slashes in path to avoid route mismatches like //api/...
app.use((req, res, next) => {
  try {
    const original = req.url;
    // Collapse any sequence of 2+ slashes into a single slash (covers //api/...)
    const normalized = original.replace(/\/{2,}/g, "/");
    if (normalized !== original) {
      console.log(`[normalize] ${original} -> ${normalized}`);
      req.url = normalized;
    }
  } catch {}
  next();
});

// Increase JSON limit to allow base64 firmware uploads from dashboard
app.use(express.json({ limit: '20mb' }));

// Root route
app.get("/", (req, res) => {
  res.json({
    status: "CalcAI Server is running",
    timestamp: new Date().toISOString(),
    endpoints: ["/gpt/ask", "/gpt/ask-image", "/api/ota/check-update/:deviceId", "/api/ota/firmware/:version"],
  });
});

// Mount ChatGPT routes (includes /gpt/ask and /gpt/ask-image)
app.use("/gpt", chatgpt());

// Device ingest routes
app.use("/api/devices", devicesIngest());
app.use("/api/devices", devicesLogs());

// OTA proxy routes (ESP -> Fly -> Dashboard)
app.use("/api/ota", otaProxy());

// Start server when not on Vercel (e.g., Fly.io, local)
const port = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`CalcAI Server listening on port ${port}`);
  });
}

// Export default for Vercel compatibility
export default app;