import {
  handleComputeRoutes,
  handleRatesRequest,
  handleReverseGeocode,
  handleSearchPlaces,
  handleStatusRequest,
} from '../server/routesHandler.js';

/**
 * Vercel Serverless Function 入口（對應 /api/routes）
 * 本地開發則由 vite.config.js 的 dev middleware 掛載同一份 server/routesHandler.js，確保開發與上線行為 100% 一致。
 */
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const wantsSearch =
      req.query?.search === '1' ||
      req.query?.action === 'search' ||
      (typeof req.url === 'string' && /[?&](search=1|action=search)\b/.test(req.url));
    if (wantsSearch) {
      const parsed = new URL(req.url || '', 'http://localhost');
      const result = await handleSearchPlaces(
        {
          q: req.query?.q ?? parsed.searchParams.get('q') ?? '',
          lat: req.query?.lat ?? parsed.searchParams.get('lat'),
          lng: req.query?.lng ?? parsed.searchParams.get('lng'),
          country: req.query?.country ?? parsed.searchParams.get('country') ?? '',
        },
        process.env
      );
      return res.status(result.statusCode).json(result.body);
    }

    const wantsReverse =
      req.query?.reverse === '1' ||
      req.query?.action === 'reverse' ||
      (typeof req.url === 'string' && /[?&](reverse=1|action=reverse)\b/.test(req.url));
    if (wantsReverse) {
      const parsed = new URL(req.url || '', 'http://localhost');
      const lat = req.query?.lat ?? parsed.searchParams.get('lat');
      const lng = req.query?.lng ?? parsed.searchParams.get('lng');
      const zoom = req.query?.zoom ?? parsed.searchParams.get('zoom');
      const result = await handleReverseGeocode(lat, lng, process.env, zoom);
      return res.status(result.statusCode).json(result.body);
    }

    const wantsRates =
      req.query?.rates === '1' ||
      req.query?.action === 'rates' ||
      (typeof req.url === 'string' && /[?&](rates=1|action=rates)\b/.test(req.url));
    if (wantsRates) {
      res.setHeader('Cache-Control', 'public, max-age=1800');
      const result = await handleRatesRequest();
      return res.status(result.statusCode).json(result.body);
    }
    const result = handleStatusRequest(process.env);
    return res.status(result.statusCode).json(result.body);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: '僅支援 GET / POST 請求' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'INVALID_JSON', message: '請求內容非有效 JSON' });
    }
  }

  const result = await handleComputeRoutes(body, process.env);
  return res.status(result.statusCode).json(result.body);
}
