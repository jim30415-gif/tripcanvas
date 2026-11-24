import { getState, saveState } from '../state/store.js';
import { calcDayExpense, calcExpenseBreakdown, getActiveDay } from '../state/selectors.js';
import { escapeHTML, formatTWD, refreshIcons } from '../utils/format.js';
import { fitBoundsToPoints, invalidateMapSize } from '../map/mapInit.js';
import { openCustomDialog, showToast } from './dialog.js';

let activeOverlay = 'none'; // 'none' | 'itinerary' | 'days' | 'expense'
let selectedDetailDayId = null;
let callbacks = {
  onStateChanged: () => {},
  onVisibilityChanged: () => {},
  onAddDay: () => {},
};

function isMobileViewport() {
  return typeof window !== 'undefined' && window.innerWidth < 1024;
}

function formatPct(pct) {
  if (!pct || pct <= 0) return '0%';
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

function syncBackdropAndOrbs() {
  const backdrop = document.getElementById('mobile-hud-backdrop');
  const leftPanel = document.getElementById('panel-left');
  const daysPopup = document.getElementById('mobile-days-popup');
  const dayDetailSheet = document.getElementById('mobile-day-detail-sheet');
  const expenseSheet = document.getElementById('mobile-expense-sheet');
  const orbItinerary = document.getElementById('btn-mobile-orb-itinerary');
  const orbDays = document.getElementById('btn-mobile-orb-days');
  const expensePill = document.getElementById('btn-mobile-expense-pill');
  const expenseArrow = document.getElementById('mobile-expense-arrow');

  const isItineraryOpen = activeOverlay === 'itinerary';
  const isDaysOpen = activeOverlay === 'days';
  const isExpenseOpen = activeOverlay === 'expense';
  const anyOpen = activeOverlay !== 'none';

  if (backdrop) {
    backdrop.classList.toggle('hidden', !anyOpen);
  }

  if (leftPanel) {
    if (isItineraryOpen && isMobileViewport()) {
      leftPanel.classList.remove('hidden');
      leftPanel.classList.add('flex', 'mobile-sheet-animate');
    } else {
      leftPanel.classList.add('hidden');
      leftPanel.classList.remove('flex', 'mobile-sheet-animate');
    }
  }

  if (daysPopup) {
    daysPopup.classList.toggle('hidden', !isDaysOpen);
  }

  if (dayDetailSheet) {
    const showDetail = isDaysOpen && Boolean(selectedDetailDayId);
    dayDetailSheet.classList.toggle('hidden', !showDetail);
  }

  if (expenseSheet) {
    expenseSheet.classList.toggle('hidden', !isExpenseOpen);
  }

  const orbBase =
    'pointer-events-auto relative w-[52px] h-[52px] rounded-full shadow-float flex items-center justify-center transition-all duration-200 active:scale-95 shrink-0 ';
  const orbIdle = 'mobile-glass-orb';
  const orbActive = 'mobile-glass-orb-active shadow-md';

  if (orbItinerary) {
    orbItinerary.className = orbBase + (isItineraryOpen ? orbActive : orbIdle);
    orbItinerary.setAttribute('aria-expanded', String(isItineraryOpen));
  }

  if (orbDays) {
    orbDays.className = orbBase + (isDaysOpen ? orbActive : orbIdle);
    orbDays.setAttribute('aria-expanded', String(isDaysOpen));
  }

  if (expensePill) {
    expensePill.setAttribute('aria-expanded', String(isExpenseOpen));
  }

  if (expenseArrow) {
    expenseArrow.style.transform = isExpenseOpen ? 'rotate(180deg)' : 'rotate(0deg)';
  }
}

function renderMobileExpenseSheet(breakdown) {
  const sheet = document.getElementById('mobile-expense-sheet');
  if (!sheet) return;

  const barHtml =
    breakdown.grandTotal > 0
      ? breakdown.days
          .map((d) => {
            if (d.amount <= 0) return '';
            const pct = (d.amount / breakdown.grandTotal) * 100;
            return `<div class="h-full first:rounded-l-full last:rounded-r-full transition-all" style="width:${pct}%; background:${d.color}; opacity:${d.visible ? 1 : 0.35};"></div>`;
          })
          .join('')
      : '';

  let detailBody = `<div class="text-xs text-[#CBB7A1] text-center py-3">尚未記錄任何支出項目</div>`;
  if (breakdown.grandTotal > 0) {
    const categoriesHtml = breakdown.categories
      .map(
        (c) => `
        <div class="space-y-1">
          <div class="flex items-center justify-between gap-2 text-[11px] leading-tight">
            <span class="inline-flex items-center gap-1.5 text-[#F2E7D9] font-semibold">
              <span>${c.emoji}</span>
              <span>${escapeHTML(c.label)}</span>
            </span>
            <span class="tabular-nums-strict text-[#FAF4EC] font-bold">
              ${formatTWD(c.amount)}
              <span class="text-[#E5C59E] font-semibold ml-1">${formatPct(c.pct)}</span>
            </span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-white/15 overflow-hidden">
            <div class="h-full rounded-full transition-all" style="width:${Math.min(100, c.pct)}%; background:${c.color};"></div>
          </div>
        </div>
      `
      )
      .join('');

    const daysHtml = breakdown.days
      .map(
        (d) => `
        <div class="space-y-1 ${d.visible ? '' : 'opacity-60'}">
          <div class="flex items-center justify-between gap-2 text-[11px] leading-tight">
            <span class="inline-flex items-center gap-1.5 min-w-0 text-[#F2E7D9] font-semibold">
              <span class="w-2 h-2 rounded-full shrink-0" style="background:${d.color};"></span>
              <span class="truncate">${escapeHTML(d.name)}</span>
            </span>
            <span class="tabular-nums-strict text-[#FAF4EC] font-bold shrink-0">
              ${formatTWD(d.amount)}
              <span class="text-[#E5C59E] font-semibold ml-1">${formatPct(d.pct)}</span>
            </span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-white/15 overflow-hidden">
            <div class="h-full rounded-full transition-all" style="width:${Math.min(100, d.pct)}%; background:${d.color};"></div>
          </div>
        </div>
      `
      )
      .join('');

    detailBody = `
      <div class="space-y-3 pt-2.5 border-t border-white/15">
        <div class="space-y-1.5">
          <div class="text-[10.5px] font-bold tracking-wide text-[#CBB7A1]">分類開銷比例</div>
          <div class="space-y-1.5">${categoriesHtml}</div>
        </div>
        <div class="border-t border-white/12 pt-2.5 space-y-1.5">
          <div class="text-[10.5px] font-bold tracking-wide text-[#CBB7A1]">各天數開銷比例</div>
          <div class="space-y-1.5">${daysHtml}</div>
        </div>
      </div>
    `;
  }

  sheet.innerHTML = `
    <div class="space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-baseline gap-2 min-w-0">
          <span class="text-xs font-bold text-[#F2E7D9]">旅程總支出</span>
          <span class="text-[10px] text-[#CBB7A1]">共 ${breakdown.totalItemCount} 項</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-lg font-extrabold text-owl-cream tabular-nums-strict">${formatTWD(breakdown.grandTotal)}</span>
          <button type="button" id="btn-close-mobile-expense" aria-label="關閉支出明細" class="w-6 h-6 rounded-full bg-white/12 hover:bg-white/22 text-[#F2E7D9] flex items-center justify-center transition">
            <i data-lucide="x" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
      <div class="expense-bar-track !my-0">${barHtml}</div>
      <div class="flex items-center justify-between text-[11px] text-[#D8C7B4]">
        <span class="inline-flex items-center gap-1">
          <i data-lucide="eye" class="w-3 h-3 text-owl-gold"></i>
          <span>顯示中圖層小計</span>
        </span>
        <span class="font-bold text-owl-gold tabular-nums-strict">${formatTWD(breakdown.visibleTotal)}</span>
      </div>
      ${detailBody}
    </div>
  `;

  sheet.querySelector('#btn-close-mobile-expense')?.addEventListener('click', () => {
    closeAllMobileOverlays();
  });
}

function renderMobileDayDetailSheet() {
  const sheet = document.getElementById('mobile-day-detail-sheet');
  if (!sheet) return;

  const state = getState();
  const dayIndex = state.days.findIndex((d) => d.id === selectedDetailDayId);
  const day = dayIndex >= 0 ? state.days[dayIndex] : null;

  if (!day) {
    selectedDetailDayId = null;
    sheet.classList.add('hidden');
    return;
  }

  const isActive = day.id === state.activeDayId;
  const dayExpense = calcDayExpense(day);

  sheet.innerHTML = `
    <div class="space-y-3">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-3 h-3 rounded-full shrink-0 ring-2 ring-owl-card shadow-2xs" style="background:${day.color};"></span>
          <div class="min-w-0">
            <div class="text-[10px] font-bold text-owl-muted leading-none">第 ${dayIndex + 1} 天 · 詳細設定</div>
            <h4 class="text-xs font-extrabold text-owl-text truncate mt-1">${escapeHTML(day.name)}</h4>
          </div>
        </div>
        <button type="button" id="btn-close-mobile-day-detail" aria-label="關閉單日詳細設定" class="w-6 h-6 rounded-full bg-owl-softBg hover:bg-owl-border/70 text-owl-subtext flex items-center justify-center shrink-0 transition">
          <i data-lucide="x" class="w-3.5 h-3.5"></i>
        </button>
      </div>

      <div class="flex items-center justify-between gap-2 px-2.5 py-2 rounded-2xl bg-owl-card/85 border border-owl-cardBorder text-[11px]">
        <div class="flex items-center gap-1.5 text-owl-subtext font-medium">
          <span>${day.pins.length} 個標點</span>
          <span class="text-owl-border">·</span>
          <span class="font-bold text-owl-text tabular-nums-strict">${formatTWD(dayExpense)}</span>
        </div>
        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${
          isActive ? 'bg-owl-softBg text-owl-primaryDeep' : 'bg-owl-canvas text-owl-muted'
        }">${isActive ? '● 編輯中' : '未選取'}</span>
      </div>

      <button
        type="button"
        id="btn-mobile-day-primary"
        class="w-full py-2 px-3 rounded-xl bg-owl-primary hover:bg-owl-primaryHover text-white text-xs font-extrabold shadow-xs flex items-center justify-center gap-1.5 transition active:scale-95"
      >
        <i data-lucide="${isActive ? 'list-ordered' : 'check'}" class="w-3.5 h-3.5"></i>
        <span>${isActive ? '查看這一天行程清單' : '切換並編輯這一天'}</span>
      </button>

      <div class="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          id="btn-mobile-day-eye"
          class="py-1.5 px-2 rounded-xl border text-[11px] font-bold flex items-center justify-center gap-1 transition active:scale-95 ${
            day.visible
              ? 'bg-owl-softBg border-owl-accentBorder text-owl-primaryDeep'
              : 'bg-owl-canvas/80 border-owl-border text-owl-muted'
          }"
        >
          <i data-lucide="${day.visible ? 'eye' : 'eye-off'}" class="w-3.5 h-3.5 shrink-0"></i>
          <span>${day.visible ? '顯示中' : '已隱藏'}</span>
        </button>

        <button
          type="button"
          id="btn-mobile-day-rename"
          class="py-1.5 px-2 rounded-xl bg-owl-card/90 hover:bg-owl-softBg border border-owl-border text-[11px] font-bold text-owl-text flex items-center justify-center gap-1 transition active:scale-95"
        >
          <i data-lucide="pencil" class="w-3 h-3 shrink-0"></i>
          <span>改名</span>
        </button>

        <button
          type="button"
          id="btn-mobile-day-delete"
          class="py-1.5 px-2 rounded-xl bg-owl-card/90 hover:bg-[#F9EDEC] border border-owl-border hover:border-[#E3BDB8] text-[11px] font-bold text-[#9B534B] flex items-center justify-center gap-1 transition active:scale-95"
        >
          <i data-lucide="trash-2" class="w-3 h-3 shrink-0"></i>
          <span>刪除</span>
        </button>
      </div>
    </div>
  `;

  sheet.querySelector('#btn-close-mobile-day-detail')?.addEventListener('click', () => {
    selectedDetailDayId = null;
    syncBackdropAndOrbs();
  });

  sheet.querySelector('#btn-mobile-day-primary')?.addEventListener('click', () => {
    const latestState = getState();
    const chosen = latestState.days.find((d) => d.id === day.id);
    if (!chosen) return;
    if (latestState.activeDayId !== chosen.id) {
      latestState.activeDayId = chosen.id;
      saveState((msg) => showToast(msg, 'error'));
      callbacks.onStateChanged();
      if (chosen.visible && chosen.pins.length > 0) {
        fitBoundsToPoints(
          chosen.pins.map((p) => [p.lat, p.lng]),
          { padding: [70, 70], maxZoom: 14 }
        );
      }
      showToast(`已切換至「${chosen.name}」`, 'success');
      closeAllMobileOverlays();
    } else {
      selectedDetailDayId = null;
      activeOverlay = 'itinerary';
      syncBackdropAndOrbs();
    }
  });

  sheet.querySelector('#btn-mobile-day-eye')?.addEventListener('click', () => {
    const latestState = getState();
    const target = latestState.days.find((d) => d.id === day.id);
    if (!target) return;
    target.visible = !target.visible;
    saveState((msg) => showToast(msg, 'error'));
    callbacks.onVisibilityChanged();
  });

  sheet.querySelector('#btn-mobile-day-rename')?.addEventListener('click', async () => {
    const latestState = getState();
    const target = latestState.days.find((d) => d.id === day.id);
    if (!target) return;
    const newName = await openCustomDialog({
      title: '修改天數圖層名稱',
      message: '輸入這一天的行程名稱：',
      inputValue: target.name,
      placeholder: '例：Day 3 · 九份山城一日遊',
      confirmText: '儲存名稱',
    });
    if (newName) {
      target.name = newName;
      saveState((msg) => showToast(msg, 'error'));
      callbacks.onStateChanged();
      showToast('已更新天數名稱', 'success');
    }
  });

  sheet.querySelector('#btn-mobile-day-delete')?.addEventListener('click', async () => {
    const latestState = getState();
    if (latestState.days.length <= 1) {
      showToast('至少需要保留一個天數圖層', 'error');
      return;
    }
    const target = latestState.days.find((d) => d.id === day.id);
    if (!target) return;
    const ok = await openCustomDialog({
      title: '確定刪除此天數圖層？',
      message: `「${target.name}」內含的 ${target.pins.length} 個標點與支出資料將會一併移除。`,
      confirmText: '確定刪除',
      danger: true,
    });
    if (ok) {
      latestState.days = latestState.days.filter((d) => d.id !== target.id);
      if (latestState.activeDayId === target.id) {
        latestState.activeDayId = latestState.days[0].id;
      }
      selectedDetailDayId = null;
      saveState((msg) => showToast(msg, 'error'));
      callbacks.onStateChanged();
      showToast('已刪除天數圖層', 'info');
    }
  });
}

function renderMobileDaysPopup() {
  const popup = document.getElementById('mobile-days-popup');
  if (!popup) return;

  const state = getState();
  const totalCount = state.days.length;

  // 正方形方塊（56×56），上方附同尺寸「+ 新增」正方形，往下依序為第 1 天、第 2 天…
  const addSquareHtml = `
    <button
      type="button"
      id="btn-mobile-add-day"
      title="新增天數"
      aria-label="新增天數"
      style="animation-delay: ${Math.min(totalCount, 6) * 24}ms;"
      class="mobile-day-square-animate mobile-day-tile-add w-[56px] h-[56px] rounded-2xl shadow-float flex flex-col items-center justify-center gap-0.5 shrink-0 transition active:scale-95"
    >
      <i data-lucide="plus" class="w-4 h-4"></i>
      <span class="text-[10px] font-bold leading-none">新增</span>
    </button>
  `;

  const squaresHtml = state.days
    .map((day, idx) => {
      const isActive = day.id === state.activeDayId;
      const isSelectedDetail = day.id === selectedDetailDayId;
      const delayMs = Math.min(totalCount - 1 - idx, 6) * 24;
      const tileClass = isSelectedDetail
        ? 'mobile-day-tile-selected'
        : isActive
          ? 'mobile-day-tile-active'
          : 'mobile-day-tile-idle';
      const dimClass = day.visible ? '' : 'opacity-55';

      return `
        <button
          type="button"
          data-mobile-day-id="${day.id}"
          title="${escapeHTML(day.name)}（點擊進行詳細設定）"
          style="animation-delay: ${delayMs}ms;"
          class="mobile-day-square mobile-day-square-animate w-[56px] h-[56px] rounded-2xl shadow-float flex flex-col items-center justify-center gap-1 shrink-0 transition active:scale-95 ${tileClass} ${dimClass}"
        >
          <span class="w-2 h-2 rounded-full shrink-0 shadow-2xs" style="background:${day.color};"></span>
          <span class="text-[11px] font-extrabold text-owl-text leading-none tracking-tight whitespace-nowrap">第 ${idx + 1} 天</span>
        </button>
      `;
    })
    .join('');

  popup.innerHTML = addSquareHtml + squaresHtml;

  popup.querySelector('#btn-mobile-add-day')?.addEventListener('click', () => {
    callbacks.onAddDay();
  });

  popup.querySelectorAll('.mobile-day-square').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dayId = btn.dataset.mobileDayId;
      selectedDetailDayId = selectedDetailDayId === dayId ? null : dayId;
      renderMobileDaysPopup();
      renderMobileDayDetailSheet();
      syncBackdropAndOrbs();
      refreshIcons();
    });
  });
}

