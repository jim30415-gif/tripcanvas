import { SILENT_TILE_SOURCES } from '../config/constants.js';
import {
  createGoogleOverlayGroup,
  createGoogleProjectionHelper,
  loadGoogleMapsSdk,
  mountBasemapPoiCard,
  resolveGoogleMapsJsKey,
} from './googleEngine.js';
import { isPinRepositioning } from './pinRenderer.js';

let leafletLib = null;
let leafletLoadPromise = null;
let activeEngine = 'leaflet'; // 'google' | 'leaflet'
let mapInstance = null; // Leaflet Map or google.maps.Map
let overlayGroup = null;
let activeBaseLayer = null;
let searchMarker = null;
let userLocationLayers = [];
let resizeObserver = null;
let googleProjection = null;
let basemapPoiOverlay = null;
let activeBasemapPoiOnClose = null;
let pendingFitBoundsIdleListener = null;
let invalidateRafId = null;
let fallbackInProgress = false;
let mapCallbacks = {};
let zoomControlsBound = false;

let tileRuntime = {
  sourceIndex: 0,
  tileSuccessCount: 0,
  tileErrorCount: 0,
  switched: false,
  token: 0,
};

async function ensureLeaflet() {
  if (leafletLib) return leafletLib;
  if (!leafletLoadPromise) {
    leafletLoadPromise = Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')])
      .then(([mod]) => {
        leafletLib = mod.default || mod;
        return leafletLib;
      })
      .catch((err) => {
        leafletLoadPromise = null;
        throw err;
      });
  }
  return leafletLoadPromise;
}

export function getLeafletLib() {
  return leafletLib;
}

function clearPendingFitBoundsIdle() {
  if (pendingFitBoundsIdleListener) {
    try {
      window.google?.maps?.event?.removeListener?.(pendingFitBoundsIdleListener);
    } catch {
      // ignore
    }
    pendingFitBoundsIdleListener = null;
  }
}

function createOfflineCanvasGridLayer(L, options) {
  const OfflineGridLayer = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      const ctx = tile.getContext('2d');

      ctx.fillStyle = '#F5EFE6';
      ctx.fillRect(0, 0, size.x, size.y);

      ctx.strokeStyle = '#E5DACB';
      ctx.lineWidth = 1;
      for (let i = 0; i < size.x; i += 64) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, size.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(size.x, i);
        ctx.stroke();
      }
      ctx.strokeStyle = '#D7C5B2';
      ctx.strokeRect(0, 0, size.x, size.y);

      const n = Math.pow(2, coords.z);
      const lng = ((coords.x / n) * 360 - 180).toFixed(2);
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * coords.y) / n)));
      const lat = ((latRad * 180) / Math.PI).toFixed(2);

      ctx.fillStyle = '#9E8C7A';
      ctx.font = '600 11px "Noto Sans TC", sans-serif';
      ctx.fillText(`Z${coords.z} · ${lat}°N, ${lng}°E`, 10, 18);
      return tile;
    },
  });
  return new OfflineGridLayer(options);
}

