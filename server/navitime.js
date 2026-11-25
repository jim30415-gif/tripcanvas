import { encodePolyline } from '../src/services/polyline.js';
import { convertMoneyToTwd } from './currency.js';
import { parseOptionalFiniteNumber } from './security.js';

const NAVITIME_RAPIDAPI_HOST = 'navitime-route-totalnavi.p.rapidapi.com';
const NAVITIME_ROUTE_TRANSIT_ENDPOINT = `https://${NAVITIME_RAPIDAPI_HOST}/route_transit`;

const SUBWAY_KEYWORDS = ['メトロ', '地下鉄', '都営', '市営地下鉄', 'Osaka Metro', '大阪メトロ'];

const NAVITIME_ORDER_MAP = {
  DEFAULT: 'time_optimized',
  LESS_WALKING: 'walk_distance',
  FEWER_TRANSFERS: 'transit',
};

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

function pointToLineSegmentKm(pt, segA, segB) {
  if (!pt || !segA || !segB) return 999;
  const ax = segA[1];
  const ay = segA[0];
  const bx = segB[1];
  const by = segB[0];
  const px = pt[1];
  const py = pt[0];
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return calcDistanceKm(py, px, ay, ax);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const projLat = ay + t * dy;
  const projLng = ax + t * dx;
  return calcDistanceKm(py, px, projLat, projLng);
}

/**
 * 判斷單一座標是否位於日本境內（涵蓋本州、北海道、九州、四國、沖繩離島，並排除台灣與韓國本土）
 */
export function isJapanCoord(pt) {
  if (!pt || typeof pt.lat !== 'number' || typeof pt.lng !== 'number') return false;
  const { lat, lng } = pt;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  // 1. 本州、四國、北海道、九州主要區域（lng >= 129.4 避開韓國釜山/首爾）
  if (lat >= 30.0 && lat <= 45.65 && lng >= 129.4 && lng <= 145.9) {
    return true;
  }
  // 2. 九州西岸與五島列島（不含韓國本土）
  if (lat >= 31.0 && lat <= 34.0 && lng >= 128.55 && lng < 129.4) {
    return true;
  }
  // 3. 沖繩本島與先島諸島（lng >= 122.8 避開台灣宜蘭／基隆／花蓮）
  if (lat >= 24.0 && lat < 30.0 && lng >= 122.8 && lng <= 131.5) {
    return true;
  }
  return false;
}

export function isJapanTrip(origin, destination) {
  return isJapanCoord(origin) && isJapanCoord(destination);
}

/**
 * 將任意時間轉換為 NAVITIME API 要求的日本標準時間格式 YYYY-MM-DDThh:mm:ss（無時區後綴）
 */
