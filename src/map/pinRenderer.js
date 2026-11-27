import { escapeHTML, renderImageContent, sanitizeHexColor } from '../utils/format.js';
import { getGoogleProjection, getLeafletLib, getMap } from './mapInit.js';
import { createGoogleHtmlOverlay } from './googleEngine.js';

const LONG_PRESS_MOUSE_MS = 280;
const LONG_PRESS_TOUCH_MS = 420;
let lastPinDragEndedAt = 0;
let activeRepositionCount = 0;

export function wasPinRecentlyDragged() {
  return Date.now() - lastPinDragEndedAt < 450;
}

export function isPinRepositioning() {
  return activeRepositionCount > 0;
}

function buildPinMarkerHtml(pin, idx, rawColor) {
  const color = sanitizeHexColor(rawColor);
  const hasImg = Boolean(pin.image);
  return hasImg
    ? `
      <div class="pin-marker-wrap select-none flex flex-col items-center cursor-pointer" style="transform: translate(-50%, -88%);">
        <span class="pin-drag-hint hidden mb-1 px-2.5 py-0.5 rounded-full bg-owl-darkTop/95 text-owl-cream text-[11px] font-bold shadow-md whitespace-nowrap">拖曳調整位置</span>
        <div class="pin-bubble-frame relative p-1 rounded-2xl bg-owl-card shadow-float" style="border: 3px solid ${color};">
          <div class="w-12 h-12 rounded-xl overflow-hidden bg-owl-canvas">
            ${renderImageContent(pin.image, 'w-full h-full')}
          </div>
          <span class="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full text-white text-xs font-extrabold flex items-center justify-center shadow-md ring-2 ring-owl-card" style="background:${color};">
            ${idx + 1}
          </span>
        </div>
        <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[7px] -mt-[1px]" style="border-top-color:${color};"></div>
        <div class="mt-0.5 px-2.5 py-0.5 rounded-lg bg-owl-panel/95 backdrop-blur-xs border border-owl-border shadow-sm text-xs font-extrabold text-owl-text whitespace-nowrap max-w-[165px] truncate">
          ${escapeHTML(pin.name)}
        </div>
      </div>
    `
    : `
      <div class="pin-marker-wrap select-none flex flex-col items-center cursor-pointer" style="transform: translate(-50%, -88%);">
        <span class="pin-drag-hint hidden mb-1 px-2.5 py-0.5 rounded-full bg-owl-darkTop/95 text-owl-cream text-[11px] font-bold shadow-md whitespace-nowrap">拖曳調整位置</span>
        <div class="pin-bubble-frame relative w-9 h-9 rounded-full text-white text-xs font-extrabold flex items-center justify-center shadow-float ring-[2.5px] ring-owl-card" style="background:${color};">
          ${idx + 1}
        </div>
        <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] -mt-[1px]" style="border-top-color:${color};"></div>
        <div class="mt-0.5 px-2.5 py-0.5 rounded-lg bg-owl-panel/95 backdrop-blur-xs border border-owl-border shadow-sm text-xs font-extrabold text-owl-text whitespace-nowrap max-w-[165px] truncate">
          ${escapeHTML(pin.name)}
        </div>
      </div>
    `;
}

/**
 * 跨引擎通用的長按標點拖曳移位互動（電腦滑鼠 280ms／手機觸控 420ms，防圖片原生拖放與地圖誤移）
 */
