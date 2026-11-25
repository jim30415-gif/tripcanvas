import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_MAP, TRANSPORT_MODES } from '../config/constants.js';
import { decodePolyline } from './polyline.js';
import { generateCurvedPath } from '../utils/geo.js';
import {
  calcPinExpense,
  calcTransportExpense,
  getTransportDisplayInfo,
  hasSegmentedTransit,
} from '../state/selectors.js';
import {
  escapeHTML,
  formatDurationZh,
  formatTWD,
  pickReadableChipColor,
  sanitizeHexColor,
} from '../utils/format.js';

/** 標準 A4 直式 150 DPI 輸出尺寸（210mm × 297mm，嚴格 1 : 1.4145 比例） */
export const A4_WIDTH = 1240;
export const A4_HEIGHT = 1754;

const FONT_STACK = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, -apple-system, sans-serif';

const BASE_MAP_CACHE = new Map();
const MAX_BASE_MAP_CACHE = 24;

// ==================== 1. Web Mercator 投影與視野計算（純函式，可供單元測試） ====================

export function latLngToWorldPx(lat, lng, zoom) {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, Number(lat) || 0));
  const siny = Math.min(Math.max(Math.sin((clampedLat * Math.PI) / 180), -0.9999), 0.9999);
  const scale = 256 * Math.pow(2, zoom);
  const x = scale * (0.5 + (Number(lng) || 0) / 360);
  const y = scale * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI));
  return [x, y];
}

export function worldYToLat(y, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * 依據一組座標計算最佳整數 zoom 與 Mercator 中心點，讓所有標點與路線完美落在安全邊距內
 */
export function computeMapViewport(points, cssWidth = 620, cssHeight = 248) {
  const valid = (points || []).filter(
    (p) =>
      p &&
      Number.isFinite(Number(p[0])) &&
      Number.isFinite(Number(p[1])) &&
      Math.abs(Number(p[0])) <= 85 &&
      Math.abs(Number(p[1])) <= 180
  );

  if (valid.length === 0) {
    return { centerLat: 25.033, centerLng: 121.5654, zoom: 12 };
  }
  if (valid.length === 1) {
    return { centerLat: Number(valid[0][0]), centerLng: Number(valid[0][1]), zoom: 15 };
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [la, ln] of valid) {
    const lat = Number(la);
    const lng = Number(ln);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  const centerLng = (minLng + maxLng) / 2;
  // 以 Mercator Y 中點換算 centerLat，高緯度上下留白才完全對稱
  const [, yTopRef] = latLngToWorldPx(maxLat, centerLng, 10);
  const [, yBotRef] = latLngToWorldPx(minLat, centerLng, 10);
  const centerLat = worldYToLat((yTopRef + yBotRef) / 2, 10);

  if (Math.abs(maxLat - minLat) < 1e-5 && Math.abs(maxLng - minLng) < 1e-5) {
    return { centerLat, centerLng, zoom: 15 };
  }

  const maxSpanX = cssWidth * 0.76;
  const maxSpanY = cssHeight * 0.72;
  let chosenZoom = 3;
  for (let z = 16; z >= 3; z--) {
    const [x1, y1] = latLngToWorldPx(maxLat, minLng, z);
    const [x2, y2] = latLngToWorldPx(minLat, maxLng, z);
    if (Math.abs(x2 - x1) <= maxSpanX && Math.abs(y2 - y1) <= maxSpanY) {
      chosenZoom = z;
      break;
    }
  }

  return { centerLat, centerLng, zoom: chosenZoom };
}

/**
 * 將經緯度精準投影至靜態地圖畫布像素座標（與 Google Maps Static API 及 Carto 圖磚完全一致）
 */
export function projectLatLngToMapPx(lat, lng, viewport, cssWidth, cssHeight, scale = 2) {
  const [cx, cy] = latLngToWorldPx(viewport.centerLat, viewport.centerLng, viewport.zoom);
  const [px, py] = latLngToWorldPx(lat, lng, viewport.zoom);
  return [(cssWidth / 2 + (px - cx)) * scale, (cssHeight / 2 + (py - cy)) * scale];
}

/**
 * 依目前中心緯度與 zoom 計算真實公尺比例尺（自動對齊 100m / 200m / 500m / 1km / 2km / 5km...）
 */
export function computeScaleBar(centerLat, zoom, scale = 2) {
  const metersPerCssPx = (156543.03392 * Math.cos((centerLat * Math.PI) / 180)) / Math.pow(2, zoom);
  const metersPerCanvasPx = metersPerCssPx / scale;
  const targetMeters = metersPerCanvasPx * 130;
  const steps = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
  let chosen = steps[steps.length - 1];
  for (const s of steps) {
    if (s >= targetMeters * 0.65) {
      chosen = s;
      break;
    }
  }
  const pxWidth = Math.max(54, Math.min(180, Math.round(chosen / metersPerCanvasPx)));
  const label = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
  return { meters: chosen, label, pxWidth };
}

// ==================== 2. 行程統計與 A4 自動分頁規劃（純函式） ====================

export function calcDaysSummaryStats(daysList) {
  const catTotals = {};
  EXPENSE_CATEGORIES.forEach((c) => {
    catTotals[c.id] = 0;
  });

  let pinCount = 0;
  let totalKm = 0;
  let totalDurationMin = 0;

  for (const day of daysList || []) {
    const pins = day?.pins || [];
    pinCount += pins.length;
    pins.forEach((pin, idx) => {
      for (const s of pin.subSpots || []) {
        const cost = Math.max(0, Math.round(Number(s.cost) || 0));
        const cat = EXPENSE_CATEGORY_MAP[s.category] ? s.category : 'other';
        catTotals[cat] += cost;
      }
      if (idx < pins.length - 1 && pin.transportToNext) {
        const t = pin.transportToNext;
        const tCost = calcTransportExpense(pin);
        if (tCost > 0) catTotals.transport += tCost;
        if (Number(t.distanceKm) > 0) totalKm += Number(t.distanceKm);
        if (Number(t.duration) > 0) totalDurationMin += Math.round(Number(t.duration));
      }
    });
  }

  const totalCost = Object.values(catTotals).reduce((a, b) => a + b, 0);
  return {
    pinCount,
    totalKm: Number(totalKm.toFixed(1)),
    totalDurationMin,
    totalCost,
    catTotals,
  };
}

export function sanitizeExportFilename(raw = '') {
  const cleaned = String(raw || '漫步地圖行程')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return (cleaned || '漫步地圖行程').slice(0, 60);
}

/**
 * 將單日行程切分為保證不溢出的標準 A4 頁面規格：
 * - 1~5 個標點：單欄寬版編輯風（1 頁 A4）
 * - 6~10 個標點：雙欄平衡排版（1 頁 A4）
 * - 11 個以上標點：自動切為多頁 A4（第 1 頁含地圖＋前 10 點，續頁每頁最多 12 點）
 */
export function planA4DayPages(day, { density = 'detailed' } = {}) {
  const pins = Array.isArray(day?.pins) ? day.pins : [];
  if (pins.length <= 5) {
    return [
      {
        kind: 'day',
        id: `${day.id}_p1`,
        dayId: day.id,
        day,
        pinStart: 0,
        pinEnd: pins.length,
        pageIndex: 1,
        pageTotal: 1,
        layout: 'single-col',
        includeMap: true,
        includeBudget: true,
        density,
      },
    ];
  }

  const firstPageCap = density === 'compact' ? 12 : 10;
  const nextPageCap = density === 'compact' ? 14 : 12;

  if (pins.length <= firstPageCap) {
    return [
      {
        kind: 'day',
        id: `${day.id}_p1`,
        dayId: day.id,
        day,
        pinStart: 0,
        pinEnd: pins.length,
        pageIndex: 1,
        pageTotal: 1,
        layout: 'two-col',
        includeMap: true,
        includeBudget: true,
        density,
      },
    ];
  }

  const chunks = [[0, firstPageCap]];
  let cursor = firstPageCap;
  while (cursor < pins.length) {
    const end = Math.min(pins.length, cursor + nextPageCap);
    chunks.push([cursor, end]);
    cursor = end;
  }

  return chunks.map(([start, end], idx) => ({
    kind: 'day',
    id: `${day.id}_p${idx + 1}`,
    dayId: day.id,
    day,
    pinStart: start,
    pinEnd: end,
    pageIndex: idx + 1,
    pageTotal: chunks.length,
    layout: 'two-col',
    includeMap: idx === 0,
    includeBudget: idx === chunks.length - 1,
    density,
  }));
}

/**
 * 規劃全行程 A4 總覽頁（每頁最多 6 天，超過自動分頁）
 */
export function planA4OverviewPages(days, { density = 'detailed' } = {}) {
  const list = Array.isArray(days) ? days : [];
  const perPage = 6;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const pages = [];
  for (let i = 0; i < totalPages; i++) {
    pages.push({
      kind: 'overview',
      id: `overview_p${i + 1}`,
      days: list.slice(i * perPage, (i + 1) * perPage),
      allDays: list,
      pageIndex: i + 1,
      pageTotal: totalPages,
      includeMap: i === 0,
      includeBudget: i === totalPages - 1,
      density,
    });
  }
  return pages;
}

/**
 * 產生整趟旅程的完整 A4 頁碼清單（全覽總圖 + 每日各頁）
 */
export function buildAllTripA4PageSpecs(state, { density = 'detailed' } = {}) {
  const days = Array.isArray(state?.days) ? state.days : [];
  const specs = [...planA4OverviewPages(days, { density })];
  for (const day of days) {
    specs.push(...planA4DayPages(day, { density }));
  }
  return specs;
}

// ==================== 3. 瀏覽器端真實底圖取得（Google Static API → Carto Voyager → 紙感備援） ====================

function loadHtmlImage(src, { crossOrigin = '' } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('IMAGE_LOAD_FAILED'));
    img.src = src;
  });
}

