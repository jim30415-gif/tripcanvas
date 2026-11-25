import { getState } from '../state/store.js';
import { getActiveDay, getTransportDisplayInfo } from '../state/selectors.js';
import { buildGoogleMapsPlaceUrl } from '../utils/geo.js';
import { escapeHTML, refreshIcons, renderImageContent } from '../utils/format.js';

let isDayDropdownOpen = false;
let dayDropdownEventsBound = false;
let latestCallbacks = {};

function pickReadableChipBg(color, fallback) {
  if (!color || !/^#[0-9A-Fa-f]{6}$/.test(color)) return fallback;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.82 ? fallback : color;
}

function closeDayDropdown() {
  isDayDropdownOpen = false;
  const dropdown = document.getElementById('left-day-dropdown');
  const switcher = document.getElementById('btn-left-day-switcher');
  const chevron = document.getElementById('left-day-chevron');
  dropdown?.classList.add('hidden');
  switcher?.setAttribute('aria-expanded', 'false');
  if (chevron) chevron.style.transform = 'rotate(0deg)';
}

function renderLeftDayDropdown() {
  const dropdown = document.getElementById('left-day-dropdown');
  const switcher = document.getElementById('btn-left-day-switcher');
  const chevron = document.getElementById('left-day-chevron');
  if (!dropdown) return;

  switcher?.setAttribute('aria-expanded', String(isDayDropdownOpen));
  if (chevron) {
    chevron.style.transform = isDayDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)';
  }

  if (!isDayDropdownOpen) {
    dropdown.classList.add('hidden');
    return;
  }

  const state = getState();
  const itemsHtml = state.days
    .map((d, idx) => {
      const active = d.id === state.activeDayId;
      return `
        <button
          type="button"
          data-quick-day-id="${d.id}"
          class="btn-quick-switch-day w-full px-3.5 py-2.5 text-left flex items-center justify-between gap-2 transition ${
            active
              ? 'bg-owl-selectedBg text-owl-primaryDeep font-extrabold'
              : 'hover:bg-owl-softBg/80 text-owl-text font-semibold'
          }"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="w-3 h-3 rounded-full shrink-0" style="background:${d.color}; opacity:${d.visible ? 1 : 0.45};"></span>
            <span class="text-sm truncate">${escapeHTML(d.name || `Day ${idx + 1}`)}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-xs text-owl-muted">${d.pins.length} 點</span>
            ${active ? '<i data-lucide="check" class="w-4 h-4 text-owl-primary"></i>' : ''}
          </div>
        </button>
      `;
    })
    .join('');

  dropdown.innerHTML = `
    <div class="divide-y divide-owl-border/50">
      ${itemsHtml}
    </div>
    <div class="border-t border-owl-border/75 pt-1 mt-1 px-2">
      <button
        type="button"
        id="btn-quick-add-day"
        class="w-full py-2 px-2.5 rounded-xl text-xs sm:text-sm font-bold text-owl-primaryDeep hover:bg-owl-softBg flex items-center justify-center gap-1.5 transition"
      >
        <i data-lucide="plus" class="w-4 h-4"></i>
        <span>新增天數</span>
      </button>
    </div>
  `;
  dropdown.classList.remove('hidden');
  refreshIcons();

  dropdown.querySelectorAll('.btn-quick-switch-day').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dayId = btn.dataset.quickDayId;
      closeDayDropdown();
      if (typeof latestCallbacks.onSelectDay === 'function') {
        latestCallbacks.onSelectDay(dayId);
      }
    });
  });

  dropdown.querySelector('#btn-quick-add-day')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDayDropdown();
    if (typeof latestCallbacks.onAddDay === 'function') {
      latestCallbacks.onAddDay();
    }
  });
}

function ensureDayDropdownBound() {
  if (dayDropdownEventsBound) return;
  const switcher = document.getElementById('btn-left-day-switcher');
  if (!switcher) return;
  dayDropdownEventsBound = true;

  switcher.addEventListener('click', (e) => {
    e.stopPropagation();
    isDayDropdownOpen = !isDayDropdownOpen;
    renderLeftDayDropdown();
  });

  document.addEventListener('click', (e) => {
    if (
      isDayDropdownOpen &&
      !e.target.closest('#btn-left-day-switcher') &&
      !e.target.closest('#left-day-dropdown')
    ) {
      closeDayDropdown();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDayDropdownOpen) {
      closeDayDropdown();
    }
  });
}

