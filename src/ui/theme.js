import { refreshIcons } from '../utils/format.js';

export const THEME_STORAGE_KEY = 'tripcanvas_theme_v1';
export const LIGHT_THEME_COLOR = '#FBF8F3';
export const DARK_THEME_COLOR = '#16120F';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

let boundWindowRef = null;
let boundButtonRef = null;
let themeChangeHandler = null;

export function getStoredTheme() {
  try {
    const val = window.localStorage?.getItem(THEME_STORAGE_KEY);
    return val === 'dark' || val === 'light' ? val : null;
  } catch {
    return null;
  }
}

export function getSystemTheme() {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia(DARK_MEDIA_QUERY).matches ? 'dark' : 'light';
    }
  } catch {
    // ignore
  }
  return null;
}

function persistTheme(theme) {
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 無痕模式或儲存受限時仍允許正常切換，不中斷操作
  }
}

function clearStoredTheme() {
  try {
    window.localStorage?.removeItem(THEME_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function isDarkTheme() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
}

export function getCurrentTheme() {
  return isDarkTheme() ? 'dark' : 'light';
}

export function resolveInitialTheme() {
  const stored = getStoredTheme();
  if (stored) return stored;
  const sys = getSystemTheme();
  if (sys) return sys;
  return isDarkTheme() ? 'dark' : 'light';
}

function syncThemeToggleButtonUI(dark, { animate = false } = {}) {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('btn-toggle-theme');
  if (!btn) return;

  btn.setAttribute('aria-pressed', String(dark));
  const label = dark ? '切換日間淺色模式' : '切換夜間深色模式';
  btn.title = label;
  btn.setAttribute('aria-label', label);

  btn.classList.toggle('text-owl-gold', dark);
  btn.classList.toggle('hover:text-owl-cream', dark);
  btn.classList.toggle('text-owl-text', !dark);
  btn.classList.toggle('hover:text-owl-primaryDeep', !dark);

  const iconEl = btn.querySelector('[data-lucide]');
  const nextIcon = dark ? 'sun' : 'moon';
  if (iconEl) {
    if (iconEl.getAttribute('data-lucide') !== nextIcon) {
      iconEl.setAttribute('data-lucide', nextIcon);
      iconEl.removeAttribute('data-lucide-rendered');
      refreshIcons(btn);
    }
    if (animate) {
      const latestIcon = btn.querySelector('[data-lucide]');
      if (latestIcon) {
        latestIcon.classList.remove('theme-icon-pop');
        void latestIcon.getBoundingClientRect?.();
        latestIcon.classList.add('theme-icon-pop');
      }
    }
  }
}

export function applyTheme(theme, { persist = true, animate = false, notify = true } = {}) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  const dark = normalized === 'dark';

  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.setAttribute('data-theme', normalized);

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
    }
  }

  if (persist) {
    persistTheme(normalized);
  }

  syncThemeToggleButtonUI(dark, { animate });

  if (notify && typeof themeChangeHandler === 'function') {
    themeChangeHandler(dark);
  }

  return normalized;
}

export function toggleTheme(options = {}) {
  const next = isDarkTheme() ? 'light' : 'dark';
  const sys = getSystemTheme();

  // 手動切換回與系統一致的外觀時清除手動覆蓋，恢復隨手機／系統日夜自動切換；切換為相反模式時則記憶覆蓋
  if (sys && next === sys) {
    clearStoredTheme();
    return applyTheme(next, { persist: false, animate: true, notify: true, ...options });
  }

  return applyTheme(next, { persist: true, animate: true, notify: true, ...options });
}

export function initTheme({ onChange = null } = {}) {
  themeChangeHandler = typeof onChange === 'function' ? onChange : null;

  const initialTheme = resolveInitialTheme();
  applyTheme(initialTheme, { persist: false, animate: false, notify: false });

  if (typeof document !== 'undefined') {
    const btn = document.getElementById('btn-toggle-theme');
    if (btn && boundButtonRef !== btn) {
      boundButtonRef = btn;
      btn.addEventListener('click', () => {
        toggleTheme();
      });
    }
  }

  if (typeof window !== 'undefined' && boundWindowRef !== window) {
    boundWindowRef = window;

    // 監聽手機／系統深淺色模式即時變動（例如日落自動切換或從控制中心開關）；僅於未手動覆蓋時自動跟隨
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia(DARK_MEDIA_QUERY);
      const handleSystemChange = (e) => {
        if (getStoredTheme() !== null) return;
        const next = e?.matches ? 'dark' : 'light';
        if (next !== getCurrentTheme()) {
          applyTheme(next, { persist: false, animate: false, notify: true });
        }
      };
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', handleSystemChange);
      } else if (typeof mq.addListener === 'function') {
        mq.addListener(handleSystemChange);
      }
    }

    if (typeof window.addEventListener === 'function') {
      window.addEventListener('storage', (e) => {
        if (e.key !== THEME_STORAGE_KEY) return;
        const next =
          e.newValue === 'dark' || e.newValue === 'light'
            ? e.newValue
            : getSystemTheme() || 'light';
        if (next !== getCurrentTheme()) {
          applyTheme(next, { persist: false, animate: false, notify: true });
        }
      });
    }
  }

  return initialTheme;
}
