import '../styles/main.css';

import { DAY_COLORS } from './config/constants.js';
import {
  getState,
  getActiveTrip,
  saveState,
  setGlobalQuotaErrorHandler,
  hydrateFromIndexedDBIfNeeded,
  createNewTrip,
  switchTrip,
  serializeStateForExport,
  parseImportedState,
} from './state/store.js';
import { getActiveDay } from './state/selectors.js';
import { resolvePendingSegments } from './services/routeManager.js';
import { initDriveSync } from './services/driveSync.js';
import { fetchPlaceDetailsById, reverseGeocode } from './services/geocoder.js';
import {
  initMap,
  getMapZoom,
  getOverlayGroup,
  invalidateMapSize,
  fitBoundsToPoints,
  isMapAnimatingZoom,
  onNextMapZoomEnd,
  showBasemapPoiPopover,
  hideBasemapPoiPopover,
} from './map/mapInit.js';
import { isPinRepositioning, renderDayPinsOnMap, wasPinRecentlyDragged } from './map/pinRenderer.js';
import { drawRouteSegmentOnMap } from './map/routeRenderer.js';
import { renderLeftPanel } from './ui/leftPanel.js';
import { renderRightPanel, closeDesktopExpenseSheet } from './ui/rightPanel.js';
import { openPinDetailModal, bindPinModalEvents } from './ui/pinModal.js';
import { openTransportModal, bindTransportModalEvents } from './ui/transportModal.js';
import { openExportModal, bindExportModalEvents } from './ui/exportModal.js';
import { bindSearchBarEvents } from './ui/searchBar.js';
import { bindTripsDrawerEvents, closeTripsDrawer, renderTripsDrawer } from './ui/tripsDrawer.js';
import { bindDriveSyncUI } from './ui/driveSyncUI.js';
import {
  setMobileTab,
  bindMobileNav,
  renderMobileHud,
  closeAllMobileOverlays,
  hasOpenMobileOverlay,
  getMobileFitBoundsOptions,
} from './ui/mobileNav.js';
import { openCustomDialog, showToast } from './ui/dialog.js';
import { bindGlobalImageFallback, refreshIcons, sanitizeHexColor, uid } from './utils/format.js';

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

let isLeftCollapsed = false;
let isRightCollapsed = false;

function getDesktopFitBoundsOptions(maxZoom = 15) {
  if (typeof window === 'undefined' || window.innerWidth < 1024) {
    return { padding: [70, 70], maxZoom };
  }
  const leftEl = document.getElementById('panel-left');
  const rightEl = document.getElementById('panel-right');
  const leftW = !isLeftCollapsed && leftEl ? leftEl.getBoundingClientRect().width : 0;
  const rightW = !isRightCollapsed && rightEl ? rightEl.getBoundingClientRect().width : 0;
  return {
    paddingTopLeft: [Math.round(leftW + 46), 72],
    paddingBottomRight: [Math.round(rightW + 46), 88],
    maxZoom,
  };
}