function mountTileSourceSilently(sourceIndex) {
  const L = leafletLib;
  if (activeEngine !== 'leaflet' || !mapInstance || !L) return;
  if (mapInstance._animatingZoom) {
    mapInstance.once('zoomend', () => mountTileSourceSilently(sourceIndex));
    return;
  }

  let resolvedIndex = sourceIndex;
  const candidate = SILENT_TILE_SOURCES[resolvedIndex] || SILENT_TILE_SOURCES[SILENT_TILE_SOURCES.length - 1];
  if (candidate.type !== 'canvas' && typeof navigator !== 'undefined' && navigator.onLine === false) {
    resolvedIndex = SILENT_TILE_SOURCES.length - 1;
  }
  const source = SILENT_TILE_SOURCES[resolvedIndex] || SILENT_TILE_SOURCES[SILENT_TILE_SOURCES.length - 1];

  if (activeBaseLayer) {
    activeBaseLayer.off('tileload tileerror');
    mapInstance.removeLayer(activeBaseLayer);
    activeBaseLayer = null;
  }

  const token = ++tileRuntime.token;
  tileRuntime = {
    sourceIndex: resolvedIndex,
    tileSuccessCount: 0,
    tileErrorCount: 0,
    switched: false,
    token,
  };

  if (source.type === 'canvas') {
    activeBaseLayer = createOfflineCanvasGridLayer(L, source.options);
    activeBaseLayer.addTo(mapInstance);
    return;
  }

  const size = mapInstance.getSize?.();
  const viewportTiles = size ? Math.ceil(size.x / 256) * Math.ceil(size.y / 256) : 6;
  const errorThreshold = Math.min(8, Math.max(4, viewportTiles - 1));

  activeBaseLayer = L.tileLayer(source.url, { ...source.options });

  activeBaseLayer.on('tileload', () => {
    if (tileRuntime.token !== token) return;
    tileRuntime.tileSuccessCount++;
  });

  activeBaseLayer.on('tileerror', () => {
    if (tileRuntime.token !== token) return;
    tileRuntime.tileErrorCount++;
    if (
      tileRuntime.tileErrorCount >= errorThreshold &&
      tileRuntime.tileSuccessCount === 0 &&
      !tileRuntime.switched &&
      resolvedIndex + 1 < SILENT_TILE_SOURCES.length
    ) {
      tileRuntime.switched = true;
      // 延後至下一個事件循環再切換底圖，避免在 Leaflet _updateLevels() 同步清除瓦片期間觸發 removeLayer 導致 _map 為 null
      setTimeout(() => {
        if (tileRuntime.token === token) {
          mountTileSourceSilently(resolvedIndex + 1);
        }
      }, 60);
    }
  });

  activeBaseLayer.addTo(mapInstance);
}

function syncEngineZoomControlsUI() {
  const panelMap = document.getElementById('panel-map');
  const gZoomWrap = document.getElementById('google-zoom-controls');
  const isGoogle = activeEngine === 'google';
  panelMap?.classList.toggle('map-engine-google', isGoogle);
  gZoomWrap?.classList.toggle('hidden', !isGoogle);

  if (!zoomControlsBound) {
    zoomControlsBound = true;
    document.getElementById('btn-gmap-zoom-in')?.addEventListener('click', () => {
      if (activeEngine === 'google' && mapInstance) {
        const curZoom = mapInstance.getZoom();
        const baseZoom = Number.isFinite(curZoom) ? curZoom : 13;
        mapInstance.setZoom(baseZoom + 1);
      }
    });
    document.getElementById('btn-gmap-zoom-out')?.addEventListener('click', () => {
      if (activeEngine === 'google' && mapInstance) {
        const curZoom = mapInstance.getZoom();
        const baseZoom = Number.isFinite(curZoom) ? curZoom : 13;
        mapInstance.setZoom(Math.max(2, baseZoom - 1));
      }
    });
  }
}

let activeDomCleanup = null;

function isInteractiveMapTarget(target) {
  const el = target instanceof Element ? target : target?.parentElement;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(
    el.closest('.custom-pin-icon') ||
      el.closest('.route-pill-marker') ||
      el.closest('.basemap-poi-card') ||
      el.closest('.leaflet-control') ||
      el.closest('#google-zoom-controls') ||
      el.closest('#map-top-left-hud') ||
      el.closest('#map-top-right-hud') ||
      el.closest('#desktop-expense-corridor') ||
      el.closest('button') ||
      el.closest('a')
  );
}

/**
 * 建立跨引擎通用的手機／平板（含 iPadOS 觸控與 Apple Pencil）長按加點控制器
 * 採用 capture 階段監聽確保不被 Google Maps 內部容器攔截，並嚴格去重保證每次長按僅新增 1 點
 */
