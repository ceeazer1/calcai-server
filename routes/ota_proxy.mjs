import express from "express";
import { getDevices, saveDevices } from "./devices_store.mjs";
import { getDeviceDb } from "../db.mjs";
import fs from "fs";
import path from "path";
import crypto from "crypto";



// OTA proxy routes: ESP talks to Fly.io server; we forward to the Vercel dashboard
export function otaProxy() {
  const router = express.Router();

  function checkToken(req, res) {
    // Allow any of several env var names; if none set, allow (dev-mode)
    const validTokens = [
      process.env.DEVICES_SERVICE_TOKEN,
      process.env.DASHBOARD_SERVICE_TOKEN,
      process.env.SERVICE_TOKEN,
    ].filter(Boolean);
    if (validTokens.length === 0) return true;
    const headerToken = req.get("X-Service-Token") || req.get("x-service-token") || "";
    if (!validTokens.includes(headerToken)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  }

  // Base URL of the dashboard (only used to host firmware binaries)
  const DASHBOARD_BASE = process.env.MANAGEMENT_DASHBOARD_BASE || "https://calcai-management-dashboard.vercel.app";
  // Local firmware directory on Fly (persistent if a volume is mounted)
  const storeBase = process.env.DEVICES_STORE_DIR || (fs.existsSync("/data") ? "/data" : process.cwd());
  const firmwareDir = path.join(storeBase, "firmware");
  // Helpers: base URL, version safety, sha256, and an in-memory hash cache
  const shaCache = new Map(); // version -> hex sha256

  // Firmware manifest helpers (persist history and latest)
  const manifestPath = path.join(firmwareDir, "manifest.json");
  function readManifest() {
    try {
      if (fs.existsSync(manifestPath)) {
        const raw = fs.readFileSync(manifestPath, "utf8");
        const m = JSON.parse(raw);
        if (Array.isArray(m?.history)) return m;
      }
    } catch {}
    // Build from directory as fallback
    try {
      const files = fs.readdirSync(firmwareDir).filter(f => f.endsWith('.bin'));
      const history = files.map(f => {
        const ver = f.replace(/\.bin$/,'');
        const st = fs.statSync(path.join(firmwareDir, f));
        return { version: ver, size: st.size, created: st.mtime.toISOString() };
      }).sort((a,b)=> new Date(b.created) - new Date(a.created));
      return { history };
    } catch { return { history: [] }; }
  }
  function writeManifest(m) {
    try { fs.writeFileSync(manifestPath, JSON.stringify({ history: m.history||[] }, null, 2)); } catch {}
  }
  function upsertManifestEntry(entry) {
    const m = readManifest();
    const idx = m.history.findIndex(h => h.version === entry.version);
    if (idx >= 0) m.history[idx] = { ...m.history[idx], ...entry };
    else m.history.unshift(entry);
    // sort newest first
    m.history.sort((a,b)=> new Date(b.created||0) - new Date(a.created||0));
    writeManifest(m);
    return m;
  }

  function publicBase(req) {
    const envBase = (process.env.FIRMWARE_PUBLIC_BASE || process.env.PUBLIC_BASE_URL || "").toString().trim();
    if (envBase) return envBase.replace(/\/$/, "");
    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
    return `${proto}://${host}`;
  }
  function safeVersion(v) {
    return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  }
  function sha256Hex(buf) {
    const h = crypto.createHash("sha256");
    h.update(buf);
    return h.digest("hex");
  }

  try { if (!fs.existsSync(firmwareDir)) fs.mkdirSync(firmwareDir, { recursive: true }); } catch {}

  // Use local device store on Fly for update metadata, so devices persist and don't disappear

  // Optional token to fetch firmware from dashboard (if it requires auth)
  const DASHBOARD_SERVICE_TOKEN = process.env.DASHBOARD_SERVICE_TOKEN || process.env.DEVICES_SERVICE_TOKEN || null;

  // Use local device store on Fly for update metadata, so devices persist and don't disappear

  // GET /api/ota/check-update/:deviceId?currentVersion=...
  router.get("/check-update/:deviceId", async (req, res) => {
    try {
      const { deviceId } = req.params;
      const currentVersion = req.query.currentVersion || "";

      let dev = null;
      if (process.env.DATABASE_URL) {
        try {
          const row = await getDeviceDb(deviceId);
          if (row) {
            dev = {
              firmware: row.firmware || "",
              updateAvailable: !!row.update_available,
              targetFirmware: row.target_firmware || null,
            };
          }
        } catch {}
      } else {
        const devices = getDevices();
        const d = devices[deviceId];
        if (d) {
          if (currentVersion) d.firmware = currentVersion;
          d.lastSeen = new Date().toISOString();
          try { saveDevices(devices); } catch {}
          dev = d;
        }
      }

      if (dev && dev.updateAvailable && dev.targetFirmware) {
        const ver = safeVersion(dev.targetFirmware);
        // If device is already on this version, do NOT prompt an update
        if (currentVersion && safeVersion(currentVersion) === ver) {
          return res.json({ updateAvailable: false });
        }
        const abs = `${publicBase(req)}/api/ota/firmware/${encodeURIComponent(ver)}`;
        // Ensure the firmware is actually available before telling device to update
        const localPath = path.join(firmwareDir, `${ver}.bin`);
        let available = false;
        if (fs.existsSync(localPath)) {
          available = true;
        } else {
          try {
            const url = `${DASHBOARD_BASE}/api/devices/firmware/${encodeURIComponent(ver)}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort("timeout"), 6000);
            const resp = await fetch(url, {
              method: "HEAD",
              headers: DASHBOARD_SERVICE_TOKEN ? { "X-Service-Token": DASHBOARD_SERVICE_TOKEN } : undefined,
              signal: controller.signal,
            });
            clearTimeout(timeout);
            available = !!resp?.ok;
          } catch (e) {
            available = false;
          }
        }
        if (!available) {
          // Not ready yet; avoid telling device to start OTA
          return res.json({ updateAvailable: false });
        }
        // If local file exists, include sha256 for device-side integrity check
        let sha256;
        try {
          if (fs.existsSync(localPath)) {
            const buf = fs.readFileSync(localPath);
            sha256 = shaCache.get(ver) || sha256Hex(buf);
            shaCache.set(ver, sha256);
          }
        } catch {}
        return res.json({ updateAvailable: true, version: ver, downloadUrl: abs, ...(sha256 ? { sha256 } : {}) });
      }
      // Fallback: global latest from manifest (pull-based updates)
      try {
        const m = readManifest();
        const latest = (m.history||[])[0];
        if (latest && latest.version) {
          const latestVer = safeVersion(latest.version);
          if (!currentVersion || safeVersion(currentVersion) !== latestVer) {
            const abs = `${publicBase(req)}/api/ota/firmware/${encodeURIComponent(latestVer)}`;
            const localPath = path.join(firmwareDir, `${latestVer}.bin`);
            if (fs.existsSync(localPath)) {
              let sha256;
              try {
                const buf = fs.readFileSync(localPath);
                sha256 = shaCache.get(latestVer) || sha256Hex(buf);
                shaCache.set(latestVer, sha256);
              } catch {}
              return res.json({ updateAvailable: true, version: latestVer, downloadUrl: abs, ...(sha256 ? { sha256 } : {}) });
            }
          }
        }
      } catch {}
      return res.json({ updateAvailable: false });
    } catch (e) {
      console.error("[otaProxy] check-update error:", e?.message || e);
      res.status(500).json({ ok: false, error: "proxy_failed" });
    }
  });

  // POST /api/ota/firmware/upload  { version, dataBase64, description? }
  router.post("/firmware/upload", async (req, res) => {
    try {
      const { version, dataBase64, description } = req.body || {};
      if (!version || !dataBase64) {
        return res.status(400).json({ ok: false, error: "version_and_data_required" });
      }
      const safeVer = String(version).replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(firmwareDir, `${safeVer}.bin`);
      const buf = Buffer.from(dataBase64, 'base64');
      fs.writeFileSync(filePath, buf);
      const created = new Date().toISOString();
      upsertManifestEntry({ version: safeVer, size: buf.length, created, description: description||"" });
      // prime sha cache
      try { shaCache.set(safeVer, sha256Hex(buf)); } catch {}
      return res.json({ ok: true, version: safeVer, size: buf.length, created });
    } catch (e) {
      console.error("[otaProxy] firmware upload error:", e?.message || e);
      res.status(500).json({ ok: false, error: "upload_failed" });
    }
  });

  // GET /api/ota/firmware/list -> array of {version,size,created,description?}, newest first
  router.get("/firmware/list", async (req, res) => {
    try {
      const m = readManifest();
      res.json(m.history || []);
    } catch (e) {
      res.json([]);
    }
  });

  // GET /api/ota/firmware/latest -> the newest entry or null
  router.get("/firmware/latest", async (req, res) => {
    try {
      const m = readManifest();
      res.json((m.history||[])[0] || null);
    } catch (e) {
      res.json(null);
    }
  });

  // DELETE /api/ota/firmware/:version -> delete file and update manifest
  router.delete("/firmware/:version", async (req, res) => {
    try {
      const ver = safeVersion(req.params.version || "");
      if (!ver) return res.status(400).json({ ok: false, error: "bad_version" });
      const localPath = path.join(firmwareDir, `${ver}.bin`);
      try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch {}
      const m = readManifest();
      m.history = (m.history||[]).filter(h => h.version !== ver);
      writeManifest(m);
      res.json({ ok: true, message: `Deleted ${ver}` });
    } catch (e) {
      res.status(500).json({ ok: false, error: "delete_failed" });
    }
  });

  // GET /api/ota/firmware/:version -> serve local if present; else fetch+cache from dashboard

	  // DELETE /api/ota/firmware/clear-all -> remove all firmware files and clear manifest
	  router.delete("/firmware/clear-all", async (req, res) => {
	    try {
	      let deleted = 0;
	      try {
	        if (fs.existsSync(firmwareDir)) {
	          for (const f of fs.readdirSync(firmwareDir)) {
	            if (f.endsWith('.bin')) {
	              try { fs.unlinkSync(path.join(firmwareDir, f)); deleted++; } catch {}
	            }
	          }
	        }
	      } catch {}
	      writeManifest({ history: [] });
	      try { if (shaCache?.clear) shaCache.clear(); } catch {}
	      return res.json({ ok: true, deleted });
	    } catch (e) {
	      return res.status(500).json({ ok: false, error: "clear_failed" });
	    }
	  });

  // Public endpoint (no token required) so ESP and browser can download firmware
  router.get("/firmware/:version", async (req, res) => {
    try {
      const ver = safeVersion(req.params.version || "");
      if (!ver) return res.status(400).type("text/plain").send("bad version");
      const localPath = path.join(firmwareDir, `${ver}.bin`);

      if (fs.existsSync(localPath)) {
        const buf = fs.readFileSync(localPath);
        const sha = shaCache.get(ver) || sha256Hex(buf); shaCache.set(ver, sha);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${ver}.bin"`);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.setHeader("ETag", `sha256-${sha}`);
        res.setHeader("Accept-Ranges", "none");
        res.setHeader("Content-Length", String(buf.length));
        return res.send(buf);
      }

      const url = `${DASHBOARD_BASE}/api/devices/firmware/${encodeURIComponent(ver)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("timeout"), 15000);
      const resp = await fetch(url, {
        method: "GET",
        headers: DASHBOARD_SERVICE_TOKEN ? { "X-Service-Token": DASHBOARD_SERVICE_TOKEN } : undefined,
        signal: controller.signal,
      }).catch((e) => { throw e; });
      clearTimeout(timeout);

      if (!resp?.ok) {
        const text = await resp?.text?.().catch(() => "");
        return res.status(resp?.status || 502).send(text || "failed to fetch firmware");
      }

      const arrayBuf = await resp.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      // Cache locally
      try { fs.writeFileSync(localPath, buf); } catch (e) { console.warn("[otaProxy] failed to cache firmware:", e?.message || e); }
      const sha = sha256Hex(buf); shaCache.set(ver, sha);

      // Best-effort: attribute download to a device if it provided an ID header (ESP >= this build)
      try {
        const devId = (req.header("X-Device-Id") || req.header("x-device-id") || "").toString().trim();
        if (devId) {
          const devices = getDevices();
          if (devices && devices[devId]) {
            devices[devId].lastDownloaded = ver;
            devices[devId].lastDownloadedAt = new Date().toISOString();
            saveDevices(devices);
          }
        }
      } catch(e) {
        console.warn("[otaProxy] failed to attribute firmware download:", e?.message || e);
      }

      res.setHeader("Content-Type", resp.headers.get("content-type") || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename=\"${ver}.bin\"`);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("ETag", `sha256-${sha}`);
      res.setHeader("Accept-Ranges", "none");
      res.setHeader("Content-Length", String(buf.length));
      return res.send(buf);
    } catch (e) {
      console.error("[otaProxy] firmware error:", e?.message || e);
      res.status(500).send("proxy_failed");
    }
  });

  // HEAD /api/ota/firmware/:version -> headers only
  router.head("/firmware/:version", async (req, res) => {
    try {
      const ver = safeVersion(req.params.version || "");
      if (!ver) return res.sendStatus(400);
      const localPath = path.join(firmwareDir, `${ver}.bin`);
      if (fs.existsSync(localPath)) {
        const st = fs.statSync(localPath);
        let sha = shaCache.get(ver);
        if (!sha) { try { sha = sha256Hex(fs.readFileSync(localPath)); shaCache.set(ver, sha); } catch {}
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename=\"${ver}.bin\"`);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        if (sha) res.setHeader("ETag", `sha256-${sha}`);
        res.setHeader("Accept-Ranges", "none");
        res.setHeader("Content-Length", String(st.size));
        return res.status(200).end();
      }

      // Probe dashboard with a HEAD (best effort)
      const url = `${DASHBOARD_BASE}/api/devices/firmware/${encodeURIComponent(ver)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("timeout"), 8000);
      const resp = await fetch(url, {
        method: "HEAD",
        headers: DASHBOARD_SERVICE_TOKEN ? { "X-Service-Token": DASHBOARD_SERVICE_TOKEN } : undefined,
        signal: controller.signal,
      }).catch((e) => { throw e; });
      clearTimeout(timeout);

      if (!resp?.ok) return res.sendStatus(resp?.status || 404);
      res.setHeader("Content-Type", resp.headers.get("content-type") || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename=\"${ver}.bin\"`);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      const cl = resp.headers.get("content-length"); if (cl) res.setHeader("Content-Length", cl);
      res.setHeader("ETag", `W/\"ver-${ver}\"`);
      res.setHeader("Accept-Ranges", "none");
      return res.status(200).end();
    } catch (e) {
      console.error("[otaProxy] firmware HEAD error:", e?.message || e);
      return res.sendStatus(500);
    }
  });


  return router;
}

