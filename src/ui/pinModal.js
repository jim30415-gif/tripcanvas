import { PRESET_ARTWORKS } from '../config/presets.js';
import { getState, saveState } from '../state/store.js';
import { escapeHTML, formatTWD, refreshIcons, renderImageContent, uid } from '../utils/format.js';
import { flyToPoint } from '../map/mapInit.js';
import { openCustomDialog, showToast } from './dialog.js';
import { setMobileTab } from './mobileNav.js';

let editingPinContext = null;
let onChangeCallback = null;

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
    preview.innerHTML = `<span class="text-[11px] text-owl-muted text-center px-2">尚未設定圖片</span>`;
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
      return `
        <button type="button" data-preset-key="${key}" title="${art.name}" class="btn-pick-preset flex flex-col items-center gap-1 p-1 rounded-xl border-2 transition ${selected ? 'border-owl-primary bg-owl-softBg scale-105' : 'border-owl-cardBorder bg-white hover:border-owl-accentBorder'}">
          <div class="w-full aspect-square rounded-lg overflow-hidden">${art.svg}</div>
          <span class="text-[10px] font-bold text-owl-subtext leading-none pb-0.5">${art.name}</span>
        </button>
      `;
    })
    .join('');

  gallery.querySelectorAll('.btn-pick-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingPinContext.draftImage = { type: 'preset', value: btn.dataset.presetKey };
      document.getElementById('input-pin-image-url').value = '';
      renderDetailImagePreview();
      renderPresetGallery();
    });
  });
}

function renderDetailSubSpots() {
  const listEl = document.getElementById('detail-subspots-list');
  const spots = editingPinContext?.draftSubSpots || [];

  const subtotal = spots.reduce((sum, s) => sum + (Number(s.cost) || 0), 0);
  document.getElementById('detail-subspots-subtotal').textContent = formatTWD(subtotal);

  if (spots.length === 0) {
    listEl.innerHTML = `<div class="text-xs text-owl-muted text-center py-3 bg-owl-card rounded-xl border border-dashed border-owl-border">尚未新增小景點或支出項目</div>`;
    return;
  }

  listEl.innerHTML = spots
    .map(
      (spot, i) => `
      <div class="flex items-center gap-2 bg-owl-card border border-owl-cardBorder rounded-xl p-2">
        <input type="text" data-sub-idx="${i}" data-field="name" value="${escapeHTML(spot.name)}" class="subspot-input flex-1 min-w-0 bg-white px-2.5 py-1.5 rounded-lg border border-owl-border text-xs font-semibold text-owl-text focus:outline-none focus:ring-2 focus:ring-owl-primary/30" />
        <div class="relative w-24 sm:w-28 shrink-0">
          <span class="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-owl-muted">NT$</span>
          <input type="number" min="0" step="10" data-sub-idx="${i}" data-field="cost" value="${Number(spot.cost) || 0}" class="subspot-input w-full bg-white pl-8 pr-2 py-1.5 rounded-lg border border-owl-border text-xs font-bold text-owl-primaryDeep tabular-nums-strict focus:outline-none focus:ring-2 focus:ring-owl-primary/30" />
        </div>
        <button type="button" data-del-sub-idx="${i}" class="btn-del-subspot w-7 h-7 rounded-lg text-owl-muted hover:text-[#A65D57] hover:bg-[#F9EDEC] flex items-center justify-center shrink-0 transition">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>
    `
    )
    .join('');

  refreshIcons();

  listEl.querySelectorAll('.subspot-input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const i = Number(inp.dataset.subIdx);
      if (inp.dataset.field === 'cost') {
        editingPinContext.draftSubSpots[i].cost = Math.max(0, Number(inp.value) || 0);
        const sub = editingPinContext.draftSubSpots.reduce((sum, s) => sum + (Number(s.cost) || 0), 0);
        document.getElementById('detail-subspots-subtotal').textContent = formatTWD(sub);
      } else {
        editingPinContext.draftSubSpots[i].name = inp.value;
      }
    });
  });

  listEl.querySelectorAll('.btn-del-subspot').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingPinContext.draftSubSpots.splice(Number(btn.dataset.delSubIdx), 1);
      renderDetailSubSpots();
    });
  });
}