export function renderMobileHud() {
  const state = getState();
  const activeDay = getActiveDay(state);
  const breakdown = calcExpenseBreakdown(state);

  const totalEl = document.getElementById('mobile-grand-total-expense');
  if (totalEl) {
    totalEl.textContent = formatTWD(breakdown.grandTotal);
  }

  const orbDot = document.getElementById('mobile-orb-day-dot');
  if (orbDot && activeDay) {
    orbDot.style.backgroundColor = activeDay.color;
  }

  renderMobileDaysPopup();
  renderMobileDayDetailSheet();
  renderMobileExpenseSheet(breakdown);
  syncBackdropAndOrbs();
  refreshIcons();
}

export function closeAllMobileOverlays() {
  activeOverlay = 'none';
  selectedDetailDayId = null;
  syncBackdropAndOrbs();
}

export function setMobileTab(tabName) {
  if (tabName === 'left') {
    activeOverlay = 'itinerary';
    selectedDetailDayId = null;
  } else if (tabName === 'right') {
    activeOverlay = 'days';
  } else {
    activeOverlay = 'none';
    selectedDetailDayId = null;
  }
  syncBackdropAndOrbs();
  if (tabName === 'map') {
    setTimeout(() => invalidateMapSize(), 120);
  }
}

export function bindMobileNav({ onStateChanged, onVisibilityChanged, onAddDay } = {}) {
  callbacks = {
    onStateChanged: onStateChanged || (() => {}),
    onVisibilityChanged: onVisibilityChanged || (() => {}),
    onAddDay: onAddDay || (() => {}),
  };

  document.getElementById('btn-mobile-orb-itinerary')?.addEventListener('click', () => {
    selectedDetailDayId = null;
    activeOverlay = activeOverlay === 'itinerary' ? 'none' : 'itinerary';
    syncBackdropAndOrbs();
  });

  document.getElementById('btn-close-mobile-itinerary')?.addEventListener('click', () => {
    closeAllMobileOverlays();
  });

  document.getElementById('btn-mobile-orb-days')?.addEventListener('click', () => {
    if (activeOverlay === 'days') {
      closeAllMobileOverlays();
    } else {
      activeOverlay = 'days';
      selectedDetailDayId = null;
      renderMobileDaysPopup();
      renderMobileDayDetailSheet();
      syncBackdropAndOrbs();
      refreshIcons();
    }
  });

  document.getElementById('btn-mobile-expense-pill')?.addEventListener('click', () => {
    selectedDetailDayId = null;
    activeOverlay = activeOverlay === 'expense' ? 'none' : 'expense';
    renderMobileExpenseSheet(calcExpenseBreakdown(getState()));
    syncBackdropAndOrbs();
    refreshIcons();
  });

  document.getElementById('mobile-hud-backdrop')?.addEventListener('click', () => {
    closeAllMobileOverlays();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeOverlay !== 'none') {
      closeAllMobileOverlays();
    }
  });

  window.addEventListener('resize', () => {
    if (!isMobileViewport() && activeOverlay !== 'none') {
      closeAllMobileOverlays();
    }
  });
}
