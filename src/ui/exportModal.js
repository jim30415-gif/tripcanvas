import { getActiveTrip, getState } from '../state/store.js';
import {
  A4_HEIGHT,
  A4_WIDTH,
  buildAllTripA4PageSpecs,
  calcDaysSummaryStats,
  downloadDataUrlAsFile,
  openA4PrintWindow,
  renderA4PageToCanvas,
} from '../services/a4PosterExporter.js';
import { escapeHTML, formatTWD, refreshIcons, sanitizeHexColor } from '../utils/format.js';
import { isCustomDialogOpen, showToast } from './dialog.js';

let exportModalContext = null;
let onExportJsonCallback = null;

function isExportModalOpen() {
  const modal = document.getElementById('modal-export');
  return Boolean(modal && !modal.classList.contains('hidden'));
}

function getCacheKey(density, specId) {
  return `${density}:${specId}`;
}

function getSpecChipLabel(spec) {
  if (spec.kind === 'overview') {
    return spec.pageTotal > 1 ? `全行程總覽 (${spec.pageIndex}/${spec.pageTotal})` : '全行程總覽';
  }
  const baseName = spec.day?.name || '行程';
  return spec.pageTotal > 1 ? `${baseName} (${spec.pageIndex}/${spec.pageTotal})` : baseName;
}

function getMapProviderNote(provider) {
  if (provider === 'google') {
    return {
      tone: 'text-[#3E5C45] bg-[#EBF2EC] border-[#C2D8C7]',
      text: `✓ Google Maps 高清實景底圖 · 統一標準 A4 (${A4_WIDTH}×${A4_HEIGHT} px · 150 DPI)`,
    };
  }
  if (provider === 'esri') {
    return {
      tone: 'text-owl-primaryDeep bg-owl-softBg border-owl-border',
      text: `✓ Esri 實景街道底圖 · 統一標準 A4 (${A4_WIDTH}×${A4_HEIGHT} px · 150 DPI)`,
    };
  }
  if (provider === 'osm') {
    return {
      tone: 'text-owl-primaryDeep bg-owl-softBg border-owl-border',
      text: `✓ OpenStreetMap 實景底圖 · 統一標準 A4 (${A4_WIDTH}×${A4_HEIGHT} px · 150 DPI)`,
    };
  }
  if (provider === 'none') {
    return {
      tone: 'text-owl-subtext bg-owl-softBg/80 border-owl-border',
      text: `續頁清單排版 · 統一標準 A4 (${A4_WIDTH}×${A4_HEIGHT} px · 150 DPI)`,
    };
  }
  return {
    tone: 'text-[#8C5B2B] bg-[#FDF6EB] border-[#E7D4B6]',
    text: `離線紙感網格底圖 · 統一標準 A4 (${A4_WIDTH}×${A4_HEIGHT} px · 150 DPI)`,
  };
}

function setExportBusyState(busy, busyButtonId = '', busyLabel = '') {
  if (!exportModalContext) return;
  exportModalContext.isBusy = busy;

  const btnCurrent = document.getElementById('btn-export-a4-current');
  const btnAll = document.getElementById('btn-export-a4-all');
  const btnPrint = document.getElementById('btn-export-a4-print');
  const buttons = [btnCurrent, btnAll, btnPrint].filter(Boolean);

  for (const btn of buttons) {
    btn.disabled = busy;
    btn.classList.toggle('opacity-60', busy);
    btn.classList.toggle('cursor-not-allowed', busy);
  }

  const allLabelEl = document.getElementById('export-a4-all-label');
  const printLabelEl = document.getElementById('export-a4-print-label');
  const totalPages = exportModalContext.specs.length;

  if (allLabelEl) {
    allLabelEl.textContent =
      busy && busyButtonId === 'all' && busyLabel ? busyLabel : `下載全部 A4（${totalPages} 張）`;
  }
  if (printLabelEl) {
    printLabelEl.textContent =
      busy && busyButtonId === 'print' && busyLabel ? busyLabel : '列印 / 存 PDF';
  }
}