function addSubSpotFromInput() {
  if (!editingPinContext) return;
  const nameInp = document.getElementById('input-new-subspot-name');
  const costInp = document.getElementById('input-new-subspot-cost');
  const name = nameInp.value.trim();
  const cost = Math.max(0, Number(costInp.value) || 0);

  if (!name) {
    showToast('請輸入小景點或支出項目名稱', 'error');
    nameInp.focus();
    return;
  }

  editingPinContext.draftSubSpots.push({ id: uid('sub'), name, cost });
  nameInp.value = '';
  costInp.value = '';
  renderDetailSubSpots();
  nameInp.focus();
}

function handleLocalImageUpload(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('請選擇有效的圖片檔案', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 320;
      let w = img.width;
      let h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round(h * (maxDim / w));
          w = maxDim;
        } else {
          w = Math.round(w * (maxDim / h));
          h = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const compressed = canvas.toDataURL('image/jpeg', 0.76);
      editingPinContext.draftImage = { type: 'upload', value: compressed };
      document.getElementById('input-pin-image-url').value = '';
      renderDetailImagePreview();
      renderPresetGallery();
      showToast('已完成本機圖片壓縮並載入', 'success');
    };
    img.onerror = () => showToast('圖片讀取失敗', 'error');
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
    draftImage: pin.image ? { ...pin.image } : null,
    draftSubSpots: (pin.subSpots || []).map((s) => ({ ...s })),
  };

  const badge = document.getElementById('detail-pin-badge');
  badge.textContent = pinIdx + 1;
  badge.style.backgroundColor = day.color;

  document.getElementById('detail-pin-coords').textContent = `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;
  document.getElementById('detail-pin-name').value = pin.name;
  document.getElementById('detail-pin-notes').value = pin.notes || '';
  document.getElementById('input-pin-image-url').value = pin.image?.type === 'url' ? pin.image.value : '';
  document.getElementById('input-new-subspot-name').value = '';
  document.getElementById('input-new-subspot-cost').value = '';

  renderDetailImagePreview();
  renderPresetGallery();
  renderDetailSubSpots();

  document.getElementById('modal-pin-detail').classList.remove('hidden');
  refreshIcons();
}

export function closePinDetailModal() {
  document.getElementById('modal-pin-detail').classList.add('hidden');
  editingPinContext = null;
}

function savePinDetail() {
  if (!editingPinContext) return;
  const state = getState();
  const day = state.days.find((d) => d.id === editingPinContext.dayId);
  const pin = day?.pins.find((p) => p.id === editingPinContext.pinId);
  if (!pin) return;

  pin.name = document.getElementById('detail-pin-name').value.trim() || '未命名景點';
  pin.notes = document.getElementById('detail-pin-notes').value.trim();
  pin.image = editingPinContext.draftImage;
  pin.subSpots = editingPinContext.draftSubSpots.filter((s) => s.name.trim() !== '');

  saveState((msg) => showToast(msg, 'error'));
  closePinDetailModal();
  if (typeof onChangeCallback === 'function') onChangeCallback();
  showToast('已儲存標點資訊與支出', 'success');
}

export function bindPinModalEvents({ onStateChanged }) {
  onChangeCallback = onStateChanged;

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
    editingPinContext.draftImage = { type: 'url', value: url };
    renderDetailImagePreview();
    renderPresetGallery();
    showToast('已套用圖片網址', 'success');
  });

  document.getElementById('btn-add-subspot').addEventListener('click', addSubSpotFromInput);
  document.getElementById('input-new-subspot-cost').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSubSpotFromInput();
    }
  });

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
    const state = getState();
    const day = state.days.find((d) => d.id === editingPinContext.dayId);
    const idx = day?.pins.findIndex((p) => p.id === editingPinContext.pinId);
    if (!day || idx === -1) return;

    const ok = await openCustomDialog({
      title: '確定刪除此標點？',
      message: `將移除「${day.pins[idx].name}」以及其小景點支出與相連路徑。`,
      confirmText: '刪除標點',
      danger: true,
    });
    if (!ok) return;

    if (idx > 0) day.pins[idx - 1].transportToNext = null;
    day.pins.splice(idx, 1);
    saveState((msg) => showToast(msg, 'error'));
    closePinDetailModal();
    if (typeof onChangeCallback === 'function') onChangeCallback();
    showToast('已刪除標點', 'info');
  });
}
