import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_MAP } from '../config/constants.js';
import { getState, saveState } from '../state/store.js';
import {
  calcDayExpense,
  calcExpenseBreakdown,
  calcTransportExpense,
  getActiveDay,
} from '../state/selectors.js';
import { escapeHTML, formatTWD, refreshIcons } from '../utils/format.js';
import { fitBoundsToPoints, invalidateMapSize } from '../map/mapInit.js';
import { openCustomDialog, showToast } from './dialog.js';

let activeOverlay = 'none'; // 'none' | 'itinerary' | 'days' | 'expense'
let splitDayId = null; // 點擊天數正方形後，左側同步展開變窄行程表，並在該天旁顯示眼睛＋齒輪小圓
let gearSettingsDayId = null; // 點擊齒輪小圓後展開的詳細設定卡（更名、刪除、單日預算檢視）
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

function calcSingleDayCategoryBreakdown(day) {
  const totals = {};
  EXPENSE_CATEGORIES.forEach((c) => {
    totals[c.id] = 0;
  });
  const pins = day?.pins || [];
  let sum = 0;
  pins.forEach((pin, idx) => {
    (pin.subSpots || []).forEach((s) => {
      const cost = Math.max(0, Math.round(Number(s.cost) || 0));
      const cat = EXPENSE_CATEGORY_MAP[s.category] ? s.category : 'other';
      totals[cat] += cost;
      sum += cost;
    });
    if (idx < pins.length - 1) {
      const tCost = calcTransportExpense(pin);
      if (tCost > 0) {
        totals.transport += tCost;
        sum += tCost;
      }
    }
  });
  return {
    total: sum,
    categories: EXPENSE_CATEGORIES.map((c) => ({
      ...c,
      amount: totals[c.id] || 0,
      pct: sum > 0 ? Math.round(((totals[c.id] || 0) / sum) * 1000) / 10 : 0,
    })),
  };
}

