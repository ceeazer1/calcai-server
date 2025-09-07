import express from "express";

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

  // Base URL of the dashboard that stores firmware files and update metadata
  const DASHBOARD_BASE = process.env.MANAGEMENT_DASHBOARD_BASE || "https://calcai-management-dashboard.vercel.app";

  // GET /api/ota/check-update/:deviceId?currentVersion=...
  router.get("/check-update/:deviceId", async (req, res) => {
    if (!checkToken(req, res)) return;
    try {
      const { deviceId } = req.params;
      const currentVersion = encodeURIComponent(req.query.currentVersion || "");
      const url = `${DASHBOARD_BASE}/api/devices/check-update/${deviceId}?currentVersion=${currentVersion}`;

      const resp = await fetch(url, { method: "GET" });
      const status = resp.status;
      const json = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        return res.status(status).json(json);
      }

      // Normalize downloadUrl to point back through this server for the binary
      if (json && json.updateAvailable && json.version) {
        json.downloadUrl = `/api/ota/firmware/${encodeURIComponent(json.version)}`;
      }

      res.json(json);
    } catch (e) {
      console.error("[otaProxy] check-update error:", e?.message || e);
      res.status(500).json({ ok: false, error: "proxy_failed" });
    }
  });

  // GET /api/ota/firmware/:version -> stream the .bin from dashboard
  router.get("/firmware/:version", async (req, res) => {
    if (!checkToken(req, res)) return;
    try {
      const { version } = req.params;
      const url = `${DASHBOARD_BASE}/api/devices/firmware/${encodeURIComponent(version)}`;

      const resp = await fetch(url);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return res.status(resp.status).send(text || "failed to fetch firmware");
      }

      // Mirror headers for content type/length if available
      const ct = resp.headers.get("content-type") || "application/octet-stream";
      const cl = resp.headers.get("content-length");
      res.setHeader("Content-Type", ct);
      if (cl) res.setHeader("Content-Length", cl);
      res.setHeader("Content-Disposition", `attachment; filename="${version}.bin"`);

      // Stream body
      const reader = resp.body;
      reader.pipe(res);
    } catch (e) {
      console.error("[otaProxy] firmware error:", e?.message || e);
      res.status(500).send("proxy_failed");
    }
  });

  return router;
}

