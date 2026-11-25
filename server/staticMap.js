import { parseOptionalFiniteNumber } from './security.js';

const GOOGLE_STATIC_MAP_ENDPOINT = 'https://maps.googleapis.com/maps/api/staticmap';
const ALLOWED_LANG_RE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,4})?$/;

function clampInt(val, min, max, fallback) {
  const n = parseOptionalFiniteNumber(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 透過伺服器端代理呼叫 Google Maps Static API，回傳 2x 高解析 PNG Base64 Data URL
 * 僅傳遞乾淨底圖座標與縮放級別，避開 URL 8KB 上限與 10 號以上標點限制，
 * 同時完整保留 Google 原生版權浮水印且絕不暴露伺服器端 API 金鑰。
 */
export async function handleStaticMapRequest(body, env = process.env) {
  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  if (!apiKey) {
    return {
      statusCode: 200,
      body: {
        status: 'unconfigured',
        provider: 'none',
        message: '伺服器尚未設定 GOOGLE_MAPS_API_KEY，前端將改用開放地圖圖磚。',
      },
    };
  }

  const lat = parseOptionalFiniteNumber(body?.lat);
  const lng = parseOptionalFiniteNumber(body?.lng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -85 ||
    lat > 85 ||
    lng < -180 ||
    lng > 180
  ) {
    return {
      statusCode: 400,
      body: {
        status: 'invalid_request',
        error: 'INVALID_COORDS',
        message: '中心座標格式不正確。',
      },
    };
  }

  const zoom = clampInt(body?.zoom, 1, 20, 13);
  const width = clampInt(body?.width, 200, 640, 620);
  const height = clampInt(body?.height, 120, 640, 248);
  const rawLang = typeof body?.language === 'string' ? body.language.trim() : 'zh-TW';
  const language = ALLOWED_LANG_RE.test(rawLang) ? rawLang : 'zh-TW';

  const params = new URLSearchParams({
    center: `${lat.toFixed(6)},${lng.toFixed(6)}`,
    zoom: String(zoom),
    size: `${width}x${height}`,
    scale: '2',
    format: 'png',
    maptype: 'roadmap',
    language,
    key: apiKey,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`${GOOGLE_STATIC_MAP_ENDPOINT}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'image/png,image/*;q=0.8' },
      signal: controller.signal,
    });

    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (!res.ok || !contentType.startsWith('image/')) {
      const reason =
        res.status === 403
          ? 'STATIC_MAP_FORBIDDEN'
          : res.status === 429
            ? 'STATIC_MAP_QUOTA'
            : 'STATIC_MAP_UPSTREAM_ERROR';
      return {
        statusCode: 200,
        body: {
          status: 'unavailable',
          provider: 'google',
          reason,
          message: 'Google Maps Static API 尚未啟用或暫時無法取得底圖，將自動改用開放地圖圖磚。',
        },
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 256 || buf.length > 5 * 1024 * 1024) {
      return {
        statusCode: 200,
        body: {
          status: 'unavailable',
          provider: 'google',
          reason: 'STATIC_MAP_EMPTY',
          message: '靜態地圖影像內容異常，將自動改用開放地圖圖磚。',
        },
      };
    }

    const mime = contentType.includes('jpeg') || contentType.includes('jpg') ? 'image/jpeg' : 'image/png';
    return {
      statusCode: 200,
      body: {
        status: 'ok',
        provider: 'google',
        width: width * 2,
        height: height * 2,
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      },
    };
  } catch (err) {
    return {
      statusCode: 200,
      body: {
        status: 'unavailable',
        provider: 'google',
        reason: err?.name === 'AbortError' ? 'STATIC_MAP_TIMEOUT' : 'STATIC_MAP_NETWORK_ERROR',
        message: '靜態地圖連線逾時，將自動改用開放地圖圖磚。',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
