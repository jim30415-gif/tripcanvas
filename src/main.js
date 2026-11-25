import 'leaflet/dist/leaflet.css';
import '../styles/main.css';

import { DAY_COLORS } from './config/constants.js';
import {
  getState,
  getActiveTrip,
  saveState,
  hydrateFromIndexedDBIfNeeded,
  createNewTrip,
  serializeStateForExport,
  parseImportedState,
} from './state/store.js';
import { getActiveDay } from './state/selectors.js';
import { resolvePendingSegments } from './services/routeManager.js';
import { initDriveSync } from './services/driveSync.js';
import { reverseGeocode } from './services/geocoder.js';
import {
  initMap,
  getMapZoom,
  getOverlayGroup,
  invalidateMapSize,
  fitBoundsToPoints,
  isMapAnimatingZoom,
  onNextMapZoomEnd,
} from './map/mapInit.js';
import { renderDayPinsOnMap, wasPinRecentlyDragged } from './map/pinRenderer.js';
import { drawRouteSegmentOnMap } from './map/routeRenderer.js';
import { renderLeftPanel } from './ui/leftPanel.js';
import { renderRightPanel, closeDesktopExpenseSheet } from './ui/rightPanel.js';
import { openPinDetailModal, bindPinModalEvents } from './ui/pinModal.js';
import { openTransportModal, bindTransportModalEvents } from './ui/transportModal.js';
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
import { refreshIcons, uid } from './utils/format.js';

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

  if (btnLeft) {
    btnLeft.setAttribute('aria-expanded', String(!isLeftCollapsed));
    btnLeft.title = isLeftCollapsed ? '展開左側行程清單' : '收合左側行程清單';
  }
  if (iconLeft) {
    iconLeft.setAttribute('data-lucide', isLeftCollapsed ? 'chevron-right' : 'chevron-left');
  }

  if (btnRight) {
    btnRight.setAttribute('aria-expanded', String(!isRightCollapsed));
    btnRight.title = isRightCollapsed ? '展開右側天數圖層' : '收合右側天數圖層';
  }
  if (iconRight) {
    iconRight.setAttribute('data-lucide', isRightCollapsed ? 'chevron-left' : 'chevron-right');
  }

  const isFullscreenMap = isLeftCollapsed && isRightCollapsed;
  if (btnFs) {
    btnFs.setAttribute('aria-pressed', String(isFullscreenMap));
    btnFs.title = isFullscreenMap ? '還原左右側欄' : '全螢幕地圖（收合左右側欄）';
  }
  if (iconFs) {
    iconFs.setAttribute('data-lucide', isFullscreenMap ? 'minimize-2' : 'maximize-2');
  }

  refreshIcons();
  invalidateMapSize();
  setTimeout(() => invalidateMapSize(), 260);
}

function updateMapHeaderUI() {
  const state = getState();
  const day = getActiveDay(state);
  const activeTrip = getActiveTrip();
  if (!day) return;

  document.getElementById('map-active-day-dot').style.backgroundColor = day.color;
  document.getElementById('map-active-day-name').textContent = day.name;

  const tripBadge = document.getElementById('header-active-trip-badge');
  if (tripBadge && activeTrip) {
    tripBadge.textContent = activeTrip.name;
    tripBadge.title = `目前計畫：${activeTrip.name}（點左側選單切換或新增計畫）`;
  }
}

function movePinToCoordinate(dayId, pinId, lat, lng) {
  const state = getState();
  const day = state.days.find((d) => d.id === dayId);
  if (!day) return;
  const idx = day.pins.findIndex((p) => p.id === pinId);
  if (idx === -1) return;

  const pin = day.pins[idx];
  pin.lat = Number(lat.toFixed(6));
  pin.lng = Number(lng.toFixed(6));
  delete pin.placeId;

  // 將相連的自動路線標記為待重算，讓路徑自動貼合新座標（保留手動紀錄與交通支出）
  const invalidateAutoSegment = (seg) => {
    if (!seg || seg.status === 'manual') return;
    seg.encodedPolyline = '';
    seg.status = 'pending';
    if (seg.mode === 'transit') {
      seg.segments = [];
    }
  };
  if (idx > 0) invalidateAutoSegment(day.pins[idx - 1].transportToNext);
  if (idx < day.pins.length - 1) invalidateAutoSegment(pin.transportToNext);

  saveState((msg) => showToast(msg, 'error'));
  renderAll();
  triggerBackgroundResolve(true);
  showToast(`已調整「${pin.name}」地圖位置`, 'success');
}

