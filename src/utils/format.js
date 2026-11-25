import {
  createElement,
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudOff,
  CloudUpload,
  Coins,
  Copy,
  Crosshair,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileJson,
  Folder,
  FolderPlus,
  GripHorizontal,
  GripVertical,
  HardDrive,
  HelpCircle,
  Image,
  ImagePlus,
  KeyRound,
  Layers,
  ListOrdered,
  Loader2,
  LogIn,
  LogOut,
  Map,
  MapPin,
  MapPinPlus,
  Maximize2,
  Menu,
  Minimize2,
  Navigation,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  StickyNote,
  Trash2,
  Upload,
  UploadCloud,
  WifiOff,
  X,
} from 'lucide';
import { PRESET_ARTWORKS } from '../config/presets.js';

const APP_ICONS = {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudOff,
  CloudUpload,
  Coins,
  Copy,
  Crosshair,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileJson,
  Folder,
  FolderPlus,
  GripHorizontal,
  GripVertical,
  HardDrive,
  HelpCircle,
  Image,
  ImagePlus,
  KeyRound,
  Layers,
  ListOrdered,
  Loader2,
  LogIn,
  LogOut,
  Map,
  MapPin,
  MapPinPlus,
  Maximize2,
  Menu,
  Minimize2,
  Navigation,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  StickyNote,
  Trash2,
  Upload,
  UploadCloud,
  WifiOff,
  X,
};

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DATA_IMAGE_RE = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

// 離線可用的內嵌 SVG 破圖佔位圖（不依賴外部 CDN、免 inline onerror）
export const FALLBACK_BROKEN_IMAGE_URI =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%23EFE6DA'/%3E%3Cpath d='M28 84l22-24 16 18 14-14 14 20H28z' fill='%23C7B299'/%3E%3Ccircle cx='44' cy='44' r='9' fill='%23C7B299'/%3E%3C/svg%3E";

// 預先將 11 款內建 SVG 編碼為獨立 data URI，徹底隔離 <linearGradient> ID，避免手機版隱藏面板導致漸層填色失效
const PRESET_DATA_URI_CACHE = Object.create(null);

