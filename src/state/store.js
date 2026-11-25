import {
  STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  ROUTE_CACHE_STORAGE_KEY,
  DAY_COLORS,
  EXPENSE_CATEGORY_MAP,
  TRANSPORT_MODES,
} from '../config/constants.js';
import { createDemoState, createBlankTripState } from '../config/demoData.js';
import { sanitizeHexColor, sanitizePinImage } from '../utils/format.js';
import { saveWorkspaceToIndexedDB, loadWorkspaceFromIndexedDB } from './localBackup.js';

const FX_CACHE_KEY = 'tripcanvas_fx_rates_twd_v1';
const VALID_CATEGORIES = new Set(Object.keys(EXPENSE_CATEGORY_MAP));
const VALID_TRANSPORT_MODES = new Set(Object.keys(TRANSPORT_MODES));
const VALID_TRANSPORT_STATUSES = new Set(['ok', 'pending', 'unsupported', 'network_error', 'manual']);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const mutationListeners = new Set();

let globalQuotaErrorHandler = null;
let localEditEpoch = 0;

export function setGlobalQuotaErrorHandler(fn) {
  globalQuotaErrorHandler = typeof fn === 'function' ? fn : null;
}

function makeId(prefix = 'trip') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeSafeId(raw, fallback) {
  const clean = typeof raw === 'string' ? raw.trim() : '';
  return SAFE_ID_RE.test(clean) ? clean : fallback;
}

function normalizeCategory(cat) {
  return VALID_CATEGORIES.has(cat) ? cat : 'other';
}

function clampCoord(val, min, max, fallback = 0) {
  const num = Number(val);
  if (!Number.isFinite(num) || num < min || num > max) return fallback;
  return num;
}

function normalizeStop(stop) {
  if (!stop || typeof stop !== 'object') return null;
  const out = {
    name: typeof stop.name === 'string' ? stop.name.trim().slice(0, 120) : '',
    timeText: typeof stop.timeText === 'string' ? stop.timeText.trim().slice(0, 32) : '',
  };
  const lat = Number(stop.lat);
  const lng = Number(stop.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    out.lat = lat;
    out.lng = lng;
  }
  return out;
}

function normalizeTransitSegment(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const type = seg.type === 'TRANSIT' ? 'TRANSIT' : 'WALK';
  const dur = Number(seg.durationMin);
  const dist = Number(seg.distanceMeters);
  const stops = Number(seg.stopCount);
  const out = {
    type,
    durationMin: Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : 0,
    distanceMeters: Number.isFinite(dist) && dist >= 0 ? Math.round(dist) : 0,
    encodedPolyline: typeof seg.encodedPolyline === 'string' ? seg.encodedPolyline : '',
  };
  if (type === 'TRANSIT') {
    out.vehicleType = typeof seg.vehicleType === 'string' ? seg.vehicleType.slice(0, 40) : 'RAIL';
    out.vehicleLabel = typeof seg.vehicleLabel === 'string' ? seg.vehicleLabel.slice(0, 40) : '大眾運輸';
    out.vehicleEmoji = typeof seg.vehicleEmoji === 'string' ? seg.vehicleEmoji.trim().slice(0, 8) : '🚆';
    out.lineName = typeof seg.lineName === 'string' ? seg.lineName.slice(0, 120) : '';
    out.lineShortName = typeof seg.lineShortName === 'string' ? seg.lineShortName.slice(0, 60) : '';
    out.displayLine = typeof seg.displayLine === 'string' ? seg.displayLine.slice(0, 120) : '';
    out.lineColor = seg.lineColor ? sanitizeHexColor(seg.lineColor, '') : '';
    if (out.lineColor === '#9A7B5C' && !/^#[0-9A-Fa-f]{6}$/.test(String(seg.lineColor || '').trim())) {
      out.lineColor = '';
    }
    out.lineTextColor = seg.lineTextColor ? sanitizeHexColor(seg.lineTextColor, '#FFFFFF') : '';
    out.headsign = typeof seg.headsign === 'string' ? seg.headsign.slice(0, 120) : '';
    out.stopCount = Number.isFinite(stops) && stops >= 0 ? Math.round(stops) : 0;
    out.departureStop = normalizeStop(seg.departureStop);
    out.arrivalStop = normalizeStop(seg.arrivalStop);
  }
  return out;
}

