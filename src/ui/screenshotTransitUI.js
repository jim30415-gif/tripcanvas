import { convertToTwdSync, formatCurrencyAmount } from '../services/currencyClient.js';
import {
  compressScreenshotBlob,
  extractImageFromClipboardEvent,
  fetchScreenshotImportStatus,
  parseTransitScreenshot,
  readClipboardImageBlob,
  rebuildScreenshotTransitRoute,
} from '../services/screenshotTransitClient.js';
import { escapeHTML, formatTWD, refreshIcons } from '../utils/format.js';
import { showToast } from './dialog.js';

const VEHICLE_OPTIONS = [
  { value: 'BUS', label: '🚌 公車' },
  { value: 'SUBWAY', label: '🚇 地鐵 / 捷運' },
  { value: 'RAIL', label: '🚆 鐵路 / JR' },
  { value: 'TRAM', label: '🚊 路面電車 / 輕軌' },
  { value: 'FERRY', label: '⛴️ 渡輪' },
  { value: 'CABLE_CAR', label: '🚡 纜車' },
  { value: 'OTHER', label: '🚐 其他大眾運輸' },
];

const CURRENCY_OPTIONS = ['JPY', 'TWD', 'KRW', 'USD', 'EUR', 'HKD', 'THB', 'SGD', 'GBP', 'CNY'];

let uiState = null;
let callbacks = {
  getActiveRouteContext: () => null,
  onConfirmRoute: () => {},
};
let eventsBound = false;

function makeFreshState() {
  return {
    quotaStatus: null, // { enabled, locked, reason, message, limits }
    phase: 'idle', // 'idle' | 'parsing' | 'review' | 'rebuilding' | 'error'
    errorMessage: '',
    previewDataUrl: '',
    draft: null,
    builtRoute: null,
    stopStats: null,
    confidence: 'medium',
    warning: '',
    dirtyStops: false,
    requestSeq: 0,
  };
}

export function hasPendingScreenshotReview() {
  return Boolean(uiState && (uiState.phase === 'review' || uiState.phase === 'rebuilding') && uiState.draft);
}

export function resetScreenshotImportUI() {
  const prevQuota = uiState?.quotaStatus || null;
  uiState = makeFreshState();
  uiState.quotaStatus = prevQuota;
  const fileInput = document.getElementById('input-transit-screenshot');
  if (fileInput) fileInput.value = '';
  renderScreenshotImportUI();
}

export async function refreshScreenshotImportStatus() {
  if (!uiState) uiState = makeFreshState();
  const status = await fetchScreenshotImportStatus();
  if (status && uiState) {
    uiState.quotaStatus = status;
    renderScreenshotImportUI();
  }
}

function isQuotaBlocked() {
  const q = uiState?.quotaStatus;
  if (!q) return false;
  return q.enabled === false || q.locked === true;
}

function renderQuotaBannerHtml(q) {
  if (!q) return '';
  if (q.enabled === false) {
    return `
      <div class="rounded-xl bg-owl-softBg/85 border border-owl-border px-3 py-2 text-xs text-owl-subtext leading-relaxed flex items-start gap-2">
        <i data-lucide="shield-alert" class="w-4 h-4 text-owl-primary shrink-0 mt-0.5"></i>
        <div>
          <span class="font-bold text-owl-text">截圖辨識尚未啟用：</span>
          請於後端設定免費的 <code class="px-1 py-0.5 rounded bg-white dark:bg-owl-canvas border border-owl-border text-[11px]">GEMINI_API_KEY</code>（Google AI Studio 免費層）即可使用；目前仍可直接使用下方手動填寫。
        </div>
      </div>
    `;
  }
  if (q.locked) {
    return `
      <div class="rounded-xl bg-[#FDF2F0] dark:bg-[#35201F] border border-[#E7C2BC] dark:border-[#613835] px-3 py-2.5 text-xs text-[#8E423B] dark:text-[#E89B94] leading-relaxed flex items-start gap-2">
        <i data-lucide="shield-alert" class="w-4 h-4 shrink-0 mt-0.5"></i>
        <div class="space-y-0.5">
          <div class="font-extrabold">已達免費保護上限，暫時限制截圖匯入</div>
          <div>${escapeHTML(q.message || '為避免超出免費額度產生費用，今日已暫停此功能，明日將自動恢復，請先改用下方手動填寫。')}</div>
        </div>
      </div>
    `;
  }
  const parseRem = q.limits?.dailyParseRemaining;
  const quotaHint = Number.isFinite(parseRem)
    ? `今日免費額度保護：剩餘 ${parseRem} 次 AI 解析 · 站牌定位全程免費（OSM）`
    : '使用 Google AI Studio 免費層解析 ＋ 免費 OSM 站牌定位';
  return `
    <div class="flex items-center justify-between gap-2 text-[11px] text-owl-subtext px-0.5">
      <span>${escapeHTML(quotaHint)}</span>
    </div>
  `;
}

