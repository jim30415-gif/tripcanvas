import { EXPENSE_CATEGORIES } from '../config/constants.js';
import { PRESET_ARTWORKS } from '../config/presets.js';
import { getState, saveState } from '../state/store.js';
import {
  buildCurrencyOptionsHTML,
  convertToTwdSync,
  ensureFxRatesLoaded,
  formatCurrencyAmount,
} from '../services/currencyClient.js';
import { buildGoogleMapsPlaceUrl, isJapanCoord } from '../utils/geo.js';
import {
  escapeHTML,
  formatTWD,
  refreshIcons,
  renderImageContent,
  sanitizeHexColor,
  sanitizePinImage,
  uid,
} from '../utils/format.js';
import { flyToPoint } from '../map/mapInit.js';
import { isCustomDialogOpen, showToast } from './dialog.js';
import { setMobileTab } from './mobileNav.js';

let editingPinContext = null;
let onChangeCallback = null;
let onDeletePinCallback = null;

function buildCategoryOptionsHTML(selectedId = 'other') {
  return EXPENSE_CATEGORIES.map(
    (c) => `<option value="${c.id}" ${selectedId === c.id ? 'selected' : ''}>${c.emoji} ${c.label}</option>`
  ).join('');
}

function renderNewSubSpotFxPreview() {
  const previewEl = document.getElementById('new-subspot-fx-preview');
  const currencySel = document.getElementById('select-new-subspot-currency');
  const costInp = document.getElementById('input-new-subspot-cost');
  if (!previewEl || !currencySel || !costInp) return;

  const currency = currencySel.value || 'TWD';
  const rawVal = Number(costInp.value);
  if (currency === 'TWD' || !Number.isFinite(rawVal) || rawVal <= 0) {
    previewEl.classList.add('hidden');
    previewEl.innerHTML = '';
    return;
  }

  const conv = convertToTwdSync(rawVal, currency);
  const rateTag = conv.rateSource === 'live' ? '即時匯率' : '參考匯率';
  previewEl.innerHTML = `💱 <strong>${escapeHTML(formatCurrencyAmount(rawVal, currency))}</strong>（${escapeHTML(currency)}）≈ <strong>${formatTWD(conv.amountTwd)}</strong>（${rateTag}，新增後自動換算新台幣計入總支出）`;
  previewEl.classList.remove('hidden');
}

function renderDetailImagePreview() {
  const preview = document.getElementById('detail-image-preview');
  const removeBtn = document.getElementById('btn-remove-pin-image');
  const img = editingPinContext?.draftImage;

  if (img) {
    preview.innerHTML = renderImageContent(img, 'w-full h-full');
    preview.classList.remove('border-dashed');
    preview.classList.add('border-solid', 'border-owl-accentBorder');
    removeBtn.classList.remove('hidden');
  } else {
    preview.innerHTML = `<span class="text-xs text-owl-muted text-center px-2">尚未設定圖片</span>`;
    preview.classList.add('border-dashed');
    preview.classList.remove('border-solid', 'border-owl-accentBorder');
    removeBtn.classList.add('hidden');
  }
}

function renderPresetGallery() {
  const gallery = document.getElementById('preset-gallery');
  const currentVal =
    editingPinContext?.draftImage?.type === 'preset' ? editingPinContext.draftImage.value : null;

  gallery.innerHTML = Object.entries(PRESET_ARTWORKS)
    .map(([key, art]) => {
      const selected = currentVal === key;
      const previewImg = renderImageContent({ type: 'preset', value: key }, 'w-full h-full');
      return `
        <button type="button" data-preset-key="${escapeHTML(key)}" title="${escapeHTML(art.name)}" class="btn-pick-preset flex flex-col items-center gap-1 p-1.5 rounded-xl border-2 transition ${selected ? 'border-owl-primary bg-owl-softBg scale-105' : 'border-owl-cardBorder bg-white hover:border-owl-accentBorder'}">
          <div class="w-full aspect-square rounded-lg overflow-hidden">${previewImg}</div>
          <span class="text-xs font-bold text-owl-subtext leading-none pb-0.5">${escapeHTML(art.name)}</span>
        </button>
      `;
    })
    .join('');

  gallery.querySelectorAll('.btn-pick-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!editingPinContext) return;
      editingPinContext.draftImage = { type: 'preset', value: btn.dataset.presetKey };
      document.getElementById('input-pin-image-url').value = '';
      renderDetailImagePreview();
      renderPresetGallery();
    });
  });
}

