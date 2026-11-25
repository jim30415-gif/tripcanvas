import { ROUTE_CACHE_STORAGE_KEY } from '../config/constants.js';
import { isJapanTrip, makeRouteCacheKey } from '../utils/geo.js';
import { getGoogleRoutesStatus, queryGoogleRoutesProxy } from './googleRoutes.js';
import { queryFossgisOSRM } from './osrmFallback.js';
import { getActiveTrip, getState, saveState } from '../state/store.js';

const MAX_CACHE_ENTRIES = 120;
const TTL_LAND_OK_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const TTL_TRANSIT_NOW_MS = 10 * 60 * 1000; // 「現在出發」班次快取 10 分鐘
const TTL_TRANSIT_SCHEDULED_MS = 6 * 60 * 60 * 1000; // 指定時刻班次快取 6 小時
const TTL_UNSUPPORTED_MS = 15 * 60 * 1000; // 查無路線快取 15 分鐘

const routeCache = loadRouteCache();
const inFlightRequests = new Map();
let persistTimer = null;
let resolveRunning = false;
let resolveQueuedOpts = null;

function isCacheEntryFresh(key, entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return false;
  const cachedAt = Number(entry._cachedAt) || 0;
  if (!cachedAt) return false;
  const age = now - cachedAt;
  if (age < 0) return false;
  if (entry.status === 'unsupported') return age <= TTL_UNSUPPORTED_MS;
  if (key.startsWith('transit|')) {
    const isNowQuery = key.endsWith('|now');
    return age <= (isNowQuery ? TTL_TRANSIT_NOW_MS : TTL_TRANSIT_SCHEDULED_MS);
  }
  return age <= TTL_LAND_OK_MS;
}

function loadRouteCache() {
  const map = new Map();
  try {
    if (typeof localStorage === 'undefined') return map;
    const raw = localStorage.getItem(ROUTE_CACHE_STORAGE_KEY);
    if (!raw) return map;
    const entries = JSON.parse(raw);
    const now = Date.now();
    if (Array.isArray(entries)) {
      for (const [k, v] of entries) {
        if (typeof k === 'string' && v && typeof v === 'object' && isCacheEntryFresh(k, v, now)) {
          map.set(k, v);
        }
      }
    }
  } catch {
    // 忽略快取損毀
  }
  return map;
}

function persistRouteCacheDebounced() {
  if (typeof localStorage === 'undefined') return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      while (routeCache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = routeCache.keys().next().value;
        routeCache.delete(oldestKey);
      }
      localStorage.setItem(ROUTE_CACHE_STORAGE_KEY, JSON.stringify(Array.from(routeCache.entries())));
    } catch {
      // 空間不足時靜默降級為記憶體快取
    }
  }, 400);
}

function setCachedRoute(key, value) {
  if (routeCache.has(key)) routeCache.delete(key);
  routeCache.set(key, { ...value, _cachedAt: Date.now() });
  persistRouteCacheDebounced();
}

function readFreshCachedRoute(key) {
  const entry = routeCache.get(key);
  if (!entry) return null;
  if (!isCacheEntryFresh(key, entry)) {
    routeCache.delete(key);
    return null;
  }
  return entry;
}

