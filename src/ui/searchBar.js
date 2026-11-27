import { getState } from '../state/store.js';
import { getActiveDay } from '../state/selectors.js';
import { searchPlaces } from '../services/geocoder.js';
import { escapeHTML, refreshIcons } from '../utils/format.js';
import { getCountryDisplayMeta, inferTripCountryProfile } from '../utils/geo.js';
import { clearSearchHighlightMarker, flyToPoint, showSearchHighlightMarker } from '../map/mapInit.js';
import { setMobileTab } from './mobileNav.js';
import { isCustomDialogOpen, showToast } from './dialog.js';

const TYPEAHEAD_DEBOUNCE_MS = 460;

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

function renderResultRowHTML(item, idx, isSelected) {
  const title = item.name || String(item.display_name || '').split(',')[0];
  const address = item.address || item.display_name || '';
  const countryLabel = item.countryName ? `${item.countryFlag || '🌐'} ${item.countryName}` : '';
  const altBadge =
    item.altName && item.altName !== title
      ? `<span class="text-xs font-semibold text-owl-muted truncate max-w-[140px]">${escapeHTML(item.altName)}</span>`
      : '';
  const catBadge = item.categoryLabel
    ? `<span class="px-1.5 py-0.5 rounded-md bg-owl-softBg text-[11px] font-bold text-owl-primaryDeep whitespace-nowrap shrink-0">${escapeHTML(item.categoryLabel)}</span>`
    : '';
  const countryBadge = countryLabel
    ? `<span class="px-1.5 py-0.5 rounded-md text-[11px] font-bold whitespace-nowrap shrink-0 ${
        item.inTripCountry
          ? 'bg-[#EBF2EC] dark:bg-[#1D2D22] text-[#3F6347] dark:text-[#9FD0AB] border border-[#C7DCCB] dark:border-[#32523C]'
          : 'bg-owl-canvas text-owl-subtext border border-owl-border/80'
      }">${escapeHTML(countryLabel)}</span>`
    : '';

  return `
    <div
      data-result-idx="${idx}"
      role="option"
      aria-selected="${isSelected ? 'true' : 'false'}"
      class="search-result-row px-3.5 py-2.5 border-b border-owl-cardBorder last:border-b-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 transition cursor-pointer ${
        isSelected ? 'bg-owl-selectedBg' : 'hover:bg-owl-selectedBg/75'
      }"
    >
      <div class="search-row-locate min-w-0 flex-1" data-view-idx="${idx}">
        <div class="flex items-center flex-wrap gap-1.5 min-w-0">
          <i data-lucide="map-pin" class="w-4 h-4 ${item.inTripCountry ? 'text-owl-primary' : 'text-owl-muted'} shrink-0"></i>
          <span class="text-sm font-extrabold text-owl-text truncate max-w-[230px] sm:max-w-[280px]">${escapeHTML(title)}</span>
          ${altBadge}
          ${countryBadge}
          ${catBadge}
        </div>
        ${address ? `<div class="text-xs text-owl-subtext line-clamp-1 mt-0.5 pl-[22px] leading-snug">${escapeHTML(address)}</div>` : ''}
      </div>
      <div class="flex items-center gap-1.5 shrink-0 pl-[22px] sm:pl-0">
        <button type="button" data-view-idx="${idx}" class="btn-search-locate inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-owl-softBg hover:bg-owl-border/75 text-owl-primaryDeep text-xs font-bold transition">
          <i data-lucide="eye" class="w-3.5 h-3.5"></i>
          定位
        </button>
        <button type="button" data-add-idx="${idx}" class="btn-search-add inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-owl-primary hover:bg-owl-primaryHover text-white text-xs font-bold shadow-2xs transition">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i>
          加入
        </button>
      </div>
    </div>
  `;
}

