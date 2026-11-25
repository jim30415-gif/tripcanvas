import {
  handleDriveLogin,
  handleDriveLogout,
  handleDrivePull,
  handleDrivePush,
  handleDriveStatus,
} from '../server/driveHandler.js';
import {
  checkRateLimit,
  checkSameOriginRequest,
  extractClientIp,
  isJsonContentType,
} from '../server/security.js';

function applyCookies(res, cookies) {
  if (Array.isArray(cookies) && cookies.length > 0) {
    res.setHeader('Set-Cookie', cookies);
  }
}

function getAction(req) {
  try {
    if (typeof req.url === 'string' && req.url) {
      const parsed = new URL(req.url, 'http://localhost');
      const fromUrl = parsed.searchParams.get('action');
      if (fromUrl) return fromUrl;
    }
  } catch {
    // fallback below
  }
  const raw = req.query?.action;
  return Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
}

/**
 * Vercel Serverless Function 入口（對應 /api/drive）
 * 支援 action=status | login | pull | push | logout
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    const action = getAction(req);
    const ip = extractClientIp(req.headers);

    if (req.method === 'GET') {
      if (action === 'login') {
        const result = handleDriveLogin({ headers: req.headers, env: process.env });
        applyCookies(res, result.cookies);
        res.statusCode = result.statusCode;
        res.setHeader('Location', result.redirectUrl);
        res.end();
        return;
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (action === 'pull') {
        const rate = checkRateLimit('drive_pull', ip, 40, 60_000);
        if (!rate.allowed) {
          res.setHeader('Retry-After', String(rate.retryAfterSec));
          return res.status(rate.statusCode).json(rate.body);
        }
        const result = await handleDrivePull({ headers: req.headers, env: process.env });
        applyCookies(res, result.cookies);
        return res.status(result.statusCode).json(result.body);
      }

      const result = handleDriveStatus({ headers: req.headers, env: process.env });
      applyCookies(res, result.cookies);
      return res.status(result.statusCode).json(result.body);
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: '僅支援 GET / POST 請求' });
    }

    const originCheck = checkSameOriginRequest(req.headers, process.env, { requireBrowserSignal: true });
    if (!originCheck.ok) return res.status(originCheck.statusCode).json(originCheck.body);

    if (action === 'logout') {
      const result = handleDriveLogout({ headers: req.headers, env: process.env });
      applyCookies(res, result.cookies);
      return res.status(result.statusCode).json(result.body);
    }

    if (action === 'push') {
      if (!isJsonContentType(req.headers)) {
        return res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE', message: '請使用 application/json 格式上傳同步資料' });
      }
      const rate = checkRateLimit('drive_push', ip, 35, 60_000);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        return res.status(rate.statusCode).json(rate.body);
      }

      let body;
      try {
        body = req.body;
        if (typeof body === 'string') {
          body = JSON.parse(body);
        }
      } catch {
        return res.status(400).json({ error: 'INVALID_JSON', message: '請求內容非有效 JSON' });
      }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'INVALID_JSON', message: '請求內容格式不正確' });
      }

      const result = await handleDrivePush({ body, headers: req.headers, env: process.env });
      applyCookies(res, result.cookies);
      return res.status(result.statusCode).json(result.body);
    }

    return res.status(400).json({ error: 'UNKNOWN_ACTION', message: '不支援的操作類型' });
  } catch (err) {
    console.error('[api/drive] unhandled error:', err?.message || err);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(500).json({ status: 'server_error', error: 'INTERNAL_ERROR', message: '雲端同步服務暫時異常，請稍後再試' });
  }
}
