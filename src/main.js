import 'leaflet/dist/leaflet.css';
import '../styles/main.css';

import { DAY_COLORS } from './config/constants.js';
import {
  getState,
  getActiveTrip,
  getWorkspace,
  saveState,
  hydrateFromIndexedDBIfNeeded,
  createNewTrip,
  resetStateToDemo,
  serializeStateForExport,
  parseImportedState,
} from './state/store.js';
import { getActiveDay } from './state/selectors.js';
import { resolvePendingSegments } from './services/routeManager.js';
import { initDriveSync } from './services/driveSync.js';
import { reverseGeocode } from './services/geocoder.js';
import {
  initMap,
  getOverlayGroup,
  invalidateMapSize,
  fitBoundsToPoints,
} from './map/mapInit.js';
import { renderDayPinsOnMap, wasPinRecentlyDragged } from './map/pinRenderer.js';
import { drawRouteSegmentOnMap } from './map/routeRenderer.js';
import { renderLeftPanel } from './ui/leftPanel.js';
import { renderRightPanel } from './ui/rightPanel.js';
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

  const mapSection = document.getElementById('panel-map');
  const addBtn = document.getElementById('btn-toggle-add-mode');
  const addLabel = document.getElementById('add-mode-label');

  if (state.addMode) {
    mapSection.classList.add('map-add-mode');
    addBtn.className =
      'order-2 ml-auto md:ml-0 md:order-none bg-owl-primary hover:bg-owl-primaryHover text-white rounded-xl px-3 py-2 md:py-1.5 text-xs font-bold flex items-center gap-1.5 shadow-xs transition active:scale-95 shrink-0';
    addLabel.textContent = '標點模式：開';
  } else {
    mapSection.classList.remove('map-add-mode');
    addBtn.className =
      'order-2 ml-auto md:ml-0 md:order-none bg-owl-softBg hover:bg-owl-border/70 text-owl-primaryDeep border border-owl-border rounded-xl px-3 py-2 md:py-1.5 text-xs font-bold flex items-center gap-1.5 transition active:scale-95 shrink-0';
    addLabel.textContent = '標點模式：關';
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

function renderMapLayers() {
  const overlayGroup = getOverlayGroup();
  if (!overlayGroup) return;
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

    // 2. 繪製標點氣泡（短按開詳細設定、長按拖曳調整地圖位置）
    renderDayPinsOnMap(
      overlayGroup,
      day,
      isActive,
      (dId, pId) => {
        if (state.activeDayId !== dId) {
          state.activeDayId = dId;
          const edited = !getWorkspace().isPristineDemo;
          saveState(null, { markEdited: edited, skipCloudSync: !edited });
          renderLeft();
          renderRight();
          updateMapHeaderUI();
        }
        openPinDetailModal(dId, pId);
      },
      movePinToCoordinate
    );
  });
}

function reorderPins(dayId, fromIdx, toIdx) {
  const state = getState();
  const day = state.days.find((d) => d.id === dayId);
  if (!day) return;

  // 僅保留仍維持原本相鄰配對的路段，其餘清空待使用者重新設定
  const existingSegments = new Map();
  for (let i = 0; i < day.pins.length - 1; i++) {
    if (day.pins[i].transportToNext) {
      existingSegments.set(`${day.pins[i].id}->${day.pins[i + 1].id}`, day.pins[i].transportToNext);
    }
  }

  const [moved] = day.pins.splice(fromIdx, 1);
  day.pins.splice(toIdx, 0, moved);

  for (let i = 0; i < day.pins.length; i++) {
    if (i === day.pins.length - 1) {
      day.pins[i].transportToNext = null;
    } else {
      const pairKey = `${day.pins[i].id}->${day.pins[i + 1].id}`;
      day.pins[i].transportToNext = existingSegments.get(pairKey) || null;
    }
  }

  saveState((msg) => showToast(msg, 'error'));
  renderAll();
  triggerBackgroundResolve();
  showToast(`已調整標點順序：${moved.name}`, 'success');
}

function renderLeft() {
  renderLeftPanel({
    onOpenPinDetail: openPinDetailModal,
    onOpenTransport: openTransportModal,
    onReorderPins: reorderPins,
  });
}