function renderSegmentedTransitChips(segments, dayColor) {
  const chips = segments.map((seg) => {
    if (seg.type === 'WALK') {
      return `<span class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md bg-owl-card border border-owl-cardBorder text-xs font-bold text-owl-subtext whitespace-nowrap">🚶 ${seg.durationMin}分</span>`;
    }
    const bg = pickReadableChipBg(seg.lineColor, dayColor);
    const stopHint = seg.stopCount ? ` ${seg.stopCount}站` : '';
    return `<span class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-xs font-bold text-white whitespace-nowrap shadow-2xs" style="background:${bg};">${seg.vehicleEmoji || '🚆'} ${escapeHTML(seg.displayLine || '大眾運輸')}${escapeHTML(stopHint)}</span>`;
  });

  return chips.join('<span class="text-xs text-owl-muted font-bold">›</span>');
}

function renderConnectorHTML(day, pin, idx) {
  const t = pin.transportToNext;
  if (!t) {
    return `
      <div class="relative flex items-center justify-center py-2.5">
        <div class="absolute top-0 bottom-0 left-[23px] w-0.5 border-l-2 border-dashed border-owl-border"></div>
        <button type="button" data-transport-idx="${idx}" class="btn-open-transport relative z-10 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-owl-card hover:bg-owl-softBg border border-dashed border-owl-accentBorder/75 hover:border-owl-primary text-xs font-bold text-owl-subtext hover:text-owl-primaryDeep shadow-2xs transition active:scale-95">
          <span class="w-4 h-4 rounded-full bg-owl-softBg text-owl-primaryDeep flex items-center justify-center">
            <i data-lucide="plus" class="w-3 h-3"></i>
          </span>
          設定交通方式
        </button>
      </div>
    `;
  }

  const info = getTransportDisplayInfo(t);
  const isAlert = info.kind === 'unsupported' || info.kind === 'network_error';
  const isUnrecorded = info.kind === 'transit-empty';
  const lineColor = isAlert ? '#C5BAB0' : `${day.color}55`;

  // 分段大眾運輸專屬卡片（支出統一由中央總支出檢視，卡片維持清爽）
  if (info.kind === 'transit-segmented' && Array.isArray(info.segments)) {
    return `
      <div class="transport-connector-row relative flex items-center pl-9 py-2">
        <div class="transport-connector-line absolute top-0 bottom-0 left-[23px] w-0.5" style="background: ${lineColor};"></div>
        <button type="button" data-transport-idx="${idx}" class="btn-open-transport group relative z-10 w-full flex flex-col gap-1.5 px-3 py-2 rounded-xl border bg-owl-selectedBg/95 hover:bg-owl-softBg border-owl-cardBorder hover:border-owl-accentBorder text-left transition">
          <div class="flex flex-wrap items-center gap-1">
            ${renderSegmentedTransitChips(info.segments, day.color)}
          </div>
          <div class="flex items-center justify-between gap-1.5">
            <span class="text-xs font-semibold text-owl-subtext truncate tabular-nums-strict">${escapeHTML(info.leftSub)}</span>
            <span class="transport-status-badge text-[11px] font-bold shrink-0 px-2 py-0.5 rounded-md border bg-owl-card border-owl-cardBorder text-owl-primaryDeep">${escapeHTML(info.badge)}</span>
          </div>
        </button>
      </div>
    `;
  }

  const cardClasses = isAlert
    ? 'bg-[#F0ECE7] hover:bg-[#E7E0D8] border-[#CFC5BA] text-[#6B5F55]'
    : isUnrecorded
      ? 'bg-[#F6F1EA] hover:bg-owl-softBg border-dashed border-owl-border text-owl-subtext'
      : 'bg-owl-selectedBg/90 hover:bg-owl-softBg border-owl-cardBorder hover:border-owl-accentBorder text-owl-text';

  return `
    <div class="transport-connector-row relative flex items-center pl-9 py-2">
      <div class="transport-connector-line absolute top-0 bottom-0 left-[23px] w-0.5" style="background: ${lineColor};"></div>
      <button type="button" data-transport-idx="${idx}" class="btn-open-transport group relative z-10 w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border transition text-left ${cardClasses}">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-base leading-none shrink-0">${info.emoji}</span>
          <div class="min-w-0">
            <div class="text-sm font-bold truncate ${isAlert ? 'text-[#63564B]' : 'text-owl-text'}">${escapeHTML(info.leftTitle)}</div>
            <div class="text-xs font-medium truncate ${isAlert ? 'text-[#847568]' : 'text-owl-subtext'}">${escapeHTML(info.leftSub)}</div>
          </div>
        </div>
        <span class="transport-status-badge text-[11px] font-bold shrink-0 px-2 py-0.5 rounded-md border ${isAlert ? 'bg-white/75 border-[#CFC5BA] text-[#78685B]' : 'bg-owl-card border-owl-cardBorder text-owl-primaryDeep'}">${escapeHTML(info.badge)}</span>
      </button>
    </div>
  `;
}

