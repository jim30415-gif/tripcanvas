import { decodePolyline, encodePolyline, stitchEncodedPolylines } from '../src/services/polyline.js';
import { convertMoneyToTwd } from './currency.js';
import { isJapanTrip } from './navitime.js';
import { formatLineDisplayName } from './routesHandler.js';
import { fetchJsonWithTimeout, parseOptionalFiniteNumber } from './security.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-3.6-flash',
  'gemini-2.5-flash-lite',
];

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB 解碼後上限
const MAX_STOPS_PER_REQUEST = 6; // 每次截圖最多定位 6 個站牌（上下車 + 最多 3 中途站；全程免費 Photon / OSM，不觸碰 Google Places 計費）
const MAX_INTERMEDIATE_STOPS = 3;
const STOP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_STOP_CACHE = 500;
const MAX_IP_DAILY_KEYS = 1000;

const DATA_IMAGE_RE = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

const VALID_VEHICLE_TYPES = new Set([
  'BUS',
  'SUBWAY',
  'METRO_RAIL',
  'RAIL',
  'HEAVY_RAIL',
  'TRAM',
  'LIGHT_RAIL',
  'FERRY',
  'CABLE_CAR',
  'OTHER',
]);

const ROAD_TRANSIT_TYPES = new Set(['BUS', 'TRAM', 'OTHER']);

const VEHICLE_META = {
  BUS: { label: '公車', emoji: '🚌', defaultColor: '#2E7D5B' },
  SUBWAY: { label: '地鐵／捷運', emoji: '🚇', defaultColor: '#2B6CB0' },
  METRO_RAIL: { label: '地鐵', emoji: '🚇', defaultColor: '#2B6CB0' },
  RAIL: { label: '鐵路', emoji: '🚆', defaultColor: '#4A5568' },
  HEAVY_RAIL: { label: '鐵路', emoji: '🚆', defaultColor: '#4A5568' },
  TRAM: { label: '路面電車', emoji: '🚊', defaultColor: '#B7791F' },
  LIGHT_RAIL: { label: '輕軌', emoji: '🚊', defaultColor: '#B7791F' },
  FERRY: { label: '渡輪', emoji: '⛴️', defaultColor: '#2C7A7B' },
  CABLE_CAR: { label: '纜車', emoji: '🚡', defaultColor: '#805AD5' },
  OTHER: { label: '大眾運輸', emoji: '🚌', defaultColor: '#5B758A' },
};

const PHOTON_BUS_VALUES = new Set(['bus_stop', 'bus_station', 'tram_stop', 'platform', 'stop_position']);
const PHOTON_RAIL_VALUES = new Set(['station', 'halt', 'subway_entrance', 'tram_stop']);

// ==================== 1. 免費層安全配額與防刷爆保護 ====================

function getUtcDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function parsePositiveInt(raw, fallback, min = 1, max = 10000) {
  const n = parseOptionalFiniteNumber(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, Math.floor(n));
}

function createInitialQuotaState(dayKey = getUtcDayKey()) {
  return {
    dayKey,
    globalParseCount: 0,
    ipDailyCounts: new Map(),
    geminiLockedUntil: 0,
    geminiLockReason: '',
  };
}

let quotaState = createInitialQuotaState();
let resolvedWorkingModel = '';
const stopGeocodeCache = new Map();

function ensureCurrentDayBucket(now = Date.now()) {
  const today = getUtcDayKey(now);
  if (quotaState.dayKey !== today) {
    quotaState = createInitialQuotaState(today);
  }
}

export function resetScreenshotQuotaStateForTest() {
  quotaState = createInitialQuotaState();
  resolvedWorkingModel = '';
  stopGeocodeCache.clear();
}

function getQuotaLimits(env = process.env) {
  return {
    dailyParseLimit: parsePositiveInt(env?.SCREENSHOT_DAILY_LIMIT, 80, 1, 2000),
    maxPerIpDay: parsePositiveInt(env?.SCREENSHOT_MAX_PER_IP_DAY, 15, 1, 500),
  };
}

function getGeminiApiKey(env = process.env) {
  return String(env?.GEMINI_API_KEY || env?.GOOGLE_AI_STUDIO_API_KEY || '').trim();
}

export function getScreenshotFeatureStatus(env = process.env, now = Date.now()) {
  ensureCurrentDayBucket(now);
  const geminiKey = getGeminiApiKey(env);
  const limits = getQuotaLimits(env);

  if (!geminiKey) {
    return {
      enabled: false,
      locked: false,
      reason: 'UNCONFIGURED',
      message: '伺服器尚未設定 GEMINI_API_KEY（Google AI Studio 免費金鑰），暫不開放截圖辨識匯入。',
      stopGeocoder: 'osm_free',
      limits: {
        dailyParseRemaining: 0,
      },
    };
  }

  const dailyParseRemaining = Math.max(0, limits.dailyParseLimit - quotaState.globalParseCount);

  if (quotaState.geminiLockedUntil > now) {
    return {
      enabled: true,
      locked: true,
      reason: quotaState.geminiLockReason || 'GEMINI_QUOTA_EXCEEDED',
      message: 'Google AI Studio 免費視覺辨識額度暫時達上限，請稍後再試或改用手動填寫。',
      stopGeocoder: 'osm_free',
      limits: { dailyParseRemaining },
    };
  }

  if (dailyParseRemaining <= 0) {
    return {
      enabled: true,
      locked: true,
      reason: 'DAILY_PARSE_CAP',
      message: '今日免費截圖匯入總次數已達安全上限，明日將自動恢復，請先改用手動填寫。',
      stopGeocoder: 'osm_free',
      limits: { dailyParseRemaining: 0 },
    };
  }

  return {
    enabled: true,
    locked: false,
    reason: '',
    message: '',
    stopGeocoder: 'osm_free',
    limits: { dailyParseRemaining },
  };
}

function tripGeminiQuotaLock(reason = 'GEMINI_QUOTA_EXCEEDED', now = Date.now()) {
  ensureCurrentDayBucket(now);
  // 免費層 RPM / RPD 保護：先冷卻 10 分鐘（若為 RPD 達上限則下次嘗試再鎖）
  quotaState.geminiLockedUntil = now + 10 * 60 * 1000;
  quotaState.geminiLockReason = reason;
}

function checkAndRecordIpDaily(ip, maxPerIpDay, now = Date.now(), { increment = false } = {}) {
  ensureCurrentDayBucket(now);
  const key = String(ip || 'local').slice(0, 64);
  const current = quotaState.ipDailyCounts.get(key) || 0;
  if (current >= maxPerIpDay) {
    return { allowed: false, remaining: 0 };
  }
  if (increment) {
    if (!quotaState.ipDailyCounts.has(key) && quotaState.ipDailyCounts.size >= MAX_IP_DAILY_KEYS) {
      const oldest = quotaState.ipDailyCounts.keys().next().value;
      if (oldest !== undefined) quotaState.ipDailyCounts.delete(oldest);
    }
    quotaState.ipDailyCounts.set(key, current + 1);
    return { allowed: true, remaining: Math.max(0, maxPerIpDay - (current + 1)) };
  }
  return { allowed: true, remaining: Math.max(0, maxPerIpDay - current) };
}

// ==================== 2. 幾何與輸入驗證工具 ====================

function isValidCoord(pt) {
  return (
    pt &&
    typeof pt.lat === 'number' &&
    typeof pt.lng === 'number' &&
    Number.isFinite(pt.lat) &&
    Number.isFinite(pt.lng) &&
    pt.lat >= -85 &&
    pt.lat <= 85 &&
    pt.lng >= -180 &&
    pt.lng <= 180
  );
}

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

function pointToSegmentKm(p, a, b) {
  const distAB = calcDistanceKm(a.lat, a.lng, b.lat, b.lng);
  if (distAB < 0.05) return calcDistanceKm(p.lat, p.lng, a.lat, a.lng);

  // 小範圍以平面近似投影計算距離
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const ax = a.lng * cosLat;
  const ay = a.lat;
  const bx = b.lng * cosLat;
  const by = b.lat;
  const px = p.lng * cosLat;
  const py = p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const projLat = ay + t * dy;
  const projLng = (ax + t * dx) / Math.max(0.01, cosLat);
  return calcDistanceKm(p.lat, p.lng, projLat, projLng);
}