async function fetchGoogleStaticMap(viewport, cssW, cssH) {
  try {
    const res = await fetch('/api/routes?action=staticmap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: viewport.centerLat,
        lng: viewport.centerLng,
        zoom: viewport.zoom,
        width: cssW,
        height: cssH,
        language: 'zh-TW',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data?.status === 'ok' && typeof data.dataUrl === 'string' && data.dataUrl.startsWith('data:image/')) {
      const img = await loadHtmlImage(data.dataUrl);
      return { image: img, provider: 'google' };
    }
    return null;
  } catch {
    return null;
  }
}

async function stitchSlippyTileBaseMap(viewport, cssW, cssH, { provider, buildUrl, scale = 2 }) {
  const z = Math.min(18, Math.max(1, viewport.zoom));
  const maxTile = Math.pow(2, z);
  const [cx, cy] = latLngToWorldPx(viewport.centerLat, viewport.centerLng, z);
  const left = cx - cssW / 2;
  const top = cy - cssH / 2;
  const right = cx + cssW / 2;
  const bottom = cy + cssH / 2;

  const minTx = Math.floor(left / 256);
  const maxTx = Math.floor(right / 256);
  const minTy = Math.max(0, Math.floor(top / 256));
  const maxTy = Math.min(maxTile - 1, Math.floor(bottom / 256));

  const off = document.createElement('canvas');
  off.width = cssW * scale;
  off.height = cssH * scale;
  const ctx = off.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#E4ECEF';
  ctx.fillRect(0, 0, off.width, off.height);

  const tasks = [];
  for (let tx = minTx; tx <= maxTx; tx++) {
    for (let ty = minTy; ty <= maxTy; ty++) {
      const wrappedTx = ((tx % maxTile) + maxTile) % maxTile;
      const url = buildUrl(z, wrappedTx, ty);
      tasks.push(
        loadHtmlImage(url, { crossOrigin: 'anonymous' })
          .then((img) => ({ img, tx, ty }))
          .catch(() => null)
      );
    }
  }

  const results = await Promise.all(tasks);
  let loadedCount = 0;
  for (const r of results) {
    if (!r) continue;
    loadedCount++;
    const dx = Math.round((r.tx * 256 - left) * scale);
    const dy = Math.round((r.ty * 256 - top) * scale);
    ctx.drawImage(r.img, dx, dy, 256 * scale, 256 * scale);
  }

  if (loadedCount === 0) return null;
  return { image: off, provider };
}

function createOfflinePaperBaseMap(cssW, cssH, scale = 2) {
  const off = document.createElement('canvas');
  off.width = cssW * scale;
  off.height = cssH * scale;
  const ctx = off.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, off.width, off.height);
  grad.addColorStop(0, '#EBE6DC');
  grad.addColorStop(1, '#E2DACD');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, off.width, off.height);

  ctx.strokeStyle = 'rgba(130, 100, 71, 0.12)';
  ctx.lineWidth = 1;
  for (let x = 60; x < off.width; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, off.height);
    ctx.stroke();
  }
  for (let y = 60; y < off.height; y += 80) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(off.width, y);
    ctx.stroke();
  }
  return { image: off, provider: 'fallback' };
}

