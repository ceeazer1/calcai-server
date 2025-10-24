import crypto from "crypto";

// Password hashing using PBKDF2 (no extra deps). Format:
// pbkdf2$<iterations>$<salt_b64>$<hash_b64>
const DEFAULT_ITERS = 120000;
const KEYLEN = 32;
const DIGEST = "sha256";

export function hashPassword(password, iterations = DEFAULT_ITERS) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, iterations, KEYLEN, DIGEST);
  return `pbkdf2$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const s = String(stored || '');
    const parts = s.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10) || DEFAULT_ITERS;
    const salt = Buffer.from(parts[2], 'base64');
    const expected = Buffer.from(parts[3], 'base64');
    const actual = crypto.pbkdf2Sync(String(password || ''), salt, iterations, expected.length, DIGEST);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

