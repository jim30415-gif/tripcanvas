import L from 'leaflet';
import { SILENT_TILE_SOURCES } from '../config/constants.js';
import {
  createGoogleOverlayGroup,
  createGoogleProjectionHelper,
  loadGoogleMapsSdk,
  mountBasemapPoiCard,
  resolveGoogleMapsJsKey,
} from './googleEngine.js';

let activeEngine = 'leaflet'; // 'google' | 'leaflet'
let mapInstance = null; // Leaflet Map or google.maps.Map
let overlayGroup = null;
let activeBaseLayer = null;
let searchMarker = null;
let resizeObserver = null;
let googleProjection = null;
let basemapPoiOverlay = null;
let mapCallbacks = {};
let zoomControlsBound = false;

let tileRuntime = {
  sourceIndex: 0,
  tileSuccessCount: 0,
  tileErrorCount: 0,
  switched: false,
  token: 0,
};

function createOfflineCanvasGridLayer(options) {
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
  if (activeEngine !== 'leaflet' || !mapInstance) return;
  if (mapInstance._animatingZoom) {
    mapInstance.once('zoomend', () => mountTileSourceSilently(sourceIndex));
    return;
  }
  const source = SILENT_TILE_SOURCES[sourceIndex] || SILENT_TILE_SOURCES[SILENT_TILE_SOURCES.length - 1];

  if (activeBaseLayer) {
    activeBaseLayer.off('tileload tileerror');
    mapInstance.removeLayer(activeBaseLayer);
    activeBaseLayer = null;
  }

  const token = ++tileRuntime.token;
  tileRuntime = {
    sourceIndex,
    tileSuccessCount: 0,
    tileErrorCount: 0,
    switched: false,
    token,
  };

  if (source.type === 'canvas') {
    activeBaseLayer = createOfflineCanvasGridLayer(source.options);
    activeBaseLayer.addTo(mapInstance);
    return;
  }

  activeBaseLayer = L.tileLayer(source.url, { ...source.options });

  activeBaseLayer.on('tileload', () => {
    if (tileRuntime.token !== token) return;
    tileRuntime.tileSuccessCount++;
  });

  activeBaseLayer.on('tileerror', () => {
    if (tileRuntime.token !== token) return;
    tileRuntime.tileErrorCount++;
    if (
      tileRuntime.tileErrorCount > 10 &&
      tileRuntime.tileSuccessCount === 0 &&
      !tileRuntime.switched &&
      sourceIndex + 1 < SILENT_TILE_SOURCES.length
    ) {
      tileRuntime.switched = true;
      // 延後至下一個事件循環再切換底圖，避免在 Leaflet _updateLevels() 同步清除瓦片期間觸發 removeLayer 導致 _map 為 null
      setTimeout(() => {
        if (tileRuntime.token === token) {
          mountTileSourceSilently(sourceIndex + 1);
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
        mapInstance.setZoom((mapInstance.getZoom() || 13) + 1);
      }
    });
    document.getElementById('btn-gmap-zoom-out')?.addEventListener('click', () => {
      if (activeEngine === 'google' && mapInstance) {
        mapInstance.setZoom(Math.max(2, (mapInstance.getZoom() || 13) - 1));
      }
    });
  }
}

/**
 * 建立跨引擎通用的手機觸控長按加點控制器（保證每次長按僅新增 1 點）
 */
function createTouchLongPressController(container, toLatLng, onLongPressAdd) {
  let touchTimer = null;
  let isTouchActive = false;
  let lastTouchActivityAt = 0;
  let touchGestureConsumed = false;
  let lastLongPressAddAt = 0;
  let startX = 0;
  let startY = 0;

  const clearTouchTimer = () => {
    if (touchTimer) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
  };

  const emitTouchLongPressAdd = (lat, lng) => {
    clearTouchTimer();
    if (touchGestureConsumed) return;
    const now = Date.now();
    if (now - lastLongPressAddAt < 900) return;
    touchGestureConsumed = true;
    lastLongPressAddAt = now;
    if (navigator.vibrate) navigator.vibrate(30);
    if (typeof onLongPressAdd === 'function') {
      onLongPressAdd(lat, lng);
    }
  };

  if (container) {
    container.addEventListener(
      'touchstart',
      (ev) => {
        isTouchActive = true;
        lastTouchActivityAt = Date.now();
        touchGestureConsumed = false;

        if (!ev.touches || ev.touches.length !== 1) {
          clearTouchTimer();
          touchGestureConsumed = true;
          return;
        }
        const target = ev.target;
        if (
          target?.closest?.('.custom-pin-icon') ||
          target?.closest?.('.route-pill-marker') ||
          target?.closest?.('.basemap-poi-card') ||
          target?.closest?.('.leaflet-control') ||
          target?.closest?.('#google-zoom-controls') ||
          target?.closest?.('button') ||
          target?.closest?.('a')
        ) {
          clearTouchTimer();
          touchGestureConsumed = true;
          return;
        }
        const t = ev.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        clearTouchTimer();
        touchTimer = setTimeout(() => {
          touchTimer = null;
          const rect = container.getBoundingClientRect();
          const latlng = toLatLng(startX - rect.left, startY - rect.top);
          if (latlng) {
            emitTouchLongPressAdd(latlng.lat, latlng.lng);
          }
        }, 520);
      },
      { passive: true }
    );

    container.addEventListener(
      'touchmove',
      (ev) => {
        lastTouchActivityAt = Date.now();
        if (!ev.touches || ev.touches.length !== 1) {
          clearTouchTimer();
          touchGestureConsumed = true;
          return;
        }
        const t = ev.touches[0];
        if (Math.hypot(t.clientX - startX, t.clientY - startY) > 9) {
          clearTouchTimer();
          touchGestureConsumed = true;
        }
      },
      { passive: true }
    );

    const onTouchFinish = (ev) => {
      lastTouchActivityAt = Date.now();
      clearTouchTimer();
      if (!ev.touches || ev.touches.length === 0) {
        isTouchActive = false;
      }
    };
    container.addEventListener('touchend', onTouchFinish, { passive: true });
    container.addEventListener('touchcancel', onTouchFinish, { passive: true });
  }

  return {
    clearTouchTimer,
    emitTouchLongPressAdd,
    markMoved() {
      clearTouchTimer();
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
        orig?.sourceCapabilities?.firesTouchEvents === true
      );
    },
  };
}

function initLeafletMap(initialCenter = [25.044, 121.535], initialZoom = 13) {
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
  const touchCtrl = createTouchLongPressController(
    mapDiv,
    (x, y) => (googleProjection ? googleProjection.containerPointToLatLng(x, y) : null),
    (lat, lng) => {
      hideBasemapPoiPopover();
      if (typeof onMapRightClick === 'function') onMapRightClick(lat, lng);
    }
  );

  // 防止電腦右鍵跳出瀏覽器選單，讓右鍵專心負責新增標點
  mapDiv.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
  });

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
    touchCtrl.clearTouchTimer();
    if (typeof onMapRightClick === 'function') {
      onMapRightClick(lat, lng);
    }
  });

  mapInstance.addListener('dragstart', () => touchCtrl.markMoved());
  mapInstance.addListener('zoom_changed', () => touchCtrl.markMoved());

  attachResizeObserver();
  return mapInstance;
}

