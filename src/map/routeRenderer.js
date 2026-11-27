import { TRANSPORT_MODES } from '../config/constants.js';
import { getTransportDisplayInfo, hasSegmentedTransit } from '../state/selectors.js';
import { getCachedRoute } from '../services/routeManager.js';
import { decodePolyline, getPolylineMidpoint } from '../services/polyline.js';
import { calcDistanceKm, generateCurvedPath } from '../utils/geo.js';
import {
  escapeHTML,
  formatDistanceMetersZh,
  formatDurationZh,
  pickReadableChipColor,
  sanitizeHexColor,
} from '../utils/format.js';
import { createGoogleHtmlOverlay } from './googleEngine.js';
import { getLeafletLib } from './mapInit.js';
import { isDarkTheme } from '../ui/theme.js';

function getRouteCasingColor() {
  return isDarkTheme() ? '#14181F' : '#FFFDF9';
}

function getStopDotFillColor() {
  return isDarkTheme() ? '#1C212A' : '#FFFDF9';
}

/**
 * 跨引擎折線繪製器（同步支援 Google Maps JS Polyline 與 Leaflet Polyline，包含點狀／短虛線樣式）
 */
function addPolyline(overlayGroup, coords, opts = {}, { onClick = null, tooltip = '', zIndex = 10 } = {}) {
  if (!Array.isArray(coords) || coords.length < 2) return null;

  if (overlayGroup?.isGoogle) {
    const gmaps = window.google?.maps;
    if (!gmaps) return null;
    const path = coords.map(([lat, lng]) => ({ lat, lng }));
    const interactive = opts.interactive !== false;
    const polyOpts = {
      path,
      map: overlayGroup.map,
      clickable: interactive && Boolean(onClick),
      zIndex,
    };

    if (opts.dashArray) {
      const parts = String(opts.dashArray)
        .split(/[,\s]+/)
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0);
      const dashLen = parts[0] || 4;
      const gapLen = parts[1] || 6;
      const isDot = dashLen <= 2.5;
      polyOpts.strokeOpacity = 0;
      polyOpts.icons = [
        {
          icon: isDot
            ? {
                path: gmaps.SymbolPath.CIRCLE,
                scale: Math.max(1.8, (opts.weight || 3) * 0.58),
                fillColor: opts.color || '#6B513A',
                fillOpacity: opts.opacity ?? 0.9,
                strokeOpacity: 0,
              }
            : {
                path: 'M 0,-1 0,1',
                strokeColor: opts.color || '#816448',
                strokeOpacity: opts.opacity ?? 0.9,
                strokeWeight: opts.weight || 3.6,
                scale: Math.max(2.4, Math.min(5, dashLen * 0.42)),
              },
          offset: '0',
          repeat: `${Math.round(dashLen + gapLen + (isDot ? 3 : 5))}px`,
        },
      ];
    } else {
      polyOpts.strokeColor = opts.color || '#816448';
      polyOpts.strokeWeight = opts.weight || 4;
      polyOpts.strokeOpacity = opts.opacity ?? 0.92;
    }

    const line = overlayGroup.add(new gmaps.Polyline(polyOpts));
    if (onClick) {
      line.addListener('click', (ev) => {
        if (ev?.stop) ev.stop();
        onClick(ev);
      });
    }
    return line;
  }

  // Leaflet 分支
  const L = getLeafletLib();
  if (!L) return null;
  const line = L.polyline(coords, opts).addTo(overlayGroup);
  if (tooltip) {
    line.bindTooltip(tooltip, {
      sticky: true,
      className: 'transit-stop-tooltip',
      direction: 'top',
      offset: [0, -6],
    });
  }
  if (onClick) {
    line.on('click', onClick);
  }
  return line;
}

/**
 * 跨引擎站點圓點繪製器
 */
