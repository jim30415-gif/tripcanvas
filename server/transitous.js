import { decodePolyline, encodePolyline } from '../src/services/polyline.js';
import { convertMoneyToTwd } from './currency.js';

const TRANSITOUS_PLAN_ENDPOINT = 'https://api.transitous.org/api/v5/plan';
const TRANSITOUS_USER_AGENT = 'TripCanvas/1.0 (+https://github.com/jim30415-gif/tripcanvas)';

const WALK_MODES = new Set(['WALK', 'FOOT']);

function calcDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
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

function calcPathMeters(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += calcDistanceMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return Math.round(total);
}

function appendCoordsDedup(target, addition) {
  for (const pt of addition || []) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const prev = target[target.length - 1];
    if (prev && Math.abs(prev[0] - pt[0]) < 1e-6 && Math.abs(prev[1] - pt[1]) < 1e-6) {
      continue;
    }
    target.push([pt[0], pt[1]]);
  }
}

function normalizeIsoTime(isoOrEmpty) {
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
  return new Date(ms).toISOString();
}

/**
 * 將 ISO 時間字串格式化為日本標準時間 (UTC+9) HH:mm
 */
export function formatJstHHmm(isoString) {
  if (!isoString || typeof isoString !== 'string') return '';
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return '';
  const jst = new Date(parsed.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}

function normalizeMotisColor(rawColor, fallback = '') {
  if (!rawColor || typeof rawColor !== 'string') return fallback;
  const trimmed = rawColor.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return fallback;
}

function mapMotisVehicle(modeRaw = '') {
  const mode = String(modeRaw || '').toUpperCase();
  switch (mode) {
    case 'BUS':
    case 'ODM':
    case 'FLEX':
      return { vehicleType: 'BUS', vehicleLabel: '公車', vehicleEmoji: '🚌', defaultColor: '#2E7D32' };
    case 'COACH':
      return { vehicleType: 'BUS', vehicleLabel: '高速巴士', vehicleEmoji: '🚌', defaultColor: '#1565C0' };
    case 'TRAM':
      return { vehicleType: 'TRAM', vehicleLabel: '路面電車', vehicleEmoji: '🚊', defaultColor: '#00838F' };
    case 'SUBWAY':
      return { vehicleType: 'SUBWAY', vehicleLabel: '地鐵', vehicleEmoji: '🚇', defaultColor: '#0078C8' };
    case 'HIGHSPEED_RAIL':
      return {
        vehicleType: 'HIGH_SPEED_TRAIN',
        vehicleLabel: '新幹線',
        vehicleEmoji: '🚄',
        defaultColor: '#0068B7',
      };
    case 'LONG_DISTANCE':
    case 'NIGHT_RAIL':
      return {
        vehicleType: 'LONG_DISTANCE_TRAIN',
        vehicleLabel: '特急',
        vehicleEmoji: '🚆',
        defaultColor: '#2E6DA4',
      };
    case 'RAIL':
    case 'REGIONAL_RAIL':
    case 'REGIONAL_FAST_RAIL':
    case 'SUBURBAN':
    case 'METRO':
      return { vehicleType: 'RAIL', vehicleLabel: '電車', vehicleEmoji: '🚆', defaultColor: '#2E6DA4' };
    case 'FERRY':
      return { vehicleType: 'FERRY', vehicleLabel: '渡輪', vehicleEmoji: '⛴️', defaultColor: '#0277BD' };
    case 'FUNICULAR':
    case 'AERIAL_LIFT':
    case 'AREAL_LIFT':
    case 'CABLE_CAR':
      return { vehicleType: 'CABLE_CAR', vehicleLabel: '纜車', vehicleEmoji: '🚡', defaultColor: '#6A1B9A' };
    case 'AIRPLANE':
      return { vehicleType: 'FLIGHT', vehicleLabel: '國內線', vehicleEmoji: '✈️', defaultColor: '#455A64' };
    default:
      return { vehicleType: 'TRANSIT', vehicleLabel: '大眾運輸', vehicleEmoji: '🚆', defaultColor: '#6B513A' };
  }
}

function formatMotisDisplayLine(leg, vMeta) {
  const displayName = String(leg?.displayName || '').trim();
  const shortName = String(leg?.routeShortName || '').trim();
  const longName = String(leg?.routeLongName || '').trim();
  const agency = String(leg?.agencyName || '').trim();

  if (vMeta.vehicleType === 'BUS') {
    const candidate = shortName || displayName || longName || agency || vMeta.vehicleLabel;
    const normalized = candidate.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );
    const numMatch =
      normalized.match(
        /^[\[\(【]?\s*((?:[都急快系統]|[A-Za-z]{1,2})?\d{1,4}[A-Za-z]?)\s*(?:系統|号|號)?\s*(?:[\]\)】]|\s|$|[\(（\[－—–~～〜])/
      ) ||
      normalized.match(
        /(?:bus|バス|系統|路線|急行)\s*[:#：]?\s*((?:[都]|[A-Za-z]{1,2})?\d{1,4}[A-Za-z]?)(?:\s|系統|号|號|[\(\[（【]|$)/i
      );
    if (numMatch?.[1] && shortName.length > 10) return numMatch[1];
    if (shortName && shortName.length <= 16) return shortName;
    if (numMatch?.[1]) return numMatch[1];
    const stripped = candidate
      .replace(/\s*[\[\(（【][^\]\)）】]*[-－—–~～〜][^\]\)）】]*[\]\)）】]\s*$/, '')
      .trim();
    return stripped || candidate;
  }

  return displayName || longName || shortName || agency || vMeta.vehicleLabel;
}