function sanitizeHexColor(raw = '') {
  const s = String(raw || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const [, r, g, b] = s;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return '';
}

function parseImageDataUrl(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(DATA_IMAGE_RE);
  if (!match) return null;
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const base64Data = match[2].replace(/\s+/g, '');
  if (!base64Data) return null;
  const approxBytes = Math.floor((base64Data.length * 3) / 4);
  if (approxBytes < 100 || approxBytes > MAX_IMAGE_BYTES) return null;
  return { mimeType, base64Data, approxBytes };
}

function toHalfWidthAscii(raw) {
  return String(raw || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[～〜]/g, '~');
}

function normalizeText(raw, maxLen = 80) {
  return toHalfWidthAscii(raw)
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function cleanStopName(raw) {
  let s = normalizeText(raw, 64);
  if (!s) return '';
  // 去除 Google Maps / 時刻表常見尾綴，保留精準站名以利 Photon / OSM 定位
  s = s
    .replace(/\s*\((?:バス|バス停|公車|公車站|停留所|bus(?:\s*stop)?)\)\s*$/i, '')
    .replace(/\s*(?:バス停|停留所|公車站牌|公車站|上車站|下車站|上車|下車)\s*$/i, '')
    .replace(/^(?:上車|下車|乘車|降車)[:：\s]+/i, '')
    .trim();
  return s.slice(0, 60);
}

function normalizeTimeText(raw) {
  const s = normalizeText(raw, 28);
  if (!s) return '';

  const isPm = /(?:下午|午後|晚上|傍晚|\bpm\b|\bp\.m\.)/i.test(s);
  const isAm = /(?:上午|午前|凌晨|早上|\bam\b|\ba\.m\.)/i.test(s);
  const match = s.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!match) return '';

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    return '';
  }

  if (isPm && hour >= 1 && hour <= 11) {
    hour += 12;
  } else if (isAm && hour === 12) {
    hour = 0;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseMinutesBetween(depTimeText, arrTimeText) {
  if (!depTimeText || !arrTimeText) return 0;
  const dm = depTimeText.match(/^(\d{2}):(\d{2})$/);
  const am = arrTimeText.match(/^(\d{2}):(\d{2})$/);
  if (!dm || !am) return 0;
  const dep = Number(dm[1]) * 60 + Number(dm[2]);
  let arr = Number(am[1]) * 60 + Number(am[2]);
  if (arr < dep) arr += 24 * 60;
  const diff = arr - dep;
  return diff > 0 && diff <= 1440 ? diff : 0;
}

// ==================== 3. Gemini Free Tier 視覺解析 ====================

const SEGMENT_FIELD_ORDER = [
  'type',
  'vehicleType',
  'lineShortName',
  'lineName',
  'headsign',
  'departureTimeText',
  'arrivalTimeText',
  'durationMin',
  'stopCount',
  'departureStopName',
  'arrivalStopName',
  'intermediateStopNames',
  'colorHex',
];

const ROOT_FIELD_ORDER = [
  'isTransitScreenshot',
  'confidence',
  'warning',
  'departureTimeText',
  'arrivalTimeText',
  'totalDurationMin',
  'fareAmount',
  'fareCurrency',
  'segments',
];

const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  description: '從大眾運輸路線截圖擷取的完整轉乘結構',
  properties: {
    isTransitScreenshot: {
      type: 'BOOLEAN',
      description: '是否為大眾運輸路線、導航步驟或時刻表截圖',
    },
    confidence: {
      type: 'STRING',
      enum: ['high', 'medium', 'low'],
      description: '截圖文字清晰度與辨識信心程度',
    },
    warning: {
      type: 'STRING',
      description: '若圖片模糊或非交通截圖時的簡短中文提醒，正常情況填空字串 ""',
    },
    departureTimeText: {
      type: 'STRING',
      description: '整趟行程最上方的出發時刻，一律轉 24 小時制 HH:MM（如 下午1:54 -> "13:54"），無則填 ""',
    },
    arrivalTimeText: {
      type: 'STRING',
      description: '整趟行程最下方的抵達時刻，一律轉 24 小時制 HH:MM（如 下午2:14 -> "14:14"），無則填 ""',
    },
    totalDurationMin: {
      type: 'INTEGER',
      description: '整趟行程總耗時（分鐘），若未直接標示請以抵達減出發時刻或各段耗時加總計算',
    },
    fareAmount: {
      type: 'NUMBER',
      description: '截圖顯示的票價數字（如 費用：¥210 -> 210），未顯示填 0',
    },
    fareCurrency: {
      type: 'STRING',
      description: '票價幣別代碼（如 JPY、TWD、USD），未顯示填 ""',
    },
    segments: {
      type: 'ARRAY',
      description: '依移動順序排列的所有步驟（例如 WALK -> TRANSIT -> WALK）',
      items: {
        type: 'OBJECT',
        properties: {
          type: {
            type: 'STRING',
            enum: ['WALK', 'TRANSIT'],
            description: '步行填 WALK，搭乘任何公車/地鐵/鐵路/電車/渡輪填 TRANSIT',
          },
          vehicleType: {
            type: 'STRING',
            enum: ['BUS', 'SUBWAY', 'RAIL', 'TRAM', 'FERRY', 'CABLE_CAR', 'OTHER', 'NONE'],
            description: 'WALK 段填 "NONE"；公車/巴士填 "BUS"；地鐵/捷運填 "SUBWAY"；JR/火車填 "RAIL"；路面電車填 "TRAM"',
          },
          lineShortName: {
            type: 'STRING',
            description: '公車號碼或簡短路線代號（如 "206"、"紅26"、"RL"）；若無獨立短號碼或 WALK 段填 ""',
          },
          lineName: {
            type: 'STRING',
            description: '截圖方框或路線標題內的完整名稱（如 "循環バス [金沢駅~金沢駅]"、"京都市営バス 206"）；WALK 段填 ""',
          },
          headsign: {
            type: 'STRING',
            description: '開往方向／行先文字（如 "広坂・21世紀美術館・兼六園下・金沢城経由橋場町・ひがし茶屋街行"）；無或 WALK 段填 ""',
          },
          departureTimeText: {
            type: 'STRING',
            description: '此段出發或上車時刻，一律轉 24 小時制 HH:MM（如 下午1:55 -> "13:55"），無則填 ""',
          },
          arrivalTimeText: {
            type: 'STRING',
            description: '此段抵達或下車時刻，一律轉 24 小時制 HH:MM（如 下午2:04 -> "14:04"），無則填 ""',
          },
          durationMin: {
            type: 'INTEGER',
            description: '此段耗時分鐘數，務必讀取截圖數字（如 "約 1 分" 填 1、"9 分 (4 站)" 填 9）',
          },
          stopCount: {
            type: 'INTEGER',
            description: '此段停靠站數（如 "9 分 (4 站)" 填 4）；未標示或 WALK 段填 0',
          },
          departureStopName: {
            type: 'STRING',
            description: 'TRANSIT 段的上車站牌名稱（粗實線起點旁的站名，如 "武蔵ヶ辻・近江町市場"，去除（バス）贅字）；WALK 段填 ""',
          },
          arrivalStopName: {
            type: 'STRING',
            description: 'TRANSIT 段的下車站牌名稱（粗實線終點旁的站名，如 "兼六園下"，去除（バス）贅字）；WALK 段填 ""',
          },
          intermediateStopNames: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: '若截圖有展開中途停靠站，依順序填入上車與下車之間的中途站名（最多 3 站，去除（バス）贅字）；未展開或 WALK 段填 []',
          },
          colorHex: {
            type: 'STRING',
            description: '路線官方代表色 #RRGGBB；無明確代表色或 WALK 段填 ""',
          },
        },
        propertyOrdering: SEGMENT_FIELD_ORDER,
        required: SEGMENT_FIELD_ORDER,
      },
    },
  },
  propertyOrdering: ROOT_FIELD_ORDER,
  required: ROOT_FIELD_ORDER,
};