function updateSubSpotsSubtotalDisplay() {
  const spots = editingPinContext?.draftSubSpots || [];
  const subtotal = spots.reduce((sum, s) => sum + (Number(s.cost) || 0), 0);
  const el = document.getElementById('detail-subspots-subtotal');
  if (el) el.textContent = formatTWD(subtotal);
}

function renderDetailSubSpots() {
  const listEl = document.getElementById('detail-subspots-list');
  const spots = editingPinContext?.draftSubSpots || [];

  updateSubSpotsSubtotalDisplay();

  if (spots.length === 0) {
    listEl.innerHTML = `<div class="text-sm text-owl-muted text-center py-3 bg-owl-card rounded-xl border border-dashed border-owl-border">尚未新增小景點或支出項目</div>`;
    return;
  }

  listEl.innerHTML = spots
    .map((spot, i) => {
      const activeCurrency =
        spot.originalCurrency && spot.originalCurrency !== 'TWD'
          ? spot.originalCurrency.toUpperCase()
          : 'TWD';
      const displayAmount =
        activeCurrency !== 'TWD' && Number(spot.originalAmount) > 0
          ? Number(spot.originalAmount)
          : Number(spot.cost) || 0;
      const showFxBadge = activeCurrency !== 'TWD' && displayAmount > 0;
      const fxText = showFxBadge ? `≈ ${formatTWD(Number(spot.cost) || 0)}` : '';

      return `
      <div class="subspot-row bg-owl-card border border-owl-cardBorder rounded-xl p-2.5 space-y-1.5" data-row-idx="${i}">
        <div class="flex flex-wrap sm:flex-nowrap items-center gap-1.5 sm:gap-2">
          <select data-sub-idx="${i}" data-field="category" title="支出分類" aria-label="支出分類" class="subspot-input bg-owl-softBg/70 hover:bg-owl-softBg px-2 py-1.5 rounded-lg border border-owl-border text-xs font-bold text-owl-text focus:outline-none focus:ring-2 focus:ring-owl-primary/30 shrink-0">
            ${buildCategoryOptionsHTML(spot.category || 'other')}
          </select>
          <input type="text" data-sub-idx="${i}" data-field="name" aria-label="支出項目名稱" value="${escapeHTML(spot.name)}" class="subspot-input flex-1 min-w-[110px] bg-white px-2.5 py-1.5 rounded-lg border border-owl-border text-sm font-semibold text-owl-text focus:outline-none focus:ring-2 focus:ring-owl-primary/35" />
          <div class="flex items-center rounded-lg border border-owl-border bg-white overflow-hidden focus-within:ring-2 focus-within:ring-owl-primary/30 shrink-0">
            <select data-sub-idx="${i}" data-field="currency" title="選擇幣別（外幣自動換算新台幣）" aria-label="支出幣別" class="subspot-input bg-owl-softBg/80 hover:bg-owl-softBg px-1.5 py-1.5 border-r border-owl-border text-xs font-extrabold text-owl-primaryDeep focus:outline-none shrink-0">
              ${buildCurrencyOptionsHTML(activeCurrency)}
            </select>
            <input type="number" inputmode="decimal" min="0" step="any" data-sub-idx="${i}" data-field="amount" aria-label="支出金額" value="${displayAmount}" class="subspot-input w-20 sm:w-24 bg-white px-2 py-1.5 text-sm font-bold text-owl-primaryDeep tabular-nums-strict focus:outline-none" />
          </div>
          <button type="button" data-del-sub-idx="${i}" aria-label="刪除此項支出" title="刪除此項支出" class="btn-del-subspot w-8 h-8 rounded-lg text-owl-muted hover:text-[#A65D57] hover:bg-[#F9EDEC] flex items-center justify-center shrink-0 transition">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
        <div data-fx-badge-idx="${i}" class="${showFxBadge ? '' : 'hidden '}text-right text-xs font-bold text-[#4F6F57] tabular-nums-strict pr-9">
          💱 自動換算新台幣：<span class="fx-twd-val">${escapeHTML(fxText)}</span>
        </div>
      </div>
    `;
    })
    .join('');

  refreshIcons(listEl);

  const recomputeRowFx = (rowIdx) => {
    const row = listEl.querySelector(`.subspot-row[data-row-idx="${rowIdx}"]`);
    const spot = editingPinContext?.draftSubSpots?.[rowIdx];
    if (!row || !spot) return;

    const curSel = row.querySelector('select[data-field="currency"]');
    const amtInp = row.querySelector('input[data-field="amount"]');
    const fxRow = row.querySelector(`[data-fx-badge-idx="${rowIdx}"]`);
    const fxValSpan = fxRow?.querySelector('.fx-twd-val');

    const currency = (curSel?.value || 'TWD').toUpperCase();
    const rawAmt = Math.max(0, Number(amtInp?.value) || 0);
    const conv = convertToTwdSync(rawAmt, currency);

    spot.cost = conv.amountTwd;
    if (currency !== 'TWD' && rawAmt > 0) {
      spot.originalCurrency = currency;
      spot.originalAmount = rawAmt;
      if (fxRow && fxValSpan) {
        fxValSpan.textContent = `≈ ${formatTWD(conv.amountTwd)}`;
        fxRow.classList.remove('hidden');
      }
    } else {
      delete spot.originalCurrency;
      delete spot.originalAmount;
      if (fxRow) fxRow.classList.add('hidden');
    }

    updateSubSpotsSubtotalDisplay();
  };

  listEl.querySelectorAll('.subspot-input').forEach((inp) => {
    const evt = inp.tagName === 'SELECT' ? 'change' : 'input';
    inp.addEventListener(evt, () => {
      if (!editingPinContext) return;
      const i = Number(inp.dataset.subIdx);
      const field = inp.dataset.field;
      if (!editingPinContext.draftSubSpots[i]) return;
      if (field === 'amount' || field === 'currency') {
        recomputeRowFx(i);
      } else if (field === 'category') {
        editingPinContext.draftSubSpots[i].category = inp.value || 'other';
      } else {
        editingPinContext.draftSubSpots[i].name = inp.value;
      }
    });
  });

  listEl.querySelectorAll('.btn-del-subspot').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!editingPinContext) return;
      editingPinContext.draftSubSpots.splice(Number(btn.dataset.delSubIdx), 1);
      renderDetailSubSpots();
    });
  });
}