function syncOrbsAndPanels() {
  const leftPanel = document.getElementById('panel-left');
  const daysPopup = document.getElementById('mobile-days-popup');
  const dayDetailSheet = document.getElementById('mobile-day-detail-sheet');
  const expenseSheet = document.getElementById('mobile-expense-sheet');
  const orbItinerary = document.getElementById('btn-mobile-orb-itinerary');
  const orbDays = document.getElementById('btn-mobile-orb-days');
  const expensePill = document.getElementById('btn-mobile-expense-pill');
  const expenseArrow = document.getElementById('mobile-expense-arrow');

  const isPureItineraryOpen = activeOverlay === 'itinerary';
  const isDaysOpen = activeOverlay === 'days';
  const isSplitItineraryOpen = isDaysOpen && Boolean(splitDayId);
  const isExpenseOpen = activeOverlay === 'expense';
  const showItineraryOnMobile = (isPureItineraryOpen || isSplitItineraryOpen) && isMobileViewport();

  if (leftPanel) {
    if (showItineraryOnMobile) {
      leftPanel.classList.remove('hidden');
      leftPanel.classList.add('flex', 'mobile-sheet-animate');
      leftPanel.classList.toggle('mobile-sheet-narrow', isSplitItineraryOpen);
    } else {
      leftPanel.classList.add('hidden');
      leftPanel.classList.remove('flex', 'mobile-sheet-animate', 'mobile-sheet-narrow');
    }
  }

  if (daysPopup) {
    daysPopup.classList.toggle('hidden', !isDaysOpen);
  }

  if (dayDetailSheet) {
    const showGearSheet = isDaysOpen && Boolean(gearSettingsDayId);
    dayDetailSheet.classList.toggle('hidden', !showGearSheet);
  }

  if (expenseSheet) {
    expenseSheet.classList.toggle('hidden', !isExpenseOpen);
  }

  const orbBase =
    'pointer-events-auto relative w-[52px] h-[52px] rounded-full shadow-float flex items-center justify-center transition-all duration-200 active:scale-95 shrink-0 ';
  const orbIdle = 'mobile-glass-orb';
  const orbActive = 'mobile-glass-orb-active shadow-md';

  if (orbItinerary) {
    orbItinerary.className = orbBase + (isPureItineraryOpen ? orbActive : orbIdle);
    orbItinerary.setAttribute('aria-expanded', String(showItineraryOnMobile));
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
  const dayIndex = state.days.findIndex((d) => d.id === gearSettingsDayId);
  const day = dayIndex >= 0 ? state.days[dayIndex] : null;

  if (!day) {
    gearSettingsDayId = null;
    sheet.classList.add('hidden');
    return;
  }

  const dayExpense = calcDayExpense(day);
  const dayCatStats = calcSingleDayCategoryBreakdown(day);
  const catChipsHtml =
    dayCatStats.total > 0
      ? dayCatStats.categories
          .filter((c) => c.amount > 0)
          .map(
            (c) => `
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-owl-softBg/85 border border-owl-cardBorder text-[10.5px] font-bold text-owl-text tabular-nums-strict">
              <span>${c.emoji}</span>
              <span>${escapeHTML(c.label)}</span>
              <span class="text-owl-primaryDeep">${formatTWD(c.amount)}</span>
            </span>
          `
          )
          .join('')
      : `<span class="text-[11px] text-owl-muted">這一天尚未記錄支出</span>`;

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

      <div class="rounded-2xl bg-owl-card/90 border border-owl-cardBorder p-2.5 space-y-2">
        <div class="flex items-center justify-between gap-2 text-[11px]">
          <span class="text-owl-subtext font-semibold">${day.pins.length} 個標點 · 當日支出預算</span>
          <span class="text-xs font-extrabold text-owl-primaryDeep tabular-nums-strict">${formatTWD(dayExpense)}</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          ${catChipsHtml}
        </div>
      </div>

      <div class="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          id="btn-mobile-day-eye"
          class="py-2 px-2 rounded-xl border text-[11px] font-bold flex items-center justify-center gap-1 transition active:scale-95 ${
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
          class="py-2 px-2 rounded-xl bg-owl-card hover:bg-owl-softBg border border-owl-border text-[11px] font-bold text-owl-text flex items-center justify-center gap-1 transition active:scale-95"
        >
          <i data-lucide="pencil" class="w-3 h-3 shrink-0"></i>
          <span>重新命名</span>
        </button>

        <button
          type="button"
          id="btn-mobile-day-delete"
          class="py-2 px-2 rounded-xl bg-owl-card hover:bg-[#F9EDEC] border border-owl-border hover:border-[#E3BDB8] text-[11px] font-bold text-[#9B534B] flex items-center justify-center gap-1 transition active:scale-95"
        >
          <i data-lucide="trash-2" class="w-3 h-3 shrink-0"></i>
          <span>刪除</span>
        </button>
      </div>
    </div>
  `;

  sheet.querySelector('#btn-close-mobile-day-detail')?.addEventListener('click', () => {
    gearSettingsDayId = null;
    renderMobileDaysPopup();
    syncOrbsAndPanels();
    refreshIcons();
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
      if (splitDayId === target.id) splitDayId = latestState.activeDayId;
      gearSettingsDayId = null;
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

  // 若 splitDayId 已不存在於天數列表，重設之
  if (splitDayId && !state.days.some((d) => d.id === splitDayId)) {
    splitDayId = null;
  }

  // 上方附同尺寸「+ 新增」正方形，往下依序為第 1 天、第 2 天…
  const addSquareHtml = `
    <div class="flex items-center justify-end">
      <button
        type="button"
        id="btn-mobile-add-day"
        title="新增天數"
        aria-label="新增天數"
        style="animation-delay: ${Math.min(totalCount, 6) * 24}ms;"
        class="mobile-day-square-animate mobile-day-tile-add w-[54px] h-[54px] rounded-2xl shadow-float flex flex-col items-center justify-center gap-0.5 shrink-0 transition active:scale-95"
      >
        <i data-lucide="plus" class="w-4 h-4"></i>
        <span class="text-[10px] font-bold leading-none">新增</span>
      </button>
    </div>
  `;

  const rowsHtml = state.days
    .map((day, idx) => {
      const isActive = day.id === state.activeDayId;
      const isSplitSelected = day.id === splitDayId;
      const isGearOpen = day.id === gearSettingsDayId;
      const delayMs = Math.min(totalCount - 1 - idx, 6) * 24;
      const tileClass = isSplitSelected
        ? 'mobile-day-tile-selected'
        : isActive
          ? 'mobile-day-tile-active'
          : 'mobile-day-tile-idle';
      const dimClass = day.visible ? '' : 'opacity-55';

      // 點擊該天正方形時，緊貼其左側同步跳出「眼睛小圓」與「齒輪小圓」
      const inlineMiniOrbsHtml = isSplitSelected
        ? `
          <div class="flex flex-col items-center gap-1 mr-1.5 mobile-day-square-animate">
            <button
              type="button"
              data-inline-eye-day-id="${day.id}"
              title="${day.visible ? '隱藏此天數地圖顯示' : '開啟此天數地圖顯示'}"
              aria-label="${day.visible ? '隱藏此天數圖層' : '顯示此天數圖層'}"
              class="btn-mobile-inline-eye w-[28px] h-[28px] rounded-full shadow-float flex items-center justify-center transition active:scale-90 ${
                day.visible ? 'mobile-mini-orb' : 'mobile-mini-orb-off'
              }"
            >
              <i data-lucide="${day.visible ? 'eye' : 'eye-off'}" class="w-3.5 h-3.5"></i>
            </button>
            <button
              type="button"
              data-inline-gear-day-id="${day.id}"
              title="單日詳細設定（更名、刪除、預算查看）"
              aria-label="單日詳細設定"
              class="btn-mobile-inline-gear w-[28px] h-[28px] rounded-full shadow-float flex items-center justify-center transition active:scale-90 ${
                isGearOpen ? 'mobile-mini-orb-active' : 'mobile-mini-orb'
              }"
            >
              <i data-lucide="settings" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        `
        : '';

      return `
        <div class="mobile-day-row flex items-center justify-end" data-row-day-id="${day.id}">
          ${inlineMiniOrbsHtml}
          <button
            type="button"
            data-mobile-day-id="${day.id}"
            title="${escapeHTML(day.name)}（點擊切換至這一天並顯示行程）"
            style="animation-delay: ${delayMs}ms;"
            class="mobile-day-square mobile-day-square-animate w-[54px] h-[54px] rounded-2xl shadow-float flex flex-col items-center justify-center gap-1 shrink-0 transition active:scale-95 ${tileClass} ${dimClass}"
          >
            <span class="w-2 h-2 rounded-full shrink-0 shadow-2xs" style="background:${day.color};"></span>
            <span class="text-[11px] font-extrabold text-owl-text leading-none tracking-tight whitespace-nowrap">第 ${idx + 1} 天</span>
          </button>
        </div>
      `;
    })
    .join('');

  popup.innerHTML = addSquareHtml + rowsHtml;

  popup.querySelector('#btn-mobile-add-day')?.addEventListener('click', () => {
    callbacks.onAddDay();
    const latest = getState();
    splitDayId = latest.activeDayId;
    gearSettingsDayId = null;
    renderMobileDaysPopup();
    syncOrbsAndPanels();
    refreshIcons();
  });

  // 點擊任一天數正方形：直接跳轉到該天行程、同步展開變窄靠左行程表、並在正方形旁彈出眼睛＋齒輪小圓
  popup.querySelectorAll('.mobile-day-square').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dayId = btn.dataset.mobileDayId;
      const latestState = getState();
      const chosen = latestState.days.find((d) => d.id === dayId);
      if (!chosen) return;

      const changedDay = latestState.activeDayId !== chosen.id;
      if (changedDay) {
        latestState.activeDayId = chosen.id;
        saveState((msg) => showToast(msg, 'error'));
      }

      splitDayId = chosen.id;
      gearSettingsDayId = null;

      if (changedDay) {
        callbacks.onStateChanged();
        if (chosen.visible && chosen.pins.length > 0) {
          fitBoundsToPoints(
            chosen.pins.map((p) => [p.lat, p.lng]),
            { padding: [60, 60], maxZoom: 14 }
          );
        }
      } else {
        renderMobileDaysPopup();
        renderMobileDayDetailSheet();
        syncOrbsAndPanels();
        refreshIcons();
      }
    });
  });

  // 眼睛小圓：直接開關該天圖層顯示
  popup.querySelectorAll('.btn-mobile-inline-eye').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dayId = btn.dataset.inlineEyeDayId;
      const latestState = getState();
      const target = latestState.days.find((d) => d.id === dayId);
      if (!target) return;
      target.visible = !target.visible;
      saveState((msg) => showToast(msg, 'error'));
      callbacks.onVisibilityChanged();
    });
  });

  // 齒輪小圓：展開／收合該天的詳細設定（更名、刪除、單日預算查看）
  popup.querySelectorAll('.btn-mobile-inline-gear').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dayId = btn.dataset.inlineGearDayId;
      gearSettingsDayId = gearSettingsDayId === dayId ? null : dayId;
      renderMobileDaysPopup();
      renderMobileDayDetailSheet();
      syncOrbsAndPanels();
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
  syncOrbsAndPanels();
  refreshIcons();
}

export function closeAllMobileOverlays() {
  activeOverlay = 'none';
  splitDayId = null;
  gearSettingsDayId = null;
  syncOrbsAndPanels();
}

export function setMobileTab(tabName) {
  if (tabName === 'left') {
    activeOverlay = 'itinerary';
    splitDayId = null;
    gearSettingsDayId = null;
  } else if (tabName === 'right') {
    activeOverlay = 'days';
  } else {
    activeOverlay = 'none';
    splitDayId = null;
    gearSettingsDayId = null;
  }
  syncOrbsAndPanels();
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

  // 單純點左下行程圓球：以原尺寸顯示半透明行程清單（收合右側天數）
  document.getElementById('btn-mobile-orb-itinerary')?.addEventListener('click', () => {
    splitDayId = null;
    gearSettingsDayId = null;
    activeOverlay = activeOverlay === 'itinerary' ? 'none' : 'itinerary';
    syncOrbsAndPanels();
  });

  // 點擊行程清單右上角 ×：若在雙開模式僅收合行程清單（保留天數列），單純模式則整個收合
  document.getElementById('btn-close-mobile-itinerary')?.addEventListener('click', () => {
    if (activeOverlay === 'days' && splitDayId) {
      splitDayId = null;
      gearSettingsDayId = null;
      renderMobileDaysPopup();
      renderMobileDayDetailSheet();
      syncOrbsAndPanels();
      refreshIcons();
    } else {
      closeAllMobileOverlays();
    }
  });

  document.getElementById('btn-mobile-orb-days')?.addEventListener('click', () => {
    if (activeOverlay === 'days') {
      closeAllMobileOverlays();
    } else {
      activeOverlay = 'days';
      splitDayId = null;
      gearSettingsDayId = null;
      renderMobileDaysPopup();
      renderMobileDayDetailSheet();
      syncOrbsAndPanels();
      refreshIcons();
    }
  });

  document.getElementById('btn-mobile-expense-pill')?.addEventListener('click', () => {
    splitDayId = null;
    gearSettingsDayId = null;
    activeOverlay = activeOverlay === 'expense' ? 'none' : 'expense';
    renderMobileExpenseSheet(calcExpenseBreakdown(getState()));
    syncOrbsAndPanels();
    refreshIcons();
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