function syncDesktopSidebarCollapseUI() {
  const appMain = document.getElementById('app-main');
  const leftPanel = document.getElementById('panel-left');
  const rightPanel = document.getElementById('panel-right');
  const btnLeft = document.getElementById('btn-collapse-left');
  const btnRight = document.getElementById('btn-collapse-right');
  const iconLeft = document.getElementById('icon-collapse-left');
  const iconRight = document.getElementById('icon-collapse-right');
  const btnFs = document.getElementById('btn-toggle-map-fullscreen');
  const iconFs = document.getElementById('icon-map-fullscreen');

  appMain?.classList.toggle('desktop-left-collapsed', isLeftCollapsed);
  appMain?.classList.toggle('desktop-right-collapsed', isRightCollapsed);
  leftPanel?.classList.toggle('desktop-collapsed', isLeftCollapsed);
  rightPanel?.classList.toggle('desktop-collapsed', isRightCollapsed);

  const replaceLucideIcon = (el, nextName) => {
    if (!el || el.getAttribute('data-lucide') === nextName) return;
    el.setAttribute('data-lucide', nextName);
    el.removeAttribute('data-lucide-rendered');
    refreshIcons(el.parentElement || document);
  };

  if (btnLeft) {
    btnLeft.setAttribute('aria-expanded', String(!isLeftCollapsed));
    btnLeft.title = isLeftCollapsed ? '展開左側行程清單' : '收合左側行程清單';
  }
  replaceLucideIcon(iconLeft, isLeftCollapsed ? 'chevron-right' : 'chevron-left');

  if (btnRight) {
    btnRight.setAttribute('aria-expanded', String(!isRightCollapsed));
    btnRight.title = isRightCollapsed ? '展開右側天數圖層' : '收合右側天數圖層';
  }
  replaceLucideIcon(iconRight, isRightCollapsed ? 'chevron-left' : 'chevron-right');

  const isFullscreenMap = isLeftCollapsed && isRightCollapsed;
  if (btnFs) {
    btnFs.setAttribute('aria-pressed', String(isFullscreenMap));
    btnFs.title = isFullscreenMap ? '還原左右側欄' : '全螢幕地圖（收合左右側欄）';
  }
  replaceLucideIcon(iconFs, isFullscreenMap ? 'minimize-2' : 'maximize-2');

  invalidateMapSize();
  setTimeout(() => invalidateMapSize(), 260);
}

function updateMapHeaderUI() {
  const state = getState();
  const day = getActiveDay(state);
  const activeTrip = getActiveTrip();
  if (!day) return;

  document.getElementById('map-active-day-dot').style.backgroundColor = sanitizeHexColor(day.color);
  document.getElementById('map-active-day-name').textContent = day.name;

  const tripBadge = document.getElementById('header-active-trip-badge');
  if (tripBadge && activeTrip) {
    tripBadge.textContent = activeTrip.name;
    tripBadge.title = `目前計畫：${activeTrip.name}（點左側選單切換或新增計畫）`;
  }
}

const pinResolveSeq = new Map();
const pinResolveControllers = new Map();

function abortPinResolve(pinId) {
  const prevCtrl = pinResolveControllers.get(pinId);
  if (prevCtrl) {
    prevCtrl.abort();
    pinResolveControllers.delete(pinId);
  }
}

function invalidateAdjacentAutoRoutes(day, pinIdx) {
  const invalidateAutoSegment = (seg) => {
    if (!seg) return;
    if (seg.status === 'manual') {
      // 手動貼路公車在鄰近標點移動後需重新貼合新馬路，保留使用者填寫的路線名、時間與費用
      if (seg.mode === 'transit' && seg.roadSnapped) {
        seg.encodedPolyline = '';
      }
      return;
    }
    seg.encodedPolyline = '';
    seg.status = 'pending';
    if (seg.mode === 'transit') {
      seg.segments = [];
    }
  };
  if (pinIdx > 0) invalidateAutoSegment(day.pins[pinIdx - 1]?.transportToNext);
  if (pinIdx < day.pins.length - 1) invalidateAutoSegment(day.pins[pinIdx]?.transportToNext);
}

