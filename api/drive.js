import {
  handleDriveLogin,
  handleDriveLogout,
  handleDrivePull,
  handleDrivePush,
  handleDriveStatus,
} from '../server/driveHandler.js';

function applyCookies(res, cookies) {
  if (Array.isArray(cookies) && cookies.length > 0) {
    res.setHeader('Set-Cookie', cookies);
  }
}

function getAction(req) {
  if (req.query?.action) return String(req.query.action);
  if (typeof req.url === 'string') {
    const parsed = new URL(req.url, 'http://localhost');
    return parsed.searchParams.get('action') || '';
  }
  return '';
}

/**
 * Vercel Serverless Function 入口（對應 /api/drive）
 * 支援 action=status | login | pull | push | logout
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = getAction(req);

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

  if (action === 'logout') {
    const result = handleDriveLogout({ headers: req.headers });
    applyCookies(res, result.cookies);
    return res.status(result.statusCode).json(result.body);
  }

  if (action === 'push') {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: 'INVALID_JSON', message: '請求內容非有效 JSON' });
      }
    }
    const result = await handleDrivePush({ body, headers: req.headers, env: process.env });
    applyCookies(res, result.cookies);
    return res.status(result.statusCode).json(result.body);
  }

  return res.status(400).json({ error: 'UNKNOWN_ACTION', message: '不支援的操作類型' });
}
