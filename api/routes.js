import {
  handleComputeRoutes,
  handlePlaceDetails,
  handleRatesRequest,
  handleReverseGeocode,
  handleSearchPlaces,
  handleStatusRequest,
} from '../server/routesHandler.js';
import { handleStaticMapRequest } from '../server/staticMap.js';
import {
  checkRateLimit,
  checkSameOriginRequest,
  extractClientIp,
  isJsonContentType,
} from '../server/security.js';

function parseSafeUrl(rawUrl) {
  try {
    return new URL(typeof rawUrl === 'string' && rawUrl ? rawUrl : '/', 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

function getSingleParam(parsedUrl, queryObj, key) {
  const fromUrl = parsedUrl.searchParams.get(key);
  if (fromUrl !== null) return fromUrl;
  const raw = queryObj?.[key];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

/**
 * Vercel Serverless Function 入口（對應 /api/routes）
 * 本地開發則由 vite.config.js 的 dev middleware 掛載同一份 server/routesHandler.js，確保開發與上線行為 100% 一致。
 */
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const parsed = parseSafeUrl(req.url);
    const ip = extractClientIp(req.headers);

    if (req.method === 'GET') {
      const action = getSingleParam(parsed, req.query, 'action') || '';
      const wantsPlace = getSingleParam(parsed, req.query, 'place') === '1' || action === 'place';
      if (wantsPlace) {
        const originCheck = checkSameOriginRequest(req.headers, process.env, { requireBrowserSignal: true });
        if (!originCheck.ok) return res.status(originCheck.statusCode).json(originCheck.body);
        const rate = checkRateLimit('routes_place', ip, 60, 60_000);
        if (!rate.allowed) {
          res.setHeader('Retry-After', String(rate.retryAfterSec));
          return res.status(rate.statusCode).json(rate.body);
        }
        const placeId = getSingleParam(parsed, req.query, 'placeId') || '';
        const result = await handlePlaceDetails(placeId, process.env);
        return res.status(result.statusCode).json(result.body);
      }

      const wantsSearch = getSingleParam(parsed, req.query, 'search') === '1' || action === 'search';
      if (wantsSearch) {
        const originCheck = checkSameOriginRequest(req.headers, process.env, { requireBrowserSignal: true });
        if (!originCheck.ok) return res.status(originCheck.statusCode).json(originCheck.body);
        const rate = checkRateLimit('routes_search', ip, 45, 60_000);
        if (!rate.allowed) {
          res.setHeader('Retry-After', String(rate.retryAfterSec));
          return res.status(rate.statusCode).json(rate.body);
        }
        const result = await handleSearchPlaces(
          {
            q: getSingleParam(parsed, req.query, 'q') || '',
            lat: getSingleParam(parsed, req.query, 'lat'),
            lng: getSingleParam(parsed, req.query, 'lng'),
            country: getSingleParam(parsed, req.query, 'country') || '',
          },
          process.env
        );
        return res.status(result.statusCode).json(result.body);
      }

      const wantsReverse = getSingleParam(parsed, req.query, 'reverse') === '1' || action === 'reverse';
      if (wantsReverse) {
        const originCheck = checkSameOriginRequest(req.headers, process.env, { requireBrowserSignal: true });
        if (!originCheck.ok) return res.status(originCheck.statusCode).json(originCheck.body);
        const rate = checkRateLimit('routes_reverse', ip, 45, 60_000);
        if (!rate.allowed) {
          res.setHeader('Retry-After', String(rate.retryAfterSec));
          return res.status(rate.statusCode).json(rate.body);
        }
        const lat = getSingleParam(parsed, req.query, 'lat');
        const lng = getSingleParam(parsed, req.query, 'lng');
        const zoom = getSingleParam(parsed, req.query, 'zoom');
        const result = await handleReverseGeocode(lat, lng, process.env, zoom);
        return res.status(result.statusCode).json(result.body);
      }

      const wantsRates = getSingleParam(parsed, req.query, 'rates') === '1' || action === 'rates';
      if (wantsRates) {
        const result = await handleRatesRequest();
        const cacheHeader =
          result.body?.source === 'live'
            ? 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=3600'
            : 'public, max-age=60';
        res.setHeader('Cache-Control', cacheHeader);
        return res.status(result.statusCode).json(result.body);
      }

      const result = handleStatusRequest(process.env);
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
      return res.status(result.statusCode).json(result.body);
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: '僅支援 GET / POST 請求' });
    }

    const originCheck = checkSameOriginRequest(req.headers, process.env, { requireBrowserSignal: true });
    if (!originCheck.ok) return res.status(originCheck.statusCode).json(originCheck.body);

    if (!isJsonContentType(req.headers)) {
      return res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE', message: '請使用 application/json 格式提交請求' });
    }

    const postAction = getSingleParam(parsed, req.query, 'action') || '';
    const isStaticMap = postAction === 'staticmap';
    const rate = isStaticMap
      ? checkRateLimit('routes_staticmap', ip, 30, 60_000)
      : checkRateLimit('routes_post', ip, 40, 60_000);
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

    const result = isStaticMap
      ? await handleStaticMapRequest(body, process.env)
      : await handleComputeRoutes(body, process.env);
    return res.status(result.statusCode).json(result.body);
  } catch (err) {
    console.error('[api/routes] unhandled error:', err?.message || err);
    return res.status(500).json({ status: 'server_error', error: 'INTERNAL_ERROR', message: '路線服務暫時發生異常，請稍後再試' });
  }
}