export function getCachedRoute(mode, pinA, pinB, extra = {}) {
  const key = makeRouteCacheKey(mode, pinA, pinB, extra);
  return readFreshCachedRoute(key);
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
        const cachedTransit = !forceRefresh ? readFreshCachedRoute(cacheKey) : null;
        if (cachedTransit) return cachedTransit;
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
      const cached = !forceRefresh ? readFreshCachedRoute(cacheKey) : null;

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
      if (inFlightRequests.get(cacheKey) === task) {
        inFlightRequests.delete(cacheKey);
      }
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
 * 依實際汽車路網行車時間估算市區／觀光公車參考車程（納入停靠站與紅綠燈停等）
 */
export function estimateBusDurationFromCarMin(carDurationMin) {
  const carMin = Number(carDurationMin);
  if (!Number.isFinite(carMin) || carMin <= 0) return null;
  if (carMin <= 20) {
    return Math.max(Math.round(carMin) + 3, Math.round(carMin * 1.45));
  }
  return Math.max(Math.round(carMin) + 5, Math.round(carMin * 1.2 + 5));
}

function sameCoord(a, b) {
  return Math.abs(Number(a.lat) - Number(b.lat)) < 1e-6 && Math.abs(Number(a.lng) - Number(b.lng)) < 1e-6;
}

/**
 * 背景補齊所有待查詢、缺少貼路折線（舊版 JSON 匯入或標點移動後之貼路公車）或可升級為分段大眾運輸的路段
 */
export async function resolvePendingSegments({ onUpdated, retryNetworkErrors = false } = {}) {
  if (resolveRunning) {
    resolveQueuedOpts = {
      onUpdated: onUpdated || resolveQueuedOpts?.onUpdated,
      retryNetworkErrors: Boolean(retryNetworkErrors || resolveQueuedOpts?.retryNetworkErrors),
    };
    return;
  }

  resolveRunning = true;
  try {
    const tripIdSnapshot = getActiveTrip()?.id || '';
    const state = getState();
    const googleStatus = await getGoogleRoutesStatus();
    const jobs = [];
    let mutatedOffline = false;

    state.days.forEach((day) => {
      day.pins.forEach((pin, idx) => {
        const nextPin = day.pins[idx + 1];
        const t = pin.transportToNext;
        if (!nextPin || !t) return;

        if (t.mode === 'transit') {
          // 手動貼路公車若因標點移動而清除折線，背景重新沿實際馬路貼路（保留手動路線名／費用）
          if (t.status === 'manual' && t.roadSnapped && !t.encodedPolyline) {
            jobs.push({
              tripId: tripIdSnapshot,
              dayId: day.id,
              pinId: pin.id,
              nextPinId: nextPin.id,
              pinACoord: { lat: Number(pin.lat), lng: Number(pin.lng) },
              pinBCoord: { lat: Number(nextPin.lat), lng: Number(nextPin.lng) },
              mode: 'car',
              resnapManualBus: true,
              expectedStatus: 'manual',
              departureTime: '',
              transitPreference: 'DEFAULT',
            });
            return;
          }

          const inJapan = isJapanTrip(pin, nextPin);
          const canQueryRegionTransit = inJapan ? googleStatus.navitimeConfigured : googleStatus.configured;

          // 若大眾運輸處於 pending 但該區域未設定自動查詢或目前離線，立刻結束 pending 狀態避免永遠卡轉圈
          if (t.status === 'pending' && !canQueryRegionTransit) {
            pin.transportToNext = {
              ...t,
              status: googleStatus.reachable ? 'manual' : 'network_error',
            };
            mutatedOffline = true;
            return;
          }

          const shouldAutoQueryTransit =
            canQueryRegionTransit &&
            (t.status === 'pending' ||
              (t.autoUpgradeOnGoogle && t.status === 'manual') ||
              (retryNetworkErrors && t.status === 'network_error'));

          if (shouldAutoQueryTransit) {
            jobs.push({
              tripId: tripIdSnapshot,
              dayId: day.id,
              pinId: pin.id,
              nextPinId: nextPin.id,
              pinACoord: { lat: Number(pin.lat), lng: Number(pin.lng) },
              pinBCoord: { lat: Number(nextPin.lat), lng: Number(nextPin.lng) },
              mode: 'transit',
              expectedStatus: t.status,
              departureTime: t.departureTime || '',
              transitPreference: t.transitPreference || 'DEFAULT',
            });
          }
          return;
        }

        const needsLandGeometry =
          t.status === 'pending' ||
          (t.status === 'ok' && !t.encodedPolyline) ||
          (retryNetworkErrors && t.status === 'network_error');

        if (needsLandGeometry) {
          jobs.push({
            tripId: tripIdSnapshot,
            dayId: day.id,
            pinId: pin.id,
            nextPinId: nextPin.id,
            pinACoord: { lat: Number(pin.lat), lng: Number(pin.lng) },
            pinBCoord: { lat: Number(nextPin.lat), lng: Number(nextPin.lng) },
            mode: t.mode,
            expectedStatus: t.status,
            departureTime: '',
            transitPreference: 'DEFAULT',
          });
        }
      });
    });

    if (mutatedOffline) {
      saveState(null, { markEdited: false, skipCloudSync: true });
      if (typeof onUpdated === 'function') onUpdated();
    }

    if (jobs.length === 0) return;

    const batchSize = 2;
    for (let i = 0; i < jobs.length; i += batchSize) {
      const batch = jobs.slice(i, i + batchSize);
      let batchMutated = false;

      await Promise.all(
        batch.map(async (job) => {
          if ((getActiveTrip()?.id || '') !== job.tripId) return;
          const latestState = getState();
          const curDay = latestState.days.find((d) => d.id === job.dayId);
          const curIdx = curDay ? curDay.pins.findIndex((p) => p.id === job.pinId) : -1;
          const curPin = curIdx >= 0 ? curDay.pins[curIdx] : null;
          const curNext = curIdx >= 0 ? curDay.pins[curIdx + 1] : null;
          if (!curPin || !curNext || curNext.id !== job.nextPinId) return;
          if (!sameCoord(curPin, job.pinACoord) || !sameCoord(curNext, job.pinBCoord)) return;
          const expectedMode = job.resnapManualBus ? 'transit' : job.mode;
          if (!curPin.transportToNext || curPin.transportToNext.mode !== expectedMode) return;

          const res = await computeSegmentRoute({
            mode: job.mode,
            pinA: curPin,
            pinB: curNext,
            departureTime: job.departureTime,
            transitPreference: job.transitPreference,
          });

          // 再次確認計畫、相鄰標點、座標與使用者設定在非同步查詢期間均未被改動
          if ((getActiveTrip()?.id || '') !== job.tripId) return;
          const afterState = getState();
          const afterDay = afterState.days.find((d) => d.id === job.dayId);
          const afterIdx = afterDay ? afterDay.pins.findIndex((p) => p.id === job.pinId) : -1;
          const afterPin = afterIdx >= 0 ? afterDay.pins[afterIdx] : null;
          const afterNext = afterIdx >= 0 ? afterDay.pins[afterIdx + 1] : null;
          if (!afterPin || !afterNext || afterNext.id !== job.nextPinId) return;
          if (!sameCoord(afterPin, job.pinACoord) || !sameCoord(afterNext, job.pinBCoord)) return;
          const curT = afterPin.transportToNext;
          if (!curT || curT.mode !== expectedMode) return;

          if (job.resnapManualBus) {
            if (curT.status !== 'manual' || !curT.roadSnapped || curT.encodedPolyline) return;
            if (res.status === 'ok' && res.encodedPolyline) {
              const estBusMin = curT.durationEstimated
                ? estimateBusDurationFromCarMin(res.durationMin)
                : curT.duration;
              afterPin.transportToNext = {
                ...curT,
                provider: res.provider === 'google' ? 'manual-google' : 'manual-osrm',
                encodedPolyline: res.encodedPolyline,
                distanceKm: res.distanceKm ?? curT.distanceKm ?? null,
                duration: estBusMin ?? curT.duration ?? null,
              };
              batchMutated = true;
            }
            return;
          }

          if (job.mode === 'transit') {
            // 若使用者已在背景查詢期間手動改寫出發時間、偏好或手動紀錄，不覆蓋使用者修改
            if (
              curT.status !== job.expectedStatus ||
              (curT.departureTime || '') !== job.departureTime ||
              (curT.transitPreference || 'DEFAULT') !== job.transitPreference
            ) {
              return;
            }

            if (res.status === 'ok' && Array.isArray(res.routes) && res.routes.length > 0) {
              const chosenIdx = Math.min(curT.selectedRouteIndex || 0, res.routes.length - 1);
              const chosenRoute = res.routes[chosenIdx];
              const hasApiFare = Boolean(chosenRoute.fare?.amountTwd);
              const autoCost = hasApiFare ? chosenRoute.fare.amountTwd : curT.cost ?? 0;
              afterPin.transportToNext = buildTransitTransportRecord(chosenRoute, {
                provider: chosenRoute.provider || res.provider || 'google',
                departureTime: curT.departureTime || '',
                transitPreference: curT.transitPreference || 'DEFAULT',
                selectedRouteIndex: chosenIdx,
                cost: autoCost,
                originalCost: hasApiFare ? null : curT.originalCost,
                originalCurrency: hasApiFare ? '' : curT.originalCurrency || '',
              });
              batchMutated = true;
              return;
            }

            // 非 ok 結果：明確脫離 pending，避免永久卡在「查詢大眾運輸中...」
            if (curT.status === 'pending') {
              const nextStatus =
                res.status === 'unsupported'
                  ? 'unsupported'
                  : res.status === 'api_unconfigured' || res.status === 'japan_transit_requires_navitime'
                    ? 'manual'
                    : 'network_error';
              afterPin.transportToNext = {
                ...curT,
                status: nextStatus,
              };
              batchMutated = true;
            }
            return;
          }

          afterPin.transportToNext = {
            ...curT,
            status: res.status,
            provider: res.provider || curT.provider || 'osrm',
            distanceKm: res.status === 'ok' ? res.distanceKm : null,
            duration: res.status === 'ok' ? res.durationMin : null,
            encodedPolyline: res.status === 'ok' ? res.encodedPolyline || '' : '',
            fallbackNote: res.status === 'ok' ? res.fallbackNote || '' : '',
            cost: Math.max(0, Math.round(Number(curT.cost) || 0)),
          };
          batchMutated = true;
        })
      );

      if (batchMutated) {
        saveState(null, { markEdited: false, skipCloudSync: true });
        if (typeof onUpdated === 'function') onUpdated();
      }
    }
  } finally {
    resolveRunning = false;
    if (resolveQueuedOpts) {
      const next = resolveQueuedOpts;
      resolveQueuedOpts = null;
      void resolvePendingSegments(next);
    }
  }
}
