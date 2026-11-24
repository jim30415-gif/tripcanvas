/**
 * 地點搜尋與「POI 地標優先、無地標則取路名」反向地理編碼服務
 * 1. 若後端已設定 Google API，優先透過 /api/routes?reverse=1 查詢 35m 內 Google Maps 標點名稱與 placeId
 * 2. 若未回傳 Google 標點，並行查詢 Overpass 30m 內具名地標與 Nominatim zoom=18：
 *    先取實際地標／商家／車站／景點名稱，沒有地標時次順位取路名（road），最後才退回街區行政區
 */

const NOMINATIM_POI_KEYS = [
  'amenity',
  'tourism',
  'shop',
  'leisure',
  'historic',
  'railway',
  'public_transport',
  'aeroway',
  'building',
  'healthcare',
  'office',
  'craft',
  'man_made',
  'natural',
];

const NOMINATIM_NON_POI_CATEGORIES = new Set(['highway', 'boundary', 'place', 'landuse', 'waterway']);

export async function searchPlaces(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=zh-TW&q=${encodeURIComponent(query)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error('Search HTTP error');
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function pickLocalizedTagName(tags = {}) {
  return (
    tags['name:zh-Hant'] ||
    tags['name:zh-TW'] ||
    tags['name:zh'] ||
    tags.name ||
    ''
  ).trim();
}

/**
 * 依「地標名稱優先 → 路名次之 → 街區備援」解析 Nominatim zoom=18 回傳結果
 */
export function pickPlaceNameFromNominatim(data) {
  if (!data || typeof data !== 'object') return null;
  const addr = data.address || {};
  const category = String(data.category || data.class || '').toLowerCase();

  // 1. 若 Nominatim 直接命中地標／建物／車站／商家（非道路／行政區）
  const rawName = (data.name || '').trim();
  if (rawName && !NOMINATIM_NON_POI_CATEGORIES.has(category)) {
    const roadStr = (addr.road || '').trim();
    if (!roadStr || rawName !== roadStr) {
      return rawName;
    }
  }

  for (const key of NOMINATIM_POI_KEYS) {
    const val = (addr[key] || '').trim();
    if (val) return val;
  }

  // 2. 次順位：明確路名
  const road = (
    addr.road ||
    addr.pedestrian ||
    addr.footway ||
    addr.cycleway ||
    addr.path ||
    ''
  ).trim();
  if (road) return road;

  // 3. 最後保底（如山林、海面等完全無地標亦無道路處）
  return (addr.neighbourhood || addr.suburb || addr.village || addr.town || addr.city || '').trim() || null;
}

async function queryBackendGoogleReverse(lat, lng) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`/api/routes?reverse=1&lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.status === 'ok' && data?.name) {
      return {
        name: String(data.name).trim(),
        placeId: data.placeId || '',
        source: data.source || 'google',
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function queryNearbyOsmPoi(lat, lng) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3200);
    const query = `[out:json][timeout:3];nwr(around:30,${lat},${lng})["name"][!"highway"][!"boundary"][!"place"];out center 6;`;
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: `data=${encodeURIComponent(query)}`,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const elements = Array.isArray(data?.elements) ? data.elements : [];
    let best = null;
    let bestDistSq = Infinity;

    for (const el of elements) {
      const name = pickLocalizedTagName(el.tags);
      if (!name) continue;
      const eLat = el.lat ?? el.center?.lat;
      const eLng = el.lon ?? el.center?.lon;
      if (eLat == null || eLng == null) continue;
      const dSq = (eLat - lat) ** 2 + (eLng - lng) ** 2;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = name;
      }
    }
    return best;
  } catch {
    return null;
  }
}

async function queryNominatimReverse(lat, lng) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=zh-TW&zoom=18&addressdetails=1`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return pickPlaceNameFromNominatim(data);
  } catch {
    return null;
  }
}

export async function reverseGeocode(lat, lng) {
  // 1. 優先查詢後端 Google Maps 標點（35m 內 POI 優先，其次路名）
  const googleHit = await queryBackendGoogleReverse(lat, lng);
  if (googleHit?.name && googleHit.source === 'google_poi') {
    return googleHit;
  }

  // 2. 若未命中 Google POI，並行比對 30m 內 OSM 具名地標與 Nominatim zoom=18
  const [osmPoiName, nominatimName] = await Promise.all([
    queryNearbyOsmPoi(lat, lng),
    queryNominatimReverse(lat, lng),
  ]);

  if (osmPoiName) {
    return { name: osmPoiName, placeId: '', source: 'osm_poi' };
  }
  if (googleHit?.name) {
    return googleHit;
  }
  if (nominatimName) {
    return { name: nominatimName, placeId: '', source: 'nominatim' };
  }
  return null;
}
