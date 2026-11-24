import { getState } from '../state/store.js';
import {
  getActiveDay,
  calcPinExpense,
  calcDayExpense,
  getTransportDisplayInfo,
} from '../state/selectors.js';
import { escapeHTML, formatTWD, refreshIcons, renderImageContent } from '../utils/format.js';

function pickReadableChipBg(color, fallback) {
  if (!color || !/^#[0-9A-Fa-f]{6}$/.test(color)) return fallback;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.82 ? fallback : color;
}

function renderSegmentedTransitChips(segments, dayColor) {
  const chips = segments.map((seg) => {
    if (seg.type === 'WALK') {
      return `<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-owl-card border border-owl-cardBorder text-[10px] font-bold text-owl-subtext whitespace-nowrap">🚶 ${seg.durationMin}分</span>`;
    }
    const bg = pickReadableChipBg(seg.lineColor, dayColor);
    const stopHint = seg.stopCount ? ` ${seg.stopCount}站` : '';
    return `<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold text-white whitespace-nowrap shadow-2xs" style="background:${bg};">${seg.vehicleEmoji || '🚆'} ${escapeHTML(seg.displayLine || '大眾運輸')}${escapeHTML(stopHint)}</span>`;
  });

  return chips.join('<span class="text-[10px] text-owl-muted font-bold">›</span>');
}

function renderConnectorHTML(day, pin, idx) {
  const t = pin.transportToNext;
  if (!t) {
    return `
      <div class="relative flex items-center justify-center py-2.5">
        <div class="absolute top-0 bottom-0 left-[23px] w-0.5 border-l-2 border-dashed border-owl-border"></div>
        <button type="button" data-transport-idx="${idx}" class="btn-open-transport relative z-10 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-owl-card hover:bg-owl-softBg border border-dashed border-owl-accentBorder/75 hover:border-owl-primary text-[11px] font-bold text-owl-subtext hover:text-owl-primaryDeep shadow-2xs transition active:scale-95">
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

  const costPill =
    info.cost > 0
      ? `<span class="text-[10px] font-bold shrink-0 px-1.5 py-0.5 rounded-md bg-[#EBF0F4] border border-[#C8D4DE] text-[#435A6E] tabular-nums-strict">${escapeHTML(formatTWD(info.cost))}</span>`
      : '';

  // 分段大眾運輸專屬卡片：直覺呈現「步行 → 大眾運輸路線 → 步行」與交通支出
  if (info.kind === 'transit-segmented' && Array.isArray(info.segments)) {
    return `
      <div class="transport-connector-row relative flex items-center pl-9 py-2">
        <div class="transport-connector-line absolute top-0 bottom-0 left-[23px] w-0.5" style="background: ${lineColor};"></div>
        <button type="button" data-transport-idx="${idx}" class="btn-open-transport group relative z-10 w-full flex flex-col gap-1.5 px-3 py-2 rounded-xl border bg-owl-selectedBg/95 hover:bg-owl-softBg border-owl-cardBorder hover:border-owl-accentBorder text-left transition">
          <div class="flex flex-wrap items-center gap-1">
            ${renderSegmentedTransitChips(info.segments, day.color)}
          </div>
          <div class="flex items-center justify-between gap-1.5">
            <span class="text-[10.5px] font-semibold text-owl-subtext truncate tabular-nums-strict">${escapeHTML(info.leftSub)}</span>
            <div class="flex items-center gap-1 shrink-0">
              ${costPill}
              <span class="transport-status-badge text-[10px] font-bold shrink-0 px-1.5 py-0.5 rounded-md border bg-owl-card border-owl-cardBorder text-owl-primaryDeep">${escapeHTML(info.badge)}</span>
            </div>
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
      <button type="button" data-transport-idx="${idx}" class="btn-open-transport group relative z-10 w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl border transition text-left ${cardClasses}">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-base leading-none shrink-0">${info.emoji}</span>
          <div class="min-w-0">
            <div class="text-xs font-bold truncate ${isAlert ? 'text-[#63564B]' : 'text-owl-text'}">${escapeHTML(info.leftTitle)}</div>
            <div class="text-[10px] font-medium truncate ${isAlert ? 'text-[#847568]' : 'text-owl-subtext'}">${escapeHTML(info.leftSub)}</div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          ${costPill}
          <span class="transport-status-badge text-[10px] font-bold shrink-0 px-1.5 py-0.5 rounded-md border ${isAlert ? 'bg-white/75 border-[#CFC5BA] text-[#78685B]' : 'bg-owl-card border-owl-cardBorder text-owl-primaryDeep'}">${escapeHTML(info.badge)}</span>
        </div>
      </button>
    </div>
  `;
}

function bindItineraryInteractions(day, { onOpenPinDetail, onOpenTransport, onReorderPins }) {
  const listEl = document.getElementById('itinerary-list');
  if (!listEl) return;

  listEl.querySelectorAll('.btn-open-transport').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onOpenTransport(day.id, Number(btn.dataset.transportIdx));
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

      if (!wasDragging && moved < 9 && !e.target.closest('.drag-handle')) {
        onOpenPinDetail(day.id, pinId);
      }
    };

    const onPointerCancel = () => {
      listEl.removeEventListener('scroll', onListScroll);
      endDrag(false);
    };

    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
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
  const state = getState();
  const day = getActiveDay(state);
  const listEl = document.getElementById('itinerary-list');
  if (!day || !listEl) return;

  document.getElementById('left-day-dot').style.backgroundColor = day.color;
  document.getElementById('left-day-title').textContent = day.name;
  document.getElementById('left-pin-count').textContent = `${day.pins.length} 個標點`;
  document.getElementById('left-day-expense').textContent = formatTWD(calcDayExpense(day));

  if (day.pins.length === 0) {
    listEl.innerHTML = `
      <div class="mt-8 rounded-3xl border-2 border-dashed border-owl-border bg-owl-selectedBg/70 p-7 text-center">
        <div class="w-12 h-12 mx-auto rounded-2xl bg-owl-softBg text-owl-primaryDeep flex items-center justify-center mb-3">
          <i data-lucide="map-pin-plus" class="w-6 h-6"></i>
        </div>
        <h3 class="text-sm font-bold text-owl-text">這一天還沒有標點</h3>
        <p class="text-xs text-owl-subtext mt-1.5 leading-relaxed">開啟「標點模式」點擊地圖，或使用上方搜尋列加入景點<br/><span class="text-[11px] text-owl-muted">（瀏覽模式下：桌機可右鍵、手機可長按地圖空處新增）</span></p>
      </div>
    `;
    refreshIcons();
    return;
  }

  let html = '';
  day.pins.forEach((pin, idx) => {
    const subCount = (pin.subSpots || []).length;
    const pinExpense = calcPinExpense(pin);
    const hasNext = idx < day.pins.length - 1;
    const hasImg = Boolean(pin.image);

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
              <div class="w-11 h-11 rounded-xl overflow-hidden border border-owl-cardBorder bg-owl-canvas shrink-0 shadow-2xs">
                ${renderImageContent(pin.image, 'w-full h-full')}
              </div>
            `
                : `
              <div class="w-11 h-11 rounded-xl border border-dashed border-owl-border bg-owl-selectedBg/60 text-owl-muted flex items-center justify-center shrink-0">
                <i data-lucide="image-plus" class="w-4 h-4"></i>
              </div>
            `
            }

            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-1">
                <h3 class="text-sm font-bold text-owl-text truncate">${escapeHTML(pin.name)}</h3>
                <i data-lucide="chevron-right" class="w-4 h-4 text-owl-muted group-hover:text-owl-primary shrink-0 transition"></i>
              </div>
              ${pin.notes ? `<p class="text-[11px] text-owl-subtext truncate mt-0.5">${escapeHTML(pin.notes)}</p>` : ''}
              <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-owl-softBg text-[10px] font-semibold text-owl-subtext">
                  <i data-lucide="sparkles" class="w-3 h-3 text-[#C48F3B]"></i>
                  ${subCount} 個小景點
                </span>
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#F2E9DE] border border-owl-cardBorder/80 text-[10px] font-bold text-owl-primaryDeep tabular-nums-strict">
                  支出 ${formatTWD(pinExpense)}
                </span>
              </div>
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
