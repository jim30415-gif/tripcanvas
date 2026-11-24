import {
  STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  ROUTE_CACHE_STORAGE_KEY,
  DAY_COLORS,
  EXPENSE_CATEGORY_MAP,
} from '../config/constants.js';
import { createDemoState, createBlankTripState } from '../config/demoData.js';
import { saveWorkspaceToIndexedDB, loadWorkspaceFromIndexedDB } from './localBackup.js';

const FX_CACHE_KEY = 'tripcanvas_fx_rates_twd_v1';
const VALID_CATEGORIES = new Set(Object.keys(EXPENSE_CATEGORY_MAP));
const mutationListeners = new Set();

function makeId(prefix = 'trip') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeCategory(cat) {
  return VALID_CATEGORIES.has(cat) ? cat : 'other';
}

function normalizeTransport(t) {
  if (!t || typeof t !== 'object') return null;
  const costVal = Number(t.cost);
  return {
    ...t,
    cost: Number.isFinite(costVal) && costVal > 0 ? Math.round(costVal) : 0,
  };
}

function normalizeDay(day, index) {
  return {
    id: day?.id || `day_${index + 1}`,
    name: typeof day?.name === 'string' && day.name.trim() ? day.name : `Day ${index + 1}`,
    color: day?.color || DAY_COLORS[index % DAY_COLORS.length],
    visible: day?.visible !== false,
    pins: Array.isArray(day?.pins)
      ? day.pins.map((pin, pIdx) => ({
          id: pin?.id || `pin_${index + 1}_${pIdx + 1}`,
          name: typeof pin?.name === 'string' && pin.name.trim() ? pin.name : `自訂景點 ${pIdx + 1}`,
          lat: Number(pin?.lat) || 0,
          lng: Number(pin?.lng) || 0,
          image: pin?.image || null,
          notes: typeof pin?.notes === 'string' ? pin.notes : '',
          subSpots: Array.isArray(pin?.subSpots)
            ? pin.subSpots.map((s, sIdx) => {
                const sub = {
                  id: s?.id || `sub_${pIdx}_${sIdx}`,
                  name: typeof s?.name === 'string' ? s.name : '',
                  cost: Math.max(0, Number(s?.cost) || 0),
                  category: normalizeCategory(s?.category),
                };
                if (
                  typeof s?.originalCurrency === 'string' &&
                  s.originalCurrency &&
                  s.originalCurrency !== 'TWD' &&
                  Number(s?.originalAmount) > 0
                ) {
                  sub.originalCurrency = s.originalCurrency.toUpperCase();
                  sub.originalAmount = Number(s.originalAmount);
                }
                return sub;
              })
            : [],
          transportToNext: normalizeTransport(pin?.transportToNext),
        }))
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
    name: (name || '').trim() || '未命名旅遊計畫',
    createdAt: nowIso,
    updatedAt: nowIso,
    data,
  };
}

function normalizeDeletedTripIds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && k && typeof v === 'string' && Number.isFinite(Date.parse(v))) {
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
        id: t?.id || `trip_${idx + 1}`,
        name: typeof t?.name === 'string' && t.name.trim() ? t.name.trim() : `旅遊計畫 ${idx + 1}`,
        createdAt: t?.createdAt || new Date().toISOString(),
        updatedAt: t?.updatedAt || new Date().toISOString(),
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

export function setState(nextState) {
  const active = getActiveTrip();
  const nowIso = new Date().toISOString();
  active.data = nextState;
  active.updatedAt = nowIso;
  workspace.updatedAt = nowIso;
  workspace.isPristineDemo = false;
}

export function saveState(onQuotaError, { markEdited = true, skipCloudSync = false } = {}) {
  const nowIso = new Date().toISOString();
  const active = getActiveTrip();
  if (markEdited) {
    if (active) active.updatedAt = nowIso;
    workspace.updatedAt = nowIso;
    workspace.isPristineDemo = false;
  }

  const localOk = writeWorkspaceToLocalStorage(workspace);
  // 雙重備份：同步鏡像至較大容量的 IndexedDB
  void saveWorkspaceToIndexedDB(workspace);

  if (!localOk && typeof onQuotaError === 'function') {
    onQuotaError('瀏覽器快捷空間已滿，已改存至擴充本機空間，建議登入 Google 雲端或精簡圖片');
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
 * 啟動時檢查 IndexedDB 備份：
 * 若 localStorage 被清掉或超過 5 MB 上限（目前僅為預設示範行程），
 * 自動從 IndexedDB 還原使用者的所有旅遊計畫。
 */
export async function hydrateFromIndexedDBIfNeeded() {
  if (!workspace.isPristineDemo) {
    void saveWorkspaceToIndexedDB(workspace);
    return false;
  }
  const backup = await loadWorkspaceFromIndexedDB();
  const normalized = normalizeWorkspace(backup);
  if (!normalized || normalized.isPristineDemo) {
    return false;
  }
  workspace = normalized;
  writeWorkspaceToLocalStorage(workspace);
  return true;
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
  target.name = newName.trim();
  target.updatedAt = new Date().toISOString();
  saveState();
  return true;
}

export function duplicateTrip(tripId) {
  const source = workspace.trips.find((t) => t.id === tripId);
  if (!source) return null;
  const clonedData = JSON.parse(JSON.stringify(source.data));
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

export function resetStateToDemo() {
  const active = getActiveTrip();
  active.data = createDemoState();
  active.updatedAt = new Date().toISOString();
  saveState();
  return active.data;
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
  const normalized = normalizeState(parsed);
  if (!normalized) {
    throw new Error('無效的行程 JSON 格式');
  }
  return {
    tripName: typeof parsed.tripName === 'string' && parsed.tripName.trim() ? parsed.tripName.trim() : '',
    data: normalized,
  };
}
