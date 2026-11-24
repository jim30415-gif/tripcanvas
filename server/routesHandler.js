import { decodePolyline, encodePolyline, stitchEncodedPolylines } from '../src/services/polyline.js';

const GOOGLE_ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const LAND_FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.distanceMeters',
  'routes.legs.duration',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.polyline.encodedPolyline',
].join(',');

const TRANSIT_FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.distanceMeters',
  'routes.legs.duration',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.polyline.encodedPolyline',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.transitDetails',
  'routes.legs.steps.startLocation',
  'routes.legs.steps.endLocation',
].join(',');

const VEHICLE_META = {
  SUBWAY: { label: '捷運', emoji: '🚇' },
  METRO_RAIL: { label: '地鐵', emoji: '🚇' },
  BUS: { label: '公車', emoji: '🚌' },
  INTERCITY_BUS: { label: '客運', emoji: '🚌' },
  TROLLEYBUS: { label: '無軌電車', emoji: '🚌' },
  SHARE_TAXI: { label: '共乘計程車', emoji: '🚐' },
  HIGH_SPEED_TRAIN: { label: '高鐵', emoji: '🚄' },
  LONG_DISTANCE_TRAIN: { label: '長途鐵路', emoji: '🚆' },
  COMMUTER_TRAIN: { label: '區間列車', emoji: '🚆' },
  HEAVY_RAIL: { label: '鐵路', emoji: '🚆' },
  RAIL: { label: '火車', emoji: '🚆' },
  TRAM: { label: '路面電車', emoji: '🚊' },
  LIGHT_RAIL: { label: '輕軌', emoji: '🚊' },
  MONORAIL: { label: '單軌列車', emoji: '🚝' },
  FERRY: { label: '渡輪', emoji: '⛴️' },
  CABLE_CAR: { label: '纜車', emoji: '🚡' },
  GONDOLA_LIFT: { label: '空中纜車', emoji: '🚡' },
  FUNICULAR: { label: '登山纜車', emoji: '🚞' },
};

const VALID_MODES = new Set(['car', 'scooter', 'bike', 'walk', 'transit']);
const VALID_TRANSIT_PREFS = new Set(['DEFAULT', 'LESS_WALKING', 'FEWER_TRANSFERS']);

function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function parseDurationSeconds(durationStr) {
  if (typeof durationStr === 'number' && Number.isFinite(durationStr)) {
    return Math.max(0, Math.round(durationStr));
  }
  if (typeof durationStr !== 'string') return 0;
  const match = durationStr.match(/^([\d.]+)s$/);
  return match ? Math.max(0, Math.round(Number(match[1]))) : 0;
}

function isValidCoord(pt) {
  return (
    pt &&
    typeof pt.lat === 'number' &&
    typeof pt.lng === 'number' &&
    Number.isFinite(pt.lat) &&
    Number.isFinite(pt.lng) &&
    pt.lat >= -90 &&
    pt.lat <= 90 &&
    pt.lng >= -180 &&
    pt.lng <= 180
  );
}

function normalizeHexColor(color) {
  if (!color || typeof color !== 'string') return '';
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return '';
}

function formatLineDisplayName(lineName, lineShortName) {
  const name = (lineName || '').trim();
  const short = (lineShortName || '').trim();
  if (short && name) {
    if (name === short || name.includes(short)) return name;
    if (short.includes(name)) return short;
    // 若簡稱僅為路線代號（如 BL、R、G），保留完整中文路線名為主
    if (/^[A-Za-z0-9]{1,4}$/.test(short) && /[\u4e00-\u9fff]/.test(name)) {
      return name;
    }
    return short;
  }
  return short || name || '大眾運輸';
}

function validateLandGeometry(coords, origin, destination, distanceMeters) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const straightKm = calcDistanceKm(origin.lat, origin.lng, destination.lat, destination.lng);
  const startErrKm = calcDistanceKm(origin.lat, origin.lng, coords[0][0], coords[0][1]);
  const endErrKm = calcDistanceKm(
    destination.lat,
    destination.lng,
    coords[coords.length - 1][0],
    coords[coords.length - 1][1]
  );
  if (startErrKm > 5 || endErrKm > 5) return false;
  if (straightKm > 0.3 && (!distanceMeters || distanceMeters < 10)) return false;

  for (let i = 1; i < coords.length; i++) {
    const stepKm = calcDistanceKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    if (stepKm > 120) return false;
  }
  return true;
}

