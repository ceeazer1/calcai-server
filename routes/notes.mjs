import express from "express";
import fs from "fs";
import path from "path";
import { getMacForWebToken, getMacForPersistentCode } from "./pair.mjs";

const LOG_BASE = process.env.DEVICE_LOG_DIR || (fs.existsSync("/data") ? "/data" : process.cwd());
const NOTES_DIR = path.join(LOG_BASE, "notes");
try { fs.mkdirSync(NOTES_DIR, { recursive: true }); } catch {}

export function notesRoutes() {
  const routes = express.Router();
  routes.use(express.json({ limit: "200kb" }));
  // Minimal CORS for browser calls
  routes.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Web-Token, X-Service-Token, X-Pair-Code");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  function normalizeMac(raw) {
    return (raw || "").toString().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  }
  function ensureAuth(req, macParam) {
    const mac = normalizeMac(req.params[macParam]);
    if (!mac) return { ok: false, status: 400, error: "bad mac" };

    // Option A: Persistent pairing code (user-entered each time)
    const pairCode = (req.header("X-Pair-Code") || req.header("x-pair-code") || "").toString();
    if (pairCode) {
      const bound = getMacForPersistentCode(pairCode);
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

    // Option C: Device/service token (from ESP32), accept header or ?token= query
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

  routes.get("/:mac", (req, res) => {
    const a = ensureAuth(req, "mac");
    if (!a.ok) return res.status(a.status).type("text/plain").send(a.error);
    try {
      const file = path.join(NOTES_DIR, `${a.mac}.txt`);
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (!fs.existsSync(file) || String(text).trim().length === 0) {
        // No notes for this device: return 204 so ESP treats it as "no content"
        return res.status(204).type("text/plain").send("");
      }
      return res.status(200).type("text/plain").send(text);
    } catch (e) {
      res.status(500).type("text/plain").send("");
    }
  });

  routes.post("/:mac", (req, res) => {
    const a = ensureAuth(req, "mac");
    if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
    try {
      let { text = "", mode = "append" } = req.body || {};
      text = String(text || "");
      const file = path.join(NOTES_DIR, `${a.mac}.txt`);
      fs.mkdirSync(NOTES_DIR, { recursive: true });
      let final = "";
      if (mode === "set") {
        final = text;
      } else {
        const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        final = prev.length ? prev + "\n" + text : text;
      }
      // Enforce simple size cap for quick TI fetch
      const CAP = 16000;
      if (final.length > CAP) final = final.slice(final.length - CAP);
      fs.writeFileSync(file, final, "utf8");
      res.json({ ok: true, bytes: final.length });
    } catch (e) {
      res.status(500).json({ ok: false });
    }
  });

  routes.delete("/:mac", (req, res) => {
    const a = ensureAuth(req, "mac");
    if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error });
    try {
      const file = path.join(NOTES_DIR, `${a.mac}.txt`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false });
    }
  });

  return routes;
}

