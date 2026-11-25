import { decodePolyline, encodePolyline, stitchEncodedPolylines } from '../src/services/polyline.js';
import { convertMoneyToTwd, getTwdRatesSummary } from './currency.js';
import { isJapanTrip, queryNavitimeTransit } from './navitime.js';
import { queryTransitousTransit } from './transitous.js';
import { fetchJsonWithTimeout, parseOptionalFiniteNumber } from './security.js';

const GOOGLE_ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const LAND_FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.distanceMeters',
  'routes.legs.duration',
  'routes.legs.steps.polyline.encodedPolyline',
].join(',');

const TRANSIT_FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.travelAdvisory.transitFare',
  'routes.localizedValues.transitFare',
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
  const a = Math.min(
    1,
    Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2
  );
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

const BUS_VEHICLE_TYPES = new Set(['BUS', 'INTERCITY_BUS', 'TROLLEYBUS']);

function toHalfWidthAlnum(str = '') {
  return String(str).replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

function looksLikeOriginDestName(str = '') {
  return /[-－—–~～〜→↔]/.test(str);
}

/**
 * 從公車路線字串擷取明確的公車號碼／代號（例：307、紅26、藍15、0東、1819、都01、205、M15）
 * 若字串沒有號碼（如「仁愛幹線」或純起迄站名「撫遠街－板橋」），回傳空字串。
 */
export function extractBusRouteNumber(raw = '') {
  const s = toHalfWidthAlnum(raw).trim();
  if (!s) return '';

  // 1. 整段本身就是簡短公車號碼（如 307、紅26、0東、1819A、都01、205系統、R26、M15、小15區）
  if (/^(?:[紅藍綠棕橘黃小棕貓都急快]|[A-Za-z]{1,2})?\d{1,4}[A-Za-z東西南北區直副延繞支號系統]*$/.test(s)) {
    return s.replace(/系統$/, '');
  }

  // 2. 開頭為方括號或號碼後接空白／括號／破折號（如 "[205] 京都駅-金閣寺"、"307 撫遠街-板橋"、"紅26(捷運淡水站-漁人碼頭)"）
  const leadingMatch = s.match(
    /^[\[\(【]?\s*((?:[紅藍綠棕橘黃小貓都]|[A-Za-z]{1,2})?\d{1,4}[A-Za-z東西南北區直副延繞支]?)\s*(?:號|系統|線)?\s*(?:[\]\)】]|\s|$|[\(（\[－—–~～〜])/
  );
  if (leadingMatch?.[1]) {
    return leadingMatch[1];
  }

  // 3. 業者／關鍵字後接號碼（如 "Bus 42"、"京都市バス 205系統"、"北鉄バス 11[東部車庫-金沢駅]"、"系統205"、"公車 307"）
  const afterKeyword = s.match(
    /(?:bus|バス|公車|客運|系統|路線|line)\s*[:#：]?\s*((?:[紅藍綠棕橘黃小貓都]|[A-Za-z]{1,2})?\d{1,4}[A-Za-z東西南北區直副延繞支]?)(?:\s|系統|號|[\(\[（【]|$)/i
  );
  if (afterKeyword?.[1]) {
    return afterKeyword[1];
  }

  return '';
}

export function formatLineDisplayName(lineName, lineShortName, vehicleType = '') {
  const name = (lineName || '').trim();
  const short = (lineShortName || '').trim();

  // 公車／客運一律以「號碼」為主，避免被起迄站名（如「撫遠街－板橋」）覆蓋
  if (BUS_VEHICLE_TYPES.has(vehicleType)) {
    const halfShort = toHalfWidthAlnum(short);
    if (short) {
      if (/\d/.test(halfShort)) {
        if (looksLikeOriginDestName(short) || short.length > 10) {
          const cleanShortNum = extractBusRouteNumber(short);
          if (cleanShortNum) return cleanShortNum;
        }
        return short;
      }
      if (!looksLikeOriginDestName(short) && looksLikeOriginDestName(name)) return short;
    }

    const extractedFromName = extractBusRouteNumber(name);
    if (extractedFromName) return extractedFromName;

    if (short && !looksLikeOriginDestName(short)) return short;
    return short || name || '公車';
  }

  if (short && name) {
    if (name === short || name.includes(short)) return name;
    if (short.includes(name)) return short;
    // 若非公車（例如捷運）且簡稱僅為路線代號（如 BL、R、G），保留完整中文路線名為主
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
      const displayLine = formatLineDisplayName(lineName, lineShortName, vehicleType);
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
    console.error('[routesHandler] Google API Referer blocked:', msg);
    return {
      statusCode: 502,
      body: {
        status: 'api_error',
        error: 'GOOGLE_API_REFERER_BLOCKED',
        message: '路線服務授權設定受限，已自動改用備援方案。',
      },
    };
  }

  if (httpStatus === 403 || statusStr === 'PERMISSION_DENIED') {
    console.error('[routesHandler] Google Routes 403:', msg);
    return {
      statusCode: 502,
      body: {
        status: 'api_error',
        error: 'GOOGLE_API_FORBIDDEN',
        message: '路線查詢服務暫時無法驗證，請稍後重試或改用手動紀錄。',
      },
    };
  }

  if (httpStatus === 429 || statusStr === 'RESOURCE_EXHAUSTED') {
    return {
      statusCode: 429,
      body: {
        status: 'api_error',
        error: 'GOOGLE_QUOTA_EXCEEDED',
        message: '路線查詢已達短時配額上限，請稍後再試。',
      },
    };
  }

  if (detailsText.includes('API_KEY_INVALID') || msg.toLowerCase().includes('api key not valid')) {
    console.error('[routesHandler] Google API key invalid');
    return {
      statusCode: 502,
      body: {
        status: 'api_error',
        error: 'GOOGLE_API_KEY_INVALID',
        message: '路線服務驗證異常，已自動改用備援方案。',
      },
    };
  }

  console.error('[routesHandler] Google Routes error:', httpStatus, msg);
  return {
    statusCode: 502,
    body: {
      status: 'network_error',
      error: 'GOOGLE_API_ERROR',
      message: '路線查詢服務暫時回傳異常，請稍後再試。',
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

function getNavitimeApiKey(env = process.env) {
  return String(
    env?.RAPIDAPI_NAVITIME_KEY || env?.NAVITIME_RAPIDAPI_KEY || env?.RAPIDAPI_KEY || ''
  ).trim();
}

export function handleStatusRequest(env = process.env) {
  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  const navitimeKey = getNavitimeApiKey(env);
  const mapsJsKey = String(env?.GOOGLE_MAPS_JS_API_KEY || env?.VITE_GOOGLE_MAPS_API_KEY || '').trim();
  const body = {
    configured: Boolean(apiKey),
    navitimeConfigured: Boolean(navitimeKey),
    mapsJsConfigured: Boolean(mapsJsKey),
    provider: 'google_routes_v2',
  };
  if (mapsJsKey) {
    body.mapsJsKey = mapsJsKey;
  }
  return {
    statusCode: 200,
    body,
  };
}

export async function handleRatesRequest() {
  const summary = await getTwdRatesSummary();
  return {
    statusCode: 200,
    body: summary,
  };
}

/**
 * 處理 POST /api/routes 請求（Vite Dev Middleware 與 Vercel Serverless Function 共用）
 */
export async function handleComputeRoutes(body, env = process.env) {
  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  const navitimeKey = getNavitimeApiKey(env);

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

  // 在計費前先攔截過近（< 5 公尺）或過遠（> 3000 公里）的不合理座標組，避免白耗 API 配額
  const straightKm = calcDistanceKm(
    Number(origin.lat),
    Number(origin.lng),
    Number(destination.lat),
    Number(destination.lng)
  );
  if (straightKm < 0.005) {
    return {
      statusCode: 200,
      body: {
        status: 'unsupported',
        provider: 'google',
        mode,
        routes: [],
        message: '起點與終點位置幾乎重疊，無需規劃路線。',
      },
    };
  }
  if (straightKm > 3000) {
    return {
      statusCode: 200,
      body: {
        status: 'unsupported',
        provider: 'google',
        mode,
        routes: [],
        message: '起終點距離超過陸路／大眾運輸查詢範圍，建議改用手動紀錄航班或交通。',
      },
    };
  }

  // 日本大眾運輸專屬分流：Google 開發者 API 因日本鐵路授權限制不提供日本大眾運輸，
  // 優先查詢日本 NAVITIME（鐵路／新幹線／地鐵／私鐵與日圓票價）；
  // 若 NAVITIME 僅回傳純步行（RapidAPI 不含路線巴士）或查無鐵道，自動備援查詢 Transitous（日本 GTFS-JP 公開公車資料）。
  if (mode === 'transit' && isJapanTrip(origin, destination)) {
    if (navitimeKey) {
      const navRes = await queryNavitimeTransit({
        apiKey: navitimeKey,
        origin,
        destination,
        departureTime,
        transitPreference,
      });

      const navRoutes = Array.isArray(navRes?.body?.routes) ? navRes.body.routes : [];
      const navHasTransit =
        navRes?.body?.status === 'ok' &&
        navRoutes.some((r) => (r.segments || []).some((s) => s.type === 'TRANSIT'));

      if (navHasTransit) {
        return navRes;
      }

      const transitousDisabled = String(env?.DISABLE_TRANSITOUS_FALLBACK || '').trim() === '1';
      const shouldTryTransitous =
        !transitousDisabled &&
        (navRes?.body?.status === 'ok' ||
          navRes?.body?.status === 'unsupported' ||
          navRes?.body?.error === 'NAVITIME_QUOTA_EXCEEDED');

      if (shouldTryTransitous) {
        const trRes = await queryTransitousTransit({
          origin,
          destination,
          departureTime,
          transitPreference,
        });
        const trRoutes = Array.isArray(trRes?.body?.routes) ? trRes.body.routes : [];
        const trHasTransit =
          trRes?.body?.status === 'ok' &&
          trRoutes.some((r) => (r.segments || []).some((s) => s.type === 'TRANSIT'));

        if (trHasTransit) {
          return {
            statusCode: 200,
            body: {
              ...trRes.body,
              hasTransit: true,
              walkOnly: false,
              fallbackFrom: 'navitime',
            },
          };
        }
      }

      if (navRes?.body?.status === 'ok') {
        return {
          statusCode: 200,
          body: {
            ...navRes.body,
            hasTransit: false,
            walkOnly: true,
            transitousChecked: !transitousDisabled,
          },
        };
      }

      if (navRes?.body?.status === 'unsupported') {
        return {
          statusCode: 200,
          body: {
            ...navRes.body,
            hasTransit: false,
            transitousChecked: !transitousDisabled,
            message:
              'NAVITIME（鐵道／地鐵）與日本公開公車資料均查無此區段路線；可能為未開放資料之地方公車，可點下方 Google Maps 查車並改填貼路公車紀錄。',
          },
        };
      }

      return navRes;
    }
    return {
      statusCode: 200,
      body: {
        status: 'japan_transit_requires_navitime',
        provider: 'google',
        region: 'JP',
        mode: 'transit',
        navitimeConfigured: false,
        routes: [],
        message:
          '日本鐵路／地鐵目前未啟用自動班次查詢，可先一鍵開啟 Google Maps 查看轉乘，再手動填寫日圓自動換算台幣。',
      },
    };
  }

  if (!apiKey) {
    return {
      statusCode: 503,
      body: {
        status: 'api_unconfigured',
        error: 'API_KEY_NOT_CONFIGURED',
        message: '路線服務尚未啟用，已自動改用備援方案。',
      },
    };
  }

  try {
    // ==================== A. 大眾運輸分段路線（台灣與日本以外全球地區） ====================
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
      const routes = (
        await Promise.all(
          rawRoutes.map(async (rawRoute) => {
            const parsed = normalizeTransitRoute(rawRoute);
            if (!parsed) return null;
            const rawMoney = rawRoute?.travelAdvisory?.transitFare || null;
            const localizedFareText = rawRoute?.localizedValues?.transitFare?.text || '';
            parsed.fare = await convertMoneyToTwd(rawMoney, localizedFareText);
            return parsed;
          })
        )
      ).filter(Boolean);

      if (routes.length === 0) {
        return {
          statusCode: 200,
          body: {
            status: 'unsupported',
            provider: 'google',
            mode: 'transit',
            hasTransit: false,
            routes: [],
            message: '查無此兩點與時段的大眾運輸路線（可能無營運班次或超出服務範圍）',
          },
        };
      }

      const hasTransit = routes.some((r) => (r.segments || []).some((s) => s.type === 'TRANSIT'));
      return {
        statusCode: 200,
        body: {
          status: 'ok',
          provider: 'google',
          mode: 'transit',
          hasTransit,
          walkOnly: !hasTransit,
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

const NON_POI_GOOGLE_TYPES = new Set([
  'route',
  'street_address',
  'intersection',
  'political',
  'country',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'administrative_area_level_4',
  'locality',
  'sublocality',
  'sublocality_level_1',
  'sublocality_level_2',
  'postal_code',
  'plus_code',
  'neighborhood',
]);

// 注意：Places API (New) 的 excludedTypes 僅允許 Table A 類型，不可放入 Table B（如 political / route / street_address），否則會回傳 400 INVALID_ARGUMENT
const GOOGLE_NEARBY_EXCLUDED_TYPES = [
  'administrative_area_level_1',
  'administrative_area_level_2',
  'country',
  'locality',
  'postal_code',
];

// 建物內常見的微型／辦公設施，若緊鄰處同時有商店／景點／車站，優先回傳底圖主要標點
const LOW_PRIORITY_GOOGLE_POI_TYPES = new Set([
  'atm',
  'parking',
  'storage',
  'real_estate_agency',
  'lawyer',
  'accounting',
  'insurance_agency',
  'corporate_office',
  'moving_company',
  'plumber',
  'electrician',
  'locksmith',
]);

function computeReverseRadiusMeters(zoom) {
  const z = parseOptionalFiniteNumber(zoom);
  if (!Number.isFinite(z)) return 60;
  if (z >= 19) return 30;
  if (z >= 18) return 45;
  if (z >= 17) return 65;
  if (z >= 16) return 95;
  return 135;
}

function computeSnapThresholdMeters(zoom) {
  const z = parseOptionalFiniteNumber(zoom);
  if (!Number.isFinite(z)) return 40;
  if (z >= 19) return 22;
  if (z >= 18) return 32;
  if (z >= 17) return 45;
  if (z >= 16) return 65;
  return 90;
}

function calcDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.min(
    1,
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  );
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isCjkRegionOrigin(origin) {
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) return false;
  return origin.lat >= 18 && origin.lat <= 46 && origin.lng >= 100 && origin.lng <= 146;
}

function isPureLatinLabel(name) {
  return /[A-Za-z]/.test(name) && !/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(name);
}

/**
 * 依「Google 顯著底圖標點優先，無標點則取路名」原則選出最適合的標點預設名稱、吸附座標與鄰近候選地標
 */
export function pickBestPlaceFromGoogle(
  placesData,
  geocodeData,
  origin = null,
  zoom = null,
  { rankedByPopularity = false } = {}
) {
  const places = Array.isArray(placesData?.places) ? placesData.places : [];
  const validPois = [];
  const seenNames = new Set();
  const inCjkRegion = isCjkRegionOrigin(origin);
  const snapThreshold = computeSnapThresholdMeters(zoom);

  const pushCandidate = ({ name, placeId, pLat, pLng, primary, types, businessStatus, prominenceRank }) => {
    const cleanName = String(name || '').trim();
    if (!cleanName || seenNames.has(cleanName)) return;
    if (businessStatus === 'CLOSED_PERMANENTLY') return;

    const typeList = Array.isArray(types) ? types : [];
    const isGenericArea =
      (primary && NON_POI_GOOGLE_TYPES.has(primary)) ||
      (typeList.length > 0 && typeList.every((t) => NON_POI_GOOGLE_TYPES.has(t)));
    if (isGenericArea) return;

    seenNames.add(cleanName);
    const hasCoords = Number.isFinite(pLat) && Number.isFinite(pLng);
    const distMeters =
      origin && hasCoords ? calcDistanceMeters(origin.lat, origin.lng, pLat, pLng) : validPois.length * 10;

    // 計算等效距離：當以 POPULARITY 排序時，Google 底圖顯著地標（排名靠前）優先於隱藏小攤販，不亂吸無名小店
    let effectiveDist = distMeters;
    if (rankedByPopularity && Number.isFinite(prominenceRank)) {
      effectiveDist += prominenceRank * 9;
    }
    const isLowPriority =
      (primary && LOW_PRIORITY_GOOGLE_POI_TYPES.has(primary)) ||
      (typeList.length > 0 &&
        typeList.some((t) => LOW_PRIORITY_GOOGLE_POI_TYPES.has(t)) &&
        !typeList.some((t) =>
          ['restaurant', 'cafe', 'tourist_attraction', 'shopping_mall', 'store', 'train_station', 'subway_station', 'hotel', 'lodging'].includes(t)
        ));
    if (isLowPriority) effectiveDist += 26;
    if (inCjkRegion && isPureLatinLabel(cleanName)) effectiveDist += 16;

    validPois.push({
      name: cleanName,
      placeId: placeId || '',
      source: 'google_poi',
      lat: hasCoords ? Number(pLat.toFixed(6)) : null,
      lng: hasCoords ? Number(pLng.toFixed(6)) : null,
      distMeters,
      effectiveDist,
    });
  };

  places.forEach((place, idx) => {
    pushCandidate({
      name: place?.displayName?.text,
      placeId: place?.id || '',
      pLat: place?.location?.latitude,
      pLng: place?.location?.longitude,
      primary: place?.primaryType || '',
      types: place?.types,
      businessStatus: place?.businessStatus || '',
      prominenceRank: idx,
    });
  });

  // Legacy Places API (results[]) 相容解析
  const legacyPlaces = Array.isArray(placesData?.results) ? placesData.results : [];
  legacyPlaces.forEach((place, idx) => {
    pushCandidate({
      name: place?.name,
      placeId: place?.place_id || '',
      pLat: place?.geometry?.location?.lat,
      pLng: place?.geometry?.location?.lng,
      primary: '',
      types: place?.types,
      businessStatus: place?.business_status || '',
      prominenceRank: idx,
    });
  });

  if (validPois.length > 0) {
    if (origin) validPois.sort((a, b) => a.effectiveDist - b.effectiveDist);
    const best = validPois[0];
    const hasBestCoords = Number.isFinite(best.lat) && Number.isFinite(best.lng);
    const result = {
      name: best.name,
      placeId: best.placeId,
      source: 'google_poi',
    };
    if (hasBestCoords) {
      result.lat = best.lat;
      result.lng = best.lng;
      result.distanceMeters = Math.round(best.distMeters);
      result.snapped = best.distMeters <= snapThreshold;
    }
    if (validPois.length > 1) {
      result.candidates = validPois.slice(0, 5).map(({ name, placeId, lat, lng, distMeters }) => {
        const item = { name, placeId };
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          item.lat = lat;
          item.lng = lng;
          item.distanceMeters = Math.round(distMeters);
        }
        return item;
      });
    }
    return result;
  }

  const results = Array.isArray(geocodeData?.results) ? geocodeData.results : [];
  // 1. 先檢查 Geocoding 結果中有無明確地標／POI
  for (const r of results) {
    const types = Array.isArray(r?.types) ? r.types : [];
    const isPoi = types.some((t) =>
      [
        'point_of_interest',
        'establishment',
        'premise',
        'park',
        'natural_feature',
        'transit_station',
        'train_station',
        'subway_station',
        'bus_station',
        'airport',
      ].includes(t)
    );
    if (!isPoi) continue;
    const comp = (r.address_components || []).find((c) =>
      (c.types || []).some((t) =>
        ['point_of_interest', 'establishment', 'premise', 'park', 'natural_feature'].includes(t)
      )
    );
    const poiName = comp?.long_name?.trim();
    if (poiName) {
      const gLat = r?.geometry?.location?.lat;
      const gLng = r?.geometry?.location?.lng;
      const res = {
        name: poiName,
        placeId: r.place_id || '',
        source: 'google_poi',
      };
      if (origin && Number.isFinite(gLat) && Number.isFinite(gLng)) {
        const d = calcDistanceMeters(origin.lat, origin.lng, gLat, gLng);
        res.lat = Number(gLat.toFixed(6));
        res.lng = Number(gLng.toFixed(6));
        res.distanceMeters = Math.round(d);
        res.snapped = d <= snapThreshold;
      }
      return res;
    }
  }

  // 2. 次順位：取路名（route）
  for (const r of results) {
    const routeComp = (r.address_components || []).find((c) => (c.types || []).includes('route'));
    const road = routeComp?.long_name?.trim();
    if (road && road !== 'Unnamed Road') {
      return {
        name: road,
        placeId: '',
        source: 'google_road',
        snapped: false,
      };
    }
  }

  return null;
}

export async function handleReverseGeocode(lat, lng, env = process.env, zoom = null) {
  const numLat = parseOptionalFiniteNumber(lat);
  const numLng = parseOptionalFiniteNumber(lng);
  if (!isValidCoord({ lat: numLat, lng: numLng })) {
    return { statusCode: 400, body: { status: 'invalid', name: null } };
  }

  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  if (!apiKey) {
    return { statusCode: 200, body: { status: 'unconfigured', name: null } };
  }

  const origin = { lat: numLat, lng: numLng };
  const radius = computeReverseRadiusMeters(zoom);
  let placesData = null;
  let geocodeData = null;
  let placesApiDisabled = false;

  // 1. 優先以 Google Places API (New) 的 POPULARITY 顯著度排序搭配緊緻縮放半徑，優先抓出畫面上看得到的底圖大地標／主要店家
  try {
    const { res, data } = await fetchJsonWithTimeout(
      fetch,
      'https://places.googleapis.com/v1/places:searchNearby',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.primaryType,places.types,places.location,places.businessStatus',
        },
        body: JSON.stringify({
          maxResultCount: 15,
          rankPreference: 'POPULARITY',
          languageCode: 'zh-TW',
          excludedTypes: GOOGLE_NEARBY_EXCLUDED_TYPES,
          locationRestriction: {
            circle: {
              center: { latitude: numLat, longitude: numLng },
              radius,
            },
          },
        }),
      },
      2200
    );
    if (res.ok && data) {
      placesData = data;
    } else if (res.status === 403 || res.status === 401) {
      placesApiDisabled = true;
    }
  } catch {
    // 逾時或網路異常時降級
  }

  const fromPlaces = pickBestPlaceFromGoogle(placesData, null, origin, zoom, { rankedByPopularity: true });
  if (fromPlaces) {
    return { statusCode: 200, body: { status: 'ok', ...fromPlaces } };
  }

  // 1b. 僅於 Places API (New) 未啟用時才降級至 Legacy Google Places Nearby Search（避免重複計費）
  if (placesApiDisabled) {
    try {
      const legacyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${numLat},${numLng}&radius=${radius}&language=zh-TW&key=${encodeURIComponent(apiKey)}`;
      const { res, data: legacyJson } = await fetchJsonWithTimeout(fetch, legacyUrl, {}, 1600);
      if (res.ok && legacyJson?.status === 'OK' && Array.isArray(legacyJson.results)) {
        const nearbyOnly = legacyJson.results.filter((r) => {
          const rLat = r?.geometry?.location?.lat;
          const rLng = r?.geometry?.location?.lng;
          return (
            Number.isFinite(rLat) &&
            Number.isFinite(rLng) &&
            calcDistanceMeters(numLat, numLng, rLat, rLng) <= radius
          );
        });
        const fromLegacy = pickBestPlaceFromGoogle({ results: nearbyOnly }, null, origin, zoom, {
          rankedByPopularity: true,
        });
        if (fromLegacy) {
          return { statusCode: 200, body: { status: 'ok', ...fromLegacy } };
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. 次順位：Google Geocoding API（POI 優先，其次取路名；與步驟 1 合計逾時 <= 3.8s，不超過前端 4.2s 取消門檻）
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${numLat},${numLng}&language=zh-TW&key=${encodeURIComponent(apiKey)}`;
    const { res, data } = await fetchJsonWithTimeout(fetch, url, {}, 1600);
    if (res.ok && data) {
      geocodeData = data;
    }
  } catch {
    // ignore
  }

  const picked = pickBestPlaceFromGoogle(null, geocodeData, origin, zoom);
  if (picked) {
    const firstCountry = (geocodeData?.results || [])
      .flatMap((r) => r?.address_components || [])
      .find((c) => (c?.types || []).includes('country'));
    const countryCode = String(firstCountry?.short_name || '').trim().toUpperCase();
    return { statusCode: 200, body: { status: 'ok', ...picked, ...(countryCode ? { countryCode } : {}) } };
  }

  return {
    statusCode: 200,
    body: {
      status: placesApiDisabled ? 'places_api_disabled' : 'not_found',
      name: null,
    },
  };
}

/**
 * 透過 Google Maps 點擊底圖圖示取得的原生 placeId，精準查詢該圖示對應的繁中名稱與精確座標（100% 與畫面顯示一致）
 */
export async function handlePlaceDetails(placeId, env = process.env) {
  const cleanId = String(placeId || '').trim();
  if (!cleanId || cleanId.length > 256 || !/^[A-Za-z0-9_\-]+$/.test(cleanId)) {
    return { statusCode: 400, body: { status: 'invalid', name: null } };
  }

  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  if (!apiKey) {
    return { statusCode: 200, body: { status: 'unconfigured', name: null } };
  }

  let placesApiDisabled = false;

  // 1. Places API (New) Place Details（Pro SKU：每月 5,000 次免費）
  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(cleanId)}?languageCode=zh-TW`;
    const { res, data: p } = await fetchJsonWithTimeout(
      fetch,
      url,
      {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'id,displayName,location,shortFormattedAddress,formattedAddress,primaryTypeDisplayName,addressComponents',
        },
      },
      3200
    );
    if (res.ok && p) {
      const name = p?.displayName?.text?.trim() || '';
      const pLat = p?.location?.latitude;
      const pLng = p?.location?.longitude;
      if (name) {
        const countryComp = (p.addressComponents || []).find((c) => (c.types || []).includes('country'));
        const countryCode = (countryComp?.shortText || '').toUpperCase();
        return {
          statusCode: 200,
          body: {
            status: 'ok',
            placeId: p.id || cleanId,
            name,
            lat: Number.isFinite(pLat) ? Number(pLat.toFixed(6)) : null,
            lng: Number.isFinite(pLng) ? Number(pLng.toFixed(6)) : null,
            address: p?.shortFormattedAddress || p?.formattedAddress || '',
            categoryLabel: p?.primaryTypeDisplayName?.text || '',
            countryCode,
            source: 'google_place_id',
          },
        };
      }
    } else if (res.status === 401 || res.status === 403) {
      placesApiDisabled = true;
    }
  } catch {
    // 逾時或網路異常
  }

  // 2. 僅於 Places API (New) 未啟用時才降級至 Legacy Place Details（避免 400/404 無效 placeId 重複計費）
  if (placesApiDisabled) {
    try {
      const legacyUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(cleanId)}&fields=place_id,name,geometry,formatted_address,address_components&language=zh-TW&key=${encodeURIComponent(apiKey)}`;
      const { res, data } = await fetchJsonWithTimeout(fetch, legacyUrl, {}, 2800);
      const r = data?.result;
      if (res.ok && data?.status === 'OK' && r?.name) {
        const countryComp = (r.address_components || []).find((c) => (c.types || []).includes('country'));
        const rLat = r?.geometry?.location?.lat;
        const rLng = r?.geometry?.location?.lng;
        return {
          statusCode: 200,
          body: {
            status: 'ok',
            placeId: r.place_id || cleanId,
            name: String(r.name).trim(),
            lat: Number.isFinite(rLat) ? Number(rLat.toFixed(6)) : null,
            lng: Number.isFinite(rLng) ? Number(rLng.toFixed(6)) : null,
            address: r.formatted_address || '',
            categoryLabel: '',
            countryCode: (countryComp?.short_name || '').toUpperCase(),
            source: 'google_place_id',
          },
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    statusCode: 200,
    body: {
      status: placesApiDisabled ? 'places_api_disabled' : 'not_found',
      name: null,
    },
  };
}

/**
 * 透過 Google Places API (New) 執行即時關鍵字地點搜尋（原生支援繁中↔日文漢字通配與國家／座標加權）
 */
export async function handleSearchPlaces(params = {}, env = process.env) {
  const query = String(params?.q || '').trim().slice(0, 120);
  if (!query || query.length < 2) {
    return { statusCode: 200, body: { status: 'ok', results: [] } };
  }

  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  if (!apiKey) {
    return { statusCode: 200, body: { status: 'unconfigured', results: [] } };
  }

  const lat = parseOptionalFiniteNumber(params?.lat);
  const lng = parseOptionalFiniteNumber(params?.lng);
  const regionCode = String(params?.country || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);

  const payload = {
    textQuery: query,
    languageCode: 'zh-TW',
    maxResultCount: 8,
  };
  if (/^[A-Z]{2}$/.test(regionCode)) {
    payload.regionCode = regionCode;
  }
  if (Number.isFinite(lat) && Number.isFinite(lng) && isValidCoord({ lat, lng })) {
    payload.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: 50000.0,
      },
    };
  }

  try {
    const { res, data } = await fetchJsonWithTimeout(
      fetch,
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.addressComponents,places.primaryTypeDisplayName',
        },
        body: JSON.stringify(payload),
      },
      3500
    );

    if (!res.ok) {
      const status = res.status === 401 || res.status === 403 ? 'places_api_disabled' : 'error';
      return { statusCode: 200, body: { status, results: [] } };
    }

    const places = Array.isArray(data?.places) ? data.places : [];
    const results = places
      .map((p) => {
        const pLat = p?.location?.latitude;
        const pLng = p?.location?.longitude;
        const name = p?.displayName?.text?.trim() || '';
        if (!name || pLat == null || pLng == null) return null;

        const countryComp = (p.addressComponents || []).find((c) => (c.types || []).includes('country'));
        const countryCode = (countryComp?.shortText || '').toUpperCase();
        const address = p?.shortFormattedAddress || p?.formattedAddress || '';

        return {
          name,
          address,
          display_name: address ? `${name}, ${address}` : name,
          lat: Number(pLat),
          lon: Number(pLng),
          countryCode,
          placeId: p.id || '',
          categoryLabel: p?.primaryTypeDisplayName?.text || '',
          source: 'google',
        };
      })
      .filter(Boolean);

    return { statusCode: 200, body: { status: 'ok', results } };
  } catch {
    return { statusCode: 200, body: { status: 'error', results: [] } };
  }
}