export function bindSearchBarEvents({ onAddPinAtCoordinate }) {
  const form = document.getElementById('map-search-form');
  const searchInput = document.getElementById('map-search-input');
  const clearBtn = document.getElementById('btn-clear-search');
  const resultsEl = document.getElementById('map-search-results');
  if (!form || !searchInput || !resultsEl) return;

  let debounceTimer = null;
  let activeAbortCtrl = null;
  let requestSeq = 0;
  let isComposing = false;
  let currentList = [];
  let visualOrderIndices = [];
  let currentMeta = { convertedHint: '', tripCountries: [], query: '' };
  let highlightedPos = -1;

  const cancelPending = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (activeAbortCtrl) {
      activeAbortCtrl.abort();
      activeAbortCtrl = null;
    }
  };

  const locateItem = (item) => {
    if (!item) return;
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    const title = item.name || String(item.display_name || '').split(',')[0];
    closeSearchResults();
    if (window.innerWidth < 1024) setMobileTab('map');
    setTimeout(() => {
      flyToPoint(lat, lng, 15);
      showSearchHighlightMarker(lat, lng);
      showToast(`已定位至：${title}`, 'info');
    }, 80);
  };

  const addItem = (item) => {
    if (!item) return;
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    const title = item.name || String(item.display_name || '').split(',')[0];
    onAddPinAtCoordinate(lat, lng, title, {
      placeId: item.placeId || '',
      countryCode: item.countryCode || '',
    });
    closeSearchResults();
    if (window.innerWidth < 1024) setMobileTab('map');
    setTimeout(() => flyToPoint(lat, lng, 15), 80);
  };

  const updateHighlightInPlace = () => {
    const activeDataIdx = highlightedPos >= 0 ? visualOrderIndices[highlightedPos] : -1;
    resultsEl.querySelectorAll('.search-result-row').forEach((row) => {
      const idx = Number(row.dataset.resultIdx);
      const isSelected = idx === activeDataIdx;
      row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      row.classList.toggle('bg-owl-selectedBg', isSelected);
      row.classList.toggle('hover:bg-owl-selectedBg/75', !isSelected);
      if (isSelected) {
        row.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  const renderDropdown = () => {
    if (!currentList.length) {
      visualOrderIndices = [];
      highlightedPos = -1;
      const hintLine = currentMeta.convertedHint
        ? `（已同步通配「${escapeHTML(currentMeta.convertedHint)}」）`
        : '';
      resultsEl.innerHTML = `
        <div class="p-4 text-sm text-owl-subtext text-center">
          找不到「${escapeHTML(currentMeta.query)}」相關地點${hintLine}，請嘗試其他關鍵字
        </div>
      `;
      resultsEl.classList.remove('hidden');
      return;
    }

    const activeDay = getActiveDay(getState());
    const primaryCode = currentMeta.tripCountries?.[0] || '';
    const primaryMeta = primaryCode ? getCountryDisplayMeta(primaryCode) : null;

    const tripCountryPill = primaryMeta?.nameZh
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#EBF2EC] dark:bg-[#1D2D22] border border-[#C7DCCB] dark:border-[#32523C] text-[#3F6347] dark:text-[#9FD0AB] font-bold whitespace-nowrap">${primaryMeta.flag} 優先顯示${escapeHTML(primaryMeta.nameZh)}</span>`
      : '';
    const convertedPill = currentMeta.convertedHint
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-owl-softBg border border-owl-accentBorder/70 text-owl-primaryDeep font-bold whitespace-nowrap">通配「${escapeHTML(currentMeta.convertedHint)}」</span>`
      : '';

    const headerBar = `
      <div class="px-3.5 py-2 bg-owl-selectedBg border-b border-owl-border/80 flex items-center justify-between gap-2 text-xs text-owl-subtext">
        <div class="flex items-center flex-wrap gap-1.5 min-w-0">
          <span class="font-bold text-owl-text whitespace-nowrap">找到 ${currentList.length} 筆</span>
          ${tripCountryPill}
          ${convertedPill}
          <span class="hidden sm:inline text-owl-muted truncate">可加入「${escapeHTML(activeDay?.name || '目前天數')}」</span>
        </div>
        <button type="button" id="btn-close-search-dropdown" class="px-2 py-1 rounded-lg hover:bg-owl-softBg text-owl-muted hover:text-owl-text font-bold whitespace-nowrap shrink-0 transition">關閉</button>
      </div>
    `;

    const inCountryItems = currentList
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => item.inTripCountry);
    const otherCountryItems = currentList
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => !item.inTripCountry);

    const hasBothGroups = inCountryItems.length > 0 && otherCountryItems.length > 0;
    const activeDataIdx = highlightedPos >= 0 ? visualOrderIndices[highlightedPos] : -1;
    let bodyHtml = '';

    if (hasBothGroups) {
      visualOrderIndices = [...inCountryItems.map((x) => x.idx), ...otherCountryItems.map((x) => x.idx)];
      const tripLabel = primaryMeta?.nameZh ? `${primaryMeta.flag} 本計畫區域（${primaryMeta.nameZh}）` : '本計畫區域相符景點';
      bodyHtml += `
        <div class="px-3.5 py-1.5 bg-owl-softBg/85 border-b border-owl-border/60 text-xs font-extrabold text-owl-primaryDeep flex items-center justify-between">
          <span>${escapeHTML(tripLabel)}</span>
          <span class="text-[11px] font-semibold text-owl-muted">${inCountryItems.length} 筆</span>
        </div>
        ${inCountryItems.map(({ item, idx }) => renderResultRowHTML(item, idx, idx === activeDataIdx)).join('')}
        <div class="px-3.5 py-1.5 bg-owl-canvas/85 border-y border-owl-border/60 text-xs font-bold text-owl-subtext flex items-center justify-between">
          <span>🌐 其他國家同名或相近地點</span>
          <span class="text-[11px] font-semibold text-owl-muted">${otherCountryItems.length} 筆</span>
        </div>
        ${otherCountryItems.map(({ item, idx }) => renderResultRowHTML(item, idx, idx === activeDataIdx)).join('')}
      `;
    } else {
      visualOrderIndices = currentList.map((_, idx) => idx);
      bodyHtml = currentList.map((item, idx) => renderResultRowHTML(item, idx, idx === activeDataIdx)).join('');
    }

    resultsEl.innerHTML = headerBar + bodyHtml;
    resultsEl.classList.remove('hidden');
    refreshIcons(resultsEl);

    document.getElementById('btn-close-search-dropdown')?.addEventListener('click', closeSearchResults);

    resultsEl.querySelectorAll('.search-row-locate, .btn-search-locate').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        locateItem(currentList[Number(el.dataset.viewIdx)]);
      });
    });

    resultsEl.querySelectorAll('.btn-search-add').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addItem(currentList[Number(btn.dataset.addIdx)]);
      });
    });
  };

  const executeSearch = async (rawQuery, { isLive = false } = {}) => {
    const q = String(rawQuery || '').trim();
    if (!q) {
      cancelPending();
      currentList = [];
      visualOrderIndices = [];
      closeSearchResults();
      return;
    }

    cancelPending();
    const seq = ++requestSeq;
    const ctrl = new AbortController();
    activeAbortCtrl = ctrl;

    const tripProfile = inferTripCountryProfile(getState());

    // 若清單目前未展開（或手動按搜尋），顯示輕量載入狀態；打字更新時若已有舊結果則在背景刷新不閃爍
    if (!isLive || resultsEl.classList.contains('hidden')) {
      resultsEl.innerHTML = `
        <div class="search-loading-state p-4 text-sm font-semibold text-owl-subtext flex items-center justify-center gap-2">
          <span class="w-4 h-4 rounded-full border-2 border-owl-primary border-t-transparent animate-spin"></span>
          <span>搜尋「${escapeHTML(q)}」中...</span>
        </div>
      `;
      resultsEl.classList.remove('hidden');
    }

    try {
      const { results, convertedHint, tripCountries } = await searchPlaces(q, {
        tripCountries: tripProfile.countryCodes,
        focusCenter: tripProfile.focusCenter,
        signal: ctrl.signal,
        isLive,
      });

      if (seq !== requestSeq) return;
      currentList = results;
      currentMeta = { convertedHint, tripCountries, query: q };
      highlightedPos = -1;
      renderDropdown();
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== requestSeq) return;
      if (!isLive || resultsEl.querySelector('.search-loading-state')) {
        resultsEl.innerHTML = `<div class="p-4 text-sm text-[#A65D57] dark:text-[#E89B94] text-center">搜尋服務暫時無法連線，您可直接右鍵或長按地圖任意位置新增標點</div>`;
        resultsEl.classList.remove('hidden');
      }
    }
  };

  const scheduleLiveSearch = () => {
    syncSearchClearButton();
    const q = searchInput.value.trim();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (q.length < 2) {
      if (activeAbortCtrl) {
        activeAbortCtrl.abort();
        activeAbortCtrl = null;
      }
      if (q.length === 0) {
        currentList = [];
        visualOrderIndices = [];
        closeSearchResults();
      }
      return;
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void executeSearch(searchInput.value, { isLive: true });
    }, TYPEAHEAD_DEBOUNCE_MS);
  };

  searchInput.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  searchInput.addEventListener('compositionend', () => {
    isComposing = false;
    scheduleLiveSearch();
  });
  searchInput.addEventListener('input', () => {
    syncSearchClearButton();
    if (isComposing) return;
    scheduleLiveSearch();
  });

  searchInput.addEventListener('focus', () => {
    const q = searchInput.value.trim();
    if (q.length >= 2) {
      if (currentMeta.query === q && currentList.length > 0) {
        resultsEl.classList.remove('hidden');
      } else {
        scheduleLiveSearch();
      }
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (isComposing) return;
    const isOpen = !resultsEl.classList.contains('hidden') && visualOrderIndices.length > 0;
    if (e.key === 'ArrowDown' && isOpen) {
      e.preventDefault();
      highlightedPos = (highlightedPos + 1) % visualOrderIndices.length;
      updateHighlightInPlace();
    } else if (e.key === 'ArrowUp' && isOpen) {
      e.preventDefault();
      highlightedPos = highlightedPos <= 0 ? visualOrderIndices.length - 1 : highlightedPos - 1;
      updateHighlightInPlace();
    } else if (e.key === 'Enter' && isOpen && highlightedPos >= 0) {
      const targetIdx = visualOrderIndices[highlightedPos];
      if (currentList[targetIdx]) {
        e.preventDefault();
        locateItem(currentList[targetIdx]);
      }
    }
  });

  clearBtn?.addEventListener('click', () => {
    cancelPending();
    searchInput.value = '';
    currentList = [];
    visualOrderIndices = [];
    currentMeta = { convertedHint: '', tripCountries: [], query: '' };
    highlightedPos = -1;
    clearSearchHighlightMarker();
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
    if (e.key === 'Escape' && !isCustomDialogOpen()) closeSearchResults();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) {
      closeSearchResults();
      return;
    }
    void executeSearch(q, { isLive: false });
  });
}
