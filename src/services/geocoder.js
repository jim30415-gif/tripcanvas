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
const PLACE_DETAILS_CACHE_MAX = 80;
const searchCache = new Map();
const placeDetailsCache = new Map();
let backendSearchAvailable = null; // null=未知, true=可用, false=未設定金鑰或未啟用 Places API
let backendReverseAvailable = null;

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

function getCachedPlaceDetails(placeId) {
  if (!placeDetailsCache.has(placeId)) return null;
  const val = placeDetailsCache.get(placeId);
  placeDetailsCache.delete(placeId);
  placeDetailsCache.set(placeId, val);
  return { ...val };
}

function setCachedPlaceDetails(placeId, value) {
  if (!placeId || !value) return;
  if (placeDetailsCache.size >= PLACE_DETAILS_CACHE_MAX) {
    const oldestKey = placeDetailsCache.keys().next().value;
    if (oldestKey !== undefined) placeDetailsCache.delete(oldestKey);
  }
  placeDetailsCache.set(placeId, { ...value });
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

  // 2. 依近距離與標準化地名去重（避免 50m 內不同名稱的相鄰店家／咖啡廳被誤刪）
  const deduped = [];
  for (const item of prepared) {
    const existing = deduped.find((kept) => {
      if (kept.placeId && item.placeId && kept.placeId === item.placeId) return true;
      const distKm = calcDistanceKm(kept.lat, kept.lon, item.lat, item.lon);
      const sameName =
        Boolean(kept._nameCanon && item._nameCanon) &&
        (kept._nameCanon === item._nameCanon ||
          kept._nameCanon.includes(item._nameCanon) ||
          item._nameCanon.includes(kept._nameCanon));
      if (distKm <= 0.05 && sameName) return true;
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
    if (focusCenter && Number.isFinite(focusCenter.lat) && Number.isFinite(focusCenter.lng)) {
      qs.set('lat', String(focusCenter.lat));
      qs.set('lng', String(focusCenter.lng));
    }
    const res = await fetch(`/api/routes?${qs.toString()}`, { signal: timed.signal });
    if (!res.ok) return [];
    const data = await res.json();
    if (data?.status === 'unconfigured' || data?.status === 'places_api_disabled') {
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
 * - 即時輸入（isLive）優先使用 Google Places ＋ Photon，避免向 Nominatim 發動多併發請求觸發 429 封鎖；
 *   僅於前兩者結果不足或使用者明確按下「搜尋／Enter」時，才補充最多 1–2 筆 Nominatim 查詢。
 */
export async function searchPlaces(
  query,
  { tripCountries = [], focusCenter = null, signal = null, isLive = false } = {}
) {
  const cleanQuery = String(query || '').trim();
  const normalizedCountries = (Array.isArray(tripCountries) ? tripCountries : [])
    .map((c) => String(c || '').trim().toUpperCase())
    .filter(Boolean);

  if (!cleanQuery) {
    return { results: [], convertedHint: '', tripCountries: normalizedCountries };
  }

  const { primary, variants, convertedHint } = buildSearchQueryVariants(cleanQuery, normalizedCountries);
  const focusKey =
    focusCenter && Number.isFinite(focusCenter.lat) && Number.isFinite(focusCenter.lng)
      ? `${Number(focusCenter.lat).toFixed(1)},${Number(focusCenter.lng).toFixed(1)}`
      : '';
  const cacheKey = `${cleanQuery.toLowerCase()}|${normalizedCountries.join(',')}|${focusKey}|${isLive ? 'L' : 'S'}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    return cached;
  }

  const primaryCountry = normalizedCountries[0] || '';
  const fastTasks = [
    queryBackendGoogleSearch(cleanQuery, { primaryCountry, focusCenter, signal }),
    queryPhotonSearch(primary, { focusCenter, limit: 6, signal }),
  ];
  if (convertedHint && convertedHint !== primary) {
    fastTasks.push(queryPhotonSearch(convertedHint, { focusCenter, limit: 5, signal }));
  }

  const fastSettled = await Promise.allSettled(fastTasks);
  if (signal?.aborted) {
    const abortErr = new Error('Search aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const merged = [];
  for (const res of fastSettled) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      merged.push(...res.value);
    }
  }

  // Nominatim 限流嚴格：即時輸入只在 Google+Photon 幾乎沒結果時補查 1 筆；明確送出搜尋時最多補查 1–2 筆
  if (!isLive || merged.length < 3) {
    const nomTasks = [];
    if (normalizedCountries.length > 0) {
      nomTasks.push(
        queryNominatimSearch(primary, {
          countryCodes: normalizedCountries,
          limit: 6,
          signal,
        })
      );
      if (!isLive) {
        nomTasks.push(queryNominatimSearch(cleanQuery, { limit: 5, signal }));
      }
    } else {
      nomTasks.push(queryNominatimSearch(variants[0], { limit: 6, signal }));
      if (!isLive && variants[1]) {
        nomTasks.push(queryNominatimSearch(variants[1], { limit: 5, signal }));
      }
    }
    const nomSettled = await Promise.allSettled(nomTasks);
    if (signal?.aborted) {
      const abortErr = new Error('Search aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    for (const res of nomSettled) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        merged.push(...res.value);
      }
    }
  }

  // 若結果為日文新字體且與繁體寫法不同，補充顯示繁體對照（例如 altName：金沢駅 → 金澤車站）
  const enriched = merged.map((item) => {
    if (!item.altName && item.countryCode === 'JP') {
      const tradName = toTraditionalChinese(item.name);
      if (tradName && tradName !== item.name) {
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

export function isCjkRegionCoord(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  return Number.isFinite(la) && Number.isFinite(ln) && la >= 18 && la <= 46 && ln >= 100 && ln <= 146;
}

function hasCjkChars(str) {
  return /[\u3400-\u9FFF\u3040-\u30FF]/.test(String(str || ''));
}

function isPureLatinName(str) {
  const s = String(str || '').trim();
  return /[A-Za-z]/.test(s) && !/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(s);
}

export function pickLocalizedTagName(tags = {}) {
  if (!tags || typeof tags !== 'object') return '';
  const ordered = [
    tags['name:zh-Hant-TW'],
    tags['name:zh-TW'],
    tags['name:zh-Hant'],
    tags['name:zh'],
    tags['official_name:zh-TW'],
    tags['official_name:zh-Hant'],
    tags['official_name:zh'],
    tags['name:ja'],
    tags['official_name:ja'],
    tags['brand:zh-TW'],
    tags['brand:zh-Hant'],
    tags['brand:zh'],
    tags['brand:ja'],
    tags.name,
    tags.brand,
  ];
  for (const cand of ordered) {
    const clean = typeof cand === 'string' ? cand.trim() : '';
    if (clean) return clean;
  }
  return '';
}

/**
 * 依「地標名稱優先（繁中／日文優先於純英文） → 路名次之 → 街區備援」解析 Nominatim zoom=18 回傳結果
 */
export function pickPlaceNameFromNominatim(data) {
  if (!data || typeof data !== 'object') return null;
  const addr = data.address || {};
  const category = String(data.category || data.class || '').toLowerCase();
  const typeVal = String(data.type || '').toLowerCase();

  const isJunkCategory =
    NOMINATIM_NON_POI_CATEGORIES.has(category) ||
    JUNK_PHOTON_KEYS.has(category) ||
    (category === 'amenity' && JUNK_OSM_AMENITIES.has(typeVal)) ||
    (category === 'tourism' && JUNK_TOURISM_VALUES.has(typeVal)) ||
    (category === 'railway' && JUNK_RAILWAY_VALUES.has(typeVal));

  // 1. 若 Nominatim 直接命中有效 POI 地標，優先取 namedetails 內的繁中／日文名稱
  if (!isJunkCategory) {
    const localizedFromDetails = pickLocalizedTagName(data.namedetails);
    const rawName = (localizedFromDetails || data.name || '').trim();
    if (rawName && !GENERIC_PLACEHOLDER_NAMES.has(rawName)) {
      const roadStr = (addr.road || '').trim();
      if (!roadStr || rawName !== roadStr) {
        return rawName;
      }
    }

    for (const key of NOMINATIM_POI_KEYS) {
      const val = (addr[key] || '').trim();
      if (val && !GENERIC_PLACEHOLDER_NAMES.has(val)) return val;
    }
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

const JUNK_OSM_AMENITIES = new Set([
  'drinking_water',
  'vending_machine',
  'bench',
  'waste_basket',
  'toilets',
  'atm',
  'recycling',
  'post_box',
  'fire_hydrant',
  'parking',
  'parking_entrance',
  'parking_space',
  'bicycle_parking',
  'bicycle_rental',
  'motorcycle_parking',
  'clock',
  'telephone',
  'charging_station',
  'letter_box',
  'parcel_locker',
  'shelter',
  'water_point',
  'fountain',
  'ticket_validator',
  'loading_dock',
  'smoking_area',
  'bbq',
  'lounger',
  'watering_place',
]);

const JUNK_PHOTON_KEYS = new Set([
  'place',
  'highway',
  'boundary',
  'information',
  'water',
  'natural',
  'landuse',
  'barrier',
  'power',
  'public_transport',
]);

const JUNK_TOURISM_VALUES = new Set(['photopoint', 'information', 'artwork', 'picnic_site', 'camp_pitch']);

const JUNK_RAILWAY_VALUES = new Set([
  'stop',
  'platform',
  'subway_entrance',
  'train_station_entrance',
  'switch',
  'signal',
  'crossing',
  'rail',
  'tram_stop',
]);

const JUNK_MAN_MADE_VALUES = new Set([
  'bridge',
  'surveillance',
  'flagpole',
  'street_cabinet',
  'utility_pole',
  'manhole',
  'lamp',
  'mast',
]);

const GENERIC_PLACEHOLDER_NAMES = new Set([
  '商辦大樓',
  '辦公大樓',
  '停車場',
  '地下停車場',
  '飲水機',
  '公廁',
  '廁所',
  '售票機',
  '自動販賣機',
]);

function computeOsmReverseRadiusMeters(zoom) {
  const z = Number(zoom);
  if (!Number.isFinite(z)) return 65;
  if (z >= 19) return 45;
  if (z >= 18) return 60;
  if (z >= 17) return 80;
  if (z >= 16) return 110;
  return 140;
}

function isJunkOsmElement(tags = {}, name = '') {
  if (!name || GENERIC_PLACEHOLDER_NAMES.has(name)) return true;
  const amenity = String(tags.amenity || '').toLowerCase();
  const tourism = String(tags.tourism || '').toLowerCase();
  const railway = String(tags.railway || '').toLowerCase();
  const manMade = String(tags.man_made || '').toLowerCase();

  if (JUNK_OSM_AMENITIES.has(amenity)) return true;
  if (tourism && JUNK_TOURISM_VALUES.has(tourism)) return true;
  if (railway && JUNK_RAILWAY_VALUES.has(railway) && !tags.shop && !tags.tourism && !tags.amenity) return true;
  if (manMade && JUNK_MAN_MADE_VALUES.has(manMade) && !tags.tourism && !tags.historic) return true;
  if (tags.information || tags.water || tags.natural === 'tree') return true;
  if (tags.emergency === 'fire_hydrant') return true;
  if (tags.highway || tags.boundary || tags.route) return true;
  return false;
}

function scorePoiCategoryAndLocale(key, val, name, distKm, inCjkRegion) {
  let tagBonus = 20;
  if (
    (key === 'tourism' && ['attraction', 'museum', 'gallery', 'theme_park', 'zoo', 'aquarium', 'viewpoint'].includes(val)) ||
    (key === 'man_made' && ['tower', 'lighthouse', 'observatory', 'pier'].includes(val)) ||
    (key === 'aeroway' && ['aerodrome', 'terminal'].includes(val)) ||
    (key === 'historic' && ['castle', 'temple', 'shrine', 'monument', 'memorial', 'ruins', 'building'].includes(val)) ||
    (key === 'shop' && ['mall', 'department_store'].includes(val)) ||
    (key === 'railway' && ['station', 'halt'].includes(val)) ||
    (key === 'leisure' && ['park', 'garden', 'stadium'].includes(val))
  ) {
    tagBonus = 46;
  } else if (
    key === 'shop' ||
    key === 'tourism' ||
    key === 'historic' ||
    (key === 'amenity' &&
      [
        'restaurant',
        'cafe',
        'fast_food',
        'food_court',
        'bar',
        'pub',
        'marketplace',
        'cinema',
        'theatre',
        'arts_centre',
        'library',
        'museum',
        'place_of_worship',
        'hospital',
        'university',
      ].includes(val))
  ) {
    tagBonus = 38;
  } else if (key === 'building') {
    tagBonus = val && val !== 'yes' ? 14 : 8;
  }

  let localeAdj = 0;
  if (inCjkRegion) {
    if (hasCjkChars(name)) localeAdj = 14;
    else if (isPureLatinName(name)) localeAdj = -24;
  }

  return tagBonus + localeAdj - distKm * 480;
}

function pickPrimaryOsmKeyVal(tags = {}) {
  for (const k of ['tourism', 'historic', 'aeroway', 'railway', 'shop', 'amenity', 'leisure', 'man_made', 'craft', 'healthcare', 'building']) {
    if (tags[k]) return [k, String(tags[k]).toLowerCase()];
  }
  return ['other', ''];
}

/**
 * 解析 Photon Reverse 回傳的鄰近具名地標（排除門牌、道路、導覽牌、水池、微設施，並於東亞區優先繁中／日文）
 */
export function pickBestPoisFromPhoton(data, lat, lng, maxDistKm = 0.095) {
  const features = Array.isArray(data?.features) ? data.features : [];
  const inCjkRegion = isCjkRegionCoord(lat, lng);
  const ranked = [];
  const seen = new Set();

  for (const feat of features) {
    const p = feat?.properties || {};
    const name = String(p.name || '').trim();
    if (!name || GENERIC_PLACEHOLDER_NAMES.has(name)) continue;

    const key = String(p.osm_key || '').toLowerCase();
    const val = String(p.osm_value || '').toLowerCase();
    if (NOMINATIM_NON_POI_CATEGORIES.has(key) || JUNK_PHOTON_KEYS.has(key)) continue;
    if (key === 'amenity' && JUNK_OSM_AMENITIES.has(val)) continue;
    if (key === 'tourism' && JUNK_TOURISM_VALUES.has(val)) continue;
    if (key === 'railway' && JUNK_RAILWAY_VALUES.has(val)) continue;
    if (key === 'man_made' && JUNK_MAN_MADE_VALUES.has(val)) continue;

    const coords = feat?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const pLat = Number(coords[1]);
    const pLng = Number(coords[0]);
    const distKm = calcDistanceKm(lat, lng, pLat, pLng);
    if (!Number.isFinite(distKm) || distKm > maxDistKm) continue;

    const canon = canonicalizePlaceName(name);
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);

    const score = scorePoiCategoryAndLocale(key, val, name, distKm, inCjkRegion);
    ranked.push({
      name,
      placeId: '',
      lat: Number(pLat.toFixed(6)),
      lng: Number(pLng.toFixed(6)),
      distKm,
      distanceMeters: Math.round(distKm * 1000),
      score,
      source: 'photon_poi',
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, 5);
}

async function queryBackendGoogleReverse(lat, lng, zoom, signal) {
  if (backendReverseAvailable === false) return null;
  const timed = createTimedSignal(signal, 4200);
  try {
    const qs = new URLSearchParams({
      reverse: '1',
      lat: String(lat),
      lng: String(lng),
    });
    if (zoom != null && zoom !== '' && Number.isFinite(Number(zoom))) {
      qs.set('zoom', String(Math.round(Number(zoom))));
    }
    const res = await fetch(`/api/routes?${qs.toString()}`, { signal: timed.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.status === 'unconfigured' || data?.status === 'places_api_disabled') {
      backendReverseAvailable = false;
      return null;
    }
    if (data?.status === 'ok' && data?.name) {
      backendReverseAvailable = true;
      const result = {
        name: String(data.name).trim(),
        placeId: data.placeId || '',
        source: data.source || 'google',
        snapped: data.snapped === true,
        candidates: Array.isArray(data.candidates) ? data.candidates : [],
        countryCode: typeof data.countryCode === 'string' ? data.countryCode : '',
      };
      if (Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lng))) {
        result.lat = Number(data.lat);
        result.lng = Number(data.lng);
      }
      if (Number.isFinite(Number(data.distanceMeters))) {
        result.distanceMeters = Number(data.distanceMeters);
      }
      return result;
    }
    return null;
  } catch {
    return null;
  } finally {
    timed.cleanup();
  }
}

async function queryPhotonReverse(lat, lng, radiusMeters, signal) {
  const timed = createTimedSignal(signal, 3200);
  try {
    const radiusKm = Math.max(0.045, Math.min(0.14, radiusMeters / 1000));
    const url = `https://photon.komoot.io/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&limit=18&radius=${radiusKm.toFixed(3)}`;
    const res = await fetch(url, { signal: timed.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return pickBestPoisFromPhoton(data, lat, lng, radiusKm + 0.025);
  } catch {
    return [];
  } finally {
    timed.cleanup();
  }
}

async function fetchOverpassPoisFromEndpoint(endpoint, lat, lng, radiusMeters, signal) {
  const timed = createTimedSignal(signal, 3000);
  try {
    const inCjkRegion = isCjkRegionCoord(lat, lng);
    const query = `[out:json][timeout:3];nwr(around:${radiusMeters},${lat},${lng})["name"][!"highway"][!"boundary"][!"place"];out center 18;`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: `data=${encodeURIComponent(query)}`,
      signal: timed.signal,
    });
    if (!res.ok) return { ok: false, items: [] };
    const data = await res.json();
    const elements = Array.isArray(data?.elements) ? data.elements : [];
    const ranked = [];
    const seen = new Set();

    for (const el of elements) {
      const name = pickLocalizedTagName(el.tags);
      if (isJunkOsmElement(el.tags, name)) continue;
      const eLat = Number(el.lat ?? el.center?.lat);
      const eLng = Number(el.lon ?? el.center?.lon);
      if (!Number.isFinite(eLat) || !Number.isFinite(eLng)) continue;
      const canon = canonicalizePlaceName(name);
      if (!canon || seen.has(canon)) continue;
      seen.add(canon);

      const distKm = calcDistanceKm(lat, lng, eLat, eLng);
      const [key, val] = pickPrimaryOsmKeyVal(el.tags);
      const score = scorePoiCategoryAndLocale(key, val, name, distKm, inCjkRegion);
      ranked.push({
        name,
        placeId: '',
        lat: Number(eLat.toFixed(6)),
        lng: Number(eLng.toFixed(6)),
        distKm,
        distanceMeters: Math.round(distKm * 1000),
        score,
        source: 'osm_poi',
      });
    }
    ranked.sort((a, b) => b.score - a.score);
    return { ok: true, items: ranked.slice(0, 5) };
  } catch {
    return { ok: false, items: [] };
  } finally {
    timed.cleanup();
  }
}

async function queryNearbyOsmPois(lat, lng, radiusMeters, signal) {
  const primary = await fetchOverpassPoisFromEndpoint(
    'https://overpass-api.de/api/interpreter',
    lat,
    lng,
    radiusMeters,
    signal
  );
  // 主節點成功回傳 200（即使空結果）即直接回傳，不再浪費 +3 秒等備用鏡像
  if (primary.ok) return primary.items;
  if (signal?.aborted) return [];
  const backup = await fetchOverpassPoisFromEndpoint(
    'https://overpass.kumi.systems/api/interpreter',
    lat,
    lng,
    radiusMeters,
    signal
  );
  return backup.items;
}

async function queryNominatimReverse(lat, lng, signal) {
  const timed = createTimedSignal(signal, 4500);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=zh-TW,zh-Hant,zh,ja&zoom=18&addressdetails=1&namedetails=1`,
      { signal: timed.signal }
    );
    if (!res.ok) return { name: null, countryCode: '' };
    const data = await res.json();
    const countryCode = String(data?.address?.country_code || '').trim().toUpperCase();
    return { name: pickPlaceNameFromNominatim(data), countryCode };
  } catch {
    return { name: null, countryCode: '' };
  } finally {
    timed.cleanup();
  }
}

export async function reverseGeocode(lat, lng, { zoom = 17, signal = null } = {}) {
  // 1. 優先查詢後端 Google Maps 標點（依縮放動態半徑抓 POI 與精確吸附座標，其次路名）
  const googleHit = await queryBackendGoogleReverse(lat, lng, zoom, signal);
  if (signal?.aborted) return null;
  if (googleHit?.name && googleHit.source === 'google_poi') {
    return googleHit;
  }

  // 2. 若未命中 Google POI，三軌並行比對：Photon Reverse ＋ Overpass ＋ Nominatim zoom=18
  const osmRadius = computeOsmReverseRadiusMeters(zoom);
  const [photonPois, osmPois, nominatimRes] = await Promise.all([
    queryPhotonReverse(lat, lng, osmRadius, signal),
    queryNearbyOsmPois(lat, lng, osmRadius, signal),
    queryNominatimReverse(lat, lng, signal),
  ]);
  if (signal?.aborted) return null;

  const nominatimName = nominatimRes?.name || null;
  const countryCode = googleHit?.countryCode || nominatimRes?.countryCode || '';

  const combinedPois = [...osmPois, ...photonPois];
  combinedPois.sort((a, b) => b.score - a.score);
  const dedupedPois = [];
  const seenCanon = new Set();
  for (const p of combinedPois) {
    const canon = canonicalizePlaceName(p.name);
    if (!canon || seenCanon.has(canon)) continue;
    seenCanon.add(canon);
    const item = { name: p.name, placeId: p.placeId || '' };
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      item.lat = p.lat;
      item.lng = p.lng;
      item.distanceMeters = p.distanceMeters;
    }
    dedupedPois.push(item);
    if (dedupedPois.length >= 5) break;
  }

  if (dedupedPois.length > 0) {
    const top = dedupedPois[0];
    const hasCoords = Number.isFinite(top.lat) && Number.isFinite(top.lng);
    const out = {
      name: top.name,
      placeId: top.placeId,
      source: 'osm_poi',
      snapped: false,
      countryCode,
      candidates: dedupedPois.length > 1 ? dedupedPois : [],
    };
    if (hasCoords) {
      out.lat = top.lat;
      out.lng = top.lng;
      out.distanceMeters = top.distanceMeters;
    }
    return out;
  }
  if (googleHit?.name) {
    return { ...googleHit, countryCode: googleHit.countryCode || countryCode };
  }
  if (nominatimName) {
    return { name: nominatimName, placeId: '', source: 'nominatim', snapped: false, countryCode, candidates: [] };
  }
  return null;
}

/**
 * 透過 Google Maps 原生點擊底圖圖示取得的 placeId，精準取得該圖示對應的繁中名稱與座標
 * 優先讀取同工作階段 LRU 快取（避免重複點擊同一底圖圖示重複計費），未命中再走後端代理與瀏覽器備援。
 */
export async function fetchPlaceDetailsById(placeId, { signal = null } = {}) {
  const cleanId = String(placeId || '').trim();
  if (!cleanId) return null;

  const cached = getCachedPlaceDetails(cleanId);
  if (cached) return cached;

  // 1. 優先走同源伺服器代理（避免瀏覽器金鑰權限不足）
  const timed = createTimedSignal(signal, 3800);
  try {
    const qs = new URLSearchParams({ place: '1', placeId: cleanId });
    const res = await fetch(`/api/routes?${qs.toString()}`, { signal: timed.signal });
    if (res.ok) {
      const data = await res.json();
      if (data?.status === 'ok' && data?.name) {
        const result = {
          placeId: data.placeId || cleanId,
          name: String(data.name).trim(),
          lat: Number.isFinite(Number(data.lat)) ? Number(data.lat) : null,
          lng: Number.isFinite(Number(data.lng)) ? Number(data.lng) : null,
          address: data.address || '',
          categoryLabel: data.categoryLabel || '',
          countryCode: data.countryCode || '',
          source: 'google_place_id',
        };
        setCachedPlaceDetails(cleanId, result);
        return result;
      }
    }
  } catch {
    if (signal?.aborted) return null;
    // fallback to client SDK below
  } finally {
    timed.cleanup();
  }

  if (signal?.aborted) return null;

  // 2. 瀏覽器端 Google Maps Places Library 備援（附 3.8 秒逾時保護）
  try {
    const g = typeof window !== 'undefined' ? window.google : null;
    if (g?.maps?.importLibrary) {
      const fetchClientPlace = async () => {
        const placesLib = await g.maps.importLibrary('places');
        if (!placesLib?.Place) return null;
        const place = new placesLib.Place({ id: cleanId, requestedLanguage: 'zh-TW' });
        await place.fetchFields({
          fields: ['id', 'displayName', 'location', 'formattedAddress', 'primaryTypeDisplayName'],
        });
        const name = String(place.displayName || '').trim();
        if (!name) return null;
        const loc = place.location;
        const pLat = typeof loc?.lat === 'function' ? loc.lat() : Number(loc?.lat);
        const pLng = typeof loc?.lng === 'function' ? loc.lng() : Number(loc?.lng);
        return {
          placeId: place.id || cleanId,
          name,
          lat: Number.isFinite(pLat) ? Number(pLat.toFixed(6)) : null,
          lng: Number.isFinite(pLng) ? Number(pLng.toFixed(6)) : null,
          address: place.formattedAddress || '',
          categoryLabel: place.primaryTypeDisplayName || '',
          countryCode: '',
          source: 'google_place_id',
        };
      };

      let timeoutId = null;
      const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(null), 3800);
      });
      try {
        const result = await Promise.race([fetchClientPlace(), timeoutPromise]);
        if (result && !signal?.aborted) {
          setCachedPlaceDetails(cleanId, result);
          return result;
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
  } catch {
    // ignore
  }

  return null;
}