function syncExportModeUI() {
  if (!exportModalContext) return;
  const isPoster = exportModalContext.mode === 'poster';

  const tabPoster = document.getElementById('btn-export-tab-poster');
  const tabJson = document.getElementById('btn-export-tab-json');
  const panePoster = document.getElementById('export-pane-poster');
  const paneJson = document.getElementById('export-pane-json');
  const footerPoster = document.getElementById('export-poster-footer');

  if (tabPoster && tabJson) {
    tabPoster.setAttribute('aria-selected', String(isPoster));
    tabJson.setAttribute('aria-selected', String(!isPoster));
    tabPoster.className = isPoster
      ? 'flex-1 py-2 px-3 rounded-xl text-sm font-extrabold bg-owl-primary text-white shadow-2xs transition flex items-center justify-center gap-1.5'
      : 'flex-1 py-2 px-3 rounded-xl text-sm font-bold text-owl-subtext hover:text-owl-text transition flex items-center justify-center gap-1.5';
    tabJson.className = !isPoster
      ? 'flex-1 py-2 px-3 rounded-xl text-sm font-extrabold bg-owl-primary text-white shadow-2xs transition flex items-center justify-center gap-1.5'
      : 'flex-1 py-2 px-3 rounded-xl text-sm font-bold text-owl-subtext hover:text-owl-text transition flex items-center justify-center gap-1.5';
  }

  panePoster?.classList.toggle('hidden', !isPoster);
  paneJson?.classList.toggle('hidden', isPoster);
  footerPoster?.classList.toggle('hidden', !isPoster);
}

function syncDensityToggleUI() {
  if (!exportModalContext) return;
  const isDetailed = exportModalContext.density === 'detailed';
  const btnDetailed = document.getElementById('btn-export-density-detailed');
  const btnCompact = document.getElementById('btn-export-density-compact');

  if (btnDetailed && btnCompact) {
    btnDetailed.className = isDetailed
      ? 'px-2.5 py-1 rounded-lg text-xs font-extrabold bg-owl-primary text-white shadow-2xs transition'
      : 'px-2.5 py-1 rounded-lg text-xs font-bold text-owl-subtext hover:text-owl-text transition';
    btnCompact.className = !isDetailed
      ? 'px-2.5 py-1 rounded-lg text-xs font-extrabold bg-owl-primary text-white shadow-2xs transition'
      : 'px-2.5 py-1 rounded-lg text-xs font-bold text-owl-subtext hover:text-owl-text transition';
  }
}

function renderPageChips() {
  const ctx = exportModalContext;
  const container = document.getElementById('export-page-chips');
  if (!ctx || !container) return;

  container.innerHTML = ctx.specs
    .map((spec, idx) => {
      const active = idx === ctx.selectedSpecIndex;
      const label = escapeHTML(getSpecChipLabel(spec));
      const dotHtml =
        spec.kind === 'overview'
          ? '<span class="text-xs leading-none">🗺️</span>'
          : `<span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${sanitizeHexColor(spec.day?.color, '#9A7B5C')};"></span>`;
      const cls = active
        ? 'bg-owl-darkTop text-owl-cream border-owl-darkTop shadow-xs'
        : 'bg-white text-owl-subtext border-owl-border hover:bg-owl-softBg hover:text-owl-text';
      return `<button type="button" data-export-page-idx="${idx}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold transition whitespace-nowrap ${cls}">${dotHtml}<span>${label}</span></button>`;
    })
    .join('');

  const metaEl = document.getElementById('export-a4-meta');
  if (metaEl) {
    metaEl.textContent = `A4 210×297 mm · 共 ${ctx.specs.length} 頁`;
  }
  const allLabelEl = document.getElementById('export-a4-all-label');
  if (allLabelEl && !ctx.isBusy) {
    allLabelEl.textContent = `下載全部 A4（${ctx.specs.length} 張）`;
  }
}