function normalizeFare(fare) {
  if (!fare || typeof fare !== 'object') return null;
  const amountTwd = Number(fare.amountTwd);
  if (!Number.isFinite(amountTwd) || amountTwd <= 0) return null;
  return {
    amountTwd: Math.round(amountTwd),
    originalAmount: Number.isFinite(Number(fare.originalAmount)) ? Number(fare.originalAmount) : Math.round(amountTwd),
    originalCurrency:
      typeof fare.originalCurrency === 'string' && fare.originalCurrency.trim()
        ? fare.originalCurrency.trim().toUpperCase().slice(0, 8)
        : 'TWD',
    originalText: typeof fare.originalText === 'string' ? fare.originalText.slice(0, 48) : '',
    exchangeRate: Number.isFinite(Number(fare.exchangeRate)) ? Number(fare.exchangeRate) : 1,
    rateSource: typeof fare.rateSource === 'string' ? fare.rateSource.slice(0, 20) : 'fallback',
  };
}

function normalizeTransport(t) {
  if (!t || typeof t !== 'object') return null;
  const mode = VALID_TRANSPORT_MODES.has(t.mode) ? t.mode : 'car';
  const costVal = Number(t.cost);
  const durVal = Number(t.duration);
  const distVal = Number(t.distanceKm);
  const walkVal = Number(t.totalWalkMin);
  const transVal = Number(t.transferCount);

  const normalized = {
    mode,
    status: VALID_TRANSPORT_STATUSES.has(t.status) ? t.status : mode === 'transit' ? 'manual' : 'ok',
    cost: Number.isFinite(costVal) && costVal > 0 ? Math.round(costVal) : 0,
  };

  if (typeof t.provider === 'string' && t.provider.trim()) {
    normalized.provider = t.provider.trim().slice(0, 32);
  }
  if (Number.isFinite(durVal) && durVal > 0) {
    normalized.duration = Math.round(durVal);
  }
  if (Number.isFinite(distVal) && distVal >= 0) {
    normalized.distanceKm = Number(distVal.toFixed(2));
  }
  if (typeof t.encodedPolyline === 'string' && t.encodedPolyline) {
    normalized.encodedPolyline = t.encodedPolyline;
  }
  if (typeof t.fallbackNote === 'string' && t.fallbackNote.trim()) {
    normalized.fallbackNote = t.fallbackNote.trim().slice(0, 120);
  }
  if (typeof t.originalCurrency === 'string' && t.originalCurrency.trim() && t.originalCurrency !== 'TWD') {
    const origCost = Number(t.originalCost);
    if (Number.isFinite(origCost) && origCost > 0) {
      normalized.originalCurrency = t.originalCurrency.trim().toUpperCase().slice(0, 8);
      normalized.originalCost = origCost;
    }
  }

  // 大眾運輸手動與分段欄位（嚴格白名單防 XSS）
  if (typeof t.transitType === 'string' && t.transitType.trim()) {
    normalized.transitType = t.transitType.trim().slice(0, 40);
  }
  if (typeof t.line === 'string' && t.line.trim()) {
    normalized.line = t.line.trim().slice(0, 120);
  }
  if (typeof t.schedule === 'string' && t.schedule.trim()) {
    normalized.schedule = t.schedule.trim().slice(0, 120);
  }
  if (typeof t.departureTime === 'string' && t.departureTime.trim()) {
    normalized.departureTime = t.departureTime.trim().slice(0, 40);
  }
  if (typeof t.transitPreference === 'string' && t.transitPreference.trim()) {
    normalized.transitPreference = t.transitPreference.trim().slice(0, 32);
  }
  if (typeof t.summaryText === 'string' && t.summaryText.trim()) {
    normalized.summaryText = t.summaryText.trim().slice(0, 200);
  }
  if (typeof t.departureTimeText === 'string' && t.departureTimeText.trim()) {
    normalized.departureTimeText = t.departureTimeText.trim().slice(0, 32);
  }
  if (typeof t.arrivalTimeText === 'string' && t.arrivalTimeText.trim()) {
    normalized.arrivalTimeText = t.arrivalTimeText.trim().slice(0, 32);
  }
  if (Number.isFinite(walkVal) && walkVal >= 0) {
    normalized.totalWalkMin = Math.round(walkVal);
  }
  if (Number.isFinite(transVal) && transVal >= 0) {
    normalized.transferCount = Math.round(transVal);
  }
  const fare = normalizeFare(t.fare);
  if (fare) normalized.fare = fare;

  if (Array.isArray(t.segments)) {
    const cleanSegs = t.segments.map(normalizeTransitSegment).filter(Boolean).slice(0, 30);
    if (cleanSegs.length > 0) {
      normalized.segments = cleanSegs;
    }
  }

  return normalized;
}