export function normalizeLandRoute(route, mode, origin, destination, fallbackNote = '') {
  const leg = route?.legs?.[0];
  const stepPolylines = (leg?.steps || [])
    .map((s) => s?.polyline?.encodedPolyline)
    .filter(Boolean);

  let coords = stitchEncodedPolylines(stepPolylines);
  if (coords.length < 2 && route?.polyline?.encodedPolyline) {
    coords = decodePolyline(route.polyline.encodedPolyline);
  }

  const distanceMeters = Number(route?.distanceMeters ?? leg?.distanceMeters ?? 0);
  if (!validateLandGeometry(coords, origin, destination, distanceMeters)) {
    return null;
  }

  const durationSec = parseDurationSeconds(route?.duration ?? leg?.duration);
  const distanceKm = Number((distanceMeters / 1000).toFixed(2));
  const durationMin = Math.max(1, Math.round(durationSec / 60));
  const encodedPolyline = encodePolyline(coords);

  return {
    status: 'ok',
    provider: 'google',
    mode,
    distanceKm,
    durationMin,
    encodedPolyline,
    fallbackNote,
  };
}

function buildTransitSummary(segments) {
  const parts = [];
  for (const seg of segments) {
    if (seg.type === 'WALK') {
      parts.push(`步行 ${seg.durationMin}分`);
    } else if (seg.type === 'TRANSIT') {
      parts.push(`${seg.vehicleEmoji} ${seg.displayLine}`);
    }
  }
  return parts.join(' → ');
}