function decodeLegCoords(leg) {
  const geom = leg?.legGeometry;
  if (geom?.points && typeof geom.points === 'string') {
    const precision = Number.isInteger(geom.precision) ? geom.precision : 6;
    const pts = decodePolyline(geom.points, precision);
    if (pts.length >= 2) return pts;
  }

  // 保底：使用起終點與中間站點座標
  const fallback = [];
  if (Number.isFinite(Number(leg?.from?.lat)) && Number.isFinite(Number(leg?.from?.lon))) {
    fallback.push([Number(leg.from.lat), Number(leg.from.lon)]);
  }
  if (Array.isArray(leg?.intermediateStops)) {
    for (const stop of leg.intermediateStops) {
      if (Number.isFinite(Number(stop?.lat)) && Number.isFinite(Number(stop?.lon))) {
        fallback.push([Number(stop.lat), Number(stop.lon)]);
      }
    }
  }
  if (Number.isFinite(Number(leg?.to?.lat)) && Number.isFinite(Number(leg?.to?.lon))) {
    fallback.push([Number(leg.to.lat), Number(leg.to.lon)]);
  }
  return fallback;
}

function buildSummaryText(segments) {
  return segments
    .map((seg) => {
      if (seg.type === 'WALK') return `步行 ${seg.durationMin}分`;
      return `${seg.vehicleEmoji} ${seg.displayLine}`;
    })
    .join(' → ');
}

function pickLowestPositiveFare(products) {
  if (!Array.isArray(products)) return null;
  let best = null;
  for (const p of products) {
    const amount = Number(p?.amount);
    const currency = String(p?.currency || '').trim().toUpperCase();
    if (!currency || !Number.isFinite(amount) || amount <= 0) continue;
    if (!best || amount < best.amount) {
      best = { amount, currency };
    }
  }
  return best;
}

async function extractTransitousFare(itinerary) {
  const transfers = Array.isArray(itinerary?.fareTransfers) ? itinerary.fareTransfers : [];
  if (transfers.length === 0) return null;

  let currency = '';
  let totalAmount = 0;

  for (const ft of transfers) {
    const rule = String(ft?.rule || 'A_AB_B').toUpperCase();
    const legGroups = Array.isArray(ft?.effectiveFareLegProducts) ? ft.effectiveFareLegProducts : [];
    const transferProd = pickLowestPositiveFare(ft?.transferProducts);

    if (rule === 'AB') {
      if (transferProd) {
        if (!currency) currency = transferProd.currency;
        if (currency === transferProd.currency) totalAmount += transferProd.amount;
      }
      continue;
    }

    const groupsToCharge = rule === 'A_AB' ? legGroups.slice(0, 1) : legGroups;
    for (const legOptions of groupsToCharge) {
      // effectiveFareLegProducts 每筆為 array<array<FareProduct>>，取最低正額方案
      const flatCandidates = Array.isArray(legOptions) ? legOptions.flat(2) : [];
      const best = pickLowestPositiveFare(flatCandidates);
      if (best) {
        if (!currency) currency = best.currency;
        if (currency === best.currency) totalAmount += best.amount;
      }
    }
    if (transferProd && (!currency || currency === transferProd.currency)) {
      currency = transferProd.currency;
      totalAmount += transferProd.amount;
    }
  }

  if (!currency || totalAmount <= 0) return null;
  const units = Math.floor(totalAmount);
  const nanos = Math.round((totalAmount - units) * 1e9);
  const display =
    currency === 'JPY'
      ? `¥${Math.round(totalAmount).toLocaleString('en-US')}`
      : `${currency} ${Math.round(totalAmount).toLocaleString('en-US')}`;

  return convertMoneyToTwd({ currencyCode: currency, units, nanos }, display);
}

/**
 * 將 Transitous (MOTIS 2) 單一 itinerary 正規化為 TripCanvas 標準分段大眾運輸路線
 * 若該 itinerary 不含任何實際大眾運輸乘車段（僅步行），回傳 null。
 */