function addStopDot(overlayGroup, lat, lng, { radius, color, opacity, tooltip, plainTitle, onClick }) {
  const fillColor = getStopDotFillColor();

  if (overlayGroup?.isGoogle) {
    const gmaps = window.google?.maps;
    if (!gmaps) return null;
    const dot = overlayGroup.add(
      new gmaps.Marker({
        position: { lat, lng },
        map: overlayGroup.map,
        zIndex: 60,
        title: plainTitle || '',
        icon: {
          path: gmaps.SymbolPath.CIRCLE,
          scale: radius + 0.6,
          strokeColor: color,
          strokeWeight: 2.8,
          strokeOpacity: opacity,
          fillColor,
          fillOpacity: 1,
        },
      })
    );
    if (onClick) {
      dot.addListener('click', (ev) => {
        if (ev?.stop) ev.stop();
        onClick(ev);
      });
    }
    return dot;
  }

  const L = getLeafletLib();
  if (!L) return null;
  const dot = L.circleMarker([lat, lng], {
    radius,
    color,
    weight: 2.8,
    fillColor,
    fillOpacity: 1,
    opacity,
  }).addTo(overlayGroup);
  if (tooltip) {
    dot.bindTooltip(tooltip, { className: 'transit-stop-tooltip', direction: 'top', offset: [0, -6] });
  }
  if (onClick) dot.on('click', onClick);
  return dot;
}

/**
 * 跨引擎路線摘要膠囊標記
 */
function addRoutePill(overlayGroup, midPt, pillHtml, zIndex, onClick) {
  if (!midPt) return null;

  if (overlayGroup?.isGoogle) {
    const overlay = overlayGroup.add(
      createGoogleHtmlOverlay(overlayGroup.map, {
        lat: midPt[0],
        lng: midPt[1],
        html: pillHtml,
        className: 'route-label-icon',
        zIndex,
        pane: 'overlayMouseTarget',
      })
    );
    const el = overlay.getElement();
    window.google?.maps?.OverlayView?.preventMapHitsFrom?.(el);
    ['mousedown', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick'].forEach((evtName) => {
      el.addEventListener(evtName, (ev) => ev.stopPropagation());
    });
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (typeof onClick === 'function') onClick(ev);
    });
    return overlay;
  }

  const L = getLeafletLib();
  if (!L) return null;
  const pillMarker = L.marker(midPt, {
    icon: L.divIcon({ html: pillHtml, className: 'route-label-icon', iconSize: [0, 0], iconAnchor: [0, 0] }),
    zIndexOffset: zIndex,
  }).addTo(overlayGroup);
  if (onClick) pillMarker.on('click', onClick);
  return pillMarker;
}

/**
 * 當標點位於公園／廣場內部（距道路吸附點 20m~400m）時，補上輕量接入虛線銜接標點與道路端點，不橫越街區
 */
function drawPinAccessConnector(overlayGroup, pin, roadEndpoint, isActive) {
  const gapKm = calcDistanceKm(pin.lat, pin.lng, roadEndpoint[0], roadEndpoint[1]);
  if (gapKm > 0.02 && gapKm < 0.45) {
    addPolyline(
      overlayGroup,
      [[pin.lat, pin.lng], roadEndpoint],
      {
        color: '#786454',
        weight: 2.2,
        opacity: isActive ? 0.5 : 0.3,
        dashArray: '2, 5',
        lineCap: 'round',
        interactive: false,
      },
      { zIndex: 8 }
    );
  }
}

/**
 * 繪製 Google Routes API 回傳的分段大眾運輸路徑：
 * 「步行實景虛線 → 上車站點 → 官方代表色實線軌道／公車路徑 → 下車／轉乘站點 → 步行實景虛線」
 */
