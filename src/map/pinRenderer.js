import L from 'leaflet';
import { escapeHTML, renderImageContent } from '../utils/format.js';
import { getMap } from './mapInit.js';

const LONG_PRESS_MS = 420;
let lastPinDragEndedAt = 0;

export function wasPinRecentlyDragged() {
  return Date.now() - lastPinDragEndedAt < 420;
}

export function renderDayPinsOnMap(overlayGroup, day, isActive, onPinClick, onPinMove) {
  const color = day.color;
  const map = getMap();

  day.pins.forEach((pin, idx) => {
    const hasImg = Boolean(pin.image);
    const markerHtml = hasImg
      ? `
        <div class="pin-marker-wrap flex flex-col items-center cursor-pointer" style="transform: translate(-50%, -88%);">
          <span class="pin-drag-hint hidden mb-1 px-2.5 py-0.5 rounded-full bg-[#4A382B]/95 text-[#FAF4EC] text-[11px] font-bold shadow-md whitespace-nowrap">拖曳調整位置</span>
          <div class="pin-bubble-frame relative p-1 rounded-2xl bg-[#FFFDF9] shadow-float" style="border: 3px solid ${color};">
            <div class="w-12 h-12 rounded-xl overflow-hidden bg-[#F5EFE6]">
              ${renderImageContent(pin.image, 'w-full h-full')}
            </div>
            <span class="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full text-white text-xs font-extrabold flex items-center justify-center shadow-md ring-2 ring-[#FFFDF9]" style="background:${color};">
              ${idx + 1}
            </span>
          </div>
          <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[7px] -mt-[1px]" style="border-top-color:${color};"></div>
          <div class="mt-0.5 px-2.5 py-0.5 rounded-lg bg-[#FBF8F3]/95 backdrop-blur-xs border border-[#E2D6C5] shadow-sm text-xs font-extrabold text-[#3A2C21] whitespace-nowrap max-w-[165px] truncate">
            ${escapeHTML(pin.name)}
          </div>
        </div>
      `
      : `
        <div class="pin-marker-wrap flex flex-col items-center cursor-pointer" style="transform: translate(-50%, -88%);">
          <span class="pin-drag-hint hidden mb-1 px-2.5 py-0.5 rounded-full bg-[#4A382B]/95 text-[#FAF4EC] text-[11px] font-bold shadow-md whitespace-nowrap">拖曳調整位置</span>
          <div class="pin-bubble-frame relative w-9 h-9 rounded-full text-white text-xs font-extrabold flex items-center justify-center shadow-float" style="background:${color}; border: 2.5px solid #FFFDF9;">
            ${idx + 1}
          </div>
          <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] -mt-[2px]" style="border-top-color:${color};"></div>
          <div class="mt-0.5 px-2.5 py-0.5 rounded-lg bg-[#FBF8F3]/95 backdrop-blur-xs border border-[#E2D6C5] shadow-sm text-xs font-extrabold text-[#3A2C21] whitespace-nowrap max-w-[165px] truncate">
            ${escapeHTML(pin.name)}
          </div>
        </div>
      `;

    const icon = L.divIcon({
      html: markerHtml,
      className: 'custom-pin-icon',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });

    const baseZIndex = isActive ? 500 + idx : 100 + idx;
    const marker = L.marker([pin.lat, pin.lng], {
      icon,
      zIndexOffset: baseZIndex,
    });

    let suppressNextClick = false;

    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (suppressNextClick || wasPinRecentlyDragged()) {
        suppressNextClick = false;
        return;
      }
      if (typeof onPinClick === 'function') {
        onPinClick(day.id, pin.id);
      }
    });

    marker.addTo(overlayGroup);

    // 綁定長按標點調整位置（桌機滑鼠與手機觸控通用，不影響一般點擊或拖曳地圖）
    const el = marker.getElement();
    if (el && map && typeof onPinMove === 'function') {
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });

      let pressTimer = null;
      let isRepositioning = false;
      let activePointerId = null;
      let startX = 0;
      let startY = 0;
      let mapRect = null;
      let dragOffset = null;
      let movedDuringDrag = false;

      const blockTouchScroll = (ev) => {
        if (isRepositioning && ev.cancelable) ev.preventDefault();
      };

      const clearPressTimer = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };

      const finishReposition = (commit) => {
        clearPressTimer();
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('touchmove', blockTouchScroll);

        if (!isRepositioning) return;
        isRepositioning = false;
        activePointerId = null;
        lastPinDragEndedAt = Date.now();
        suppressNextClick = true;

        const wrap = el.querySelector('.pin-marker-wrap');
        wrap?.classList.remove('pin-repositioning');
        el.querySelector('.pin-drag-hint')?.classList.add('hidden');
        el.style.touchAction = '';
        marker.setZIndexOffset(baseZIndex);
        if (map.dragging && !map.dragging.enabled()) {
          map.dragging.enable();
        }

        if (commit && movedDuringDrag) {
          const finalLatLng = marker.getLatLng();
          onPinMove(day.id, pin.id, finalLatLng.lat, finalLatLng.lng);
        } else if (!commit) {
          marker.setLatLng([pin.lat, pin.lng]);
        }
      };

      const onPointerMove = (e) => {
        if (e.pointerId !== activePointerId) return;
        if (!isRepositioning) {
          if (Math.hypot(e.clientX - startX, e.clientY - startY) > 9) {
            clearPressTimer();
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerCancel);
            window.removeEventListener('touchmove', blockTouchScroll);
          }
          return;
        }

        e.preventDefault();
        movedDuringDrag = true;
        const containerPt = L.point(e.clientX - mapRect.left, e.clientY - mapRect.top).add(dragOffset);
        const nextLatLng = map.containerPointToLatLng(containerPt);
        marker.setLatLng(nextLatLng);
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
        activePointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        movedDuringDrag = false;
        suppressNextClick = false;

        clearPressTimer();
        pressTimer = setTimeout(() => {
          isRepositioning = true;
          if (navigator.vibrate) navigator.vibrate(35);

          mapRect = map.getContainer().getBoundingClientRect();
          const pinPt = map.latLngToContainerPoint(marker.getLatLng());
          const pointerPt = L.point(startX - mapRect.left, startY - mapRect.top);
          dragOffset = pinPt.subtract(pointerPt);

          if (map.dragging && !map.dragging.enabled()) {
            // already disabled
          } else if (map.dragging) {
            map.dragging.disable();
          }
          window.addEventListener('touchmove', blockTouchScroll, { passive: false });
          el.style.touchAction = 'none';
          marker.setZIndexOffset(2400);
          const wrap = el.querySelector('.pin-marker-wrap');
          wrap?.classList.add('pin-repositioning');
          el.querySelector('.pin-drag-hint')?.classList.remove('hidden');
        }, LONG_PRESS_MS);

        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerCancel);
      });
    }
  });
}
