import { getState, saveState } from '../state/store.js';
import { calcExpenseBreakdown, getActiveDay } from '../state/selectors.js';
import { escapeHTML, formatTWD, refreshIcons, sanitizeHexColor } from '../utils/format.js';
import { fitBoundsToPoints, invalidateMapSize } from '../map/mapInit.js';
import { isCustomDialogOpen, openCustomDialog, showToast } from './dialog.js';

let activeOverlay = 'none'; // 'none' | 'itinerary' | 'days' | 'expense'
let selectedDayId = null; // 點擊天數正方形後，在該天旁顯示眼睛＋齒輪小圓（不再跳出行程清單）
let gearSettingsDayId = null; // 點擊齒輪小圓後展開的詳細設定卡（更名、刪除、顯隱）
let lastViewportWasMobile = null;
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
  const showGearSheet = isDaysOpen && Boolean(gearSettingsDayId);
  const isExpenseOpen = activeOverlay === 'expense';
  const showItineraryOnMobile = isPureItineraryOpen && isMobileViewport();

  if (leftPanel) {
    if (showItineraryOnMobile) {
      leftPanel.classList.remove('hidden');
      leftPanel.classList.add('flex', 'mobile-sheet-animate');
    } else {
      leftPanel.classList.add('hidden');
      leftPanel.classList.remove('flex', 'mobile-sheet-animate');
    }
  }

  if (daysPopup) {
    daysPopup.classList.toggle('hidden', !(isDaysOpen && !showGearSheet));
  }

  if (dayDetailSheet) {
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
            return `<div class="h-full first:rounded-l-full last:rounded-r-full transition-all" style="width:${pct}%; background:${sanitizeHexColor(d.color)}; opacity:${d.visible ? 1 : 0.35};"></div>`;
          })
          .join('')
      : '';

  let detailBody = `<div class="text-sm text-[#CBB7A1] dark:text-[#9AA7B8] text-center py-3">尚未記錄任何支出項目</div>`;
  if (breakdown.grandTotal > 0) {
    const categoriesHtml = breakdown.categories
      .map(
        (c) => `
        <div class="space-y-1">
          <div class="flex items-center justify-between gap-2 text-xs sm:text-[13px] leading-tight">
            <span class="inline-flex items-center gap-1.5 text-[#F2E7D9] dark:text-[#E8EDF4] font-semibold">
              <span>${escapeHTML(c.emoji || '')}</span>
              <span>${escapeHTML(c.label)}</span>
            </span>
            <span class="tabular-nums-strict text-[#FAF4EC] dark:text-[#F1F5FA] font-bold">
              ${formatTWD(c.amount)}
              <span class="text-[#E5C59E] dark:text-[#8AB4F8] font-semibold ml-1">${formatPct(c.pct)}</span>
            </span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-white/15 overflow-hidden">
            <div class="h-full rounded-full transition-[width] duration-300" style="width:${Math.min(100, c.pct)}%; background:${sanitizeHexColor(c.color)};"></div>
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
            <span class="inline-flex items-center gap-1.5 min-w-0 text-[#F2E7D9] dark:text-[#E8EDF4] font-semibold">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${safeColor};"></span>
              <span class="truncate">${escapeHTML(d.name)}</span>
            </span>
            <span class="tabular-nums-strict text-[#FAF4EC] dark:text-[#F1F5FA] font-bold shrink-0">
              ${formatTWD(d.amount)}
              <span class="text-[#E5C59E] dark:text-[#8AB4F8] font-semibold ml-1">${formatPct(d.pct)}</span>
            </span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-white/15 overflow-hidden">
            <div class="h-full rounded-full transition-[width] duration-300" style="width:${Math.min(100, d.pct)}%; background:${safeColor};"></div>
          </div>
        </div>
      `;
      })
      .join('');

    detailBody = `
      <div class="space-y-3.5 pt-3 border-t border-white/15">
        <div class="space-y-2">
          <div class="text-xs font-bold tracking-wide text-[#CBB7A1] dark:text-[#9AA7B8]">分類開銷比例</div>
          <div class="space-y-2">${categoriesHtml}</div>
        </div>
        <div class="border-t border-white/12 pt-3 space-y-2">
          <div class="text-xs font-bold tracking-wide text-[#CBB7A1] dark:text-[#9AA7B8]">各天數開銷比例</div>
          <div class="space-y-2">${daysHtml}</div>
        </div>
      </div>
    `;
  }

  sheet.innerHTML = `
    <div class="space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-baseline gap-2 min-w-0">
          <span class="text-sm font-bold text-[#F2E7D9] dark:text-[#E8EDF4]">旅程總支出</span>
          <span class="text-xs text-[#CBB7A1] dark:text-[#9AA7B8]">共 ${breakdown.totalItemCount} 項</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-xl font-extrabold text-owl-cream tabular-nums-strict">${formatTWD(breakdown.grandTotal)}</span>
          <button type="button" id="btn-close-mobile-expense" aria-label="關閉支出明細" class="w-9 h-9 rounded-full bg-white/12 hover:bg-white/22 text-[#F2E7D9] dark:text-[#E8EDF4] flex items-center justify-center transition-[background-color,transform] duration-150 active:scale-95">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
      <div class="expense-bar-track !my-0">${barHtml}</div>
      <div class="flex items-center justify-between text-xs text-[#D8C7B4] dark:text-[#9AA7B8]">
        <span class="inline-flex items-center gap-1.5">
          <i data-lucide="eye" class="w-3.5 h-3.5 text-owl-gold"></i>
          <span>顯示中圖層小計</span>
        </span>
        <span class="font-bold text-owl-gold tabular-nums-strict">${formatTWD(breakdown.visibleTotal)}</span>
      </div>
      ${detailBody}
    </div>
  `;

  refreshIcons(sheet);
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

  const dayId = day.id;
  const safeColor = sanitizeHexColor(day.color);

  sheet.innerHTML = `
    <div class="space-y-3.5">
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="w-3.5 h-3.5 rounded-full shrink-0 ring-2 ring-owl-card shadow-2xs" style="background:${safeColor};"></span>
          <div class="min-w-0">
            <div class="text-xs font-bold text-owl-muted leading-none">第 ${dayIndex + 1} 天 · 圖層設定（${day.pins.length} 個標點）</div>
            <h4 class="text-base font-extrabold text-owl-text truncate mt-1">${escapeHTML(day.name)}</h4>
          </div>
        </div>
        <button type="button" id="btn-close-mobile-day-detail" aria-label="關閉單日詳細設定" class="w-9 h-9 rounded-full bg-owl-softBg hover:bg-owl-border/70 text-owl-subtext flex items-center justify-center shrink-0 transition active:scale-95">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>

      <div class="grid grid-cols-3 gap-2">
        <button
          type="button"
          id="btn-mobile-day-eye"
          class="py-2.5 px-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1 transition active:scale-95 ${
            day.visible
              ? 'bg-owl-softBg border-owl-accentBorder text-owl-primaryDeep'
              : 'bg-owl-canvas/80 border-owl-border text-owl-muted'
          }"
        >
          <i data-lucide="${day.visible ? 'eye' : 'eye-off'}" class="w-4 h-4 shrink-0"></i>
          <span>${day.visible ? '顯示中' : '已隱藏'}</span>
        </button>

        <button
          type="button"
          id="btn-mobile-day-rename"
          class="py-2.5 px-2 rounded-xl bg-owl-card hover:bg-owl-softBg border border-owl-border text-xs font-bold text-owl-text flex items-center justify-center gap-1 transition active:scale-95"
        >
          <i data-lucide="pencil" class="w-3.5 h-3.5 shrink-0"></i>
          <span>重新命名</span>
        </button>

        <button
          type="button"
          id="btn-mobile-day-delete"
          class="py-2.5 px-2 rounded-xl bg-owl-card hover:bg-[#F9EDEC] dark:hover:bg-[#35201F] border border-owl-border hover:border-[#E3BDB8] dark:hover:border-[#613835] text-xs font-bold text-[#9B534B] dark:text-[#E89B94] flex items-center justify-center gap-1 transition active:scale-95"
        >
          <i data-lucide="trash-2" class="w-3.5 h-3.5 shrink-0"></i>
          <span>刪除</span>
        </button>
      </div>
    </div>
  `;

  refreshIcons(sheet);

  sheet.querySelector('#btn-close-mobile-day-detail')?.addEventListener('click', () => {
    gearSettingsDayId = null;
    renderMobileDaysPopup();
    syncOrbsAndPanels();
  });

  sheet.querySelector('#btn-mobile-day-eye')?.addEventListener('click', () => {
    const latestState = getState();
    const target = latestState.days.find((d) => d.id === dayId);
    if (!target) return;
    target.visible = !target.visible;
    saveState((msg) => showToast(msg, 'error'));
    callbacks.onVisibilityChanged();
  });

  sheet.querySelector('#btn-mobile-day-rename')?.addEventListener('click', async () => {
    const initialTarget = getState().days.find((d) => d.id === dayId);
    if (!initialTarget) return;
    const newName = await openCustomDialog({
      title: '修改天數圖層名稱',
      message: '輸入這一天的行程名稱：',
      inputValue: initialTarget.name,
      placeholder: '例：Day 3 · 九份山城一日遊',
      confirmText: '儲存名稱',
    });
    if (newName) {
      const target = getState().days.find((d) => d.id === dayId);
      if (!target) return;
      target.name = newName;
      saveState((msg) => showToast(msg, 'error'));
      callbacks.onStateChanged();
      showToast('已更新天數名稱', 'success');
    }
  });

  sheet.querySelector('#btn-mobile-day-delete')?.addEventListener('click', async () => {
    const beforeState = getState();
    if (beforeState.days.length <= 1) {
      showToast('至少需要保留一個天數圖層', 'error');
      return;
    }
    const targetBefore = beforeState.days.find((d) => d.id === dayId);
    if (!targetBefore) return;
    const ok = await openCustomDialog({
      title: '確定刪除此天數圖層？',
      message: `「${targetBefore.name}」內含的 ${targetBefore.pins.length} 個標點與支出資料將會一併移除。`,
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
      if (selectedDayId === dayId) selectedDayId = latestState.activeDayId;
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

  // 若 selectedDayId 已不存在於天數列表，重設之
  if (selectedDayId && !state.days.some((d) => d.id === selectedDayId)) {
    selectedDayId = null;
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
        class="mobile-day-square-animate mobile-day-tile-add w-[58px] h-[58px] rounded-2xl shadow-float flex flex-col items-center justify-center gap-0.5 shrink-0 transition active:scale-95"
      >
        <i data-lucide="plus" class="w-4 h-4"></i>
        <span class="text-xs font-bold leading-none">新增</span>
      </button>
    </div>
  `;

  const rowsHtml = state.days
    .map((day, idx) => {
      const isActive = day.id === state.activeDayId;
      const isSelected = day.id === selectedDayId;
      const isGearOpen = day.id === gearSettingsDayId;
      const safeDayId = escapeHTML(day.id);
      const safeColor = sanitizeHexColor(day.color);
      const delayMs = Math.min(totalCount - 1 - idx, 6) * 24;
      const tileClass = isSelected
        ? 'mobile-day-tile-selected'
        : isActive
          ? 'mobile-day-tile-active'
          : 'mobile-day-tile-idle';
      const dimClass = day.visible ? '' : 'opacity-55';

      // 點擊該天正方形時，僅在緊貼左側跳出「眼睛小圓」與「齒輪小圓」（視覺 32px，觸控熱區擴大至 40px）
      const inlineMiniOrbsHtml = isSelected
        ? `
          <div class="flex flex-col items-center gap-1.5 mr-1.5 mobile-day-square-animate">
            <button
              type="button"
              data-inline-eye-day-id="${safeDayId}"
              title="${day.visible ? '隱藏此天數地圖顯示' : '開啟此天數地圖顯示'}"
              aria-label="${day.visible ? '隱藏此天數圖層' : '顯示此天數圖層'}"
              class="btn-mobile-inline-eye mobile-hit-expand w-[32px] h-[32px] rounded-full shadow-float flex items-center justify-center transition active:scale-90 ${
                day.visible ? 'mobile-mini-orb' : 'mobile-mini-orb-off'
              }"
            >
              <i data-lucide="${day.visible ? 'eye' : 'eye-off'}" class="w-4 h-4"></i>
            </button>
            <button
              type="button"
              data-inline-gear-day-id="${safeDayId}"
              title="單日詳細設定（更名、刪除、顯示切換）"
              aria-label="單日詳細設定"
              class="btn-mobile-inline-gear mobile-hit-expand w-[32px] h-[32px] rounded-full shadow-float flex items-center justify-center transition active:scale-90 ${
                isGearOpen ? 'mobile-mini-orb-active' : 'mobile-mini-orb'
              }"
            >
              <i data-lucide="settings" class="w-4 h-4"></i>
            </button>
          </div>
        `
        : '';

      return `
        <div class="mobile-day-row flex items-center justify-end" data-row-day-id="${safeDayId}">
          ${inlineMiniOrbsHtml}
          <button
            type="button"
            data-mobile-day-id="${safeDayId}"
            title="${escapeHTML(day.name)}（點擊切換至這一天並顯示眼睛與設定按鈕）"
            style="animation-delay: ${delayMs}ms;"
            class="mobile-day-square mobile-day-square-animate w-[58px] h-[58px] rounded-2xl shadow-float flex flex-col items-center justify-center gap-1 shrink-0 transition active:scale-95 ${tileClass} ${dimClass}"
          >
            <span class="w-2.5 h-2.5 rounded-full shrink-0 shadow-2xs" style="background:${safeColor};"></span>
            <span class="text-xs font-extrabold text-owl-text leading-none tracking-tight whitespace-nowrap">第 ${idx + 1} 天</span>
          </button>
        </div>
      `;
    })
    .join('');

  popup.innerHTML = addSquareHtml + rowsHtml;
  refreshIcons(popup);

  popup.querySelector('#btn-mobile-add-day')?.addEventListener('click', () => {
    callbacks.onAddDay();
    const latest = getState();
    selectedDayId = latest.activeDayId;
    gearSettingsDayId = null;
    renderMobileDaysPopup();
    syncOrbsAndPanels();
  });

  // 點擊任一天數正方形：切換作用中天數並於正方形旁彈出眼睛＋齒輪小圓（不自動彈出行程清單）
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

      selectedDayId = chosen.id;
      gearSettingsDayId = null;

      if (changedDay) {
        callbacks.onStateChanged();
      } else {
        renderMobileDaysPopup();
        renderMobileDayDetailSheet();
        syncOrbsAndPanels();
      }

      if (chosen.visible && chosen.pins.length > 0) {
        fitBoundsToPoints(
          chosen.pins.map((p) => [p.lat, p.lng]),
          getMobileFitBoundsOptions({ daysPopupOpen: true })
        );
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

  // 齒輪小圓：展開／收合該天的詳細設定（更名、刪除、顯示切換）
  popup.querySelectorAll('.btn-mobile-inline-gear').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dayId = btn.dataset.inlineGearDayId;
      gearSettingsDayId = gearSettingsDayId === dayId ? null : dayId;
      renderMobileDaysPopup();
      renderMobileDayDetailSheet();
      syncOrbsAndPanels();
    });
  });
}

export function hasOpenMobileOverlay() {
  return isMobileViewport() && activeOverlay !== 'none';
}

export function getMobileFitBoundsOptions({ daysPopupOpen = false } = {}) {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 844;
  const hasTallBottomSheet =
    activeOverlay === 'itinerary' || activeOverlay === 'expense' || Boolean(gearSettingsDayId);
  const bottomReserve = hasTallBottomSheet ? Math.min(Math.round(vh * 0.56), 470) : 110;
  const rightReserve = daysPopupOpen || (activeOverlay === 'days' && !gearSettingsDayId) ? 116 : 24;
  return {
    paddingTopLeft: [24, 68],
    paddingBottomRight: [rightReserve, bottomReserve],
    maxZoom: 14,
  };
}

export function renderMobileHud() {
  const mobile = isMobileViewport();
  lastViewportWasMobile = mobile;
  if (!mobile) {
    syncOrbsAndPanels();
    return;
  }

  const state = getState();
  const activeDay = getActiveDay(state);
  const breakdown = calcExpenseBreakdown(state);

  const totalEl = document.getElementById('mobile-grand-total-expense');
  if (totalEl) {
    totalEl.textContent = formatTWD(breakdown.grandTotal);
  }

  const orbDot = document.getElementById('mobile-orb-day-dot');
  if (orbDot && activeDay) {
    orbDot.style.backgroundColor = sanitizeHexColor(activeDay.color);
  }

  renderMobileDaysPopup();
  renderMobileDayDetailSheet();
  renderMobileExpenseSheet(breakdown);
  syncOrbsAndPanels();
}

export function closeAllMobileOverlays() {
  activeOverlay = 'none';
  selectedDayId = null;
  gearSettingsDayId = null;
  syncOrbsAndPanels();
}

export function setMobileTab(tabName) {
  closeAllMobileOverlays();
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

  // 點擊左下行程圓球：以原尺寸顯示半透明行程清單（收合右側天數）
  document.getElementById('btn-mobile-orb-itinerary')?.addEventListener('click', () => {
    selectedDayId = null;
    gearSettingsDayId = null;
    activeOverlay = activeOverlay === 'itinerary' ? 'none' : 'itinerary';
    syncOrbsAndPanels();
  });

  // 點擊行程清單右上角 ×：收合行程清單
  document.getElementById('btn-close-mobile-itinerary')?.addEventListener('click', () => {
    closeAllMobileOverlays();
  });

  document.getElementById('btn-mobile-orb-days')?.addEventListener('click', () => {
    if (activeOverlay === 'days') {
      closeAllMobileOverlays();
    } else {
      activeOverlay = 'days';
      selectedDayId = null;
      gearSettingsDayId = null;
      renderMobileDaysPopup();
      renderMobileDayDetailSheet();
      syncOrbsAndPanels();
    }
  });

  document.getElementById('btn-mobile-expense-pill')?.addEventListener('click', () => {
    selectedDayId = null;
    gearSettingsDayId = null;
    activeOverlay = activeOverlay === 'expense' ? 'none' : 'expense';
    renderMobileExpenseSheet(calcExpenseBreakdown(getState()));
    syncOrbsAndPanels();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeOverlay !== 'none' && !isCustomDialogOpen()) {
      closeAllMobileOverlays();
    }
  });

  window.addEventListener('resize', () => {
    const mobileNow = isMobileViewport();
    if (!mobileNow && activeOverlay !== 'none') {
      closeAllMobileOverlays();
    } else if (mobileNow && lastViewportWasMobile === false) {
      renderMobileHud();
    }
    lastViewportWasMobile = mobileNow;
  });
}
