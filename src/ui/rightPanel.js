import { getState, saveState } from '../state/store.js';
import { calcDayExpense } from '../state/selectors.js';
import { escapeHTML, formatTWD, refreshIcons } from '../utils/format.js';
import { fitBoundsToPoints } from '../map/mapInit.js';
import { openCustomDialog, showToast } from './dialog.js';

export function renderRightPanel({ onStateChanged, onVisibilityChanged }) {
  const state = getState();
  const container = document.getElementById('day-layers-list');
  if (!container) return;

  let html = '';
  let grandTotal = 0;
  let visibleTotal = 0;
  let totalSubSpots = 0;

  state.days.forEach((day) => {
    const isActive = day.id === state.activeDayId;
    const dayExpense = calcDayExpense(day);
    grandTotal += dayExpense;
    if (day.visible) visibleTotal += dayExpense;
    day.pins.forEach((p) => {
      totalSubSpots += (p.subSpots || []).length;
    });

    const dimmedClass = day.visible ? 'opacity-100' : 'opacity-55 bg-owl-canvas/65';
    const activeBorder = isActive
      ? 'ring-2 ring-owl-primary/25 border-owl-accentBorder bg-owl-selectedBg shadow-xs'
      : 'border-owl-cardBorder hover:border-owl-accentBorder/75 bg-owl-card';

    html += `
      <div class="day-layer-card rounded-xl border px-2.5 py-2 transition cursor-pointer ${activeBorder} ${dimmedClass}" data-day-id="${day.id}">
        <div class="flex items-center justify-between gap-1.5">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="w-2.5 h-2.5 rounded-full shrink-0 shadow-2xs ring-2 ring-owl-card" style="background:${day.color};"></span>
            <div class="day-name-label text-xs font-extrabold text-owl-text truncate" data-day-id="${day.id}" title="雙擊重新命名">
              ${escapeHTML(day.name)}
            </div>
          </div>

          <div class="flex items-center gap-0.5 shrink-0">
            <button type="button" data-rename-day-id="${day.id}" title="重新命名" class="btn-rename-day w-6 h-6 rounded-lg text-owl-muted hover:text-owl-primaryDeep hover:bg-owl-softBg flex items-center justify-center transition">
              <i data-lucide="pencil" class="w-3 h-3"></i>
            </button>
            <button type="button" data-delete-day-id="${day.id}" title="刪除此天數" class="btn-delete-day w-6 h-6 rounded-lg text-owl-muted hover:text-[#A65D57] hover:bg-[#F9EDEC] flex items-center justify-center transition">
              <i data-lucide="trash-2" class="w-3 h-3"></i>
            </button>
            <button type="button" data-eye-day-id="${day.id}" title="${day.visible ? '隱藏此天數地圖顯示' : '開啟此天數地圖顯示'}" class="btn-toggle-eye w-7 h-7 rounded-lg flex items-center justify-center ml-0.5 transition ${day.visible ? 'bg-owl-softBg text-owl-primaryDeep hover:bg-[#E5D7C5]' : 'bg-owl-border/60 text-owl-muted hover:bg-owl-border'}">
              <i data-lucide="${day.visible ? 'eye' : 'eye-off'}" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>

        <div class="mt-1 pl-[18px] flex items-center justify-between gap-2 text-[11px] leading-tight">
          <div class="flex items-center gap-1.5 text-owl-subtext font-medium truncate">
            <span>${day.pins.length} 個標點</span>
            <span class="text-owl-border">·</span>
            <span class="font-bold text-owl-text tabular-nums-strict">${formatTWD(dayExpense)}</span>
          </div>
          <span class="shrink-0 text-[10px] ${isActive ? 'text-owl-primaryDeep font-bold bg-owl-softBg px-1.5 py-0.5 rounded-md' : 'text-owl-muted font-medium'}">
            ${isActive ? '● 編輯中' : '切換'}
          </span>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  // 底部 3 行精簡「旅程總支出」深貓頭鷹咖卡片
  document.getElementById('grand-total-expense').textContent = formatTWD(grandTotal);
  document.getElementById('visible-total-expense').textContent = formatTWD(visibleTotal);
  document.getElementById('total-spots-count').textContent = `共 ${totalSubSpots} 項`;

  const barEl = document.getElementById('expense-bar');
  if (grandTotal > 0) {
    barEl.innerHTML = state.days
      .map((d) => {
        const val = calcDayExpense(d);
        if (val <= 0) return '';
        const pct = (val / grandTotal) * 100;
        const roundedPct = Math.round(pct);
        return `<div class="h-full first:rounded-l-full last:rounded-r-full transition-all" style="width:${pct}%; background:${d.color}; opacity:${d.visible ? 1 : 0.32};" title="${escapeHTML(d.name)}：${formatTWD(val)}（佔 ${roundedPct}%）"></div>`;
      })
      .join('');
  } else {
    barEl.innerHTML = '';
  }

  refreshIcons();

  const promptRenameDay = async (dayId) => {
    const day = state.days.find((d) => d.id === dayId);
    if (!day) return;
    const newName = await openCustomDialog({
      title: '修改天數圖層名稱',
      message: '輸入這一天的行程名稱：',
      inputValue: day.name,
      placeholder: '例：Day 3 · 九份山城一日遊',
      confirmText: '儲存名稱',
    });
    if (newName) {
      day.name = newName;
      saveState((msg) => showToast(msg, 'error'));
      onStateChanged();
      showToast('已更新天數名稱', 'success');
    }
  };

  container.querySelectorAll('.day-layer-card').forEach((card) => {
    card.addEventListener('click', () => {
      const dayId = card.dataset.dayId;
      state.activeDayId = dayId;
      saveState((msg) => showToast(msg, 'error'));
      onStateChanged();
      const chosen = state.days.find((d) => d.id === dayId);
      if (chosen && chosen.visible && chosen.pins.length > 0) {
        fitBoundsToPoints(
          chosen.pins.map((p) => [p.lat, p.lng]),
          { padding: [80, 80], maxZoom: 14 }
        );
      }
    });
  });

  container.querySelectorAll('.day-name-label').forEach((lbl) => {
    lbl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      promptRenameDay(lbl.dataset.dayId);
    });
  });

  container.querySelectorAll('.btn-toggle-eye').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const day = state.days.find((d) => d.id === btn.dataset.eyeDayId);
      if (!day) return;
      day.visible = !day.visible;
      saveState((msg) => showToast(msg, 'error'));
      onVisibilityChanged();
    });
  });

  container.querySelectorAll('.btn-rename-day').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      promptRenameDay(btn.dataset.renameDayId);
    });
  });

  container.querySelectorAll('.btn-delete-day').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (state.days.length <= 1) {
        showToast('至少需要保留一個天數圖層', 'error');
        return;
      }
      const day = state.days.find((d) => d.id === btn.dataset.deleteDayId);
      if (!day) return;
      const ok = await openCustomDialog({
        title: '確定刪除此天數圖層？',
        message: `「${day.name}」內含的 ${day.pins.length} 個標點與支出資料將會一併移除。`,
        confirmText: '確定刪除',
        danger: true,
      });
      if (ok) {
        state.days = state.days.filter((d) => d.id !== day.id);
        if (state.activeDayId === day.id) state.activeDayId = state.days[0].id;
        saveState((msg) => showToast(msg, 'error'));
        onStateChanged();
        showToast('已刪除天數圖層', 'info');
      }
    });
  });
}