function resolvePinPlaceAndSnap(dayId, pinId, lat, lng, { isMove = false } = {}) {
  abortPinResolve(pinId);
  const seq = (pinResolveSeq.get(pinId) || 0) + 1;
  pinResolveSeq.set(pinId, seq);

  const ctrl = new AbortController();
  pinResolveControllers.set(pinId, ctrl);
  const targetTripId = getActiveTrip()?.id;

  reverseGeocode(lat, lng, { zoom: getMapZoom(), signal: ctrl.signal })
    .then((resolved) => {
      if (pinResolveControllers.get(pinId) === ctrl) {
        pinResolveControllers.delete(pinId);
      }
      if (pinResolveSeq.get(pinId) !== seq || getActiveTrip()?.id !== targetTripId) return;
      const niceName = typeof resolved === 'string' ? resolved : resolved?.name;
      if (!niceName) return;

      const placeId = typeof resolved === 'object' ? resolved?.placeId || '' : '';
      const countryCode = typeof resolved === 'object' ? resolved?.countryCode || '' : '';
      const candidates =
        typeof resolved === 'object' && Array.isArray(resolved?.candidates) ? resolved.candidates : [];
      const snapped = typeof resolved === 'object' && resolved?.snapped === true;
      const snapLat = typeof resolved === 'object' ? Number(resolved?.lat) : NaN;
      const snapLng = typeof resolved === 'object' ? Number(resolved?.lng) : NaN;

      const latestDay = getState().days.find((d) => d.id === dayId);
      const pinIdx = latestDay?.pins.findIndex((p) => p.id === pinId) ?? -1;
      if (!latestDay || pinIdx === -1) return;
      const pin = latestDay.pins[pinIdx];

      // 即使已自訂名稱，仍可補記尚未紀錄的國家代碼供後續搜尋排序參考
      if (countryCode && !pin.countryCode) {
        pin.countryCode = countryCode;
      }

      // 若使用者已手動自訂名稱，移動或異步解析皆不得覆蓋
      if (pin.nameCustomized === true) return;

      pin.name = niceName;
      if (placeId) pin.placeId = placeId;
      else delete pin.placeId;
      if (countryCode) pin.countryCode = countryCode;

      if (candidates.length > 1) pin.nearbyCandidates = candidates;
      else delete pin.nearbyCandidates;

      let didSnap = false;
      if (snapped && Number.isFinite(snapLat) && Number.isFinite(snapLng)) {
        const nextLat = Number(snapLat.toFixed(6));
        const nextLng = Number(snapLng.toFixed(6));
        if (Math.abs(pin.lat - nextLat) > 1e-6 || Math.abs(pin.lng - nextLng) > 1e-6) {
          pin.lat = nextLat;
          pin.lng = nextLng;
          invalidateAdjacentAutoRoutes(latestDay, pinIdx);
          didSnap = true;
        } else {
          didSnap = true;
        }
      }

      saveState((msg) => showToast(msg, 'error'));
      renderLeft();
      renderMapLayers();
      if (didSnap) {
        triggerBackgroundResolve(true);
      }

      if (isMove) {
        showToast(didSnap ? `已吸附至「${pin.name}」` : `已更新地標名稱為「${pin.name}」`, 'success');
      } else if (didSnap) {
        showToast(`已自動吸附至「${pin.name}」`, 'success');
      }
    })
    .catch((err) => {
      if (pinResolveControllers.get(pinId) === ctrl) {
        pinResolveControllers.delete(pinId);
      }
      if (err?.name !== 'AbortError') {
        console.warn('[TripCanvas] reverseGeocode error:', err);
      }
    });
}

function movePinToCoordinate(dayId, pinId, lat, lng) {
  mapRenderDeferredForDrag = false;
  const state = getState();
  const day = state.days.find((d) => d.id === dayId);
  if (!day) return;
  const idx = day.pins.findIndex((p) => p.id === pinId);
  if (idx === -1) return;

  const pin = day.pins[idx];
  pin.lat = Number(lat.toFixed(6));
  pin.lng = Number(lng.toFixed(6));
  delete pin.placeId;
  delete pin.nearbyCandidates;

  // 將相連的自動路線標記為待重算，讓路徑自動貼合新座標（保留手動紀錄與交通支出）
  invalidateAdjacentAutoRoutes(day, idx);

  saveState((msg) => showToast(msg, 'error'));
  renderAll();
  triggerBackgroundResolve(true);

  if (pin.nameCustomized === true) {
    // 已手動更改過名稱：取消任何尚未回傳的舊地標查詢，並保留使用者自訂名稱與精準落點
    abortPinResolve(pin.id);
    pinResolveSeq.set(pin.id, (pinResolveSeq.get(pin.id) || 0) + 1);
    showToast(`已調整「${pin.name}」地圖位置`, 'success');
    return;
  }

  // 尚未手動改名：依新落點重新辨識並吸附至鄰近地標，自動更新預設名稱
  showToast('已調整位置，更新地標名稱中…', 'info');
  resolvePinPlaceAndSnap(dayId, pin.id, pin.lat, pin.lng, { isMove: true });
}