function createTouchLongPressController(container, toLatLng, onLongPressAdd) {
  const supportsTouchEvents = typeof window !== 'undefined' && 'ontouchstart' in window;
  let touchTimer = null;
  let isTouchActive = false;
  let lastTouchActivityAt = 0;
  let touchGestureConsumed = false;
  let lastLongPressAddAt = 0;
  let startX = 0;
  let startY = 0;
  let activePointerId = null;
  const activePointers = new Set();

  const clearTouchTimer = () => {
    if (touchTimer) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
  };

  const emitTouchLongPressAdd = (lat, lng) => {
    clearTouchTimer();
    if (touchGestureConsumed || isPinRepositioning()) return;
    const now = Date.now();
    if (now - lastLongPressAddAt < 850) return;
    touchGestureConsumed = true;
    lastLongPressAddAt = now;
    if (navigator.vibrate) navigator.vibrate(30);
    if (typeof onLongPressAdd === 'function') {
      onLongPressAdd(lat, lng);
    }
  };

  const scheduleLongPress = (clientX, clientY) => {
    if (isPinRepositioning()) {
      clearTouchTimer();
      return;
    }
    startX = clientX;
    startY = clientY;
    clearTouchTimer();
    touchTimer = setTimeout(() => {
      touchTimer = null;
      if (isPinRepositioning()) return;
      const rect = container.getBoundingClientRect();
      const latlng = toLatLng(startX - rect.left, startY - rect.top);
      if (latlng) {
        emitTouchLongPressAdd(latlng.lat, latlng.lng);
      }
    }, 460);
  };

  const cleanups = [];
  const bindCap = (evt, fn, opts) => {
    container.addEventListener(evt, fn, opts);
    cleanups.push(() => container.removeEventListener(evt, fn, opts));
  };

  if (container) {
    // 1. 觸控事件（capture 階段，優先於 Google Maps 內部手勢處理，涵蓋 iPhone／iPad／Android）
    bindCap(
      'touchstart',
      (ev) => {
        isTouchActive = true;
        lastTouchActivityAt = Date.now();
        touchGestureConsumed = false;
        activePointerId = null;

        if (!ev.touches || ev.touches.length !== 1) {
          clearTouchTimer();
          touchGestureConsumed = true;
          return;
        }
        if (isPinRepositioning() || isInteractiveMapTarget(ev.target)) {
          clearTouchTimer();
          touchGestureConsumed = true;
          return;
        }
        const t = ev.touches[0];
        scheduleLongPress(t.clientX, t.clientY);
      },
      { capture: true, passive: true }
    );

    bindCap(
      'touchmove',
      (ev) => {
        lastTouchActivityAt = Date.now();
        if (!ev.touches || ev.touches.length !== 1) {
          clearTouchTimer();
          touchGestureConsumed = true;
          return;
        }
        const t = ev.touches[0];
        if (Math.hypot(t.clientX - startX, t.clientY - startY) > 12) {
          clearTouchTimer();
          touchGestureConsumed = true;
        }
      },
      { capture: true, passive: true }
    );

    const onTouchFinish = (ev) => {
      lastTouchActivityAt = Date.now();
      clearTouchTimer();
      if (!ev.touches || ev.touches.length === 0) {
        isTouchActive = false;
      }
    };
    bindCap('touchend', onTouchFinish, { capture: true, passive: true });
    bindCap('touchcancel', onTouchFinish, { capture: true, passive: true });

    // 2. Pointer Events 備援（專為 iPad Apple Pencil 及無 TouchEvent 的平板／觸控筆瀏覽器）
    bindCap(
      'pointerdown',
      (ev) => {
        if (ev.pointerType !== 'pen' && ev.pointerType !== 'touch') return;
        activePointers.add(ev.pointerId);
        if (activePointers.size > 1) {
          clearTouchTimer();
          touchGestureConsumed = true;
          activePointerId = null;
          return;
        }
        // 在支援 TouchEvent 的瀏覽器上，單指 touch 統一交由 touchstart 排程，避免 pointerdown 早於 touchstart 觸發雙重計時
        if (ev.pointerType === 'touch' && supportsTouchEvents) return;
        if (isPinRepositioning() || isInteractiveMapTarget(ev.target)) return;
        isTouchActive = true;
        lastTouchActivityAt = Date.now();
        touchGestureConsumed = false;
        activePointerId = ev.pointerId;
        scheduleLongPress(ev.clientX, ev.clientY);
      },
      { capture: true, passive: true }
    );

    bindCap(
      'pointermove',
      (ev) => {
        if (activePointerId == null || ev.pointerId !== activePointerId) return;
        lastTouchActivityAt = Date.now();
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 12) {
          clearTouchTimer();
          touchGestureConsumed = true;
          activePointerId = null;
        }
      },
      { capture: true, passive: true }
    );

    const onPointerFinish = (ev) => {
      activePointers.delete(ev.pointerId);
      if (activePointerId == null || ev.pointerId !== activePointerId) return;
      lastTouchActivityAt = Date.now();
      clearTouchTimer();
      activePointerId = null;
      if (activePointers.size === 0) {
        isTouchActive = false;
      }
    };
    bindCap('pointerup', onPointerFinish, { capture: true, passive: true });
    bindCap('pointercancel', onPointerFinish, { capture: true, passive: true });
  }

  return {
    clearTouchTimer,
    emitTouchLongPressAdd,
    markMoved() {
      clearTouchTimer();
      activePointerId = null;
      if (isTouchActive) touchGestureConsumed = true;
    },
    isRecentLongPress() {
      return Date.now() - lastLongPressAddAt < 800;
    },
    isTouchContextEvent(orig) {
      return (
        isTouchActive ||
        Date.now() - lastTouchActivityAt < 1400 ||
        orig?.pointerType === 'touch' ||
        orig?.pointerType === 'pen' ||
        orig?.sourceCapabilities?.firesTouchEvents === true
      );
    },
    destroy() {
      clearTouchTimer();
      activePointers.clear();
      cleanups.forEach((fn) => fn());
      cleanups.length = 0;
    },
  };
}

