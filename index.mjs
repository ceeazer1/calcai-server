import express from "express";
import cors from "cors";
import { chatgpt } from "./routes/chatgpt.mjs";
import { devicesLogs } from "./routes/devices_logs.mjs";
import { otaProxy } from "./routes/ota_proxy.mjs";
import { serverLogs } from "./routes/server_logs.mjs";
import { pairRoutes } from "./routes/pair.mjs";
import { notesRoutes } from "./routes/notes.mjs";
import { initDb } from "./db.mjs";

const app = express();
app.set("trust proxy", true);
app.use(cors());
// Normalize multiple slashes in path to avoid route mismatches like //api/...
app.use((req, res, next) => {
  try {
    const original = req.url;
    // Collapse any sequence of 2+ slashes into a single slash (covers //api/...)
    const normalized = original.replace(/\/{2,}/g, "/");
    if (normalized !== original) {
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
// Health check for Fly.io
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});


// Mount ChatGPT routes (includes /gpt/ask and /gpt/ask-image)
app.use("/gpt", chatgpt());

// Device logs only; registration/ingest disabled
// app.use("/api/devices", devicesIngest());
app.use("/api/devices", devicesLogs());

// OTA proxy routes (ESP -> Fly -> Dashboard)
app.use("/api/ota", otaProxy());

// Pairing + Notes APIs
app.use("/api/pair", pairRoutes());
app.use("/api/notes", notesRoutes());

// Server logs API
app.use("/api/logs", serverLogs());

// Initialize database (no-op if DATABASE_URL not set)
(async () => { try { await initDb(); } catch (e) { console.warn("[db] init failed; falling back to FS", e?.message || e); } })();

// Start server when not on Vercel (e.g., Fly.io, local)
const port = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`CalcAI Server listening on port ${port}`);
  });
}

// Export default for Vercel compatibility
export default app;