function renderRight() {
  renderRightPanel({
    onStateChanged: renderAll,
    onVisibilityChanged: () => {
      renderRight();
      renderMapLayers();
    },
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
      : { padding: [70, 70], maxZoom: 15 };
  fitBoundsToPoints(pts, opts);
}

function addPinAtCoordinate(lat, lng, customName = null) {
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
  activeDay.pins.push(newPin);
  saveState((msg) => showToast(msg, 'error'));
  renderAll();
  showToast(`已於「${activeDay.name}」新增標點 #${pinNum}`, 'success');

  if (!customName) {
    reverseGeocode(newPin.lat, newPin.lng).then((niceName) => {
      if (!niceName) return;
      const latestDay = getState().days.find((d) => d.id === activeDay.id);
      const pin = latestDay?.pins.find((p) => p.id === newPin.id);
      if (pin && pin.name.startsWith('自訂景點 ')) {
        pin.name = niceName;
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
      if (window.innerWidth < 1024) {
        getState().addMode = false;
      }
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

async function promptRestoreDemo() {
  const activeTrip = getActiveTrip();
  const ok = await openCustomDialog({
    title: '重置目前計畫為台北 2 日示範？',
    message: `將把目前計畫「${activeTrip?.name || ''}」重設為台北 2 日示範行程（其他旅遊計畫不受影響）。`,
    confirmText: '確認重置',
  });
  if (ok) {
    resetStateToDemo();
    if (window.innerWidth < 1024) {
      getState().addMode = false;
    }
    renderAll();
    triggerBackgroundResolve(true);
    fitMapToVisiblePins(true);
    showToast('已重置目前計畫為台北 2 日示範行程', 'success');
  }
}

function bindGlobalEvents() {
  document.getElementById('btn-toggle-add-mode').addEventListener('click', () => {
    const state = getState();
    state.addMode = !state.addMode;
    saveState((msg) => showToast(msg, 'error'));
    updateMapHeaderUI();
    const isMobile = window.innerWidth < 1024;
    showToast(
      state.addMode
        ? '標點模式已開啟：點擊地圖即可新增標點'
        : isMobile
          ? '已切換為瀏覽模式（可長按地圖空處或使用搜尋新增標點）'
          : '標點模式已關閉（仍可右鍵新增）',
      'info'
    );
  });

  document.getElementById('btn-fit-bounds').addEventListener('click', () => fitMapToVisiblePins(false));

  const createAndAddNewDay = () => {
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
  };

  document.getElementById('btn-add-day').addEventListener('click', createAndAddNewDay);

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

  document.getElementById('btn-restore-demo')?.addEventListener('click', promptRestoreDemo);
  document.getElementById('btn-restore-demo-mobile')?.addEventListener('click', () => {
    closeTripsDrawer();
    promptRestoreDemo();
  });

  bindTripsDrawerEvents({
    onTripSwitched: (shouldRefit) => {
      if (window.innerWidth < 1024) {
        getState().addMode = false;
      }
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
      if (window.innerWidth < 1024) {
        getState().addMode = false;
      }
      renderAll();
      renderTripsDrawer();
      fitMapToVisiblePins(true);
    }

    await initDriveSync({
      onWorkspaceUpdated: (shouldRefit) => {
        if (window.innerWidth < 1024) {
          getState().addMode = false;
        }
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
    // 手機端預設進入瀏覽模式，避免滑動／點擊地圖時誤觸新增標點
    getState().addMode = false;
    setMobileTab('map');
  }

  initMap({
    onMapClick: (lat, lng) => {
      if (wasPinRecentlyDragged()) return;
      // 手機版若有浮動面板開啟，點擊露出的地圖空處優先收合面板並攔截誤加標點
      if (window.innerWidth < 1024 && hasOpenMobileOverlay()) {
        closeAllMobileOverlays();
        return;
      }
      if (!getState().addMode) return;
      addPinAtCoordinate(lat, lng);
    },
    onMapRightClick: (lat, lng) => {
      if (wasPinRecentlyDragged()) return;
      if (window.innerWidth < 1024 && hasOpenMobileOverlay()) return;
      addPinAtCoordinate(lat, lng);
    },
  });

  bindGlobalEvents();
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