function runActiveDomCleanup() {
  if (typeof activeDomCleanup === 'function') {
    try {
      activeDomCleanup();
    } catch {
      // ignore
    }
    activeDomCleanup = null;
  }
}

async function initLeafletMap(initialCenter = [25.044, 121.535], initialZoom = 13) {
  const L = await ensureLeaflet();
  runActiveDomCleanup();
  clearPendingFitBoundsIdle();
  activeEngine = 'leaflet';
  const mapDiv = document.getElementById('map');
  if (mapDiv) {
    mapDiv.innerHTML = '';
  }

  mapInstance = L.map('map', {
    center: initialCenter,
    zoom: initialZoom,
    zoomControl: false,
  });

  L.control.zoom({ position: 'bottomright' }).addTo(mapInstance);
  overlayGroup = L.layerGroup().addTo(mapInstance);
  mountTileSourceSilently(0);
  syncEngineZoomControlsUI();

  const { onMapClick, onMapRightClick } = mapCallbacks;
  const touchCtrl = createTouchLongPressController(
    mapInstance.getContainer(),
    (x, y) => mapInstance.containerPointToLatLng(L.point(x, y)),
    onMapRightClick
  );
  activeDomCleanup = () => touchCtrl.destroy();

  mapInstance.on('click', (e) => {
    if (touchCtrl.isRecentLongPress()) return;
    if (typeof onMapClick === 'function') onMapClick(e.latlng.lat, e.latlng.lng);
  });

  mapInstance.on('contextmenu', (e) => {
    L.DomEvent.preventDefault(e);
    if (touchCtrl.isTouchContextEvent(e.originalEvent)) {
      touchCtrl.emitTouchLongPressAdd(e.latlng.lat, e.latlng.lng);
      return;
    }
    touchCtrl.clearTouchTimer();
    if (typeof onMapRightClick === 'function') {
      onMapRightClick(e.latlng.lat, e.latlng.lng);
    }
  });

  mapInstance.on('dragstart', () => touchCtrl.markMoved());
  mapInstance.on('zoomstart', () => touchCtrl.markMoved());

  mapInstance.invalidateSize();
  setTimeout(() => activeEngine === 'leaflet' && mapInstance && mapInstance.invalidateSize(), 150);
  setTimeout(() => activeEngine === 'leaflet' && mapInstance && mapInstance.invalidateSize(), 500);

  attachResizeObserver();
  return mapInstance;
}