export function normalizeTransitRoute(route) {
  const leg = route?.legs?.[0];
  const rawSteps = Array.isArray(leg?.steps) ? leg.steps : [];
  const segments = [];

  let pendingWalk = null;

  const flushWalk = (nextTransitStopName = '') => {
    if (!pendingWalk) return;
    const mergedCoords = stitchEncodedPolylines(pendingWalk.encodedPolylines);
    const durationMin = Math.max(1, Math.round(pendingWalk.durationSec / 60));
    const instruction = nextTransitStopName
      ? `步行前往「${nextTransitStopName}」`
      : pendingWalk.firstInstruction || '步行前往目的地';

    segments.push({
      type: 'WALK',
      durationSec: pendingWalk.durationSec,
      durationMin,
      distanceMeters: pendingWalk.distanceMeters,
      encodedPolyline: mergedCoords.length >= 2 ? encodePolyline(mergedCoords) : pendingWalk.encodedPolylines[0] || '',
      instruction,
    });
    pendingWalk = null;
  };

  for (const step of rawSteps) {
    const stepMode = step?.travelMode || (step?.transitDetails ? 'TRANSIT' : 'WALK');
    const stepEncoded = step?.polyline?.encodedPolyline || '';
    const stepDist = Number(step?.distanceMeters || 0);
    const stepDurSec = parseDurationSeconds(step?.staticDuration);

    if (stepMode === 'TRANSIT' && step?.transitDetails) {
      const td = step.transitDetails;
      const depStopName = td.stopDetails?.departureStop?.name || '';
      flushWalk(depStopName);

      const vehicleType = td.transitLine?.vehicle?.type || 'OTHER';
      const vMeta = VEHICLE_META[vehicleType] || {
        label: td.transitLine?.vehicle?.name?.text || '大眾運輸',
        emoji: '🚆',
      };

      const lineName = td.transitLine?.name || '';
      const lineShortName = td.transitLine?.nameShort || '';
      const displayLine = formatLineDisplayName(lineName, lineShortName);
      const lineColor = normalizeHexColor(td.transitLine?.color);
      const lineTextColor = normalizeHexColor(td.transitLine?.textColor) || '#FFFFFF';

      const depLatLng = td.stopDetails?.departureStop?.location?.latLng || step.startLocation?.latLng;
      const arrLatLng = td.stopDetails?.arrivalStop?.location?.latLng || step.endLocation?.latLng;

      const headwaySec = parseDurationSeconds(td.headway);

      segments.push({
        type: 'TRANSIT',
        durationSec: stepDurSec,
        durationMin: Math.max(1, Math.round(stepDurSec / 60)),
        distanceMeters: stepDist,
        encodedPolyline: stepEncoded,
        vehicleType,
        vehicleLabel: vMeta.label,
        vehicleEmoji: vMeta.emoji,
        lineName,
        lineShortName,
        displayLine,
        lineColor,
        lineTextColor,
        headsign: td.headsign || '',
        stopCount: Number(td.stopCount) || null,
        headwayMin: headwaySec > 0 ? Math.max(1, Math.round(headwaySec / 60)) : null,
        agencyName: td.transitLine?.agencies?.[0]?.name || '',
        departureStop: {
          name: depStopName,
          lat: depLatLng?.latitude ?? null,
          lng: depLatLng?.longitude ?? null,
          timeText: td.localizedValues?.departureTime?.time?.text || '',
          timeIso: td.stopDetails?.departureTime || '',
        },
        arrivalStop: {
          name: td.stopDetails?.arrivalStop?.name || '',
          lat: arrLatLng?.latitude ?? null,
          lng: arrLatLng?.longitude ?? null,
          timeText: td.localizedValues?.arrivalTime?.time?.text || '',
          timeIso: td.stopDetails?.arrivalTime || '',
        },
      });
    } else {
      // WALK 或其他非大眾運輸步段，連續步行自動合併成一段清晰步行路徑
      if (!pendingWalk) {
        pendingWalk = {
          durationSec: 0,
          distanceMeters: 0,
          encodedPolylines: [],
          firstInstruction: step?.navigationInstruction?.instructions || '',
        };
      }
      pendingWalk.durationSec += stepDurSec;
      pendingWalk.distanceMeters += stepDist;
      if (stepEncoded) pendingWalk.encodedPolylines.push(stepEncoded);
    }
  }

  flushWalk('');

  if (segments.length === 0) return null;

  const totalDistanceMeters = Number(route?.distanceMeters ?? leg?.distanceMeters ?? 0);
  const totalDurationSec = parseDurationSeconds(route?.duration ?? leg?.duration);
  const durationMin = Math.max(1, Math.round(totalDurationSec / 60));
  const distanceKm = Number((totalDistanceMeters / 1000).toFixed(2));

  const transitSegs = segments.filter((s) => s.type === 'TRANSIT');
  const walkSegs = segments.filter((s) => s.type === 'WALK');
  const totalWalkMin = walkSegs.reduce((sum, s) => sum + s.durationMin, 0);
  const transferCount = Math.max(0, transitSegs.length - 1);

  const firstTransit = transitSegs[0];
  const lastTransit = transitSegs[transitSegs.length - 1];

  // 將各步段拼接作為整體備用 polyline
  const allPolylines = segments.map((s) => s.encodedPolyline).filter(Boolean);
  const stitched = stitchEncodedPolylines(allPolylines);
  const overallEncoded =
    stitched.length >= 2 ? encodePolyline(stitched) : route?.polyline?.encodedPolyline || '';

  return {
    durationMin,
    distanceKm,
    totalWalkMin,
    transferCount,
    summaryText: buildTransitSummary(segments),
    departureTimeText: firstTransit?.departureStop?.timeText || '',
    arrivalTimeText: lastTransit?.arrivalStop?.timeText || '',
    encodedPolyline: overallEncoded,
    segments,
  };
}

async function callGoogleComputeRoutes(apiKey, payload, fieldMask) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(GOOGLE_ROUTES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, data: json };
  } finally {
    clearTimeout(timer);
  }
}