function bindItineraryInteractions(day, { onOpenPinDetail, onOpenTransport, onReorderPins, onDeletePin }) {
  const listEl = document.getElementById('itinerary-list');
  if (!listEl) return;

  listEl.querySelectorAll('.btn-open-transport').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onOpenTransport(day.id, Number(btn.dataset.transportIdx));
    });
  });

  // 單景點直接跳轉 Google Maps 與快速刪除按鈕（避免誤觸開詳情或長按拖曳）
  listEl.querySelectorAll('.btn-card-gmaps').forEach((link) => {
    link.addEventListener('pointerdown', (e) => e.stopPropagation());
    link.addEventListener('click', (e) => e.stopPropagation());
  });

  listEl.querySelectorAll('.btn-card-delete').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof onDeletePin === 'function') {
        onDeletePin(day.id, btn.dataset.deletePinId);
      }
    });
  });

  listEl.querySelectorAll('.pin-card').forEach((card) => {
    const pinIndex = Number(card.dataset.pinIndex);
    const pinId = card.dataset.pinId;

    let longPressTimer = null;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let pointerId = null;
    let ghostEl = null;
    let indicatorEl = null;
    let targetIndex = pinIndex;

    const blockTouchScroll = (ev) => {
      if (isDragging && ev.cancelable) ev.preventDefault();
    };

    const clearTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const startDrag = (clientY) => {
      isDragging = true;
      clearTimer();
      if (navigator.vibrate) navigator.vibrate(25);
      window.addEventListener('touchmove', blockTouchScroll, { passive: false });
      listEl.style.overflowY = 'hidden';
      try {
        if (pointerId != null && card.setPointerCapture) card.setPointerCapture(pointerId);
      } catch {
        // 某些瀏覽器若觸控點已移開則略過 capture
      }

      const rect = card.getBoundingClientRect();
      card.classList.add('dragging-source');

      ghostEl = card.cloneNode(true);
      ghostEl.classList.remove('dragging-source');
      ghostEl.classList.add('drag-ghost');
      ghostEl.style.width = `${rect.width}px`;
      ghostEl.style.left = `${rect.left}px`;
      ghostEl.style.top = `${clientY - rect.height / 2}px`;
      document.body.appendChild(ghostEl);

      indicatorEl = document.createElement('div');
      indicatorEl.className = 'h-1.5 rounded-full bg-owl-primary my-1.5 shadow-sm transition-all';
      targetIndex = pinIndex;
    };

    const updateDragPosition = (clientY) => {
      if (!ghostEl) return;
      const ghostRect = ghostEl.getBoundingClientRect();
      ghostEl.style.top = `${clientY - ghostRect.height / 2}px`;

      const listRect = listEl.getBoundingClientRect();
      if (clientY < listRect.top + 55) listEl.scrollTop -= 9;
      else if (clientY > listRect.bottom - 55) listEl.scrollTop += 9;

      const blocks = Array.from(listEl.querySelectorAll('.pin-item-block'));
      let newTarget = blocks.length - 1;
      let inserted = false;

      for (let i = 0; i < blocks.length; i++) {
        const bCard = blocks[i].querySelector('.pin-card');
        const bRect = bCard.getBoundingClientRect();
        const midY = bRect.top + bRect.height / 2;
        if (clientY < midY) {
          newTarget = i;
          blocks[i].parentNode.insertBefore(indicatorEl, blocks[i]);
          inserted = true;
          break;
        }
      }

      if (!inserted && blocks.length > 0) {
        newTarget = blocks.length - 1;
        blocks[blocks.length - 1].after(indicatorEl);
      }
      targetIndex = newTarget;
    };

    const endDrag = (commit) => {
      clearTimer();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('touchmove', blockTouchScroll);
      listEl.style.overflowY = '';
      try {
        if (pointerId != null && card.hasPointerCapture?.(pointerId)) {
          card.releasePointerCapture(pointerId);
        }
      } catch {
        // ignore
      }

      if (!isDragging) return;
      isDragging = false;
      card.classList.remove('dragging-source');

      if (ghostEl) {
        ghostEl.remove();
        ghostEl = null;
      }
      if (indicatorEl) {
        indicatorEl.remove();
        indicatorEl = null;
      }

      if (commit && targetIndex !== pinIndex) {
        onReorderPins(day.id, pinIndex, targetIndex);
      }
    };

    const onPointerMove = (e) => {
      if (e.pointerId !== pointerId) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);

      if (!isDragging) {
        if (e.target.closest('.drag-handle') && dy > 5) {
          startDrag(e.clientY);
          return;
        }
        if (dx > 6 || dy > 6) {
          clearTimer();
          window.removeEventListener('pointermove', onPointerMove);
        }
      } else {
        e.preventDefault();
        updateDragPosition(e.clientY);
      }
    };

    const onListScroll = () => {
      if (!isDragging) {
        clearTimer();
        window.removeEventListener('pointermove', onPointerMove);
      }
    };

    const onPointerUp = (e) => {
      if (e.pointerId !== pointerId) return;
      listEl.removeEventListener('scroll', onListScroll);
      const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
      const wasDragging = isDragging;
      endDrag(true);

      if (!wasDragging && moved < 9 && !e.target.closest('.drag-handle') && !e.target.closest('.btn-card-gmaps')) {
        onOpenPinDetail(day.id, pinId);
      }
    };

    const onPointerCancel = () => {
      listEl.removeEventListener('scroll', onListScroll);
      endDrag(false);
    };

    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.target.closest('.btn-card-gmaps')) return;
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;

      const isHandle = Boolean(e.target.closest('.drag-handle'));
      const pressDelay = isHandle ? 75 : e.pointerType === 'touch' ? 420 : 250;
      longPressTimer = setTimeout(() => {
        card.classList.add('longpress-active');
        setTimeout(() => card.classList.remove('longpress-active'), 450);
        startDrag(startY);
      }, pressDelay);

      listEl.addEventListener('scroll', onListScroll, { passive: true });
      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    });
  });
}

