/**
 * 智慧即時地點搜尋 ＋ 「POI 地標優先、無地標則取路名」反向地理編碼服務
 * - 搜尋支援：打字即時建議（支援 AbortSignal）、繁中↔日文新字體↔簡中自動轉換（如 金澤 ↔ 金沢）、
 *   以及「優先顯示本計畫已標點國家之相似景點，次序才是其他國家同名地點」
 * - 反向地理編碼支援：Google 35m POI → Overpass 30m 具名地標 + Nominatim zoom=18 → 路名 → 街區保底
 */

import {
  buildSearchQueryVariants,
  canonicalizePlaceName,
  toTraditionalChinese,
} from '../utils/cjkNormalize.js';
import {
  calcDistanceKm,
  getCountryDisplayMeta,
  inferCountryCodeFromCoord,
} from '../utils/geo.js';

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

const CATEGORY_ZH_LABELS = {
  station: '車站',
  halt: '車站',
  subway_entrance: '地鐵站',
  tram_stop: '電車站',
  bus_stop: '公車站',
  bus_station: '轉運站',
  aerodrome: '機場',
  airport: '機場',
  museum: '美術館／展館',
  attraction: '景點',
  viewpoint: '觀景台',
  castle: '古城',
  temple: '寺院',
  shrine: '神社',
  place_of_worship: '寺社',
  park: '公園',
  garden: '庭園',
  hotel: '飯店',
  hostel: '旅宿',
  guest_house: '民宿',
  restaurant: '餐廳',
  cafe: '咖啡館',
  marketplace: '市場',
  mall: '商場',
  department_store: '百貨',
  city: '城市',
  town: '城鎮',
  village: '村落',
  suburb: '區域',
};

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 60;
const searchCache = new Map();
let backendSearchAvailable = null; // null=未知, true=可用, false=未設定金鑰或未啟用 Places API

function getCachedSearch(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedSearch(key, value) {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey !== undefined) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { at: Date.now(), value });
}