function initGoogleMap(gmaps, initialCenter = [25.044, 121.535], initialZoom = 13) {
  runActiveDomCleanup();
  clearPendingFitBoundsIdle();
  activeEngine = 'google';
  const mapDiv = document.getElementById('map');
  if (!mapDiv) return null;
  mapDiv.innerHTML = '';

  mapInstance = new gmaps.Map(mapDiv, {
    center: { lat: initialCenter[0], lng: initialCenter[1] },
    zoom: initialZoom,
    disableDefaultUI: true,
    clickableIcons: true,
    gestureHandling: 'greedy',
    keyboardShortcuts: false,
  });

  overlayGroup = createGoogleOverlayGroup(mapInstance);
  googleProjection = createGoogleProjectionHelper(mapInstance);
  syncEngineZoomControlsUI();

  const { onMapClick, onMapRightClick, onBasemapPoiClick } = mapCallbacks;
  const toLatLng = (x, y) => (googleProjection ? googleProjection.containerPointToLatLng(x, y) : null);

  let lastRightClickEmitAt = 0;
  const emitMouseRightClickAdd = (lat, lng) => {
    if (isPinRepositioning()) return;
    const now = Date.now();
    if (now - lastRightClickEmitAt < 300) return;
    lastRightClickEmitAt = now;
    touchCtrl.clearTouchTimer();
    hideBasemapPoiPopover();
    if (typeof onMapRightClick === 'function') {
      onMapRightClick(lat, lng);
    }
  };

  const touchCtrl = createTouchLongPressController(mapDiv, toLatLng, (lat, lng) => {
    hideBasemapPoiPopover();
    if (typeof onMapRightClick === 'function') onMapRightClick(lat, lng);
  });

  // 統一於 capture 階段攔截 contextmenu：
  // 1) 阻擋瀏覽器與 iPadOS 系統「儲存圖片／複製圖片」選單
  // 2) 在 iPad 外接巧控鍵盤／觸控板／滑鼠右鍵時（Google Maps JS 在觸控裝置會略過 rightclick 事件），直接由 DOM contextmenu 補位設點！
  const onDomContextMenu = (ev) => {
    ev.preventDefault();
    if (isPinRepositioning() || isInteractiveMapTarget(ev.target)) return;
    const rect = mapDiv.getBoundingClientRect();
    const ll = toLatLng(ev.clientX - rect.left, ev.clientY - rect.top);
    if (!ll) return;
    if (touchCtrl.isTouchContextEvent(ev)) {
      touchCtrl.emitTouchLongPressAdd(ll.lat, ll.lng);
      return;
    }
    emitMouseRightClickAdd(ll.lat, ll.lng);
  };
  const onDomDragStart = (ev) => {
    ev.preventDefault();
  };
  mapDiv.addEventListener('contextmenu', onDomContextMenu, { capture: true });
  mapDiv.addEventListener('dragstart', onDomDragStart, { capture: true });

  activeDomCleanup = () => {
    touchCtrl.destroy();
    mapDiv.removeEventListener('contextmenu', onDomContextMenu, { capture: true });
    mapDiv.removeEventListener('dragstart', onDomDragStart, { capture: true });
  };

  // 核心：點擊畫面上看得到的 Google 底圖圖示時，原生取得 IconMouseEvent.placeId（絕不誤抓隱藏店家）
  mapInstance.addListener('click', (ev) => {
    if (touchCtrl.isRecentLongPress()) return;
    const lat = ev?.latLng?.lat?.();
    const lng = ev?.latLng?.lng?.();
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    if (ev.placeId) {
      if (typeof ev.stop === 'function') ev.stop();
      if (typeof onBasemapPoiClick === 'function') {
        onBasemapPoiClick({ placeId: ev.placeId, lat, lng });
      }
      return;
    }

    hideBasemapPoiPopover();
    if (typeof onMapClick === 'function') {
      onMapClick(lat, lng);
    }
  });

  mapInstance.addListener('rightclick', (ev) => {
    const lat = ev?.latLng?.lat?.();
    const lng = ev?.latLng?.lng?.();
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    hideBasemapPoiPopover();

    if (touchCtrl.isTouchContextEvent(ev?.domEvent)) {
      touchCtrl.emitTouchLongPressAdd(lat, lng);
      return;
    }
    emitMouseRightClickAdd(lat, lng);
  });

  mapInstance.addListener('dragstart', () => touchCtrl.markMoved());
  mapInstance.addListener('zoom_changed', () => touchCtrl.markMoved());

  attachResizeObserver();
  return mapInstance;
}