function mapGoogleError(httpStatus, data) {
  const msg = data?.error?.message || '';
  const statusStr = data?.error?.status || '';
  const detailsText = JSON.stringify(data?.error?.details || '');

  if (detailsText.includes('API_KEY_HTTP_REFERRER_BLOCKED') || msg.toLowerCase().includes('referer')) {
    return {
      statusCode: 502,
      body: {
        status: 'api_error',
        error: 'GOOGLE_API_REFERER_BLOCKED',
        message:
          'Google API 金鑰設定了網站（HTTP Referer）限制，無法由伺服器代理呼叫。請在 Google Cloud Console 移除金鑰的網域限制，僅保留「API 限制：Routes API」與每日配額上限。',
      },
    };
  }

  if (httpStatus === 403 || statusStr === 'PERMISSION_DENIED') {
    return {
      statusCode: 502,
      body: {
        status: 'api_error',
        error: 'GOOGLE_API_FORBIDDEN',
        message: 'Google Routes API 權限遭拒，請確認專案已啟用 Routes API 與帳單，且金鑰允許存取 Routes API。',
        detail: msg,
      },
    };
  }

  if (httpStatus === 429 || statusStr === 'RESOURCE_EXHAUSTED') {
    return {
      statusCode: 429,
      body: {
        status: 'api_error',
        error: 'GOOGLE_QUOTA_EXCEEDED',
        message: '已達 Google Routes API 配額上限，請稍後再試。',
      },
    };
  }

  if (detailsText.includes('API_KEY_INVALID') || msg.toLowerCase().includes('api key not valid')) {
    return {
      statusCode: 502,
      body: {
        status: 'api_error',
        error: 'GOOGLE_API_KEY_INVALID',
        message: 'GOOGLE_MAPS_API_KEY 無效，請檢查 .env.local 中的金鑰內容。',
      },
    };
  }

  return {
    statusCode: 502,
    body: {
      status: 'network_error',
      error: 'GOOGLE_API_ERROR',
      message: msg || 'Google Routes API 回傳異常',
    },
  };
}

function buildWaypoint(pt) {
  return {
    location: {
      latLng: {
        latitude: Number(pt.lat),
        longitude: Number(pt.lng),
      },
    },
  };
}

export function handleStatusRequest(env = process.env) {
  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  return {
    statusCode: 200,
    body: {
      configured: Boolean(apiKey),
      provider: 'google_routes_v2',
    },
  };
}

/**
 * 處理 POST /api/routes 請求（Vite Dev Middleware 與 Vercel Serverless Function 共用）
 */