let mapRenderDeferred = false;

function renderMapLayers() {
  const overlayGroup = getOverlayGroup();
  if (!overlayGroup) return;
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
        ? getMobileFitBoundsOptions({ splitOpen: true })
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

async function quickDeletePin(dayId, pinId) {
  const state = getState();
  const day = state.days.find((d) => d.id === dayId);
  const idx = day?.pins.findIndex((p) => p.id === pinId);
  if (!day || idx === -1) return;
  const target = day.pins[idx];

  const ok = await openCustomDialog({
    title: '刪除此景點標點？',
    message: `確定要從「${day.name}」移除「${target.name}」及其小景點紀錄嗎？`,
    confirmText: '確定刪除',
    danger: true,
  });
  if (!ok) return;

  const latestState = getState();
  const latestDay = latestState.days.find((d) => d.id === dayId);
  const latestIdx = latestDay?.pins.findIndex((p) => p.id === pinId);
  if (!latestDay || latestIdx === -1) return;

  const [removed] = latestDay.pins.splice(latestIdx, 1);
  // 移除節點後清除前一點原本連向已刪除節點的交通快取
  if (latestIdx > 0 && latestDay.pins[latestIdx - 1]) {
    latestDay.pins[latestIdx - 1].transportToNext = null;
  }
  saveState((msg) => showToast(msg, 'error'));
  renderAll();
  showToast(`已刪除景點「${removed.name}」`, 'info');
}

function renderLeft() {
  renderLeftPanel({
    onOpenPinDetail: (dayId, pinId) => openPinDetailModal(dayId, pinId),
    onOpenTransport: (dayId, pinIdx) => openTransportModal(dayId, pinIdx),
    onSelectDay: (dayId) => selectDayAndFocus(dayId),
    onAddDay: () => createAndAddNewDay(),
    onDeletePin: (dayId, pinId) => {
      void quickDeletePin(dayId, pinId);
    },
    onReorderPins: (dayId, fromIdx, toIdx) => {
      const state = getState();
      const day = state.days.find((d) => d.id === dayId);
      if (!day || fromIdx === toIdx) return;

      const [moved] = day.pins.splice(fromIdx, 1);
      day.pins.splice(toIdx, 0, moved);

      // 順序改變後，清除原有段對段路徑快取避免錯配
      day.pins.forEach((p) => {
        p.transportToNext = null;
      });

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
      renderMobileHud();
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
      ? getMobileFitBoundsOptions({ splitOpen: true })
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
    reverseGeocode(newPin.lat, newPin.lng, { zoom: getMapZoom() }).then((resolved) => {
      const niceName = typeof resolved === 'string' ? resolved : resolved?.name;
      const placeId = typeof resolved === 'object' ? resolved?.placeId || '' : '';
      const candidates = typeof resolved === 'object' && Array.isArray(resolved?.candidates) ? resolved.candidates : [];
      if (!niceName) return;
      const latestDay = getState().days.find((d) => d.id === activeDay.id);
      const pin = latestDay?.pins.find((p) => p.id === newPin.id);
      if (pin && pin.name.startsWith('自訂景點 ')) {
        pin.name = niceName;
        if (placeId) pin.placeId = placeId;
        if (candidates.length > 1) pin.nearbyCandidates = candidates;
        saveState((msg) => showToast(msg, 'error'));
        renderLeft();
        renderMapLayers();
      }
    });
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
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const { tripName, data } = parseImportedState(e.target.result);
      const fallbackName = file.name.replace(/\.json$/i, '') || '匯入的旅遊計畫';
      const created = createNewTrip(tripName || fallbackName, { initialData: data });
      renderAll();
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

  document.getElementById('btn-export-json')?.addEventListener('click', exportJSON);
  document.getElementById('btn-export-json-mobile')?.addEventListener('click', () => {
    closeTripsDrawer();
    exportJSON();
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
  bindPinModalEvents({ onStateChanged: renderAll });
  bindTransportModalEvents({ onStateChanged: renderAll });
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
  } finally {
    triggerBackgroundResolve(true);
  }
}

function boot() {
  if (window.innerWidth < 1024) {
    setMobileTab('map');
  }

  initMap({
    onMapClick: () => {
      if (wasPinRecentlyDragged()) return;
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
      addPinAtCoordinate(lat, lng);
    },
  });

  bindGlobalEvents();
  syncDesktopSidebarCollapseUI();
  renderAll();
  setTimeout(() => fitMapToVisiblePins(true), 380);
  refreshIcons();
  void hydratePersistedWorkspace();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