async function getOrRenderSpec(spec) {
  const ctx = exportModalContext;
  if (!ctx) return null;
  const key = getCacheKey(ctx.density, spec.id);
  if (ctx.cache.has(key)) {
    return ctx.cache.get(key);
  }
  const rendered = await renderA4PageToCanvas(spec, { tripName: ctx.tripName });
  ctx.cache.set(key, rendered);
  return rendered;
}

async function renderSelectedPreview() {
  const ctx = exportModalContext;
  if (!ctx) return;

  const spec = ctx.specs[ctx.selectedSpecIndex] || ctx.specs[0];
  if (!spec) return;

  const seq = ++ctx.renderSeq;
  const loadingEl = document.getElementById('export-a4-loading');
  const imgEl = document.getElementById('export-a4-preview-img');
  const noteEl = document.getElementById('export-map-source-note');

  const cacheKey = getCacheKey(ctx.density, spec.id);
  const isCached = ctx.cache.has(cacheKey);
  if (!isCached) {
    loadingEl?.classList.remove('hidden');
  }

  try {
    const rendered = await getOrRenderSpec(spec);
    if (!exportModalContext || exportModalContext.renderSeq !== seq || !rendered) return;

    if (imgEl) {
      imgEl.src = rendered.dataUrl;
      imgEl.alt = `${ctx.tripName} - ${getSpecChipLabel(spec)} A4 懶人包預覽`;
    }
    if (noteEl) {
      const info = getMapProviderNote(rendered.mapProvider);
      noteEl.className = `inline-flex items-center justify-center text-center text-[11px] sm:text-xs font-bold px-3 py-1 rounded-full border ${info.tone}`;
      noteEl.textContent = info.text;
    }
  } catch (err) {
    console.warn('[TripCanvas] A4 preview render error:', err);
    if (exportModalContext && exportModalContext.renderSeq === seq && noteEl) {
      noteEl.className = 'inline-flex items-center justify-center text-xs font-bold px-3 py-1 rounded-full border text-[#A65D57] bg-[#F9EDEC] border-[#E5C5C2]';
      noteEl.textContent = '預覽產生時發生錯誤，請重新點選頁面再試';
    }
  } finally {
    if (exportModalContext && exportModalContext.renderSeq === seq) {
      loadingEl?.classList.add('hidden');
    }
  }
}

function rebuildSpecsAndRender({ preserveSelection = true } = {}) {
  const ctx = exportModalContext;
  if (!ctx) return;

  const prevSpec = preserveSelection ? ctx.specs[ctx.selectedSpecIndex] : null;
  ctx.specs = buildAllTripA4PageSpecs(ctx.stateSnapshot, { density: ctx.density });

  if (prevSpec) {
    let nextIdx = ctx.specs.findIndex((s) => s.id === prevSpec.id);
    if (nextIdx < 0 && prevSpec.kind === 'day') {
      nextIdx = ctx.specs.findIndex((s) => s.kind === 'day' && s.dayId === prevSpec.dayId);
    }
    ctx.selectedSpecIndex = nextIdx >= 0 ? nextIdx : 0;
  } else {
    const dayCount = ctx.stateSnapshot?.days?.length || 0;
    ctx.selectedSpecIndex = dayCount === 1 && ctx.specs.length > 1 ? 1 : 0;
  }

  syncDensityToggleUI();
  renderPageChips();
  renderSelectedPreview();
}

export function closeExportModal() {
  const modal = document.getElementById('modal-export');
  modal?.classList.add('hidden');
  if (exportModalContext) {
    exportModalContext.renderSeq += 1;
  }
  exportModalContext = null;
}

