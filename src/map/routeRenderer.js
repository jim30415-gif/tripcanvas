import L from 'leaflet';
import { TRANSPORT_MODES } from '../config/constants.js';
import { getTransportDisplayInfo, hasSegmentedTransit } from '../state/selectors.js';
import { getCachedRoute } from '../services/routeManager.js';
import { decodePolyline, getPolylineMidpoint } from '../services/polyline.js';
import { calcDistanceKm, generateCurvedPath } from '../utils/geo.js';
import { escapeHTML, formatDistanceMetersZh, formatDurationZh } from '../utils/format.js';

/**
 * 判斷 hex 顏色是否過淺（避免白色或極淺黃色在淺底地圖上看不清楚）
 */
function pickReadableLineColor(lineColor, fallbackColor) {
  if (!lineColor || !/^#[0-9A-Fa-f]{6}$/.test(lineColor)) return fallbackColor;
  const r = parseInt(lineColor.slice(1, 3), 16);
  const g = parseInt(lineColor.slice(3, 5), 16);
  const b = parseInt(lineColor.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.82 ? fallbackColor : lineColor;
}

/**
 * 當標點位於公園／廣場內部（距道路吸附點 20m~400m）時，補上輕量接入虛線銜接標點與道路端點，不橫越街區
 */
function drawPinAccessConnector(overlayGroup, pin, roadEndpoint, isActive) {
  const gapKm = calcDistanceKm(pin.lat, pin.lng, roadEndpoint[0], roadEndpoint[1]);
  if (gapKm > 0.02 && gapKm < 0.45) {
    L.polyline([[pin.lat, pin.lng], roadEndpoint], {
      color: '#786454',
      weight: 2.2,
      opacity: isActive ? 0.5 : 0.3,
      dashArray: '2, 5',
      lineCap: 'round',
      interactive: false,
    }).addTo(overlayGroup);
  }
}

/**
 * 繪製 Google Routes API 回傳的分段大眾運輸路徑：
 * 「步行實景虛線 → 上車站點 → 官方代表色實線軌道／公車路徑 → 下車／轉乘站點 → 步行實景虛線」
 */
function drawSegmentedTransitRoute(overlayGroup, day, pinA, pinB, t, info, isActive, openEdit) {
  const allPoints = [];
  let primaryTransitCoords = null;
  let longestTransitLen = 0;

  t.segments.forEach((seg) => {
    const coords = decodePolyline(seg.encodedPolyline);
    if (coords.length >= 2) {
      allPoints.push(...coords);
    }

    if (seg.type === 'WALK') {
      if (coords.length < 2) return;

      // 步行段：貼合實際人行道與街巷的暖咖細圓點虛線
      L.polyline(coords, {
        color: '#FFFDF9',
        weight: 6.4,
        opacity: isActive ? 0.85 : 0.48,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      }).addTo(overlayGroup);

      const walkLine = L.polyline(coords, {
        color: isActive ? '#6B513A' : '#8C7866',
        weight: 3.4,
        opacity: isActive ? 0.92 : 0.58,
        dashArray: '1, 7',
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(overlayGroup);

      const distText = formatDistanceMetersZh(seg.distanceMeters);
      walkLine.bindTooltip(
        `🚶 步行約 ${formatDurationZh(seg.durationMin)}${distText ? `（${distText}）` : ''}`,
        { sticky: true, className: 'transit-stop-tooltip', direction: 'top', offset: [0, -6] }
      );
      walkLine.on('click', openEdit);
      return;
    }

    // TRANSIT 段：貼合實際捷運軌道／鐵路／公車路線，優先使用官方路線代表色
    const segColor = pickReadableLineColor(seg.lineColor, day.color);
    const transitCoords =
      coords.length >= 2
        ? coords
        : seg.departureStop?.lat != null && seg.arrivalStop?.lat != null
          ? [
              [seg.departureStop.lat, seg.departureStop.lng],
              [seg.arrivalStop.lat, seg.arrivalStop.lng],
            ]
          : [];

    if (transitCoords.length >= 2) {
      if (transitCoords.length > longestTransitLen) {
        longestTransitLen = transitCoords.length;
        primaryTransitCoords = transitCoords;
      }

      L.polyline(transitCoords, {
        color: '#FFFDF9',
        weight: 8.2,
        opacity: isActive ? 0.94 : 0.55,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      }).addTo(overlayGroup);

      const transitLine = L.polyline(transitCoords, {
        color: segColor,
        weight: 4.8,
        opacity: isActive ? 0.96 : 0.62,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(overlayGroup);

      const tipParts = [
        `${seg.vehicleEmoji || '🚆'} ${seg.displayLine || '大眾運輸'}`,
        seg.headsign ? `往 ${seg.headsign}` : '',
        seg.stopCount ? `${seg.stopCount} 站` : '',
        formatDurationZh(seg.durationMin),
      ].filter(Boolean);
      transitLine.bindTooltip(tipParts.join(' · '), {
        sticky: true,
        className: 'transit-stop-tooltip',
        direction: 'top',
        offset: [0, -6],
      });
      transitLine.on('click', openEdit);
    }

    // 繪製上下車站點小圓點標記
    const stops = [
      { role: '上車', stop: seg.departureStop },
      { role: '下車', stop: seg.arrivalStop },
    ];
    stops.forEach(({ role, stop }) => {
      if (!stop || stop.lat == null || stop.lng == null) return;
      const dot = L.circleMarker([stop.lat, stop.lng], {
        radius: isActive ? 5.2 : 4.2,
        color: segColor,
        weight: 2.8,
        fillColor: '#FFFDF9',
        fillOpacity: 1,
        opacity: isActive ? 1 : 0.72,
      }).addTo(overlayGroup);

      const timeSuffix = stop.timeText ? ` (${stop.timeText})` : '';
      dot.bindTooltip(
        `${seg.vehicleEmoji || '🚆'} ${role}：${escapeHTML(stop.name || '站點')}${escapeHTML(timeSuffix)}`,
        { className: 'transit-stop-tooltip', direction: 'top', offset: [0, -6] }
      );
      dot.on('click', openEdit);
    });
  });

  // 起終點與路網微距銜接
  if (allPoints.length >= 2) {
    drawPinAccessConnector(overlayGroup, pinA, allPoints[0], isActive);
    drawPinAccessConnector(overlayGroup, pinB, allPoints[allPoints.length - 1], isActive);
  }

  // 在主乘車段（或整段路線）的幾何中點放置大眾運輸分段摘要膠囊
  const anchorCoords = primaryTransitCoords || (allPoints.length >= 2 ? allPoints : [[pinA.lat, pinA.lng], [pinB.lat, pinB.lng]]);
  const midPt = getPolylineMidpoint(anchorCoords);
  if (!midPt) return;

  const transitBadges = t.segments
    .filter((s) => s.type === 'TRANSIT')
    .slice(0, 2)
    .map((s) => {
      const bg = pickReadableLineColor(s.lineColor, day.color);
      return `<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-extrabold leading-none text-white" style="background:${bg};">${escapeHTML(s.displayLine)}</span>`;
    })
    .join('<span class="text-owl-muted text-[10px]">›</span>');

  const durStr = formatDurationZh(t.duration);
  const pillHtml = `
    <div class="route-pill-marker inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#FBF8F3]/96 backdrop-blur-sm shadow-float border text-[11px] font-bold text-[#3A2C21] whitespace-nowrap cursor-pointer" style="border-color:${day.color}; transform: translate(-50%, -50%);">
      <span class="text-xs leading-none">${info.emoji}</span>
      ${transitBadges || `<span>${escapeHTML(info.mapPill)}</span>`}
      ${transitBadges && durStr ? `<span class="text-[10.5px] font-extrabold text-[#6B513A] tabular-nums-strict">${escapeHTML(durStr)}</span>` : ''}
    </div>
  `;

  const pillMarker = L.marker(midPt, {
    icon: L.divIcon({ html: pillHtml, className: 'route-label-icon', iconSize: [0, 0], iconAnchor: [0, 0] }),
    zIndexOffset: isActive ? 430 : 95,
  }).addTo(overlayGroup);

  pillMarker.on('click', openEdit);
}

/**
 * 繪製單段點對點路徑：
 * - 陸路交通：嚴格使用真實道路 encodedPolyline 繪製，查詢中或失敗不再以弧線假裝真實道路
 * - 大眾運輸：優先繪製 Google 分段「步行 → 乘車（官方色＋站點） → 步行」；手動紀錄維持柔和虛線示意
 */
export function drawRouteSegmentOnMap(overlayGroup, day, pinA, pinB, pinIdx, isActive, onOpenTransportModal) {
  const t = pinA.transportToNext;
  if (!t) return;

  const modeMeta = TRANSPORT_MODES[t.mode] || TRANSPORT_MODES.car;
  const info = getTransportDisplayInfo(t);
  const openEdit = (ev) => {
    L.DomEvent.stopPropagation(ev);
    if (typeof onOpenTransportModal === 'function') {
      onOpenTransportModal(day.id, pinIdx);
    }
  };

  // A. Google Routes API 分段大眾運輸（步行 → 大眾運輸實際路線與站點 → 步行）
  if (t.mode === 'transit' && hasSegmentedTransit(t)) {
    drawSegmentedTransitRoute(overlayGroup, day, pinA, pinB, t, info, isActive, openEdit);
    return;
  }

  // B. 不支援陸路／無班次／無法連線：誠實淡灰細虛線＋灰色提示膠囊
  if (info.kind === 'unsupported' || info.kind === 'network_error') {
    const dashCoords = generateCurvedPath(pinA.lat, pinA.lng, pinB.lat, pinB.lng);
    const faintLine = L.polyline(dashCoords, {
      color: '#9A8C7F',
      weight: 2.2,
      opacity: isActive ? 0.55 : 0.35,
      dashArray: '4, 7',
      lineCap: 'round',
    }).addTo(overlayGroup);

    const midPt = getPolylineMidpoint(dashCoords);
    const pillHtml = `
      <div class="route-pill-marker inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#F3EFEA]/95 border border-[#C9BEB2] shadow-sm text-[11px] font-bold text-[#6F6257] whitespace-nowrap cursor-pointer" style="transform: translate(-50%, -50%);">
        <span>${escapeHTML(info.mapPill)}</span>
      </div>
    `;
    const pillMarker = L.marker(midPt, {
      icon: L.divIcon({ html: pillHtml, className: 'route-label-icon', iconSize: [0, 0], iconAnchor: [0, 0] }),
      zIndexOffset: isActive ? 410 : 80,
    }).addTo(overlayGroup);

    faintLine.on('click', openEdit);
    pillMarker.on('click', openEdit);
    return;
  }

  // C. 手動紀錄大眾運輸（尚未透過 Google Routes 自動查詢）：柔和虛線示意
  if (t.mode === 'transit' && info.kind !== 'pending') {
    const transitCoords = generateCurvedPath(pinA.lat, pinA.lng, pinB.lat, pinB.lng);
    L.polyline(transitCoords, {
      color: '#FFFDF9',
      weight: 6.5,
      opacity: isActive ? 0.88 : 0.55,
      dashArray: '6, 8',
      lineCap: 'round',
      interactive: false,
    }).addTo(overlayGroup);

    const mainLine = L.polyline(transitCoords, {
      color: day.color,
      weight: 3.6,
      opacity: isActive ? 0.88 : 0.55,
      dashArray: '6, 8',
      lineCap: 'round',
    }).addTo(overlayGroup);

    const midPt = getPolylineMidpoint(transitCoords);
    const isEmpty = info.kind === 'transit-empty';
    const pillHtml = `
      <div class="route-pill-marker inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ${isEmpty ? 'bg-[#F5EFE6]/95 text-[#786454] border-[#CBBBA8]' : 'bg-[#FBF8F3]/95 text-[#3A2C21]'} backdrop-blur-sm shadow-float border text-[11px] font-bold whitespace-nowrap cursor-pointer" style="${isEmpty ? '' : `border-color:${day.color};`} transform: translate(-50%, -50%);">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${day.color}; opacity:${isEmpty ? 0.55 : 1};"></span>
        <span>${escapeHTML(info.mapPill)}</span>
      </div>
    `;
    const pillMarker = L.marker(midPt, {
      icon: L.divIcon({ html: pillHtml, className: 'route-label-icon', iconSize: [0, 0], iconAnchor: [0, 0] }),
      zIndexOffset: isActive ? 420 : 90,
    }).addTo(overlayGroup);

    mainLine.on('click', openEdit);
    pillMarker.on('click', openEdit);
    return;
  }

  // D. 陸路交通（汽車 / 機車 / 自行車 / 步行）：僅在取得真實道路幾何時繪製實景道路線
  const persistedPolyline = t.encodedPolyline || getCachedRoute(t.mode, pinA, pinB)?.encodedPolyline || '';
  const roadCoords = persistedPolyline ? decodePolyline(persistedPolyline) : [];
  const hasRealCoords = roadCoords.length >= 2;

  if (!hasRealCoords) {
    // 尚在查詢實際路網中：僅顯示極淡細虛線與查詢中膠囊，絕不以彩色粗弧線橫越街區
    const guideCoords = [
      [pinA.lat, pinA.lng],
      [pinB.lat, pinB.lng],
    ];
    const guideLine = L.polyline(guideCoords, {
      color: '#A08D7C',
      weight: 2,
      opacity: isActive ? 0.35 : 0.2,
      dashArray: '3, 7',
      lineCap: 'round',
    }).addTo(overlayGroup);

    const midPt = getPolylineMidpoint(guideCoords);
    const pillHtml = `
      <div class="route-pill-marker inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#FBF8F3]/92 border border-[#D8C7B4] shadow-sm text-[11px] font-bold text-[#786454] whitespace-nowrap cursor-pointer" style="transform: translate(-50%, -50%);">
        <span>${escapeHTML(info.mapPill)}</span>
      </div>
    `;
    const pillMarker = L.marker(midPt, {
      icon: L.divIcon({ html: pillHtml, className: 'route-label-icon', iconSize: [0, 0], iconAnchor: [0, 0] }),
      zIndexOffset: isActive ? 415 : 85,
    }).addTo(overlayGroup);

    guideLine.on('click', openEdit);
    pillMarker.on('click', openEdit);
    return;
  }

  // 繪製完全貼合道路的折線（白米色外框光暈＋天數主題色主線）
  L.polyline(roadCoords, {
    color: '#FFFDF9',
    weight: modeMeta.weight + 3.2,
    opacity: isActive ? 0.92 : 0.58,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false,
  }).addTo(overlayGroup);

  const mainLine = L.polyline(roadCoords, {
    color: day.color,
    weight: modeMeta.weight,
    opacity: isActive ? 0.96 : 0.62,
    dashArray: modeMeta.dashArray,
    lineCap: 'round',
    lineJoin: 'round',
  }).addTo(overlayGroup);

  // 若標點位於公園／建築內，補上極輕量短接入點線
  drawPinAccessConnector(overlayGroup, pinA, roadCoords[0], isActive);
  drawPinAccessConnector(overlayGroup, pinB, roadCoords[roadCoords.length - 1], isActive);

  const midPt = getPolylineMidpoint(roadCoords);
  const pillHtml = `
    <div class="route-pill-marker inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#FBF8F3]/95 backdrop-blur-sm shadow-float border text-[11px] font-bold text-[#3A2C21] whitespace-nowrap cursor-pointer" style="border-color: ${day.color}; transform: translate(-50%, -50%);">
      <span class="w-2 h-2 rounded-full shrink-0" style="background:${day.color};"></span>
      <span>${escapeHTML(info.mapPill)}</span>
    </div>
  `;
  const pillMarker = L.marker(midPt, {
    icon: L.divIcon({ html: pillHtml, className: 'route-label-icon', iconSize: [0, 0], iconAnchor: [0, 0] }),
    zIndexOffset: isActive ? 420 : 90,
  }).addTo(overlayGroup);

  mainLine.on('click', openEdit);
  pillMarker.on('click', openEdit);
}
