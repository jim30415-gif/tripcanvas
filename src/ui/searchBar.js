import { getState } from '../state/store.js';
import { getActiveDay } from '../state/selectors.js';
import { searchPlaces } from '../services/geocoder.js';
import { escapeHTML, refreshIcons } from '../utils/format.js';
import { flyToPoint, showSearchHighlightMarker } from '../map/mapInit.js';
import { setMobileTab } from './mobileNav.js';
import { showToast } from './dialog.js';

export function closeSearchResults() {
  document.getElementById('map-search-results')?.classList.add('hidden');
}

function syncSearchClearButton() {
  const input = document.getElementById('map-search-input');
  const clearBtn = document.getElementById('btn-clear-search');
  if (!input || !clearBtn) return;
  if (input.value.trim().length > 0) clearBtn.classList.remove('hidden');
  else clearBtn.classList.add('hidden');
}

export function bindSearchBarEvents({ onAddPinAtCoordinate }) {
  const form = document.getElementById('map-search-form');
  const searchInput = document.getElementById('map-search-input');
  const clearBtn = document.getElementById('btn-clear-search');
  const resultsEl = document.getElementById('map-search-results');

  searchInput.addEventListener('input', syncSearchClearButton);
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    syncSearchClearButton();
    closeSearchResults();
    searchInput.focus();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#map-search-form') && !e.target.closest('#map-search-results')) {
      closeSearchResults();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearchResults();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) {
      closeSearchResults();
      return;
    }

    resultsEl.innerHTML = `
      <div class="p-4 text-xs font-semibold text-owl-subtext flex items-center justify-center gap-2">
        <span class="w-3.5 h-3.5 rounded-full border-2 border-owl-primary border-t-transparent animate-spin"></span>
        <span>搜尋「${escapeHTML(q)}」中...</span>
      </div>
    `;
    resultsEl.classList.remove('hidden');

    try {
      const list = await searchPlaces(q);

      if (!list.length) {
        resultsEl.innerHTML = `<div class="p-4 text-xs text-owl-subtext text-center">找不到相符地點，請嘗試其他關鍵字</div>`;
        return;
      }

      const activeDay = getActiveDay(getState());
      const headerBar = `
        <div class="px-3.5 py-2 bg-owl-selectedBg border-b border-owl-border/80 flex items-center justify-between gap-2 text-[11px] text-owl-subtext">
          <span class="font-semibold min-w-0">找到 ${list.length} 筆結果（可定位檢視或直接加入「${escapeHTML(activeDay?.name || '目前天數')}」）</span>
          <button type="button" id="btn-close-search-dropdown" class="px-2 py-1 rounded-lg hover:bg-owl-softBg text-owl-muted hover:text-owl-text font-bold whitespace-nowrap shrink-0 transition">關閉</button>
        </div>
      `;

      const itemsHtml = list
        .map((item, i) => {
          const shortTitle = item.display_name.split(',')[0];
          return `
            <div class="px-3.5 py-3 hover:bg-owl-selectedBg/80 border-b border-owl-cardBorder last:border-b-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 transition">
              <div class="min-w-0 flex-1">
                <div class="text-xs font-extrabold text-owl-text truncate flex items-center gap-1.5">
                  <i data-lucide="map-pin" class="w-3.5 h-3.5 text-owl-primary shrink-0"></i>
                  <span class="truncate">${escapeHTML(shortTitle)}</span>
                </div>
                <div class="text-[11px] text-owl-subtext line-clamp-2 mt-0.5 leading-snug">${escapeHTML(item.display_name)}</div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <button type="button" data-view-idx="${i}" class="btn-search-locate inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-owl-softBg hover:bg-owl-border/75 text-owl-primaryDeep text-[11px] font-bold transition">
                  <i data-lucide="eye" class="w-3 h-3"></i>
                  定位檢視
                </button>
                <button type="button" data-add-idx="${i}" class="btn-search-add inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-owl-primary hover:bg-owl-primaryHover text-white text-[11px] font-bold shadow-2xs transition">
                  <i data-lucide="plus" class="w-3 h-3"></i>
                  加入目前天數
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      resultsEl.innerHTML = headerBar + itemsHtml;
      refreshIcons();

      document.getElementById('btn-close-search-dropdown')?.addEventListener('click', closeSearchResults);

      resultsEl.querySelectorAll('.btn-search-locate').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = list[Number(btn.dataset.viewIdx)];
          const lat = Number(item.lat);
          const lng = Number(item.lon);
          closeSearchResults();
          if (window.innerWidth < 1024) setMobileTab('map');
          setTimeout(() => {
            flyToPoint(lat, lng, 16);
            showSearchHighlightMarker(lat, lng);
            showToast(`已定位至：${item.display_name.split(',')[0]}`, 'info');
          }, 80);
        });
      });

      resultsEl.querySelectorAll('.btn-search-add').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = list[Number(btn.dataset.addIdx)];
          const lat = Number(item.lat);
          const lng = Number(item.lon);
          const shortTitle = item.display_name.split(',')[0];
          onAddPinAtCoordinate(lat, lng, shortTitle);
          closeSearchResults();
          if (window.innerWidth < 1024) setMobileTab('map');
          setTimeout(() => flyToPoint(lat, lng, 15), 80);
        });
      });
    } catch {
      resultsEl.innerHTML = `<div class="p-4 text-xs text-[#A65D57] text-center">搜尋服務暫時無法連線，您可直接點擊地圖任意位置新增標點</div>`;
    }
  });
}