export function openExportModal() {
  const state = getState();
  const activeTrip = getActiveTrip();
  const tripName = activeTrip?.name || '漫步地圖行程';
  const days = Array.isArray(state?.days) ? state.days : [];
  const stats = calcDaysSummaryStats(days);

  exportModalContext = {
    mode: 'poster',
    density: 'detailed',
    tripName,
    stateSnapshot: state,
    specs: [],
    selectedSpecIndex: 0,
    renderSeq: 0,
    isBusy: false,
    cache: new Map(),
  };

  const subtitleEl = document.getElementById('export-modal-subtitle');
  if (subtitleEl) {
    subtitleEl.textContent = `${tripName} · ${days.length} 天 · ${stats.pinCount} 個標點`;
  }

  const jsonSummaryEl = document.getElementById('export-json-summary');
  if (jsonSummaryEl) {
    const costPart = stats.totalCost > 0 ? ` · 預估總支出 ${formatTWD(stats.totalCost)}` : '';
    jsonSummaryEl.textContent = `目前計畫「${tripName}」：共 ${days.length} 天、${stats.pinCount} 個景點標點${costPart}`;
  }

  const modal = document.getElementById('modal-export');
  modal?.classList.remove('hidden');

  syncExportModeUI();
  setExportBusyState(false);
  rebuildSpecsAndRender({ preserveSelection: false });
  refreshIcons(modal);
}

async function handleDownloadCurrentA4() {
  const ctx = exportModalContext;
  if (!ctx || ctx.isBusy) return;
  const spec = ctx.specs[ctx.selectedSpecIndex] || ctx.specs[0];
  if (!spec) return;

  setExportBusyState(true);
  try {
    const rendered = await getOrRenderSpec(spec);
    if (!rendered) return;
    downloadDataUrlAsFile(rendered.dataUrl, rendered.filename);
    showToast(`已下載 A4 圖片：${rendered.filename}`, 'success');
  } catch (err) {
    console.warn('[TripCanvas] download current A4 failed:', err);
    showToast('下載 A4 圖片失敗，請再試一次', 'error');
  } finally {
    setExportBusyState(false);
  }
}

async function handleDownloadAllA4() {
  const ctx = exportModalContext;
  if (!ctx || ctx.isBusy || ctx.specs.length === 0) return;

  const total = ctx.specs.length;
  setExportBusyState(true, 'all', `準備生成 1 / ${total}...`);
  try {
    let downloaded = 0;
    for (let i = 0; i < total; i++) {
      if (!exportModalContext) return;
      setExportBusyState(true, 'all', `生成中 ${i + 1} / ${total}...`);
      const rendered = await getOrRenderSpec(ctx.specs[i]);
      if (!rendered || !exportModalContext) return;
      downloadDataUrlAsFile(rendered.dataUrl, rendered.filename);
      downloaded += 1;
      if (i < total - 1) {
        await new Promise((r) => setTimeout(r, 260));
      }
    }
    showToast(`已下載全部 ${downloaded} 張標準 A4 PNG 圖片`, 'success');
  } catch (err) {
    console.warn('[TripCanvas] download all A4 failed:', err);
    showToast('批次下載 A4 圖片時發生錯誤，請再試一次', 'error');
  } finally {
    setExportBusyState(false);
  }
}

