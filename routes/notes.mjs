import express from "express";
import fs from "fs";
import path from "path";
import { getMacForWebToken } from "./pair.mjs";
import { getNotes as dbGetNotes, setNotes as dbSetNotes, deleteNotes as dbDeleteNotes, resolvePairCode, getDeviceOwner } from "../db.mjs";
import { verifyToken } from "../utils/token.mjs";

const LOG_BASE = process.env.DEVICE_LOG_DIR || (fs.existsSync("/data") ? "/data" : process.cwd());
const NOTES_DIR = path.join(LOG_BASE, "notes");
try { fs.mkdirSync(NOTES_DIR, { recursive: true }); } catch {}

export function notesRoutes() {
  const routes = express.Router();
  routes.use(express.json({ limit: "200kb" }));
  // Minimal CORS for browser calls
  routes.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Web-Token, X-Service-Token, X-Pair-Code");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  function normalizeMac(raw) {
    return (raw || "").toString().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  }
  async function ensureAuth(req, macParam) {
    const mac = normalizeMac(req.params[macParam]);
    if (!mac) return { ok: false, status: 400, error: "bad mac" };

    // Option A: Persistent pairing code (user-entered each time)
    const pairCode = (req.header("X-Pair-Code") || req.header("x-pair-code") || "").toString();
    if (pairCode) {
      const bound = await resolvePairCode(pairCode);
      if (bound !== mac) return { ok: false, status: 403, error: "forbidden" };
      return { ok: true, mac };
    }

    // Option B: Browser pairing token (back-compat)
    const webTok = (req.header("X-Web-Token") || req.header("x-web-token") || "").toString();
    if (webTok) {
      const bound = getMacForWebToken(webTok);
      if (bound !== mac) return { ok: false, status: 403, error: "forbidden" };
      return { ok: true, mac };
    }

    // Option C: Authorization Bearer (JWT for user accounts)
    const auth = (req.header("authorization") || req.header("Authorization") || "").toString();
    if (auth.startsWith("Bearer ")) {
      const payload = verifyToken(auth.slice(7));
      if (payload && payload.sub) {
        // Accept if token user owns this device
        const owner = await getDeviceOwner(mac);
        if ((owner && owner === payload.sub) || (Array.isArray(payload.macs) && payload.macs.includes(mac))) {
          return { ok: true, mac };
        }
        // Otherwise fallthrough to other auth options
      }
    }

    // Option D: Device/service token (from ESP32), accept header or ?token= query
    const validTokens = [
      process.env.DEVICES_SERVICE_TOKEN,
      process.env.DASHBOARD_SERVICE_TOKEN,
      process.env.SERVICE_TOKEN,
    ].filter(t => t && t.length > 0);
    const svcTok = (req.header("X-Service-Token") || req.header("x-service-token") || req.query.token || "").toString();
    if (validTokens.length === 0 && svcTok) {
      // If no tokens configured, allow when a token is provided (dev/local mode)
      return { ok: true, mac };
    }
    if (validTokens.includes(svcTok)) {
      return { ok: true, mac };
    }

    return { ok: false, status: 401, error: "missing token" };
  }

  routes.get("/:mac", async (req, res) => {
    const a = await ensureAuth(req, "mac");
    if (!a.ok) return res.status(a.status).type("text/plain").send(a.error);
    try {
      const text = await dbGetNotes(a.mac);
      if (!text || String(text).trim().length === 0) {
        return res.status(204).type("text/plain").send("");
      }
      return res.status(200).type("text/plain").send(text);
    } catch (e) {
      res.status(500).type("text/plain").send("");
    }
  });

  routes.post("/:mac", async (req, res) => {
    const a = await ensureAuth(req, "mac");
    if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
    try {
      let { text = "", mode = "append" } = req.body || {};
      text = String(text || "");
      // Enforce simple size cap for quick TI fetch on the final stored body
      const CAP = 16000;
      if (text.length > CAP && mode === "set") text = text.slice(text.length - CAP);
      // For append, cap is enforced by storing and letting client request pages; we keep a loose cap by trimming after append
      await dbSetNotes(a.mac, text, mode);
      // Optional post-trim to keep row bounded
      const final = await dbGetNotes(a.mac);
      if (final.length > CAP) {
        await dbSetNotes(a.mac, final.slice(final.length - CAP), "set");
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false });
    }
  });

  routes.delete("/:mac", async (req, res) => {
    const a = await ensureAuth(req, "mac");
    if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
    try {
      await dbDeleteNotes(a.mac);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false });
    }
  });

  return routes;
}