export function renderLeftPanel(callbacks) {
  latestCallbacks = callbacks || {};
  ensureDayDropdownBound();

  const state = getState();
  const day = getActiveDay(state);
  const listEl = document.getElementById('itinerary-list');
  if (!day || !listEl) return;

  document.getElementById('left-day-dot').style.backgroundColor = day.color;
  document.getElementById('left-day-title').textContent = day.name;
  document.getElementById('left-pin-count').textContent = `${day.pins.length} 個標點`;

  if (isDayDropdownOpen) {
    renderLeftDayDropdown();
  }

  if (day.pins.length === 0) {
    listEl.innerHTML = `
      <div class="mt-8 rounded-3xl border-2 border-dashed border-owl-border bg-owl-selectedBg/70 p-7 text-center">
        <div class="w-12 h-12 mx-auto rounded-2xl bg-owl-softBg text-owl-primaryDeep flex items-center justify-center mb-3">
          <i data-lucide="map-pin-plus" class="w-6 h-6"></i>
        </div>
        <h3 class="text-base font-bold text-owl-text">這一天還沒有標點</h3>
        <p class="text-sm text-owl-subtext mt-1.5 leading-relaxed">電腦請「右鍵點擊」地圖、手機請「長按」地圖空處，<br/>或直接使用上方搜尋列加入景點！</p>
      </div>
    `;
    refreshIcons();
    return;
  }

  let html = '';
  day.pins.forEach((pin, idx) => {
    const subCount = (pin.subSpots || []).length;
    const hasNext = idx < day.pins.length - 1;
    const hasImg = Boolean(pin.image);
    const gmapsUrl = buildGoogleMapsPlaceUrl(pin);

    html += `
      <div class="pin-item-block" data-pin-index="${idx}" data-pin-id="${pin.id}">
        <div class="pin-card group relative bg-owl-card hover:bg-owl-selectedBg/75 border border-owl-cardBorder hover:border-owl-accentBorder rounded-2xl p-3 shadow-xs hover:shadow-soft transition cursor-pointer touch-pan-y" data-pin-index="${idx}" data-pin-id="${pin.id}">
          <div class="flex items-center gap-2">
            <div class="drag-handle flex flex-col items-center justify-center gap-1 min-w-[38px] min-h-[44px] -ml-1.5 pl-1.5 pr-1 py-1 cursor-grab active:cursor-grabbing text-owl-muted group-hover:text-owl-primaryDeep shrink-0 touch-none" title="按住上下拖曳調整順序">
              <span class="w-6 h-6 rounded-full text-white text-xs font-extrabold flex items-center justify-center shadow-xs" style="background:${day.color};">
                ${idx + 1}
              </span>
              <i data-lucide="grip-horizontal" class="w-3.5 h-3.5"></i>
            </div>

            ${
              hasImg
                ? `
              <div class="pin-thumb-box w-12 h-12 rounded-xl overflow-hidden border border-owl-cardBorder bg-owl-canvas shrink-0 shadow-2xs">
                ${renderImageContent(pin.image, 'w-full h-full')}
              </div>
            `
                : `
              <div class="pin-thumb-box w-12 h-12 rounded-xl border border-dashed border-owl-border bg-owl-selectedBg/60 text-owl-muted flex items-center justify-center shrink-0">
                <i data-lucide="image-plus" class="w-4 h-4"></i>
              </div>
            `
            }

            <div class="flex-1 min-w-0">
              <h3 class="text-[15px] font-bold text-owl-text truncate">${escapeHTML(pin.name)}</h3>
              ${pin.notes ? `<p class="text-xs text-owl-subtext truncate mt-0.5">${escapeHTML(pin.notes)}</p>` : ''}
              ${
                subCount > 0
                  ? `
                <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-owl-softBg text-xs font-semibold text-owl-subtext whitespace-nowrap">
                    <i data-lucide="sparkles" class="w-3 h-3 text-[#C48F3B] shrink-0"></i>
                    ${subCount} 個小景點
                  </span>
                </div>
              `
                  : ''
              }
            </div>

            <!-- 右側上下對稱快速操作列：上方 Google Maps 導出、下方快速刪除 -->
            <div class="flex flex-col items-center justify-center gap-1 shrink-0 pl-0.5">
              <a
                href="${escapeHTML(gmapsUrl)}"
                target="_blank"
                rel="noopener noreferrer"
                title="在 Google Maps 開啟此景點"
                aria-label="在 Google Maps 開啟 ${escapeHTML(pin.name)}"
                class="btn-card-gmaps w-7 h-7 rounded-lg text-[#4F6F57] hover:bg-[#EBF2EC] flex items-center justify-center transition active:scale-90"
              >
                <i data-lucide="navigation" class="w-3.5 h-3.5"></i>
              </a>
              <button
                type="button"
                data-delete-pin-id="${pin.id}"
                title="快速刪除此景點"
                aria-label="刪除 ${escapeHTML(pin.name)}"
                class="btn-card-delete w-7 h-7 rounded-lg text-owl-muted hover:text-[#A65D57] hover:bg-[#F9EDEC] flex items-center justify-center transition active:scale-90"
              >
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </div>
        </div>

        ${hasNext ? renderConnectorHTML(day, pin, idx) : ''}
      </div>
    `;
  });

  listEl.innerHTML = html;
  refreshIcons();
  bindItineraryInteractions(day, callbacks);
}
