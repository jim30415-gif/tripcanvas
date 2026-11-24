import {
  createIcons,
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
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
  Folder,
  FolderPlus,
  GripHorizontal,
  GripVertical,
  HardDrive,
  HelpCircle,
  Image,
  ImagePlus,
  Info,
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
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
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
  Folder,
  FolderPlus,
  GripHorizontal,
  GripVertical,
  HardDrive,
  HelpCircle,
  Image,
  ImagePlus,
  Info,
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
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
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

export function refreshIcons() {
  createIcons({ icons: APP_ICONS });
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
  if (!imgObj) return '';
  if (imgObj.type === 'preset' && PRESET_ARTWORKS[imgObj.value]) {
    return `<div class="${sizeClass} overflow-hidden">${PRESET_ARTWORKS[imgObj.value].svg}</div>`;
  }
  if (imgObj.value) {
    const safeSrc = escapeHTML(imgObj.value);
    return `<img src="${safeSrc}" alt="標點圖片" class="${sizeClass} object-cover" onerror="this.onerror=null;this.src='https://placehold.co/160x160/EFE6DA/6B513A?text=No+Image';" />`;
  }
  return '';
}