function normalizeDay(day, index) {
  const defaultColor = DAY_COLORS[index % DAY_COLORS.length];
  return {
    id: sanitizeSafeId(day?.id, `day_${index + 1}`),
    name: typeof day?.name === 'string' && day.name.trim() ? day.name.trim().slice(0, 80) : `Day ${index + 1}`,
    color: sanitizeHexColor(day?.color, defaultColor),
    visible: day?.visible !== false,
    pins: Array.isArray(day?.pins)
      ? day.pins.map((pin, pIdx) => {
          const normalized = {
            id: sanitizeSafeId(pin?.id, `pin_${index + 1}_${pIdx + 1}`),
            name:
              typeof pin?.name === 'string' && pin.name.trim()
                ? pin.name.trim().slice(0, 120)
                : `自訂景點 ${pIdx + 1}`,
            lat: clampCoord(pin?.lat, -90, 90, 25.033),
            lng: clampCoord(pin?.lng, -180, 180, 121.5654),
            image: sanitizePinImage(pin?.image),
            notes: typeof pin?.notes === 'string' ? pin.notes.slice(0, 4000) : '',
            subSpots: Array.isArray(pin?.subSpots)
              ? pin.subSpots.map((s, sIdx) => {
                  const sub = {
                    id: sanitizeSafeId(s?.id, `sub_${pIdx}_${sIdx}`),
                    name: typeof s?.name === 'string' ? s.name.slice(0, 120) : '',
                    cost: Math.max(0, Math.round(Number(s?.cost) || 0)),
                    category: normalizeCategory(s?.category),
                  };
                  if (
                    typeof s?.originalCurrency === 'string' &&
                    s.originalCurrency.trim() &&
                    s.originalCurrency !== 'TWD' &&
                    Number(s?.originalAmount) > 0
                  ) {
                    sub.originalCurrency = s.originalCurrency.trim().toUpperCase().slice(0, 8);
                    sub.originalAmount = Number(s.originalAmount);
                  }
                  return sub;
                })
              : [],
            transportToNext: normalizeTransport(pin?.transportToNext),
          };
          if (pin?.nameCustomized === true) {
            normalized.nameCustomized = true;
          }
          if (typeof pin?.placeId === 'string' && /^[A-Za-z0-9_\-]{1,256}$/.test(pin.placeId.trim())) {
            normalized.placeId = pin.placeId.trim();
          }
          if (typeof pin?.countryCode === 'string' && /^[A-Za-z]{2}$/.test(pin.countryCode.trim())) {
            normalized.countryCode = pin.countryCode.trim().toUpperCase();
          }
          if (Array.isArray(pin?.nearbyCandidates) && pin.nearbyCandidates.length > 1) {
            const cleanCands = pin.nearbyCandidates
              .filter((c) => c && typeof c.name === 'string' && c.name.trim())
              .slice(0, 5)
              .map((c) => {
                const rawPid = typeof c.placeId === 'string' ? c.placeId.trim() : '';
                const item = {
                  name: c.name.trim().slice(0, 120),
                  placeId: /^[A-Za-z0-9_\-]{1,256}$/.test(rawPid) ? rawPid : '',
                };
                if (Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
                  item.lat = clampCoord(c.lat, -90, 90, normalized.lat);
                  item.lng = clampCoord(c.lng, -180, 180, normalized.lng);
                }
                if (Number.isFinite(Number(c.distanceMeters))) {
                  item.distanceMeters = Math.max(0, Math.round(Number(c.distanceMeters)));
                }
                return item;
              });
            if (cleanCands.length > 1) {
              normalized.nearbyCandidates = cleanCands;
            }
          }
          return normalized;
        })
      : [],
  };
}

export function normalizeState(parsed) {
  if (!parsed || !Array.isArray(parsed.days) || parsed.days.length === 0) {
    return null;
  }
  const days = parsed.days.map(normalizeDay);
  const activeDayId = days.some((d) => d.id === parsed.activeDayId) ? parsed.activeDayId : days[0].id;
  return {
    activeDayId,
    addMode: parsed.addMode !== false,
    days,
  };
}

