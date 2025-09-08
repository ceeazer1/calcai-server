import express from "express";
import { getDevices } from "./devices_store.mjs";
import fs from "fs";
import path from "path";


// OTA proxy routes: ESP talks to Fly.io server; we forward to the Vercel dashboard
export function otaProxy() {
  const router = express.Router();

  // Simple auth check using a shared service token (optional but recommended)
  function checkToken(req, res) {
    const requiredToken = process.env.DEVICES_SERVICE_TOKEN;
    if (!requiredToken) return true;
    const headerToken = req.header("X-Service-Token") || req.header("x-service-token");
    if (!headerToken || headerToken !== requiredToken) {
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
  try { if (!fs.existsSync(firmwareDir)) fs.mkdirSync(firmwareDir, { recursive: true }); } catch {}

  // Use local device store on Fly for update metadata, so devices persist and don't disappear

  // Optional token to fetch firmware from dashboard (if it requires auth)
  const DASHBOARD_SERVICE_TOKEN = process.env.DASHBOARD_SERVICE_TOKEN || process.env.DEVICES_SERVICE_TOKEN || null;

  // Use local device store on Fly for update metadata, so devices persist and don't disappear

  // GET /api/ota/check-update/:deviceId?currentVersion=...
  router.get("/check-update/:deviceId", async (req, res) => {
    if (!checkToken(req, res)) return;
    try {
      const { deviceId } = req.params;
      const currentVersion = req.query.currentVersion || "";

      const devices = getDevices();
      const dev = devices[deviceId];
      if (!dev) {
        return res.status(404).json({ error: "Device not found" });
      }

      // Update lastSeen and firmware if provided
      if (currentVersion) {
        dev.firmware = currentVersion;
      }
      dev.lastSeen = new Date().toISOString();
      // No write here to keep this route read-mostly; it's fine to skip persistence

      if (dev.updateAvailable && dev.targetFirmware) {
        return res.json({
          updateAvailable: true,
          version: dev.targetFirmware,
          downloadUrl: `/api/ota/firmware/${encodeURIComponent(dev.targetFirmware)}`,
        });
      }
      return res.json({ updateAvailable: false });
    } catch (e) {
      console.error("[otaProxy] check-update error:", e?.message || e);
      res.status(500).json({ ok: false, error: "proxy_failed" });
    }
  });

  // POST /api/ota/firmware/upload  { version, dataBase64 }
  router.post("/firmware/upload", async (req, res) => {
    if (!checkToken(req, res)) return;
    try {
      const { version, dataBase64 } = req.body || {};
      if (!version || !dataBase64) {
        return res.status(400).json({ ok: false, error: "version_and_data_required" });
      }
      const safeVer = String(version).replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(firmwareDir, `${safeVer}.bin`);
      const buf = Buffer.from(dataBase64, 'base64');
      fs.writeFileSync(filePath, buf);
      return res.json({ ok: true, version: safeVer, size: buf.length });
    } catch (e) {
      console.error("[otaProxy] firmware upload error:", e?.message || e);
      res.status(500).json({ ok: false, error: "upload_failed" });
    }
  });

  // GET /api/ota/firmware/:version -> serve local if present; else stream from dashboard
  router.get("/firmware/:version", async (req, res) => {
    if (!checkToken(req, res)) return;
    try {
      const { version } = req.params;
      const localPath = path.join(firmwareDir, `${version}.bin`);
      if (fs.existsSync(localPath)) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${version}.bin"`);
        return res.sendFile(path.resolve(localPath));
      }

      const url = `${DASHBOARD_BASE}/api/devices/firmware/${encodeURIComponent(version)}`;
      const resp = await fetch(url, {
        headers: DASHBOARD_SERVICE_TOKEN ? { "X-Service-Token": DASHBOARD_SERVICE_TOKEN } : undefined,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return res.status(resp.status).send(text || "failed to fetch firmware");
      }

      const ct = resp.headers.get("content-type") || "application/octet-stream";
      const cl = resp.headers.get("content-length");
      res.setHeader("Content-Type", ct);
      if (cl) res.setHeader("Content-Length", cl);
      res.setHeader("Content-Disposition", `attachment; filename="${version}.bin"`);

      const reader = resp.body;
      reader.pipe(res);
    } catch (e) {
      console.error("[otaProxy] firmware error:", e?.message || e);
      res.status(500).send("proxy_failed");
    }
  });

  return router;
}

