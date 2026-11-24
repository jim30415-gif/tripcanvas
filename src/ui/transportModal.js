import { TRANSPORT_MODES, TRANSIT_PREFERENCES, TRANSIT_TYPES } from '../config/constants.js';
import { getState, saveState } from '../state/store.js';
import { hasManualTransitDetails, hasSegmentedTransit } from '../state/selectors.js';
import { computeSegmentRoute, buildTransitTransportRecord } from '../services/routeManager.js';
import {
  convertToTwdSync,
  ensureFxRatesLoaded,
  formatCurrencyAmount,
} from '../services/currencyClient.js';
import { buildGoogleMapsDirUrl, isJapanTrip, NAVITIME_JP_WEB_URL } from '../utils/geo.js';
import {
  escapeHTML,
  formatDistanceMetersZh,
  formatDurationZh,
  formatTWD,
  refreshIcons,
} from '../utils/format.js';
import { showToast } from './dialog.js';

let editingTransportContext = null;
let onChangeCallback = null;

function pickReadableColor(color, fallback = '#6B513A') {
  if (!color || !/^#[0-9A-Fa-f]{6}$/.test(color)) return fallback;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.82 ? fallback : color;
}

function toDatetimeLocalValue(isoString) {
  const date = isoString ? new Date(isoString) : new Date(Date.now() + 30 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getSelectedAutoTransitRoute(ctx) {
  if (
    !ctx ||
    ctx.selectedMode !== 'transit' ||
    ctx.transitResult?.status !== 'ok' ||
    !Array.isArray(ctx.transitResult.routes) ||
    ctx.transitResult.routes.length === 0
  ) {
    return null;
  }
  const idx = Math.min(ctx.selectedRouteIndex || 0, ctx.transitResult.routes.length - 1);
  return ctx.transitResult.routes[idx] || null;
}

function resolveTransportInputCost() {
  const costInput = document.getElementById('input-transport-cost');
  const currencySel = document.getElementById('select-transport-currency');
  const currency = currencySel?.value || 'TWD';
  const rawStr = costInput?.value?.trim() || '';
  const rawNum = rawStr ? Number(rawStr) : 0;

  if (!Number.isFinite(rawNum) || rawNum <= 0) {
    return {
      costTwd: 0,
      originalCost: 0,
      originalCurrency: currency,
      rateSource: 'native',
    };
  }

  const conv = convertToTwdSync(rawNum, currency);
  return {
    costTwd: conv.amountTwd,
    originalCost: rawNum,
    originalCurrency: currency,
    rateSource: conv.rateSource,
  };
}

/**
 * 同步交通支出輸入欄、外幣手動換算新台幣預覽，與 Google / NAVITIME 自動票價提示
 */
function renderTransportCostHint({ autoFillFare = false } = {}) {
  const ctx = editingTransportContext;
  const costInput = document.getElementById('input-transport-cost');
  const currencySel = document.getElementById('select-transport-currency');
  const hintEl = document.getElementById('transport-fare-hint');
  if (!ctx || !costInput || !hintEl) return;

  const selectedTransit = getSelectedAutoTransitRoute(ctx);
  const fare = selectedTransit?.fare || null;
  const providerLabel =
    (selectedTransit?.provider || ctx.transitResult?.provider) === 'navitime' ? 'NAVITIME' : 'Google';

  if (autoFillFare && fare?.amountTwd && !ctx.userEditedCost) {
    if (currencySel) currencySel.value = 'TWD';
    costInput.value = String(fare.amountTwd);
  }

  const currentCurrency = currencySel?.value || 'TWD';
  const rawVal = Number(costInput.value);
  const hasForeignInput = currentCurrency !== 'TWD' && Number.isFinite(rawVal) && rawVal > 0;

  // 若使用者正在以日圓或其他外幣手動輸入金額，即時顯示新台幣換算結果
  if (hasForeignInput) {
    const conv = convertToTwdSync(rawVal, currentCurrency);
    const rateTag = conv.rateSource === 'live' ? '即時匯率' : '參考匯率';
    const fareApplyBtn =
      ctx.selectedMode === 'transit' && fare?.amountTwd
        ? `<button type="button" id="btn-apply-google-fare" class="px-2 py-0.5 rounded-lg bg-white border border-[#B5D0BA] text-[#3E5C45] font-bold hover:bg-[#F5FAF6] transition">改套用 ${providerLabel} 票價</button>`
        : '';

    hintEl.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-[#4F6F57] bg-[#EBF2EC] border border-[#C7DCCB] rounded-xl px-2.5 py-1.5">
        <span>💱 <strong>${escapeHTML(formatCurrencyAmount(rawVal, currentCurrency))}</strong>（${escapeHTML(currentCurrency)}）≈ <strong>${formatTWD(conv.amountTwd)}</strong>（${rateTag}，儲存後計入台幣總支出）</span>
        ${fareApplyBtn}
      </div>
    `;
    document.getElementById('btn-apply-google-fare')?.addEventListener('click', () => {
      if (currencySel) currencySel.value = 'TWD';
      costInput.value = String(fare.amountTwd);
      ctx.userEditedCost = false;
      renderTransportCostHint();
    });
    return;
  }

  if (ctx.selectedMode === 'transit') {
    if (fare?.amountTwd) {
      const currentTwd = resolveTransportInputCost().costTwd;
      const differs = currentTwd !== fare.amountTwd;

      if (fare.originalCurrency && fare.originalCurrency !== 'TWD') {
        const rateTag = fare.rateSource === 'live' ? '即時匯率' : '參考匯率';
        hintEl.innerHTML = `
          <div class="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-[#4F6F57] bg-[#EBF2EC] border border-[#C7DCCB] rounded-xl px-2.5 py-1.5">
            <span>💱 ${providerLabel} 票價 <strong>${escapeHTML(fare.originalText || `${fare.originalCurrency} ${fare.originalAmount}`)}</strong>（${escapeHTML(fare.originalCurrency)}）≈ <strong>${formatTWD(fare.amountTwd)}</strong>（${rateTag}自動換算）</span>
            ${differs ? '<button type="button" id="btn-apply-google-fare" class="px-2 py-0.5 rounded-lg bg-white border border-[#B5D0BA] text-[#3E5C45] font-bold hover:bg-[#F5FAF6] transition">套用換算票價</button>' : ''}
          </div>
        `;
      } else {
        hintEl.innerHTML = `
          <div class="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-[#4F6F57] bg-[#EBF2EC] border border-[#C7DCCB] rounded-xl px-2.5 py-1.5">
            <span>🎫 ${providerLabel} 預估票價 <strong>${formatTWD(fare.amountTwd)}</strong>${differs ? '' : '（已自動帶入）'}</span>
            ${differs ? `<button type="button" id="btn-apply-google-fare" class="px-2 py-0.5 rounded-lg bg-white border border-[#B5D0BA] text-[#3E5C45] font-bold hover:bg-[#F5FAF6] transition">套用 ${providerLabel} 票價</button>` : ''}
          </div>
        `;
      }

      document.getElementById('btn-apply-google-fare')?.addEventListener('click', () => {
        if (currencySel) currencySel.value = 'TWD';
        costInput.value = String(fare.amountTwd);
        ctx.userEditedCost = false;
        renderTransportCostHint();
      });
      return;
    }

    if (selectedTransit) {
      hintEl.innerHTML = `<div class="text-[11px] text-owl-muted">${providerLabel} 未提供此段票價，可直接輸入金額（支援切換日圓等外幣自動換台幣）。</div>`;
      return;
    }

    hintEl.innerHTML = `<div class="text-[11px] text-owl-muted">${ctx.isJapan ? '可直接輸入日圓（¥ JPY）或台幣車資，系統將即時換算新台幣並歸入「交通」分類。' : '可填寫單程票價或悠遊卡車資（支援外幣自動換台幣，歸入「交通」分類）。'}</div>`;
    return;
  }

  const modeHints = {
    car: '可填寫油資、過路費、停車費或租車分攤（支援切換外幣自動換台幣，歸入「交通」分類）。',
    scooter: '可填寫油資、停車費或租機車費用（支援切換外幣自動換台幣，歸入「交通」分類）。',
    bike: '可填寫 YouBike 或單車租借費用（支援切換外幣自動換台幣，歸入「交通」分類）。',
    walk: '步行一般為 0 元，若有接駁或通行費也可手動補充。',
  };
  hintEl.innerHTML = `<div class="text-[11px] text-owl-muted">${modeHints[ctx.selectedMode] || ''}</div>`;
}

function renderTransitTypeChips() {
  const ctx = editingTransportContext;
  const container = document.getElementById('transit-type-chips');
  if (!ctx || !container) return;

  container.innerHTML = TRANSIT_TYPES.map((t) => {
    const active = ctx.selectedTransitType === t.id;
    return `
      <button type="button" data-ttype="${t.id}" class="btn-pick-ttype px-2.5 py-1 rounded-xl text-[11px] font-bold border transition ${active ? 'bg-owl-primary text-white border-owl-primary' : 'bg-white text-owl-subtext border-owl-border hover:border-owl-accentBorder'}">
        ${t.emoji} ${t.label}
      </button>
    `;
  }).join('');

  container.querySelectorAll('.btn-pick-ttype').forEach((btn) => {
    btn.addEventListener('click', () => {
      ctx.selectedTransitType = ctx.selectedTransitType === btn.dataset.ttype ? '' : btn.dataset.ttype;
      renderTransitTypeChips();
    });
  });
}

function renderTransitPreferenceChips() {
  const ctx = editingTransportContext;
  const container = document.getElementById('transit-pref-chips');
  if (!ctx || !container) return;

  container.innerHTML = TRANSIT_PREFERENCES.map((p) => {
    const active = ctx.transitPreference === p.id;
    return `
      <button type="button" data-tpref="${p.id}" class="btn-pick-tpref px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${active ? 'bg-owl-primary text-white border-owl-primary' : 'bg-white text-owl-subtext border-owl-border hover:border-owl-accentBorder'}">
        ${p.label}
      </button>
    `;
  }).join('');

  container.querySelectorAll('.btn-pick-tpref').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (ctx.transitPreference === btn.dataset.tpref) return;
      ctx.transitPreference = btn.dataset.tpref;
      renderTransitPreferenceChips();
      runModalTransitQuery(true);
    });
  });
}

function renderTransitTabState() {
  const ctx = editingTransportContext;
  if (!ctx) return;

  const autoTabBtn = document.getElementById('btn-transit-tab-auto');
  const manualTabBtn = document.getElementById('btn-transit-tab-manual');
  const autoPane = document.getElementById('transit-auto-pane');
  const manualPane = document.getElementById('transit-manual-pane');

  const isAuto = ctx.transitSubTab === 'auto';
  autoTabBtn.className = isAuto
    ? 'flex-1 py-1.5 px-2.5 rounded-xl text-xs font-extrabold bg-owl-primary text-white shadow-2xs transition'
    : 'flex-1 py-1.5 px-2.5 rounded-xl text-xs font-bold text-owl-subtext hover:text-owl-text transition';
  manualTabBtn.className = !isAuto
    ? 'flex-1 py-1.5 px-2.5 rounded-xl text-xs font-extrabold bg-owl-primary text-white shadow-2xs transition'
    : 'flex-1 py-1.5 px-2.5 rounded-xl text-xs font-bold text-owl-subtext hover:text-owl-text transition';

  if (isAuto) {
    autoPane.classList.remove('hidden');
    manualPane.classList.add('hidden');
  } else {
    autoPane.classList.add('hidden');
    manualPane.classList.remove('hidden');
  }
}

function renderTransitAutoResults({ autoFillFare = false } = {}) {
  const ctx = editingTransportContext;
  const statusEl = document.getElementById('transit-auto-status');
  const routesWrap = document.getElementById('transit-routes-wrap');
  const tabsEl = document.getElementById('transit-route-tabs');
  const timelineEl = document.getElementById('transit-timeline');
  if (!ctx || !statusEl || !routesWrap) return;

  const res = ctx.transitResult;
  if (!res || res.status === 'pending') {
    routesWrap.classList.add('hidden');
    const loadingText = ctx.isJapan
      ? '正在查詢日本大眾運輸分段路線與日圓票價...'
      : '正在透過 Google Routes API 查詢實際大眾運輸分段與班次...';
    statusEl.innerHTML = `
      <div class="flex items-center gap-2 text-owl-subtext font-semibold py-2 text-xs">
        <span class="w-3.5 h-3.5 rounded-full border-2 border-owl-primary border-t-transparent animate-spin shrink-0"></span>
        <span>${loadingText}</span>
      </div>
    `;
    renderTransportCostHint();
    return;
  }

  if (res.status === 'japan_transit_requires_navitime') {
    routesWrap.classList.add('hidden');
    const gmapsUrl = buildGoogleMapsDirUrl(ctx.pinA, ctx.pinB, 'transit');
    statusEl.innerHTML = `
      <div class="rounded-xl bg-owl-card border border-owl-accentBorder/80 p-3.5 space-y-2.5 text-xs">
        <div class="flex items-start gap-2 text-owl-text">
          <span class="text-base leading-none shrink-0 mt-0.5">🇯🇵</span>
          <div class="leading-relaxed">
            <div class="font-extrabold text-owl-text">日本大眾運輸需啟用 NAVITIME 引擎</div>
            <p class="text-[11px] text-owl-subtext mt-0.5">
              Google 開發者 API 因日本鐵路業者授權限制，不提供日本大眾運輸路線（步行／開車／騎車皆正常）。你可直接點下方查詢日本路線並手動填寫日圓自動換台幣，或免費開啟 NAVITIME 自動抓取電車！
            </p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 pt-0.5">
          <button type="button" id="btn-jp-switch-manual" class="px-3 py-1.5 rounded-lg bg-owl-primary hover:bg-owl-primaryHover text-white text-[11px] font-bold transition">
            改用手動記錄（可填日圓換台幣）
          </button>
          <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-owl-darkTop hover:bg-owl-darkBottom text-owl-cream text-[11px] font-bold transition">
            Google Maps 查車 ↗
          </a>
          <a href="${NAVITIME_JP_WEB_URL}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#EBF2EC] hover:bg-[#DCE9DE] border border-[#C7DCCB] text-[#3E5C45] text-[11px] font-bold transition">
            NAVITIME 繁中 ↗
          </a>
        </div>
        <details class="rounded-lg bg-owl-softBg/70 border border-owl-border/80 px-2.5 py-2 text-[11px] text-owl-subtext">
          <summary class="font-bold text-owl-primaryDeep cursor-pointer select-none">
            如何 2 分鐘免費啟用日本電車自動查詢？（每月 500 次硬上限不扣款）
          </summary>
          <ol class="list-decimal pl-4 mt-1.5 space-y-1 leading-relaxed">
            <li>前往 RapidAPI 訂閱 <strong>NAVITIME Route(totalnavi)</strong> 的 <strong>Basic（$0／月，Hard Limit 硬上限）</strong>方案。</li>
            <li>複製 <code class="px-1 rounded bg-white text-owl-primaryDeep font-mono">X-RapidAPI-Key</code>，到 Vercel 專案 <strong>Settings → Environment Variables</strong> 新增 <code class="px-1 rounded bg-white text-owl-primaryDeep font-mono">RAPIDAPI_NAVITIME_KEY</code> 並 Redeploy 即可自動生效！</li>
          </ol>
        </details>
      </div>
    `;
    refreshIcons();
    renderTransportCostHint();
    document.getElementById('btn-jp-switch-manual')?.addEventListener('click', () => {
      ctx.transitSubTab = 'manual';
      renderTransitTabState();
      document.getElementById('input-transit-line')?.focus();
    });
    return;
  }

  if (res.status === 'api_unconfigured') {
    routesWrap.classList.add('hidden');
    statusEl.innerHTML = `
      <div class="rounded-xl bg-owl-card border border-owl-border p-3 space-y-2 text-xs">
        <div class="flex items-start gap-2 text-owl-text">
          <i data-lucide="key-round" class="w-4 h-4 text-owl-primary shrink-0 mt-0.5"></i>
          <div class="leading-relaxed">
            <div class="font-extrabold">尚未設定 Google Routes API 金鑰</div>
            <p class="text-[11px] text-owl-subtext mt-0.5">
              於專案根目錄建立 <code class="px-1 py-0.5 rounded bg-owl-softBg text-owl-primaryDeep font-mono">.env.local</code> 並填入 <code class="px-1 py-0.5 rounded bg-owl-softBg text-owl-primaryDeep font-mono">GOOGLE_MAPS_API_KEY</code> 後重啟即可自動查詢「步行 → 大眾運輸實際路線與班次 → 步行」。
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2 pt-1">
          <button type="button" id="btn-switch-to-manual-inline" class="px-3 py-1.5 rounded-lg bg-owl-softBg hover:bg-owl-border/75 text-owl-primaryDeep text-[11px] font-bold transition">
            改用手動填寫紀錄
          </button>
          <button type="button" id="btn-recheck-transit-api" class="px-3 py-1.5 rounded-lg bg-white hover:bg-owl-softBg border border-owl-border text-owl-subtext text-[11px] font-bold transition">
            重新偵測
          </button>
        </div>
      </div>
    `;
    refreshIcons();
    renderTransportCostHint();
    document.getElementById('btn-switch-to-manual-inline')?.addEventListener('click', () => {
      ctx.transitSubTab = 'manual';
      renderTransitTabState();
    });
    document.getElementById('btn-recheck-transit-api')?.addEventListener('click', () => {
      runModalTransitQuery(true);
    });
    return;
  }

  if (res.status === 'unsupported') {
    routesWrap.classList.add('hidden');
    statusEl.innerHTML = `
      <div class="rounded-xl bg-[#EFECE7] border border-[#CFC5BA] p-3 flex items-start gap-2 text-xs text-[#5E5248]">
        <i data-lucide="alert-triangle" class="w-4 h-4 text-[#A65D57] shrink-0 mt-0.5"></i>
        <div class="leading-relaxed">
          <div class="font-extrabold">${ctx.isJapan ? '查無日本鐵道／地鐵分段路線' : '此時段查無大眾運輸班次'}</div>
          <p class="text-[11px] text-[#7D6E62] mt-0.5">${escapeHTML(res.message || '請調整上方出發時間、改查 Google Maps，或切換至手動紀錄填寫。')}</p>
        </div>
      </div>
    `;
    refreshIcons();
    renderTransportCostHint();
    return;
  }

  if (res.status !== 'ok' || !Array.isArray(res.routes) || res.routes.length === 0) {
    routesWrap.classList.add('hidden');
    statusEl.innerHTML = `
      <div class="rounded-xl bg-[#EFECE7] border border-[#CFC5BA] p-3 flex items-start gap-2 text-xs text-[#5E5248]">
        <i data-lucide="wifi-off" class="w-4 h-4 text-[#A65D57] shrink-0 mt-0.5"></i>
        <div class="leading-relaxed">
          <div class="font-extrabold">無法取得大眾運輸路線</div>
          <p class="text-[11px] text-[#7D6E62] mt-0.5">${escapeHTML(res.message || '服務暫時無法連線，請重試或改用手動紀錄。')}</p>
        </div>
      </div>
    `;
    refreshIcons();
    renderTransportCostHint();
    return;
  }

  // 成功取得分段大眾運輸路線（全球 Google 或日本 NAVITIME）！
  const routes = res.routes;
  ctx.selectedRouteIndex = Math.min(ctx.selectedRouteIndex || 0, routes.length - 1);
  const selected = routes[ctx.selectedRouteIndex];
  const isNavitime = (selected.provider || res.provider) === 'navitime';

  statusEl.innerHTML = `
    <div class="space-y-1">
      <div class="flex items-center justify-between gap-2 text-xs">
        <div class="flex items-center gap-1.5 text-[#4F6F57] font-bold">
          <i data-lucide="check-circle-2" class="w-4 h-4 shrink-0"></i>
          <span>${isNavitime ? '已取得日本 NAVITIME 分段路線' : '已取得 Google 分段路線與班次'}</span>
        </div>
        <span class="text-[11px] font-extrabold text-owl-primaryDeep tabular-nums-strict">
          總計 ${escapeHTML(formatDurationZh(selected.durationMin))}${selected.distanceKm ? ` · ${selected.distanceKm.toFixed(1)} km` : ''}
        </span>
      </div>
      ${isNavitime ? '<div class="text-[10.5px] text-owl-muted">涵蓋日本 JR／新幹線／地鐵／私鐵與步行（平均車程估算）；若需搭地方公車可點下方 Google Maps 對照。</div>' : ''}
    </div>
  `;

  routesWrap.classList.remove('hidden');

  if (routes.length > 1) {
    tabsEl.classList.remove('hidden');
    tabsEl.innerHTML = routes
      .map((r, idx) => {
        const active = idx === ctx.selectedRouteIndex;
        const transferLabel = r.transferCount > 0 ? `轉乘 ${r.transferCount} 次` : '免轉乘';
        const fareLabel = r.fare?.amountTwd ? ` · ${formatTWD(r.fare.amountTwd)}` : '';
        return `
          <button type="button" data-route-idx="${idx}" class="btn-pick-transit-route flex-1 min-w-[115px] px-2.5 py-1.5 rounded-xl border text-left transition ${active ? 'border-owl-primary bg-owl-card shadow-2xs ring-1 ring-owl-primary/25' : 'border-owl-cardBorder bg-owl-panel/70 hover:bg-owl-card'}">
            <div class="text-[11px] font-extrabold ${active ? 'text-owl-primaryDeep' : 'text-owl-text'} tabular-nums-strict">
              方案 ${idx + 1} · ${escapeHTML(formatDurationZh(r.durationMin))}${escapeHTML(fareLabel)}
            </div>
            <div class="text-[10px] text-owl-subtext truncate">
              步行 ${r.totalWalkMin || 0} 分 · ${transferLabel}
            </div>
          </button>
        `;
      })
      .join('');

    tabsEl.querySelectorAll('.btn-pick-transit-route').forEach((btn) => {
      btn.addEventListener('click', () => {
        ctx.selectedRouteIndex = Number(btn.dataset.routeIdx);
        renderTransitAutoResults({ autoFillFare: true });
      });
    });
  } else {
    tabsEl.classList.add('hidden');
    tabsEl.innerHTML = '';
  }

  // 分段垂直時間軸：步行 → 大眾運輸實際路線／上下車站／班次 → 步行
  timelineEl.innerHTML = selected.segments
    .map((seg, i) => {
      const isLast = i === selected.segments.length - 1;
      if (seg.type === 'WALK') {
        const distStr = formatDistanceMetersZh(seg.distanceMeters);
        return `
          <div class="relative pl-6 ${isLast ? '' : 'pb-3'}">
            ${isLast ? '' : '<div class="absolute left-[9px] top-5 bottom-0 w-0.5 border-l-2 border-dotted border-owl-accentBorder/75"></div>'}
            <span class="absolute left-0 top-0.5 w-5 h-5 rounded-full bg-owl-softBg border border-owl-border flex items-center justify-center text-[11px]">🚶</span>
            <div class="rounded-xl bg-white/90 border border-owl-cardBorder px-3 py-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-bold text-owl-text">${escapeHTML(seg.instruction || '步行')}</span>
                <span class="text-[11px] font-extrabold text-owl-subtext shrink-0 tabular-nums-strict">${escapeHTML(formatDurationZh(seg.durationMin))}</span>
              </div>
              ${distStr ? `<div class="text-[10.5px] text-owl-muted mt-0.5">實際人行道步行距離約 ${escapeHTML(distStr)}</div>` : ''}
            </div>
          </div>
        `;
      }

      const lineBg = pickReadableColor(seg.lineColor, '#6B513A');
      const depName = seg.departureStop?.name || '上車站';
      const arrName = seg.arrivalStop?.name || '下車站';
      const depTime = seg.departureStop?.timeText || '';
      const arrTime = seg.arrivalStop?.timeText || '';
      const metaParts = [
        seg.stopCount ? `共 ${seg.stopCount} 站` : '',
        seg.headwayMin ? `約每 ${seg.headwayMin} 分一班` : '',
        seg.agencyName || '',
      ].filter(Boolean);

      return `
        <div class="relative pl-6 ${isLast ? '' : 'pb-3'}">
          ${isLast ? '' : `<div class="absolute left-[9px] top-5 bottom-0 w-0.5" style="background:${lineBg};"></div>`}
          <span class="absolute left-0 top-0.5 w-5 h-5 rounded-full text-white flex items-center justify-center text-[11px] shadow-2xs" style="background:${lineBg};">${seg.vehicleEmoji || '🚆'}</span>
          <div class="rounded-xl bg-white border border-owl-cardBorder px-3 py-2.5 space-y-1.5" style="border-left: 3.5px solid ${lineBg};">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="px-2 py-0.5 rounded-md text-[11px] font-extrabold text-white shrink-0" style="background:${lineBg};">${escapeHTML(seg.displayLine || seg.vehicleLabel)}</span>
                ${seg.headsign ? `<span class="text-[11px] font-bold text-owl-subtext truncate">往 ${escapeHTML(seg.headsign)}</span>` : ''}
              </div>
              <span class="text-[11px] font-extrabold text-owl-primaryDeep shrink-0 tabular-nums-strict">${escapeHTML(formatDurationZh(seg.durationMin))}</span>
            </div>

            <div class="grid grid-cols-1 gap-1 text-[11px] text-owl-text pt-0.5">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate"><span class="text-owl-muted font-semibold">上車</span> ${escapeHTML(depName)}</span>
                ${depTime ? `<span class="font-bold text-owl-primaryDeep tabular-nums-strict shrink-0">${escapeHTML(depTime)}</span>` : ''}
              </div>
              <div class="flex items-center justify-between gap-2">
                <span class="truncate"><span class="text-owl-muted font-semibold">下車</span> ${escapeHTML(arrName)}</span>
                ${arrTime ? `<span class="font-bold text-owl-primaryDeep tabular-nums-strict shrink-0">${escapeHTML(arrTime)}</span>` : ''}
              </div>
            </div>

            ${metaParts.length > 0 ? `<div class="text-[10.5px] text-owl-muted border-t border-owl-border/50 pt-1">${escapeHTML(metaParts.join(' · '))}</div>` : ''}
          </div>
        </div>
      `;
    })
    .join('');

  refreshIcons();
  renderTransportCostHint({ autoFillFare });
}

async function runModalTransitQuery(forceRefresh = false) {
  const ctx = editingTransportContext;
  if (!ctx || ctx.selectedMode !== 'transit') return;

  const token = ++ctx.queryToken;
  const depMode = document.getElementById('select-transit-time-mode')?.value || 'now';
  const depInput = document.getElementById('input-transit-departure')?.value || '';
  const departureTime = depMode === 'custom' && depInput ? new Date(depInput).toISOString() : '';

  ctx.departureTime = departureTime;
  ctx.transitResult = { status: 'pending', routes: [] };
  renderTransitAutoResults();

  const res = await computeSegmentRoute({
    mode: 'transit',
    pinA: ctx.pinA,
    pinB: ctx.pinB,
    departureTime,
    transitPreference: ctx.transitPreference,
    forceRefresh,
  });

  if (!editingTransportContext || editingTransportContext !== ctx || ctx.queryToken !== token) return;
  ctx.transitResult = res;
  renderTransitAutoResults({ autoFillFare: true });
}

async function runModalLandQuery(forceRefresh = false) {
  const ctx = editingTransportContext;
  if (!ctx || ctx.selectedMode === 'transit') return;

  const token = ++ctx.queryToken;
  const mode = ctx.selectedMode;
  const modeMeta = TRANSPORT_MODES[mode];

  const statusEl = document.getElementById('land-route-status');
  const metricsEl = document.getElementById('land-route-metrics');
  const retryBtn = document.getElementById('btn-retry-land');

  ctx.landResult = { status: 'pending', encodedPolyline: '', distanceKm: null, durationMin: null };
  metricsEl.classList.add('hidden');
  retryBtn.classList.add('hidden');
  statusEl.innerHTML = `
    <div class="flex items-center gap-2 text-owl-subtext font-semibold py-1">
      <span class="w-3.5 h-3.5 rounded-full border-2 border-owl-primary border-t-transparent animate-spin shrink-0"></span>
      <span>正在查詢「${modeMeta.label}」高精度實際道路路線...</span>
    </div>
  `;

  const res = await computeSegmentRoute({
    mode,
    pinA: ctx.pinA,
    pinB: ctx.pinB,
    forceRefresh,
  });

  if (!editingTransportContext || editingTransportContext !== ctx || ctx.queryToken !== token) return;
  ctx.landResult = res;

  if (res.status === 'ok') {
    const providerTag =
      res.provider === 'google' ? 'Google Routes 高精度路網' : 'FOSSGIS OpenStreetMap 路網';
    const noteText = res.fallbackNote ? ` · ${res.fallbackNote}` : '';
    statusEl.innerHTML = `
      <div class="flex items-center gap-2 text-[#4F6F57] font-bold">
        <i data-lucide="check-circle-2" class="w-4 h-4 shrink-0"></i>
        <span>已取得實際貼路路線（${escapeHTML(providerTag)}${escapeHTML(noteText)}）</span>
      </div>
    `;
    document.getElementById('land-metric-distance').textContent = `${Number(res.distanceKm).toFixed(1)} 公里`;
    document.getElementById('land-metric-duration').textContent = formatDurationZh(res.durationMin);
    metricsEl.classList.remove('hidden');
    retryBtn.classList.add('hidden');
  } else if (res.status === 'unsupported') {
    statusEl.innerHTML = `
      <div class="rounded-xl bg-[#EFECE7] border border-[#CFC5BA] p-3 flex items-start gap-2 text-[#5E5248]">
        <i data-lucide="alert-triangle" class="w-4 h-4 text-[#A65D57] shrink-0 mt-0.5"></i>
        <div class="leading-relaxed">
          <div class="font-extrabold">不支援此陸路路線（可能跨海或無道路可達）</div>
          <div class="text-[11px] text-[#7D6E62] mt-0.5">此兩點之間無法以${modeMeta.label}行駛，建議改選「大眾運輸」或以 Google Maps 查詢跨區交通方式。</div>
        </div>
      </div>
    `;
    metricsEl.classList.add('hidden');
    retryBtn.classList.add('hidden');
  } else {
    statusEl.innerHTML = `
      <div class="rounded-xl bg-[#EFECE7] border border-[#CFC5BA] p-3 flex items-start gap-2 text-[#5E5248]">
        <i data-lucide="wifi-off" class="w-4 h-4 text-[#A65D57] shrink-0 mt-0.5"></i>
        <div class="leading-relaxed">
          <div class="font-extrabold">無法連線取得路線</div>
          <div class="text-[11px] text-[#7D6E62] mt-0.5">路網查詢服務暫時無法連線，不會顯示推測時間或橫越街區線條；請稍後重試或使用 Google Maps 查詢。</div>
        </div>
      </div>
    `;
    metricsEl.classList.add('hidden');
    retryBtn.classList.remove('hidden');
  }
  refreshIcons();
}

function renderTransportModalControls() {
  const ctx = editingTransportContext;
  if (!ctx) return;

  const modeGrid = document.getElementById('transport-mode-grid');
  modeGrid.innerHTML = Object.values(TRANSPORT_MODES)
    .map((m) => {
      const active = ctx.selectedMode === m.id;
      return `
        <button type="button" data-mode="${m.id}" class="btn-pick-mode flex flex-col items-center justify-center py-2.5 px-1 rounded-2xl border-2 transition ${active ? 'border-owl-primary bg-owl-softBg text-owl-primaryDeep shadow-xs' : 'border-owl-cardBorder bg-white text-owl-subtext hover:border-owl-accentBorder'}">
          <span class="text-xl leading-none">${m.emoji}</span>
          <span class="text-[11px] font-bold mt-1.5">${m.label}</span>
        </button>
      `;
    })
    .join('');

  modeGrid.querySelectorAll('.btn-pick-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (ctx.selectedMode === btn.dataset.mode) return;
      ctx.selectedMode = btn.dataset.mode;
      // 切換不同交通方式時允許重新自動帶入大眾運輸票價
      if (ctx.selectedMode === 'transit') {
        ctx.userEditedCost = false;
      }
      renderTransportModalControls();
      if (ctx.selectedMode === 'transit') {
        if (ctx.transitSubTab === 'auto') runModalTransitQuery(false);
      } else {
        runModalLandQuery(false);
      }
    });
  });

  const landBox = document.getElementById('land-route-box');
  const transitBox = document.getElementById('transit-details-box');
  const gmapsTransitBtn = document.getElementById('btn-gmaps-transit');
  const gmapsTransitAutoBtn = document.getElementById('btn-gmaps-transit-auto');
  const navitimeAutoBtn = document.getElementById('btn-navitime-transit-auto');
  const navitimeManualBtn = document.getElementById('btn-navitime-transit-manual');
  const gmapsLandBtn = document.getElementById('btn-gmaps-land');

  if (ctx.selectedMode === 'transit') {
    landBox.classList.add('hidden');
    transitBox.classList.remove('hidden');
    const url = buildGoogleMapsDirUrl(ctx.pinA, ctx.pinB, 'transit');
    if (gmapsTransitBtn) gmapsTransitBtn.href = url;
    if (gmapsTransitAutoBtn) gmapsTransitAutoBtn.href = url;
    if (navitimeAutoBtn) {
      navitimeAutoBtn.href = NAVITIME_JP_WEB_URL;
      navitimeAutoBtn.classList.toggle('hidden', !ctx.isJapan);
    }
    if (navitimeManualBtn) {
      navitimeManualBtn.href = NAVITIME_JP_WEB_URL;
      navitimeManualBtn.classList.toggle('hidden', !ctx.isJapan);
    }
    renderTransitTabState();
    renderTransitPreferenceChips();
    renderTransitTypeChips();
    if (ctx.transitSubTab === 'auto' && ctx.transitResult) {
      renderTransitAutoResults({ autoFillFare: false });
    } else {
      renderTransportCostHint();
    }
  } else {
    transitBox.classList.add('hidden');
    landBox.classList.remove('hidden');
    gmapsLandBtn.href = buildGoogleMapsDirUrl(ctx.pinA, ctx.pinB, ctx.selectedMode);
    renderTransportCostHint();
  }
  refreshIcons();
}

export function openTransportModal(dayId, pinIndex) {
  const state = getState();
  const day = state.days.find((d) => d.id === dayId);
  if (!day || !day.pins[pinIndex] || !day.pins[pinIndex + 1]) return;

  const pinA = day.pins[pinIndex];
  const pinB = day.pins[pinIndex + 1];
  const existing = pinA.transportToNext;

  const existingHasSegmented = hasSegmentedTransit(existing);
  const existingCost = Number(existing?.cost) > 0 ? Math.round(Number(existing.cost)) : '';
  const inJapan = isJapanTrip(pinA, pinB);

  editingTransportContext = {
    dayId,
    pinIndex,
    pinA,
    pinB,
    isJapan: inJapan,
    selectedMode: existing?.mode || 'car',
    selectedTransitType: existing?.mode === 'transit' ? existing.transitType || '' : '',
    transitSubTab: 'auto',
    transitPreference: existing?.transitPreference || 'DEFAULT',
    departureTime: existing?.departureTime || '',
    selectedRouteIndex: existing?.selectedRouteIndex || 0,
    userEditedCost: Boolean(existingCost && !existing?.autoUpgradeOnGoogle),
    landResult: null,
    transitResult: existingHasSegmented
      ? {
          status: 'ok',
          provider: existing.provider || 'google',
          routes: [
            {
              provider: existing.provider || 'google',
              durationMin: existing.duration,
              distanceKm: existing.distanceKm,
              totalWalkMin: existing.totalWalkMin || 0,
              transferCount: existing.transferCount || 0,
              summaryText: existing.summaryText || '',
              departureTimeText: existing.departureTimeText || '',
              arrivalTimeText: existing.arrivalTimeText || '',
              encodedPolyline: existing.encodedPolyline || '',
              fare: existing.fare || null,
              segments: existing.segments,
            },
          ],
        }
      : null,
    queryToken: 0,
  };

  document.getElementById('transport-route-header').innerHTML = `
    <span class="font-bold text-owl-text truncate max-w-[140px]">${escapeHTML(pinA.name)}</span>
    <span>→</span>
    <span class="font-bold text-owl-text truncate max-w-[140px]">${escapeHTML(pinB.name)}</span>
  `;

  // 還原交通支出金額與輸入幣別（日本路段若尚未填寫金額則預設 ¥ JPY，填寫即即時換算台幣）
  const costInput = document.getElementById('input-transport-cost');
  const currencySel = document.getElementById('select-transport-currency');
  if (
    existing?.originalCurrency &&
    existing.originalCurrency !== 'TWD' &&
    Number(existing?.originalCost) > 0
  ) {
    if (currencySel) currencySel.value = existing.originalCurrency;
    costInput.value = String(existing.originalCost);
  } else if (existingCost !== '') {
    if (currencySel) currencySel.value = 'TWD';
    costInput.value = String(existingCost);
  } else {
    if (currencySel) currencySel.value = inJapan ? 'JPY' : 'TWD';
    costInput.value = '';
  }

  ensureFxRatesLoaded().then(() => {
    if (editingTransportContext?.pinA?.id === pinA.id) {
      renderTransportCostHint();
    }
  });

  // 還原出發時間控制項
  const timeModeSelect = document.getElementById('select-transit-time-mode');
  const depTimeInput = document.getElementById('input-transit-departure');
  if (existing?.departureTime) {
    timeModeSelect.value = 'custom';
    depTimeInput.value = toDatetimeLocalValue(existing.departureTime);
    depTimeInput.classList.remove('hidden');
  } else {
    timeModeSelect.value = 'now';
    depTimeInput.value = toDatetimeLocalValue('');
    depTimeInput.classList.add('hidden');
  }

  // 還原大眾運輸手動欄位
  document.getElementById('input-transit-line').value = existing?.mode === 'transit' ? existing.line || '' : '';
  document.getElementById('input-transit-schedule').value =
    existing?.mode === 'transit' ? existing.schedule || '' : '';
  document.getElementById('input-transit-duration').value =
    existing?.mode === 'transit' && Number(existing.duration) > 0 ? existing.duration : '';

  renderTransportModalControls();
  document.getElementById('modal-transport').classList.remove('hidden');
  refreshIcons();

  if (editingTransportContext.selectedMode === 'transit') {
    if (!existingHasSegmented) {
      runModalTransitQuery(false);
    }
  } else {
    runModalLandQuery(false);
  }
}

export function closeTransportModal() {
  document.getElementById('modal-transport').classList.add('hidden');
  editingTransportContext = null;
}

async function saveTransportSetting() {
  if (!editingTransportContext) return;
  const ctx = editingTransportContext;
  const state = getState();
  const day = state.days.find((d) => d.id === ctx.dayId);
  const pinA = day?.pins[ctx.pinIndex];
  if (!pinA) return;

  const resolvedCost = resolveTransportInputCost();
  const cost = resolvedCost.costTwd;
  const foreignMeta =
    resolvedCost.originalCurrency !== 'TWD' && resolvedCost.originalCost > 0
      ? {
          originalCost: resolvedCost.originalCost,
          originalCurrency: resolvedCost.originalCurrency,
        }
      : {};

  // 1. 大眾運輸模式
  if (ctx.selectedMode === 'transit') {
    const canSaveAuto =
      ctx.transitSubTab === 'auto' &&
      ctx.transitResult?.status === 'ok' &&
      Array.isArray(ctx.transitResult.routes) &&
      ctx.transitResult.routes.length > 0;

    if (canSaveAuto) {
      const idx = Math.min(ctx.selectedRouteIndex || 0, ctx.transitResult.routes.length - 1);
      const chosenRoute = ctx.transitResult.routes[idx];
      pinA.transportToNext = buildTransitTransportRecord(chosenRoute, {
        provider: chosenRoute.provider || ctx.transitResult.provider || 'google',
        departureTime: ctx.departureTime || '',
        transitPreference: ctx.transitPreference || 'DEFAULT',
        selectedRouteIndex: idx,
        cost,
        ...foreignMeta,
      });

      saveState((msg) => showToast(msg, 'error'));
      closeTransportModal();
      if (typeof onChangeCallback === 'function') onChangeCallback();
      showToast('已套用大眾運輸分段路線與支出', 'success');
      return;
    }

    const line = document.getElementById('input-transit-line').value.trim();
    const schedule = document.getElementById('input-transit-schedule').value.trim();
    const rawDur = document.getElementById('input-transit-duration').value.trim();
    const duration = rawDur ? Math.max(1, Math.round(Number(rawDur))) : null;

    pinA.transportToNext = {
      mode: 'transit',
      status: 'manual',
      provider: 'manual',
      duration,
      distanceKm: null,
      cost,
      ...foreignMeta,
      fare: null,
      encodedPolyline: '',
      segments: [],
      transitType: ctx.selectedTransitType || '',
      line,
      schedule,
    };

    saveState((msg) => showToast(msg, 'error'));
    closeTransportModal();
    if (typeof onChangeCallback === 'function') onChangeCallback();
    showToast(
      hasManualTransitDetails(pinA.transportToNext)
        ? '已儲存大眾運輸手動紀錄與支出'
        : '已設為大眾運輸（待設定班次或手動補記）',
      'success'
    );
    return;
  }

  // 2. 陸路交通模式（汽車 / 機車 / 自行車 / 步行）
  let res = ctx.landResult;
  if (!res || res.status === 'pending') {
    res = await computeSegmentRoute({
      mode: ctx.selectedMode,
      pinA: ctx.pinA,
      pinB: ctx.pinB,
    });
  }

  pinA.transportToNext = {
    mode: ctx.selectedMode,
    status: res.status,
    provider: res.provider || 'osrm',
    duration: res.status === 'ok' ? res.durationMin : null,
    distanceKm: res.status === 'ok' ? res.distanceKm : null,
    cost,
    ...foreignMeta,
    encodedPolyline: res.status === 'ok' ? res.encodedPolyline || '' : '',
    fallbackNote: res.status === 'ok' ? res.fallbackNote || '' : '',
    transitType: '',
    line: '',
    schedule: '',
  };

  saveState((msg) => showToast(msg, 'error'));
  closeTransportModal();
  if (typeof onChangeCallback === 'function') onChangeCallback();

  if (res.status === 'ok') {
    showToast('已套用實際道路路線與交通支出', 'success');
  } else if (res.status === 'unsupported') {
    showToast('已標記：此兩點不支援陸路路線', 'warn');
  } else {
    showToast('目前無法連線取得路線', 'warn');
  }
}

export function bindTransportModalEvents({ onStateChanged }) {
  onChangeCallback = onStateChanged;

  document.getElementById('btn-close-transport').addEventListener('click', closeTransportModal);
  document.getElementById('btn-cancel-transport').addEventListener('click', closeTransportModal);
  document.getElementById('btn-save-transport').addEventListener('click', saveTransportSetting);
  document.getElementById('btn-retry-land').addEventListener('click', () => runModalLandQuery(true));

  document.getElementById('input-transport-cost').addEventListener('input', () => {
    if (!editingTransportContext) return;
    editingTransportContext.userEditedCost = true;
    renderTransportCostHint();
  });

  document.getElementById('select-transport-currency')?.addEventListener('change', () => {
    if (!editingTransportContext) return;
    renderTransportCostHint();
  });

  document.getElementById('btn-transit-tab-auto').addEventListener('click', () => {
    if (!editingTransportContext) return;
    editingTransportContext.transitSubTab = 'auto';
    renderTransitTabState();
    if (!editingTransportContext.transitResult) {
      runModalTransitQuery(false);
    } else {
      renderTransitAutoResults({ autoFillFare: false });
    }
  });

  document.getElementById('btn-transit-tab-manual').addEventListener('click', () => {
    if (!editingTransportContext) return;
    editingTransportContext.transitSubTab = 'manual';
    renderTransitTabState();
    renderTransportCostHint();
  });

  document.getElementById('select-transit-time-mode').addEventListener('change', (e) => {
    const depInput = document.getElementById('input-transit-departure');
    if (e.target.value === 'custom') {
      depInput.classList.remove('hidden');
      if (!depInput.value) depInput.value = toDatetimeLocalValue('');
    } else {
      depInput.classList.add('hidden');
    }
  });

  document.getElementById('btn-query-transit').addEventListener('click', () => {
    if (editingTransportContext) editingTransportContext.userEditedCost = false;
    runModalTransitQuery(true);
  });

  document.getElementById('btn-clear-transport').addEventListener('click', () => {
    if (!editingTransportContext) return;
    const state = getState();
    const day = state.days.find((d) => d.id === editingTransportContext.dayId);
    if (day?.pins[editingTransportContext.pinIndex]) {
      day.pins[editingTransportContext.pinIndex].transportToNext = null;
      saveState((msg) => showToast(msg, 'error'));
      closeTransportModal();
      if (typeof onChangeCallback === 'function') onChangeCallback();
      showToast('已清除該段交通路徑', 'info');
    }
  });
}