function buildGeminiPrompt({ originName, destinationName, inJapan, includeSchemaHint = false }) {
  const regionHint = inJapan
    ? '此路段位於日本（常見為 Google Maps、NAVITIME、Yahoo! 乗換案内截圖；站名與路線名請忠實保留圖片上的日文漢字或英文原文，票價幣別通常為 JPY）。'
    : '此路段常見為 Google Maps、公車動態 App 或時刻表截圖（請忠實保留截圖上的繁中／原文，台灣票價幣別通常為 TWD）。';

  const lines = [
    '你是高精度大眾運輸截圖 OCR 與結構化解析器。請仔細逐行閱讀截圖中的每一個字、每一個時刻與每一個站名，完整填寫所有欄位，不可遺漏 TRANSIT 段的路線名、上車站、下車站、耗時、站數或時刻。',
    regionHint,
    originName || destinationName
      ? `參考行程起終點：起點「${normalizeText(originName, 40) || '未命名'}」→ 終點「${normalizeText(destinationName, 40) || '未命名'}」。`
      : '',
    'Google Maps / 轉乘 App 垂直時間軸判讀重點：',
    '1. 最上方與最下方附地址的圓點是「起點／終點地標」，虛線是步行（WALK），粗實線是搭車（TRANSIT）。',
    '2. 每個 TRANSIT 段的「粗實線起點圓點」旁文字就是上車站（departureStopName），「粗實線終點圓點」旁文字就是下車站（arrivalStopName）；例如「武蔵ヶ辻・近江町市場（バス）」請填 "武蔵ヶ辻・近江町市場"（去除（バス）／公車站等括號贅字）。',
    '3. 公車／電車圖示旁通常有「方框路線名」與「開往方向（〜行／往〜）」：方框內的路線名稱填入 lineName（若有純號碼／短代號如 "206"、"紅26"、"RL" 才填 lineShortName，否則 lineShortName 填 ""），方向文字填入 headsign。',
    '4. 務必讀取每段的耗時與站數（例如「約 1 分」→ durationMin: 1；「9 分 (4 站)」→ durationMin: 9, stopCount: 4；「約 10 分」→ durationMin: 10）。',
    '5. 若粗實線中間有展開較小圓點的中途停靠站（例如 Minami-cho・Oyama Jinja Shrine、香林坊、広坂・21世紀美術館），請依序填入 intermediateStopNames（最多 3 站，均勻涵蓋全程，去除（バス）贅字）。',
    '6. 時刻務必轉成 24 小時制 HH:MM（例：下午1:54 → "13:54"、下午2:04 → "14:04"、上午9:05 → "09:05"）。整趟最上／最下時刻填入根層級 departureTimeText / arrivalTimeText，搭車上下車時刻填入該 TRANSIT 段的 departureTimeText / arrivalTimeText。',
    '7. 若圖片左下／上方有顯示費用（如「費用：¥210」），填入 fareAmount: 210 與 fareCurrency: "JPY"。',
    '8. 若圖片明顯不是交通路線或時刻表截圖，設 isTransitScreenshot = false 並在 warning 簡短說明。',
  ];

  if (includeSchemaHint) {
    lines.push(
      '9. 請回傳單一純 JSON 物件，包含欄位：{isTransitScreenshot, confidence, warning, departureTimeText, arrivalTimeText, totalDurationMin, fareAmount, fareCurrency, segments:[{type, vehicleType, lineShortName, lineName, headsign, departureTimeText, arrivalTimeText, durationMin, stopCount, departureStopName, arrivalStopName, intermediateStopNames, colorHex}]}。'
    );
  }

  return lines.filter(Boolean).join('\n');
}

function isGeminiQuotaError(httpStatus, data) {
  if (httpStatus === 429) return true;
  const statusStr = String(data?.error?.status || '').toUpperCase();
  const msg = String(data?.error?.message || '').toLowerCase();
  return (
    statusStr === 'RESOURCE_EXHAUSTED' ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('resource exhausted')
  );
}

function isGeminiZeroQuotaForModelError(httpStatus, data) {
  if (!isGeminiQuotaError(httpStatus, data)) return false;
  const msg = String(data?.error?.message || '').toLowerCase();
  return /\blimit:\s*0\b/.test(msg);
}

function isGeminiAuthError(httpStatus, data) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  const statusStr = String(data?.error?.status || '').toUpperCase();
  const msg = String(data?.error?.message || '').toLowerCase();
  return (
    statusStr === 'UNAUTHENTICATED' ||
    statusStr === 'PERMISSION_DENIED' ||
    msg.includes('api key not valid') ||
    msg.includes('api_key_invalid') ||
    msg.includes('invalid api key')
  );
}

function isGeminiLocationError(httpStatus, data) {
  const statusStr = String(data?.error?.status || '').toUpperCase();
  const msg = String(data?.error?.message || '').toLowerCase();
  return (
    httpStatus === 400 &&
    (statusStr === 'FAILED_PRECONDITION' || msg.includes('user location is not supported'))
  );
}

function isGeminiModelUnavailableError(httpStatus, data) {
  if (httpStatus === 404 || httpStatus === 503) return true;
  const statusStr = String(data?.error?.status || '').toUpperCase();
  const msg = String(data?.error?.message || '').toLowerCase();
  return (
    statusStr === 'NOT_FOUND' ||
    msg.includes('no longer available') ||
    msg.includes('not found for api version') ||
    msg.includes('is not supported for generatecontent')
  );
}

function buildCandidateModelList(env = process.env) {
  const custom = String(env?.GEMINI_VISION_MODEL || '').trim();
  const raw = [
    custom,
    custom ? '' : resolvedWorkingModel,
    DEFAULT_GEMINI_MODEL,
    ...FALLBACK_GEMINI_MODELS,
  ].filter(Boolean);
  return [...new Set(raw)];
}

function supportsGemini3VisionConfig(model) {
  return !/^gemini-2\./i.test(String(model || '').trim());
}

