import fs from "fs";
import path from "path";

// Simple in-memory + optional file-backed logger for application (GPT) logs
// - Keeps recent logs in memory for quick API access
// - Also appends JSONL to /data/app-logs.jsonl if the volume is mounted

const LOG_FILE = process.env.LOG_FILE || "/data/app-logs.jsonl";
const MAX_IN_MEMORY = parseInt(process.env.LOG_MAX_MEM || "5000", 10); // lines

const entries = [];

function nowIso() {
  return new Date().toISOString();
}

function safeAppend(line) {
  try {
    fs.appendFile(LOG_FILE, line + "\n", { encoding: "utf8" }, ()=>{});
  } catch {}
}

function push(level, message, meta = {}) {
  const ts = Date.now();
  const item = { ts, iso: nowIso(), level, message, ...meta };
  // Mirror to console for fly logs
  const prefix = level === "error" ? "[error]" : level === "warn" ? "[warn]" : "[info]";
  console.log(`[app] ${prefix} ${item.iso} ${message}`);
  // Add to memory buffer
  entries.push(item);
  if (entries.length > MAX_IN_MEMORY) entries.splice(0, entries.length - MAX_IN_MEMORY);
  // Append to file (JSONL)
  try { safeAppend(JSON.stringify(item)); } catch {}
  return item;
}

function querySince(sinceMs) {
  const cutoff = typeof sinceMs === "number" ? sinceMs : 0;
  const fromMem = entries.filter(e => e.ts >= cutoff);
  if (fromMem.length > 0) return fromMem;
  // Fallback: try to read from file-backed JSONL
  try {
    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      const parsed = [];
      for (let i = lines.length - 1; i >= 0 && parsed.length < MAX_IN_MEMORY; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (!obj || typeof obj.ts !== 'number') continue;
          if (obj.ts >= cutoff) parsed.push(obj);
        } catch {}
      }
      return parsed.reverse();
    }
  } catch {}
  return [];
}

function parseRangeToMs(rangeStr) {
  // Accept forms like "5m", "15m", "1h", "1d"; default 15m
  const s = String(rangeStr || "15m").trim().toLowerCase();
  const m = s.match(/^([0-9]+)\s*([smhd])$/);
  if (!m) return 15 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  switch (unit) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: return 15 * 60 * 1000;
  }
}

export const AppLogger = {
  push,
  querySince,
  parseRangeToMs,
};