async function fallbackToLeafletAfterAuthFailure() {
  if (activeEngine !== 'google' || fallbackInProgress) return;
  fallbackInProgress = true;
  let center = [25.044, 121.535];
  let zoom = 13;
  try {
    const c = mapInstance?.getCenter?.();
    if (c) center = [c.lat(), c.lng()];
    const z = mapInstance?.getZoom?.();
    if (Number.isFinite(z)) zoom = z;
  } catch {
    // ignore
  }
  runActiveDomCleanup();
  clearPendingFitBoundsIdle();
  hideBasemapPoiPopover();
  if (overlayGroup) overlayGroup.clearLayers();
  clearSearchHighlightMarker();
  clearUserLocationMarker();
  if (mapInstance) {
    try {
      window.google?.maps?.event?.clearInstanceListeners?.(mapInstance);
    } catch {
      // ignore
    }
  }
  if (googleProjection) {
    googleProjection.destroy();
    googleProjection = null;
  }
  try {
    await initLeafletMap(center, zoom);
    if (typeof mapCallbacks.onEngineChanged === 'function') {
      mapCallbacks.onEngineChanged('leaflet', 'GOOGLE_MAPS_AUTH_FAILURE');
    }
  } finally {
    fallbackInProgress = false;
  }
}

function attachResizeObserver() {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  const mapEl = document.getElementById('panel-map');
  if (window.ResizeObserver && mapEl) {
    resizeObserver = new ResizeObserver(() => {
      invalidateMapSize();
    });
    resizeObserver.observe(mapEl);
  }
}

/**
 * 初始化地圖引擎：
 * - 若已設定 GOOGLE_MAPS_JS_API_KEY（或 VITE_GOOGLE_MAPS_API_KEY），優先啟用官方 Google Maps JS SDK（原生底圖圖示點擊取 placeId）
 * - 否則或載入／驗證失敗時，動態延遲載入 Leaflet 無縫降級
 */
export async function initMap({ onMapClick, onMapRightClick, onBasemapPoiClick, onEngineChanged } = {}) {
  mapCallbacks = { onMapClick, onMapRightClick, onBasemapPoiClick, onEngineChanged };

  const jsKey = await resolveGoogleMapsJsKey();
  if (jsKey) {
    try {
      const gmaps = await loadGoogleMapsSdk(jsKey, () => {
        void fallbackToLeafletAfterAuthFailure();
      });
      initGoogleMap(gmaps);
      return { engine: 'google', map: mapInstance };
    } catch {
      // 金鑰異常或離線時無縫退回 Leaflet
    }
  }

  await initLeafletMap();
  return { engine: 'leaflet', map: mapInstance };
}

export function getMapEngine() {
  return activeEngine;
}

export function getMap() {
  return mapInstance;
}

export function getGoogleProjection() {
  return activeEngine === 'google' ? googleProjection : null;
}

export function getMapZoom() {
  if (!mapInstance) return 16;
  const z = mapInstance.getZoom?.();
  return Number.isFinite(z) ? z : 16;
}

export function getOverlayGroup() {
  return overlayGroup;
}

export function isMapAnimatingZoom() {
  return activeEngine === 'leaflet' && Boolean(mapInstance && mapInstance._animatingZoom);
}

export function onNextMapZoomEnd(fn) {
  if (!mapInstance || typeof fn !== 'function') return;
  if (activeEngine === 'leaflet') {
    mapInstance.once('zoomend', fn);
  } else {
    fn();
  }
}

export function invalidateMapSize() {
  if (!mapInstance) return;
  if (invalidateRafId !== null) return;
  invalidateRafId = requestAnimationFrame(() => {
    invalidateRafId = null;
    if (!mapInstance) return;
    if (activeEngine === 'leaflet') {
      mapInstance.invalidateSize();
    } else if (window.google?.maps?.event) {
      window.google.maps.event.trigger(mapInstance, 'resize');
    }
  });
}

export function flyToPoint(lat, lng, zoom = 16) {
  if (!mapInstance) return;
  clearPendingFitBoundsIdle();
  if (activeEngine === 'google') {
    mapInstance.panTo({ lat, lng });
    if (Number.isFinite(zoom)) {
      mapInstance.setZoom(zoom);
    }
    return;
  }
  mapInstance.flyTo([lat, lng], zoom, { duration: 0.7 });
}