function createTripEntry(name, data) {
  const nowIso = new Date().toISOString();
  return {
    id: makeId('trip'),
    name: (name || '').trim().slice(0, 80) || '未命名旅遊計畫',
    createdAt: nowIso,
    updatedAt: nowIso,
    data,
  };
}

function normalizeDeletedTripIds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [k, v] of Object.entries(raw)) {
    if (
      typeof k === 'string' &&
      k &&
      !FORBIDDEN_KEYS.has(k) &&
      SAFE_ID_RE.test(k) &&
      typeof v === 'string' &&
      Number.isFinite(Date.parse(v))
    ) {
      clean[k] = v;
    }
  }
  return clean;
}

export function normalizeWorkspace(rawWs) {
  if (!rawWs || !Array.isArray(rawWs.trips) || rawWs.trips.length === 0) {
    return null;
  }
  const trips = rawWs.trips
    .map((t, idx) => {
      const data = normalizeState(t?.data);
      if (!data) return null;
      return {
        id: sanitizeSafeId(t?.id, `trip_${idx + 1}`),
        name: typeof t?.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 80) : `旅遊計畫 ${idx + 1}`,
        createdAt: typeof t?.createdAt === 'string' && Number.isFinite(Date.parse(t.createdAt)) ? t.createdAt : new Date().toISOString(),
        updatedAt: typeof t?.updatedAt === 'string' && Number.isFinite(Date.parse(t.updatedAt)) ? t.updatedAt : new Date().toISOString(),
        data,
      };
    })
    .filter(Boolean);

  if (trips.length === 0) return null;
  const activeTripId = trips.some((t) => t.id === rawWs.activeTripId) ? rawWs.activeTripId : trips[0].id;
  const latestTripTs = trips.reduce((acc, t) => {
    const ms = Date.parse(t.updatedAt);
    return Number.isFinite(ms) && ms > acc ? ms : acc;
  }, 0);
  const wsUpdatedAt =
    typeof rawWs.updatedAt === 'string' && Number.isFinite(Date.parse(rawWs.updatedAt))
      ? rawWs.updatedAt
      : latestTripTs > 0
        ? new Date(latestTripTs).toISOString()
        : new Date().toISOString();

  return {
    version: 5,
    activeTripId,
    updatedAt: wsUpdatedAt,
    isPristineDemo: rawWs.isPristineDemo === true,
    deletedTripIds: normalizeDeletedTripIds(rawWs.deletedTripIds),
    trips,
  };
}

function getWorkspaceMaxTimestampMs(ws) {
  if (!ws || typeof ws !== 'object') return 0;
  let maxMs = Number.isFinite(Date.parse(ws.updatedAt)) ? Date.parse(ws.updatedAt) : 0;
  if (Array.isArray(ws.trips)) {
    for (const t of ws.trips) {
      const ms = Date.parse(t?.updatedAt);
      if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
    }
  }
  return maxMs;
}

function createPristineDemoWorkspace() {
  const demo = createTripEntry('台北 2 日示範行程', createDemoState());
  return {
    version: 5,
    activeTripId: demo.id,
    updatedAt: demo.updatedAt,
    isPristineDemo: true,
    deletedTripIds: {},
    trips: [demo],
  };
}

function loadWorkspaceFromStorage() {
  if (typeof localStorage === 'undefined') {
    return createPristineDemoWorkspace();
  }

  // 1. 優先讀取 v5 多旅遊計畫工作區
  try {
    const rawV5 = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (rawV5) {
      const ws = normalizeWorkspace(JSON.parse(rawV5));
      if (ws) return ws;
    }
  } catch (err) {
    console.warn('讀取多旅遊計畫工作區失敗：', err);
  }

  // 2. 無縫遷移舊版 v4 單計畫資料（確保使用者原本規劃的行程不遺失）
  try {
    const rawV4 = localStorage.getItem(STORAGE_KEY);
    if (rawV4) {
      const migratedData = normalizeState(JSON.parse(rawV4));
      if (migratedData) {
        const entry = createTripEntry('我的自由行計畫', migratedData);
        const ws = {
          version: 5,
          activeTripId: entry.id,
          updatedAt: entry.updatedAt,
          isPristineDemo: false,
          deletedTripIds: {},
          trips: [entry],
        };
        try {
          localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
        } catch {
          // 靜默忽略
        }
        return ws;
      }
    }
  } catch (err) {
    console.warn('遷移舊版行程資料失敗：', err);
  }

  // 3. 全新瀏覽器載入預設台北 2 日示範行程（標記為 isPristineDemo，避免誤覆蓋雲端既有行程）
  return createPristineDemoWorkspace();
}