function fallbackToLeafletAfterAuthFailure() {
  if (activeEngine !== 'google') return;
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
  hideBasemapPoiPopover();
  if (overlayGroup) overlayGroup.clearLayers();
  if (searchMarker && typeof searchMarker.setMap === 'function') {
    searchMarker.setMap(null);
    searchMarker = null;
  }
  if (googleProjection) {
    googleProjection.destroy();
    googleProjection = null;
  }
  initLeafletMap(center, zoom);
  if (typeof mapCallbacks.onEngineChanged === 'function') {
    mapCallbacks.onEngineChanged('leaflet', 'GOOGLE_MAPS_AUTH_FAILURE');
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
 * - 否則或載入／驗證失敗時，自動無縫降級回 Leaflet
 */
export async function initMap({ onMapClick, onMapRightClick, onBasemapPoiClick, onEngineChanged } = {}) {
  mapCallbacks = { onMapClick, onMapRightClick, onBasemapPoiClick, onEngineChanged };

  const jsKey = await resolveGoogleMapsJsKey();
  if (jsKey) {
    try {
      const gmaps = await loadGoogleMapsSdk(jsKey, () => {
        fallbackToLeafletAfterAuthFailure();
      });
      initGoogleMap(gmaps);
      return { engine: 'google', map: mapInstance };
    } catch {
      // 金鑰異常或離線時無縫退回 Leaflet
    }
  }

  initLeafletMap();
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
  if (activeEngine === 'leaflet') {
    mapInstance.invalidateSize();
  } else if (window.google?.maps?.event) {
    window.google.maps.event.trigger(mapInstance, 'resize');
  }
}

export function flyToPoint(lat, lng, zoom = 16) {
  if (!mapInstance) return;
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
      mapInstance.panTo({ lat: pts[0][0], lng: pts[0][1] });
      mapInstance.setZoom(maxZoom);
      // 若左右／上下留白不對稱（浮動工作區），稍微平移鏡頭讓單點落在可視走廊中央
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
      gmaps.event.addListenerOnce(mapInstance, 'idle', () => {
        if (activeEngine === 'google' && mapInstance && mapInstance.getZoom() > maxZoom) {
          mapInstance.setZoom(maxZoom);
        }
      });
    }
    return;
  }

  // Leaflet 分支
  if (pts.length === 1) {
    if (bottomPad > topPad || rightPad > leftPad) {
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

export function showSearchHighlightMarker(lat, lng) {
  if (!mapInstance) return;
  if (activeEngine === 'google') {
    const gmaps = window.google?.maps;
    if (!gmaps) return;
    if (searchMarker && typeof searchMarker.setMap === 'function') {
      searchMarker.setMap(null);
    }
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

  if (searchMarker) mapInstance.removeLayer(searchMarker);
  searchMarker = L.circleMarker([lat, lng], {
    radius: 10,
    color: '#816448',
    fillColor: '#9A7B5C',
    fillOpacity: 0.34,
    weight: 3,
  }).addTo(mapInstance);
}

export function showBasemapPoiPopover(opts) {
  hideBasemapPoiPopover();
  if (activeEngine !== 'google' || !mapInstance) return null;
  basemapPoiOverlay = mountBasemapPoiCard(mapInstance, {
    ...opts,
    onClose: () => {
      hideBasemapPoiPopover();
      if (typeof opts?.onClose === 'function') opts.onClose();
    },
  });
  return basemapPoiOverlay;
}

export function hideBasemapPoiPopover() {
  if (basemapPoiOverlay) {
    try {
      basemapPoiOverlay.setMap(null);
    } catch {
      // ignore
    }
    basemapPoiOverlay = null;
  }
}