export function fitBoundsToPoints(pts, options = { padding: [70, 70], maxZoom: 15 }) {
  if (!mapInstance || !pts || pts.length === 0) return;
  clearPendingFitBoundsIdle();

  const maxZoom = options?.maxZoom || 15;
  const topPad = Array.isArray(options?.paddingTopLeft)
    ? options.paddingTopLeft[1] || 0
    : Array.isArray(options?.padding)
      ? options.padding[1] || 40
      : 40;
  const leftPad = Array.isArray(options?.paddingTopLeft)
    ? options.paddingTopLeft[0] || 0
    : Array.isArray(options?.padding)
      ? options.padding[0] || 40
      : 40;
  const bottomPad = Array.isArray(options?.paddingBottomRight)
    ? options.paddingBottomRight[1] || 0
    : Array.isArray(options?.padding)
      ? options.padding[1] || 40
      : 40;
  const rightPad = Array.isArray(options?.paddingBottomRight)
    ? options.paddingBottomRight[0] || 0
    : Array.isArray(options?.padding)
      ? options.padding[0] || 40
      : 40;

  if (activeEngine === 'google') {
    const gmaps = window.google?.maps;
    if (!gmaps) return;
    if (pts.length === 1) {
      mapInstance.setCenter({ lat: pts[0][0], lng: pts[0][1] });
      mapInstance.setZoom(maxZoom);
      // 若左右／上下留白不對稱（浮動工作區），平移鏡頭讓單點落在可視走廊中央
      const offsetX = Math.round((rightPad - leftPad) / 2);
      const offsetY = Math.round((bottomPad - topPad) / 2);
      if (Math.abs(offsetX) > 4 || Math.abs(offsetY) > 4) {
        mapInstance.panBy(offsetX, offsetY);
      }
      return;
    }
    const bounds = new gmaps.LatLngBounds();
    pts.forEach(([la, ln]) => bounds.extend({ lat: la, lng: ln }));
    mapInstance.fitBounds(bounds, {
      top: Math.max(24, topPad),
      right: Math.max(24, rightPad),
      bottom: Math.max(24, bottomPad),
      left: Math.max(24, leftPad),
    });
    if (gmaps.event?.addListenerOnce) {
      pendingFitBoundsIdleListener = gmaps.event.addListenerOnce(mapInstance, 'idle', () => {
        pendingFitBoundsIdleListener = null;
        if (activeEngine === 'google' && mapInstance && mapInstance.getZoom() > maxZoom) {
          mapInstance.setZoom(maxZoom);
        }
      });
    }
    return;
  }

  // Leaflet 分支
  const L = leafletLib;
  if (!L) return;
  if (pts.length === 1) {
    if (Math.abs(rightPad - leftPad) > 4 || Math.abs(bottomPad - topPad) > 4) {
      const projected = mapInstance.project(pts[0], maxZoom);
      const offsetX = (rightPad - leftPad) / 2;
      const offsetY = (bottomPad - topPad) / 2;
      const shifted = mapInstance.unproject([projected.x + offsetX, projected.y + offsetY], maxZoom);
      mapInstance.flyTo(shifted, maxZoom, { duration: 0.65 });
      return;
    }
    mapInstance.flyTo(pts[0], maxZoom, { duration: 0.7 });
  } else {
    mapInstance.fitBounds(L.latLngBounds(pts), options);
  }
}

export function clearSearchHighlightMarker() {
  if (!searchMarker) return;
  try {
    if (typeof searchMarker.setMap === 'function') {
      searchMarker.setMap(null);
    } else if (mapInstance && typeof mapInstance.removeLayer === 'function') {
      mapInstance.removeLayer(searchMarker);
    }
  } catch {
    // ignore
  }
  searchMarker = null;
}

export function showSearchHighlightMarker(lat, lng) {
  if (!mapInstance) return;
  clearSearchHighlightMarker();

  if (activeEngine === 'google') {
    const gmaps = window.google?.maps;
    if (!gmaps) return;
    searchMarker = new gmaps.Marker({
      position: { lat, lng },
      map: mapInstance,
      clickable: false,
      zIndex: 900,
      icon: {
        path: gmaps.SymbolPath.CIRCLE,
        scale: 11,
        strokeColor: '#816448',
        strokeWeight: 3,
        fillColor: '#9A7B5C',
        fillOpacity: 0.34,
      },
    });
    return;
  }

  const L = leafletLib;
  if (!L) return;
  searchMarker = L.circleMarker([lat, lng], {
    radius: 10,
    color: '#816448',
    fillColor: '#9A7B5C',
    fillOpacity: 0.34,
    weight: 3,
  }).addTo(mapInstance);
}