export async function handleComputeRoutes(body, env = process.env) {
  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  if (!apiKey) {
    return {
      statusCode: 503,
      body: {
        status: 'api_unconfigured',
        error: 'API_KEY_NOT_CONFIGURED',
        message: '尚未設定 GOOGLE_MAPS_API_KEY 環境變數，已自動改用備援方案。',
      },
    };
  }

  const { origin, destination, mode, departureTime, transitPreference } = body || {};
  if (!isValidCoord(origin) || !isValidCoord(destination) || !VALID_MODES.has(mode)) {
    return {
      statusCode: 400,
      body: {
        status: 'invalid_request',
        error: 'INVALID_PARAMS',
        message: '起終點座標或交通模式格式不正確。',
      },
    };
  }

  try {
    // ==================== A. 大眾運輸分段路線 ====================
    if (mode === 'transit') {
      const payload = {
        origin: buildWaypoint(origin),
        destination: buildWaypoint(destination),
        travelMode: 'TRANSIT',
        computeAlternativeRoutes: true,
        polylineEncoding: 'ENCODED_POLYLINE',
        languageCode: 'zh-TW',
        units: 'METRIC',
      };

      if (departureTime && typeof departureTime === 'string') {
        const parsedTime = new Date(departureTime);
        if (!Number.isNaN(parsedTime.getTime())) {
          const now = Date.now();
          const minAllowed = now - 6 * 24 * 3600 * 1000;
          const maxAllowed = now + 99 * 24 * 3600 * 1000;
          if (parsedTime.getTime() >= minAllowed && parsedTime.getTime() <= maxAllowed) {
            payload.departureTime = parsedTime.toISOString();
          }
        }
      }

      if (VALID_TRANSIT_PREFS.has(transitPreference) && transitPreference !== 'DEFAULT') {
        payload.transitPreferences = {
          routingPreference: transitPreference,
        };
      }

      const res = await callGoogleComputeRoutes(apiKey, payload, TRANSIT_FIELD_MASK);
      if (!res.ok) {
        return mapGoogleError(res.status, res.data);
      }

      const rawRoutes = Array.isArray(res.data?.routes) ? res.data.routes : [];
      const routes = rawRoutes.map(normalizeTransitRoute).filter(Boolean);

      if (routes.length === 0) {
        return {
          statusCode: 200,
          body: {
            status: 'unsupported',
            provider: 'google',
            mode: 'transit',
            routes: [],
            message: '查無此兩點與時段的大眾運輸路線（可能無營運班次或超出服務範圍）',
          },
        };
      }

      return {
        statusCode: 200,
        body: {
          status: 'ok',
          provider: 'google',
          mode: 'transit',
          routes,
        },
      };
    }

    // ==================== B. 陸路交通（汽車 / 機車 / 自行車 / 步行） ====================
    const travelModeMap = {
      car: 'DRIVE',
      scooter: 'TWO_WHEELER',
      bike: 'BICYCLE',
      walk: 'WALK',
    };

    const buildLandPayload = (googleTravelMode, avoidHighways = false) => {
      const payload = {
        origin: buildWaypoint(origin),
        destination: buildWaypoint(destination),
        travelMode: googleTravelMode,
        polylineQuality: 'HIGH_QUALITY',
        polylineEncoding: 'ENCODED_POLYLINE',
        languageCode: 'zh-TW',
        units: 'METRIC',
      };
      // Google Routes API v2 僅允許 DRIVE / TWO_WHEELER 帶入 routingPreference 與 routeModifiers
      if (googleTravelMode === 'DRIVE' || googleTravelMode === 'TWO_WHEELER') {
        payload.routingPreference = 'TRAFFIC_UNAWARE';
        if (avoidHighways) {
          payload.routeModifiers = { avoidHighways: true };
        }
      }
      return payload;
    };

    const primaryGoogleMode = travelModeMap[mode];
    let fallbackNote = '';
    let res = await callGoogleComputeRoutes(
      apiKey,
      buildLandPayload(primaryGoogleMode, mode === 'scooter'),
      LAND_FIELD_MASK
    );

    // 若地區不支援 TWO_WHEELER（例如日本／歐美），自動降級為 DRIVE + 避開高速公路
    if (
      mode === 'scooter' &&
      ((!res.ok && res.status === 400) || (res.ok && (!res.data?.routes || res.data.routes.length === 0)))
    ) {
      const retryRes = await callGoogleComputeRoutes(
        apiKey,
        buildLandPayload('DRIVE', true),
        LAND_FIELD_MASK
      );
      if (retryRes.ok) {
        res = retryRes;
        fallbackNote = '此地區以避開高速公路之一般道路估算';
      }
    }

    if (!res.ok) {
      return mapGoogleError(res.status, res.data);
    }

    const rawRoute = res.data?.routes?.[0];
    if (!rawRoute) {
      return {
        statusCode: 200,
        body: {
          status: 'unsupported',
          provider: 'google',
          mode,
          message: '此兩點之間無可用道路路線（可能跨海或無可達道路）',
        },
      };
    }

    const normalized = normalizeLandRoute(rawRoute, mode, origin, destination, fallbackNote);
    if (!normalized) {
      return {
        statusCode: 200,
        body: {
          status: 'unsupported',
          provider: 'google',
          mode,
          message: '此兩點之間無法以陸路直達（可能跨海或座標離道路過遠）',
        },
      };
    }

    return {
      statusCode: 200,
      body: normalized,
    };
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    return {
      statusCode: 504,
      body: {
        status: 'network_error',
        error: isAbort ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR',
        message: isAbort ? 'Google Routes API 查詢逾時，請稍後重試。' : '無法連線至 Google Routes API。',
      },
    };
  }
}