let mapRenderDeferred = false;
let mapRenderDeferredForDrag = false;

function flushDeferredDragRender() {
  if (!mapRenderDeferredForDrag) return;
  queueMicrotask(() => {
    if (mapRenderDeferredForDrag && !isPinRepositioning()) {
      mapRenderDeferredForDrag = false;
      renderMapLayers();
    }
  });
}

function renderMapLayers() {
  const overlayGroup = getOverlayGroup();
  if (!overlayGroup) return;
  if (isPinRepositioning()) {
    mapRenderDeferredForDrag = true;
    return;
  }
  if (isMapAnimatingZoom()) {
    if (!mapRenderDeferred) {
      mapRenderDeferred = true;
      onNextMapZoomEnd(() => {
        mapRenderDeferred = false;
        renderMapLayers();
      });
    }
    return;
  }
  overlayGroup.clearLayers();

  const state = getState();
  const activeDayId = state.activeDayId;

  state.days.forEach((day) => {
    if (!day.visible) return;
    const isActive = day.id === activeDayId;

    // 1. 繪製貼合道路的陸路路徑與分段大眾運輸路徑
    day.pins.forEach((pin, idx) => {
      const nextPin = day.pins[idx + 1];
      if (!nextPin || !pin.transportToNext) return;
      drawRouteSegmentOnMap(overlayGroup, day, pin, nextPin, idx, isActive, (dId, pIdx) => {
        openTransportModal(dId, pIdx);
      });
    });

    // 2. 繪製該天數所有標點氣泡（支援長按拖曳微調地圖位置）
    renderDayPinsOnMap(
      overlayGroup,
      day,
      isActive,
      (dId, pinId) => {
        openPinDetailModal(dId, pinId);
      },
      (dId, pinId, nextLat, nextLng) => {
        movePinToCoordinate(dId, pinId, nextLat, nextLng);
      }
    );
  });
}

function selectDayAndFocus(dayId) {
  const state = getState();
  const chosen = state.days.find((d) => d.id === dayId);
  if (!chosen) return;

  state.activeDayId = chosen.id;
  saveState((msg) => showToast(msg, 'error'));
  renderAll();

  if (chosen.visible && chosen.pins.length > 0) {
    const opts =
      window.innerWidth < 1024 && hasOpenMobileOverlay()
        ? getMobileFitBoundsOptions({ daysPopupOpen: false })
        : getDesktopFitBoundsOptions(14);
    fitBoundsToPoints(
      chosen.pins.map((p) => [p.lat, p.lng]),
      opts
    );
  }
}

function createAndAddNewDay() {
  const state = getState();
  const nextNum = state.days.length + 1;
  const newDay = {
    id: uid('day'),
    name: `Day ${nextNum} · 新旅程`,
    color: DAY_COLORS[(nextNum - 1) % DAY_COLORS.length],
    visible: true,
    pins: [],
  };
  state.days.push(newDay);
  state.activeDayId = newDay.id;
  saveState((msg) => showToast(msg, 'error'));
  renderAll();
  showToast(`已新增「${newDay.name}」圖層`, 'success');
}