export async function normalizeTransitousItinerary(itinerary) {
  const rawLegs = Array.isArray(itinerary?.legs) ? itinerary.legs : [];
  if (rawLegs.length === 0) return null;

  const hasAnyTransit = rawLegs.some((leg) => !WALK_MODES.has(String(leg?.mode || '').toUpperCase()));
  if (!hasAnyTransit) return null;

  const segments = [];
  const allCoords = [];
  let pendingWalk = null;

  const flushWalk = (nextStopName = '') => {
    if (!pendingWalk) return;
    if (pendingWalk.durationSec < 25 && pendingWalk.distanceMeters < 20) {
      pendingWalk = null;
      return;
    }
    const durationMin = Math.max(1, Math.round(pendingWalk.durationSec / 60));
    const encodedPolyline =
      pendingWalk.coords.length >= 2 ? encodePolyline(pendingWalk.coords) : '';
    const instruction = nextStopName ? `步行前往「${nextStopName}」` : '步行前往目的地';

    segments.push({
      type: 'WALK',
      durationSec: Math.max(60, Math.round(pendingWalk.durationSec)),
      durationMin,
      distanceMeters: Math.round(pendingWalk.distanceMeters),
      encodedPolyline,
      instruction,
    });
    appendCoordsDedup(allCoords, pendingWalk.coords);
    pendingWalk = null;
  };

  for (const leg of rawLegs) {
    const mode = String(leg?.mode || 'WALK').toUpperCase();
    const legCoords = decodeLegCoords(leg);
    const durSec = Math.max(
      0,
      Number(leg?.duration) ||
        (leg?.startTime && leg?.endTime
          ? Math.max(0, (new Date(leg.endTime).getTime() - new Date(leg.startTime).getTime()) / 1000)
          : 0)
    );
    const distMeters =
      Number.isFinite(Number(leg?.distance)) && Number(leg.distance) > 0
        ? Math.round(Number(leg.distance))
        : calcPathMeters(legCoords);

    if (WALK_MODES.has(mode)) {
      if (!pendingWalk) {
        pendingWalk = { durationSec: 0, distanceMeters: 0, coords: [] };
      }
      pendingWalk.durationSec += durSec;
      pendingWalk.distanceMeters += distMeters;
      appendCoordsDedup(pendingWalk.coords, legCoords);
      continue;
    }

    const depName = String(leg?.from?.name || '').trim() || '上車站';
    const arrName = String(leg?.to?.name || '').trim() || '下車站';
    flushWalk(depName);

    const vMeta = mapMotisVehicle(mode);
    const displayLine = formatMotisDisplayLine(leg, vMeta);
    const lineColor = normalizeMotisColor(leg?.routeColor, vMeta.defaultColor);
    const encodedPolyline = legCoords.length >= 2 ? encodePolyline(legCoords) : '';
    appendCoordsDedup(allCoords, legCoords);

    const stopCount = Array.isArray(leg?.intermediateStops) ? leg.intermediateStops.length + 1 : null;
    const durationMin = Math.max(1, Math.round(durSec / 60));

    segments.push({
      type: 'TRANSIT',
      durationSec: Math.max(60, Math.round(durSec)),
      durationMin,
      distanceMeters: distMeters,
      encodedPolyline,
      vehicleType: vMeta.vehicleType,
      vehicleLabel: vMeta.vehicleLabel,
      vehicleEmoji: vMeta.vehicleEmoji,
      lineName: String(leg?.routeLongName || leg?.displayName || displayLine).trim(),
      lineShortName: String(leg?.routeShortName || displayLine).trim(),
      displayLine,
      lineColor,
      lineTextColor: normalizeMotisColor(leg?.routeTextColor, '#FFFFFF'),
      headsign: String(leg?.headsign || leg?.tripTo?.name || '').trim(),
      stopCount,
      headwayMin: null,
      agencyName: String(leg?.agencyName || '').trim(),
      departureStop: {
        name: depName,
        lat: Number.isFinite(Number(leg?.from?.lat)) ? Number(leg.from.lat) : null,
        lng: Number.isFinite(Number(leg?.from?.lon)) ? Number(leg.from.lon) : null,
        timeText: formatJstHHmm(leg?.startTime),
        timeIso: leg?.startTime || '',
      },
      arrivalStop: {
        name: arrName,
        lat: Number.isFinite(Number(leg?.to?.lat)) ? Number(leg.to.lat) : null,
        lng: Number.isFinite(Number(leg?.to?.lon)) ? Number(leg.to.lon) : null,
        timeText: formatJstHHmm(leg?.endTime),
        timeIso: leg?.endTime || '',
      },
    });
  }

  flushWalk('');

  const transitSegs = segments.filter((s) => s.type === 'TRANSIT');
  if (transitSegs.length === 0) return null;

  const walkSegs = segments.filter((s) => s.type === 'WALK');
  const sumDistMeters = segments.reduce((acc, s) => acc + (Number(s.distanceMeters) || 0), 0);
  const rawTotalSec = Number(itinerary?.duration);
  const durationMin =
    Number.isFinite(rawTotalSec) && rawTotalSec > 0
      ? Math.max(1, Math.round(rawTotalSec / 60))
      : Math.max(1, segments.reduce((acc, s) => acc + s.durationMin, 0));

  const distanceKm = Number((sumDistMeters / 1000).toFixed(2));
  const totalWalkMin = walkSegs.reduce((sum, s) => sum + s.durationMin, 0);
  const parsedTransfers = Number(itinerary?.transfers);
  const transferCount =
    Number.isFinite(parsedTransfers) && parsedTransfers >= 0
      ? Math.round(parsedTransfers)
      : Math.max(0, transitSegs.length - 1);

  const firstTransit = transitSegs[0];
  const lastTransit = transitSegs[transitSegs.length - 1];
  const fare = await extractTransitousFare(itinerary);

  return {
    provider: 'transitous',
    hasTransit: true,
    durationMin,
    distanceKm,
    totalWalkMin,
    transferCount,
    summaryText: buildSummaryText(segments),
    departureTimeText: firstTransit?.departureStop?.timeText || formatJstHHmm(itinerary?.startTime),
    arrivalTimeText: lastTransit?.arrivalStop?.timeText || formatJstHHmm(itinerary?.endTime),
    encodedPolyline: allCoords.length >= 2 ? encodePolyline(allCoords) : '',
    fare,
    segments,
  };
}

