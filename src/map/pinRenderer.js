import L from 'leaflet';
import { escapeHTML, renderImageContent } from '../utils/format.js';

export function renderDayPinsOnMap(overlayGroup, day, isActive, onPinClick) {
  const color = day.color;

  day.pins.forEach((pin, idx) => {
    const hasImg = Boolean(pin.image);
    const markerHtml = hasImg
      ? `
        <div class="pin-marker-wrap flex flex-col items-center cursor-pointer" style="transform: translate(-50%, -88%);">
          <div class="relative p-1 rounded-2xl bg-[#FFFDF9] shadow-float" style="border: 3px solid ${color};">
            <div class="w-12 h-12 rounded-xl overflow-hidden bg-[#F5EFE6]">
              ${renderImageContent(pin.image, 'w-full h-full')}
            </div>
            <span class="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full text-white text-[11px] font-extrabold flex items-center justify-center shadow-md ring-2 ring-[#FFFDF9]" style="background:${color};">
              ${idx + 1}
            </span>
          </div>
          <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[7px] -mt-[1px]" style="border-top-color:${color};"></div>
          <div class="mt-0.5 px-2 py-0.5 rounded-lg bg-[#FBF8F3]/95 backdrop-blur-xs border border-[#E2D6C5] shadow-sm text-[11px] font-extrabold text-[#3A2C21] whitespace-nowrap max-w-[145px] truncate">
            ${escapeHTML(pin.name)}
          </div>
        </div>
      `
      : `
        <div class="pin-marker-wrap flex flex-col items-center cursor-pointer" style="transform: translate(-50%, -88%);">
          <div class="relative w-9 h-9 rounded-full text-white text-xs font-extrabold flex items-center justify-center shadow-float" style="background:${color}; border: 2.5px solid #FFFDF9;">
            ${idx + 1}
          </div>
          <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] -mt-[2px]" style="border-top-color:${color};"></div>
          <div class="mt-0.5 px-2 py-0.5 rounded-lg bg-[#FBF8F3]/95 backdrop-blur-xs border border-[#E2D6C5] shadow-sm text-[11px] font-extrabold text-[#3A2C21] whitespace-nowrap max-w-[145px] truncate">
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

    const marker = L.marker([pin.lat, pin.lng], {
      icon,
      zIndexOffset: isActive ? 500 + idx : 100 + idx,
    });

    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (typeof onPinClick === 'function') {
        onPinClick(day.id, pin.id);
      }
    });

    marker.addTo(overlayGroup);
  });
}
