import express from "express";
import crypto from "crypto";
import { getDeviceOwner, setUserPassword } from "../db.mjs";

// Simple header token guard shared by admin endpoints
function requireServiceToken(req){
  const valid = [
    process.env.DASHBOARD_SERVICE_TOKEN,
    process.env.SERVICE_TOKEN,
  ].filter(Boolean);
  const tok = (req.header('X-Service-Token') || req.header('x-service-token') || '').toString();
  if (valid.length === 0) return true; // dev mode
  return valid.includes(tok);
}

function genTempPassword(){
  return crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,10);
}

export function adminRoutes(){
  const router = express.Router();
  router.use(express.json({ limit:'50kb' }));

  router.get('/devices/:mac/owner', async (req, res) => {
    if (!requireServiceToken(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
    const mac = String(req.params.mac||'');
    const username = await getDeviceOwner(mac);
    return res.json({ ok:true, mac, username: username || null });
  });

  router.post('/devices/:mac/reset-password', async (req, res) => {
    if (!requireServiceToken(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
    const mac = String(req.params.mac||'');
    const username = await getDeviceOwner(mac);
    if (!username) return res.status(404).json({ ok:false, error:'unclaimed' });
    const temp = genTempPassword();
    const { hashPassword } = await import('../utils/auth.mjs');
    const ok = await setUserPassword(username, hashPassword(temp));
    if (!ok) return res.status(500).json({ ok:false, error:'reset_failed' });
    return res.json({ ok:true, username, tempPassword: temp });
  });

  return router;
}

