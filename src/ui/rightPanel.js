import { getState, saveState } from '../state/store.js';
import { calcExpenseBreakdown } from '../state/selectors.js';
import { escapeHTML, formatTWD, refreshIcons, sanitizeHexColor } from '../utils/format.js';
import { fitBoundsToPoints } from '../map/mapInit.js';
import { isCustomDialogOpen, openCustomDialog, showToast } from './dialog.js';

let isDesktopExpenseOpen = false;
let desktopExpenseBound = false;

function formatPct(pct) {
  if (!pct || pct <= 0) return '0%';
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

export function closeDesktopExpenseSheet() {
  if (!isDesktopExpenseOpen) return;
  isDesktopExpenseOpen = false;
  syncDesktopExpenseUI(calcExpenseBreakdown(getState()));
}

function syncDesktopExpenseUI(breakdown) {
  const pill = document.getElementById('btn-desktop-expense-pill');
  const totalEl = document.getElementById('desktop-grand-total-expense');
  const arrowEl = document.getElementById('desktop-expense-arrow');
  const sheet = document.getElementById('desktop-expense-sheet');

  if (totalEl) {
    totalEl.textContent = formatTWD(breakdown.grandTotal);
  }
  if (pill) {
    pill.setAttribute('aria-expanded', String(isDesktopExpenseOpen));
  }
  if (arrowEl) {
    arrowEl.style.transform = isDesktopExpenseOpen ? 'rotate(180deg)' : 'rotate(0deg)';
  }
  if (!sheet) return;

  if (!isDesktopExpenseOpen) {
    sheet.classList.add('hidden');
    return;
  }

  const barHtml =
    breakdown.grandTotal > 0
      ? breakdown.days
          .map((d) => {
            if (d.amount <= 0) return '';
            const pct = (d.amount / breakdown.grandTotal) * 100;
            const roundedPct = Math.round(pct);
            const safeColor = sanitizeHexColor(d.color);
            return `<div class="h-full first:rounded-l-full last:rounded-r-full transition-all" style="width:${pct}%; background:${safeColor}; opacity:${d.visible ? 1 : 0.35};" title="${escapeHTML(d.name)}：${formatTWD(d.amount)}（佔 ${roundedPct}%）"></div>`;
          })
          .join('')
      : '';

  let detailBody = `<div class="text-sm text-[#CBB7A1] text-center py-3">尚未記錄任何支出項目</div>`;
  if (breakdown.grandTotal > 0) {
    const categoriesHtml = breakdown.categories
      .map(
        (c) => `
        <div class="space-y-1">
          <div class="flex items-center justify-between gap-2 text-xs sm:text-[13px] leading-tight">
            <span class="inline-flex items-center gap-1.5 text-[#F2E7D9] font-semibold">
              <span>${escapeHTML(c.emoji || '')}</span>
              <span>${escapeHTML(c.label)}</span>
            </span>
            <span class="tabular-nums-strict text-[#FAF4EC] font-bold">
              ${formatTWD(c.amount)}
              <span class="text-[#E5C59E] font-semibold ml-1">${formatPct(c.pct)}</span>
            </span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-white/15 overflow-hidden">
            <div class="h-full rounded-full transition-all" style="width:${Math.min(100, c.pct)}%; background:${sanitizeHexColor(c.color)};"></div>
          </div>
        </div>
      `
      )
      .join('');

    const daysHtml = breakdown.days
      .map((d) => {
        const safeColor = sanitizeHexColor(d.color);
        return `
        <div class="space-y-1 ${d.visible ? '' : 'opacity-60'}">
          <div class="flex items-center justify-between gap-2 text-xs sm:text-[13px] leading-tight">
            <span class="inline-flex items-center gap-1.5 min-w-0 text-[#F2E7D9] font-semibold">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${safeColor};"></span>
              <span class="truncate">${escapeHTML(d.name)}</span>
            </span>
            <span class="tabular-nums-strict text-[#FAF4EC] font-bold shrink-0">
              ${formatTWD(d.amount)}
              <span class="text-[#E5C59E] font-semibold ml-1">${formatPct(d.pct)}</span>
            </span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-white/15 overflow-hidden">
            <div class="h-full rounded-full transition-all" style="width:${Math.min(100, d.pct)}%; background:${safeColor};"></div>
          </div>
        </div>
      `;
      })
      .join('');

    detailBody = `
      <div class="space-y-3.5 pt-3 border-t border-white/15">
        <div class="space-y-2">
          <div class="text-xs font-bold tracking-wide text-[#CBB7A1]">分類開銷比例</div>
          <div class="space-y-2">${categoriesHtml}</div>
        </div>
        <div class="border-t border-white/12 pt-3 space-y-2">
          <div class="text-xs font-bold tracking-wide text-[#CBB7A1]">各天數開銷比例</div>
          <div class="space-y-2">${daysHtml}</div>
        </div>
      </div>
    `;
  }

  sheet.innerHTML = `
    <div class="space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-baseline gap-2 min-w-0">
          <span class="text-sm font-bold text-[#F2E7D9]">旅程總支出</span>
          <span class="text-xs text-[#CBB7A1]">共 ${breakdown.totalItemCount} 項</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-xl font-extrabold text-owl-cream tabular-nums-strict">${formatTWD(breakdown.grandTotal)}</span>
          <button type="button" id="btn-close-desktop-expense" aria-label="關閉支出明細" class="w-8 h-8 rounded-full bg-white/12 hover:bg-white/22 text-[#F2E7D9] flex items-center justify-center transition">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
      <div class="expense-bar-track !my-0">${barHtml}</div>
      <div class="flex items-center justify-between text-xs text-[#D8C7B4]">
        <span class="inline-flex items-center gap-1.5">
          <i data-lucide="eye" class="w-3.5 h-3.5 text-owl-gold"></i>
          <span>顯示中圖層小計</span>
        </span>
        <span class="font-bold text-owl-gold tabular-nums-strict">${formatTWD(breakdown.visibleTotal)}</span>
      </div>
      ${detailBody}
    </div>
  `;

  sheet.classList.remove('hidden');
  refreshIcons(sheet);

  sheet.querySelector('#btn-close-desktop-expense')?.addEventListener('click', () => {
    closeDesktopExpenseSheet();
  });
}

function ensureDesktopExpenseBound() {
  if (desktopExpenseBound) return;
  const pill = document.getElementById('btn-desktop-expense-pill');
  if (!pill) return;
  desktopExpenseBound = true;

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    isDesktopExpenseOpen = !isDesktopExpenseOpen;
    syncDesktopExpenseUI(calcExpenseBreakdown(getState()));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDesktopExpenseOpen && !isCustomDialogOpen()) {
      closeDesktopExpenseSheet();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth < 1024 && isDesktopExpenseOpen) {
      closeDesktopExpenseSheet();
    }
  });
}