async function deletePinWithUndo(dayId, pinId) {
  const state = getState();
  const day = state.days.find((d) => d.id === dayId);
  const idx = day?.pins.findIndex((p) => p.id === pinId);
  if (!day || idx === -1) return false;
  const target = day.pins[idx];

  const ok = await openCustomDialog({
    title: '刪除此景點標點？',
    message: `確定要從「${day.name}」移除「${target.name}」及其小景點支出與相連路徑嗎？`,
    confirmText: '確定刪除',
    danger: true,
  });
  if (!ok) return false;

  const latestTripId = getActiveTrip()?.id;
  const latestState = getState();
  const latestDay = latestState.days.find((d) => d.id === dayId);
  const latestIdx = latestDay?.pins.findIndex((p) => p.id === pinId);
  if (!latestDay || latestIdx === -1) return false;

  abortPinResolve(pinId);
  const prevPin = latestIdx > 0 ? latestDay.pins[latestIdx - 1] : null;
  const prevPinId = prevPin?.id || null;
  const prevTransportBackup = prevPin?.transportToNext ? structuredClone(prevPin.transportToNext) : null;
  const [removed] = latestDay.pins.splice(latestIdx, 1);
  const removedSnapshot = structuredClone(removed);

  // 移除節點後清除前一點原本連向已刪除節點的交通快取
  if (prevPin) {
    prevPin.transportToNext = null;
  }
  saveState((msg) => showToast(msg, 'error'));
  renderAll();

  showToast(`已刪除景點「${removed.name}」`, 'info', {
    actionLabel: '復原',
    onAction: () => {
      if (getActiveTrip()?.id !== latestTripId) return;
      const curDay = getState().days.find((d) => d.id === dayId);
      if (!curDay || curDay.pins.some((p) => p.id === removedSnapshot.id)) return;
      const insertAt = Math.min(latestIdx, curDay.pins.length);
      curDay.pins.splice(insertAt, 0, removedSnapshot);
      if (prevPinId && insertAt > 0 && curDay.pins[insertAt - 1]?.id === prevPinId && prevTransportBackup) {
        curDay.pins[insertAt - 1].transportToNext = prevTransportBackup;
      }
      saveState((msg) => showToast(msg, 'error'));
      renderAll();
      showToast(`已復原景點「${removedSnapshot.name}」`, 'success');
    },
  });
  return true;
}

function renderLeft() {
  renderLeftPanel({
    onOpenPinDetail: (dayId, pinId) => openPinDetailModal(dayId, pinId),
    onOpenTransport: (dayId, pinIdx) => openTransportModal(dayId, pinIdx),
    onSelectDay: (dayId) => selectDayAndFocus(dayId),
    onAddDay: () => createAndAddNewDay(),
    onDeletePin: (dayId, pinId) => {
      void deletePinWithUndo(dayId, pinId);
    },
    onReorderPins: (dayId, fromIdx, toIdx) => {
      const state = getState();
      const day = state.days.find((d) => d.id === dayId);
      if (!day || fromIdx === toIdx) return;

      // 保留順序調整後仍維持相鄰的標點交通設定，僅清除受影響的新配對
      const prevTransportByPair = new Map();
      for (let i = 0; i < day.pins.length - 1; i++) {
        if (day.pins[i].transportToNext) {
          prevTransportByPair.set(`${day.pins[i].id}->${day.pins[i + 1].id}`, day.pins[i].transportToNext);
        }
      }

      const [moved] = day.pins.splice(fromIdx, 1);
      day.pins.splice(toIdx, 0, moved);

      for (let i = 0; i < day.pins.length; i++) {
        const nextPin = day.pins[i + 1];
        day.pins[i].transportToNext = nextPin
          ? prevTransportByPair.get(`${day.pins[i].id}->${nextPin.id}`) || null
          : null;
      }

      saveState((msg) => showToast(msg, 'error'));
      renderAll();
      showToast(`已調整標點順序：${moved.name}`, 'success');
    },
  });
}

function renderRight() {
  renderRightPanel({
    onStateChanged: () => renderAll(),
    onVisibilityChanged: () => {
      renderRight();
      renderMapLayers();
    },
    getFitBoundsOptions: (maxZoom) => getDesktopFitBoundsOptions(maxZoom),
  });
  renderMobileHud();
}

function renderAll() {
  updateMapHeaderUI();
  renderLeft();
  renderRight();
  renderMapLayers();
}

function triggerBackgroundResolve(retryNetworkErrors = false) {
  resolvePendingSegments({
    retryNetworkErrors,
    onUpdated: () => {
      renderLeft();
      renderRight();
      renderMapLayers();
    },
  });
}

function fitMapToVisiblePins(silentIfEmpty = false) {
  const state = getState();
  const pts = [];
  state.days.forEach((d) => {
    if (!d.visible) return;
    d.pins.forEach((p) => pts.push([p.lat, p.lng]));
  });
  if (pts.length === 0) {
    if (!silentIfEmpty) showToast('目前地圖上沒有可見的標點', 'info');
    return;
  }
  const opts =
    window.innerWidth < 1024 && hasOpenMobileOverlay()
      ? getMobileFitBoundsOptions({ daysPopupOpen: false })
      : getDesktopFitBoundsOptions(15);
  fitBoundsToPoints(pts, opts);
}

