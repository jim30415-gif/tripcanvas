import {
  getAllTrips,
  getActiveTrip,
  createNewTrip,
  switchTrip,
  renameTrip,
  duplicateTrip,
  deleteTrip,
} from '../state/store.js';
import { calcTripPinCount } from '../state/selectors.js';
import { escapeHTML, refreshIcons } from '../utils/format.js';
import { isCustomDialogOpen, openCustomDialog, showToast } from './dialog.js';

let onTripSwitchedCallback = null;

function formatUpdatedTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderTripsDrawer() {
  const listEl = document.getElementById('trips-drawer-list');
  const countEl = document.getElementById('trips-drawer-count');
  if (!listEl) return;

  const trips = getAllTrips();
  const active = getActiveTrip();

  if (countEl) {
    countEl.textContent = `共 ${trips.length} 個計畫`;
  }

  listEl.innerHTML = trips
    .map((trip) => {
      const isActive = trip.id === active?.id;
      const dayCount = trip.data?.days?.length || 0;
      const pinCount = calcTripPinCount(trip.data);
      const updatedStr = formatUpdatedTime(trip.updatedAt);
      const safeTripId = escapeHTML(trip.id);

      return `
        <div
          tabindex="0"
          role="button"
          aria-label="切換至旅遊計畫 ${escapeHTML(trip.name)}"
          class="trip-plan-card rounded-2xl border p-3.5 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-owl-primary/40 ${
            isActive
              ? 'border-owl-primary bg-owl-selectedBg ring-2 ring-owl-primary/20 shadow-xs'
              : 'border-owl-cardBorder bg-owl-card hover:border-owl-accentBorder hover:bg-owl-selectedBg/50'
          }"
          data-trip-id="${safeTripId}"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                ${
                  isActive
                    ? '<span class="w-4 h-4 rounded-full bg-owl-primary text-white flex items-center justify-center shrink-0"><i data-lucide="check" class="w-2.5 h-2.5"></i></span>'
                    : '<span class="w-2 h-2 rounded-full bg-owl-border shrink-0 ml-1"></span>'
                }
                <h4 class="text-sm sm:text-base font-extrabold text-owl-text truncate">${escapeHTML(trip.name)}</h4>
              </div>
              <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-owl-subtext font-medium">
                <span>${dayCount} 天</span>
                <span class="text-owl-border">·</span>
                <span>${pinCount} 個標點</span>
              </div>
              ${
                updatedStr
                  ? `<div class="mt-1 text-xs text-owl-muted">更新於 ${escapeHTML(updatedStr)}</div>`
                  : ''
              }
            </div>

            <div class="flex items-center gap-0.5 shrink-0">
              <button type="button" data-rename-trip-id="${safeTripId}" title="重新命名計畫" aria-label="重新命名 ${escapeHTML(trip.name)}" class="btn-rename-trip w-7 h-7 rounded-lg text-owl-muted hover:text-owl-primaryDeep hover:bg-owl-softBg flex items-center justify-center transition">
                <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
              </button>
              <button type="button" data-dup-trip-id="${safeTripId}" title="複製此計畫" aria-label="複製 ${escapeHTML(trip.name)}" class="btn-dup-trip w-7 h-7 rounded-lg text-owl-muted hover:text-owl-primaryDeep hover:bg-owl-softBg flex items-center justify-center transition">
                <i data-lucide="copy" class="w-3.5 h-3.5"></i>
              </button>
              <button type="button" data-del-trip-id="${safeTripId}" title="刪除此計畫" aria-label="刪除 ${escapeHTML(trip.name)}" class="btn-del-trip w-7 h-7 rounded-lg text-owl-muted hover:text-[#A65D57] dark:hover:text-[#E89B94] hover:bg-[#F9EDEC] dark:hover:bg-[#35201F] flex items-center justify-center transition">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  refreshIcons(listEl);

  const activateTripCard = (tripId) => {
    if (tripId === getActiveTrip()?.id) {
      closeTripsDrawer();
      return;
    }
    const switched = switchTrip(tripId);
    if (switched) {
      closeTripsDrawer();
      if (typeof onTripSwitchedCallback === 'function') onTripSwitchedCallback(true);
      showToast(`已切換至「${switched.name}」`, 'success');
    }
  };

  listEl.querySelectorAll('.trip-plan-card').forEach((card) => {
    card.addEventListener('click', () => activateTripCard(card.dataset.tripId));
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateTripCard(card.dataset.tripId);
      }
    });
  });

  listEl.querySelectorAll('.btn-rename-trip').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tripId = btn.dataset.renameTripId;
      const target = getAllTrips().find((t) => t.id === tripId);
      if (!target) return;
      const newName = await openCustomDialog({
        title: '重新命名旅遊計畫',
        message: '輸入新的旅遊計畫名稱：',
        inputValue: target.name,
        placeholder: '例：京都 5 日賞楓獨旅',
        confirmText: '儲存名稱',
      });
      if (newName) {
        if (renameTrip(tripId, newName)) {
          renderTripsDrawer();
          if (typeof onTripSwitchedCallback === 'function') onTripSwitchedCallback(false);
          showToast('已更新旅遊計畫名稱', 'success');
        }
      }
    });
  });

  listEl.querySelectorAll('.btn-dup-trip').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const copy = duplicateTrip(btn.dataset.dupTripId);
      if (copy) {
        renderTripsDrawer();
        if (typeof onTripSwitchedCallback === 'function') onTripSwitchedCallback(true);
        showToast(`已複製並切換至「${copy.name}」`, 'success');
      }
    });
  });

  listEl.querySelectorAll('.btn-del-trip').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tripId = btn.dataset.delTripId;
      if (getAllTrips().length <= 1) {
        showToast('至少需要保留一個旅遊計畫', 'error');
        return;
      }
      const target = getAllTrips().find((t) => t.id === tripId);
      if (!target) return;
      const targetName = target.name;
      const ok = await openCustomDialog({
        title: '確定刪除此旅遊計畫？',
        message: `將永久移除「${targetName}」內所有天數、標點與支出紀錄。`,
        confirmText: '確定刪除',
        danger: true,
      });
      if (ok && deleteTrip(tripId)) {
        renderTripsDrawer();
        if (typeof onTripSwitchedCallback === 'function') onTripSwitchedCallback(true);
        showToast(`已刪除「${targetName}」`, 'info');
      }
    });
  });
}

export function openTripsDrawer() {
  renderTripsDrawer();
  const drawer = document.getElementById('drawer-trips');
  drawer?.classList.remove('hidden');
  refreshIcons(drawer);
}

export function closeTripsDrawer() {
  document.getElementById('drawer-trips')?.classList.add('hidden');
}

export function bindTripsDrawerEvents({ onTripSwitched }) {
  onTripSwitchedCallback = onTripSwitched;

  document.getElementById('btn-open-trips-drawer')?.addEventListener('click', openTripsDrawer);
  document.getElementById('btn-close-trips-drawer')?.addEventListener('click', closeTripsDrawer);
  document.getElementById('drawer-trips-backdrop')?.addEventListener('click', closeTripsDrawer);

  document.getElementById('btn-create-trip')?.addEventListener('click', async () => {
    const defaultName = `旅遊計畫 ${getAllTrips().length + 1}`;
    const name = await openCustomDialog({
      title: '新增旅遊計畫',
      message: '原有的計畫都會完整保留，隨時可從此選單切換回來：',
      inputValue: '',
      placeholder: '例：東京 5 日獨旅、台南週末小吃之旅',
      confirmText: '建立計畫',
    });
    if (name === null) return;
    const created = createNewTrip(name || defaultName, { blank: true });
    closeTripsDrawer();
    if (typeof onTripSwitchedCallback === 'function') onTripSwitchedCallback(true);
    showToast(`已建立新計畫「${created.name}」`, 'success');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !isCustomDialogOpen()) closeTripsDrawer();
  });
}