let workspace = loadWorkspaceFromStorage();

function writeWorkspaceToLocalStorage(ws) {
  if (typeof localStorage === 'undefined') return true;
  const serialized = JSON.stringify(ws);
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, serialized);
    return true;
  } catch (firstErr) {
    // 空間不足時先自動清除可重建的路線／匯率快取並重試一次
    try {
      localStorage.removeItem(ROUTE_CACHE_STORAGE_KEY);
      localStorage.removeItem(FX_CACHE_KEY);
      localStorage.setItem(WORKSPACE_STORAGE_KEY, serialized);
      return true;
    } catch (retryErr) {
      console.error('寫入 localStorage 失敗（已嘗試清理快取並降級為 IndexedDB 備份）：', firstErr, retryErr);
      return false;
    }
  }
}

function notifyWorkspaceMutated() {
  for (const fn of mutationListeners) {
    try {
      fn(workspace);
    } catch (err) {
      console.warn('Workspace mutation listener error:', err);
    }
  }
}

export function onWorkspaceMutated(listener) {
  if (typeof listener !== 'function') return () => {};
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

export function getWorkspace() {
  return workspace;
}

export function getAllTrips() {
  return workspace.trips;
}

export function getActiveTrip() {
  return workspace.trips.find((t) => t.id === workspace.activeTripId) || workspace.trips[0];
}

export function getState() {
  return getActiveTrip().data;
}

export function saveState(onQuotaError, { markEdited = true, skipCloudSync = false } = {}) {
  const nowIso = new Date().toISOString();
  const active = getActiveTrip();
  if (markEdited) {
    localEditEpoch++;
    if (active) active.updatedAt = nowIso;
    workspace.updatedAt = nowIso;
    workspace.isPristineDemo = false;
  }

  const localOk = writeWorkspaceToLocalStorage(workspace);
  // 雙重備份：同步鏡像至較大容量的 IndexedDB
  void saveWorkspaceToIndexedDB(workspace);

  if (!localOk) {
    const msg = '瀏覽器快捷空間已滿，已改存至擴充本機空間，建議登入 Google 雲端或精簡圖片';
    if (typeof onQuotaError === 'function') {
      onQuotaError(msg);
    } else if (typeof globalQuotaErrorHandler === 'function') {
      globalQuotaErrorHandler(msg);
    }
  }

  if (!skipCloudSync && !workspace.isPristineDemo) {
    notifyWorkspaceMutated();
  }

  return localOk;
}

export async function flushLocalBackupNow() {
  writeWorkspaceToLocalStorage(workspace);
  await saveWorkspaceToIndexedDB(workspace);
}

export function replaceWorkspace(nextRawWs, { markEdited = false, skipCloudSync = true } = {}) {
  const normalized = normalizeWorkspace(nextRawWs);
  if (!normalized) return false;
  if (markEdited) {
    localEditEpoch++;
    normalized.isPristineDemo = false;
    normalized.updatedAt = new Date().toISOString();
  }
  workspace = normalized;
  writeWorkspaceToLocalStorage(workspace);
  void saveWorkspaceToIndexedDB(workspace);
  if (!skipCloudSync && !workspace.isPristineDemo) {
    notifyWorkspaceMutated();
  }
  return true;
}

/**
 * 啟動時比對 IndexedDB 與 localStorage：
 * - 無論 localStorage 是否有資料，一律先讀出 IndexedDB 比較時間戳，絕不用滿額後殘留的舊 localStorage 反蓋較新的 IndexedDB！
 * - 若使用者在等待 IndexedDB 讀取期間已經動手編輯（localEditEpoch 改變），則保留使用者最新修改不硬蓋。
 */
export async function hydrateFromIndexedDBIfNeeded(loadImpl = loadWorkspaceFromIndexedDB) {
  const epochBeforeLoad = localEditEpoch;
  const backup = await loadImpl();
  const normalized = normalizeWorkspace(backup);

  // 若使用者在等待 IndexedDB 期間已經編輯過目前工作區，絕不覆蓋剛編輯的內容
  if (localEditEpoch !== epochBeforeLoad) {
    return false;
  }

  if (!normalized || normalized.isPristineDemo) {
    if (!workspace.isPristineDemo) {
      void saveWorkspaceToIndexedDB(workspace);
    }
    return false;
  }

  const localTs = getWorkspaceMaxTimestampMs(workspace);
  const idbTs = getWorkspaceMaxTimestampMs(normalized);

  if (workspace.isPristineDemo || idbTs > localTs) {
    workspace = normalized;
    writeWorkspaceToLocalStorage(workspace);
    return true;
  }

  // localStorage 較新時才同步鏡像回 IndexedDB
  if (localTs > idbTs) {
    void saveWorkspaceToIndexedDB(workspace);
  }
  return false;
}

export function createNewTrip(name, { blank = true, initialData = null } = {}) {
  const data = initialData ? normalizeState(initialData) : blank ? createBlankTripState() : createDemoState();
  const entry = createTripEntry(name || `旅遊計畫 ${workspace.trips.length + 1}`, data || createBlankTripState());
  workspace.trips.unshift(entry);
  workspace.activeTripId = entry.id;
  saveState();
  return entry;
}

export function switchTrip(tripId) {
  const target = workspace.trips.find((t) => t.id === tripId);
  if (!target) return null;
  workspace.activeTripId = target.id;
  saveState(null, { markEdited: !workspace.isPristineDemo });
  return target;
}

export function renameTrip(tripId, newName) {
  const target = workspace.trips.find((t) => t.id === tripId);
  if (!target || !newName?.trim()) return false;
  target.name = newName.trim().slice(0, 80);
  target.updatedAt = new Date().toISOString();
  saveState();
  return true;
}

function regenerateTripEntityIds(data) {
  const dayIdMap = new Map();
  const days = (data?.days || []).map((day, dIdx) => {
    const newDayId = makeId(`day${dIdx + 1}`);
    dayIdMap.set(day.id, newDayId);
    const pins = (day.pins || []).map((pin, pIdx) => ({
      ...pin,
      id: makeId(`pin${pIdx + 1}`),
      subSpots: (pin.subSpots || []).map((sub, sIdx) => ({
        ...sub,
        id: makeId(`sub${sIdx + 1}`),
      })),
    }));
    return {
      ...day,
      id: newDayId,
      pins,
    };
  });
  return {
    ...data,
    activeDayId: dayIdMap.get(data?.activeDayId) || days[0]?.id || 'day_1',
    days,
  };
}

export function duplicateTrip(tripId) {
  const source = workspace.trips.find((t) => t.id === tripId);
  if (!source) return null;
  const clonedData = regenerateTripEntityIds(JSON.parse(JSON.stringify(source.data)));
  const copy = createTripEntry(`${source.name} (副本)`, clonedData);
  const idx = workspace.trips.findIndex((t) => t.id === tripId);
  workspace.trips.splice(idx + 1, 0, copy);
  workspace.activeTripId = copy.id;
  saveState();
  return copy;
}

export function deleteTrip(tripId) {
  if (workspace.trips.length <= 1) return false;
  workspace.trips = workspace.trips.filter((t) => t.id !== tripId);
  if (!workspace.deletedTripIds || typeof workspace.deletedTripIds !== 'object') {
    workspace.deletedTripIds = {};
  }
  workspace.deletedTripIds[tripId] = new Date().toISOString();
  if (workspace.activeTripId === tripId) {
    workspace.activeTripId = workspace.trips[0].id;
  }
  saveState();
  return true;
}

export function serializeStateForExport() {
  const active = getActiveTrip();
  return JSON.stringify(
    {
      tripName: active.name,
      ...active.data,
    },
    null,
    2
  );
}

export function parseImportedState(jsonText) {
  const parsed = JSON.parse(jsonText);
  // 同時相容匯入完整多計畫備份檔（tripcanvas-workspace.json）與單計畫匯出檔
  if (parsed && Array.isArray(parsed.trips) && parsed.trips.length > 0 && !Array.isArray(parsed.days)) {
    const ws = normalizeWorkspace(parsed);
    if (!ws) throw new Error('無效的行程 JSON 格式');
    const primaryTrip = ws.trips.find((t) => t.id === ws.activeTripId) || ws.trips[0];
    return {
      isWorkspace: true,
      workspace: ws,
      tripName: primaryTrip.name,
      data: primaryTrip.data,
    };
  }
  const normalized = normalizeState(parsed);
  if (!normalized) {
    throw new Error('無效的行程 JSON 格式');
  }
  return {
    isWorkspace: false,
    tripName: typeof parsed.tripName === 'string' && parsed.tripName.trim() ? parsed.tripName.trim().slice(0, 80) : '',
    data: normalized,
  };
}
