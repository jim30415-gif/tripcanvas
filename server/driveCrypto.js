import crypto from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * 產生 32-byte AES-256 加密金鑰：
 * 若設定了 SESSION_SECRET 則優先使用；否則由 OAuth Client ID + Secret 穩定推導，
 * 讓使用者在 Vercel 只需填寫 Google OAuth 兩組環境變數即可零額外設定啟用。
 */
export function deriveSessionKey(env = {}) {
  const explicit = (env.SESSION_SECRET || env.DRIVE_SESSION_SECRET || '').trim();
  if (explicit) {
    return crypto.createHash('sha256').update(`tripcanvas-explicit-v1:${explicit}`).digest();
  }
  const clientId = (env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  return crypto
    .createHash('sha256')
    .update(`tripcanvas-drive-cookie-v1:${clientId}:${clientSecret}`)
    .digest();
}

export function encryptJsonPayload(payload, key) {
  if (!key || key.length !== 32) {
    throw new Error('INVALID_SESSION_KEY');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64url');
}

export function decryptJsonPayload(token, key) {
  if (!token || typeof token !== 'string' || !key || key.length !== 32) {
    return null;
  }
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) return null;
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    return null;
  }
}

export function generateRandomHex(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function generatePkcePair() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return result;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

export function serializeCookie(
  name,
  value,
  { maxAge, path = '/', httpOnly = true, sameSite = 'Lax', secure = false } = {}
) {
  const segments = [`${name}=${encodeURIComponent(value ?? '')}`];
  if (typeof maxAge === 'number') {
    segments.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
    if (maxAge <= 0) {
      segments.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    }
  }
  if (path) segments.push(`Path=${path}`);
  if (httpOnly) segments.push('HttpOnly');
  if (sameSite) segments.push(`SameSite=${sameSite}`);
  if (secure) segments.push('Secure');
  return segments.join('; ');
}