function addPinAtCoordinate(lat, lng, customName = null, meta = {}) {
  const state = getState();
  const activeDay = getActiveDay(state);
  if (!activeDay) return;

  if (!activeDay.visible) {
    activeDay.visible = true;
    showToast(`已自動開啟「${activeDay.name}」圖層顯示`, 'info');
  }

  const pinNum = activeDay.pins.length + 1;
  const newPin = {
    id: uid('pin'),
    name: customName || `自訂景點 ${pinNum}`,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    image: null,
    notes: '',
    subSpots: [],
    transportToNext: null,
  };
  if (meta?.placeId) newPin.placeId = meta.placeId;
  if (meta?.countryCode) newPin.countryCode = meta.countryCode;
  activeDay.pins.push(newPin);
  saveState((msg) => showToast(msg, 'error'));
  renderAll();
  showToast(`已於「${activeDay.name}」新增標點 #${pinNum}`, 'success');

  if (!customName) {
    resolvePinPlaceAndSnap(activeDay.id, newPin.id, newPin.lat, newPin.lng, { isMove: false });
  }
}

function exportJSON() {
  const activeTrip = getActiveTrip();
  const safeName = (activeTrip?.name || 'itinerary')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 32);
  const blob = new Blob([serializeStateForExport()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tripcanvas-${safeName}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('已匯出目前旅遊計畫 JSON 檔案', 'success');
}

function importJSON(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    showToast('匯入檔案超過 5 MB 上限，請確認為漫旅匯出的 JSON 檔', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => {
    showToast('讀取檔案失敗，請再試一次', 'error');
  };
  reader.onload = (e) => {
    try {
      const parsed = parseImportedState(e.target.result);
      if (parsed.isWorkspace && Array.isArray(parsed.workspace?.trips) && parsed.workspace.trips.length > 0) {
        let primaryCreatedId = null;
        const sourceActiveId = parsed.workspace.activeTripId;
        parsed.workspace.trips.forEach((trip, idx) => {
          const created = createNewTrip(trip.name || `匯入計畫 ${idx + 1}`, { initialData: trip.data });
          if (trip.id === sourceActiveId || primaryCreatedId === null) {
            primaryCreatedId = created.id;
          }
        });
        if (primaryCreatedId) switchTrip(primaryCreatedId);
        renderAll();
        renderTripsDrawer();
        triggerBackgroundResolve(true);
        fitMapToVisiblePins(true);
        showToast(`已從完整備份檔匯入 ${parsed.workspace.trips.length} 個旅遊計畫（原計畫皆已保留）`, 'success');
        return;
      }

      const fallbackName = file.name.replace(/\.json$/i, '') || '匯入的旅遊計畫';
      const created = createNewTrip(parsed.tripName || fallbackName, { initialData: parsed.data });
      renderAll();
      renderTripsDrawer();
      triggerBackgroundResolve(true);
      fitMapToVisiblePins(true);
      showToast(`已匯入為新旅遊計畫「${created.name}」（原計畫皆已保留）`, 'success');
    } catch {
      showToast('匯入失敗：請確認選擇正確的 JSON 行程檔', 'error');
    }
  };
  reader.readAsText(file);
}

function bindGlobalEvents() {
  document.getElementById('btn-fit-bounds')?.addEventListener('click', () => fitMapToVisiblePins(false));
  document.getElementById('btn-add-day')?.addEventListener('click', createAndAddNewDay);

  // 電腦版左右欄獨立收合／展開箭頭 ＋ 全螢幕地圖切換
  document.getElementById('btn-collapse-left')?.addEventListener('click', () => {
    isLeftCollapsed = !isLeftCollapsed;
    syncDesktopSidebarCollapseUI();
  });
  document.getElementById('btn-collapse-right')?.addEventListener('click', () => {
    isRightCollapsed = !isRightCollapsed;
    syncDesktopSidebarCollapseUI();
  });
  document.getElementById('btn-toggle-map-fullscreen')?.addEventListener('click', () => {
    const enterFullscreen = !(isLeftCollapsed && isRightCollapsed);
    isLeftCollapsed = enterFullscreen;
    isRightCollapsed = enterFullscreen;
    syncDesktopSidebarCollapseUI();
  });

  document.getElementById('btn-export-json')?.addEventListener('click', openExportModal);
  document.getElementById('btn-export-json-mobile')?.addEventListener('click', () => {
    closeTripsDrawer();
    openExportModal();
  });

  const handleImportChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      closeTripsDrawer();
      importJSON(file);
    }
    e.target.value = '';
  };
  document.getElementById('input-import-json')?.addEventListener('change', handleImportChange);
  document.getElementById('input-import-json-mobile')?.addEventListener('change', handleImportChange);

  bindTripsDrawerEvents({
    onTripSwitched: (shouldRefit) => {
      renderAll();
      if (shouldRefit) {
        triggerBackgroundResolve(true);
        fitMapToVisiblePins(true);
      }
    },
  });

  bindSearchBarEvents({ onAddPinAtCoordinate: addPinAtCoordinate });
  bindPinModalEvents({
    onStateChanged: () => {
      renderAll();
      triggerBackgroundResolve(false);
    },
    onDeletePin: (dayId, pinId) => deletePinWithUndo(dayId, pinId),
  });
  bindTransportModalEvents({ onStateChanged: renderAll });
  bindExportModalEvents({ onExportJson: exportJSON });
  bindDriveSyncUI();
  bindMobileNav({
    onStateChanged: renderAll,
    onVisibilityChanged: () => {
      renderRight();
      renderMapLayers();
    },
    onAddDay: createAndAddNewDay,
  });

  window.addEventListener('resize', () => invalidateMapSize());
  window.addEventListener('pointerup', flushDeferredDragRender, { capture: true });
  window.addEventListener('pointercancel', flushDeferredDragRender, { capture: true });
  window.addEventListener('blur', flushDeferredDragRender);
}

