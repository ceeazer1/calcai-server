import express from "express";
import fs from "fs";
import path from "path";
import { getPairCode as dbGetPairCode, setPairCode as dbSetPairCode, rotatePairCode as dbRotatePairCode, resolvePairCode as dbResolvePairCode, deleteNotes as dbDeleteNotes, isDeviceClaimed as dbIsDeviceClaimed } from "../db.mjs";

// Shared data paths (notes file lives alongside logs)
const LOG_BASE = fs.existsSync("/data") ? "/data" : process.cwd();
const NOTES_DIR = path.join(LOG_BASE, "notes");
try { fs.mkdirSync(NOTES_DIR, { recursive: true }); } catch {}

// In-memory storage for one-time web tokens (back-compat)
const webTokens = new Map(); // webToken -> mac

// Persistent per-device pairing PINs (MAC -> CODE)
const STORE_BASE = fs.existsSync("/data") ? "/data" : process.cwd();
const PINS_FILE = path.join(STORE_BASE, "pair-pins.json");
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8") || "{}") || {}; } catch { return {}; }
}
function writeJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8"); return true; } catch { return false; }
}
function loadPins() {
  return readJSON(PINS_FILE);
}
function savePins(pins) {
  try { fs.mkdirSync(path.dirname(PINS_FILE), { recursive: true }); } catch {}
  return writeJSON(PINS_FILE, pins || {});
}
function getMacForPairCode(code) {
  if (!code) return null;
  const pins = loadPins();
  const norm = String(code).toUpperCase();
  for (const [mac, c] of Object.entries(pins)) {
    if (String(c).toUpperCase() === norm) return mac;
  }
  return null;
}

function genCode(len = 6) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // avoid 0/O and 1/I
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function pairRoutes() {
  const routes = express.Router();

  // Minimal CORS for browser calls
  routes.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Web-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // Device (ESP) requests a persistent pairing code (PIN). Returns plain text code.
  // Accept both GET and POST for simplicity from firmware
  const startHandler = async (req, res) => {
    try {
      const rawMac = (req.query.mac || req.body?.mac || "").toString();
      const mac = rawMac.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      if (!mac) return res.status(400).type("text/plain").send("bad mac");

      let code = await dbGetPairCode(mac);
      if (!code) {
        code = genCode(6);
        await dbSetPairCode(mac, code);
      }
      res.type("text/plain").send(code);
    } catch (e) {
      res.status(500).type("text/plain").send("server error");
    }
  };
  routes.get("/start", startHandler);
  routes.post("/start", express.json(), startHandler);

  // Website claims a code and receives a webToken bound to the device MAC (back-compat)
  routes.post("/claim", express.json(), (req, res) => {
    try {
      let code = (req.body?.code || "").toString().toUpperCase();
      if (!code || code.length < 4) return res.status(400).json({ ok: false, error: "invalid" });
      const mac = getMacForPairCode(code);
      if (!mac) return res.status(400).json({ ok: false, error: "invalid" });

      const webToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      webTokens.set(webToken, mac);
      res.json({ ok: true, mac, webToken });
    } catch (e) {
      res.status(500).json({ ok: false });
    }
  });

  // Resolve code -> mac (for code-first flows). Also indicate claim status.
  routes.get("/resolve", async (req, res) => {
    const code = (req.query.code || "").toString();
    const mac = await dbResolvePairCode(code);
    if (!mac) return res.status(404).json({ ok: false, error: "not_found" });
    const claimed = await dbIsDeviceClaimed(mac);
    res.json({ ok: true, mac, claimed: !!claimed });
  });

  // Reset pairing for a device: rotate PIN and clear existing web tokens for that MAC
  routes.post("/reset/:mac", async (req, res) => {
    const raw = (req.params.mac || "").toString();
    const mac = raw.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (!mac) return res.status(400).json({ ok: false, error: "bad_mac" });

    const code = await dbRotatePairCode(mac, genCode);

    // Clear web tokens for this MAC
    try {
      for (const [tok, m] of Array.from(webTokens.entries())) {
        if (m === mac) webTokens.delete(tok);
      }
    } catch {}

    // Also clear any stored notes so calculator shows pairing/setup again
    try {
      await dbDeleteNotes(mac);
      const notesFile = path.join(NOTES_DIR, `${mac}.txt`);
      if (fs.existsSync(notesFile)) fs.unlinkSync(notesFile);
    } catch {}

    res.json({ ok: true, mac, code });
  });

  return routes;
}

export function getMacForWebToken(tok) {
  return webTokens.get(tok) || null;
}
export function getMacForPersistentCode(code) {
  // Synchronous wrapper retained for back-compat callers; resolves from file map.
  // Note: New code paths should use dbResolvePairCode (async).
  return getMacForPairCode(code);
}

