import { escapeHTML } from '../utils/format.js';
import { getGoogleRoutesStatus } from '../services/googleRoutes.js';

let sdkPromise = null;
let authFailed = false;
let authFailureCallback = null;
let gmAuthFailureHooked = false;
let originalGmAuthFailure = null;
let activeAuthFailureReject = null;

const projectionClassCache = new WeakMap();
const htmlOverlayClassCache = new WeakMap();

function getProjectionOverlayClass(gmaps) {
  let Cls = projectionClassCache.get(gmaps);
  if (!Cls) {
    Cls = class ProjectionOverlay extends gmaps.OverlayView {
      onAdd() {}
      draw() {}
      onRemove() {}
    };
    projectionClassCache.set(gmaps, Cls);
  }
  return Cls;
}

function getHtmlOverlayClass(gmaps) {
  let Cls = htmlOverlayClassCache.get(gmaps);
  if (!Cls) {
    Cls = class HtmlOverlay extends gmaps.OverlayView {
      constructor(initLat, initLng, el, pane, onRemoveCb = null) {
        super();
        this._lat = initLat;
        this._lng = initLng;
        this._el = el;
        this._pane = pane || 'overlayMouseTarget';
        this._onRemoveCb = typeof onRemoveCb === 'function' ? onRemoveCb : null;
      }

      onAdd() {
        const panes = this.getPanes();
        const targetPane = panes?.[this._pane] || panes?.overlayMouseTarget;
        if (targetPane && !this._el.parentNode) {
          targetPane.appendChild(this._el);
        }
      }

      draw() {
        const proj = this.getProjection();
        if (!proj) return;
        const pt = proj.fromLatLngToDivPixel(new gmaps.LatLng(this._lat, this._lng));
        if (!pt) return;
        this._el.style.left = `${pt.x}px`;
        this._el.style.top = `${pt.y}px`;
      }

      onRemove() {
        if (typeof this._onRemoveCb === 'function') {
          const cb = this._onRemoveCb;
          this._onRemoveCb = null;
          try {
            cb();
          } catch {
            // ignore cleanup errors
          }
        }
        if (this._el.parentNode) {
          this._el.parentNode.removeChild(this._el);
        }
      }

      setOnRemove(cb) {
        this._onRemoveCb = typeof cb === 'function' ? cb : null;
      }

      setPosition(nextLat, nextLng) {
        this._lat = nextLat;
        this._lng = nextLng;
        this.draw();
      }

      getLatLng() {
        return { lat: this._lat, lng: this._lng };
      }

      setZIndex(nextZ) {
        this._el.style.zIndex = String(nextZ);
      }

      getElement() {
        return this._el;
      }
    };
    htmlOverlayClassCache.set(gmaps, Cls);
  }
  return Cls;
}

/**
 * 檢查是否設定了瀏覽器專用 Google Maps JS API 金鑰（不接觸伺服器專屬 GOOGLE_MAPS_API_KEY）
 * 與 googleRoutes.js 共用同一份 /api/routes 狀態快取，避免啟動時重複打兩次 API。
 */