function addSubSpotFromInput() {
  if (!editingPinContext) return;
  const nameInp = document.getElementById('input-new-subspot-name');
  const costInp = document.getElementById('input-new-subspot-cost');
  const currencySel = document.getElementById('select-new-subspot-currency');
  const catSel = document.getElementById('select-new-subspot-category');
  const name = nameInp.value.trim();
  const rawCost = Math.max(0, Number(costInp.value) || 0);
  const currency = currencySel?.value || 'TWD';
  const category = catSel?.value || 'other';

  if (!name) {
    showToast('請輸入小景點或支出項目名稱', 'error');
    nameInp.focus();
    return;
  }

  const conv = convertToTwdSync(rawCost, currency);
  const entry = {
    id: uid('sub'),
    name,
    cost: conv.amountTwd,
    category,
  };
  if (currency !== 'TWD' && rawCost > 0) {
    entry.originalAmount = rawCost;
    entry.originalCurrency = currency;
  }

  editingPinContext.draftSubSpots.push(entry);
  nameInp.value = '';
  costInp.value = '';
  renderNewSubSpotFxPreview();
  renderDetailSubSpots();
  nameInp.focus();
}

function handleLocalImageUpload(file) {
  const ctx = editingPinContext;
  if (!ctx) return;
  if (!file || !file.type.startsWith('image/')) {
    showToast('請選擇有效的圖片檔案', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => {
    showToast('本機圖片檔案讀取失敗', 'error');
  };
  reader.onload = (e) => {
    if (!editingPinContext || editingPinContext !== ctx) return;
    const img = new Image();
    img.onload = () => {
      if (!editingPinContext || editingPinContext !== ctx) return;
      const maxDim = 320;
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        showToast('圖片尺寸無效，請改選其他圖片', 'error');
        return;
      }
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.max(1, Math.round(h * (maxDim / w)));
          w = maxDim;
        } else {
          w = Math.max(1, Math.round(w * (maxDim / h)));
          h = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) {
        showToast('瀏覽器無法處理圖片壓縮', 'error');
        return;
      }
      // 透明 PNG / WebP 轉存 JPEG 前先填暖白底，避免出現黑底
      ctx2d.fillStyle = '#FFFDF9';
      ctx2d.fillRect(0, 0, w, h);
      ctx2d.drawImage(img, 0, 0, w, h);
      const compressed = canvas.toDataURL('image/jpeg', 0.76);
      editingPinContext.draftImage = { type: 'upload', value: compressed };
      document.getElementById('input-pin-image-url').value = '';
      renderDetailImagePreview();
      renderPresetGallery();
      showToast('已完成本機圖片壓縮並載入', 'success');
    };
    img.onerror = () => {
      if (editingPinContext === ctx) showToast('圖片讀取失敗', 'error');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

export function openPinDetailModal(dayId, pinId) {
  const state = getState();
  const day = state.days.find((d) => d.id === dayId);
  const pinIdx = day?.pins.findIndex((p) => p.id === pinId);
  if (!day || pinIdx === -1) return;
  const pin = day.pins[pinIdx];

  editingPinContext = {
    dayId,
    pinId,
    originalName: pin.name,
    userEditedName: false,
    draftImage: pin.image ? { ...pin.image } : null,
    draftSubSpots: (pin.subSpots || []).map((s) => ({ ...s })),
    pickedCandidatePlaceId: null, // null = 未改動；'' = 手動改名清除舊 placeId；string = 選用新候選 placeId
    draftLat: null,
    draftLng: null,
  };

  const badge = document.getElementById('detail-pin-badge');
  badge.textContent = pinIdx + 1;
  badge.style.backgroundColor = sanitizeHexColor(day.color);

  document.getElementById('detail-pin-coords').textContent = `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;
  document.getElementById('detail-pin-name').value = pin.name;

  // 若放點位置附近偵測到多個鄰近地標／店家，提供一鍵快選切換名稱與精準吸附座標
  const candidatesEl = document.getElementById('detail-nearby-candidates');
  if (candidatesEl) {
    const candidates = Array.isArray(pin.nearbyCandidates) ? pin.nearbyCandidates : [];
    if (candidates.length > 1) {
      candidatesEl.innerHTML =
        `<span class="text-xs font-semibold text-owl-muted">鄰近地標快選：</span>` +
        candidates
          .map(
            (c, i) => `
          <button
            type="button"
            data-candidate-idx="${i}"
            class="btn-pick-nearby-name px-2.5 py-1 rounded-full border border-owl-border bg-owl-softBg/80 hover:bg-owl-softBg hover:border-owl-accentBorder text-xs font-bold text-owl-primaryDeep transition"
          >
            ${escapeHTML(c.name)}
          </button>
        `
          )
          .join('');
      candidatesEl.classList.remove('hidden');
      candidatesEl.querySelectorAll('.btn-pick-nearby-name').forEach((btn) => {
        btn.addEventListener('click', () => {
          const picked = candidates[Number(btn.dataset.candidateIdx)];
          if (!picked || !editingPinContext) return;
          document.getElementById('detail-pin-name').value = picked.name;
          editingPinContext.userEditedName = true;
          editingPinContext.pickedCandidatePlaceId = picked.placeId || '';
          if (Number.isFinite(Number(picked.lat)) && Number.isFinite(Number(picked.lng))) {
            editingPinContext.draftLat = Number(picked.lat);
            editingPinContext.draftLng = Number(picked.lng);
            document.getElementById('detail-pin-coords').textContent =
              `${editingPinContext.draftLat.toFixed(5)}, ${editingPinContext.draftLng.toFixed(5)}`;
          }
          const gLink = document.getElementById('btn-open-pin-gmaps');
          if (gLink) {
            gLink.href = buildGoogleMapsPlaceUrl({
              ...pin,
              lat: editingPinContext.draftLat ?? pin.lat,
              lng: editingPinContext.draftLng ?? pin.lng,
              name: picked.name,
              placeId: picked.placeId || '',
            });
          }
        });
      });
    } else {
      candidatesEl.innerHTML = '';
      candidatesEl.classList.add('hidden');
    }
  }
  document.getElementById('detail-pin-notes').value = pin.notes || '';
  document.getElementById('input-pin-image-url').value = pin.image?.type === 'url' ? pin.image.value : '';
  const gmapsLink = document.getElementById('btn-open-pin-gmaps');
  if (gmapsLink) {
    gmapsLink.href = buildGoogleMapsPlaceUrl(pin);
  }
  document.getElementById('input-new-subspot-name').value = '';
  document.getElementById('input-new-subspot-cost').value = '';
  const currencySel = document.getElementById('select-new-subspot-currency');
  if (currencySel) {
    currencySel.value = isJapanCoord(pin) ? 'JPY' : 'TWD';
  }
  renderNewSubSpotFxPreview();

  ensureFxRatesLoaded().then(() => {
    if (editingPinContext?.pinId === pinId) {
      renderNewSubSpotFxPreview();
    }
  });

  renderDetailImagePreview();
  renderPresetGallery();
  renderDetailSubSpots();

  const modalEl = document.getElementById('modal-pin-detail');
  modalEl.classList.remove('hidden');
  refreshIcons(modalEl);
}

export function closePinDetailModal() {
  document.getElementById('modal-pin-detail').classList.add('hidden');
  editingPinContext = null;
}

function savePinDetail() {
  if (!editingPinContext) return;
  const ctx = editingPinContext;
  const state = getState();
  const day = state.days.find((d) => d.id === ctx.dayId);
  const pinIdx = day?.pins.findIndex((p) => p.id === ctx.pinId);
  if (!day || pinIdx === -1) return;
  const pin = day.pins[pinIdx];

  const nextName = document.getElementById('detail-pin-name').value.trim() || '未命名景點';
  const nameChangedByUser = ctx.userEditedName && nextName !== ctx.originalName;
  if (nameChangedByUser || nextName !== ctx.originalName) {
    // 使用者已手動修改名稱（或主動改選指定地標），之後拖曳標點時保留此自訂名稱不覆蓋
    pin.name = nextName;
    pin.nameCustomized = true;
  }
  pin.notes = document.getElementById('detail-pin-notes').value.trim();
  pin.image = sanitizePinImage(ctx.draftImage);
  pin.subSpots = ctx.draftSubSpots.filter((s) => s.name.trim() !== '');

  if (ctx.pickedCandidatePlaceId !== null) {
    if (ctx.pickedCandidatePlaceId) {
      pin.placeId = ctx.pickedCandidatePlaceId;
    } else {
      delete pin.placeId;
    }
  }

  // 若切換鄰近地標候選並帶有精確座標，同步吸附並重算相鄰自動路徑
  if (Number.isFinite(ctx.draftLat) && Number.isFinite(ctx.draftLng)) {
    const moved = Math.abs(pin.lat - ctx.draftLat) > 1e-6 || Math.abs(pin.lng - ctx.draftLng) > 1e-6;
    if (moved) {
      pin.lat = Number(ctx.draftLat.toFixed(6));
      pin.lng = Number(ctx.draftLng.toFixed(6));
      const invalidateAuto = (seg) => {
        if (!seg || seg.status === 'manual') return;
        seg.encodedPolyline = '';
        seg.status = 'pending';
        if (seg.mode === 'transit') seg.segments = [];
      };
      if (pinIdx > 0) invalidateAuto(day.pins[pinIdx - 1].transportToNext);
      if (pinIdx < day.pins.length - 1) invalidateAuto(pin.transportToNext);
    }
  }

  saveState((msg) => showToast(msg, 'error'));
  closePinDetailModal();
  if (typeof onChangeCallback === 'function') onChangeCallback();
  showToast('已儲存標點資訊與支出', 'success');
}

export function bindPinModalEvents({ onStateChanged, onDeletePin }) {
  onChangeCallback = onStateChanged;
  onDeletePinCallback = onDeletePin;

  const modalEl = document.getElementById('modal-pin-detail');
  modalEl?.addEventListener('click', (e) => {
    if (e.target === modalEl) closePinDetailModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editingPinContext && !isCustomDialogOpen()) closePinDetailModal();
  });

  document.getElementById('detail-pin-name')?.addEventListener('input', () => {
    if (!editingPinContext) return;
    editingPinContext.userEditedName = true;
    // 手動輸入新名稱時清除舊 placeId，避免 Google Maps 連結仍導向舊地標
    editingPinContext.pickedCandidatePlaceId = '';
  });

  document.getElementById('btn-close-pin-detail').addEventListener('click', closePinDetailModal);
  document.getElementById('btn-save-pin-detail').addEventListener('click', savePinDetail);

  document.getElementById('btn-remove-pin-image').addEventListener('click', () => {
    if (!editingPinContext) return;
    editingPinContext.draftImage = null;
    document.getElementById('input-pin-image-url').value = '';
    renderDetailImagePreview();
    renderPresetGallery();
  });

  document.getElementById('input-pin-image-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleLocalImageUpload(file);
    e.target.value = '';
  });

  document.getElementById('btn-apply-image-url').addEventListener('click', () => {
    if (!editingPinContext) return;
    const url = document.getElementById('input-pin-image-url').value.trim();
    if (!url) {
      showToast('請先輸入圖片網址', 'error');
      return;
    }
    const sanitized = sanitizePinImage({ type: 'url', value: url });
    if (!sanitized) {
      showToast('請輸入有效的 http:// 或 https:// 圖片網址', 'error');
      return;
    }
    editingPinContext.draftImage = sanitized;
    renderDetailImagePreview();
    renderPresetGallery();
    showToast('已套用圖片網址', 'success');
  });

  document.getElementById('btn-add-subspot').addEventListener('click', addSubSpotFromInput);
  document.getElementById('input-new-subspot-cost').addEventListener('input', renderNewSubSpotFxPreview);
  document.getElementById('select-new-subspot-currency')?.addEventListener('change', renderNewSubSpotFxPreview);
  const submitOnEnter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSubSpotFromInput();
    }
  };
  document.getElementById('input-new-subspot-name')?.addEventListener('keydown', submitOnEnter);
  document.getElementById('input-new-subspot-cost').addEventListener('keydown', submitOnEnter);

  document.getElementById('btn-locate-pin').addEventListener('click', () => {
    if (!editingPinContext) return;
    const state = getState();
    const day = state.days.find((d) => d.id === editingPinContext.dayId);
    const pin = day?.pins.find((p) => p.id === editingPinContext.pinId);
    if (!pin) return;
    if (!day.visible) {
      day.visible = true;
      saveState((msg) => showToast(msg, 'error'));
      if (typeof onChangeCallback === 'function') onChangeCallback();
    }
    closePinDetailModal();
    if (window.innerWidth < 1024) setMobileTab('map');
    setTimeout(() => flyToPoint(pin.lat, pin.lng, 16), 140);
  });

  document.getElementById('btn-delete-pin').addEventListener('click', async () => {
    if (!editingPinContext) return;
    const { dayId, pinId } = editingPinContext;
    if (typeof onDeletePinCallback === 'function') {
      const deleted = await onDeletePinCallback(dayId, pinId);
      if (deleted) closePinDetailModal();
    }
  });
}
