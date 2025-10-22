import express from "express";
import openai from "openai";
import https from "https";
import { AppLogger } from "../utils/app_logger.mjs";
// Lightweight in-memory protections for concurrency and rate limiting
const MAX_CONCURRENCY = parseInt(process.env.GPT_MAX_CONCURRENCY || "8", 10);
let currentConcurrency = 0;

const RATE = {
  ask: { limit: parseInt(process.env.GPT_ASK_RPM || "30", 10), windowMs: 60_000 },
  img: { limit: parseInt(process.env.GPT_IMG_RPM || "12", 10), windowMs: 60_000 },
};
const rlBuckets = new Map(); // key -> timestamps array
function rateLimitOk(route, req) {
  const id = (
    req.headers["x-device-id"] ||
    req.headers["x-device"] ||
    req.headers["x-device-mac"] ||
    req.query?.mac ||
    req.ip ||
    "unknown"
  ).toString();
  const key = `${route}:${id}`;
  const now = Date.now();
  const { limit, windowMs } = RATE[route];
  let arr = rlBuckets.get(key);
  if (!arr) arr = [], rlBuckets.set(key, arr);
  // Drop old
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), ms);
  return { controller, timer };
}

import fs from "fs";
import path from "path";

// Per-device activity logging (non-blocking) and latest image storage
const LOG_BASE = process.env.DEVICE_LOG_DIR || (fs.existsSync("/data") ? "/data" : process.cwd());
const DEV_LOG_DIR = path.join(LOG_BASE, "device-logs");
const DEV_IMG_DIR = path.join(LOG_BASE, "device-images");
try { fs.mkdirSync(DEV_LOG_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DEV_IMG_DIR, { recursive: true }); } catch {}

function deviceIdFromReq(req) {
  const raw = (
    req.header("X-Device-Id") ||
    req.header("X-Device") ||
    req.header("X-Device-Mac") ||
    req.query?.deviceId ||
    req.query?.mac ||
    ""
  ).toString();
  if (!raw) return null;
  const id = raw.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return id || null;
}

function macPretty(id){
  if (!id) return null;
  if (/^[0-9a-f]{12}$/.test(id)) return id.match(/.{1,2}/g).join(":");
  return id;
}

function appendDeviceLog(deviceId, entry){
  try {
    const file = path.join(DEV_LOG_DIR, `${deviceId}.jsonl`);
    fs.appendFile(file, JSON.stringify(entry) + "\n", ()=>{});
  } catch {}
}

function saveLatestImage(deviceId, buf){
  try {
    const file = path.join(DEV_IMG_DIR, `${deviceId}.jpg`);
    fs.writeFile(file, buf, ()=>{});
    return file;
  } catch {
    return null;
  }
}


// Simple in-memory slot for the last uploaded image (ephemeral)
let lastImageBuf = null;
let lastImageMime = "image/jpeg";
let lastImageUpdatedAt = null;

