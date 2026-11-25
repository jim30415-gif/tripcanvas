import { handleDriveCallback } from '../server/driveHandler.js';

/**
 * Vercel Serverless Function 入口（對應 /api/drive-callback）
 * 作為 Google OAuth 2.0 授權後的固定回呼網址（不含 query 參數，符合 Google Cloud Console 規範）
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: '僅支援 GET 回呼請求' });
  }

  try {
    let parsed;
    try {
      parsed = new URL(typeof req.url === 'string' && req.url ? req.url : '/', 'http://localhost');
    } catch {
      parsed = new URL('/', 'http://localhost');
    }

    const pick = (key) => {
      const fromUrl = parsed.searchParams.get(key);
      if (fromUrl !== null) return fromUrl;
      const raw = req.query?.[key];
      return Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
    };

    const query = {
      code: pick('code'),
      state: pick('state'),
      error: pick('error'),
    };

    const result = await handleDriveCallback({
      query,
      headers: req.headers,
      env: process.env,
    });

    if (Array.isArray(result.cookies) && result.cookies.length > 0) {
      res.setHeader('Set-Cookie', result.cookies);
    }
    res.statusCode = result.statusCode;
    res.setHeader('Location', result.redirectUrl);
    res.end();
  } catch (err) {
    console.error('[api/drive-callback] unhandled error:', err?.message || err);
    res.statusCode = 302;
    res.setHeader('Location', '/?drive_auth=error');
    res.end();
  }
}
