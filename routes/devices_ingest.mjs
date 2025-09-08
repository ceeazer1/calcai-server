import express from "express";
import { getDevices, saveDevices, upsertDevice, setUpdateFlags, pingDevice } from "./devices_store.mjs";

// Device-ingest API for ESP32 devices (public from device) and simple admin helpers
// - POST /api/devices/register-public
//   Body: { mac, chipId, model, firmware, uptime, rssi, firstSeen }
//   Idempotent: upserts into persistent store on Fly (devices.json)
// - POST /api/devices/ping-public       (token optional) marks lastSeen and update status by MAC
// - GET  /api/devices/list-public       (token optional, returns devices)
// - PUT  /api/devices/update/:deviceId  (token required, set update flags)
// - Optional forward: if process.env.DASHBOARD_FORWARD_URL is set, forward the payload
//   with header X-Service-Token: process.env.DASHBOARD_SERVICE_TOKEN

export function devicesIngest() {
  const routes = express.Router();
  routes.use(express.json({ limit: "200kb" }));

  // Public device register/upsert (token optional but recommended)
  routes.post("/register-public", async (req, res) => {
    try {
      const requiredToken = process.env.DEVICES_SERVICE_TOKEN;
      if (requiredToken) {
        const headerToken = req.header("X-Service-Token") || req.header("x-service-token");
        if (!headerToken || headerToken !== requiredToken) {
          return res.status(401).json({ ok: false, error: "unauthorized" });
        }
      }

      const { mac = "", chipId = "", model = "", firmware = "", firstSeen = Date.now() } = req.body || {};
      if (!mac || !chipId) {
        return res.status(400).json({ ok: false, error: "mac and chipId required" });
      }

      // Upsert into Fly server persistent store
      const { deviceId, device } = upsertDevice({ mac, chipId, model, firmware, firstSeen });

      // Optional forward to dashboard/backoffice
      // Derive URL from MANAGEMENT_DASHBOARD_BASE if DASHBOARD_FORWARD_URL not provided
      const derivedBase = (process.env.MANAGEMENT_DASHBOARD_BASE || "").replace(/\/+$/,'');
      const forwardUrl = process.env.DASHBOARD_FORWARD_URL || (derivedBase ? `${derivedBase}/api/devices/register-ingest` : null);
      // Prefer DASHBOARD_SERVICE_TOKEN, else fall back to DEVICES_SERVICE_TOKEN so a single token can be used
      const forwardToken = process.env.DASHBOARD_SERVICE_TOKEN || process.env.DEVICES_SERVICE_TOKEN;
      let forwarded = false;
      let forwardCode = null;
      if (forwardUrl) {
        try {
          const resp = await fetch(forwardUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(forwardToken ? { "X-Service-Token": forwardToken } : {}),
            },
            body: JSON.stringify({ mac, chipId, model, firmware, firstSeen }),
          });
          forwardCode = resp.status;
          forwarded = resp.ok;
        } catch (e) {
          console.error("[devices] forward error:", e?.message || e);
        }
      }

      return res.json({ ok: true, deviceId, forwarded, forwardCode });
    } catch (e) {
      console.error("[devices] ingest error:", e?.message || e);
      return res.status(500).json({ ok: false });
    }
  });

  // Public ping (token optional): update lastSeen/firmware by MAC without re-registering
  routes.post("/ping-public", (req, res) => {
    const requiredToken = process.env.DEVICES_SERVICE_TOKEN;
    if (requiredToken) {
      const headerToken = req.header("X-Service-Token") || req.header("x-service-token");
      if (!headerToken || headerToken !== requiredToken) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }
    const { mac = "", firmware = null, rssi = null } = req.body || {};
    if (!mac) return res.status(400).json({ ok: false, error: "mac_required" });
    const result = pingDevice({ mac, firmware, rssi });
    if (!result.ok && result.notFound) return res.status(404).json({ ok: false, error: "not_registered" });
    return res.json({ ok: true, deviceId: result.deviceId, device: result.device });
  });

  // Public list (token optional)
  routes.get("/list-public", (req, res) => {
    const requiredToken = process.env.DEVICES_SERVICE_TOKEN;
    if (requiredToken) {
      const headerToken = req.header("X-Service-Token") || req.header("x-service-token");
      if (!headerToken || headerToken !== requiredToken) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }
    const devices = getDevices();
    // Mark offline if older than 5 minutes
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    Object.values(devices).forEach(d => {
      if (new Date(d.lastSeen).getTime() < fiveMinutesAgo) d.status = 'offline';
    });
    saveDevices(devices);
    res.json(devices);
  });

  // Admin: set update flags on device (token required)
  routes.put("/update/:deviceId", (req, res) => {
    const requiredToken = process.env.DEVICES_SERVICE_TOKEN;
    const headerToken = req.header("X-Service-Token") || req.header("x-service-token");
    if (requiredToken && headerToken !== requiredToken) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const { deviceId } = req.params;
    const { updateAvailable, targetFirmware } = req.body || {};
    const ok = setUpdateFlags(deviceId, { updateAvailable, targetFirmware });
    if (!ok) return res.status(404).json({ ok: false, error: "not_found" });
    const devices = getDevices();
    res.json({ ok: true, device: devices[deviceId] });
  });

  // Admin: set update flags for ALL devices (token required)
  routes.post("/update-all", (req, res) => {
    const requiredToken = process.env.DEVICES_SERVICE_TOKEN;
    const headerToken = req.header("X-Service-Token") || req.header("x-service-token");
    if (requiredToken && headerToken !== requiredToken) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const { version } = req.body || {};
    if (!version) return res.status(400).json({ ok: false, error: "version_required" });
    const devices = getDevices();
    let count = 0;
    Object.keys(devices || {}).forEach(id => {
      const ok = setUpdateFlags(id, { updateAvailable: true, targetFirmware: version });
      if (ok) count++;
    });
    return res.json({ ok: true, devicesUpdated: count });
  });

  return routes;
}
