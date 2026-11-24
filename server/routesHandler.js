import { decodePolyline, encodePolyline, stitchEncodedPolylines } from '../src/services/polyline.js';
import { convertMoneyToTwd, getTwdRatesSummary } from './currency.js';
import { isJapanTrip, queryNavitimeTransit } from './navitime.js';

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

function getNavitimeApiKey(env = process.env) {
  return String(
    env?.RAPIDAPI_NAVITIME_KEY || env?.NAVITIME_RAPIDAPI_KEY || env?.RAPIDAPI_KEY || ''
  ).trim();
}

export function handleStatusRequest(env = process.env) {
  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  const navitimeKey = getNavitimeApiKey(env);
  return {
    statusCode: 200,
    body: {
      configured: Boolean(apiKey),
      navitimeConfigured: Boolean(navitimeKey),
      provider: 'google_routes_v2',
    },
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

  // 日本大眾運輸專屬分流：Google 開發者 API 因日本鐵路授權限制不提供日本大眾運輸，
  // 自動改由日本 NAVITIME (RapidAPI) 查詢；若尚未設定金鑰則回傳明確的日本指引與備援入口。
  if (mode === 'transit' && isJapanTrip(origin, destination)) {
    if (navitimeKey) {
      return queryNavitimeTransit({
        apiKey: navitimeKey,
        origin,
        destination,
        departureTime,
        transitPreference,
      });
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
          'Google 開發者 API 因日本鐵路授權限制，不支援自動抓取日本大眾運輸。可於 Vercel 免費設定 NAVITIME（RapidAPI 每月 500 次免費硬上限）啟用日本電車自動查詢，或一鍵開啟 Google Maps 查詢並手動填寫日圓自動換台幣。',
      },
    };
  }

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
  'postal_code',
  'plus_code',
]);

/**
 * 依「Google 地圖標點名稱優先，無標點則取路名」原則選出最適合的標點預設名稱
 */
export function pickBestPlaceFromGoogle(placesData, geocodeData) {
  const places = Array.isArray(placesData?.places) ? placesData.places : [];
  for (const place of places) {
    const name = place?.displayName?.text?.trim();
    if (!name) continue;
    const types = Array.isArray(place?.types) ? place.types : [];
    const primary = place?.primaryType || '';
    const isGenericArea =
      (primary && NON_POI_GOOGLE_TYPES.has(primary)) ||
      (types.length > 0 && types.every((t) => NON_POI_GOOGLE_TYPES.has(t)));
    if (!isGenericArea) {
      return {
        name,
        placeId: place.id || '',
        source: 'google_poi',
      };
    }
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
      return {
        name: poiName,
        placeId: r.place_id || '',
        source: 'google_poi',
      };
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
      };
    }
  }

  return null;
}

export async function handleReverseGeocode(lat, lng, env = process.env) {
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (!isValidCoord({ lat: numLat, lng: numLng })) {
    return { statusCode: 400, body: { status: 'invalid', name: null } };
  }

  const apiKey = (env?.GOOGLE_MAPS_API_KEY || '').trim();
  if (!apiKey) {
    return { statusCode: 200, body: { status: 'unconfigured', name: null } };
  }

  let placesData = null;
  let geocodeData = null;

  // 1. 優先以 Google Places API (New) 搜尋 35 公尺內最近的 Google 地圖標點
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.primaryType,places.types',
      },
      body: JSON.stringify({
        maxResultCount: 3,
        rankPreference: 'DISTANCE',
        languageCode: 'zh-TW',
        locationRestriction: {
          circle: {
            center: { latitude: numLat, longitude: numLng },
            radius: 35.0,
          },
        },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      placesData = await res.json();
    }
  } catch {
    // 若金鑰僅開通 Routes API 未開 Places API，靜默降級
  }

  const fromPlaces = pickBestPlaceFromGoogle(placesData, null);
  if (fromPlaces) {
    return { statusCode: 200, body: { status: 'ok', ...fromPlaces } };
  }

  // 2. 次順位：Google Geocoding API（POI 優先，其次取路名）
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${numLat},${numLng}&language=zh-TW&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      geocodeData = await res.json();
    }
  } catch {
    // ignore
  }

  const picked = pickBestPlaceFromGoogle(null, geocodeData);
  if (picked) {
    return { statusCode: 200, body: { status: 'ok', ...picked } };
  }

  return { statusCode: 200, body: { status: 'not_found', name: null } };
}

