import express from "express";
import { resolvePairCode } from "../db.mjs";
import { createUser, getUserByUsername, setDeviceOwner, isDeviceClaimed, getUserDevices } from "../db.mjs";
import { hashPassword, verifyPassword } from "../utils/auth.mjs";
import { signToken, verifyToken } from "../utils/token.mjs";

export function authRoutes(){
  const router = express.Router();

  // POST /api/auth/register  { code, username, password }
  router.post('/register', async (req, res) => {
    try {
      const code = String(req.body?.code || '').trim().toUpperCase();
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      if (!code || !username || !password) return res.status(400).json({ ok:false, error:'missing_fields' });

      const mac = await resolvePairCode(code);
      if (!mac) return res.status(404).json({ ok:false, error:'invalid_code' });

      const claimed = await isDeviceClaimed(mac);
      if (claimed) return res.status(409).json({ ok:false, error:'already_claimed', mac });

      // If user exists, verify password; else create user
      const existing = await getUserByUsername(username);
      if (existing) {
        const ok = verifyPassword(password, existing.password_hash);
        if (!ok) return res.status(403).json({ ok:false, error:'bad_credentials' });
      } else {
        const h = hashPassword(password);
        const cr = await createUser(username, h);
        if (!cr.ok) return res.status(409).json({ ok:false, error: cr.error || 'username_taken' });
      }

      const okSet = await setDeviceOwner(mac, username);
      if (!okSet) return res.status(500).json({ ok:false, error:'claim_failed' });

      const macs = await getUserDevices(username);
      const token = signToken({ sub: username, macs, exp: Date.now() + 7*24*60*60*1000 });
      return res.json({ ok:true, mac, macs, token, username });
    } catch (e) {
      return res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  // POST /api/auth/login  { username, password }
  router.post('/login', async (req, res) => {
    try {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      if (!username || !password) return res.status(400).json({ ok:false, error:'missing_fields' });
      const u = await getUserByUsername(username);
      if (!u) return res.status(403).json({ ok:false, error:'bad_credentials' });
      const ok = verifyPassword(password, u.password_hash);
      if (!ok) return res.status(403).json({ ok:false, error:'bad_credentials' });
      const macs = await getUserDevices(username);
      const token = signToken({ sub: username, macs, exp: Date.now() + 7*24*60*60*1000 });
      return res.json({ ok:true, username, macs, token });
    } catch (e) {
      return res.status(500).json({ ok:false, error:'server_error' });
    }
  });

  // GET /api/auth/whoami  (Authorization: Bearer)
  router.get('/whoami', async (req, res) => {
    const auth = String(req.header('authorization') || '');
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const payload = tok ? verifyToken(tok) : null;
    if (!payload) return res.status(401).json({ ok:false, error:'unauthorized' });
    return res.json({ ok:true, username: payload.sub, macs: payload.macs || [] });
  });

  return router;
}

