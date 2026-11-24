import { handleDriveCallback } from '../server/driveHandler.js';

/**
 * Vercel Serverless Function 入口（對應 /api/drive-callback）
 * 作為 Google OAuth 2.0 授權後的固定回呼網址（不含 query 參數，符合 Google Cloud Console 規範）
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: '僅支援 GET 回呼請求' });
  }

  const parsed = new URL(req.url || '/', 'http://localhost');
  const query = {
    code: req.query?.code || parsed.searchParams.get('code') || '',
    state: req.query?.state || parsed.searchParams.get('state') || '',
    error: req.query?.error || parsed.searchParams.get('error') || '',
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
}