export async function fetchBaseMapImage(viewport, cssW, cssH) {
  const cacheKey = `${viewport.centerLat.toFixed(5)},${viewport.centerLng.toFixed(5)},${viewport.zoom},${cssW}x${cssH}`;
  if (BASE_MAP_CACHE.has(cacheKey)) {
    const hit = BASE_MAP_CACHE.get(cacheKey);
    BASE_MAP_CACHE.delete(cacheKey);
    BASE_MAP_CACHE.set(cacheKey, hit);
    return hit;
  }

  let result = await fetchGoogleStaticMap(viewport, cssW, cssH);
  if (!result) {
    result = await stitchSlippyTileBaseMap(viewport, cssW, cssH, {
      provider: 'esri',
      buildUrl: (z, x, y) =>
        `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
      scale: 2,
    });
  }
  if (!result) {
    result = await stitchSlippyTileBaseMap(viewport, cssW, cssH, {
      provider: 'osm',
      buildUrl: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
      scale: 2,
    });
  }
  if (!result) {
    result = createOfflinePaperBaseMap(cssW, cssH, 2);
  }

  if (BASE_MAP_CACHE.size >= MAX_BASE_MAP_CACHE) {
    const oldest = BASE_MAP_CACHE.keys().next().value;
    if (oldest !== undefined) BASE_MAP_CACHE.delete(oldest);
  }
  BASE_MAP_CACHE.set(cacheKey, result);
  return result;
}

// ==================== 4. Canvas 繪圖工具與 A4 成品渲染引擎 ====================

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function fitTextSingleLine(ctx, text, maxWidth) {
  const s = String(text || '');
  if (!s || ctx.measureText(s).width <= maxWidth) return s;
  const ell = '…';
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + ell).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, Math.max(1, lo)) + ell;
}

function wrapTextLines(ctx, text, maxWidth, maxLines = 2) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const lines = [];
  let cur = '';
  for (const ch of raw) {
    const next = cur + ch;
    if (ctx.measureText(next).width > maxWidth && cur.length > 0) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) {
    lines.push(cur);
  } else if (lines.length === maxLines && cur) {
    lines[maxLines - 1] = fitTextSingleLine(ctx, lines[maxLines - 1] + cur, maxWidth);
  }
  return lines;
}

function drawSuitcaseMark(ctx, x, y, size = 34) {
  ctx.save();
  ctx.translate(x, y);
  const s = size / 38;
  ctx.scale(s, s);
  roundRectPath(ctx, 0, 0, 38, 38, 10);
  const g = ctx.createLinearGradient(0, 0, 38, 38);
  g.addColorStop(0, '#B99773');
  g.addColorStop(1, '#826447');
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  ctx.translate(15, 21.5);
  ctx.rotate((25 * Math.PI) / 180);
  ctx.translate(-15, -21.5);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(12.7, 14.2);
  ctx.lineTo(12.7, 7.5);
  ctx.moveTo(17.3, 14.2);
  ctx.lineTo(17.3, 7.5);
  ctx.stroke();
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(11.4, 7.5);
  ctx.lineTo(18.6, 7.5);
  ctx.stroke();
  roundRectPath(ctx, 7.2, 13.6, 15.6, 17.6, 3.4);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = '#8D6E4F';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(11.2, 16.7);
  ctx.lineTo(11.2, 28.1);
  ctx.moveTo(15.0, 16.7);
  ctx.lineTo(15.0, 28.1);
  ctx.moveTo(18.8, 16.7);
  ctx.lineTo(18.8, 28.1);
  ctx.stroke();
  ctx.restore();
  ctx.restore();
}

function collectMapPointsForDays(daysList) {
  const pts = [];
  for (const day of daysList || []) {
    const pins = day?.pins || [];
    for (let i = 0; i < pins.length; i++) {
      const p = pins[i];
      if (Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))) {
        pts.push([Number(p.lat), Number(p.lng)]);
      }
      const t = p.transportToNext;
      if (!t || i >= pins.length - 1) continue;
      if (t.encodedPolyline) {
        const poly = decodePolyline(t.encodedPolyline);
        // 抽樣加入外框計算，避免極長折線拖慢
        const step = Math.max(1, Math.floor(poly.length / 40));
        for (let k = 0; k < poly.length; k += step) {
          pts.push(poly[k]);
        }
      }
    }
  }
  return pts;
}

function drawPolylineStroke(ctx, screenPts, { color, width, haloWidth = 0, dash = null, alpha = 1 }) {
  if (!screenPts || screenPts.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = alpha;

  if (haloWidth > 0) {
    ctx.strokeStyle = '#FFFDF9';
    ctx.lineWidth = haloWidth;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(screenPts[0][0], screenPts[0][1]);
    for (let i = 1; i < screenPts.length; i++) ctx.lineTo(screenPts[i][0], screenPts[i][1]);
    ctx.stroke();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.beginPath();
  ctx.moveTo(screenPts[0][0], screenPts[0][1]);
  for (let i = 1; i < screenPts.length; i++) ctx.lineTo(screenPts[i][0], screenPts[i][1]);
  ctx.stroke();
  ctx.restore();
}

function boxesOverlap(a, b, pad = 4) {
  return !(
    a.x + a.w + pad < b.x ||
    b.x + b.w + pad < a.x ||
    a.y + a.h + pad < b.y ||
    b.y + b.h + pad < a.y
  );
}

/**
 * 繪製地圖區：真實底圖（Google Static API 或 Carto Voyager）＋精確 Mercator 路線與防重疊編號標點
 */
async function drawMapSection(ctx, { daysList, showPinLabels, mapY, mapH }) {
  const cssW = A4_WIDTH / 2; // 620
  const cssH = Math.round(mapH / 2);
  const allPts = collectMapPointsForDays(daysList);
  const viewport = computeMapViewport(allPts, cssW, cssH);
  const baseMap = await fetchBaseMapImage(viewport, cssW, cssH);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, mapY, A4_WIDTH, mapH);
  ctx.clip();

  // 1. 繪製底圖
  ctx.drawImage(baseMap.image, 0, mapY, A4_WIDTH, mapH);

  const project = (lat, lng) => {
    const [mx, my] = projectLatLngToMapPx(lat, lng, viewport, cssW, cssH, 2);
    return [mx, mapY + my];
  };

  // 2. 繪製各天路線折線
  for (const day of daysList) {
    const dayColor = sanitizeHexColor(day.color, '#9A7B5C');
    const pins = day.pins || [];
    for (let i = 0; i < pins.length - 1; i++) {
      const pinA = pins[i];
      const pinB = pins[i + 1];
      const t = pinA.transportToNext;

      if (!t) {
        // 尚未設定交通時以柔和細虛線標示前後順序
        const curve = generateCurvedPath(pinA.lat, pinA.lng, pinB.lat, pinB.lng, 16);
        drawPolylineStroke(
          ctx,
          curve.map(([la, ln]) => project(la, ln)),
          { color: dayColor, width: 3.2, haloWidth: 5.5, dash: [6, 8], alpha: 0.6 }
        );
        continue;
      }

      if (t.mode === 'transit' && hasSegmentedTransit(t)) {
        for (const seg of t.segments) {
          const coords = seg.encodedPolyline ? decodePolyline(seg.encodedPolyline) : [];
          if (coords.length < 2) continue;
          const scr = coords.map(([la, ln]) => project(la, ln));
          if (seg.type === 'WALK') {
            drawPolylineStroke(ctx, scr, {
              color: '#6B513A',
              width: 3.8,
              haloWidth: 7.2,
              dash: [2, 8],
              alpha: 0.92,
            });
          } else {
            const segColor = pickReadableChipColor(seg.lineColor, dayColor);
            drawPolylineStroke(ctx, scr, {
              color: segColor,
              width: 5.4,
              haloWidth: 9.2,
              alpha: 0.96,
            });
          }
        }
        continue;
      }

      const decoded = t.encodedPolyline ? decodePolyline(t.encodedPolyline) : [];
      if (decoded.length >= 2) {
        drawPolylineStroke(
          ctx,
          decoded.map(([la, ln]) => project(la, ln)),
          { color: dayColor, width: 5.0, haloWidth: 8.8, alpha: 0.95 }
        );
      } else {
        const curve = generateCurvedPath(pinA.lat, pinA.lng, pinB.lat, pinB.lng, 18);
        drawPolylineStroke(
          ctx,
          curve.map(([la, ln]) => project(la, ln)),
          { color: dayColor, width: 4.0, haloWidth: 7.4, dash: [8, 8], alpha: 0.85 }
        );
      }
    }
  }

  // 3. 繪製編號圓點標記與防重疊地名標籤
  const occupiedBoxes = [];
  const pinRenderList = [];
  for (const day of daysList) {
    const dayColor = sanitizeHexColor(day.color, '#9A7B5C');
    (day.pins || []).forEach((pin, idx) => {
      const [px, py] = project(pin.lat, pin.lng);
      pinRenderList.push({ px, py, num: idx + 1, name: pin.name, color: dayColor });
      occupiedBoxes.push({ x: px - 18, y: py - 18, w: 36, h: 36 });
    });
  }

  for (const item of pinRenderList) {
    ctx.save();
    ctx.shadowColor = 'rgba(42, 30, 20, 0.34)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.arc(item.px, item.py, 17, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFDF9';
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(item.px, item.py, 13.5, 0, Math.PI * 2);
    ctx.fillStyle = item.color;
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 ${item.num >= 10 ? 14 : 16}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(item.num), item.px, item.py + 0.5);
  }

  if (showPinLabels) {
    ctx.font = `800 17px ${FONT_STACK}`;
    ctx.textBaseline = 'middle';
    const mapPad = 14;
    // 避開左上比例尺與右下角版權列
    occupiedBoxes.push({ x: 0, y: mapY, w: 220, h: 52 });
    occupiedBoxes.push({ x: A4_WIDTH - 240, y: mapY + mapH - 42, w: 240, h: 42 });
    occupiedBoxes.push({ x: 0, y: mapY + mapH - 42, w: 130, h: 42 });

    for (const item of pinRenderList) {
      const cleanLabel = String(item.name || '')
        .replace(/（.*?）|\(.*?\)/g, '')
        .trim()
        .slice(0, 10);
      if (!cleanLabel) continue;
      const tw = ctx.measureText(cleanLabel).width;
      const th = 22;

      const candidates = [
        { x: item.px + 22, y: item.py - th / 2, align: 'left' },
        { x: item.px - 22 - tw, y: item.py - th / 2, align: 'left' },
        { x: item.px - tw / 2, y: item.py - 22 - th, align: 'left' },
        { x: item.px - tw / 2, y: item.py + 22, align: 'left' },
        { x: item.px + 18, y: item.py - 18 - th, align: 'left' },
        { x: item.px - 18 - tw, y: item.py - 18 - th, align: 'left' },
        { x: item.px + 18, y: item.py + 18, align: 'left' },
        { x: item.px - 18 - tw, y: item.py + 18, align: 'left' },
      ];

      let chosen = null;
      for (const c of candidates) {
        const box = { x: c.x, y: c.y, w: tw, h: th };
        const inside =
          box.x >= mapPad &&
          box.x + box.w <= A4_WIDTH - mapPad &&
          box.y >= mapY + mapPad &&
          box.y + box.h <= mapY + mapH - mapPad;
        if (!inside) continue;
        if (!occupiedBoxes.some((ob) => boxesOverlap(box, ob, 3))) {
          chosen = box;
          break;
        }
      }
      if (!chosen) continue;
      occupiedBoxes.push(chosen);

      ctx.textAlign = 'left';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255, 253, 249, 0.96)';
      ctx.strokeText(cleanLabel, chosen.x, chosen.y + th / 2);
      ctx.fillStyle = '#2E2218';
      ctx.fillText(cleanLabel, chosen.x, chosen.y + th / 2);
    }
  }

  // 4. 左上角動態真實比例尺（絕不遮擋 Google 左下 Logo）
  const scaleBar = computeScaleBar(viewport.centerLat, viewport.zoom, 2);
  const sbX = 20;
  const sbY = mapY + 18;
  const sbBoxW = scaleBar.pxWidth + 82;
  roundRectPath(ctx, sbX, sbY, sbBoxW, 32, 9);
  ctx.fillStyle = 'rgba(255, 253, 249, 0.9)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(130, 100, 71, 0.25)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.strokeStyle = '#5A4331';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(sbX + 14, sbY + 13);
  ctx.lineTo(sbX + 14, sbY + 21);
  ctx.lineTo(sbX + 14 + scaleBar.pxWidth, sbY + 21);
  ctx.lineTo(sbX + 14 + scaleBar.pxWidth, sbY + 13);
  ctx.stroke();

  ctx.fillStyle = '#4A382B';
  ctx.font = `700 14px ${FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(scaleBar.label, sbX + 22 + scaleBar.pxWidth, sbY + 17);

  // 5. 若為 Esri / OpenStreetMap 開放地圖底圖，於右下角附上正式圖資授權標註
  if (baseMap.provider === 'esri' || baseMap.provider === 'osm') {
    const attrText = baseMap.provider === 'esri' ? '© Esri · World Street Map' : '© OpenStreetMap contributors';
    ctx.font = `600 13px ${FONT_STACK}`;
    const aw = ctx.measureText(attrText).width + 20;
    roundRectPath(ctx, A4_WIDTH - aw - 14, mapY + mapH - 32, aw, 24, 6);
    ctx.fillStyle = 'rgba(255, 253, 249, 0.88)';
    ctx.fill();
    ctx.fillStyle = '#5A4738';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(attrText, A4_WIDTH - aw / 2 - 14, mapY + mapH - 20);
  }

  ctx.restore();

  // 底部分隔線
  ctx.fillStyle = '#D9CBB7';
  ctx.fillRect(0, mapY + mapH, A4_WIDTH, 2);

  return baseMap.provider;
}

function drawHeaderBand(ctx, { eyebrow, title, subtitle, stats, pageTag }) {
  const headerH = 200;
  const grad = ctx.createLinearGradient(0, 0, A4_WIDTH, headerH);
  grad.addColorStop(0, '#4A382B');
  grad.addColorStop(1, '#392A1F');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, A4_WIDTH, headerH);

  drawSuitcaseMark(ctx, 44, 34, 40);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#E5C59E';
  ctx.font = `700 18px ${FONT_STACK}`;
  ctx.fillText(eyebrow, 96, 58);

  if (pageTag) {
    const tagW = ctx.measureText(pageTag).width + 24;
    const tagX = 96 + ctx.measureText(eyebrow).width + 14;
    roundRectPath(ctx, tagX, 38, tagW, 26, 13);
    ctx.fillStyle = 'rgba(229, 197, 158, 0.2)';
    ctx.fill();
    ctx.fillStyle = '#FAF4EC';
    ctx.font = `700 14px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.fillText(pageTag, tagX + tagW / 2, 56);
    ctx.textAlign = 'left';
  }

  const maxTitleW = stats.totalCost > 0 ? A4_WIDTH - 340 : A4_WIDTH - 96;
  ctx.fillStyle = '#FAF4EC';
  ctx.font = `800 36px ${FONT_STACK}`;
  ctx.fillText(fitTextSingleLine(ctx, title, maxTitleW), 44, 118);

  if (subtitle) {
    ctx.fillStyle = '#D6C2AC';
    ctx.font = `500 17px ${FONT_STACK}`;
    ctx.fillText(fitTextSingleLine(ctx, subtitle, maxTitleW), 44, 145);
  }

  // 右上預估花費框
  if (stats.totalCost > 0) {
    const boxW = 236;
    const boxH = 86;
    const boxX = A4_WIDTH - 44 - boxW;
    const boxY = 34;
    roundRectPath(ctx, boxX, boxY, boxW, boxH, 18);
    ctx.fillStyle = 'rgba(255, 253, 249, 0.09)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(229, 197, 158, 0.34)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = 'right';
    ctx.fillStyle = '#E5C59E';
    ctx.font = `700 16px ${FONT_STACK}`;
    ctx.fillText('預估總花費', boxX + boxW - 22, boxY + 32);
    ctx.fillStyle = '#FAF4EC';
    ctx.font = `800 28px ${FONT_STACK}`;
    ctx.fillText(formatTWD(stats.totalCost), boxX + boxW - 22, boxY + 69);
    ctx.textAlign = 'left';
  }

  // 底部摘要膠囊列
  const pills = [
    `📍 ${stats.pinCount} 個標點`,
    stats.totalKm > 0 ? `🛣️ 移動約 ${stats.totalKm} km` : '',
    stats.totalDurationMin > 0 ? `⏱️ 交通合計 ${formatDurationZh(stats.totalDurationMin)}` : '',
  ].filter(Boolean);

  let px = 44;
  const py = 158;
  ctx.font = `700 15px ${FONT_STACK}`;
  for (const text of pills) {
    const pw = ctx.measureText(text).width + 28;
    roundRectPath(ctx, px, py, pw, 30, 15);
    ctx.fillStyle = 'rgba(255, 253, 249, 0.13)';
    ctx.fill();
    ctx.fillStyle = '#FAF4EC';
    ctx.fillText(text, px + 14, py + 20);
    px += pw + 12;
  }

  return headerH;
}

function drawBudgetAndFooter(ctx, stats, { includeBudget = true } = {}) {
  const footerLineY = A4_HEIGHT - 36;
  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '/');

  if (includeBudget && stats.totalCost > 0) {
    const cardW = A4_WIDTH - 88;
    const cardH = 122;
    const cardX = 44;
    const cardY = A4_HEIGHT - 64 - cardH;

    roundRectPath(ctx, cardX, cardY, cardW, cardH, 20);
    ctx.fillStyle = '#FFFDF9';
    ctx.fill();
    ctx.strokeStyle = '#E2D6C5';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#6B513A';
    ctx.font = `800 17px ${FONT_STACK}`;
    ctx.fillText('💰 預估支出結構（自動統計）', cardX + 24, cardY + 34);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#3A2C21';
    ctx.font = `800 20px ${FONT_STACK}`;
    ctx.fillText(`總計 ${formatTWD(stats.totalCost)}`, cardX + cardW - 24, cardY + 35);
    ctx.textAlign = 'left';

    // 比例進度條
    const barX = cardX + 24;
    const barY = cardY + 50;
    const barW = cardW - 48;
    const barH = 16;
    roundRectPath(ctx, barX, barY, barW, barH, 8);
    ctx.fillStyle = '#EFE6DA';
    ctx.fill();

    const entries = EXPENSE_CATEGORIES.map((c) => ({
      ...c,
      val: stats.catTotals[c.id] || 0,
    })).filter((c) => c.val > 0);

    ctx.save();
    roundRectPath(ctx, barX, barY, barW, barH, 8);
    ctx.clip();
    let bx = barX;
    entries.forEach((e, idx) => {
      const segW = idx === entries.length - 1 ? barX + barW - bx : Math.max(12, Math.round((e.val / stats.totalCost) * barW));
      ctx.fillStyle = e.color;
      ctx.fillRect(bx, barY, segW, barH);
      bx += segW + 2;
    });
    ctx.restore();

    // 分類圖例
    let lx = barX;
    const ly = cardY + 98;
    for (const e of entries) {
      ctx.beginPath();
      ctx.arc(lx + 6, ly - 5, 6, 0, Math.PI * 2);
      ctx.fillStyle = e.color;
      ctx.fill();

      ctx.fillStyle = '#6B513A';
      ctx.font = `700 16px ${FONT_STACK}`;
      ctx.fillText(e.label, lx + 18, ly);
      const lblW = ctx.measureText(e.label).width;

      const amtText = formatTWD(e.val);
      ctx.fillStyle = '#3A2C21';
      ctx.font = `800 16px ${FONT_STACK}`;
      ctx.fillText(amtText, lx + 24 + lblW, ly);
      const amtW = ctx.measureText(amtText).width;
      lx += 48 + lblW + amtW;
      if (lx > cardX + cardW - 140) break;
    }
  }

  // 最底層 A4 頁尾
  ctx.fillStyle = '#8F7A66';
  ctx.font = `600 15px ${FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('由 漫步地圖 TripCanvas 自動排版生成 · 標準 A4 (210 × 297 mm)', 44, footerLineY);
  ctx.textAlign = 'right';
  ctx.fillText(`匯出日期 ${todayStr}`, A4_WIDTH - 44, footerLineY);
  ctx.textAlign = 'left';
}

function formatCompactTransportLine(t) {
  if (!t) return '';
  const info = getTransportDisplayInfo(t);
  if (!info) return '';
  if (info.kind === 'transit-segmented' && Array.isArray(info.segments)) {
    const parts = info.segments.map((s) =>
      s.type === 'WALK' ? `🚶 ${s.durationMin}分` : `${s.vehicleEmoji || '🚆'} ${s.displayLine || '大眾運輸'}`
    );
    const dur = Number(t.duration) > 0 ? `（共 ${formatDurationZh(t.duration)}）` : '';
    return `${parts.join(' › ')}${dur}`;
  }
  // 靜態 A4 海報不顯示「點此重新查詢」等互動錯誤訊息，改顯示乾淨的模式＋時間／距離
  if (['pending', 'network_error', 'unsupported', 'transit-empty'].includes(info.kind)) {
    const modeMeta = TRANSPORT_MODES[t.mode] || TRANSPORT_MODES.car;
    const parts = [`${modeMeta.emoji} ${modeMeta.label}`];
    if (Number(t.duration) > 0) parts.push(formatDurationZh(t.duration));
    if (Number(t.distanceKm) > 0) parts.push(`約 ${Number(t.distanceKm).toFixed(1)} km`);
    return parts.join(' · ');
  }
  const cleanSub = String(info.leftSub || '')
    .replace(/\s*[（(]免費備援路網[）)]/g, '')
    .replace(/\s*·\s*依一般道路估算/g, '')
    .replace(/^依一般道路估算$/g, '')
    .trim();
  const bits = [info.emoji, info.leftTitle];
  if (cleanSub && !['手動紀錄', '實際馬路路線'].includes(cleanSub)) {
    bits.push('·', cleanSub);
  }
  return bits.filter(Boolean).join(' ');
}

function drawDayPinColumn(ctx, { day, pins, startNum, x, y, width, maxY, density, isTwoCol }) {
  const dayColor = sanitizeHexColor(day.color, '#9A7B5C');
  const count = pins.length;
  if (count === 0) return;

  const compact = density === 'compact';
  const availableH = Math.max(200, maxY - y);
  const connectorH = isTwoCol ? 30 : 34;
  const connectorsTotal = Math.max(0, count - 1) * connectorH;
  const maxCardH = Math.floor((availableH - connectorsTotal) / count);
  const cardH = Math.max(isTwoCol ? 72 : 84, Math.min(compact ? 110 : 148, maxCardH));

  let curY = y;
  pins.forEach((pin, localIdx) => {
    const num = startNum + localIdx;
    const hasNext = localIdx < count - 1;
    const circleR = isTwoCol ? 18 : 20;
    const circleCx = x + circleR;
    const circleCy = curY + 26;
    const cardX = x + circleR * 2 + 14;
    const cardW = width - (circleR * 2 + 14);

    // 垂直連接線
    if (hasNext) {
      ctx.strokeStyle = `${dayColor}66`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(circleCx, circleCy + circleR);
      ctx.lineTo(circleCx, curY + cardH + connectorH + 26 - circleR);
      ctx.stroke();
    }

    // 序號圓徽章
    ctx.beginPath();
    ctx.arc(circleCx, circleCy, circleR, 0, Math.PI * 2);
    ctx.fillStyle = dayColor;
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 ${num >= 10 ? 15 : 17}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), circleCx, circleCy + 1);

    // 景點白卡
    roundRectPath(ctx, cardX, curY, cardW, cardH, 18);
    ctx.fillStyle = '#FFFDF9';
    ctx.fill();
    ctx.strokeStyle = '#E6DBC9';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const pinCost = calcPinExpense(pin);
    const padX = isTwoCol ? 16 : 20;
    const rightReserve = pinCost > 0 ? 124 : padX;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#3A2C21';
    ctx.font = `800 ${isTwoCol ? 19 : 22}px ${FONT_STACK}`;
    ctx.fillText(fitTextSingleLine(ctx, pin.name, cardW - padX - rightReserve), cardX + padX, curY + 32);

    if (pinCost > 0) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#6B513A';
      ctx.font = `800 ${isTwoCol ? 16 : 18}px ${FONT_STACK}`;
      ctx.fillText(formatTWD(pinCost), cardX + cardW - padX, curY + 31);
      ctx.textAlign = 'left';
    }

    let innerY = curY + 54;
    let notesBottomY = curY + 38;
    const maxNotesLines = cardH >= 122 ? 2 : 1;
    if (pin.notes && innerY < curY + cardH - 12) {
      ctx.fillStyle = '#786454';
      ctx.font = `500 ${isTwoCol ? 14 : 15.5}px ${FONT_STACK}`;
      const lines = wrapTextLines(ctx, pin.notes, cardW - padX * 2, maxNotesLines);
      for (const ln of lines) {
        if (innerY > curY + cardH - 10) break;
        ctx.fillText(ln, cardX + padX, innerY);
        notesBottomY = innerY + 6;
        innerY += isTwoCol ? 20 : 22;
      }
    }

    // 子項目膠囊列（完整明細版且空間足夠不與備註重疊時繪製）
    const subs = !compact && Array.isArray(pin.subSpots) ? pin.subSpots : [];
    const chipY = curY + cardH - 34;
    if (subs.length > 0 && chipY >= notesBottomY + 4) {
      let sx = cardX + padX;
      ctx.font = `600 ${isTwoCol ? 13 : 14}px ${FONT_STACK}`;
      let renderedCount = 0;
      for (const sub of subs) {
        const emoji = EXPENSE_CATEGORY_MAP[sub.category]?.emoji || '•';
        const costPart = Number(sub.cost) > 0 ? ` ${formatTWD(sub.cost)}` : '';
        const text = `${emoji} ${String(sub.name || '').slice(0, isTwoCol ? 10 : 16)}${costPart}`;
        const tw = ctx.measureText(text).width + 18;
        if (sx + tw > cardX + cardW - padX - 46 && renderedCount > 0) {
          const rest = `+${subs.length - renderedCount}`;
          const rw = ctx.measureText(rest).width + 14;
          roundRectPath(ctx, sx, chipY, rw, 25, 8);
          ctx.fillStyle = '#EFE6DA';
          ctx.fill();
          ctx.fillStyle = '#6B513A';
          ctx.fillText(rest, sx + 7, chipY + 17);
          break;
        }
        roundRectPath(ctx, sx, chipY, Math.min(tw, cardW - padX * 2), 25, 8);
        ctx.fillStyle = '#FBF8F3';
        ctx.fill();
        ctx.strokeStyle = '#E6DBC9';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#5A4738';
        ctx.fillText(fitTextSingleLine(ctx, text, cardW - padX * 2 - 16), sx + 9, chipY + 17);
        sx += tw + 8;
        renderedCount++;
      }
    }

    curY += cardH;

    // 路段交通資訊膠囊
    if (hasNext) {
      const tText = formatCompactTransportLine(pin.transportToNext);
      if (tText) {
        ctx.font = `700 ${isTwoCol ? 13.5 : 14.5}px ${FONT_STACK}`;
        const maxPillW = cardW;
        const label = fitTextSingleLine(ctx, tText, maxPillW - 24);
        const pillW = Math.min(maxPillW, ctx.measureText(label).width + 24);
        const pillY = curY + Math.round((connectorH - 24) / 2);
        roundRectPath(ctx, cardX, pillY, pillW, 24, 12);
        ctx.fillStyle = '#EFE6DA';
        ctx.fill();
        ctx.strokeStyle = '#DFD1BE';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#6B513A';
        ctx.fillText(label, cardX + 12, pillY + 17);
      }
      curY += connectorH;
    }
  });
}

function drawOverviewGrid(ctx, { days, startY, maxY, density }) {
  const list = days || [];
  if (list.length === 0) return;

  const compact = density === 'compact';
  const cols = list.length <= 2 ? Math.max(1, list.length) : 3;
  const rows = Math.ceil(list.length / cols);
  const gapX = 20;
  const gapY = 20;
  const totalW = A4_WIDTH - 88;
  const colW = Math.floor((totalW - gapX * (cols - 1)) / cols);
  const colH = Math.floor((maxY - startY - gapY * (rows - 1)) / rows);

  list.forEach((day, idx) => {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const x = 44 + c * (colW + gapX);
    const y = startY + r * (colH + gapY);
    const dayColor = sanitizeHexColor(day.color, '#9A7B5C');
    const dStats = calcDaysSummaryStats([day]);

    roundRectPath(ctx, x, y, colW, colH, 20);
    ctx.fillStyle = '#FFFDF9';
    ctx.fill();
    ctx.strokeStyle = '#E2D6C5';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // 頂部色條
    ctx.save();
    roundRectPath(ctx, x, y, colW, colH, 20);
    ctx.clip();
    ctx.fillStyle = dayColor;
    ctx.fillRect(x, y, colW, 7);
    ctx.restore();

    // 標題列
    ctx.beginPath();
    ctx.arc(x + 24, y + 36, 7, 0, Math.PI * 2);
    ctx.fillStyle = dayColor;
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#3A2C21';
    ctx.font = `800 20px ${FONT_STACK}`;
    ctx.fillText(fitTextSingleLine(ctx, day.name, colW - 135), x + 38, y + 43);

    if (dStats.totalKm > 0) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#786454';
      ctx.font = `700 14px ${FONT_STACK}`;
      ctx.fillText(`${dStats.totalKm} km`, x + colW - 18, y + 41);
      ctx.textAlign = 'left';
    }

    ctx.fillStyle = '#EFE6DA';
    ctx.fillRect(x + 18, y + 56, colW - 36, 1.5);

    // 標點清單（自動依卡片高度計算最多行數，超長顯示 +N 個標點）
    const pins = day.pins || [];
    const footerReserve = 46;
    const listTop = y + 76;
    const listBottom = y + colH - footerReserve;
    const rowStep = compact ? 34 : 46;
    const maxVisible = Math.max(1, Math.floor((listBottom - listTop) / rowStep));

    if (pins.length === 0) {
      ctx.fillStyle = '#8F7A66';
      ctx.font = `500 15px ${FONT_STACK}`;
      ctx.fillText('尚未加入標點', x + 20, listTop + 14);
    } else {
      const visibleCount = pins.length > maxVisible ? Math.max(1, maxVisible - 1) : pins.length;
      for (let i = 0; i < visibleCount; i++) {
        const pin = pins[i];
        const py = listTop + i * rowStep;

        ctx.beginPath();
        ctx.arc(x + 28, py + 7, 11, 0, Math.PI * 2);
        ctx.fillStyle = dayColor;
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `800 ${i + 1 >= 10 ? 11 : 12.5}px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), x + 28, py + 7.5);

        const pinCost = !compact ? calcPinExpense(pin) : 0;
        const costReserve = pinCost > 0 ? 86 : 0;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#3A2C21';
        ctx.font = `700 16px ${FONT_STACK}`;
        ctx.fillText(fitTextSingleLine(ctx, pin.name, colW - 64 - costReserve), x + 46, py + 13);

        if (pinCost > 0) {
          ctx.textAlign = 'right';
          ctx.fillStyle = '#786454';
          ctx.font = `700 13.5px ${FONT_STACK}`;
          ctx.fillText(formatTWD(pinCost), x + colW - 18, py + 12);
          ctx.textAlign = 'left';
        }

        if (!compact && i < pins.length - 1 && pin.transportToNext) {
          const tLine = formatCompactTransportLine(pin.transportToNext);
          if (tLine) {
            ctx.fillStyle = '#8C7662';
            ctx.font = `600 12.5px ${FONT_STACK}`;
            ctx.fillText(fitTextSingleLine(ctx, `↓ ${tLine}`, colW - 64), x + 46, py + 31);
          }
        }
      }

      if (pins.length > visibleCount) {
        const moreY = listTop + visibleCount * rowStep + 10;
        ctx.fillStyle = '#8C7662';
        ctx.font = `700 14px ${FONT_STACK}`;
        ctx.fillText(`… 其餘 ${pins.length - visibleCount} 個標點詳見分天頁`, x + 22, moreY);
      }
    }

    // 卡片底部統計列
    ctx.fillStyle = '#EFE6DA';
    ctx.fillRect(x + 18, y + colH - 42, colW - 36, 1.5);
    ctx.fillStyle = '#6B513A';
    ctx.font = `700 14px ${FONT_STACK}`;
    ctx.fillText(`${pins.length} 個標點`, x + 20, y + colH - 16);
    if (dStats.totalCost > 0) {
      ctx.textAlign = 'right';
      ctx.font = `800 15px ${FONT_STACK}`;
      ctx.fillText(formatTWD(dStats.totalCost), x + colW - 20, y + colH - 16);
      ctx.textAlign = 'left';
    }
  });
}

/**
 * 將單一 A4 頁面規格渲染為標準 1240×1754 px (150 DPI A4) Canvas 與 PNG Data URL
 */
export async function renderA4PageToCanvas(pageSpec, { tripName = '漫步地圖行程' } = {}) {
  try {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 600))]);
    }
  } catch {
    // 字型尚未完成載入時使用系統黑體保底
  }

  const canvas = document.createElement('canvas');
  canvas.width = A4_WIDTH;
  canvas.height = A4_HEIGHT;
  const ctx = canvas.getContext('2d');

  // 1. 暖米色紙張底色
  ctx.fillStyle = '#F5EFE6';
  ctx.fillRect(0, 0, A4_WIDTH, A4_HEIGHT);

  const isOverview = pageSpec.kind === 'overview';
  const targetDays = isOverview ? pageSpec.allDays : [pageSpec.day];
  const stats = calcDaysSummaryStats(targetDays);
  const pageTag = pageSpec.pageTotal > 1 ? `第 ${pageSpec.pageIndex} / ${pageSpec.pageTotal} 頁` : '';

  // 2. 頂部標題帶
  const headerH = drawHeaderBand(ctx, {
    eyebrow: isOverview
      ? `漫步地圖 TripCanvas · 全行程 ${targetDays.length} 天總覽`
      : `漫步地圖 TripCanvas · ${pageSpec.day.name} 行程懶人包`,
    title: isOverview ? tripName : pageSpec.day.name,
    subtitle: isOverview
      ? `共 ${targetDays.length} 天 · 依地圖與實際路徑自動排版`
      : tripName,
    stats,
    pageTag,
  });

  let cursorY = headerH;
  let mapProvider = 'none';

  // 3. 地圖圖例（全覽頁且 ≥2 天）＋真實地圖區
  if (pageSpec.includeMap) {
    if (isOverview && targetDays.length > 1) {
      const legendH = 42;
      ctx.fillStyle = '#FBF8F3';
      ctx.fillRect(0, cursorY, A4_WIDTH, legendH);
      ctx.fillStyle = '#E6DBC9';
      ctx.fillRect(0, cursorY + legendH - 1, A4_WIDTH, 1);

      let lx = 44;
      const maxLegendLabelW = Math.min(340, Math.max(150, Math.floor((A4_WIDTH - 88) / Math.min(targetDays.length, 5)) - 44));
      ctx.font = `700 15px ${FONT_STACK}`;
      ctx.textBaseline = 'middle';
      for (const d of targetDays) {
        const dc = sanitizeHexColor(d.color, '#9A7B5C');
        const label = fitTextSingleLine(ctx, d.name, maxLegendLabelW);
        const tw = ctx.measureText(label).width;
        if (lx + tw + 36 > A4_WIDTH - 44) break;
        ctx.beginPath();
        ctx.arc(lx + 7, cursorY + legendH / 2, 7, 0, Math.PI * 2);
        ctx.fillStyle = dc;
        ctx.fill();
        ctx.fillStyle = '#3A2C21';
        ctx.fillText(label, lx + 20, cursorY + legendH / 2 + 1);
        lx += tw + 38;
      }
      ctx.textBaseline = 'alphabetic';
      cursorY += legendH;
    }

    const mapH = !isOverview && pageSpec.layout === 'two-col' ? 420 : 496;
    mapProvider = await drawMapSection(ctx, {
      daysList: targetDays,
      showPinLabels: !isOverview,
      mapY: cursorY,
      mapH,
    });
    cursorY += mapH + 2;
  }

  // 4. 內容區標題列
  cursorY += 36;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#6B513A';
  ctx.font = `800 18px ${FONT_STACK}`;
  ctx.fillText(
    isOverview
      ? '📌 每日動線一覽'
      : `📌 ${pageSpec.day.name} 動線順序${pageSpec.pageTotal > 1 ? `（標點 ${pageSpec.pinStart + 1}–${pageSpec.pinEnd}）` : ''}`,
    44,
    cursorY
  );

  ctx.textAlign = 'right';
  ctx.fillStyle = '#8C7662';
  ctx.font = `600 15px ${FONT_STACK}`;
  ctx.fillText(pageSpec.density === 'compact' ? '精簡分享版 · A4' : '完整明細版 · A4', A4_WIDTH - 44, cursorY);
  ctx.textAlign = 'left';
  cursorY += 20;

  // 5. 保留底部預算卡＋頁尾高度
  const hasBudgetCard = pageSpec.includeBudget && stats.totalCost > 0;
  const contentMaxY = A4_HEIGHT - (hasBudgetCard ? 204 : 68);

  if (isOverview) {
    drawOverviewGrid(ctx, {
      days: pageSpec.days,
      startY: cursorY,
      maxY: contentMaxY,
      density: pageSpec.density,
    });
  } else {
    const slicePins = (pageSpec.day.pins || []).slice(pageSpec.pinStart, pageSpec.pinEnd);
    if (slicePins.length === 0) {
      ctx.fillStyle = '#8F7A66';
      ctx.font = `600 20px ${FONT_STACK}`;
      ctx.fillText('這一天尚未新增任何景點標點。', 44, cursorY + 46);
    } else if (pageSpec.layout === 'single-col') {
      drawDayPinColumn(ctx, {
        day: pageSpec.day,
        pins: slicePins,
        startNum: pageSpec.pinStart + 1,
        x: 44,
        y: cursorY,
        width: A4_WIDTH - 88,
        maxY: contentMaxY,
        density: pageSpec.density,
        isTwoCol: false,
      });
    } else {
      const mid = Math.ceil(slicePins.length / 2);
      const colGap = 24;
      const colW = Math.floor((A4_WIDTH - 88 - colGap) / 2);
      drawDayPinColumn(ctx, {
        day: pageSpec.day,
        pins: slicePins.slice(0, mid),
        startNum: pageSpec.pinStart + 1,
        x: 44,
        y: cursorY,
        width: colW,
        maxY: contentMaxY,
        density: pageSpec.density,
        isTwoCol: true,
      });
      drawDayPinColumn(ctx, {
        day: pageSpec.day,
        pins: slicePins.slice(mid),
        startNum: pageSpec.pinStart + mid + 1,
        x: 44 + colW + colGap,
        y: cursorY,
        width: colW,
        maxY: contentMaxY,
        density: pageSpec.density,
        isTwoCol: true,
      });
    }
  }

  // 6. 支出統計條與 A4 頁尾
  drawBudgetAndFooter(ctx, stats, { includeBudget: pageSpec.includeBudget });

  const safeTrip = sanitizeExportFilename(tripName);
  const pageSuffix = pageSpec.pageTotal > 1 ? `_p${pageSpec.pageIndex}` : '';
  const partName = isOverview ? '全行程總覽' : sanitizeExportFilename(pageSpec.day.name);
  const filename = `${safeTrip}_${partName}${pageSuffix}_A4.png`;

  return {
    canvas,
    dataUrl: canvas.toDataURL('image/png'),
    mapProvider,
    filename,
    width: A4_WIDTH,
    height: A4_HEIGHT,
  };
}

export function downloadDataUrlAsFile(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * 開啟標準 A4 多頁列印／另存 PDF 視窗（每頁精準滿版 210mm × 297mm）
 */
export function openA4PrintWindow(renderedPages, tripName = '漫步地圖行程', preOpenedWindow = null) {
  const win = preOpenedWindow && !preOpenedWindow.closed ? preOpenedWindow : window.open('', '_blank');
  if (!win) return false;

  const safeTitle = escapeHTML(`${tripName} - A4 行程手冊`);
  const pagesHtml = renderedPages
    .map(
      (p) => `
      <div class="a4-sheet">
        <img src="${p.dataUrl}" alt="${escapeHTML(p.filename)}" />
      </div>
    `
    )
    .join('');

  win.document.open();
  win.document.write(`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <title>${safeTitle}</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #E9E2D7; font-family: system-ui, -apple-system, sans-serif; }
    .toolbar {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 12px 20px; background: #3D2E23; color: #FAF4EC; font-size: 14px;
    }
    .toolbar button {
      background: #9A7B5C; color: #fff; border: 0; border-radius: 10px;
      padding: 8px 16px; font-weight: 700; cursor: pointer; font-size: 14px;
    }
    .toolbar button:hover { background: #816448; }
    .pages { display: flex; flex-direction: column; align-items: center; gap: 20px; padding: 20px; }
    .a4-sheet {
      width: 210mm; height: 297mm; background: #F5EFE6;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18); overflow: hidden;
    }
    .a4-sheet img { width: 100%; height: 100%; display: block; object-fit: contain; }
    @media print {
      body { background: #fff; }
      .toolbar { display: none !important; }
      .pages { padding: 0; gap: 0; display: block; }
      .a4-sheet { box-shadow: none; page-break-after: always; break-after: page; }
      .a4-sheet:last-child { page-break-after: auto; break-after: auto; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span>🦉 ${safeTitle}（共 ${renderedPages.length} 頁標準 A4）</span>
    <button type="button" onclick="window.print()">列印 / 另存為 PDF</button>
  </div>
  <div class="pages">${pagesHtml}</div>
  <script>
    window.addEventListener('load', () => {
      setTimeout(() => { try { window.print(); } catch {} }, 350);
    });
  </script>
</body>
</html>`);
  win.document.close();
  return true;
}