export async function resolveGoogleMapsJsKey() {
  try {
    const inlineKey = (import.meta.env?.VITE_GOOGLE_MAPS_API_KEY || '').trim();
    if (inlineKey) return inlineKey;
  } catch {
    // ignore in non-Vite test environments
  }

  try {
    const status = await getGoogleRoutesStatus();
    return typeof status?.mapsJsKey === 'string' ? status.mapsJsKey.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 動態載入官方 Google Maps JavaScript SDK（language=zh-TW, region=TW）
 * Places 函式庫改為按需 importLibrary('places') 載入，不於啟動時預載。
 * 若金鑰無效、網域被擋或離線逾時則 reject，由 mapInit 自動無縫降級回 Leaflet。
 */
export function loadGoogleMapsSdk(apiKey, onAuthError = null) {
  if (typeof onAuthError === 'function') {
    authFailureCallback = onAuthError;
  }

  if (typeof window === 'undefined') {
    return Promise.reject(new Error('NO_WINDOW'));
  }

  if (window.google?.maps?.Map && window.google?.maps?.OverlayView) {
    return Promise.resolve(window.google.maps);
  }

  if (!apiKey || authFailed) {
    return Promise.reject(new Error('NO_GOOGLE_MAPS_JS_KEY'));
  }

  if (sdkPromise) return sdkPromise;

  if (!gmAuthFailureHooked) {
    gmAuthFailureHooked = true;
    originalGmAuthFailure = typeof window.gm_authFailure === 'function' ? window.gm_authFailure : null;
    window.gm_authFailure = () => {
      authFailed = true;
      sdkPromise = null;
      if (typeof originalGmAuthFailure === 'function') {
        try {
          originalGmAuthFailure();
        } catch {
          // ignore
        }
      }
      if (typeof activeAuthFailureReject === 'function') {
        const rejectPending = activeAuthFailureReject;
        activeAuthFailureReject = null;
        rejectPending(new Error('GOOGLE_MAPS_AUTH_FAILURE'));
      }
      if (typeof authFailureCallback === 'function') {
        authFailureCallback();
      }
    };
  }

  sdkPromise = new Promise((resolve, reject) => {
    const callbackName = '__tripcanvasGoogleMapsReady';
    let settled = false;
    let scriptEl = null;

    const cleanupLoader = (removeScript) => {
      clearTimeout(timeoutId);
      try {
        delete window[callbackName];
      } catch {
        window[callbackName] = undefined;
      }
      if (removeScript && scriptEl && scriptEl.parentNode) {
        scriptEl.parentNode.removeChild(scriptEl);
      }
    };

    const fail = (err, removeScript = true) => {
      if (settled) return;
      settled = true;
      activeAuthFailureReject = null;
      cleanupLoader(removeScript);
      sdkPromise = null;
      reject(err);
    };

    activeAuthFailureReject = (err) => {
      fail(err, true);
    };

    const finishOk = async () => {
      if (settled) return;
      try {
        if (window.google?.maps?.importLibrary && !window.google?.maps?.Map) {
          await window.google.maps.importLibrary('maps');
        }
        if (window.google?.maps?.Map && window.google?.maps?.OverlayView) {
          if (settled) return;
          settled = true;
          activeAuthFailureReject = null;
          cleanupLoader(false);
          resolve(window.google.maps);
        }
      } catch (err) {
        fail(err, true);
      }
    };

    const timeoutId = setTimeout(() => {
      fail(new Error('GOOGLE_MAPS_SDK_TIMEOUT'), true);
    }, 6500);

    window[callbackName] = () => {
      void finishOk();
    };

    scriptEl = document.createElement('script');
    scriptEl.async = true;
    scriptEl.defer = true;
    scriptEl.src =
      `https://maps.googleapis.com/maps/api/js` +
      `?key=${encodeURIComponent(apiKey)}` +
      `&language=zh-TW&region=TW&v=weekly&callback=${callbackName}`;
    scriptEl.onerror = () => {
      fail(new Error('GOOGLE_MAPS_SDK_LOAD_ERROR'), true);
    };
    document.head.appendChild(scriptEl);
  });

  return sdkPromise;
}

/**
 * 輕量級投影橋接器：提供容器像素座標 ↔ 經緯度轉換（供長按加點、平板右鍵與拖曳標點使用）
 * 優先採用 Google OverlayView 投影，若尚未就緒自動以標準 Web Mercator 公式無縫補位
 */
export function createGoogleProjectionHelper(googleMap) {
  const gmaps = window.google.maps;
  const ProjectionOverlay = getProjectionOverlayClass(gmaps);
  const helper = new ProjectionOverlay();
  helper.setMap(googleMap);

  const fallbackMercatorToLatLng = (x, y) => {
    const center = googleMap?.getCenter?.();
    const zoom = googleMap?.getZoom?.();
    const div = googleMap?.getDiv?.();
    if (!center || !Number.isFinite(zoom) || !div) return null;
    const rect = div.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const scale = 256 * Math.pow(2, zoom);
    const cLat = center.lat();
    const cLng = center.lng();
    const sinLat = Math.max(-0.9999, Math.min(0.9999, Math.sin((cLat * Math.PI) / 180)));
    const centerWorldX = ((cLng + 180) / 360) * scale;
    const centerWorldY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;

    const worldX = centerWorldX + (x - rect.width / 2);
    const worldY = centerWorldY + (y - rect.height / 2);
    const lng = (worldX / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * worldY) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  };

  return {
    containerPointToLatLng(x, y) {
      const proj = helper.getProjection();
      if (proj) {
        const ll = proj.fromContainerPixelToLatLng(new gmaps.Point(x, y));
        if (ll) return { lat: ll.lat(), lng: ll.lng() };
      }
      return fallbackMercatorToLatLng(x, y);
    },
    latLngToContainerPoint(lat, lng) {
      const proj = helper.getProjection();
      if (!proj) return null;
      const pt = proj.fromLatLngToContainerPixel(new gmaps.LatLng(lat, lng));
      if (!pt) return null;
      return { x: pt.x, y: pt.y };
    },
    destroy() {
      helper.setMap(null);
    },
  };
}

/**
 * 建立自訂 HTML 覆蓋物（無需 Cloud Map ID，完整保留貓頭鷹咖啡館風格標點與路線膠囊）
 */
export function createGoogleHtmlOverlay(
  googleMap,
  { lat, lng, html, className = '', zIndex = 100, pane = 'overlayMouseTarget', onRemove = null }
) {
  const gmaps = window.google.maps;
  const HtmlOverlay = getHtmlOverlayClass(gmaps);

  const div = document.createElement('div');
  div.className = className;
  div.style.position = 'absolute';
  div.style.left = '0px';
  div.style.top = '0px';
  div.style.zIndex = String(zIndex);
  div.innerHTML = html;

  const overlay = new HtmlOverlay(lat, lng, div, pane, onRemove);
  overlay.setMap(googleMap);
  return overlay;
}

/**
 * 統一圖層容器：對齊 Leaflet LayerGroup 的 clearLayers() 介面
 */
export function createGoogleOverlayGroup(googleMap) {
  const items = [];
  return {
    isGoogle: true,
    map: googleMap,
    add(item) {
      if (item) items.push(item);
      return item;
    },
    clearLayers() {
      const clearListeners = window.google?.maps?.event?.clearInstanceListeners;
      while (items.length > 0) {
        const item = items.pop();
        try {
          if (typeof clearListeners === 'function') clearListeners(item);
        } catch {
          // ignore
        }
        try {
          if (typeof item.setMap === 'function') item.setMap(null);
          else if (typeof item.close === 'function') item.close();
        } catch {
          // ignore
        }
      }
    },
  };
}

/**
 * 在 Google 底圖原生地標圖示上方顯示精巧浮動確認卡（「點畫面上看得到的點 → 一鍵加入」）
 */
export function mountBasemapPoiCard(
  googleMap,
  { lat, lng, loading = false, name = '', address = '', categoryLabel = '', onAdd, onClose }
) {
  const cardHtml = `
    <div
      class="basemap-poi-card pointer-events-auto select-none"
      style="transform: translate(-50%, calc(-100% - 14px));"
    >
      <div class="min-w-[210px] max-w-[270px] rounded-2xl bg-[#FBF8F3]/95 backdrop-blur-md border border-[#D8C7B4] shadow-2xl p-3 text-[#3A2C21]">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 mb-1">
              <span class="inline-flex items-center px-2 py-0.5 rounded-full bg-[#EBF2EC] text-[#4F6F57] text-[10px] font-extrabold tracking-wide">
                Google 底圖標點
              </span>
              ${
                categoryLabel
                  ? `<span class="text-[10px] font-semibold text-[#8C7664] truncate">${escapeHTML(categoryLabel)}</span>`
                  : ''
              }
            </div>
            <div class="text-sm font-extrabold text-[#3A2C21] leading-snug break-words">
              ${loading ? '讀取底圖地標中…' : escapeHTML(name || 'Google 地圖地點')}
            </div>
            ${
              !loading && address
                ? `<div class="text-[11px] text-[#786454] mt-0.5 line-clamp-2 leading-tight">${escapeHTML(address)}</div>`
                : ''
            }
          </div>
          <button
            type="button"
            class="btn-close-poi-card w-6 h-6 rounded-full hover:bg-[#EFE7DC] text-[#8C7664] hover:text-[#3A2C21] flex items-center justify-center shrink-0 text-sm font-bold transition"
            aria-label="關閉"
          >×</button>
        </div>
        ${
          loading
            ? `<div class="mt-2.5 h-8 rounded-xl bg-[#EFE7DC] animate-pulse"></div>`
            : `
          <button
            type="button"
            class="btn-add-basemap-poi mt-2.5 w-full py-2 px-3 rounded-xl bg-[#816448] hover:bg-[#6B513A] active:scale-[0.98] text-[#FAF4EC] text-xs font-extrabold shadow-sm transition flex items-center justify-center gap-1.5"
          >
            <span>＋</span>
            <span>加入目前行程</span>
          </button>
        `
        }
      </div>
      <div class="w-0 h-0 mx-auto border-l-[7px] border-l-transparent border-r-[7px] border-r-transparent border-t-[8px] border-t-[#FBF8F3] drop-shadow-sm"></div>
    </div>
  `;

  const overlay = createGoogleHtmlOverlay(googleMap, {
    lat,
    lng,
    html: cardHtml,
    className: 'basemap-poi-overlay',
    zIndex: 3200,
    pane: 'floatPane',
  });

  const el = overlay.getElement();
  window.google?.maps?.OverlayView?.preventMapHitsFrom?.(el);
  // 防止卡片上的點擊與滾動冒泡至 Google Map 底層
  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick'].forEach(
    (evtName) => {
      el.addEventListener(evtName, (ev) => ev.stopPropagation());
    }
  );

  el.querySelector('.btn-close-poi-card')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (typeof onClose === 'function') onClose();
  });

  el.querySelector('.btn-add-basemap-poi')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (typeof onAdd === 'function') onAdd();
  });

  return overlay;
}
