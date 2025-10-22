import express from "express";

import path from "path";
import fs from "fs";
import { AppLogger } from "../utils/app_logger.mjs";

// Server logs API and per-device activity/image helpers
// - GET /api/logs?range=5m|15m|1h|1d
// - GET /api/logs/device-activity/list
// - GET /api/logs/device-activity/logs/:deviceId?limit=200
// - GET /api/logs/image/latest/:deviceId.jpg
export function serverLogs() {
  const routes = express.Router();

  // Base directories (match chatgpt.mjs defaults)
  const LOG_BASE = process.env.DEVICE_LOG_DIR || (fs.existsSync("/data") ? "/data" : process.cwd());
  const DEV_LOG_DIR = path.join(LOG_BASE, "device-logs");
  const DEV_IMG_DIR = path.join(LOG_BASE, "device-images");

  // Ensure dirs exist (best-effort)
  try { fs.mkdirSync(DEV_LOG_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(DEV_IMG_DIR, { recursive: true }); } catch {}

  routes.get("/", async (req, res) => {
    try {
      const { range = "15m", mode } = req.query;
      const delta = AppLogger.parseRangeToMs(range);
      const since = Date.now() - delta;

      const token = process.env.FLY_API_TOKEN || "";
      const preferFly = !!token && mode !== "app";

      if (preferFly) {
        // Try Fly GraphQL logs first (aggregated across machines/regions)
        try {
          const result = await fetchFlyLogs({ token, appName: process.env.FLY_APP_NAME || "calcai-server", sinceMs: since });
          if (result?.ok && Array.isArray(result.logs)) {
            return res.json({ source: "fly", range, count: result.logs.length, logs: result.logs });
          }
        } catch (e) {
          // fall through to local logs
        }
      }

      // Default: return in-app logs captured by AppLogger (with file fallback inside)
      const logs = AppLogger.querySince(since);
      return res.json({ source: "app", range, count: logs.length, logs });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "failed_to_fetch_logs" });
    }
  });

  // List device IDs that have activity logs
  routes.get("/device-activity/list", async (req, res) => {
    try {
      const items = fs.existsSync(DEV_LOG_DIR) ? fs.readdirSync(DEV_LOG_DIR) : [];
      const ids = items
        .filter(name => name.endsWith(".jsonl"))
        .map(name => name.replace(/\.jsonl$/i, ""));
      res.json({ ok: true, count: ids.length, deviceIds: ids });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: "list_failed" });
    }
  });

  // Get recent logs for a device (most recent first)
  routes.get("/device-activity/logs/:deviceId", async (req, res) => {
    try {
      const raw = (req.params.deviceId || "").toString();
      const id = raw.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      if (!id) return res.status(400).json({ ok: false, error: "bad_deviceId" });
      const file = path.join(DEV_LOG_DIR, `${id}.jsonl`);
      if (!fs.existsSync(file)) return res.json({ ok: true, count: 0, logs: [] });

      const limit = Math.max(1, Math.min(1000, Number.parseInt(req.query.limit || "200")));
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      const parsed = [];
      for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
        const line = lines[i];
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      res.json({ ok: true, count: parsed.length, logs: parsed });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: "read_failed" });
    }
  });

  // Serve latest image for a device
  routes.get("/image/latest/:deviceId.jpg", (req, res) => {
    try {
      const raw = (req.params.deviceId || "").toString();
      const id = raw.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      if (!id) return res.status(400).type("text/plain").send("bad deviceId");
      const file = path.join(DEV_IMG_DIR, `${id}.jpg`);
      if (!fs.existsSync(file)) return res.status(404).type("text/plain").send("no image");
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(file);
    } catch (e) {
      console.error(e);
      res.status(500).type("text/plain").send("failed");
    }
  });

  return routes;
}

// Experimental Fly GraphQL log fetcher (undocumented; best-effort). May not work without proper scopes.
async function fetchFlyLogs({ token, appName, sinceMs }) {
  const endpoint = "https://api.fly.io/graphql";
  const sinceIso = new Date(sinceMs).toISOString();
  const query = `
    query($appName:String!, $since:Time) {
      app(name: $appName) {
        logs(filters:{since:$since}) {
          edges {
            node { timestamp level message instance { id } region }
          }
        }
      }
    }
  `;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables: { appName, since: sinceIso } }),
  });
  if (!resp.ok) return { ok: false, status: resp.status };
  const data = await resp.json();
  const edges = data?.data?.app?.logs?.edges || [];
  const logs = edges.map(e => ({
    ts: Date.parse(e.node.timestamp) || Date.now(),
    iso: e.node.timestamp,
    level: (e.node.level || "info").toLowerCase(),
    message: e.node.message,
    region: e.node.region,
    instanceId: e.node.instance?.id,
  }));
  return { ok: true, logs };
}