function bindPinInteractions(el, adapter, { day, pin, baseZIndex, bindDomClick, onPinClick, onPinMove }) {
  if (!el) return null;

  let suppressNextClick = false;

  const handleTapClick = (ev) => {
    if (ev?.stopPropagation) ev.stopPropagation();
    if (suppressNextClick || wasPinRecentlyDragged()) {
      suppressNextClick = false;
      return;
    }
    if (typeof onPinClick === 'function') {
      onPinClick(day.id, pin.id);
    }
  };

  if (bindDomClick) {
    el.addEventListener('click', handleTapClick);
  }

  // 阻止瀏覽器原生圖片拖放、文字反白、雙擊縮放與右鍵選單干擾標點長按移位
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  el.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
  });
  el.addEventListener('dragstart', (ev) => {
    ev.preventDefault();
  });
  el.addEventListener('selectstart', (ev) => {
    ev.preventDefault();
  });
  el.addEventListener('mousedown', (ev) => {
    if (ev.button === 0) {
      ev.stopPropagation();
    }
  });

  if (typeof onPinMove !== 'function') {
    return {
      shouldSuppressClick: () => suppressNextClick,
      clearSuppress: () => (suppressNextClick = false),
      destroy: () => {},
    };
  }

  let pressTimer = null;
  let isRepositioning = false;
  let activePointerId = null;
  let activePointerType = 'mouse';
  let startX = 0;
  let startY = 0;
  let mapRect = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let movedDuringDrag = false;
  let prevBodyUserSelect = '';
  let prevBodyCursor = '';

  const blockTouchScroll = (ev) => {
    if (isRepositioning && ev.cancelable) ev.preventDefault();
  };

  const clearPressTimer = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  const detachWindowListeners = () => {
    window.removeEventListener('pointermove', onPointerMove, { capture: true });
    window.removeEventListener('pointerup', onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', onPointerCancel, { capture: true });
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('touchmove', blockTouchScroll);
  };

  const finishReposition = (commit, { skipResetPos = false } = {}) => {
    clearPressTimer();
    detachWindowListeners();

    if (!isRepositioning) {
      activePointerId = null;
      return;
    }
    isRepositioning = false;
    activeRepositionCount = Math.max(0, activeRepositionCount - 1);
    activePointerId = null;
    lastPinDragEndedAt = Date.now();
    suppressNextClick = true;

    const wrap = el.querySelector('.pin-marker-wrap');
    wrap?.classList.remove('pin-repositioning');
    el.querySelector('.pin-drag-hint')?.classList.add('hidden');
    el.style.touchAction = '';
    document.body.style.userSelect = prevBodyUserSelect;
    document.body.style.cursor = prevBodyCursor;
    adapter.setZIndex(baseZIndex);
    adapter.setMapDraggable(true);

    if (commit && movedDuringDrag) {
      const finalLatLng = adapter.getLatLng();
      onPinMove(day.id, pin.id, finalLatLng.lat, finalLatLng.lng);
    } else if (!commit && !skipResetPos) {
      adapter.setLatLng(pin.lat, pin.lng);
    }
  };

  const onWindowBlur = () => {
    finishReposition(false);
  };

  const onPointerMove = (e) => {
    if (e.pointerId !== activePointerId) return;
    if (!isRepositioning) {
      const jitterLimit = activePointerType === 'mouse' ? 14 : 9;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > jitterLimit) {
        clearPressTimer();
        detachWindowListeners();
        activePointerId = null;
      }
      return;
    }

    e.preventDefault();
    movedDuringDrag = true;
    const x = e.clientX - mapRect.left + dragOffsetX;
    const y = e.clientY - mapRect.top + dragOffsetY;
    const nextLatLng = adapter.containerPointToLatLng(x, y);
    if (nextLatLng) {
      adapter.setLatLng(nextLatLng.lat, nextLatLng.lng);
    }
  };

  const onPointerUp = (e) => {
    if (e.pointerId !== activePointerId) return;
    finishReposition(true);
  };

  const onPointerCancel = (e) => {
    if (e.pointerId !== activePointerId) return;
    finishReposition(false);
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // 防多指重複覆寫 activePointerId 導致拖曳與 body 鎖死
    if (activePointerId !== null || isRepositioning) return;
    if (e.pointerType === 'mouse') {
      e.stopPropagation();
    }
    activePointerId = e.pointerId;
    activePointerType = e.pointerType || 'mouse';
    startX = e.clientX;
    startY = e.clientY;
    movedDuringDrag = false;
    suppressNextClick = false;

    const holdDelay = activePointerType === 'mouse' ? LONG_PRESS_MOUSE_MS : LONG_PRESS_TOUCH_MS;

    clearPressTimer();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      mapRect = adapter.getMapRect();
      const cur = adapter.getLatLng();
      const pinPt = adapter.latLngToContainerPoint(cur.lat, cur.lng);
      if (!mapRect || !pinPt) {
        detachWindowListeners();
        activePointerId = null;
        return;
      }

      isRepositioning = true;
      activeRepositionCount++;
      if (navigator.vibrate) navigator.vibrate(35);

      dragOffsetX = pinPt.x - (startX - mapRect.left);
      dragOffsetY = pinPt.y - (startY - mapRect.top);

      adapter.setMapDraggable(false);
      prevBodyUserSelect = document.body.style.userSelect;
      prevBodyCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
      window.addEventListener('touchmove', blockTouchScroll, { passive: false });
      el.style.touchAction = 'none';
      adapter.setZIndex(2400);
      const wrap = el.querySelector('.pin-marker-wrap');
      wrap?.classList.add('pin-repositioning');
      el.querySelector('.pin-drag-hint')?.classList.remove('hidden');
    }, holdDelay);

    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
    window.addEventListener('pointerup', onPointerUp, { capture: true });
    window.addEventListener('pointercancel', onPointerCancel, { capture: true });
    window.addEventListener('blur', onWindowBlur);
  });

  return {
    shouldSuppressClick: () => suppressNextClick,
    clearSuppress: () => {
      suppressNextClick = false;
    },
    destroy: () => {
      finishReposition(false, { skipResetPos: true });
    },
  };
}

