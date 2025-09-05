import express from "express";

// Minimal device-ingest API for ESP32 devices.
// - POST /api/devices/register-public
//   Body: { mac, chipId, model, firmware, uptime, rssi, firstSeen }
// - Optional auth: header X-Service-Token must equal process.env.DEVICES_SERVICE_TOKEN (if set)
// - Optional forward: if process.env.DASHBOARD_FORWARD_URL is set, forward the payload
//   with header X-Service-Token: process.env.DASHBOARD_SERVICE_TOKEN
//
// Keep this tiny and device-friendly. Return a small JSON with ok plus any hints
// (e.g., featureFlags, otaUrl) in the future.

export function devicesIngest() {
  const routes = express.Router();

  // Limit just this route if desired (global body parser is already applied)
  routes.use(express.json({ limit: "100kb" }));

  routes.post("/register-public", async (req, res) => {
    try {
      // Optional incoming token check
      const requiredToken = process.env.DEVICES_SERVICE_TOKEN;
      if (requiredToken) {
        const headerToken = req.header("X-Service-Token") || req.header("x-service-token");
        if (!headerToken || headerToken !== requiredToken) {
          return res.status(401).json({ ok: false, error: "unauthorized" });
        }
      }

      const {
        mac = "",
        chipId = "",
        model = "",
        firmware = "",
        uptime = 0,
        rssi = null,
        firstSeen = Date.now()
      } = req.body || {};

      if (!mac || !chipId) {
        return res.status(400).json({ ok: false, error: "mac and chipId required" });
      }

      const payload = {
        mac,
        chipId,
        model,
        firmware,
        uptime,
        rssi,
        firstSeen,
        serverTs: Date.now(),
      };

      // Optional forward to dashboard/backoffice
      const forwardUrl = process.env.DASHBOARD_FORWARD_URL; // e.g., https://calcai-management-dashboard.vercel.app/api/devices/register-ingest
      const forwardToken = process.env.DASHBOARD_SERVICE_TOKEN; // server-to-server token expected by dashboard

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
            body: JSON.stringify(payload),
          });
          forwardCode = resp.status;
          forwarded = resp.ok;
        } catch (e) {
          console.error("[devices] forward error:", e?.message || e);
        }
      }

      // Respond to device with a tiny JSON; keep it parsable
      return res.json({ ok: true, forwarded, forwardCode });
    } catch (e) {
      console.error("[devices] ingest error:", e?.message || e);
      return res.status(500).json({ ok: false });
    }
  });

  return routes;
}