async function invokeGeminiVision({
  apiKey,
  model,
  mimeType,
  base64Data,
  prompt,
  includeSchema = true,
  useEnhancedVision = true,
}) {
  const generationConfig = {
    maxOutputTokens: 4096,
    responseMimeType: 'application/json',
  };
  if (includeSchema) {
    generationConfig.responseSchema = GEMINI_RESPONSE_SCHEMA;
  }
  if (useEnhancedVision && supportsGemini3VisionConfig(model)) {
    generationConfig.mediaResolution = 'MEDIA_RESOLUTION_HIGH';
    generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: base64Data,
            },
          },
        ],
      },
    ],
    generationConfig,
  };

  return fetchJsonWithTimeout(
    fetch,
    `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    },
    18000
  );
}

function extractGeminiJson(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;

  // Gemini 3.x 可能附帶 thought=true 思考區塊，優先僅擷取最終非思考文字
  const answerParts = parts.filter((p) => !p?.thought && typeof p?.text === 'string');
  const candidateParts = answerParts.length > 0 ? answerParts : parts.filter((p) => typeof p?.text === 'string');
  const text = candidateParts
    .map((p) => p.text)
    .join('')
    .trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // continue to brace extraction
      }
    }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function normalizeParsedScreenshotDraft(raw, { inJapan = false } = {}) {
  const rawSegs = Array.isArray(raw?.segments) ? raw.segments.slice(0, 8) : [];
  const segments = [];
  let firstRawDepTime = '';
  let lastRawArrTime = '';

  for (const s of rawSegs) {
    if (!s || typeof s !== 'object') continue;
    const type = String(s.type || '').toUpperCase() === 'WALK' ? 'WALK' : 'TRANSIT';
    const segDepTime = normalizeTimeText(s.departureTimeText);
    const segArrTime = normalizeTimeText(s.arrivalTimeText);
    if (segDepTime && !firstRawDepTime) firstRawDepTime = segDepTime;
    if (segArrTime) lastRawArrTime = segArrTime;

    const rawDur = parseOptionalFiniteNumber(s.durationMin);
    const timeDiffMin = parseMinutesBetween(segDepTime, segArrTime);
    const durationMin =
      Number.isFinite(rawDur) && rawDur > 0 ? Math.min(720, Math.round(rawDur)) : timeDiffMin;

    if (type === 'WALK') {
      segments.push({
        type: 'WALK',
        durationMin: durationMin || 3,
      });
      continue;
    }

    const rawVeh = String(s.vehicleType || 'BUS').toUpperCase();
    const vehicleType = VALID_VEHICLE_TYPES.has(rawVeh) ? rawVeh : 'BUS';
    const lineName = normalizeText(s.lineName, 80);
    const lineShortName = normalizeText(s.lineShortName, 32);
    const headsign = normalizeText(s.headsign, 80);
    const departureStopName = cleanStopName(s.departureStopName);
    const arrivalStopName = cleanStopName(s.arrivalStopName);
    const seenMid = new Set();
    const intermediateStopNames = Array.isArray(s.intermediateStopNames)
      ? s.intermediateStopNames
          .map((n) => cleanStopName(n))
          .filter((n) => {
            if (!n || n === departureStopName || n === arrivalStopName || seenMid.has(n)) return false;
            seenMid.add(n);
            return true;
          })
          .slice(0, MAX_INTERMEDIATE_STOPS)
      : [];
    const rawStops = parseOptionalFiniteNumber(s.stopCount);
    const stopCount = Number.isFinite(rawStops) && rawStops >= 0 ? Math.min(200, Math.round(rawStops)) : 0;

    segments.push({
      type: 'TRANSIT',
      vehicleType,
      lineName: lineName || lineShortName || VEHICLE_META[vehicleType]?.label || '公車',
      lineShortName,
      headsign,
      durationMin: durationMin || 10,
      stopCount,
      departureStopName,
      arrivalStopName,
      intermediateStopNames,
      departureTimeText: segDepTime,
      arrivalTimeText: segArrTime,
      colorHex: sanitizeHexColor(s.colorHex),
    });
  }

  const firstTransit = segments.find((s) => s.type === 'TRANSIT');
  const lastTransit = [...segments].reverse().find((s) => s.type === 'TRANSIT');
  const departureTimeText =
    normalizeTimeText(raw?.departureTimeText) || firstRawDepTime || firstTransit?.departureTimeText || '';
  const arrivalTimeText =
    normalizeTimeText(raw?.arrivalTimeText) || lastRawArrTime || lastTransit?.arrivalTimeText || '';

  const summedDur = segments.reduce((sum, seg) => sum + (seg.durationMin || 0), 0);
  const rootTimeDiffMin = parseMinutesBetween(departureTimeText, arrivalTimeText);
  const rawTotal = parseOptionalFiniteNumber(raw?.totalDurationMin);
  const totalDurationMin =
    Number.isFinite(rawTotal) && rawTotal > 0
      ? Math.min(1440, Math.round(rawTotal))
      : rootTimeDiffMin || Math.max(1, summedDur || 15);

  const rawFare = parseOptionalFiniteNumber(raw?.fareAmount);
  const fareAmount = Number.isFinite(rawFare) && rawFare > 0 ? Number(rawFare.toFixed(2)) : 0;
  const rawCur = normalizeText(raw?.fareCurrency, 8).toUpperCase();
  const fareCurrency = fareAmount > 0 ? rawCur || (inJapan ? 'JPY' : 'TWD') : inJapan ? 'JPY' : 'TWD';

  const rawConf = String(raw?.confidence || 'medium').toLowerCase();
  const confidence = ['high', 'medium', 'low'].includes(rawConf) ? rawConf : 'medium';

  return {
    isTransitScreenshot: raw?.isTransitScreenshot !== false && segments.length > 0,
    confidence,
    warning: normalizeText(raw?.warning, 160),
    totalDurationMin,
    departureTimeText,
    arrivalTimeText,
    fareAmount,
    fareCurrency,
    segments,
  };
}

function isHollowTransitParse(rawJson, normalized) {
  if (!normalized?.isTransitScreenshot) return false;
  const rawSegs = Array.isArray(rawJson?.segments) ? rawJson.segments : [];
  const rawTransit = rawSegs.filter((s) => s && String(s.type || '').toUpperCase() !== 'WALK');
  if (rawTransit.length === 0) return false;
  return rawTransit.some((s) => {
    const hasLine = Boolean(normalizeText(s.lineName, 80) || normalizeText(s.lineShortName, 32));
    const hasDep = Boolean(cleanStopName(s.departureStopName));
    const hasArr = Boolean(cleanStopName(s.arrivalStopName));
    return !hasLine && !hasDep && !hasArr;
  });
}

function scoreParsedDraftRichness(rawJson, normalized) {
  if (!normalized?.isTransitScreenshot) return 0;
  let score = 0;
  if (normalized.departureTimeText) score += 2;
  if (normalized.arrivalTimeText) score += 2;
  if (normalized.fareAmount > 0) score += 1;

  const rawSegs = Array.isArray(rawJson?.segments) ? rawJson.segments : [];
  for (const s of rawSegs) {
    if (!s || String(s.type || '').toUpperCase() === 'WALK') continue;
    if (normalizeText(s.lineName, 80) || normalizeText(s.lineShortName, 32)) score += 4;
    if (cleanStopName(s.departureStopName)) score += 4;
    if (cleanStopName(s.arrivalStopName)) score += 4;
    if (normalizeText(s.headsign, 80)) score += 2;
    if (Number(s.stopCount) > 0) score += 2;
    if (Array.isArray(s.intermediateStopNames) && s.intermediateStopNames.length > 0) {
      score += Math.min(3, s.intermediateStopNames.length);
    }
  }
  return score;
}

// ==================== 4. 100% 免費開源站牌定位（Photon → OSM Nominatim，完全不觸碰 Google Places 計費）與貼路公車建構 ====================

function getStopCacheKey(stopName, vehicleType, origin) {
  const gridLat = Math.round(origin.lat * 20) / 20;
  const gridLng = Math.round(origin.lng * 20) / 20;
  const kind = ROAD_TRANSIT_TYPES.has(vehicleType) ? 'bus' : 'rail';
  return `${gridLat.toFixed(2)},${gridLng.toFixed(2)}|${kind}|${stopName.toLowerCase()}`;
}

function readStopCache(key, now = Date.now()) {
  const entry = stopGeocodeCache.get(key);
  if (!entry) return undefined;
  if (now - entry.ts > STOP_CACHE_TTL_MS) {
    stopGeocodeCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeStopCache(key, value, now = Date.now()) {
  if (stopGeocodeCache.size >= MAX_STOP_CACHE) {
    const oldest = stopGeocodeCache.keys().next().value;
    if (oldest !== undefined) stopGeocodeCache.delete(oldest);
  }
  stopGeocodeCache.set(key, { value, ts: now });
}

function buildStopSearchQuery(stopName, vehicleType, inJapan) {
  const clean = stopName.trim();
  const hasStopSuffix = /(?:駅|站|バス停|停留所|station|bus\s*stop|terminal|港|碼頭)$/i.test(clean);
  if (hasStopSuffix) return clean;
  if (inJapan) {
    if (vehicleType === 'BUS') return `${clean} バス停`;
    if (vehicleType === 'SUBWAY' || vehicleType === 'RAIL' || vehicleType === 'HEAVY_RAIL' || vehicleType === 'TRAM') {
      return `${clean} 駅`;
    }
    return clean;
  }
  if (vehicleType === 'BUS') return `${clean} 公車站`;
  return clean;
}

function extractPrimaryStopToken(stopName) {
  const clean = String(stopName || '').trim();
  const primary = clean.split(/[・／/(（]/)[0]?.trim() || '';
  if (primary.length >= 2 && primary !== clean) return primary;
  return '';
}

function computeCorridorRect(origin, destination) {
  const straightKm = calcDistanceKm(origin.lat, origin.lng, destination.lat, destination.lng);
  const padKm = Math.min(35, Math.max(2.5, straightKm * 0.45));
  const dLat = padKm / 111;
  const avgLat = (origin.lat + destination.lat) / 2;
  const dLng = padKm / Math.max(15, 111 * Math.cos((avgLat * Math.PI) / 180));

  return {
    low: {
      latitude: Math.max(-84.5, Math.min(origin.lat, destination.lat) - dLat),
      longitude: Math.max(-179.5, Math.min(origin.lng, destination.lng) - dLng),
    },
    high: {
      latitude: Math.min(84.5, Math.max(origin.lat, destination.lat) + dLat),
      longitude: Math.min(179.5, Math.max(origin.lng, destination.lng) + dLng),
    },
    maxCorridorKm: Math.min(40, Math.max(3.5, straightKm * 0.65)),
  };
}

function scorePhotonFeature(feature, cleanName, vehicleType, origin, destination, maxCorridorKm) {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const devKm = pointToSegmentKm({ lat, lng }, origin, destination);
  if (devKm > maxCorridorKm) return null;

  const props = feature?.properties || {};
  const osmKey = String(props.osm_key || '').toLowerCase();
  const osmVal = String(props.osm_value || '').toLowerCase();
  const featName = String(props.name || '').trim();

  const isBusTagged = osmKey === 'public_transport' || PHOTON_BUS_VALUES.has(osmVal);
  const isRailTagged = osmKey === 'railway' || PHOTON_RAIL_VALUES.has(osmVal);
  const isFerryTagged = osmVal === 'ferry_terminal';

  let typeBonus = 0;
  if (ROAD_TRANSIT_TYPES.has(vehicleType)) {
    if (isBusTagged) typeBonus = 35;
    else if (isRailTagged) typeBonus = 14;
  } else if (vehicleType === 'FERRY') {
    if (isFerryTagged) typeBonus = 35;
  } else if (isRailTagged) {
    typeBonus = 35;
  } else if (isBusTagged) {
    typeBonus = 14;
  }

  let nameBonus = 0;
  if (featName) {
    const normFeat = featName.toLowerCase();
    const normQuery = cleanName.toLowerCase();
    if (normFeat === normQuery) nameBonus = 14;
    else if (normFeat.includes(normQuery) || normQuery.includes(normFeat)) nameBonus = 10;
  }

  return {
    lat,
    lng,
    matchedName: featName || cleanName,
    source: 'photon_osm',
    score: typeBonus + nameBonus - devKm * 2.5,
  };
}

async function queryPhotonStop(queryText, cleanName, vehicleType, origin, destination, corridor) {
  const midLat = ((origin.lat + destination.lat) / 2).toFixed(5);
  const midLng = ((origin.lng + destination.lng) / 2).toFixed(5);
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(queryText)}&lat=${midLat}&lon=${midLng}&limit=6`;

  try {
    const { res, data } = await fetchJsonWithTimeout(
      fetch,
      url,
      { headers: { 'User-Agent': 'TripCanvas/2.0 (free-stop-anchor)' } },
      3500
    );
    if (!res.ok || !Array.isArray(data?.features) || data.features.length === 0) return null;

    let best = null;
    for (const f of data.features) {
      const scored = scorePhotonFeature(f, cleanName, vehicleType, origin, destination, corridor.maxCorridorKm);
      if (scored && (!best || scored.score > best.score)) {
        best = scored;
      }
    }
    if (!best) return null;
    return { lat: best.lat, lng: best.lng, matchedName: best.matchedName, source: best.source };
  } catch {
    return null;
  }
}