export function clearUserLocationMarker() {
  if (!userLocationLayers.length) return;
  for (const layer of userLocationLayers) {
    try {
      if (typeof layer?.setMap === 'function') {
        layer.setMap(null);
      } else if (mapInstance && typeof mapInstance.removeLayer === 'function') {
        mapInstance.removeLayer(layer);
      }
    } catch {
      // ignore
    }
  }
  userLocationLayers = [];
}

/**
 * 顯示使用者目前位置藍點、外圈光暈與定位精度誤差圓（支援 Google Maps 與 Leaflet 雙引擎，且不寫入行程資料）
 */
export function showUserLocationMarker(lat, lng, accuracyMeters = 0) {
  if (!mapInstance || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  clearUserLocationMarker();

  const clampedAcc =
    Number.isFinite(accuracyMeters) && accuracyMeters >= 15 ? Math.min(Math.round(accuracyMeters), 2500) : 0;

  if (activeEngine === 'google') {
    const gmaps = window.google?.maps;
    if (!gmaps) return;
    if (clampedAcc > 0) {
      userLocationLayers.push(
        new gmaps.Circle({
          center: { lat, lng },
          radius: clampedAcc,
          map: mapInstance,
          clickable: false,
          zIndex: 940,
          strokeColor: '#3B82F6',
          strokeOpacity: 0.36,
          strokeWeight: 1.5,
          fillColor: '#3B82F6',
          fillOpacity: 0.13,
        })
      );
    }
    userLocationLayers.push(
      new gmaps.Marker({
        position: { lat, lng },
        map: mapInstance,
        clickable: false,
        zIndex: 945,
        icon: {
          path: gmaps.SymbolPath.CIRCLE,
          scale: 14,
          strokeWeight: 0,
          fillColor: '#3B82F6',
          fillOpacity: 0.22,
        },
      }),
      new gmaps.Marker({
        position: { lat, lng },
        map: mapInstance,
        clickable: false,
        zIndex: 950,
        icon: {
          path: gmaps.SymbolPath.CIRCLE,
          scale: 7.5,
          strokeColor: '#FFFFFF',
          strokeWeight: 3,
          fillColor: '#2563EB',
          fillOpacity: 1,
        },
      })
    );
    return;
  }

  const L = leafletLib;
  if (!L) return;
  if (clampedAcc > 0) {
    userLocationLayers.push(
      L.circle([lat, lng], {
        radius: clampedAcc,
        color: '#3B82F6',
        weight: 1.5,
        opacity: 0.36,
        fillColor: '#3B82F6',
        fillOpacity: 0.13,
        interactive: false,
      }).addTo(mapInstance)
    );
  }
  userLocationLayers.push(
    L.circleMarker([lat, lng], {
      radius: 13,
      stroke: false,
      fillColor: '#3B82F6',
      fillOpacity: 0.22,
      interactive: false,
    }).addTo(mapInstance),
    L.circleMarker([lat, lng], {
      radius: 7,
      color: '#FFFFFF',
      weight: 3,
      fillColor: '#2563EB',
      fillOpacity: 1,
      interactive: false,
    }).addTo(mapInstance)
  );
}

function clearBasemapPoiOverlayDom() {
  if (basemapPoiOverlay) {
    try {
      basemapPoiOverlay.setMap(null);
    } catch {
      // ignore
    }
    basemapPoiOverlay = null;
  }
}

export function showBasemapPoiPopover(opts) {
  clearBasemapPoiOverlayDom();
  activeBasemapPoiOnClose = typeof opts?.onClose === 'function' ? opts.onClose : null;
  if (activeEngine !== 'google' || !mapInstance) return null;
  basemapPoiOverlay = mountBasemapPoiCard(mapInstance, {
    ...opts,
    onClose: () => {
      hideBasemapPoiPopover();
    },
  });
  return basemapPoiOverlay;
}

export function hideBasemapPoiPopover() {
  clearBasemapPoiOverlayDom();
  const cb = activeBasemapPoiOnClose;
  activeBasemapPoiOnClose = null;
  if (typeof cb === 'function') {
    try {
      cb();
    } catch {
      // ignore
    }
  }
}