export function chatgpt() {
  const routes = express.Router();

  const agent = new https.Agent({ keepAlive: true });
  const gpt = new openai.OpenAI({ httpAgent: agent });

  // simply answer a question (rate-limited + concurrency-limited + timeout)
  routes.get("/ask", async (req, res) => {
    const question = req.query.question ?? "";
    if (Array.isArray(question)) {
      return res.sendStatus(400);
    }
    if (!rateLimitOk("ask", req)) {
      return res.status(429).type("text/plain").send("Too many requests; please slow down");
    }
    if (currentConcurrency >= MAX_CONCURRENCY) {
      return res.status(429).type("text/plain").send("Server is busy; try again shortly");
    }

    const { controller, timer } = withTimeout(20000); // 20s timeout
    const started = Date.now();
    currentConcurrency++;
    try {
      AppLogger.push("info", "/gpt/ask start", { q: String(question).slice(0, 160) });
      const result = await gpt.chat.completions.create({
        messages: [
          { role: "system", content: "Plain ASCII only. Be concise for a 16x8 screen. Use ASCII math (^, *, /). Use i for imaginary. If there is a problem, compute it and give 1–3 short steps plus the FINAL numeric answer. Polar: r<theta deg. No placeholders." },
          { role: "user", content: question },
        ],
        model: "gpt-5-mini",
        temperature: 0.2,
        max_tokens: 200,
      }, { signal: controller.signal });

      const text = result.choices[0]?.message?.content ?? "no response";
      AppLogger.push("info", "/gpt/ask done", { ms: Date.now()-started, out: String(text).slice(0, 200) });
      res.type("text/plain").send(text);
      // Async device activity log (non-blocking)
      setImmediate(() => {
        const deviceId = deviceIdFromReq(req);
        if (deviceId) {
          const entry = {
            ts: Date.now(),
            iso: new Date().toISOString(),
            type: "text",
            deviceId,
            mac: macPretty(deviceId),
            question: String(question),
            response: String(text),
          };
          appendDeviceLog(deviceId, entry);
          try { AppLogger.push("info", "/gpt/device/text", { deviceId, mac: entry.mac }); } catch {}
        } else {
          try { AppLogger.push("info", "/gpt/device/text", { deviceId: null }); } catch {}
        }
      });
    } catch (e) {
      if (e?.name === "AbortError" || String(e?.message || "").includes("timeout")) {
        AppLogger.push("warn", "/gpt/ask timeout", { ms: Date.now()-started });
        res.status(504).type("text/plain").send("timeout");
      } else {
        AppLogger.push("error", "/gpt/ask error", { err: e?.message || String(e) });
        console.error(e);
        res.sendStatus(500);
      }
    } finally {
      clearTimeout(timer);
      currentConcurrency--;
    }
  });

  // New: accept raw JPEG and ask GPT-4o with vision; returns plain text (rate/concurrency/timeout)
  routes.post(
    "/ask-image",
    express.raw({ type: ["image/jpeg", "image/jpg"], limit: "5mb" }),
    async (req, res) => {
      if (!rateLimitOk("img", req)) {
        return res.status(429).type("text/plain").send("Too many image requests; slow down");
      }
      if (currentConcurrency >= MAX_CONCURRENCY) {
        return res.status(429).type("text/plain").send("Server is busy; try again shortly");
      }

      const { controller, timer } = withTimeout(30000); // 30s timeout for image
      const started = Date.now();
      currentConcurrency++;
      try {
        const prompt = String(
          (typeof req.query.prompt === "string" && req.query.prompt) ||
            "You are CalcAI. Read the image and help with ANY subject (math, science, ELA, history, etc.). If the image shows a multiple-choice question, return ONLY the letter (A/B/C/...) and one short justification. If it’s a short-answer or free response, answer concisely. If no question, summarize key info. Do not assume it is math unless clearly a math problem."
        );

        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).type("text/plain").send("No image body provided");
        }

        // Save last image (ephemeral) for viewing at /gpt/last-image
        lastImageBuf = Buffer.from(req.body);
        lastImageMime = (req.headers["content-type"] || "image/jpeg").toString();
        lastImageUpdatedAt = new Date();

        // Save latest image per device (non-blocking)
        setImmediate(() => {
          const deviceId = deviceIdFromReq(req);
          if (deviceId) {
            saveLatestImage(deviceId, req.body);
          }
        });


        const encoded_image = req.body.toString("base64");
        AppLogger.push("info", "/gpt/ask-image start", { prompt: String(prompt).slice(0,120), size: req.body.length });

        const result = await gpt.chat.completions.create({
          model: "gpt-5-mini",
          temperature: 0.2,
          max_tokens: 200,
          messages: [
            { role: "system", content: "Plain ASCII only. Be concise. Detect subject. If multiple-choice: ONLY the letter + one short reason. For computations: solve, show 1–3 short steps, give FINAL numeric answer. ASCII math (^,*,/). Use i for imaginary. Polar: r<theta deg." },
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${encoded_image}` } },
              ],
            },
          ],
        }, { signal: controller.signal });

        const text = result.choices?.[0]?.message?.content?.trim() || "no response";
        AppLogger.push("info", "/gpt/ask-image done", { ms: Date.now()-started, out: String(text).slice(0, 200) });
        res.type("text/plain").send(text);
        // Async per-device image activity log (non-blocking)
        setImmediate(() => {
          const deviceId = deviceIdFromReq(req);
          if (deviceId) {
            const entry = {
              ts: Date.now(),
              iso: new Date().toISOString(),
              type: "image",
              deviceId,
              mac: macPretty(deviceId),
              prompt: String(prompt),
              response: String(text),
              image: `/api/logs/image/latest/${deviceId}.jpg`
            };
            appendDeviceLog(deviceId, entry);
            try { AppLogger.push("info", "/gpt/device/image", { deviceId, mac: entry.mac }); } catch {}
          } else {
            try { AppLogger.push("info", "/gpt/device/image", { deviceId: null }); } catch {}
          }
        });

      } catch (e) {
        if (e?.name === "AbortError" || String(e?.message || "").includes("timeout")) {
          AppLogger.push("warn", "/gpt/ask-image timeout", { ms: Date.now()-started });
          res.status(504).type("text/plain").send("timeout");
        } else {
          AppLogger.push("error", "/gpt/ask-image error", { err: e?.message || String(e) });
          console.error(e);
          res.sendStatus(500);
        }
      } finally {
        clearTimeout(timer);
        currentConcurrency--;
      }
    }
  );

  // View the last uploaded image (ephemeral, single slot)
  routes.get("/last-image", (req, res) => {
    if (!lastImageBuf) {
      res.status(404).type("text/plain").send("no image");
      return;
    }

    if (req.query.info === "1") {
      res.type("application/json").send({
        mime: lastImageMime,
        updatedAt: lastImageUpdatedAt ? lastImageUpdatedAt.toISOString() : null,
        size: lastImageBuf.length
      });
      return;
    }

    res.setHeader("Content-Type", lastImageMime);
    res.setHeader("Cache-Control", "no-store");
    res.send(lastImageBuf);
  });

  return routes;
}
