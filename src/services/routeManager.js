import { ROUTE_CACHE_STORAGE_KEY } from '../config/constants.js';
import { isJapanTrip, makeRouteCacheKey } from '../utils/geo.js';
import { getGoogleRoutesStatus, queryGoogleRoutesProxy } from './googleRoutes.js';
import { queryFossgisOSRM } from './osrmFallback.js';
import { getState, saveState } from '../state/store.js';

const MAX_CACHE_ENTRIES = 120;
const routeCache = loadRouteCache();
const inFlightRequests = new Map();

function loadRouteCache() {
  const map = new Map();
  try {
    const raw = localStorage.getItem(ROUTE_CACHE_STORAGE_KEY);
    if (!raw) return map;
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) {
      for (const [k, v] of entries) {
        if (typeof k === 'string' && v && typeof v === 'object') {
          map.set(k, v);
        }
      }
    }
  } catch {
    // 忽略快取損毀
  }
  return map;
}

function persistRouteCache() {
  try {
    while (routeCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = routeCache.keys().next().value;
      routeCache.delete(oldestKey);
    }
    localStorage.setItem(ROUTE_CACHE_STORAGE_KEY, JSON.stringify(Array.from(routeCache.entries())));
  } catch {
    // 空間不足時靜默降級為記憶體快取
  }
}

function setCachedRoute(key, value) {
  if (routeCache.has(key)) routeCache.delete(key);
  routeCache.set(key, value);
  persistRouteCache();
}

export function getCachedRoute(mode, pinA, pinB, extra = {}) {
  const key = makeRouteCacheKey(mode, pinA, pinB, extra);
  return routeCache.get(key) || null;
}

/**
 * 統一的路線查詢入口：
 * - 陸路交通：Google Routes API (HIGH_QUALITY) 優先；未設定 Key 或連線異常時無縫降級至 FOSSGIS OSRM
 * - 大眾運輸：全球走 Google Routes API (TRANSIT 分段)，日本自動走 NAVITIME RapidAPI（含日圓票價自動換算）
 */