function getPresetDataUri(key) {
  if (!Object.hasOwn(PRESET_ARTWORKS, key)) return '';
  if (!PRESET_DATA_URI_CACHE[key]) {
    const rawSvg = PRESET_ARTWORKS[key].svg.trim();
    const withXmlns = rawSvg.includes('xmlns=')
      ? rawSvg
      : rawSvg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    PRESET_DATA_URI_CACHE[key] = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withXmlns)}`;
  }
  return PRESET_DATA_URI_CACHE[key];
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function formatTWD(num) {
  const n = Math.max(0, Math.round(Number(num) || 0));
  return `NT$ ${n.toLocaleString('zh-TW')}`;
}

export function escapeHTML(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHexColor(color, fallback = '#9A7B5C') {
  const clean = typeof color === 'string' ? color.trim() : '';
  if (HEX_COLOR_RE.test(clean)) return clean;
  return HEX_COLOR_RE.test(fallback) ? fallback : '#9A7B5C';
}

export function pickReadableChipColor(color, fallback = '#9A7B5C') {
  const safeFallback = sanitizeHexColor(fallback, '#9A7B5C');
  const safeColor = sanitizeHexColor(color, '');
  if (!safeColor || safeColor === '#9A7B5C' && !HEX_COLOR_RE.test(String(color || '').trim())) {
    return safeFallback;
  }
  const r = parseInt(safeColor.slice(1, 3), 16);
  const g = parseInt(safeColor.slice(3, 5), 16);
  const b = parseInt(safeColor.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.82 ? safeFallback : safeColor;
}

export function sanitizeExternalUrl(raw, { httpsOnly = false } = {}) {
  const str = typeof raw === 'string' ? raw.trim() : '';
  if (!str) return '';
  try {
    const parsed = new URL(str);
    if (httpsOnly) {
      return parsed.protocol === 'https:' ? parsed.href : '';
    }
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

export function sanitizePinImage(imgObj) {
  if (!imgObj || typeof imgObj !== 'object') return null;
  const type = String(imgObj.type || '').trim();
  const value = typeof imgObj.value === 'string' ? imgObj.value.trim() : '';
  if (!value) return null;

  if (type === 'preset') {
    return Object.hasOwn(PRESET_ARTWORKS, value) ? { type: 'preset', value } : null;
  }
  if (type === 'url') {
    const safeUrl = sanitizeExternalUrl(value);
    return safeUrl ? { type: 'url', value: safeUrl } : null;
  }
  if (type === 'upload') {
    return DATA_IMAGE_RE.test(value) ? { type: 'upload', value } : null;
  }
  return null;
}

function toPascalCase(str) {
  return String(str || '').replace(/(\w)(\w*)(_|-|\s*)/g, (_, g1, g2) => g1.toUpperCase() + g2.toLowerCase());
}

/**
 * 增量式 Lucide 圖示轉換器：
 * 僅轉換尚未渲染的 <i data-lucide> 或圖示名稱有變更的 <svg>，
 * 不再重複銷毀重建整頁既有 SVG，大幅提升效能並保留進行中的 CSS 動畫。
 */
export function refreshIcons(root = typeof document !== 'undefined' ? document : null) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const nodes = root.querySelectorAll('[data-lucide]');
  for (const el of nodes) {
    const iconName = el.getAttribute('data-lucide');
    if (!iconName) continue;
    if (el.tagName.toLowerCase() === 'svg' && el.getAttribute('data-lucide-rendered') === iconName) {
      continue;
    }
    const iconNode = APP_ICONS[toPascalCase(iconName)];
    if (!iconNode) continue;
    const [tag, defaultAttrs, children] = iconNode;
    const elemAttrs = {};
    for (const attr of el.attributes) {
      if (attr.name === 'data-lucide-rendered') continue;
      elemAttrs[attr.name] = attr.value;
    }
    const baseClasses = String(elemAttrs.class || '')
      .split(/\s+/)
      .filter((c) => c && !c.startsWith('lucide'));
    const svgAttrs = {
      ...defaultAttrs,
      ...elemAttrs,
      'data-lucide': iconName,
      'data-lucide-rendered': iconName,
      class: ['lucide', `lucide-${iconName}`, ...baseClasses].join(' '),
    };
    const svgEl = createElement([tag, svgAttrs, children]);
    el.parentNode?.replaceChild(svgEl, el);
  }
}

export function formatDurationZh(minutes) {
  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m <= 0) return '';
  if (m < 60) return `${m} 分鐘`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h} 小時 ${rem} 分` : `${h} 小時`;
}

export function formatDistanceMetersZh(meters) {
  const m = Math.round(Number(meters));
  if (!Number.isFinite(m) || m <= 0) return '';
  if (m < 1000) return `${m} 公尺`;
  return `${(m / 1000).toFixed(1)} 公里`;
}

export function renderImageContent(imgObj, sizeClass = 'w-full h-full') {
  const safeImg = sanitizePinImage(imgObj);
  if (!safeImg) return '';
  if (safeImg.type === 'preset') {
    const uri = getPresetDataUri(safeImg.value);
    if (!uri) return '';
    const label = escapeHTML(PRESET_ARTWORKS[safeImg.value]?.name || '預設插圖');
    return `<img src="${uri}" alt="${label}" draggable="false" class="${sizeClass} object-cover select-none" />`;
  }
  const safeSrc = escapeHTML(safeImg.value);
  return `<img src="${safeSrc}" alt="標點圖片" draggable="false" referrerpolicy="no-referrer" loading="lazy" data-fallback-img="1" class="${sizeClass} object-cover select-none" />`;
}

// 統一透過 capture-phase error 監聽處理圖片載入失敗，完全免去 inline onerror 並支援離線顯示
let brokenImgListenerBound = false;
export function bindGlobalImageFallback() {
  if (brokenImgListenerBound || typeof document === 'undefined') return;
  brokenImgListenerBound = true;
  document.addEventListener(
    'error',
    (e) => {
      const target = e.target;
      if (
        target &&
        target.tagName === 'IMG' &&
        target.dataset?.fallbackImg === '1' &&
        !target.dataset.fallbackApplied
      ) {
        target.dataset.fallbackApplied = '1';
        target.src = FALLBACK_BROKEN_IMAGE_URI;
      }
    },
    true
  );
}