async function hydratePersistedWorkspace() {
  try {
    const restoredFromIdb = await hydrateFromIndexedDBIfNeeded();
    if (restoredFromIdb) {
      renderAll();
      renderTripsDrawer();
      fitMapToVisiblePins(true);
    }

    await initDriveSync({
      onWorkspaceUpdated: (shouldRefit) => {
        renderAll();
        renderTripsDrawer();
        if (shouldRefit) {
          triggerBackgroundResolve(true);
          fitMapToVisiblePins(true);
        }
      },
      onToast: (msg, type) => showToast(msg, type),
    });
  } catch (err) {
    console.warn('[TripCanvas] hydratePersistedWorkspace warning:', err);
  } finally {
    triggerBackgroundResolve(true);
  }
}

let basemapPoiSeq = 0;
let basemapPoiAbortCtrl = null;

function cancelBasemapPoiLookup() {
  basemapPoiSeq++;
  if (basemapPoiAbortCtrl) {
    basemapPoiAbortCtrl.abort();
    basemapPoiAbortCtrl = null;
  }
}

async function handleBasemapPoiClick({ placeId, lat, lng }) {
  if (wasPinRecentlyDragged()) return;
  if (window.innerWidth < 1024 && hasOpenMobileOverlay()) {
    closeAllMobileOverlays();
    return;
  }
  closeDesktopExpenseSheet();

  cancelBasemapPoiLookup();
  const seq = basemapPoiSeq;
  const ctrl = new AbortController();
  basemapPoiAbortCtrl = ctrl;

  showBasemapPoiPopover({
    lat,
    lng,
    loading: true,
    onClose: () => {
      if (basemapPoiSeq === seq) {
        cancelBasemapPoiLookup();
      }
    },
  });

  try {
    const place = await fetchPlaceDetailsById(placeId, { signal: ctrl.signal });
    if (basemapPoiSeq !== seq || ctrl.signal.aborted) return;

    if (place?.name) {
      const finalLat = Number.isFinite(place.lat) ? place.lat : lat;
      const finalLng = Number.isFinite(place.lng) ? place.lng : lng;
      showBasemapPoiPopover({
        lat: finalLat,
        lng: finalLng,
        name: place.name,
        address: place.address || '',
        categoryLabel: place.categoryLabel || '',
        onAdd: () => {
          hideBasemapPoiPopover();
          addPinAtCoordinate(finalLat, finalLng, place.name, {
            placeId: place.placeId || placeId,
            countryCode: place.countryCode || '',
          });
        },
        onClose: () => {
          if (basemapPoiSeq === seq) cancelBasemapPoiLookup();
        },
      });
      return;
    }

    // 若 Places 詳情暫時查無資料，仍提供備援辨識與加入按鈕不卡死
    const fallback = await reverseGeocode(lat, lng, { zoom: getMapZoom(), signal: ctrl.signal });
    if (basemapPoiSeq !== seq || ctrl.signal.aborted) return;
    const fallbackName = (typeof fallback === 'string' ? fallback : fallback?.name) || 'Google 地圖標點';
    const fallbackCountry = typeof fallback === 'object' ? fallback?.countryCode || '' : '';
    showBasemapPoiPopover({
      lat,
      lng,
      name: fallbackName,
      address: '可先加入行程，點擊標點即可微調名稱與座標',
      onAdd: () => {
        hideBasemapPoiPopover();
        addPinAtCoordinate(lat, lng, fallbackName, { placeId, countryCode: fallbackCountry });
      },
      onClose: () => {
        if (basemapPoiSeq === seq) cancelBasemapPoiLookup();
      },
    });
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.warn('[TripCanvas] handleBasemapPoiClick error:', err);
    }
  } finally {
    if (basemapPoiAbortCtrl === ctrl) {
      basemapPoiAbortCtrl = null;
    }
  }
}