export function renderDayPinsOnMap(overlayGroup, day, isActive, onPinClick, onPinMove) {
  const color = sanitizeHexColor(day.color);
  const map = getMap();
  const isGoogle = Boolean(overlayGroup?.isGoogle);
  const L = isGoogle ? null : getLeafletLib();
  if (!isGoogle && !L) return;

  day.pins.forEach((pin, idx) => {
    const markerHtml = buildPinMarkerHtml(pin, idx, color);
    const baseZIndex = isActive ? 500 + idx : 100 + idx;

    if (isGoogle) {
      const gMap = overlayGroup.map;
      const proj = getGoogleProjection();
      const overlay = overlayGroup.add(
        createGoogleHtmlOverlay(gMap, {
          lat: pin.lat,
          lng: pin.lng,
          html: markerHtml,
          className: 'custom-pin-icon',
          zIndex: baseZIndex,
          pane: 'overlayMouseTarget',
        })
      );
      const el = overlay.getElement();
      window.google?.maps?.OverlayView?.preventMapHitsFrom?.(el);

      const dragState = bindPinInteractions(
        el,
        {
          getMapRect: () => gMap.getDiv()?.getBoundingClientRect() || null,
          getLatLng: () => overlay.getLatLng(),
          setLatLng: (la, ln) => overlay.setPosition(la, ln),
          latLngToContainerPoint: (la, ln) => proj?.latLngToContainerPoint(la, ln) || null,
          containerPointToLatLng: (x, y) => proj?.containerPointToLatLng(x, y) || null,
          setMapDraggable: (enabled) => gMap.setOptions({ draggable: enabled }),
          setZIndex: (z) => overlay.setZIndex(z),
        },
        { day, pin, baseZIndex, bindDomClick: true, onPinClick, onPinMove }
      );
      if (typeof overlay.setOnRemove === 'function') {
        overlay.setOnRemove(() => dragState?.destroy?.());
      }
      return;
    }

    // Leaflet 分支
    const icon = L.divIcon({
      html: markerHtml,
      className: 'custom-pin-icon',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });

    const marker = L.marker([pin.lat, pin.lng], {
      icon,
      zIndexOffset: baseZIndex,
    });
    marker.addTo(overlayGroup);

    const el = marker.getElement();
    const dragState = bindPinInteractions(
      el,
      {
        getMapRect: () => map?.getContainer()?.getBoundingClientRect() || null,
        getLatLng: () => marker.getLatLng(),
        setLatLng: (la, ln) => marker.setLatLng([la, ln]),
        latLngToContainerPoint: (la, ln) => map?.latLngToContainerPoint([la, ln]) || null,
        containerPointToLatLng: (x, y) => map?.containerPointToLatLng(L.point(x, y)) || null,
        setMapDraggable: (enabled) => {
          if (!map?.dragging) return;
          if (enabled && !map.dragging.enabled()) map.dragging.enable();
          if (!enabled && map.dragging.enabled()) map.dragging.disable();
        },
        setZIndex: (z) => marker.setZIndexOffset(z),
      },
      { day, pin, baseZIndex, bindDomClick: false, onPinClick, onPinMove }
    );

    marker.on('remove', () => {
      dragState?.destroy?.();
    });

    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (dragState?.shouldSuppressClick() || wasPinRecentlyDragged()) {
        dragState?.clearSuppress();
        return;
      }
      if (typeof onPinClick === 'function') {
        onPinClick(day.id, pin.id);
      }
    });
  });
}
