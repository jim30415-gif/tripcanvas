const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 天

function parseTs(iso) {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function getWorkspaceLatestTs(ws) {
  if (!ws) return 0;
  let maxTs = parseTs(ws.updatedAt);
  if (Array.isArray(ws.trips)) {
    for (const trip of ws.trips) {
      maxTs = Math.max(maxTs, parseTs(trip?.updatedAt));
    }
  }
  if (ws.deletedTripIds && typeof ws.deletedTripIds === 'object') {
    for (const delIso of Object.values(ws.deletedTripIds)) {
      maxTs = Math.max(maxTs, parseTs(delIso));
    }
  }
  return maxTs;
}

/**
 * 判斷某筆旅遊計畫是否為尚未改動過的預設「台北 2 日示範行程」，
 * 避免跨裝置合併時出現兩份一模一樣的預設示範行程。
 */
export function isUntouchedDemoTrip(trip) {
  if (!trip || trip.name !== '台北 2 日示範行程') return false;
  const days = trip.data?.days;
  if (!Array.isArray(days) || days.length !== 2) return false;
  if (days[0]?.id !== 'day_1' || days[1]?.id !== 'day_2') return false;
  const d1Pins = Array.isArray(days[0]?.pins) ? days[0].pins : [];
  const d2Pins = Array.isArray(days[1]?.pins) ? days[1].pins : [];
  if (d1Pins.length !== 4 || d2Pins.length !== 3) return false;
  return (
    d1Pins[0]?.id === 'p_d1_1' &&
    d1Pins[3]?.id === 'p_d1_4' &&
    d2Pins[0]?.id === 'p_d2_1' &&
    d2Pins[2]?.id === 'p_d2_3'
  );
}

function mergeDeletedTripIds(localDeleted = {}, cloudDeleted = {}, nowMs = Date.now()) {
  const merged = {};
  const keys = new Set([...Object.keys(localDeleted || {}), ...Object.keys(cloudDeleted || {})]);
  for (const id of keys) {
    const tLocal = parseTs(localDeleted?.[id]);
    const tCloud = parseTs(cloudDeleted?.[id]);
    const best = Math.max(tLocal, tCloud);
    if (best > 0 && nowMs - best <= TOMBSTONE_TTL_MS) {
      merged[id] = new Date(best).toISOString();
    }
  }
  return merged;
}

function tripsSignature(ws) {
  if (!ws || !Array.isArray(ws.trips)) return '';
  return JSON.stringify({
    activeTripId: ws.activeTripId,
    deletedTripIds: ws.deletedTripIds || {},
    trips: ws.trips,
  });
}

/**
 * 安全合併本機與 Google Drive 雲端工作區：
 * - 空白／未編輯過的預設示範瀏覽器「絕對不會」覆蓋雲端既有行程
 * - 兩邊都有各自建立的新計畫時，自動合併保留雙方計畫（依 trip.id 與 updatedAt 比對）
 * - 透過 deletedTripIds 尊重使用者在另一裝置明確刪除的計畫
 */
export function mergeWorkspaces(localWs, cloudWs, { nowMs = Date.now() } = {}) {
  // 情況 1：雲端還沒有檔案 → 準備上傳本機工作區
  if (!cloudWs || !Array.isArray(cloudWs.trips) || cloudWs.trips.length === 0) {
    return {
      action: 'push_local',
      workspace: {
        ...localWs,
        isPristineDemo: false,
        updatedAt: localWs?.updatedAt || new Date(nowMs).toISOString(),
      },
    };
  }

  // 情況 2：本機只是全新未改動的預設示範行程 → 無條件採用雲端資料（防覆蓋保護）
  if (localWs?.isPristineDemo) {
    return {
      action: 'use_cloud',
      workspace: {
        ...cloudWs,
        isPristineDemo: false,
      },
    };
  }

  // 情況 3：本機與雲端皆有編輯紀錄 → 依 trip.id + updatedAt + deletedTripIds 雙向無損合併
  const deletedTripIds = mergeDeletedTripIds(localWs?.deletedTripIds, cloudWs?.deletedTripIds, nowMs);

  const cloudById = new Map();
  for (const t of cloudWs.trips) {
    if (t?.id) cloudById.set(t.id, t);
  }
  const localById = new Map();
  for (const t of localWs?.trips || []) {
    if (t?.id) localById.set(t.id, t);
  }

  const mergedList = [];
  const addedIds = new Set();

  // 3a. 先納入雲端既有順序中的有效計畫（若同 id 本機較新則採用本機版本）
  for (const cTrip of cloudWs.trips) {
    if (!cTrip?.id) continue;
    const delTs = parseTs(deletedTripIds[cTrip.id]);
    const lTrip = localById.get(cTrip.id);
    const bestTrip = lTrip && parseTs(lTrip.updatedAt) > parseTs(cTrip.updatedAt) ? lTrip : cTrip;
    if (delTs > parseTs(bestTrip.updatedAt)) continue;
    mergedList.push(bestTrip);
    addedIds.add(bestTrip.id);
  }

  // 3b. 再納入「只有本機才有」的新計畫（排除重複的未修改示範行程）
  const localOnlyTrips = [];
  for (const lTrip of localWs?.trips || []) {
    if (!lTrip?.id || addedIds.has(lTrip.id)) continue;
    const delTs = parseTs(deletedTripIds[lTrip.id]);
    if (delTs > parseTs(lTrip.updatedAt)) continue;
    if (mergedList.length > 0 && isUntouchedDemoTrip(lTrip)) continue;
    localOnlyTrips.push(lTrip);
    addedIds.add(lTrip.id);
  }

  const finalTrips = [...localOnlyTrips, ...mergedList];
  if (finalTrips.length === 0) {
    const fallbackTrip = cloudWs.trips[0];
    finalTrips.push(fallbackTrip);
    if (fallbackTrip?.id && deletedTripIds[fallbackTrip.id]) {
      delete deletedTripIds[fallbackTrip.id];
    }
  }

  const localLatest = getWorkspaceLatestTs(localWs);
  const cloudLatest = getWorkspaceLatestTs(cloudWs);
  const preferredActiveId = localLatest > cloudLatest ? localWs?.activeTripId : cloudWs?.activeTripId;
  const activeTripId = finalTrips.some((t) => t.id === preferredActiveId)
    ? preferredActiveId
    : finalTrips[0].id;

  const mergedWorkspace = {
    version: 5,
    activeTripId,
    updatedAt: new Date(Math.max(localLatest, cloudLatest, nowMs)).toISOString(),
    isPristineDemo: false,
    deletedTripIds,
    trips: finalTrips,
  };

  const mergedSig = tripsSignature(mergedWorkspace);
  const cloudSig = tripsSignature(cloudWs);
  const localSig = tripsSignature(localWs);

  if (mergedSig === cloudSig && mergedSig === localSig) {
    return { action: 'in_sync', workspace: mergedWorkspace };
  }
  if (mergedSig === cloudSig) {
    return { action: 'use_cloud', workspace: mergedWorkspace };
  }
  if (mergedSig === localSig) {
    return { action: 'push_local', workspace: mergedWorkspace };
  }
  return { action: 'merged_push', workspace: mergedWorkspace };
}