function createTimedSignal(externalSignal, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      ctrl.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

function buildShortAddressFromParts(parts = [], excludeName = '') {
  const seen = new Set();
  const excludeCanon = canonicalizePlaceName(excludeName);
  const clean = [];
  for (const raw of parts) {
    const p = String(raw || '').trim();
    if (!p) continue;
    const canon = canonicalizePlaceName(p);
    if (!canon || seen.has(canon) || (excludeCanon && canon === excludeCanon)) continue;
    seen.add(canon);
    clean.push(p);
  }
  return clean.slice(0, 4).join(' · ');
}

function normalizeNominatimItem(item) {
  const lat = Number(item?.lat);
  const lon = Number(item?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const addr = item.address || {};
  const nd = item.namedetails || {};
  const zhName = (nd['name:zh-Hant'] || nd['name:zh-TW'] || nd['name:zh'] || '').trim();
  const localName = (nd['name:ja'] || nd.name || item.name || '').trim();
  const fallbackTitle = String(item.display_name || '').split(',')[0].trim();

  const name = zhName || localName || fallbackTitle;
  if (!name) return null;

  const altName =
    localName && canonicalizePlaceName(localName) !== canonicalizePlaceName(name)
      ? localName
      : localName && localName !== name
        ? localName
        : '';

  const cc = (addr.country_code || inferCountryCodeFromCoord(lat, lon) || '').toUpperCase();
  const countryMeta = getCountryDisplayMeta(cc);
  const address =
    buildShortAddressFromParts(
      [
        addr.country || countryMeta.nameZh,
        addr.state || addr.province || addr.region,
        addr.city || addr.town || addr.village || addr.county,
        addr.suburb || addr.city_district || addr.neighbourhood || addr.road,
      ],
      name
    ) || String(item.display_name || '');

  const typeKey = String(item.type || item.addresstype || '').toLowerCase();
  return {
    name,
    altName,
    address,
    display_name: item.display_name || (address ? `${name}, ${address}` : name),
    lat,
    lon,
    countryCode: cc,
    countryName: countryMeta.nameZh || addr.country || '',
    countryFlag: countryMeta.flag,
    placeId: '',
    categoryLabel: CATEGORY_ZH_LABELS[typeKey] || '',
    importance: Number(item.importance) || 0,
    source: 'nominatim',
  };
}

function normalizePhotonFeature(feat) {
  const coords = feat?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const p = feat.properties || {};
  const rawName = String(p.name || p.street || p.city || '').trim();
  if (!rawName) return null;

  const cc = String(p.countrycode || inferCountryCodeFromCoord(lat, lon) || '').toUpperCase();
  const countryMeta = getCountryDisplayMeta(cc);
  const address = buildShortAddressFromParts(
    [countryMeta.nameZh || p.country, p.state || p.county, p.city || p.district || p.locality, p.street],
    rawName
  );
  const typeKey = String(p.osm_value || p.type || '').toLowerCase();

  return {
    name: rawName,
    altName: '',
    address,
    display_name: address ? `${rawName}, ${address}` : rawName,
    lat,
    lon,
    countryCode: cc,
    countryName: countryMeta.nameZh || p.country || '',
    countryFlag: countryMeta.flag,
    placeId: '',
    categoryLabel: CATEGORY_ZH_LABELS[typeKey] || '',
    importance: 0.25,
    source: 'photon',
  };
}

function normalizeBackendGoogleItem(item) {
  const lat = Number(item?.lat);
  const lon = Number(item?.lon);
  const name = String(item?.name || '').trim();
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const cc = String(item.countryCode || inferCountryCodeFromCoord(lat, lon) || '').toUpperCase();
  const countryMeta = getCountryDisplayMeta(cc);
  const address = String(item.address || '').trim();

  return {
    name,
    altName: '',
    address,
    display_name: item.display_name || (address ? `${name}, ${address}` : name),
    lat,
    lon,
    countryCode: cc,
    countryName: countryMeta.nameZh || '',
    countryFlag: countryMeta.flag,
    placeId: item.placeId || '',
    categoryLabel: item.categoryLabel || '',
    importance: 0.9,
    source: 'google',
  };
}

function scoreNameSimilarity(item, canonicalQuery) {
  if (!canonicalQuery) return 0;
  const nameCanon = canonicalizePlaceName(item.name);
  const altCanon = canonicalizePlaceName(item.altName);
  const addrCanon = canonicalizePlaceName(item.address || item.display_name);

  if (nameCanon === canonicalQuery || (altCanon && altCanon === canonicalQuery)) return 420;
  if (nameCanon.startsWith(canonicalQuery) || (altCanon && altCanon.startsWith(canonicalQuery))) return 310;
  if (nameCanon.includes(canonicalQuery) || (altCanon && altCanon.includes(canonicalQuery))) return 210;

  // 若查詢包含多個字，計算共同字元命中率（例如「金澤美術館」命中「金沢21世紀美術館」）
  let matchedChars = 0;
  for (const ch of canonicalQuery) {
    if (nameCanon.includes(ch) || altCanon.includes(ch)) matchedChars++;
  }
  const ratio = matchedChars / canonicalQuery.length;
  if (ratio >= 0.75) return Math.round(135 * ratio);
  if (addrCanon.includes(canonicalQuery)) return 55;
  if (ratio >= 0.5) return Math.round(65 * ratio);
  return 0;
}

const SOURCE_WEIGHT = {
  google: 45,
  nominatim: 22,
  photon: 12,
};

/**
 * 統一去重並依「本計畫國家優先 → 跨語系名稱相似度 → 距離本計畫中心近 → 資料來源品質」排序
 */
export function rankAndDeduplicateSearchResults(
  rawItems = [],
  { query = '', tripCountries = [], focusCenter = null, maxResults = 10 } = {}
) {
  const canonicalQuery = canonicalizePlaceName(query);
  const normalizedCountries = (Array.isArray(tripCountries) ? tripCountries : [])
    .map((c) => String(c || '').trim().toUpperCase())
    .filter(Boolean);

  // 1. 補齊國家資訊並先依來源優先權整理，利於合併重複地標時保留最完整欄位
  const prepared = rawItems
    .filter((it) => it && it.name && Number.isFinite(Number(it.lat)) && Number.isFinite(Number(it.lon)))
    .map((it) => {
      const lat = Number(it.lat);
      const lon = Number(it.lon);
      const cc = String(it.countryCode || inferCountryCodeFromCoord(lat, lon) || '').toUpperCase();
      const meta = getCountryDisplayMeta(cc);
      const countryIdx = normalizedCountries.indexOf(cc);
      const inTripCountry = countryIdx !== -1;

      const nameScore = scoreNameSimilarity(it, canonicalQuery);
      let proximityScore = 0;
      if (focusCenter && Number.isFinite(focusCenter.lat) && Number.isFinite(focusCenter.lng)) {
        const km = calcDistanceKm(lat, lon, focusCenter.lat, focusCenter.lng);
        if (km <= 35) proximityScore = 70;
        else if (km <= 150) proximityScore = 45;
        else if (km <= 450) proximityScore = 25;
        else if (km <= 1200) proximityScore = 10;
      }

      const sourceScore = (SOURCE_WEIGHT[it.source] || 10) + Math.min(25, (Number(it.importance) || 0) * 25);
      const countryTierScore = inTripCountry ? 10000 - countryIdx * 500 : 0;

      return {
        ...it,
        lat,
        lon,
        countryCode: cc,
        countryName: it.countryName || meta.nameZh || '',
        countryFlag: it.countryFlag || meta.flag,
        inTripCountry,
        _score: countryTierScore + nameScore + proximityScore + sourceScore,
        _nameCanon: canonicalizePlaceName(it.name),
      };
    });

  prepared.sort((a, b) => b._score - a._score);

  // 2. 依近距離（<= 100m）與標準化地名去重
  const deduped = [];
  for (const item of prepared) {
    const existing = deduped.find((kept) => {
      const distKm = calcDistanceKm(kept.lat, kept.lon, item.lat, item.lon);
      if (distKm <= 0.05) return true;
      if (distKm <= 0.14 && kept._nameCanon && item._nameCanon && kept._nameCanon === item._nameCanon) {
        return true;
      }
      return false;
    });

    if (existing) {
      if (!existing.placeId && item.placeId) existing.placeId = item.placeId;
      if (!existing.altName && item.altName) existing.altName = item.altName;
      if (!existing.categoryLabel && item.categoryLabel) existing.categoryLabel = item.categoryLabel;
      continue;
    }
    deduped.push(item);
  }

  // 3. 確保「本計畫國家」優先於前段，且若有其他國家同名景點也保留於後方呈現
  const inCountry = deduped.filter((r) => r.inTripCountry);
  const otherCountry = deduped.filter((r) => !r.inTripCountry);

  let finalItems;
  if (inCountry.length > 0 && otherCountry.length > 0) {
    const primaryCap = Math.min(inCountry.length, Math.max(6, maxResults - Math.min(otherCountry.length, 3)));
    finalItems = [...inCountry.slice(0, primaryCap), ...otherCountry.slice(0, maxResults - primaryCap)];
  } else {
    finalItems = deduped.slice(0, maxResults);
  }

  return finalItems.map(({ _score, _nameCanon, ...clean }) => clean);
}

async function queryBackendGoogleSearch(query, { primaryCountry, focusCenter, signal }) {
  if (backendSearchAvailable === false) return [];
  const timed = createTimedSignal(signal, 3200);
  try {
    const qs = new URLSearchParams({ search: '1', q: query });
    if (primaryCountry) qs.set('country', primaryCountry);
    if (focusCenter) {
      qs.set('lat', String(focusCenter.lat));
      qs.set('lng', String(focusCenter.lng));
    }
    const res = await fetch(`/api/routes?${qs.toString()}`, { signal: timed.signal });
    if (!res.ok) return [];
    const data = await res.json();
    if (data?.status === 'unconfigured') {
      backendSearchAvailable = false;
      return [];
    }
    if (data?.status === 'ok' && Array.isArray(data.results)) {
      backendSearchAvailable = true;
      return data.results.map(normalizeBackendGoogleItem).filter(Boolean);
    }
    return [];
  } catch (err) {
    if (err?.name === 'AbortError' && signal?.aborted) throw err;
    return [];
  } finally {
    timed.cleanup();
  }
}

async function queryNominatimSearch(query, { countryCodes = [], limit = 6, signal } = {}) {
  const timed = createTimedSignal(signal, 4800);
  try {
    const qs = new URLSearchParams({
      format: 'jsonv2',
      limit: String(limit),
      addressdetails: '1',
      namedetails: '1',
      'accept-language': 'zh-TW,ja,en',
      q: query,
    });
    if (Array.isArray(countryCodes) && countryCodes.length > 0) {
      qs.set('countrycodes', countryCodes.map((c) => c.toLowerCase()).join(','));
    }
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs.toString()}`, {
      signal: timed.signal,
    });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list.map(normalizeNominatimItem).filter(Boolean) : [];
  } catch (err) {
    if (err?.name === 'AbortError' && signal?.aborted) throw err;
    return [];
  } finally {
    timed.cleanup();
  }
}

async function queryPhotonSearch(query, { focusCenter = null, limit = 6, signal } = {}) {
  const timed = createTimedSignal(signal, 3500);
  try {
    const qs = new URLSearchParams({
      q: query,
      limit: String(limit),
    });
    if (focusCenter && Number.isFinite(focusCenter.lat) && Number.isFinite(focusCenter.lng)) {
      qs.set('lat', String(focusCenter.lat));
      qs.set('lon', String(focusCenter.lng));
    }
    const res = await fetch(`https://photon.komoot.io/api/?${qs.toString()}`, {
      signal: timed.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    return features.map(normalizePhotonFeature).filter(Boolean);
  } catch (err) {
    if (err?.name === 'AbortError' && signal?.aborted) throw err;
    return [];
  } finally {
    timed.cleanup();
  }
}

/**
 * 即時智慧地點搜尋：並行查詢多來源 ＋ 繁簡日漢字通配 ＋ 依本計畫國家優先排序
 */
export async function searchPlaces(query, { tripCountries = [], focusCenter = null, signal = null } = {}) {
  const cleanQuery = String(query || '').trim();
  const normalizedCountries = (Array.isArray(tripCountries) ? tripCountries : [])
    .map((c) => String(c || '').trim().toUpperCase())
    .filter(Boolean);

  if (!cleanQuery) {
    return { results: [], convertedHint: '', tripCountries: normalizedCountries };
  }

  const { primary, variants, convertedHint } = buildSearchQueryVariants(cleanQuery, normalizedCountries);
  const cacheKey = `${cleanQuery.toLowerCase()}|${normalizedCountries.join(',')}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    return cached;
  }

  const primaryCountry = normalizedCountries[0] || '';
  const tasks = [];

  // 1. 後端 Google Places 搜尋（若已設定金鑰）
  tasks.push(queryBackendGoogleSearch(cleanQuery, { primaryCountry, focusCenter, signal }));

  // 2. 若本計畫已有標點國家，優先針對該國家（含日文新字體轉換變體）做精準檢索
  if (normalizedCountries.length > 0) {
    tasks.push(
      queryNominatimSearch(primary, {
        countryCodes: normalizedCountries,
        limit: 6,
        signal,
      })
    );
    if (variants[1] && variants[1] !== primary) {
      tasks.push(
        queryNominatimSearch(variants[1], {
          countryCodes: normalizedCountries,
          limit: 5,
          signal,
        })
      );
    }
    // 同時檢索全球其他國家同名地點（排序在後作為次要選項）
    tasks.push(queryNominatimSearch(cleanQuery, { limit: 6, signal }));
    if (convertedHint && convertedHint !== cleanQuery) {
      tasks.push(queryNominatimSearch(convertedHint, { limit: 5, signal }));
    }
  } else {
    // 尚未標點的空白計畫：對原字與跨語系轉換變體做全球搜尋
    tasks.push(queryNominatimSearch(variants[0], { limit: 6, signal }));
    if (variants[1]) {
      tasks.push(queryNominatimSearch(variants[1], { limit: 6, signal }));
    }
  }

  // 3. Photon 快速自動完成引擎（對即時輸入友善，不限速）
  tasks.push(queryPhotonSearch(primary, { focusCenter, limit: 6, signal }));
  if (convertedHint && convertedHint !== primary) {
    tasks.push(queryPhotonSearch(convertedHint, { focusCenter, limit: 5, signal }));
  }

  const settled = await Promise.allSettled(tasks);
  if (signal?.aborted) {
    const abortErr = new Error('Search aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const merged = [];
  for (const res of settled) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      merged.push(...res.value);
    }
  }

  // 若結果為日文新字體且與繁體使用者查詢不同，補充顯示繁體對照（例如 altName）
  const enriched = merged.map((item) => {
    if (!item.altName && item.countryCode === 'JP') {
      const tradName = toTraditionalChinese(item.name);
      if (tradName && tradName !== item.name && canonicalizePlaceName(tradName) !== canonicalizePlaceName(item.name)) {
        return { ...item, altName: tradName };
      }
    }
    return item;
  });

  const results = rankAndDeduplicateSearchResults(enriched, {
    query: cleanQuery,
    tripCountries: normalizedCountries,
    focusCenter,
    maxResults: 10,
  });

  const payload = {
    results,
    convertedHint,
    tripCountries: normalizedCountries,
  };

  if (results.length > 0) {
    setCachedSearch(cacheKey, payload);
  }
  return payload;
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