async function handlePrintAllA4() {
  const ctx = exportModalContext;
  if (!ctx || ctx.isBusy || ctx.specs.length === 0) return;

  // 在點擊事件的同步週期內先行開啟新視窗，避免瀏覽器彈窗攔截
  const printWin = window.open('', '_blank');
  if (!printWin) {
    showToast('瀏覽器已攔截列印視窗，請允許彈出視窗後再試一次', 'error');
    return;
  }

  try {
    printWin.document.open();
    printWin.document.write(`<!DOCTYPE html>
<html lang="zh-Hant">
<head><meta charset="UTF-8"><title>正在排版標準 A4 行程手冊...</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F5EFE6;color:#3A2C21;font-family:system-ui,-apple-system,sans-serif;">
  <div style="text-align:center;padding:24px;">
    <div style="font-size:28px;margin-bottom:8px;">🗺️</div>
    <div style="font-size:18px;font-weight:800;">正在排版標準 A4 行程手冊（共 ${ctx.specs.length} 頁）...</div>
    <div style="font-size:13px;color:#786454;margin-top:6px;">完成後將自動開啟列印與另存 PDF 對話框</div>
  </div>
</body>
</html>`);
    printWin.document.close();
  } catch {
    // 忽略初期寫入失敗，待渲染完成後再覆寫
  }

  const total = ctx.specs.length;
  setExportBusyState(true, 'print', `排版中 1 / ${total}...`);
  try {
    const renderedPages = [];
    for (let i = 0; i < total; i++) {
      if (!exportModalContext) {
        try { printWin.close(); } catch {}
        return;
      }
      setExportBusyState(true, 'print', `排版中 ${i + 1} / ${total}...`);
      const rendered = await getOrRenderSpec(ctx.specs[i]);
      if (rendered) renderedPages.push(rendered);
    }

    if (renderedPages.length === 0) {
      try { printWin.close(); } catch {}
      return;
    }

    openA4PrintWindow(renderedPages, ctx.tripName, printWin);
    showToast(`已開啟 ${renderedPages.length} 頁標準 A4 列印／另存 PDF 預覽`, 'success');
  } catch (err) {
    console.warn('[TripCanvas] print A4 failed:', err);
    try { printWin.close(); } catch {}
    showToast('產生 A4 列印手冊失敗，請再試一次', 'error');
  } finally {
    setExportBusyState(false);
  }
}

export function bindExportModalEvents({ onExportJson } = {}) {
  onExportJsonCallback = onExportJson || null;

  const modal = document.getElementById('modal-export');
  document.getElementById('btn-close-export')?.addEventListener('click', closeExportModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal && !exportModalContext?.isBusy) {
      closeExportModal();
    }
  });

  document.getElementById('btn-export-tab-poster')?.addEventListener('click', () => {
    if (!exportModalContext) return;
    exportModalContext.mode = 'poster';
    syncExportModeUI();
  });

  document.getElementById('btn-export-tab-json')?.addEventListener('click', () => {
    if (!exportModalContext) return;
    exportModalContext.mode = 'json';
    syncExportModeUI();
  });

  document.getElementById('export-page-chips')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-export-page-idx]');
    if (!btn || !exportModalContext || exportModalContext.isBusy) return;
    const idx = Number(btn.dataset.exportPageIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= exportModalContext.specs.length) return;
    if (idx === exportModalContext.selectedSpecIndex) return;
    exportModalContext.selectedSpecIndex = idx;
    renderPageChips();
    renderSelectedPreview();
  });

  document.getElementById('btn-export-density-detailed')?.addEventListener('click', () => {
    if (!exportModalContext || exportModalContext.isBusy || exportModalContext.density === 'detailed') return;
    exportModalContext.density = 'detailed';
    rebuildSpecsAndRender({ preserveSelection: true });
  });

  document.getElementById('btn-export-density-compact')?.addEventListener('click', () => {
    if (!exportModalContext || exportModalContext.isBusy || exportModalContext.density === 'compact') return;
    exportModalContext.density = 'compact';
    rebuildSpecsAndRender({ preserveSelection: true });
  });

  document.getElementById('btn-export-a4-current')?.addEventListener('click', handleDownloadCurrentA4);
  document.getElementById('btn-export-a4-all')?.addEventListener('click', handleDownloadAllA4);
  document.getElementById('btn-export-a4-print')?.addEventListener('click', handlePrintAllA4);

  document.getElementById('btn-export-json-confirm')?.addEventListener('click', () => {
    onExportJsonCallback?.();
    closeExportModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isExportModalOpen() && !isCustomDialogOpen() && !exportModalContext?.isBusy) {
      closeExportModal();
    }
  });
}
