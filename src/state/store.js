import {
  STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  DAY_COLORS,
  EXPENSE_CATEGORY_MAP,
} from '../config/constants.js';
import { createDemoState, createBlankTripState } from '../config/demoData.js';

const VALID_CATEGORIES = new Set(Object.keys(EXPENSE_CATEGORY_MAP));

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
            ? pin.subSpots.map((s, sIdx) => ({
                id: s?.id || `sub_${pIdx}_${sIdx}`,
                name: typeof s?.name === 'string' ? s.name : '',
                cost: Math.max(0, Number(s?.cost) || 0),
                category: normalizeCategory(s?.category),
              }))
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

function normalizeWorkspace(rawWs) {
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
  return {
    version: 5,
    activeTripId,
    trips,
  };
}

function loadWorkspaceFromStorage() {
  if (typeof localStorage === 'undefined') {
    const demo = createTripEntry('台北 2 日示範行程', createDemoState());
    return { version: 5, activeTripId: demo.id, trips: [demo] };
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
        const ws = { version: 5, activeTripId: entry.id, trips: [entry] };
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

  // 3. 全新使用者載入預設台北 2 日示範行程
  const demo = createTripEntry('台北 2 日示範行程', createDemoState());
  return { version: 5, activeTripId: demo.id, trips: [demo] };
}

let workspace = loadWorkspaceFromStorage();

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
  active.data = nextState;
  active.updatedAt = new Date().toISOString();
}

export function saveState(onQuotaError) {
  const active = getActiveTrip();
  if (active) {
    active.updatedAt = new Date().toISOString();
  }
  if (typeof localStorage === 'undefined') return true;
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    return true;
  } catch (err) {
    console.error('寫入 localStorage 失敗：', err);
    if (typeof onQuotaError === 'function') {
      onQuotaError('儲存空間已滿，建議匯出 JSON 備份或移除過大圖片');
    }
    return false;
  }
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
  saveState();
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