function bindGlobalErrorHandlers() {
  window.addEventListener('error', (event) => {
    console.error('[TripCanvas] Uncaught error:', event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason?.name === 'AbortError') return;
    console.error('[TripCanvas] Unhandled rejection:', event.reason);
  });
}

async function boot() {
  try {
    bindGlobalErrorHandlers();
    bindGlobalImageFallback();
    setGlobalQuotaErrorHandler((msg) => showToast(msg, 'error'));

    if (window.innerWidth < 1024) {
      setMobileTab('map');
    }

    bindGlobalEvents();
    syncDesktopSidebarCollapseUI();
    updateMapHeaderUI();
    renderLeft();
    renderRight();
    refreshIcons();

    await initMap({
      onMapClick: () => {
        if (wasPinRecentlyDragged()) return;
        hideBasemapPoiPopover();
        // 單點地圖空處永不誤加標點：僅優先收合展開中的手機浮動面板或桌機支出明細
        if (window.innerWidth < 1024 && hasOpenMobileOverlay()) {
          closeAllMobileOverlays();
          return;
        }
        closeDesktopExpenseSheet();
      },
      onMapRightClick: (lat, lng) => {
        // 電腦統一右鍵新增、手機統一長按地圖空處新增
        if (wasPinRecentlyDragged()) return;
        if (window.innerWidth < 1024 && hasOpenMobileOverlay()) return;
        hideBasemapPoiPopover();
        addPinAtCoordinate(lat, lng);
      },
      onBasemapPoiClick: (poi) => {
        void handleBasemapPoiClick(poi);
      },
      onEngineChanged: (_nextEngine, reason) => {
        renderMapLayers();
        setTimeout(() => fitMapToVisiblePins(true), 240);
        if (reason === 'GOOGLE_MAPS_AUTH_FAILURE') {
          showToast('Google 地圖載入受限，已自動切換為備援底圖', 'error');
        }
      },
    });

    renderMapLayers();
    setTimeout(() => fitMapToVisiblePins(true), 280);
    void hydratePersistedWorkspace();
  } catch (err) {
    console.error('[TripCanvas] Boot failure:', err);
    showToast('載入頁面時發生異常，請重新整理再試', 'error');
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    void boot();
  });
} else {
  void boot();
}