export function renderRightPanel({ onStateChanged, onVisibilityChanged, getFitBoundsOptions }) {
  ensureDesktopExpenseBound();

  const state = getState();
  const container = document.getElementById('day-layers-list');
  if (!container) return;

  let html = '';

  state.days.forEach((day) => {
    const isActive = day.id === state.activeDayId;
    const safeDayId = escapeHTML(day.id);
    const safeColor = sanitizeHexColor(day.color);

    const dimmedClass = day.visible ? 'opacity-100' : 'opacity-55 bg-owl-canvas/65';
    const activeBorder = isActive
      ? 'ring-2 ring-owl-primary/25 border-owl-accentBorder bg-owl-selectedBg shadow-xs'
      : 'border-owl-cardBorder hover:border-owl-accentBorder/75 bg-owl-card';

    html += `
      <div tabindex="0" role="button" aria-label="切換至 ${escapeHTML(day.name)}" class="day-layer-card rounded-xl border px-3 py-2.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-owl-primary/40 ${activeBorder} ${dimmedClass}" data-day-id="${safeDayId}">
        <div class="flex items-center justify-between gap-1.5">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="w-3 h-3 rounded-full shrink-0 shadow-2xs ring-2 ring-owl-card" style="background:${safeColor};"></span>
            <div class="day-name-label text-sm font-extrabold text-owl-text truncate" data-day-id="${safeDayId}" title="雙擊重新命名">
              ${escapeHTML(day.name)}
            </div>
          </div>

          <div class="flex items-center gap-0.5 shrink-0">
            <button type="button" data-rename-day-id="${safeDayId}" title="重新命名" aria-label="重新命名 ${escapeHTML(day.name)}" class="btn-rename-day w-7 h-7 rounded-lg text-owl-muted hover:text-owl-primaryDeep hover:bg-owl-softBg flex items-center justify-center transition">
              <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
            </button>
            <button type="button" data-delete-day-id="${safeDayId}" title="刪除此天數" aria-label="刪除 ${escapeHTML(day.name)}" class="btn-delete-day w-7 h-7 rounded-lg text-owl-muted hover:text-[#A65D57] hover:bg-[#F9EDEC] flex items-center justify-center transition">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
            <button type="button" data-eye-day-id="${safeDayId}" title="${day.visible ? '隱藏此天數地圖顯示' : '開啟此天數地圖顯示'}" aria-label="${day.visible ? `隱藏 ${escapeHTML(day.name)}` : `顯示 ${escapeHTML(day.name)}`}" aria-pressed="${day.visible}" class="btn-toggle-eye w-8 h-8 rounded-lg flex items-center justify-center ml-0.5 transition ${day.visible ? 'bg-owl-softBg text-owl-primaryDeep hover:bg-[#E5D7C5]' : 'bg-owl-border/60 text-owl-muted hover:bg-owl-border'}">
              <i data-lucide="${day.visible ? 'eye' : 'eye-off'}" class="w-4 h-4"></i>
            </button>
          </div>
        </div>

        <div class="mt-1.5 pl-[20px] flex items-center justify-between gap-2 text-xs leading-tight">
          <span class="text-owl-subtext font-semibold truncate">${day.pins.length} 個標點</span>
          <span class="shrink-0 text-xs ${isActive ? 'text-owl-primaryDeep font-bold bg-owl-softBg px-2 py-0.5 rounded-md' : 'text-owl-muted font-medium'}">
            ${isActive ? '● 編輯中' : '切換'}
          </span>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  // 更新地圖下方中央的電腦版總支出膠囊與可展開明細
  syncDesktopExpenseUI(calcExpenseBreakdown(state));
  refreshIcons(container);

  const promptRenameDay = async (dayId) => {
    const initialDay = getState().days.find((d) => d.id === dayId);
    if (!initialDay) return;
    const newName = await openCustomDialog({
      title: '修改天數圖層名稱',
      message: '輸入這一天的行程名稱：',
      inputValue: initialDay.name,
      placeholder: '例：Day 3 · 九份山城一日遊',
      confirmText: '儲存名稱',
    });
    if (newName) {
      const latestDay = getState().days.find((d) => d.id === dayId);
      if (!latestDay) return;
      latestDay.name = newName;
      saveState((msg) => showToast(msg, 'error'));
      onStateChanged();
      showToast('已更新天數名稱', 'success');
    }
  };

  const selectDayCard = (dayId) => {
    const latestState = getState();
    const chosen = latestState.days.find((d) => d.id === dayId);
    if (!chosen) return;
    latestState.activeDayId = dayId;
    saveState((msg) => showToast(msg, 'error'));
    onStateChanged();
    if (chosen.visible && chosen.pins.length > 0) {
      const opts =
        typeof getFitBoundsOptions === 'function'
          ? getFitBoundsOptions(14)
          : { padding: [80, 80], maxZoom: 14 };
      fitBoundsToPoints(
        chosen.pins.map((p) => [p.lat, p.lng]),
        opts
      );
    }
  };

  container.querySelectorAll('.day-layer-card').forEach((card) => {
    card.addEventListener('click', () => selectDayCard(card.dataset.dayId));
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectDayCard(card.dataset.dayId);
      }
    });
  });

  container.querySelectorAll('.day-name-label').forEach((lbl) => {
    lbl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      void promptRenameDay(lbl.dataset.dayId);
    });
  });

  container.querySelectorAll('.btn-toggle-eye').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const day = getState().days.find((d) => d.id === btn.dataset.eyeDayId);
      if (!day) return;
      day.visible = !day.visible;
      saveState((msg) => showToast(msg, 'error'));
      onVisibilityChanged();
    });
  });

  container.querySelectorAll('.btn-rename-day').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void promptRenameDay(btn.dataset.renameDayId);
    });
  });

  container.querySelectorAll('.btn-delete-day').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const dayId = btn.dataset.deleteDayId;
      const beforeState = getState();
      if (beforeState.days.length <= 1) {
        showToast('至少需要保留一個天數圖層', 'error');
        return;
      }
      const day = beforeState.days.find((d) => d.id === dayId);
      if (!day) return;
      const ok = await openCustomDialog({
        title: '確定刪除此天數圖層？',
        message: `「${day.name}」內含的 ${day.pins.length} 個標點與支出資料將會一併移除。`,
        confirmText: '確定刪除',
        danger: true,
      });
      if (ok) {
        const latestState = getState();
        if (latestState.days.length <= 1) return;
        latestState.days = latestState.days.filter((d) => d.id !== dayId);
        if (latestState.activeDayId === dayId && latestState.days[0]) {
          latestState.activeDayId = latestState.days[0].id;
        }
        saveState((msg) => showToast(msg, 'error'));
        onStateChanged();
        showToast('已刪除天數圖層', 'info');
      }
    });
  });
}