export async function computeSegmentRoute({
  mode,
  pinA,
  pinB,
  departureTime = '',
  transitPreference = 'DEFAULT',
  forceRefresh = false,
}) {
  const cacheKey = makeRouteCacheKey(mode, pinA, pinB, { departureTime, transitPreference });

  if (!forceRefresh && inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }

  const task = (async () => {
    try {
      // A. 大眾運輸：透過 /api/routes 呼叫 Google Routes API v2 或日本 NAVITIME
      if (mode === 'transit') {
        if (!forceRefresh && routeCache.has(cacheKey)) {
          return routeCache.get(cacheKey);
        }
        const res = await queryGoogleRoutesProxy({
          mode: 'transit',
          pinA,
          pinB,
          departureTime,
          transitPreference,
        });
        if (res.status === 'ok') {
          setCachedRoute(cacheKey, res);
        }
        return res;
      }

      // B. 陸路交通（car / scooter / bike / walk）
      const googleStatus = await getGoogleRoutesStatus(forceRefresh);
      const cached = !forceRefresh ? routeCache.get(cacheKey) : null;

      // 若快取已存在且（非備援 OSRM 或尚未設定 Google Key），直接使用快取
      if (cached && (!googleStatus.configured || cached.provider === 'google')) {
        return cached;
      }

      if (googleStatus.configured) {
        const gRes = await queryGoogleRoutesProxy({ mode, pinA, pinB });
        if (gRes.status === 'ok' || gRes.status === 'unsupported') {
          setCachedRoute(cacheKey, gRes);
          return gRes;
        }
        if (cached) return cached;
        // 若 Google API 發生配額/網路錯誤，自動備援 FOSSGIS OSRM 讓地圖依然能貼路繪製
      }

      const osrmRes = await queryFossgisOSRM(mode, pinA, pinB);
      if (osrmRes.status === 'ok' || osrmRes.status === 'unsupported') {
        setCachedRoute(cacheKey, osrmRes);
      }
      return osrmRes;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, task);
  return task;
}

/**
 * 將選定的分段大眾運輸路線物件（Google 或日本 NAVITIME）轉換為存於 pin.transportToNext 的標準欄位
 */
export function buildTransitTransportRecord(
  routeObj,
  {
    provider = '',
    departureTime = '',
    transitPreference = 'DEFAULT',
    selectedRouteIndex = 0,
    cost = null,
    originalCost = null,
    originalCurrency = '',
  } = {}
) {
  const transitSegs = (routeObj.segments || []).filter((s) => s.type === 'TRANSIT');
  const firstTransit = transitSegs[0];
  const fare = routeObj.fare || null;
  const resolvedCost =
    cost != null && Number.isFinite(Number(cost))
      ? Math.max(0, Math.round(Number(cost)))
      : fare?.amountTwd
        ? Math.max(0, Math.round(Number(fare.amountTwd)))
        : 0;

  const record = {
    mode: 'transit',
    status: 'ok',
    provider: provider || routeObj.provider || 'google',
    duration: routeObj.durationMin,
    distanceKm: routeObj.distanceKm,
    cost: resolvedCost,
    fare,
    encodedPolyline: routeObj.encodedPolyline || '',
    departureTime,
    transitPreference,
    selectedRouteIndex,
    summaryText: routeObj.summaryText || '',
    departureTimeText: routeObj.departureTimeText || '',
    arrivalTimeText: routeObj.arrivalTimeText || '',
    totalWalkMin: routeObj.totalWalkMin || 0,
    transferCount: routeObj.transferCount || 0,
    segments: routeObj.segments || [],
    // 同步寫入傳統欄位，確保匯出至舊版也能讀懂基本路線名與時間
    transitType: firstTransit?.vehicleLabel || '大眾運輸',
    line: transitSegs.map((s) => s.displayLine).filter(Boolean).join(' → '),
    schedule: firstTransit?.headsign ? `往 ${firstTransit.headsign}` : '',
  };

  if (originalCurrency && originalCurrency !== 'TWD' && Number(originalCost) > 0) {
    record.originalCost = Number(originalCost);
    record.originalCurrency = originalCurrency;
  }

  return record;
}

/**
 * 背景補齊所有待查詢、缺少貼路折線（舊版 JSON 匯入）或可升級為分段大眾運輸的路段
 */
export async function resolvePendingSegments({ onUpdated, retryNetworkErrors = false } = {}) {
  const state = getState();
  const googleStatus = await getGoogleRoutesStatus();
  const jobs = [];

  state.days.forEach((day) => {
    day.pins.forEach((pin, idx) => {
      const nextPin = day.pins[idx + 1];
      const t = pin.transportToNext;
      if (!nextPin || !t) return;

      if (t.mode === 'transit') {
        const inJapan = isJapanTrip(pin, nextPin);
        const canQueryRegionTransit = inJapan ? googleStatus.navitimeConfigured : googleStatus.configured;
        const shouldAutoQueryTransit =
          canQueryRegionTransit &&
          (t.status === 'pending' || (t.autoUpgradeOnGoogle && t.status === 'manual'));

        if (shouldAutoQueryTransit) {
          jobs.push({ dayId: day.id, pinId: pin.id, nextPinId: nextPin.id, idx, mode: 'transit', t });
        }
        return;
      }

      const needsLandGeometry =
        t.status === 'pending' ||
        (t.status === 'ok' && !t.encodedPolyline) ||
        (retryNetworkErrors && t.status === 'network_error');

      if (needsLandGeometry) {
        jobs.push({ dayId: day.id, pinId: pin.id, nextPinId: nextPin.id, idx, mode: t.mode, t });
      }
    });
  });

  if (jobs.length === 0) return;

  // 每次處理 2 筆，避免一次大量並發觸發外部限流
  const batchSize = 2;
  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (job) => {
        const latestState = getState();
        const curDay = latestState.days.find((d) => d.id === job.dayId);
        const curPin = curDay?.pins[job.idx];
        const curNext = curDay?.pins[job.idx + 1];
        if (!curPin || curPin.id !== job.pinId || !curNext || curNext.id !== job.nextPinId) return;
        if (!curPin.transportToNext || curPin.transportToNext.mode !== job.mode) return;

        const res = await computeSegmentRoute({
          mode: job.mode,
          pinA: curPin,
          pinB: curNext,
          departureTime: job.t.departureTime || '',
          transitPreference: job.t.transitPreference || 'DEFAULT',
        });

        // 再次確認路段未在使用者操作期間被變更
        const afterState = getState();
        const afterDay = afterState.days.find((d) => d.id === job.dayId);
        const afterPin = afterDay?.pins[job.idx];
        const afterNext = afterDay?.pins[job.idx + 1];
        if (!afterPin || afterPin.id !== job.pinId || !afterNext || afterNext.id !== job.nextPinId) return;
        if (!afterPin.transportToNext || afterPin.transportToNext.mode !== job.mode) return;

        if (job.mode === 'transit') {
          if (res.status === 'ok' && Array.isArray(res.routes) && res.routes.length > 0) {
            const chosenIdx = Math.min(afterPin.transportToNext.selectedRouteIndex || 0, res.routes.length - 1);
            const chosenRoute = res.routes[chosenIdx];
            // 若有回傳票價優先自動帶入新台幣票價，否則保留既有費用
            const autoCost = chosenRoute.fare?.amountTwd ?? afterPin.transportToNext.cost ?? 0;
            afterPin.transportToNext = buildTransitTransportRecord(chosenRoute, {
              provider: chosenRoute.provider || res.provider || 'google',
              departureTime: afterPin.transportToNext.departureTime || '',
              transitPreference: afterPin.transportToNext.transitPreference || 'DEFAULT',
              selectedRouteIndex: chosenIdx,
              cost: autoCost,
            });
            saveState(null, { markEdited: false, skipCloudSync: true });
            if (typeof onUpdated === 'function') onUpdated();
          }
          return;
        }

        afterPin.transportToNext = {
          ...afterPin.transportToNext,
          status: res.status,
          provider: res.provider || afterPin.transportToNext.provider || 'osrm',
          distanceKm: res.status === 'ok' ? res.distanceKm : null,
          duration: res.status === 'ok' ? res.durationMin : null,
          encodedPolyline: res.status === 'ok' ? res.encodedPolyline || '' : '',
          fallbackNote: res.status === 'ok' ? res.fallbackNote || '' : '',
          cost: Math.max(0, Math.round(Number(afterPin.transportToNext.cost) || 0)),
        };
        saveState(null, { markEdited: false, skipCloudSync: true });
        if (typeof onUpdated === 'function') onUpdated();
      })
    );
  }
}