function drawSegmentedTransitRoute(overlayGroup, day, safeDayColor, pinA, pinB, t, info, isActive, openEdit) {
  const allPoints = [];
  let primaryTransitCoords = null;
  let longestTransitLen = 0;
  const dark = isDarkTheme();
  const casingColor = getRouteCasingColor();

  t.segments.forEach((seg) => {
    const coords = decodePolyline(seg.encodedPolyline);
    if (coords.length >= 2) {
      allPoints.push(...coords);
    }

    if (seg.type === 'WALK') {
      if (coords.length < 2) return;

      // 步行段：貼合實際人行道與街巷的暖咖／暖金細圓點虛線
      addPolyline(
        overlayGroup,
        coords,
        {
          color: casingColor,
          weight: 6.4,
          opacity: isActive ? 0.85 : 0.48,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
        },
        { zIndex: 18 }
      );

      const distText = formatDistanceMetersZh(seg.distanceMeters);
      const walkTip = `🚶 步行約 ${escapeHTML(formatDurationZh(seg.durationMin))}${distText ? `（${escapeHTML(distText)}）` : ''}`;
      addPolyline(
        overlayGroup,
        coords,
        {
          color: dark
            ? isActive
              ? '#8AB4F8'
              : '#6F8EB8'
            : isActive
              ? '#6B513A'
              : '#8C7866',
          weight: 3.4,
          opacity: isActive ? 0.92 : 0.58,
          dashArray: '1, 7',
          lineCap: 'round',
          lineJoin: 'round',
        },
        {
          onClick: openEdit,
          tooltip: walkTip,
          zIndex: 20,
        }
      );
      return;
    }

    // TRANSIT 段：貼合實際捷運軌道／鐵路／公車路線，優先使用官方路線代表色
    const segColor = pickReadableChipColor(seg.lineColor, safeDayColor);
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

      addPolyline(
        overlayGroup,
        transitCoords,
        {
          color: casingColor,
          weight: 8.2,
          opacity: isActive ? 0.94 : 0.55,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
        },
        { zIndex: 24 }
      );

      const tipParts = [
        `${escapeHTML(seg.vehicleEmoji || '🚆')} ${escapeHTML(seg.displayLine || '大眾運輸')}`,
        seg.headsign ? `往 ${escapeHTML(seg.headsign)}` : '',
        seg.stopCount ? `${escapeHTML(String(seg.stopCount))} 站` : '',
        escapeHTML(formatDurationZh(seg.durationMin)),
      ].filter(Boolean);

      addPolyline(
        overlayGroup,
        transitCoords,
        {
          color: segColor,
          weight: 4.8,
          opacity: isActive ? 0.96 : 0.62,
          lineCap: 'round',
          lineJoin: 'round',
        },
        { onClick: openEdit, tooltip: tipParts.join(' · '), zIndex: 26 }
      );
    }

    // 繪製上下車站點小圓點標記
    const stops = [
      { role: '上車', stop: seg.departureStop },
      { role: '下車', stop: seg.arrivalStop },
    ];
    stops.forEach(({ role, stop }) => {
      if (!stop || stop.lat == null || stop.lng == null) return;
      const timeSuffix = stop.timeText ? ` (${stop.timeText})` : '';
      const plainTitle = `${seg.vehicleEmoji || '🚆'} ${role}：${stop.name || '站點'}${timeSuffix}`;
      addStopDot(overlayGroup, stop.lat, stop.lng, {
        radius: isActive ? 5.2 : 4.2,
        color: segColor,
        opacity: isActive ? 1 : 0.72,
        tooltip: `${escapeHTML(seg.vehicleEmoji || '🚆')} ${escapeHTML(role)}：${escapeHTML(stop.name || '站點')}${escapeHTML(timeSuffix)}`,
        plainTitle,
        onClick: openEdit,
      });
    });
  });

  // 起終點與路網微距銜接
  if (allPoints.length >= 2) {
    drawPinAccessConnector(overlayGroup, pinA, allPoints[0], isActive);
    drawPinAccessConnector(overlayGroup, pinB, allPoints[allPoints.length - 1], isActive);
  }

  // 在主乘車段（或整段路線）的幾何中點放置大眾運輸分段摘要膠囊
  const anchorCoords =
    primaryTransitCoords ||
    (allPoints.length >= 2
      ? allPoints
      : [
          [pinA.lat, pinA.lng],
          [pinB.lat, pinB.lng],
        ]);
  const midPt = getPolylineMidpoint(anchorCoords);
  if (!midPt) return;

  const transitBadges = t.segments
    .filter((s) => s.type === 'TRANSIT')
    .slice(0, 2)
    .map((s) => {
      const bg = pickReadableChipColor(s.lineColor, safeDayColor);
      return `<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-extrabold leading-none text-white" style="background:${bg};">${escapeHTML(s.displayLine)}</span>`;
    })
    .join('<span class="text-owl-muted text-[11px]">›</span>');

  const durStr = formatDurationZh(t.duration);
  const pillHtml = `
    <div class="route-pill-marker inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-owl-panel/95 backdrop-blur-sm shadow-float border text-xs font-bold text-owl-text whitespace-nowrap cursor-pointer" style="border-color:${safeDayColor}; transform: translate(-50%, -50%);">
      <span class="text-sm leading-none">${escapeHTML(info.emoji)}</span>
      ${transitBadges || `<span>${escapeHTML(info.mapPill)}</span>`}
      ${transitBadges && durStr ? `<span class="text-[11px] font-extrabold text-owl-primaryDeep tabular-nums-strict">${escapeHTML(durStr)}</span>` : ''}
    </div>
  `;

  addRoutePill(overlayGroup, midPt, pillHtml, isActive ? 430 : 95, openEdit);
}