function renderStopMatchBadge(stopName, coord) {
  if (!stopName || !stopName.trim()) return '';
  if (coord && Number.isFinite(coord.lat) && Number.isFinite(coord.lng)) {
    return '<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-[#EBF2EC] dark:bg-[#1D2D22] border border-[#C2D8C7] dark:border-[#32523C] text-[10px] font-extrabold text-[#3E5C45] dark:text-[#9FD0AB] shrink-0">📍 已定位</span>';
  }
  return '<span class="inline-flex items-center px-1.5 py-0.5 rounded-md bg-owl-softBg border border-owl-border text-[10px] font-bold text-owl-muted shrink-0">未定位</span>';
}

function renderReviewCardHtml() {
  const s = uiState;
  const draft = s?.draft;
  if (!draft) return '';

  const isRebuilding = s.phase === 'rebuilding';
  const totalStops = s.stopStats?.totalStops || 0;
  const matchedStops = s.stopStats?.matchedStops || 0;
  const anchorSummary =
    totalStops > 0
      ? matchedStops === totalStops
        ? `📍 已精準定位 ${matchedStops}/${totalStops} 個站牌並串連實際市區道路`
        : matchedStops > 0
          ? `📍 已定位 ${matchedStops}/${totalStops} 個站牌（其餘將以起終點銜接）`
          : '⚠️ 尚未定位到站牌座標，將先以起終點貼路繪製（可微調站名後點「重新定位」）'
      : '尚未偵測到明確站名，可補填上／下車站名以繪製更精準的公車路段';

  const anchorTone =
    matchedStops > 0
      ? 'bg-[#EBF2EC] dark:bg-[#1D2D22] border-[#C2D8C7] dark:border-[#32523C] text-[#3E5C45] dark:text-[#9FD0AB]'
      : 'bg-[#FDF6EB] dark:bg-[#33281A] border-[#E7D4B6] dark:border-[#5D482A] text-[#8C5B2B] dark:text-[#E8C589]';

  const confLabel =
    s.confidence === 'high' ? '辨識清晰' : s.confidence === 'low' ? '辨識較模糊・請仔細核對' : '請核對後匯入';
  const confTone =
    s.confidence === 'high'
      ? 'bg-[#EBF2EC] dark:bg-[#1D2D22] text-[#3E5C45] dark:text-[#9FD0AB]'
      : s.confidence === 'low'
        ? 'bg-[#FDF2F0] dark:bg-[#35201F] text-[#8E423B] dark:text-[#E89B94]'
        : 'bg-owl-softBg text-owl-primaryDeep';

  const fareAmountVal = Number(draft.fareAmount) > 0 ? draft.fareAmount : '';
  const fareCur = CURRENCY_OPTIONS.includes(draft.fareCurrency) ? draft.fareCurrency : 'JPY';
  let fareTwdPreview = '';
  if (Number(draft.fareAmount) > 0) {
    const conv = convertToTwdSync(Number(draft.fareAmount), fareCur);
    if (fareCur !== 'TWD' && conv?.amountTwd > 0) {
      fareTwdPreview = `約 ${formatTWD(conv.amountTwd)}（${formatCurrencyAmount(Number(draft.fareAmount), fareCur)}）`;
    }
  }

  const segmentsHtml = (draft.segments || [])
    .map((seg, idx) => {
      const isWalk = seg.type === 'WALK';
      const typeSelectHtml = `
        <select data-ss-seg-idx="${idx}" data-ss-seg-field="segKind" class="px-2 py-1 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs font-extrabold text-owl-text focus:outline-none focus:ring-2 focus:ring-owl-primary/35">
          <option value="WALK" ${isWalk ? 'selected' : ''}>🚶 步行</option>
          ${VEHICLE_OPTIONS.map(
            (opt) =>
              `<option value="TRANSIT:${opt.value}" ${!isWalk && seg.vehicleType === opt.value ? 'selected' : ''}>${opt.label}</option>`
          ).join('')}
        </select>
      `;

      if (isWalk) {
        return `
          <div class="rounded-xl border border-owl-border/90 bg-white dark:bg-owl-panel p-2.5 space-y-2" data-ss-seg-row="${idx}">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="w-5 h-5 rounded-full bg-owl-softBg text-owl-primaryDeep text-[11px] font-extrabold flex items-center justify-center shrink-0">${idx + 1}</span>
                ${typeSelectHtml}
              </div>
              <div class="flex items-center gap-1.5">
                <label class="text-[11px] font-bold text-owl-subtext">耗時</label>
                <input type="number" min="1" max="360" inputmode="numeric" value="${escapeHTML(String(seg.durationMin || 3))}" data-ss-seg-idx="${idx}" data-ss-seg-field="durationMin" class="w-14 px-2 py-1 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs font-bold text-owl-text text-center tabular-nums-strict focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
                <span class="text-[11px] text-owl-subtext">分</span>
                <button type="button" data-ss-remove-seg="${idx}" title="移除此段" aria-label="移除第 ${idx + 1} 段" class="w-6 h-6 rounded-lg hover:bg-[#F9EDEC] dark:hover:bg-[#35201F] text-owl-muted hover:text-[#A65D57] dark:hover:text-[#E89B94] flex items-center justify-center transition">
                  <i data-lucide="x" class="w-3.5 h-3.5"></i>
                </button>
              </div>
            </div>
          </div>
        `;
      }

      const interText = Array.isArray(seg.intermediateStopNames) ? seg.intermediateStopNames.join('、') : '';

      return `
        <div class="rounded-xl border border-owl-border/90 bg-white dark:bg-owl-panel p-2.5 space-y-2" data-ss-seg-row="${idx}">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-5 h-5 rounded-full bg-owl-primary text-white text-[11px] font-extrabold flex items-center justify-center shrink-0">${idx + 1}</span>
              ${typeSelectHtml}
            </div>
            <div class="flex items-center gap-1.5">
              <input type="number" min="1" max="720" inputmode="numeric" value="${escapeHTML(String(seg.durationMin || 10))}" data-ss-seg-idx="${idx}" data-ss-seg-field="durationMin" title="此段耗時（分鐘）" class="w-14 px-2 py-1 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs font-bold text-owl-text text-center tabular-nums-strict focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
              <span class="text-[11px] text-owl-subtext">分</span>
              <input type="number" min="0" max="200" inputmode="numeric" value="${escapeHTML(String(seg.stopCount || ''))}" placeholder="站數" data-ss-seg-idx="${idx}" data-ss-seg-field="stopCount" title="停靠站數（選填）" class="w-14 px-2 py-1 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs font-bold text-owl-text text-center tabular-nums-strict focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
              <span class="text-[11px] text-owl-subtext">站</span>
              <button type="button" data-ss-remove-seg="${idx}" title="移除此段" aria-label="移除第 ${idx + 1} 段" class="w-6 h-6 rounded-lg hover:bg-[#F9EDEC] dark:hover:bg-[#35201F] text-owl-muted hover:text-[#A65D57] dark:hover:text-[#E89B94] flex items-center justify-center transition">
                <i data-lucide="x" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <div>
              <label class="block text-[11px] font-bold text-owl-subtext mb-0.5">路線名 / 公車號碼</label>
              <input type="text" value="${escapeHTML(
                seg.lineShortName && /^[\dA-Za-z\-]+$|^[紅藍綠橘棕黃黑小幹線快][\dA-Za-z]+$/.test(seg.lineShortName.trim())
                  ? seg.lineShortName
                  : seg.lineName || seg.lineShortName || ''
              )}" placeholder="例：206、城下まち周遊バス" data-ss-seg-idx="${idx}" data-ss-seg-field="lineName" class="w-full px-2.5 py-1.5 rounded-lg border border-owl-border bg-owl-card/40 dark:bg-owl-canvas text-xs font-bold text-owl-text focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
            </div>
            <div>
              <label class="block text-[11px] font-bold text-owl-subtext mb-0.5">開往方向 / 備註（選填）</label>
              <input type="text" value="${escapeHTML(seg.headsign || '')}" placeholder="例：往京都駅前" data-ss-seg-idx="${idx}" data-ss-seg-field="headsign" class="w-full px-2.5 py-1.5 rounded-lg border border-owl-border bg-owl-card/40 dark:bg-owl-canvas text-xs font-semibold text-owl-text focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <div>
              <div class="flex items-center justify-between gap-1 mb-0.5">
                <label class="text-[11px] font-bold text-owl-subtext">上車站牌</label>
                ${renderStopMatchBadge(seg.departureStopName, seg.departureCoord)}
              </div>
              <input type="text" value="${escapeHTML(seg.departureStopName || '')}" placeholder="例：兼六園下・金沢城" data-ss-seg-idx="${idx}" data-ss-seg-field="departureStopName" class="w-full px-2.5 py-1.5 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs font-semibold text-owl-text focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
            </div>
            <div>
              <div class="flex items-center justify-between gap-1 mb-0.5">
                <label class="text-[11px] font-bold text-owl-subtext">下車站牌</label>
                ${renderStopMatchBadge(seg.arrivalStopName, seg.arrivalCoord)}
              </div>
              <input type="text" value="${escapeHTML(seg.arrivalStopName || '')}" placeholder="例：近江町市場" data-ss-seg-idx="${idx}" data-ss-seg-field="arrivalStopName" class="w-full px-2.5 py-1.5 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs font-semibold text-owl-text focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
            </div>
          </div>

          ${
            seg.vehicleType === 'BUS' || interText
              ? `<div>
                  <label class="block text-[11px] font-bold text-owl-subtext mb-0.5">中途關鍵停靠站（選填，以頓號分隔，最多 5 站・平均涵蓋前／中／後站點更貼路）</label>
                  <input type="text" value="${escapeHTML(interText)}" placeholder="例：橫山町、旭町、若松、角間新町" data-ss-seg-idx="${idx}" data-ss-seg-field="intermediateStopNames" class="w-full px-2.5 py-1.5 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs text-owl-text focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
                </div>`
              : ''
          }
        </div>
      `;
    })
    .join('');

  return `
    <div id="screenshot-review-card" class="rounded-2xl border-2 border-owl-primary/55 bg-owl-card p-3.5 space-y-3 shadow-xs">
      <div class="flex items-start gap-2.5">
        ${
          s.previewDataUrl
            ? `<img src="${s.previewDataUrl}" alt="上傳截圖預覽" class="w-14 h-20 rounded-xl object-cover border border-owl-border shrink-0 bg-white dark:bg-owl-canvas shadow-2xs" />`
            : ''
        }
        <div class="min-w-0 flex-1 space-y-1.5">
          <div class="flex flex-wrap items-center justify-between gap-1.5">
            <span class="text-sm font-extrabold text-owl-text">截圖辨識結果（匯入前請核對）</span>
            <span class="px-2 py-0.5 rounded-full text-[11px] font-extrabold ${confTone}">${confLabel}</span>
          </div>
          <div class="rounded-lg border px-2.5 py-1.5 text-xs font-bold leading-snug ${anchorTone}">
            ${escapeHTML(anchorSummary)}
          </div>
          ${
            s.warning
              ? `<div class="text-xs text-[#8C5B2B] dark:text-[#E8C589] font-medium">💡 ${escapeHTML(s.warning)}</div>`
              : ''
          }
        </div>
      </div>

      <!-- 總耗時、票價與班次時間微調 -->
      <div class="grid grid-cols-2 gap-2 pt-1 border-t border-owl-border/70">
        <div>
          <label class="block text-[11px] font-bold text-owl-subtext mb-0.5">總耗時（分）</label>
          <input id="input-ss-total-duration" type="number" min="1" max="1440" inputmode="numeric" value="${escapeHTML(String(draft.totalDurationMin || ''))}" class="w-full px-2.5 py-1.5 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs font-extrabold text-owl-text tabular-nums-strict focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
        </div>
        <div>
          <label class="block text-[11px] font-bold text-owl-subtext mb-0.5">票價金額</label>
          <div class="flex rounded-lg border border-owl-border bg-white dark:bg-owl-canvas overflow-hidden focus-within:ring-2 focus-within:ring-owl-primary/35">
            <select id="select-ss-fare-currency" class="bg-owl-softBg/80 px-2 py-1.5 border-r border-owl-border text-xs font-extrabold text-owl-primaryDeep focus:outline-none shrink-0">
              ${CURRENCY_OPTIONS.map((c) => `<option value="${c}" ${c === fareCur ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
            <input id="input-ss-fare-amount" type="number" min="0" step="any" inputmode="decimal" value="${escapeHTML(String(fareAmountVal))}" placeholder="0" class="w-full min-w-0 px-2.5 py-1.5 bg-white dark:bg-owl-canvas text-xs font-extrabold text-owl-text tabular-nums-strict focus:outline-none" />
          </div>
        </div>
        <div>
          <label class="block text-[11px] font-bold text-owl-subtext mb-0.5">出發時刻</label>
          <input id="input-ss-dep-time" type="text" value="${escapeHTML(draft.departureTimeText || '')}" placeholder="09:15" class="w-full px-2.5 py-1.5 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs font-semibold text-owl-text tabular-nums-strict focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
        </div>
        <div>
          <label class="block text-[11px] font-bold text-owl-subtext mb-0.5">抵達時刻</label>
          <input id="input-ss-arr-time" type="text" value="${escapeHTML(draft.arrivalTimeText || '')}" placeholder="09:38" class="w-full px-2.5 py-1.5 rounded-lg border border-owl-border bg-white dark:bg-owl-canvas text-xs font-semibold text-owl-text tabular-nums-strict focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
        </div>
      </div>
      ${
        fareTwdPreview
          ? `<div class="text-[11px] font-bold text-[#4F6F57] dark:text-[#9FD0AB]">💱 匯入時將自動帶入票價：${escapeHTML(fareTwdPreview)}</div>`
          : ''
      }

      <!-- 可微調分段清單 -->
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-extrabold text-owl-text">轉乘步驟明細（共 ${draft.segments.length} 段）</span>
          <button id="btn-ss-add-segment" type="button" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-owl-softBg hover:bg-owl-border/75 text-xs font-bold text-owl-primaryDeep transition">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i>
            新增一段
          </button>
        </div>
        <div id="screenshot-review-segments" class="space-y-2">
          ${segmentsHtml}
        </div>
      </div>

      <!-- 匯入前確認按鈕列 -->
      <div class="pt-2 border-t border-owl-border/80 flex flex-wrap items-center justify-between gap-2">
        <button id="btn-ss-discard" type="button" ${isRebuilding ? 'disabled' : ''} class="px-3 py-2 rounded-xl text-xs font-bold text-owl-subtext hover:bg-owl-softBg transition">
          放棄截圖
        </button>
        <div class="flex flex-wrap items-center gap-1.5 ml-auto">
          <button id="btn-ss-rebuild" type="button" ${isRebuilding ? 'disabled' : ''} class="inline-flex items-center gap-1 px-3 py-2 rounded-xl border ${s.dirtyStops ? 'border-owl-primary bg-owl-selectedBg text-owl-primaryDeep' : 'border-owl-border bg-white dark:bg-owl-panel text-owl-subtext hover:bg-owl-softBg'} text-xs font-bold transition">
            <i data-lucide="${isRebuilding ? 'loader-2' : 'refresh-cw'}" class="w-3.5 h-3.5 ${isRebuilding ? 'animate-spin' : ''}"></i>
            <span>${isRebuilding ? '定位中...' : '重新定位站牌'}</span>
          </button>
          <button id="btn-ss-confirm" type="button" ${isRebuilding ? 'disabled' : ''} class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#4F6F57] hover:bg-[#3E5C45] text-white text-xs sm:text-sm font-extrabold shadow-xs transition active:scale-95">
            <i data-lucide="check" class="w-4 h-4"></i>
            <span>確認匯入此路線</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderScreenshotImportUI() {
  if (!uiState) uiState = makeFreshState();
  const root = document.getElementById('screenshot-import-card');
  if (!root) return;

  const blocked = isQuotaBlocked();
  const isParsing = uiState.phase === 'parsing';
  const showReview = (uiState.phase === 'review' || uiState.phase === 'rebuilding') && uiState.draft;

  const statusHtml =
    uiState.phase === 'parsing'
      ? `
        <div class="rounded-xl border border-owl-border bg-white dark:bg-owl-panel px-3.5 py-3 flex items-center gap-3">
          ${
            uiState.previewDataUrl
              ? `<img src="${uiState.previewDataUrl}" alt="解析中" class="w-11 h-14 rounded-lg object-cover border border-owl-border shrink-0" />`
              : ''
          }
          <div class="min-w-0 flex-1 space-y-0.5">
            <div class="flex items-center gap-1.5 text-sm font-extrabold text-owl-primaryDeep">
              <i data-lucide="loader-2" class="w-4 h-4 animate-spin shrink-0"></i>
              <span>正在以免費 AI 辨識截圖並定位公車站牌...</span>
            </div>
            <div class="text-xs text-owl-subtext">自動擷取公車號碼、上下車站、時刻與票價，並串連真實街道動線</div>
          </div>
        </div>
      `
      : uiState.phase === 'error' && uiState.errorMessage
        ? `
          <div class="rounded-xl bg-[#FDF2F0] dark:bg-[#35201F] border border-[#E7C2BC] dark:border-[#613835] px-3 py-2 text-xs font-bold text-[#8E423B] dark:text-[#E89B94] leading-relaxed">
            ⚠️ ${escapeHTML(uiState.errorMessage)}
          </div>
        `
        : '';

  const controlsDisabled = blocked || isParsing;
  const uploadBoxClass = controlsDisabled
    ? 'opacity-50 pointer-events-none select-none'
    : 'cursor-pointer hover:border-owl-primary/70 hover:bg-white dark:hover:bg-owl-softBg';

  root.innerHTML = `
    <div class="space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 text-sm font-extrabold text-owl-text">
          <i data-lucide="camera" class="w-4 h-4 text-owl-primary shrink-0"></i>
          <span>截圖匯入路線與公車站牌</span>
        </div>
        <span class="px-2 py-0.5 rounded-full bg-owl-softBg border border-owl-border text-[11px] font-bold text-owl-primaryDeep">
          免費 AI 辨識
        </span>
      </div>

      ${renderQuotaBannerHtml(uiState.quotaStatus)}

      ${
        !showReview
          ? `
            <div id="screenshot-dropzone" class="rounded-xl border-2 border-dashed border-owl-border bg-white/80 dark:bg-owl-panel/80 p-3 space-y-2.5 transition ${controlsDisabled ? 'opacity-60' : ''}">
              <div class="grid grid-cols-2 gap-2">
                <label class="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-owl-primary hover:bg-owl-primaryHover text-white text-xs sm:text-sm font-extrabold shadow-2xs transition active:scale-95 ${controlsDisabled ? 'pointer-events-none opacity-60' : 'cursor-pointer'}">
                  <i data-lucide="upload-cloud" class="w-4 h-4 shrink-0"></i>
                  <span>上傳截圖 / 相簿</span>
                  <input id="input-transit-screenshot" type="file" accept="image/*" ${controlsDisabled ? 'disabled' : ''} class="sr-only" />
                </label>
                <button id="btn-paste-transit-screenshot" type="button" ${controlsDisabled ? 'disabled' : ''} class="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-white dark:bg-owl-card border border-owl-border text-owl-text text-xs sm:text-sm font-extrabold transition active:scale-95 ${uploadBoxClass}">
                  <i data-lucide="clipboard-paste" class="w-4 h-4 text-owl-primary shrink-0"></i>
                  <span>貼上截圖</span>
                </button>
              </div>
              <p class="text-[11px] text-owl-subtext leading-relaxed text-center">
                免手動打字！支援 Google Maps / NAVITIME / Yahoo! 乗換案内截圖（電腦可直接 <kbd class="px-1 py-0.5 rounded bg-owl-softBg border border-owl-border font-mono text-[10px]">Ctrl+V</kbd> 貼上；截圖展開停靠站可更貼合實際公車路線）
              </p>
            </div>
          `
          : ''
      }

      ${statusHtml}
      ${showReview ? renderReviewCardHtml() : ''}
    </div>
  `;

  bindDynamicScreenshotCardEvents(root);
  refreshIcons(root);
}

async function processIncomingScreenshotBlob(blob) {
  const routeCtx = callbacks.getActiveRouteContext?.();
  if (!routeCtx) return;

  if (!uiState) uiState = makeFreshState();
  if (isQuotaBlocked()) {
    showToast(uiState.quotaStatus?.message || '目前截圖辨識已暫停開放，請改用手動填寫', 'warn');
    return;
  }

  const seq = ++uiState.requestSeq;
  uiState.phase = 'parsing';
  uiState.errorMessage = '';
  uiState.draft = null;
  uiState.builtRoute = null;
  uiState.dirtyStops = false;
  renderScreenshotImportUI();

  let compressedUrl = '';
  try {
    compressedUrl = await compressScreenshotBlob(blob, { maxDim: 1280, quality: 0.82 });
  } catch {
    if (uiState.requestSeq !== seq) return;
    uiState.phase = 'error';
    uiState.errorMessage = '無法讀取這張圖片，請重新選擇 JPG / PNG 截圖。';
    renderScreenshotImportUI();
    return;
  }

  if (uiState.requestSeq !== seq) return;
  uiState.previewDataUrl = compressedUrl;
  renderScreenshotImportUI();

  const res = await parseTransitScreenshot({
    imageDataUrl: compressedUrl,
    origin: routeCtx.pinA,
    destination: routeCtx.pinB,
    originName: routeCtx.pinA?.name || '',
    destinationName: routeCtx.pinB?.name || '',
  });

  if (!uiState || uiState.requestSeq !== seq) return;
  if (res.quota) {
    uiState.quotaStatus = res.quota;
  }

  if (res.status === 'quota_limited' || res.httpStatus === 429) {
    uiState.phase = 'idle';
    uiState.errorMessage = '';
    if (!uiState.quotaStatus || !uiState.quotaStatus.locked) {
      uiState.quotaStatus = {
        enabled: true,
        locked: true,
        reason: res.error || 'QUOTA_LIMITED',
        message: res.message || '今日免費額度已達上限，已暫時限制截圖匯入功能。',
      };
    }
    renderScreenshotImportUI();
    showToast(res.message || '今日免費截圖辨識額度已達上限', 'warn');
    return;
  }

  if (res.status === 'unconfigured') {
    uiState.phase = 'idle';
    uiState.quotaStatus = res.quota || { enabled: false, locked: false, reason: 'UNCONFIGURED', message: res.message };
    renderScreenshotImportUI();
    return;
  }

  if (res.status !== 'ok' || !res.draft || !res.route) {
    uiState.phase = 'error';
    uiState.errorMessage = res.message || '無法解析這張截圖，請確認截圖清楚包含交通路線與站名。';
    renderScreenshotImportUI();
    return;
  }

  uiState.phase = 'review';
  uiState.draft = res.draft;
  uiState.builtRoute = res.route;
  uiState.stopStats = res.stopStats || { totalStops: 0, matchedStops: 0 };
  uiState.confidence = res.confidence || 'medium';
  uiState.warning = res.warning || '';
  uiState.dirtyStops = false;
  renderScreenshotImportUI();
  showToast('已完成截圖辨識！請核對下方站名與分段後點「確認匯入」', 'success');
}

function readDraftEditsFromDom() {
  if (!uiState?.draft) return null;
  const draft = uiState.draft;

  const totalDurEl = document.getElementById('input-ss-total-duration');
  const fareAmtEl = document.getElementById('input-ss-fare-amount');
  const fareCurEl = document.getElementById('select-ss-fare-currency');
  const depTimeEl = document.getElementById('input-ss-dep-time');
  const arrTimeEl = document.getElementById('input-ss-arr-time');

  if (totalDurEl) {
    const n = Number(totalDurEl.value);
    if (Number.isFinite(n) && n > 0) draft.totalDurationMin = Math.round(n);
  }
  if (fareAmtEl) {
    const f = Number(fareAmtEl.value);
    draft.fareAmount = Number.isFinite(f) && f > 0 ? f : 0;
  }
  if (fareCurEl) {
    draft.fareCurrency = fareCurEl.value || 'JPY';
  }
  if (depTimeEl) draft.departureTimeText = depTimeEl.value.trim();
  if (arrTimeEl) draft.arrivalTimeText = arrTimeEl.value.trim();

  return draft;
}

async function rebuildAnchoredRouteFromDraft() {
  const routeCtx = callbacks.getActiveRouteContext?.();
  if (!routeCtx || !uiState?.draft) return false;

  readDraftEditsFromDom();
  if (!Array.isArray(uiState.draft.segments) || uiState.draft.segments.length === 0) {
    showToast('請至少保留一段交通步驟', 'warn');
    return false;
  }

  const seq = ++uiState.requestSeq;
  uiState.phase = 'rebuilding';
  renderScreenshotImportUI();

  const res = await rebuildScreenshotTransitRoute({
    draft: uiState.draft,
    origin: routeCtx.pinA,
    destination: routeCtx.pinB,
  });

  if (!uiState || uiState.requestSeq !== seq) return false;
  if (res.quota) {
    uiState.quotaStatus = res.quota;
  }

  if (res.status === 'quota_limited' || res.httpStatus === 429) {
    uiState.phase = 'review';
    if (!uiState.quotaStatus?.locked) {
      uiState.quotaStatus = {
        enabled: true,
        locked: true,
        reason: res.error || 'PLACES_QUOTA_EXCEEDED',
        message: res.message || 'Google Places 免費額度已達上限，暫時無法重新定位站牌。',
      };
    }
    renderScreenshotImportUI();
    showToast(res.message || '站牌定位免費額度今日已達上限', 'warn');
    return false;
  }

  if (res.status !== 'ok' || !res.route) {
    uiState.phase = 'review';
    renderScreenshotImportUI();
    showToast(res.message || '重新定位站牌路線失敗，請再試一次', 'warn');
    return false;
  }

  uiState.phase = 'review';
  uiState.draft = res.draft;
  uiState.builtRoute = res.route;
  uiState.stopStats = res.stopStats || uiState.stopStats;
  uiState.dirtyStops = false;
  renderScreenshotImportUI();
  return true;
}

async function confirmAndImportDraft() {
  if (!uiState?.draft) return;
  readDraftEditsFromDom();

  if (!Array.isArray(uiState.draft.segments) || uiState.draft.segments.length === 0) {
    showToast('請至少保留一段交通步驟再匯入', 'warn');
    return;
  }

  // 若使用者有修改站名、路線、票價或耗時，匯入前先同步重建分段與貼路折線（不耗 Gemini 額度）
  if (uiState.dirtyStops || !uiState.builtRoute) {
    const ok = await rebuildAnchoredRouteFromDraft();
    if (!ok) return;
  }

  const finalRoute = uiState.builtRoute;
  const finalDraft = uiState.draft;
  resetScreenshotImportUI();
  callbacks.onConfirmRoute?.({ route: finalRoute, draft: finalDraft });
}

function bindDynamicScreenshotCardEvents(root) {
  const fileInput = root.querySelector('#input-transit-screenshot');
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) processIncomingScreenshotBlob(file);
    e.target.value = '';
  });

  const dropzone = root.querySelector('#screenshot-dropzone');
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      if (isQuotaBlocked()) return;
      e.preventDefault();
      dropzone.classList.add('border-owl-primary', 'bg-owl-selectedBg');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('border-owl-primary', 'bg-owl-selectedBg');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('border-owl-primary', 'bg-owl-selectedBg');
      if (isQuotaBlocked()) return;
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        processIncomingScreenshotBlob(file);
      } else {
        showToast('請拖放圖片檔案（JPG / PNG / WebP）', 'warn');
      }
    });
  }

  root.querySelector('#btn-paste-transit-screenshot')?.addEventListener('click', async () => {
    if (isQuotaBlocked()) return;
    const res = await readClipboardImageBlob();
    if (res.status === 'ok' && res.blob) {
      processIncomingScreenshotBlob(res.blob);
    } else if (res.status === 'empty') {
      showToast('剪貼簿目前沒有圖片，請先截圖複製後再貼上，或直接點左側「上傳截圖」', 'info');
    } else {
      showToast('請直接按 Ctrl+V / Cmd+V 貼上截圖，或點左側「上傳截圖 / 相簿」', 'info');
    }
  });

  // Review Card 編輯事件
  const markDirty = () => {
    if (!uiState) return;
    uiState.dirtyStops = true;
    const rebuildBtn = document.getElementById('btn-ss-rebuild');
    if (rebuildBtn) {
      rebuildBtn.classList.remove('border-owl-border', 'bg-white', 'dark:bg-owl-panel', 'text-owl-subtext');
      rebuildBtn.classList.add('border-owl-primary', 'bg-owl-selectedBg', 'text-owl-primaryDeep');
    }
  };

  root.querySelector('#input-ss-total-duration')?.addEventListener('input', () => {
    readDraftEditsFromDom();
    markDirty();
  });
  root.querySelector('#input-ss-fare-amount')?.addEventListener('input', () => {
    readDraftEditsFromDom();
    markDirty();
  });
  root.querySelector('#select-ss-fare-currency')?.addEventListener('change', () => {
    readDraftEditsFromDom();
    markDirty();
    renderScreenshotImportUI();
  });
  root.querySelector('#input-ss-dep-time')?.addEventListener('input', () => {
    readDraftEditsFromDom();
    markDirty();
  });
  root.querySelector('#input-ss-arr-time')?.addEventListener('input', () => {
    readDraftEditsFromDom();
    markDirty();
  });

  root.querySelectorAll('[data-ss-seg-field]').forEach((el) => {
    const idx = Number(el.dataset.ssSegIdx);
    const field = el.dataset.ssSegField;
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      const seg = uiState?.draft?.segments?.[idx];
      if (!seg) return;

      if (field === 'segKind') {
        const val = el.value;
        if (val === 'WALK') {
          uiState.draft.segments[idx] = { type: 'WALK', durationMin: seg.durationMin || 3 };
        } else {
          const vehicleType = val.replace(/^TRANSIT:/, '') || 'BUS';
          uiState.draft.segments[idx] = {
            type: 'TRANSIT',
            vehicleType,
            lineName: seg.lineName || '',
            lineShortName: seg.lineShortName || '',
            headsign: seg.headsign || '',
            durationMin: seg.durationMin || 10,
            stopCount: seg.stopCount || 0,
            departureStopName: seg.departureStopName || '',
            arrivalStopName: seg.arrivalStopName || '',
            intermediateStopNames: seg.intermediateStopNames || [],
            departureTimeText: seg.departureTimeText || '',
            arrivalTimeText: seg.arrivalTimeText || '',
            colorHex: seg.colorHex || '',
          };
        }
        uiState.dirtyStops = true;
        renderScreenshotImportUI();
        return;
      }

      if (field === 'durationMin') {
        const n = Number(el.value);
        seg.durationMin = Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
      } else if (field === 'stopCount') {
        const n = Number(el.value);
        seg.stopCount = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
      } else if (field === 'lineName') {
        seg.lineName = el.value.trim();
        seg.lineShortName = '';
      } else if (field === 'headsign') {
        seg.headsign = el.value.trim();
      } else if (field === 'departureStopName') {
        seg.departureStopName = el.value.trim();
        seg.departureCoord = null;
      } else if (field === 'arrivalStopName') {
        seg.arrivalStopName = el.value.trim();
        seg.arrivalCoord = null;
      } else if (field === 'intermediateStopNames') {
        seg.intermediateStopNames = el.value
          .split(/[、,，\n]+/)
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 5);
        seg.intermediateCoords = [];
      }

      markDirty();
    });
  });

  root.querySelectorAll('[data-ss-remove-seg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.ssRemoveSeg);
      if (!uiState?.draft?.segments || uiState.draft.segments.length <= 1) {
        showToast('至少需要保留一段行程', 'warn');
        return;
      }
      uiState.draft.segments.splice(idx, 1);
      uiState.dirtyStops = true;
      renderScreenshotImportUI();
    });
  });

  root.querySelector('#btn-ss-add-segment')?.addEventListener('click', () => {
    if (!uiState?.draft?.segments) return;
    if (uiState.draft.segments.length >= 8) {
      showToast('單趟最多支援 8 段轉乘步驟', 'warn');
      return;
    }
    uiState.draft.segments.push({
      type: 'TRANSIT',
      vehicleType: 'BUS',
      lineName: '',
      lineShortName: '',
      headsign: '',
      durationMin: 10,
      stopCount: 0,
      departureStopName: '',
      arrivalStopName: '',
      intermediateStopNames: [],
      departureTimeText: '',
      arrivalTimeText: '',
      colorHex: '',
    });
    uiState.dirtyStops = true;
    renderScreenshotImportUI();
  });

  root.querySelector('#btn-ss-discard')?.addEventListener('click', () => {
    resetScreenshotImportUI();
    showToast('已放棄截圖解析結果', 'info');
  });

  root.querySelector('#btn-ss-rebuild')?.addEventListener('click', async () => {
    const ok = await rebuildAnchoredRouteFromDraft();
    if (ok) {
      showToast('已重新定位站牌並更新公車路線', 'success');
    }
  });

  root.querySelector('#btn-ss-confirm')?.addEventListener('click', confirmAndImportDraft);
}

export function bindScreenshotTransitUI({ getActiveRouteContext, onConfirmRoute }) {
  callbacks = { getActiveRouteContext, onConfirmRoute };
  if (!uiState) uiState = makeFreshState();

  if (eventsBound) return;
  eventsBound = true;

  // 在交通設定視窗開啟且位於「手動填寫紀錄」分頁時，支援直接 Ctrl+V / Cmd+V 貼上截圖
  document.addEventListener('paste', (e) => {
    const ctx = callbacks.getActiveRouteContext?.();
    if (!ctx || ctx.selectedMode !== 'transit' || ctx.transitSubTab !== 'manual') return;
    const modal = document.getElementById('modal-transport');
    if (!modal || modal.classList.contains('hidden')) return;

    const imageFile = extractImageFromClipboardEvent(e);
    if (!imageFile) return;

    e.preventDefault();
    processIncomingScreenshotBlob(imageFile);
  });
}
