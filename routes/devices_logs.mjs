import express from "express";

// Device log ingest (public from device) with optional forward to dashboard
export function devicesLogs() {
  const routes = express.Router();
  routes.use(express.json({ limit: "200kb" }));

  routes.post("/logs-public", async (req, res) => {
    try {
      const requiredToken = process.env.DEVICES_SERVICE_TOKEN;
      if (requiredToken) {
        const headerToken = req.header("X-Service-Token") || req.header("x-service-token");
        if (!headerToken || headerToken !== requiredToken) {
          return res.status(401).json({ ok: false, error: "unauthorized" });
        }
      }

      const { mac = "", chipId = "", lines = [] } = req.body || {};
      if (!mac || !Array.isArray(lines)) {
        return res.status(400).json({ ok: false, error: "mac and lines required" });
      }

      // Optional forward to dashboard
      const forwardUrl = process.env.DASHBOARD_LOGS_FORWARD_URL; // e.g., https://calcai-management-dashboard.vercel.app/api/devices/logs-ingest
      const forwardToken = process.env.DASHBOARD_SERVICE_TOKEN;
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
            body: JSON.stringify({ mac, chipId, lines }),
          });
          forwardCode = resp.status;
          forwarded = resp.ok;
        } catch (e) {
          console.error("[logs] forward error:", e?.message || e);
        }
      }

      res.json({ ok: true, forwarded, forwardCode });
    } catch (e) {
      console.error("[logs] ingest error:", e?.message || e);
      res.status(500).json({ ok: false });
    }
  });

  return routes;
}