/**
 * 繪製單段點對點路徑：
 * - 陸路交通：嚴格使用真實道路 encodedPolyline 繪製，查詢中或失敗不再以弧線假裝真實道路
 * - 大眾運輸：優先繪製 Google 分段「步行 → 乘車（官方色＋站點） → 步行」；手動紀錄維持柔和虛線示意
 */
export function drawRouteSegmentOnMap(overlayGroup, day, pinA, pinB, pinIdx, isActive, onOpenTransportModal) {
  const t = pinA.transportToNext;
  if (!t) return;

  const safeDayColor = sanitizeHexColor(day.color);
  const casingColor = getRouteCasingColor();
  const modeMeta = TRANSPORT_MODES[t.mode] || TRANSPORT_MODES.car;
  const info = getTransportDisplayInfo(t);
  const openEdit = (ev) => {
    if (!overlayGroup?.isGoogle && ev) {
      const L = getLeafletLib();
      if (L) L.DomEvent.stopPropagation(ev);
    }
    if (typeof onOpenTransportModal === 'function') {
      onOpenTransportModal(day.id, pinIdx);
    }
  };

  // A. Google Routes API 分段大眾運輸（步行 → 大眾運輸實際路線與站點 → 步行）
  if (t.mode === 'transit' && hasSegmentedTransit(t)) {
    drawSegmentedTransitRoute(overlayGroup, day, safeDayColor, pinA, pinB, t, info, isActive, openEdit);
    return;
  }

  // B. 不支援陸路／無班次／無法連線：誠實淡灰細虛線＋灰色提示膠囊
  if (info.kind === 'unsupported' || info.kind === 'network_error') {
    const dashCoords = generateCurvedPath(pinA.lat, pinA.lng, pinB.lat, pinB.lng);
    addPolyline(
      overlayGroup,
      dashCoords,
      {
        color: '#9A8C7F',
        weight: 2.2,
        opacity: isActive ? 0.55 : 0.35,
        dashArray: '4, 7',
        lineCap: 'round',
      },
      { onClick: openEdit, zIndex: 12 }
    );

    const midPt = getPolylineMidpoint(dashCoords);
    const pillHtml = `
      <div class="route-pill-marker inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-owl-softBg/95 border border-owl-border shadow-sm text-xs font-bold text-owl-subtext whitespace-nowrap cursor-pointer" style="transform: translate(-50%, -50%);">
        <span>${escapeHTML(info.mapPill)}</span>
      </div>
    `;
    addRoutePill(overlayGroup, midPt, pillHtml, isActive ? 410 : 80, openEdit);
    return;
  }

  // C. 手動紀錄大眾運輸：若有實際貼路折線（例如手動公車）沿真實馬路繪製，否則維持柔和虛線弧線示意
  if (t.mode === 'transit' && info.kind !== 'pending') {
    const snappedCoords = t.encodedPolyline ? decodePolyline(t.encodedPolyline) : [];
    const hasRoadPoly = snappedCoords.length >= 2;
    const transitCoords = hasRoadPoly
      ? snappedCoords
      : generateCurvedPath(pinA.lat, pinA.lng, pinB.lat, pinB.lng);

    if (hasRoadPoly) {
      addPolyline(
        overlayGroup,
        transitCoords,
        {
          color: casingColor,
          weight: 7.4,
          opacity: isActive ? 0.94 : 0.55,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
        },
        { zIndex: 20 }
      );

      addPolyline(
        overlayGroup,
        transitCoords,
        {
          color: safeDayColor,
          weight: 4.4,
          opacity: isActive ? 0.94 : 0.6,
          lineCap: 'round',
          lineJoin: 'round',
        },
        { onClick: openEdit, tooltip: escapeHTML(info.mapPill), zIndex: 22 }
      );

      drawPinAccessConnector(overlayGroup, pinA, transitCoords[0], isActive);
      drawPinAccessConnector(overlayGroup, pinB, transitCoords[transitCoords.length - 1], isActive);
    } else {
      addPolyline(
        overlayGroup,
        transitCoords,
        {
          color: casingColor,
          weight: 6.5,
          opacity: isActive ? 0.88 : 0.55,
          dashArray: '6, 8',
          lineCap: 'round',
          interactive: false,
        },
        { zIndex: 14 }
      );

      addPolyline(
        overlayGroup,
        transitCoords,
        {
          color: safeDayColor,
          weight: 3.6,
          opacity: isActive ? 0.88 : 0.55,
          dashArray: '6, 8',
          lineCap: 'round',
        },
        { onClick: openEdit, zIndex: 16 }
      );
    }

    const midPt = getPolylineMidpoint(transitCoords);
    const isEmpty = info.kind === 'transit-empty';
    const pillHtml = `
      <div class="route-pill-marker inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ${isEmpty ? 'bg-owl-softBg/95 text-owl-subtext border-owl-border' : 'bg-owl-panel/95 text-owl-text'} backdrop-blur-sm shadow-float border text-xs font-bold whitespace-nowrap cursor-pointer" style="${isEmpty ? '' : `border-color:${safeDayColor};`} transform: translate(-50%, -50%);">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${safeDayColor}; opacity:${isEmpty ? 0.55 : 1};"></span>
        <span>${escapeHTML(info.mapPill)}</span>
      </div>
    `;
    addRoutePill(overlayGroup, midPt, pillHtml, isActive ? 420 : 90, openEdit);
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
    addPolyline(
      overlayGroup,
      guideCoords,
      {
        color: '#A08D7C',
        weight: 2,
        opacity: isActive ? 0.35 : 0.2,
        dashArray: '3, 7',
        lineCap: 'round',
      },
      { onClick: openEdit, zIndex: 10 }
    );

    const midPt = getPolylineMidpoint(guideCoords);
    const pillHtml = `
      <div class="route-pill-marker inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-owl-panel/95 border border-owl-border shadow-sm text-xs font-bold text-owl-subtext whitespace-nowrap cursor-pointer" style="transform: translate(-50%, -50%);">
        <span>${escapeHTML(info.mapPill)}</span>
      </div>
    `;
    addRoutePill(overlayGroup, midPt, pillHtml, isActive ? 415 : 85, openEdit);
    return;
  }

  // 繪製完全貼合道路的折線（主題外框光暈＋天數主題色主線）
  addPolyline(
    overlayGroup,
    roadCoords,
    {
      color: casingColor,
      weight: modeMeta.weight + 3.2,
      opacity: isActive ? 0.92 : 0.58,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    },
    { zIndex: 18 }
  );

  addPolyline(
    overlayGroup,
    roadCoords,
    {
      color: safeDayColor,
      weight: modeMeta.weight,
      opacity: isActive ? 0.96 : 0.62,
      dashArray: modeMeta.dashArray,
      lineCap: 'round',
      lineJoin: 'round',
    },
    { onClick: openEdit, zIndex: 20 }
  );

  // 若標點位於公園／建築內，補上極輕量短接入點線
  drawPinAccessConnector(overlayGroup, pinA, roadCoords[0], isActive);
  drawPinAccessConnector(overlayGroup, pinB, roadCoords[roadCoords.length - 1], isActive);

  const midPt = getPolylineMidpoint(roadCoords);
  const pillHtml = `
    <div class="route-pill-marker inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-owl-panel/95 backdrop-blur-sm shadow-float border text-xs font-bold text-owl-text whitespace-nowrap cursor-pointer" style="border-color: ${safeDayColor}; transform: translate(-50%, -50%);">
      <span class="w-2 h-2 rounded-full shrink-0" style="background:${safeDayColor};"></span>
      <span>${escapeHTML(info.mapPill)}</span>
    </div>
  `;
  addRoutePill(overlayGroup, midPt, pillHtml, isActive ? 420 : 90, openEdit);
}