export function formatJstDateTime(isoOrEmpty) {
  const now = Date.now();
  let ms = now;
  if (isoOrEmpty && typeof isoOrEmpty === 'string') {
    const parsed = new Date(isoOrEmpty);
    if (!Number.isNaN(parsed.getTime())) {
      const minAllowed = now - 30 * 24 * 3600 * 1000;
      const maxAllowed = now + 180 * 24 * 3600 * 1000;
      if (parsed.getTime() >= minAllowed && parsed.getTime() <= maxAllowed) {
        ms = parsed.getTime();
      }
    }
  }
  // 固定平移至 JST (UTC+9)，避免雲端伺服器 UTC 時區導致時間偏移
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}` +
    `T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}`
  );
}

function extractTimeHHmm(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return '';
  const m = timeStr.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
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

function isNeutralWalkColor(hex) {
  return !hex || hex === '#BFBFBF' || hex === '#999999' || hex === '#CCCCCC' || hex === '#808080';
}

function mapNavitimeVehicle(moveType, lineName = '', companyName = '') {
  const combined = `${lineName} ${companyName}`;
  const isSubway = SUBWAY_KEYWORDS.some((kw) => combined.includes(kw));

  switch (moveType) {
    case 'superexpress_train':
      return { vehicleType: 'HIGH_SPEED_TRAIN', vehicleLabel: '新幹線', vehicleEmoji: '🚄' };
    case 'ultraexpress_train':
    case 'sleeper_ultraexpress':
      return { vehicleType: 'LONG_DISTANCE_TRAIN', vehicleLabel: '特急', vehicleEmoji: '🚆' };
    case 'express_train':
    case 'rapid_train':
    case 'semiexpress_train':
    case 'local_train':
      return isSubway
        ? { vehicleType: 'SUBWAY', vehicleLabel: '地鐵', vehicleEmoji: '🚇' }
        : { vehicleType: 'RAIL', vehicleLabel: '電車', vehicleEmoji: '🚆' };
    case 'local_bus':
    case 'highway_bus':
    case 'shuttle_bus':
      return { vehicleType: 'BUS', vehicleLabel: '巴士', vehicleEmoji: '🚌' };
    case 'ferry':
      return { vehicleType: 'FERRY', vehicleLabel: '渡輪', vehicleEmoji: '⛴️' };
    case 'domestic_flight':
      return { vehicleType: 'FLIGHT', vehicleLabel: '國內線', vehicleEmoji: '✈️' };
    default:
      return isSubway
        ? { vehicleType: 'SUBWAY', vehicleLabel: '地鐵', vehicleEmoji: '🚇' }
        : { vehicleType: 'RAIL', vehicleLabel: '大眾運輸', vehicleEmoji: '🚆' };
  }
}

function extractNavitimeFareJpy(item) {
  const summaryMove = item?.summary?.move || {};
  const ref = summaryMove.reference_fare;
  if (ref && typeof ref === 'object') {
    const ic = Number(ref.lowest_total_ic);
    const ticket = Number(ref.lowest_total_ticket);
    if (Number.isFinite(ic) && ic > 0) return Math.round(ic);
    if (Number.isFinite(ticket) && ticket > 0) return Math.round(ticket);
  }

  const summaryFare = summaryMove.fare;
  if (summaryFare && typeof summaryFare === 'object') {
    const ic = Number(summaryFare.unit_48);
    const ticket = Number(summaryFare.unit_0);
    const base = Number.isFinite(ic) && ic > 0 ? ic : Number.isFinite(ticket) && ticket > 0 ? ticket : 0;
    if (base > 0) {
      // 若有特急／新幹線自由席加價（unit_1 ~ unit_10），優先加上必要基礎運費
      let extra = 0;
      for (const [k, v] of Object.entries(summaryFare)) {
        const val = Number(v);
        if (!Number.isFinite(val) || val <= 0) continue;
        if (k === 'unit_1' || k === 'unit_2') {
          extra = Math.min(extra || Infinity, val);
        }
      }
      return Math.round(base + (Number.isFinite(extra) && extra !== Infinity ? extra : 0));
    }
  }

  // 備援：從各個 move section 加總
  let sectionSum = 0;
  const sections = Array.isArray(item?.sections) ? item.sections : [];
  for (const sec of sections) {
    if (sec?.type !== 'move' || !sec?.transport?.fare) continue;
    const f = sec.transport.fare;
    const ic = Number(f.unit_48);
    const ticket = Number(f.unit_0);
    const chosen = Number.isFinite(ic) && ic > 0 ? ic : Number.isFinite(ticket) && ticket > 0 ? ticket : 0;
    sectionSum += chosen;
  }
  return sectionSum > 0 ? Math.round(sectionSum) : 0;
}

function extractGeoJsonFeatures(shapes) {
  const rawFeatures = Array.isArray(shapes?.features) ? shapes.features : [];
  const parsed = [];

  for (const feat of rawFeatures) {
    const geom = feat?.geometry;
    if (!geom) continue;
    const props = feat?.properties || {};
    const isWalk = props.ways === 'walk';
    const color = normalizeHexColor(props.inline?.color);

    const pushLine = (rawCoords) => {
      if (!Array.isArray(rawCoords) || rawCoords.length < 2) return;
      const latLngs = [];
      for (const pair of rawCoords) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const lng = Number(pair[0]);
        const lat = Number(pair[1]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          latLngs.push([lat, lng]);
        }
      }
      if (latLngs.length >= 2) {
        parsed.push({ isWalk, coords: latLngs, color });
      }
    };

    if (geom.type === 'LineString') {
      pushLine(geom.coordinates);
    } else if (geom.type === 'MultiLineString' && Array.isArray(geom.coordinates)) {
      geom.coordinates.forEach(pushLine);
    }
  }

  return parsed;
}

function appendCoordsDedup(target, addition) {
  for (const pt of addition) {
    const prev = target[target.length - 1];
    if (prev && Math.abs(prev[0] - pt[0]) < 1e-6 && Math.abs(prev[1] - pt[1]) < 1e-6) {
      continue;
    }
    target.push(pt);
  }
}

function alignShapesToSegments(segments, features) {
  if (!Array.isArray(features) || features.length === 0) return;

  const assignForType = (isWalkTarget) => {
    const targetSegs = segments.filter((s) => (s.type === 'WALK') === isWalkTarget);
    const targetFeats = features.filter((f) => f.isWalk === isWalkTarget);
    if (targetSegs.length === 0 || targetFeats.length === 0) return;

    const buckets = targetSegs.map(() => []);
    const bucketColors = targetSegs.map(() => '');
    let cursor = 0;

    for (const feat of targetFeats) {
      const midPt = feat.coords[Math.floor(feat.coords.length / 2)];
      const endPt = feat.coords[feat.coords.length - 1];

      let bestIdx = cursor;
      let bestScore = Infinity;

      const maxCandidate = Math.min(targetSegs.length - 1, cursor + 2);
      for (let j = cursor; j <= maxCandidate; j++) {
        const seg = targetSegs[j];
        const segStart = seg._startLatLng;
        const segEnd = seg._endLatLng;
        let score = pointToLineSegmentKm(midPt, segStart, segEnd);
        if (segEnd) {
          score += calcDistanceKm(endPt[0], endPt[1], segEnd[0], segEnd[1]) * 0.25;
        }
        if (!isWalkTarget && seg.lineColor && feat.color && seg.lineColor === feat.color) {
          score -= 5;
        }
        if (score < bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      }

      cursor = bestIdx;
      appendCoordsDedup(buckets[bestIdx], feat.coords);
      if (!isWalkTarget && !bucketColors[bestIdx] && !isNeutralWalkColor(feat.color)) {
        bucketColors[bestIdx] = feat.color;
      }
    }

    targetSegs.forEach((seg, idx) => {
      if (buckets[idx].length >= 2) {
        seg.encodedPolyline = encodePolyline(buckets[idx]);
      }
      if (!isWalkTarget && !seg.lineColor && bucketColors[idx]) {
        seg.lineColor = bucketColors[idx];
      }
    });
  };

  assignForType(true);
  assignForType(false);
}

function buildSummaryText(segments) {
  return segments
    .map((seg) => (seg.type === 'WALK' ? `步行 ${seg.durationMin}分` : `${seg.vehicleEmoji} ${seg.displayLine}`))
    .join(' → ');
}

/**
 * 將 NAVITIME /route_transit 單一 item 正規化為 TripCanvas 標準分段大眾運輸物件
 */
export async function normalizeNavitimeRoute(item, origin, destination) {
  const sections = Array.isArray(item?.sections) ? item.sections : [];
  if (sections.length === 0) return null;

  const segments = [];
  let pendingWalk = null;

  const flushWalk = (nextStopName = '') => {
    if (!pendingWalk) return;
    const durationMin = Math.max(1, Math.round(pendingWalk.durationMin));
    const instruction = nextStopName
      ? `步行前往「${nextStopName}」`
      : '步行前往目的地';

    segments.push({
      type: 'WALK',
      durationSec: durationMin * 60,
      durationMin,
      distanceMeters: pendingWalk.distanceMeters,
      encodedPolyline: '',
      instruction,
      _startLatLng: pendingWalk.startLatLng,
      _endLatLng: pendingWalk.endLatLng,
    });
    pendingWalk = null;
  };

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (sec?.type !== 'move') continue;

    // 尋找前後對應的 point 節點
    let prevPoint = null;
    for (let p = i - 1; p >= 0; p--) {
      if (sections[p]?.type === 'point') {
        prevPoint = sections[p];
        break;
      }
    }
    let nextPoint = null;
    for (let n = i + 1; n < sections.length; n++) {
      if (sections[n]?.type === 'point') {
        nextPoint = sections[n];
        break;
      }
    }

    const startLatLng =
      prevPoint?.coord?.lat != null && prevPoint?.coord?.lon != null
        ? [Number(prevPoint.coord.lat), Number(prevPoint.coord.lon)]
        : origin
          ? [Number(origin.lat), Number(origin.lng)]
          : null;
    const endLatLng =
      nextPoint?.coord?.lat != null && nextPoint?.coord?.lon != null
        ? [Number(nextPoint.coord.lat), Number(nextPoint.coord.lon)]
        : destination
          ? [Number(destination.lat), Number(destination.lng)]
          : null;

    const moveType = String(sec.move || 'walk');
    const durMin = Math.max(1, Number(sec.time) || 1);
    const distMeters = Math.max(0, Math.round(Number(sec.distance) || 0));

    if (moveType === 'walk') {
      if (!pendingWalk) {
        pendingWalk = {
          durationMin: 0,
          distanceMeters: 0,
          startLatLng,
          endLatLng,
        };
      }
      pendingWalk.durationMin += durMin;
      pendingWalk.distanceMeters += distMeters;
      if (endLatLng) pendingWalk.endLatLng = endLatLng;
      continue;
    }

    const depName = (prevPoint?.name && prevPoint.name !== 'start' ? prevPoint.name : '') || '上車站';
    const arrName = (nextPoint?.name && nextPoint.name !== 'goal' ? nextPoint.name : '') || '下車站';
    flushWalk(depName);

    const transport = sec.transport || {};
    const companyName = transport.company?.name || '';
    const rawLineName = (sec.line_name || transport.name || '').trim() || '日本電車';
    const vMeta = mapNavitimeVehicle(moveType, rawLineName, companyName);
    let displayLine = rawLineName;
    if (vMeta.vehicleType === 'BUS') {
      const normalizedBusRaw = rawLineName.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
      );
      const explicitNum = String(transport.number || sec.bus_number || '').trim();
      const busNumMatch =
        normalizedBusRaw.match(
          /^[\[\(【]?\s*((?:[都急快系統]|[A-Za-z]{1,2})?\d{1,4}[A-Za-z]?)\s*(?:系統|号|號)?\s*(?:[\]\)】]|\s|$|[\(（\[－—–~～〜])/
        ) ||
        normalizedBusRaw.match(
          /(?:bus|バス|系統|路線|急行)\s*[:#：]?\s*((?:[都]|[A-Za-z]{1,2})?\d{1,4}[A-Za-z]?)(?:\s|系統|号|號|[\(\[（【]|$)/i
        );
      if (explicitNum) {
        displayLine = explicitNum;
      } else if (busNumMatch?.[1]) {
        displayLine = busNumMatch[1];
      } else {
        // 真的沒有號碼時，優先保留路線名（移除尾端 [起站-迄站] 冗餘括號；若全為起迄站名則保留原樣）
        const strippedBracket = rawLineName.replace(/\s*[\[\(（【][^\]\)）】]*[-－—–~～〜][^\]\)）】]*[\]\)）】]\s*$/, '').trim();
        displayLine = strippedBracket || rawLineName;
      }
    }
    const lineColor = normalizeHexColor(transport.color);
    const firstLink = Array.isArray(transport.links) ? transport.links[0] : null;
    const headsign =
      firstLink?.destination?.name ||
      (typeof firstLink?.direction === 'string' && !['up', 'down'].includes(firstLink.direction)
        ? firstLink.direction
        : '') ||
      '';

    const callingAt = Array.isArray(sec.calling_at)
      ? sec.calling_at
      : Array.isArray(transport.calling_at)
        ? transport.calling_at
        : null;
    const stopCount = callingAt && callingAt.length > 0 ? callingAt.length + 1 : null;

    segments.push({
      type: 'TRANSIT',
      durationSec: durMin * 60,
      durationMin: Math.round(durMin),
      distanceMeters: distMeters,
      encodedPolyline: '',
      vehicleType: vMeta.vehicleType,
      vehicleLabel: vMeta.vehicleLabel,
      vehicleEmoji: vMeta.vehicleEmoji,
      lineName: rawLineName,
      lineShortName: displayLine,
      displayLine,
      lineColor,
      lineTextColor: '#FFFFFF',
      headsign,
      stopCount,
      headwayMin: null,
      agencyName: companyName,
      departureStop: {
        name: depName,
        lat: startLatLng ? startLatLng[0] : null,
        lng: startLatLng ? startLatLng[1] : null,
        timeText: extractTimeHHmm(sec.from_time),
        timeIso: sec.from_time || '',
      },
      arrivalStop: {
        name: arrName,
        lat: endLatLng ? endLatLng[0] : null,
        lng: endLatLng ? endLatLng[1] : null,
        timeText: extractTimeHHmm(sec.to_time),
        timeIso: sec.to_time || '',
      },
      _startLatLng: startLatLng,
      _endLatLng: endLatLng,
    });
  }

  flushWalk('');

  if (segments.length === 0) return null;

  // 對齊 GeoJSON shapes 至各步行／乘車分段，並補齊缺少折線之保底端點
  const features = extractGeoJsonFeatures(item?.shapes);
  alignShapesToSegments(segments, features);

  const allCoords = [];
  for (const seg of segments) {
    if (!seg.encodedPolyline && seg._startLatLng && seg._endLatLng) {
      seg.encodedPolyline = encodePolyline([seg._startLatLng, seg._endLatLng]);
    }
    if (seg._startLatLng) appendCoordsDedup(allCoords, [seg._startLatLng]);
    if (seg._endLatLng) appendCoordsDedup(allCoords, [seg._endLatLng]);
    delete seg._startLatLng;
    delete seg._endLatLng;
  }

  // 若 GeoJSON 完整，使用完整 GeoJSON 拼接作為整體折線
  const fullGeoCoords = [];
  for (const f of features) {
    appendCoordsDedup(fullGeoCoords, f.coords);
  }
  const overallEncoded =
    fullGeoCoords.length >= 2
      ? encodePolyline(fullGeoCoords)
      : allCoords.length >= 2
        ? encodePolyline(allCoords)
        : '';

  const summaryMove = item?.summary?.move || {};
  const transitSegs = segments.filter((s) => s.type === 'TRANSIT');
  const walkSegs = segments.filter((s) => s.type === 'WALK');
  const sumDuration = segments.reduce((acc, s) => acc + s.durationMin, 0);
  const sumDistance = segments.reduce((acc, s) => acc + s.distanceMeters, 0);

  const durationMin = Math.max(1, Math.round(Number(summaryMove.time) || sumDuration));
  const totalDistanceMeters = Number(summaryMove.distance) || sumDistance;
  const distanceKm = Number((totalDistanceMeters / 1000).toFixed(2));
  const totalWalkMin = walkSegs.reduce((sum, s) => sum + s.durationMin, 0);
  const parsedTransitCount = parseOptionalFiniteNumber(summaryMove.transit_count);
  const transferCount = Number.isFinite(parsedTransitCount)
    ? Math.max(0, Math.round(parsedTransitCount))
    : Math.max(0, transitSegs.length - 1);

  const firstTransit = transitSegs[0];
  const lastTransit = transitSegs[transitSegs.length - 1];

  const fareJpy = extractNavitimeFareJpy(item);
  const fare =
    fareJpy > 0
      ? await convertMoneyToTwd(
          { currencyCode: 'JPY', units: fareJpy, nanos: 0 },
          `¥${fareJpy.toLocaleString('en-US')}`
        )
      : null;

  return {
    provider: 'navitime',
    hasTransit: transitSegs.length > 0,
    durationMin,
    distanceKm,
    totalWalkMin,
    transferCount,
    summaryText: buildSummaryText(segments),
    departureTimeText:
      firstTransit?.departureStop?.timeText || extractTimeHHmm(summaryMove.from_time),
    arrivalTimeText:
      lastTransit?.arrivalStop?.timeText || extractTimeHHmm(summaryMove.to_time),
    encodedPolyline: overallEncoded,
    fare,
    segments,
  };
}

/**
 * 透過 RapidAPI 呼叫日本 NAVITIME Route (totalnavi) /route_transit
 */
export async function queryNavitimeTransit({
  apiKey,
  origin,
  destination,
  departureTime = '',
  transitPreference = 'DEFAULT',
}) {
  const params = new URLSearchParams({
    start: `${Number(origin.lat)},${Number(origin.lng)}`,
    goal: `${Number(destination.lat)},${Number(destination.lng)}`,
    start_time: formatJstDateTime(departureTime),
    datum: 'wgs84',
    coord_unit: 'degree',
    shape: 'true',
    shape_color: 'railway_line',
    order: NAVITIME_ORDER_MAP[transitPreference] || 'time_optimized',
    limit: '3',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${NAVITIME_ROUTE_TRANSIT_ENDPOINT}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': NAVITIME_RAPIDAPI_HOST,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        console.error('[navitime] 401/403:', data?.message || '');
        return {
          statusCode: 502,
          body: {
            status: 'api_error',
            provider: 'navitime',
            region: 'JP',
            error: 'NAVITIME_API_FORBIDDEN',
            message: '日本大眾運輸自動查詢暫時無法驗證，可先開啟 Google Maps 查詢並手動填寫日圓自動換算。',
          },
        };
      }
      if (res.status === 429) {
        return {
          statusCode: 429,
          body: {
            status: 'api_error',
            provider: 'navitime',
            region: 'JP',
            error: 'NAVITIME_QUOTA_EXCEEDED',
            message:
              '本月日本電車自動查詢額度已達上限，可先一鍵開啟 Google Maps 查詢並改用手動填寫日圓換算。',
          },
        };
      }
      console.error('[navitime] upstream error:', res.status, data?.message || data?.error?.message || '');
      return {
        statusCode: 502,
        body: {
          status: 'network_error',
          provider: 'navitime',
          region: 'JP',
          error: 'NAVITIME_API_ERROR',
          message: '日本大眾運輸查詢服務暫時異常，請稍後再試或改用手動紀錄。',
        },
      };
    }

    const rawItems = Array.isArray(data?.items) ? data.items : [];
    const routes = (
      await Promise.all(rawItems.map((item) => normalizeNavitimeRoute(item, origin, destination)))
    ).filter(Boolean);

    if (routes.length === 0) {
      return {
        statusCode: 200,
        body: {
          status: 'unsupported',
          provider: 'navitime',
          region: 'JP',
          mode: 'transit',
          hasTransit: false,
          routes: [],
          message:
            'NAVITIME 查無此兩點之鐵路／地鐵路線（可能距離較近適合步行，或該區段僅有日本地方公車；可點下方按鈕在 Google Maps 查詢並手動填寫日圓）。',
        },
      };
    }

    const hasTransit = routes.some((r) => Boolean(r.hasTransit));
    return {
      statusCode: 200,
      body: {
        status: 'ok',
        provider: 'navitime',
        region: 'JP',
        mode: 'transit',
        hasTransit,
        walkOnly: !hasTransit,
        routes,
      },
    };
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    return {
      statusCode: 504,
      body: {
        status: 'network_error',
        provider: 'navitime',
        region: 'JP',
        error: isAbort ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR',
        message: isAbort
          ? '日本 NAVITIME 路線查詢逾時，請稍後重試。'
          : '無法連線至日本 NAVITIME 路線服務。',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
