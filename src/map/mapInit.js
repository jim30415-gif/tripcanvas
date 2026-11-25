import L from 'leaflet';
import { SILENT_TILE_SOURCES } from '../config/constants.js';

let mapInstance = null;
let activeBaseLayer = null;
let overlayGroup = null;
let searchMarker = null;
let resizeObserver = null;

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

      const isSoftTone = (coords.x * 7 + coords.y * 13) % 5 === 0;
      ctx.fillStyle = isSoftTone ? '#EFE7DB' : '#F7F1E7';
      ctx.fillRect(0, 0, size.x, size.y);

      ctx.strokeStyle = 'rgba(154, 123, 92, 0.14)';
      ctx.lineWidth = 1;
      for (let p = 64; p < size.x; p += 64) {
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, size.y);
        ctx.moveTo(0, p);
        ctx.lineTo(size.x, p);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(120, 100, 84, 0.22)';
      ctx.strokeRect(0.5, 0.5, size.x - 1, size.y - 1);

      const n = Math.pow(2, coords.z);
      const lng = ((coords.x / n) * 360 - 180).toFixed(2);
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * coords.y) / n)));
      const lat = ((latRad * 180) / Math.PI).toFixed(2);
      ctx.fillStyle = 'rgba(107, 81, 58, 0.45)';
      ctx.font = '600 10px Inter, sans-serif';
      ctx.fillText(`Z${coords.z} · ${lat}°N, ${lng}°E`, 10, 18);
      return tile;
    },
  });
  return new OfflineGridLayer(options);
}

function mountTileSourceSilently(sourceIndex) {
  if (!mapInstance) return;
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

export function initMap({ onMapClick, onMapRightClick }) {
  mapInstance = L.map('map', {
    center: [25.044, 121.535],
    zoom: 13,
    zoomControl: false,
  });

  L.control.zoom({ position: 'bottomright' }).addTo(mapInstance);
  overlayGroup = L.layerGroup().addTo(mapInstance);

  mountTileSourceSilently(0);

  let touchTimer = null;
  let isTouchActive = false;
  let lastTouchActivityAt = 0;
  let touchGestureConsumed = false;
  let lastLongPressAddAt = 0;

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
    if (typeof onMapRightClick === 'function') {
      onMapRightClick(lat, lng);
    }
  };

  mapInstance.on('click', (e) => {
    if (Date.now() - lastLongPressAddAt < 800) return;
    if (typeof onMapClick === 'function') onMapClick(e.latlng.lat, e.latlng.lng);
  });

  mapInstance.on('contextmenu', (e) => {
    L.DomEvent.preventDefault(e);
    const orig = e.originalEvent;
    const isTouchContextMenu =
      isTouchActive ||
      Date.now() - lastTouchActivityAt < 1400 ||
      orig?.pointerType === 'touch' ||
      orig?.sourceCapabilities?.firesTouchEvents === true;

    if (isTouchContextMenu) {
      // Android Chrome／Leaflet TapHold 可能早於或晚於 520ms 觸發 contextmenu，統一經單次去重通道避免生出兩個標點
      emitTouchLongPressAdd(e.latlng.lat, e.latlng.lng);
      return;
    }

    // 電腦版滑鼠右鍵：立即新增單一標點
    clearTouchTimer();
    if (typeof onMapRightClick === 'function') {
      onMapRightClick(e.latlng.lat, e.latlng.lng);
    }
  });

  mapInstance.on('dragstart', () => {
    clearTouchTimer();
    if (isTouchActive) touchGestureConsumed = true;
  });
  mapInstance.on('zoomstart', () => {
    clearTouchTimer();
    if (isTouchActive) touchGestureConsumed = true;
  });

  // 手機觸控長按地圖空處（520ms）即可新增標點（支援 iOS Safari 與 Android Chrome，保證每次長按僅新增 1 點）
  const mapContainer = mapInstance.getContainer();
  if (mapContainer) {
    let startX = 0;
    let startY = 0;

    mapContainer.addEventListener(
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
          target?.closest?.('.leaflet-control') ||
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
          const rect = mapContainer.getBoundingClientRect();
          const latlng = mapInstance.containerPointToLatLng(
            L.point(startX - rect.left, startY - rect.top)
          );
          emitTouchLongPressAdd(latlng.lat, latlng.lng);
        }, 520);
      },
      { passive: true }
    );

    mapContainer.addEventListener(
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
    mapContainer.addEventListener('touchend', onTouchFinish, { passive: true });
    mapContainer.addEventListener('touchcancel', onTouchFinish, { passive: true });
  }

  mapInstance.invalidateSize();
  setTimeout(() => mapInstance && mapInstance.invalidateSize(), 150);
  setTimeout(() => mapInstance && mapInstance.invalidateSize(), 500);

  const mapEl = document.getElementById('panel-map');
  if (window.ResizeObserver && mapEl) {
    resizeObserver = new ResizeObserver(() => {
      if (mapInstance) mapInstance.invalidateSize();
    });
    resizeObserver.observe(mapEl);
  }

  return mapInstance;
}

export function getMap() {
  return mapInstance;
}

export function getMapZoom() {
  return mapInstance ? mapInstance.getZoom() : 16;
}

export function getOverlayGroup() {
  return overlayGroup;
}

export function isMapAnimatingZoom() {
  return Boolean(mapInstance && mapInstance._animatingZoom);
}

export function onNextMapZoomEnd(fn) {
  if (!mapInstance || typeof fn !== 'function') return;
  mapInstance.once('zoomend', fn);
}

export function invalidateMapSize() {
  if (mapInstance) mapInstance.invalidateSize();
}

export function flyToPoint(lat, lng, zoom = 16) {
  if (!mapInstance) return;
  mapInstance.flyTo([lat, lng], zoom, { duration: 0.7 });
}

export function fitBoundsToPoints(pts, options = { padding: [70, 70], maxZoom: 15 }) {
  if (!mapInstance || !pts || pts.length === 0) return;
  if (pts.length === 1) {
    const zoom = options.maxZoom || 15;
    const bottomPad = Array.isArray(options.paddingBottomRight) ? options.paddingBottomRight[1] || 0 : 0;
    const topPad = Array.isArray(options.paddingTopLeft) ? options.paddingTopLeft[1] || 0 : 0;
    const rightPad = Array.isArray(options.paddingBottomRight) ? options.paddingBottomRight[0] || 0 : 0;
    const leftPad = Array.isArray(options.paddingTopLeft) ? options.paddingTopLeft[0] || 0 : 0;
    if (bottomPad > topPad || rightPad > leftPad) {
      const projected = mapInstance.project(pts[0], zoom);
      const offsetX = (rightPad - leftPad) / 2;
      const offsetY = (bottomPad - topPad) / 2;
      const shifted = mapInstance.unproject([projected.x + offsetX, projected.y + offsetY], zoom);
      mapInstance.flyTo(shifted, zoom, { duration: 0.65 });
      return;
    }
    mapInstance.flyTo(pts[0], zoom, { duration: 0.7 });
  } else {
    mapInstance.fitBounds(L.latLngBounds(pts), options);
  }
}

export function showSearchHighlightMarker(lat, lng) {
  if (!mapInstance) return;
  if (searchMarker) mapInstance.removeLayer(searchMarker);
  searchMarker = L.circleMarker([lat, lng], {
    radius: 10,
    color: '#816448',
    fillColor: '#9A7B5C',
    fillOpacity: 0.34,
    weight: 3,
  }).addTo(mapInstance);
}
