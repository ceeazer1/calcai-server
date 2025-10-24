import crypto from "crypto";

const SECRET = process.env.AUTH_SECRET || process.env.SESSION_SECRET || "calcai-dev-secret";

function b64url(buf){
  return Buffer.from(buf).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function b64urlDecode(str){
  str = String(str||'').replace(/-/g,'+').replace(/_/g,'/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

export function signToken(payload){
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${data}.${sig}`;
}

export function verifyToken(token){
  if (!token || token.indexOf('.') === -1) return null;
  const [h, p, s] = token.split('.');
  const data = `${h}.${p}`;
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
  if (s !== expected) return null;
  try {
    const payload = JSON.parse(b64urlDecode(p).toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