async function queryNominatimStop(queryText, cleanName, vehicleType, origin, destination, corridor, inJapan) {
  try {
    const viewbox = [
      corridor.low.longitude.toFixed(5),
      corridor.high.latitude.toFixed(5),
      corridor.high.longitude.toFixed(5),
      corridor.low.latitude.toFixed(5),
    ].join(',');
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=4&bounded=1&viewbox=${encodeURIComponent(viewbox)}&q=${encodeURIComponent(queryText)}`;
    const { res, data } = await fetchJsonWithTimeout(
      fetch,
      url,
      {
        headers: {
          'User-Agent': 'TripCanvas/2.0 (free-stop-anchor)',
          'Accept-Language': inJapan ? 'ja,zh-TW' : 'zh-TW,en',
        },
      },
      3500
    );

    if (!res.ok || !Array.isArray(data) || data.length === 0) return null;

    let best = null;
    for (const item of data) {
      const lat = Number(item?.lat);
      const lng = Number(item?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const devKm = pointToSegmentKm({ lat, lng }, origin, destination);
      if (devKm > corridor.maxCorridorKm) continue;

      const cls = String(item?.class || '').toLowerCase();
      const typ = String(item?.type || '').toLowerCase();
      const isBus = cls === 'public_transport' || PHOTON_BUS_VALUES.has(typ);
      const isRail = cls === 'railway' || PHOTON_RAIL_VALUES.has(typ);
      const bonus =
        (ROAD_TRANSIT_TYPES.has(vehicleType) && isBus) || (!ROAD_TRANSIT_TYPES.has(vehicleType) && isRail)
          ? 30
          : isBus || isRail
            ? 12
            : 0;
      const score = bonus - devKm * 2.5;
      if (!best || score > best.score) {
        best = { lat, lng, matchedName: cleanName, source: 'osm_nominatim', score };
      }
    }
    if (!best) return null;
    return { lat: best.lat, lng: best.lng, matchedName: best.matchedName, source: best.source };
  } catch {
    return null;
  }
}

async function geocodeTransitStop(stopName, vehicleType, origin, destination, _env, budget) {
  const cleanName = normalizeText(stopName, 60);
  if (!cleanName) return null;

  const cacheKey = getStopCacheKey(cleanName, vehicleType, origin);
  const cached = readStopCache(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  if (budget.remainingLookups <= 0) {
    return null;
  }

  budget.remainingLookups -= 1;
  budget.freeLookupsUsed += 1;

  const inJapan = isJapanTrip(origin, destination);
  const corridor = computeCorridorRect(origin, destination);
  const primaryToken = extractPrimaryStopToken(cleanName);

  // 1. 優先使用免費開源 Photon（支援座標鄰近加權與 highway=bus_stop 精準篩選，永遠 $0）
  let found = await queryPhotonStop(cleanName, cleanName, vehicleType, origin, destination, corridor);
  if (!found && primaryToken) {
    found = await queryPhotonStop(primaryToken, cleanName, vehicleType, origin, destination, corridor);
  }

  // 2. 備援：免費 OpenStreetMap Nominatim 走廊範圍搜尋（同樣永遠 $0、完全不碰 Google Places API）
  if (!found) {
    const nomQuery = buildStopSearchQuery(cleanName, vehicleType, inJapan);
    found = await queryNominatimStop(nomQuery, cleanName, vehicleType, origin, destination, corridor, inJapan);
  }
  if (!found && primaryToken) {
    found = await queryNominatimStop(primaryToken, cleanName, vehicleType, origin, destination, corridor, inJapan);
  }

  writeStopCache(cacheKey, found);
  return found;
}

async function queryFreeOsrmPolyline(waypoints, profile = 'car', { excludeMotorway = false } = {}) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) return null;
  const coordsParam = waypoints.map((p) => `${Number(p.lng).toFixed(6)},${Number(p.lat).toFixed(6)}`).join(';');
  const service = profile === 'foot' ? 'routed-foot' : 'routed-car';
  const modeSegment = profile === 'foot' ? 'foot' : 'driving';
  const baseUrl = `https://routing.openstreetmap.de/${service}/route/v1/${modeSegment}/${coordsParam}?overview=full&geometries=polyline`;

  const tryFetch = async (url) => {
    const { res, data } = await fetchJsonWithTimeout(
      fetch,
      url,
      { headers: { 'User-Agent': 'TripCanvas/2.0 (bus-route-anchor)' } },
      3500
    );
    if (!res.ok || data?.code !== 'Ok' || !data?.routes?.[0]?.geometry) return null;
    const r = data.routes[0];
    return {
      encodedPolyline: r.geometry,
      distanceMeters: Math.max(0, Math.round(Number(r.distance) || 0)),
      durationMin: Math.max(1, Math.round((Number(r.duration) || 0) / 60)),
    };
  };

  try {
    if (excludeMotorway && profile === 'car') {
      const noHw = await tryFetch(`${baseUrl}&exclude=motorway`);
      if (noHw) return noHw;
    }
    return await tryFetch(baseUrl);
  } catch {
    return null;
  }
}

function buildDirectPolyline(points) {
  const clean = (points || [])
    .filter((p) => isValidCoord(p))
    .map((p) => [Number(p.lat), Number(p.lng)]);
  if (clean.length < 2) return '';
  return encodePolyline(clean);
}

function buildTransitSummary(segments) {
  return segments
    .map((seg) =>
      seg.type === 'WALK' ? `步行 ${seg.durationMin}分` : `${seg.vehicleEmoji || '🚌'} ${seg.displayLine || '大眾運輸'}`
    )
    .join(' → ');
}

export async function anchorAndBuildTransitRoute(
  { draft, origin, destination },
  env = process.env
) {
  const inJapan = isJapanTrip(origin, destination);
  const normalizedDraft = normalizeParsedScreenshotDraft(draft, { inJapan });
  const budget = { remainingLookups: MAX_STOPS_PER_REQUEST, freeLookupsUsed: 0 };

  // 1. 依序對所有 TRANSIT 段的「上車站、下車站、最多 3 個中途站」做站牌定位
  const anchoredDraftSegments = [];
  let totalStopCandidates = 0;
  let matchedStopsCount = 0;

  for (const seg of normalizedDraft.segments) {
    if (seg.type === 'WALK') {
      anchoredDraftSegments.push({ ...seg });
      continue;
    }

    let depCoord = null;
    let arrCoord = null;
    const interCoords = [];

    if (seg.departureStopName) {
      totalStopCandidates += 1;
      depCoord = await geocodeTransitStop(seg.departureStopName, seg.vehicleType, origin, destination, env, budget);
      if (depCoord) matchedStopsCount += 1;
    }

    if (seg.arrivalStopName) {
      totalStopCandidates += 1;
      arrCoord = await geocodeTransitStop(seg.arrivalStopName, seg.vehicleType, origin, destination, env, budget);
      if (arrCoord) matchedStopsCount += 1;
    }

    if (ROAD_TRANSIT_TYPES.has(seg.vehicleType) && Array.isArray(seg.intermediateStopNames)) {
      for (const midName of seg.intermediateStopNames.slice(0, MAX_INTERMEDIATE_STOPS)) {
        if (!midName || budget.remainingLookups <= 0) break;
        totalStopCandidates += 1;
        const midCoord = await geocodeTransitStop(midName, seg.vehicleType, origin, destination, env, budget);
        if (midCoord) {
          matchedStopsCount += 1;
          interCoords.push({ name: midName, lat: midCoord.lat, lng: midCoord.lng });
        }
      }
    }

    anchoredDraftSegments.push({
      ...seg,
      departureCoord: depCoord ? { lat: depCoord.lat, lng: depCoord.lng } : null,
      arrivalCoord: arrCoord ? { lat: arrCoord.lat, lng: arrCoord.lng } : null,
      intermediateCoords: interCoords,
    });
  }

  // 2. 組裝地圖可繪製的分段結構（起點 → 步行 → 上車站 → 真實道路公車段 → 下車站 → 步行 → 終點）
  const transitOnlyIndices = anchoredDraftSegments
    .map((s, idx) => (s.type === 'TRANSIT' ? idx : -1))
    .filter((idx) => idx >= 0);

  const builtSegments = [];
  let cursorCoord = { lat: origin.lat, lng: origin.lng };
  let totalDistanceMeters = 0;

  for (let i = 0; i < anchoredDraftSegments.length; i++) {
    const seg = anchoredDraftSegments[i];

    if (seg.type === 'WALK') {
      // 尋找下一個有座標的錨點作為這段步行的終點
      let walkTarget = null;
      for (let j = i + 1; j < anchoredDraftSegments.length; j++) {
        const nextSeg = anchoredDraftSegments[j];
        if (nextSeg.type === 'TRANSIT') {
          walkTarget = nextSeg.departureCoord || null;
          break;
        }
      }
      if (!walkTarget && i === anchoredDraftSegments.length - 1) {
        walkTarget = { lat: destination.lat, lng: destination.lng };
      }

      let walkPoly = '';
      let walkDist = Math.round((seg.durationMin || 3) * 75);
      if (walkTarget && calcDistanceKm(cursorCoord.lat, cursorCoord.lng, walkTarget.lat, walkTarget.lng) > 0.025) {
        const osrmWalk = await queryFreeOsrmPolyline([cursorCoord, walkTarget], 'foot');
        if (osrmWalk?.encodedPolyline) {
          walkPoly = osrmWalk.encodedPolyline;
          walkDist = osrmWalk.distanceMeters || walkDist;
        } else {
          walkPoly = buildDirectPolyline([cursorCoord, walkTarget]);
          walkDist = Math.round(calcDistanceKm(cursorCoord.lat, cursorCoord.lng, walkTarget.lat, walkTarget.lng) * 1000);
        }
        cursorCoord = walkTarget;
      }

      totalDistanceMeters += walkDist;
      builtSegments.push({
        type: 'WALK',
        durationMin: Math.max(1, seg.durationMin || 3),
        distanceMeters: walkDist,
        instruction: '',
        encodedPolyline: walkPoly,
      });
      continue;
    }

    // TRANSIT 段
    const isFirstTransit = i === transitOnlyIndices[0];
    const isLastTransit = i === transitOnlyIndices[transitOnlyIndices.length - 1];
    const startPt = seg.departureCoord || (isFirstTransit ? { lat: origin.lat, lng: origin.lng } : cursorCoord);
    const endPt =
      seg.arrivalCoord ||
      (isLastTransit ? { lat: destination.lat, lng: destination.lng } : null);

    // 若起點／上一段結尾與此段上車站有明顯距離且前面沒有 WALK 段，補上步行接駁折線
    if (
      seg.departureCoord &&
      builtSegments[builtSegments.length - 1]?.type !== 'WALK' &&
      calcDistanceKm(cursorCoord.lat, cursorCoord.lng, seg.departureCoord.lat, seg.departureCoord.lng) > 0.06
    ) {
      const gapKm = calcDistanceKm(cursorCoord.lat, cursorCoord.lng, seg.departureCoord.lat, seg.departureCoord.lng);
      const osrmAccess = await queryFreeOsrmPolyline([cursorCoord, seg.departureCoord], 'foot');
      const accessDist = osrmAccess?.distanceMeters || Math.round(gapKm * 1000);
      totalDistanceMeters += accessDist;
      builtSegments.push({
        type: 'WALK',
        durationMin: osrmAccess?.durationMin || Math.max(1, Math.round((gapKm / 4.5) * 60)),
        distanceMeters: accessDist,
        instruction: '',
        encodedPolyline: osrmAccess?.encodedPolyline || buildDirectPolyline([cursorCoord, seg.departureCoord]),
      });
    }

    let transitPoly = '';
    let transitDist = 0;

    if (startPt && endPt) {
      const waypoints = [
        startPt,
        ...(seg.intermediateCoords || []).map((c) => ({ lat: c.lat, lng: c.lng })),
        endPt,
      ];

      if (ROAD_TRANSIT_TYPES.has(seg.vehicleType)) {
        // 公車／路面交通：以免費 OSRM 多中繼點串連上車站→中途站→下車站，貼合實際市區幹道（排除高速公路）
        const osrmBus = await queryFreeOsrmPolyline(waypoints, 'car', { excludeMotorway: true });
        if (osrmBus?.encodedPolyline) {
          transitPoly = osrmBus.encodedPolyline;
          transitDist = osrmBus.distanceMeters;
        }
      }

      if (!transitPoly) {
        transitPoly = buildDirectPolyline(waypoints);
        for (let k = 1; k < waypoints.length; k++) {
          transitDist += Math.round(
            calcDistanceKm(waypoints[k - 1].lat, waypoints[k - 1].lng, waypoints[k].lat, waypoints[k].lng) * 1000
          );
        }
      }

      cursorCoord = endPt;
    }

    totalDistanceMeters += transitDist;
    const meta = VEHICLE_META[seg.vehicleType] || VEHICLE_META.BUS;
    const displayLine = formatLineDisplayName(seg.lineName, seg.lineShortName, seg.vehicleType);

    builtSegments.push({
      type: 'TRANSIT',
      durationMin: Math.max(1, seg.durationMin || 10),
      distanceMeters: transitDist,
      vehicleType: seg.vehicleType,
      vehicleLabel: meta.label,
      vehicleEmoji: meta.emoji,
      lineName: seg.lineName || displayLine,
      lineShortName: seg.lineShortName || '',
      displayLine,
      lineColor: seg.colorHex || meta.defaultColor,
      lineTextColor: '#FFFFFF',
      headsign: seg.headsign || '',
      stopCount: seg.stopCount || 0,
      departureStop: seg.departureStopName
        ? {
            name: seg.departureStopName,
            timeText: seg.departureTimeText || '',
            ...(seg.departureCoord ? { lat: seg.departureCoord.lat, lng: seg.departureCoord.lng } : {}),
          }
        : null,
      arrivalStop: seg.arrivalStopName
        ? {
            name: seg.arrivalStopName,
            timeText: seg.arrivalTimeText || '',
            ...(seg.arrivalCoord ? { lat: seg.arrivalCoord.lat, lng: seg.arrivalCoord.lng } : {}),
          }
        : null,
      encodedPolyline: transitPoly,
    });
  }

  // 若最後一段下車站離終點有距離且尾段沒有 WALK，補上最後一段步行接駁
  if (
    builtSegments.length > 0 &&
    builtSegments[builtSegments.length - 1]?.type === 'TRANSIT' &&
    calcDistanceKm(cursorCoord.lat, cursorCoord.lng, destination.lat, destination.lng) > 0.06
  ) {
    const tailKm = calcDistanceKm(cursorCoord.lat, cursorCoord.lng, destination.lat, destination.lng);
    const osrmTail = await queryFreeOsrmPolyline([cursorCoord, destination], 'foot');
    const tailDist = osrmTail?.distanceMeters || Math.round(tailKm * 1000);
    totalDistanceMeters += tailDist;
    builtSegments.push({
      type: 'WALK',
      durationMin: osrmTail?.durationMin || Math.max(1, Math.round((tailKm / 4.5) * 60)),
      distanceMeters: tailDist,
      instruction: '',
      encodedPolyline: osrmTail?.encodedPolyline || buildDirectPolyline([cursorCoord, destination]),
    });
  }

  // 合併全覽折線
  const segPolys = builtSegments.map((s) => s.encodedPolyline).filter(Boolean);
  let stitchedCoords = stitchEncodedPolylines(segPolys);
  if (stitchedCoords.length < 2) {
    stitchedCoords = [
      [origin.lat, origin.lng],
      [destination.lat, destination.lng],
    ];
  }
  const encodedPolyline = encodePolyline(stitchedCoords);

  const transitCount = builtSegments.filter((s) => s.type === 'TRANSIT').length;
  const totalWalkMin = builtSegments
    .filter((s) => s.type === 'WALK')
    .reduce((sum, s) => sum + (s.durationMin || 0), 0);

  let fare = null;
  if (normalizedDraft.fareAmount > 0) {
    try {
      const wholeUnits = Math.trunc(normalizedDraft.fareAmount);
      const fracNanos = Math.round((normalizedDraft.fareAmount - wholeUnits) * 1e9);
      fare = await convertMoneyToTwd({
        currencyCode: normalizedDraft.fareCurrency,
        units: wholeUnits,
        nanos: fracNanos,
      });
    } catch {
      fare = null;
    }
  }

  const route = {
    provider: 'screenshot',
    durationMin: normalizedDraft.totalDurationMin,
    distanceKm: Number((totalDistanceMeters / 1000).toFixed(2)),
    totalWalkMin,
    transferCount: Math.max(0, transitCount - 1),
    summaryText: buildTransitSummary(builtSegments),
    departureTimeText: normalizedDraft.departureTimeText,
    arrivalTimeText: normalizedDraft.arrivalTimeText,
    encodedPolyline,
    fare,
    segments: builtSegments,
  };

  return {
    draft: {
      ...normalizedDraft,
      segments: anchoredDraftSegments,
    },
    route,
    stopStats: {
      totalStops: totalStopCandidates,
      matchedStops: matchedStopsCount,
      freeLookupsUsed: budget.freeLookupsUsed,
      placesCallsUsed: 0,
      geocoder: 'osm_free',
    },
  };
}

// ==================== 5. 伺服器端 API Handler ====================

export async function handleScreenshotParseRequest(body, { ip = 'local', env = process.env } = {}) {
  const now = Date.now();
  const featureStatus = getScreenshotFeatureStatus(env, now);

  if (!featureStatus.enabled) {
    return {
      statusCode: 200,
      body: {
        status: 'unconfigured',
        error: 'GEMINI_UNCONFIGURED',
        message: featureStatus.message,
        quota: featureStatus,
      },
    };
  }

  if (featureStatus.locked) {
    return {
      statusCode: 429,
      body: {
        status: 'quota_limited',
        error: featureStatus.reason,
        message: featureStatus.message,
        quota: featureStatus,
      },
    };
  }

  const { maxPerIpDay } = getQuotaLimits(env);
  const ipCheck = checkAndRecordIpDaily(ip, maxPerIpDay, now, { increment: false });
  if (!ipCheck.allowed) {
    return {
      statusCode: 429,
      body: {
        status: 'quota_limited',
        error: 'IP_DAILY_LIMIT',
        message: `您今日的截圖辨識次數已達上限（每日 ${maxPerIpDay} 次），明日將自動恢復，請先改用手動填寫。`,
        quota: featureStatus,
      },
    };
  }

  const image = parseImageDataUrl(body?.imageDataUrl);
  if (!image) {
    return {
      statusCode: 400,
      body: {
        status: 'invalid_request',
        error: 'INVALID_IMAGE',
        message: '請上傳或貼上有效的 JPG / PNG / WebP 截圖（檔案上限 1.5 MB）。',
      },
    };
  }

  const origin = body?.origin;
  const destination = body?.destination;
  if (!isValidCoord(origin) || !isValidCoord(destination)) {
    return {
      statusCode: 400,
      body: {
        status: 'invalid_request',
        error: 'INVALID_COORDS',
        message: '起終點座標格式不正確。',
      },
    };
  }

  const apiKey = getGeminiApiKey(env);
  const candidateModels = buildCandidateModelList(env);
  const inJapan = isJapanTrip(origin, destination);
  const promptWithSchema = buildGeminiPrompt({
    originName: body?.originName || '',
    destinationName: body?.destinationName || '',
    inJapan,
    includeSchemaHint: false,
  });
  const promptPlainJson = buildGeminiPrompt({
    originName: body?.originName || '',
    destinationName: body?.destinationName || '',
    inJapan,
    includeSchemaHint: true,
  });

  const isRetryableParam400 = (httpStatus, errData) =>
    httpStatus === 400 &&
    !isGeminiAuthError(httpStatus, errData) &&
    !isGeminiLocationError(httpStatus, errData) &&
    !isGeminiModelUnavailableError(httpStatus, errData);

  const callGeminiModelStaged = async (model) => {
    let attempt = await invokeGeminiVision({
      apiKey,
      model,
      mimeType: image.mimeType,
      base64Data: image.base64Data,
      prompt: promptWithSchema,
      includeSchema: true,
      useEnhancedVision: true,
    });

    // 若特定模型不支援 thinkingLevel 或 mediaResolution 而回 400，先移除增強參數並保留嚴格 responseSchema 重試
    if (isRetryableParam400(attempt.res.status, attempt.data) && supportsGemini3VisionConfig(model)) {
      attempt = await invokeGeminiVision({
        apiKey,
        model,
        mimeType: image.mimeType,
        base64Data: image.base64Data,
        prompt: promptWithSchema,
        includeSchema: true,
        useEnhancedVision: false,
      });
    }

    // 若仍對 responseSchema 回 400，最後降級為純 JSON 模式重試
    if (isRetryableParam400(attempt.res.status, attempt.data)) {
      attempt = await invokeGeminiVision({
        apiKey,
        model,
        mimeType: image.mimeType,
        base64Data: image.base64Data,
        prompt: promptPlainJson,
        includeSchema: false,
        useEnhancedVision: false,
      });
    }

    return attempt;
  };

  // 依序嘗試 Gemini Free Tier 視覺模型（自動避開舊版 2.5 對新帳號 404 限制，並記住第一個成功模型）
  let res = null;
  let data = null;
  let usedModel = candidateModels[0] || DEFAULT_GEMINI_MODEL;

  try {
    for (const model of candidateModels) {
      usedModel = model;
      ({ res, data } = await callGeminiModelStaged(model));

      if (res.ok) {
        if (!String(env?.GEMINI_VISION_MODEL || '').trim()) {
          resolvedWorkingModel = model;
        }
        break;
      }

      // 若為特定模型在免費層無額度（limit: 0），改試下一個免費層模型
      if (isGeminiZeroQuotaForModelError(res.status, data)) {
        continue;
      }

      // 429 額度滿、金鑰無效或區域不支援時立刻停止，不重打其他模型
      if (
        isGeminiQuotaError(res.status, data) ||
        isGeminiAuthError(res.status, data) ||
        isGeminiLocationError(res.status, data)
      ) {
        break;
      }

      // 若為 404 / 503 模型不開放或暫時過載，自動切換下一個可用免費模型
      if (isGeminiModelUnavailableError(res.status, data)) {
        continue;
      }

      break;
    }
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        status: 'network_error',
        error: err?.name === 'AbortError' ? 'GEMINI_TIMEOUT' : 'GEMINI_NETWORK_ERROR',
        message: '截圖辨識連線逾時，請稍後再試或改用手動填寫。',
      },
    };
  }

  if (isGeminiQuotaError(res.status, data)) {
    const zeroQuota = isGeminiZeroQuotaForModelError(res.status, data);
    if (zeroQuota) {
      console.error('[screenshotTransit] Gemini zero free-tier quota across models:', res.status, usedModel);
    }
    tripGeminiQuotaLock('GEMINI_QUOTA_EXCEEDED', Date.now());
    const lockedStatus = getScreenshotFeatureStatus(env, Date.now());
    return {
      statusCode: 429,
      body: {
        status: 'quota_limited',
        error: 'GEMINI_QUOTA_EXCEEDED',
        message: zeroQuota
          ? 'Google AI Studio 專案目前免費額度為 0（Free Tier limit: 0），請至 AI Studio 確認專案狀態，或先改用手動填寫。'
          : lockedStatus.message,
        quota: lockedStatus,
      },
    };
  }

  if (isGeminiAuthError(res.status, data)) {
    console.error('[screenshotTransit] Gemini auth error:', res.status, usedModel, data?.error?.status || '');
    return {
      statusCode: 502,
      body: {
        status: 'parse_error',
        error: 'GEMINI_AUTH_ERROR',
        message: 'GEMINI_API_KEY 金鑰無效或權限不足，請確認 Vercel 環境變數設定並重新部署。',
      },
    };
  }

  if (isGeminiLocationError(res.status, data)) {
    console.error('[screenshotTransit] Gemini region error:', res.status, usedModel);
    return {
      statusCode: 502,
      body: {
        status: 'parse_error',
        error: 'GEMINI_REGION_UNSUPPORTED',
        message: 'Google AI Studio 免費層不支援目前伺服器區域，請確認 Vercel Function 區域設定。',
      },
    };
  }

  if (!res.ok) {
    const errCode = String(data?.error?.status || res.status || 'ERROR').slice(0, 32);
    const errMsg = String(data?.error?.message || '').slice(0, 140);
    console.error('[screenshotTransit] Gemini upstream error:', res.status, usedModel, errCode, errMsg);
    return {
      statusCode: 502,
      body: {
        status: 'parse_error',
        error: 'GEMINI_UPSTREAM_ERROR',
        message: `截圖辨識服務暫時異常（${res.status} / ${errCode}），請稍後再試或改用手動填寫。`,
      },
    };
  }

  // 成功呼叫 Gemini：記錄次數
  ensureCurrentDayBucket(Date.now());
  quotaState.globalParseCount += 1;
  checkAndRecordIpDaily(ip, maxPerIpDay, Date.now(), { increment: true });

  let parsedJson = extractGeminiJson(data);
  if (!parsedJson || typeof parsedJson !== 'object') {
    return {
      statusCode: 200,
      body: {
        status: 'parse_error',
        error: 'UNPARSEABLE_RESPONSE',
        message: '無法從這張圖片讀出清楚的路線資訊，請確認截圖文字清晰後再試。',
        quota: getScreenshotFeatureStatus(env, Date.now()),
      },
    };
  }

  let normalized = normalizeParsedScreenshotDraft(parsedJson, { inJapan });

  // 品質防護：若輕量模型漏填了所有公車路線名與上下車站名（空殼結果），自動改用免費層 gemini-3.6-flash 補讀一次
  if (
    isHollowTransitParse(parsedJson, normalized) &&
    !String(env?.GEMINI_VISION_MODEL || '').trim() &&
    usedModel !== 'gemini-3.6-flash'
  ) {
    try {
      const upgraded = await callGeminiModelStaged('gemini-3.6-flash');
      if (upgraded.res.ok) {
        const upgradedJson = extractGeminiJson(upgraded.data);
        if (upgradedJson && typeof upgradedJson === 'object') {
          const upgradedNorm = normalizeParsedScreenshotDraft(upgradedJson, { inJapan });
          if (scoreParsedDraftRichness(upgradedJson, upgradedNorm) > scoreParsedDraftRichness(parsedJson, normalized)) {
            parsedJson = upgradedJson;
            normalized = upgradedNorm;
          }
        }
      }
    } catch {
      // 補讀失敗時安靜保留初次結果，不中斷使用者流程
    }
  }

  if (!normalized.isTransitScreenshot || normalized.segments.length === 0) {
    return {
      statusCode: 200,
      body: {
        status: 'not_transit',
        error: 'NOT_TRANSIT_SCREENSHOT',
        message: normalized.warning || '這張圖片看起來不含大眾運輸或公車路線資訊，請上傳 Google Maps / NAVITIME 等轉乘截圖。',
        quota: getScreenshotFeatureStatus(env, Date.now()),
      },
    };
  }

  // 以 100% 免費 Photon / OSM 進行站牌定位與 OSRM 貼路公車路線串連（不呼叫 Google Places API）
  const built = await anchorAndBuildTransitRoute({ draft: normalized, origin, destination }, env);
  return {
    statusCode: 200,
    body: {
      status: 'ok',
      ...built,
      confidence: normalized.confidence,
      warning: normalized.warning,
      quota: getScreenshotFeatureStatus(env, Date.now()),
    },
  };
}

export async function handleScreenshotBuildRouteRequest(body, { env = process.env } = {}) {
  const origin = body?.origin;
  const destination = body?.destination;
  const draft = body?.draft;

  if (!isValidCoord(origin) || !isValidCoord(destination) || !draft || !Array.isArray(draft.segments) || draft.segments.length === 0) {
    return {
      statusCode: 400,
      body: {
        status: 'invalid_request',
        error: 'INVALID_DRAFT',
        message: '請至少保留一段交通行程再進行站牌定位。',
      },
    };
  }

  const built = await anchorAndBuildTransitRoute({ draft, origin, destination }, env);
  return {
    statusCode: 200,
    body: {
      status: 'ok',
      ...built,
      quota: getScreenshotFeatureStatus(env, Date.now()),
    },
  };
}