function sortAndDedupeTransitousRoutes(routes, transitPreference = 'DEFAULT') {
  const seen = new Set();
  const unique = [];
  for (const r of routes) {
    const key = `${r.summaryText}|${r.departureTimeText}|${r.durationMin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  unique.sort((a, b) => {
    if (transitPreference === 'LESS_WALKING') {
      if (a.totalWalkMin !== b.totalWalkMin) return a.totalWalkMin - b.totalWalkMin;
      return a.durationMin - b.durationMin;
    }
    if (transitPreference === 'FEWER_TRANSFERS') {
      if (a.transferCount !== b.transferCount) return a.transferCount - b.transferCount;
      return a.durationMin - b.durationMin;
    }
    if (a.durationMin !== b.durationMin) return a.durationMin - b.durationMin;
    return a.transferCount - b.transferCount;
  });

  return unique.slice(0, 3);
}

/**
 * 透過 Transitous (MOTIS 2 /api/v5/plan) 查詢日本公開 GTFS-JP 大眾運輸（特別是用於補齊地方公車）
 * 遵循 Transitous 使用條款：附上識別 User-Agent、僅於主服務查無乘車段時作為輕量備援。
 */
export async function queryTransitousTransit({
  origin,
  destination,
  departureTime = '',
  transitPreference = 'DEFAULT',
}) {
  const params = new URLSearchParams({
    fromPlace: `${Number(origin.lat)},${Number(origin.lng)}`,
    toPlace: `${Number(destination.lat)},${Number(destination.lng)}`,
    time: normalizeIsoTime(departureTime),
    transitModes: 'TRANSIT',
    directModes: '',
    detailedLegs: 'true',
    detailedTransfers: 'true',
    numItineraries: '5',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`${TRANSITOUS_PLAN_ENDPOINT}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'User-Agent': TRANSITOUS_USER_AGENT,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        statusCode: 502,
        body: {
          status: 'network_error',
          provider: 'transitous',
          region: 'JP',
          mode: 'transit',
          hasTransit: false,
          routes: [],
        },
      };
    }

    const data = await res.json().catch(() => ({}));
    const rawItineraries = Array.isArray(data?.itineraries) ? data.itineraries : [];
    const normalized = (
      await Promise.all(rawItineraries.map((it) => normalizeTransitousItinerary(it)))
    ).filter(Boolean);

    const routes = sortAndDedupeTransitousRoutes(normalized, transitPreference);

    if (routes.length === 0) {
      return {
        statusCode: 200,
        body: {
          status: 'unsupported',
          provider: 'transitous',
          region: 'JP',
          mode: 'transit',
          hasTransit: false,
          routes: [],
        },
      };
    }

    return {
      statusCode: 200,
      body: {
        status: 'ok',
        provider: 'transitous',
        region: 'JP',
        mode: 'transit',
        hasTransit: true,
        routes,
      },
    };
  } catch {
    return {
      statusCode: 504,
      body: {
        status: 'network_error',
        provider: 'transitous',
        region: 'JP',
        mode: 'transit',
        hasTransit: false,
        routes: [],
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
