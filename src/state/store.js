import { STORAGE_KEY, DAY_COLORS } from '../config/constants.js';
import { createDemoState } from '../config/demoData.js';

let currentState = loadStateFromStorage();

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
              }))
            : [],
          transportToNext: pin?.transportToNext ? { ...pin.transportToNext } : null,
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

function loadStateFromStorage() {
  if (typeof localStorage === 'undefined') {
    return createDemoState();
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const normalized = normalizeState(JSON.parse(raw));
      if (normalized) return normalized;
    }
  } catch (err) {
    console.warn('讀取本機儲存失敗，載入預設示範行程：', err);
  }
  return createDemoState();
}

export function getState() {
  return currentState;
}

export function setState(nextState) {
  currentState = nextState;
}

export function resetStateToDemo() {
  currentState = createDemoState();
  saveState();
  return currentState;
}

export function saveState(onQuotaError) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));
    return true;
  } catch (err) {
    console.error('寫入 localStorage 失敗：', err);
    if (typeof onQuotaError === 'function') {
      onQuotaError('儲存空間已滿，建議匯出 JSON 備份或移除過大圖片');
    }
    return false;
  }
}

export function serializeStateForExport() {
  return JSON.stringify(currentState, null, 2);
}

export function parseImportedState(jsonText) {
  const parsed = JSON.parse(jsonText);
  const normalized = normalizeState(parsed);
  if (!normalized) {
    throw new Error('無效的行程 JSON 格式');
  }
  return normalized;
}
