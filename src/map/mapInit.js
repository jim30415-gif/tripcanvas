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
  const source = SILENT_TILE_SOURCES[sourceIndex] || SILENT_TILE_SOURCES[SILENT_TILE_SOURCES.length - 1];

  if (activeBaseLayer) {
    activeBaseLayer.off();
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
      tileRuntime.tileErrorCount > 4 &&
      tileRuntime.tileSuccessCount === 0 &&
      !tileRuntime.switched &&
      sourceIndex + 1 < SILENT_TILE_SOURCES.length
    ) {
      tileRuntime.switched = true;
      mountTileSourceSilently(sourceIndex + 1);
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

  mapInstance.on('click', (e) => {
    if (typeof onMapClick === 'function') onMapClick(e.latlng.lat, e.latlng.lng);
  });

  mapInstance.on('contextmenu', (e) => {
    L.DomEvent.preventDefault(e);
    if (typeof onMapRightClick === 'function') onMapRightClick(e.latlng.lat, e.latlng.lng);
  });

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

export function getOverlayGroup() {
  return overlayGroup;
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
