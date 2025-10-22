import fs from "fs";
import path from "path";

// Optional Postgres adapter with FS fallback
// - If process.env.DATABASE_URL is set and 'pg' is available, use Postgres
// - Otherwise, fall back to existing on-disk storage under /data

const LOG_BASE = fs.existsSync("/data") ? "/data" : process.cwd();
const NOTES_DIR = path.join(LOG_BASE, "notes");
const PINS_FILE = path.join(LOG_BASE, "pair-pins.json");
try { fs.mkdirSync(NOTES_DIR, { recursive: true }); } catch {}

let pool = null;
let dbReady = false;
let dbEnabled = !!process.env.DATABASE_URL;

async function tryInitPg() {
  // Keep retrying opportunistically if DATABASE_URL is set
  if (!dbEnabled || pool) return;
  try {
    const pg = await import("pg");
    const { Pool } = pg;
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    await ensureSchema();
    dbReady = true;
  } catch (e) {
    // Do NOT permanently disable DB usage; leave pool null and try again on next call
    console.warn("[db] init attempt failed; will retry on next request:", e?.message || e);
    pool = null; dbReady = false;
  }
}

async function ensureSchema() {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists devices (
        mac text primary key,
        code text unique,
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      );
      create table if not exists notes (
        mac text primary key references devices(mac) on delete cascade,
        text text default '' not null,
        updated_at timestamptz default now()
      );
      create index if not exists idx_devices_code on devices(code);
      -- Extend devices for firmware/update tracking (safe no-ops if already present)
      alter table devices add column if not exists chip_id text;
      alter table devices add column if not exists model text;
      alter table devices add column if not exists firmware text;
      alter table devices add column if not exists first_seen timestamptz;
      alter table devices add column if not exists last_seen timestamptz;
      alter table devices add column if not exists status text;
      alter table devices add column if not exists name text;
      alter table devices add column if not exists update_available boolean default false;
      alter table devices add column if not exists target_firmware text;
      alter table devices add column if not exists last_update_status text;
      alter table devices add column if not exists last_downloaded text;
      alter table devices add column if not exists last_downloaded_at timestamptz;
    `);
  } finally {
    client.release();
  }
}

export async function initDb() {
  await tryInitPg();
}

function readPinsJSON() {
  try { return JSON.parse(fs.readFileSync(PINS_FILE, "utf8") || "{}") || {}; } catch { return {}; }
}
function writePinsJSON(obj) {
  try { fs.writeFileSync(PINS_FILE, JSON.stringify(obj, null, 2), "utf8"); return true; } catch { return false; }
}

// Pairing code helpers
export async function getPairCode(mac) {
  mac = String(mac || "").toLowerCase();
  if (dbEnabled) await tryInitPg();
  if (pool) {
    const client = await pool.connect();
    try {
      let { rows } = await client.query("select code from devices where mac=$1", [mac]);
      if (rows.length && rows[0].code) return rows[0].code;
      // Try to migrate from JSON file
      const pins = readPinsJSON();
      if (pins[mac]) {
        const code = String(pins[mac]);
        await client.query("insert into devices(mac, code) values($1,$2) on conflict (mac) do update set code=excluded.code, updated_at=now()", [mac, code]);
        return code;
      }
      return null;
    } finally { client.release(); }
  }
  // FS fallback
  const pins = readPinsJSON();
  return pins[mac] || null;
}

export async function setPairCode(mac, code) {
  mac = String(mac || "").toLowerCase(); code = String(code || "").toUpperCase();
  if (dbEnabled) await tryInitPg();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("insert into devices(mac, code) values($1,$2) on conflict (mac) do update set code=excluded.code, updated_at=now()", [mac, code]);
    } finally { client.release(); }
    return true;
  }
  // FS fallback
  const pins = readPinsJSON(); pins[mac] = code; writePinsJSON(pins); return true;
}

export async function rotatePairCode(mac, genCodeFn) {
  const code = genCodeFn ? genCodeFn(6) : Math.random().toString(36).slice(2, 8).toUpperCase();
  await setPairCode(mac, code);
  return code;
}

export async function resolvePairCode(code) {
  code = String(code || "").toUpperCase();
  if (dbEnabled) await tryInitPg();
  if (pool) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query("select mac from devices where upper(code)=$1", [code]);
      if (rows.length) return rows[0].mac;
      // Try migrate from JSON then re-check
      const pins = readPinsJSON();
      for (const [m, c] of Object.entries(pins)) {
        if (String(c).toUpperCase() === code) {
          await client.query("insert into devices(mac, code) values($1,$2) on conflict (mac) do update set code=excluded.code, updated_at=now()", [m, c]);
          return m;
        }
      }
      return null;
    } finally { client.release(); }
  }
  // FS fallback
  const pins = readPinsJSON();
  for (const [m, c] of Object.entries(pins)) {
    if (String(c).toUpperCase() === code) return m;
  }
  return null;
}

// Notes helpers
export async function getNotes(mac) {
  mac = String(mac || "").toLowerCase();
  if (dbEnabled) await tryInitPg();
  if (pool) {
    const client = await pool.connect();
    try {
      let { rows } = await client.query("select text from notes where mac=$1", [mac]);
      if (rows.length) return rows[0].text || "";
      // Try to migrate from file
      const file = path.join(NOTES_DIR, `${mac}.txt`);
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (text.length) {
        // Ensure device row exists
        await client.query("insert into devices(mac) values($1) on conflict do nothing", [mac]);
        await client.query("insert into notes(mac, text) values($1,$2) on conflict (mac) do update set text=excluded.text, updated_at=now()", [mac, text]);
        try { fs.unlinkSync(file); } catch {}
      }
      return text;
    } finally { client.release(); }
  }
  // FS fallback
  const file = path.join(NOTES_DIR, `${mac}.txt`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

export async function setNotes(mac, text, mode = "append") {
  mac = String(mac || "").toLowerCase(); text = String(text || "");
  if (dbEnabled) await tryInitPg();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("insert into devices(mac) values($1) on conflict do nothing", [mac]);
      if (mode === "set") {
        await client.query("insert into notes(mac, text) values($1,$2) on conflict (mac) do update set text=excluded.text, updated_at=now()", [mac, text]);
      } else {
        // Atomic append with newline if existing text is not empty
        await client.query(
          `insert into notes(mac, text) values($1,$2)
           on conflict (mac) do update set text = case when notes.text = '' then excluded.text else notes.text || E'\n' || excluded.text end, updated_at=now()`,
          [mac, text]
        );
      }
    } finally { client.release(); }
    return true;
  }
  // FS fallback
  const file = path.join(NOTES_DIR, `${mac}.txt`);
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  if (mode === "set") {
    fs.writeFileSync(file, text, "utf8");
  } else {
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const final = prev.length ? prev + "\n" + text : text;
    fs.writeFileSync(file, final, "utf8");
  }
  return true;
}

export async function deleteNotes(mac) {
  mac = String(mac || "").toLowerCase();
  if (dbEnabled) await tryInitPg();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("delete from notes where mac=$1", [mac]);
    } finally { client.release(); }
    return true;
  }
  // FS fallback
  const file = path.join(NOTES_DIR, `${mac}.txt`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}

// --- Devices/OTA helpers (DB-first with graceful no-op when DB unavailable) ---
export async function upsertDeviceDb({ mac, chipId = null, model = null, firmware = null, name = null, status = null, firstSeen = null }) {
  mac = String(mac || "").toLowerCase();
  if (!mac) return null;
  if (dbEnabled) await tryInitPg();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query(
      `insert into devices(mac, chip_id, model, firmware, name, status, first_seen, last_seen)
       values($1,$2,$3,$4,$5,$6, coalesce($7, now()), now())
       on conflict (mac) do update set
         chip_id = coalesce(excluded.chip_id, devices.chip_id),
         model = coalesce(excluded.model, devices.model),
         firmware = coalesce(excluded.firmware, devices.firmware),
         name = coalesce(excluded.name, devices.name),
         status = coalesce(excluded.status, devices.status),
         last_seen = now(),
         updated_at = now()`,
      [mac, chipId, model, firmware, name, status, firstSeen]
    );
    const { rows } = await client.query("select * from devices where mac=$1", [mac]);
    return rows[0] || null;
  } finally { client.release(); }
}

export async function pingDeviceDb({ mac, firmware = null, rssi = null, status = 'online' }) {
  mac = String(mac || "").toLowerCase(); if (!mac) return false;
  if (dbEnabled) await tryInitPg();
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query(
      `insert into devices(mac, firmware, status, last_seen)
       values($1,$2,$3, now())
       on conflict (mac) do update set
         firmware = coalesce(excluded.firmware, devices.firmware),
         status = coalesce(excluded.status, devices.status),
         last_seen = now(),
         updated_at = now()`,
      [mac, firmware, status]
    );
    return true;
  } finally { client.release(); }
}

export async function setUpdateFlagsDb(deviceId, { updateAvailable, targetFirmware }) {
  const mac = String(deviceId || "").toLowerCase(); if (!mac) return false;
  if (dbEnabled) await tryInitPg();
  if (!pool) return false;
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(
      `update devices set
         update_available = coalesce($2, update_available),
         target_firmware = coalesce($3, target_firmware),
         updated_at = now()
       where mac = $1`,
      [mac, typeof updateAvailable === 'boolean' ? updateAvailable : null, targetFirmware ?? null]
    );
    return rowCount > 0;
  } finally { client.release(); }
}

export async function getDeviceDb(deviceId) {
  const mac = String(deviceId || "").toLowerCase(); if (!mac) return null;
  if (dbEnabled) await tryInitPg();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    const { rows } = await client.query("select * from devices where mac=$1", [mac]);
    return rows[0] || null;
  } finally { client.release(); }
}

export async function listDevicesDb() {
  if (dbEnabled) await tryInitPg();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    const { rows } = await client.query("select * from devices order by coalesce(last_seen, created_at) desc limit 1000");
    const out = {};
    for (const r of rows) {
      const id = r.mac;
      out[id] = {
        mac: r.mac,
        chipId: r.chip_id || '',
        model: r.model || 'ESP32',
        firmware: r.firmware || '',
        firstSeen: r.first_seen ? new Date(r.first_seen).toISOString() : (r.created_at ? new Date(r.created_at).toISOString() : null),
        lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
        status: r.status || 'online',
        name: r.name || `CalcAI-${(r.mac || '').slice(-5)}`,
        updateAvailable: !!r.update_available,
        targetFirmware: r.target_firmware || null,
        lastUpdateStatus: r.last_update_status || null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      };
    }
    return out;
  } finally { client.release(); }
}
