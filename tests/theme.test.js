import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DARK_THEME_COLOR,
  LIGHT_THEME_COLOR,
  THEME_STORAGE_KEY,
  applyTheme,
  getCurrentTheme,
  getStoredTheme,
  getSystemTheme,
  initTheme,
  isDarkTheme,
  resolveInitialTheme,
  toggleTheme,
} from '../src/ui/theme.js';
import { GOOGLE_MAP_NIGHT_STYLES } from '../src/map/googleEngine.js';

function createMockClassList() {
  const set = new Set();
  return {
    add(...names) {
      names.forEach((n) => set.add(n));
    },
    remove(...names) {
      names.forEach((n) => set.delete(n));
    },
    toggle(name, force) {
      if (force === undefined) {
        if (set.has(name)) {
          set.delete(name);
          return false;
        }
        set.add(name);
        return true;
      }
      if (force) set.add(name);
      else set.delete(name);
      return Boolean(force);
    },
    contains(name) {
      return set.has(name);
    },
  };
}

function createMockElement(tagName = 'div') {
  const attrs = new Map();
  const listeners = new Map();
  return {
    tagName: tagName.toUpperCase(),
    classList: createMockClassList(),
    title: '',
    children: [],
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.has(k) ? attrs.get(k) : null;
    },
    removeAttribute(k) {
      attrs.delete(k);
    },
    addEventListener(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    dispatchEvent(evt) {
      const fns = listeners.get(evt) || [];
      fns.forEach((fn) => fn());
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

function withMockDom(fn, { systemDark = null } = {}) {
  const origDoc = globalThis.document;
  const origWin = globalThis.window;

  const store = new Map();
  const htmlEl = createMockElement('html');
  const metaTheme = createMockElement('meta');
  metaTheme.setAttribute('name', 'theme-color');
  metaTheme.setAttribute('content', LIGHT_THEME_COLOR);

  const toggleBtn = createMockElement('button');
  toggleBtn.setAttribute('id', 'btn-toggle-theme');

  const winListeners = new Map();
  let currentSystemDark = Boolean(systemDark);
  const mqListeners = [];

  const mockWin = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    addEventListener(evt, handler) {
      if (!winListeners.has(evt)) winListeners.set(evt, []);
      winListeners.get(evt).push(handler);
    },
  };

  if (systemDark !== null) {
    mockWin.matchMedia = () => ({
      get matches() {
        return currentSystemDark;
      },
      addEventListener(evt, handler) {
        if (evt === 'change') mqListeners.push(handler);
      },
    });
  }

  globalThis.window = mockWin;
  globalThis.document = {
    documentElement: htmlEl,
    getElementById(id) {
      if (id === 'btn-toggle-theme') return toggleBtn;
      return null;
    },
    querySelector(sel) {
      if (sel === 'meta[name="theme-color"]') return metaTheme;
      return null;
    },
  };

  const triggerSystemThemeChange = (nextDark) => {
    currentSystemDark = Boolean(nextDark);
    mqListeners.forEach((fn) => fn({ matches: currentSystemDark }));
  };

  try {
    return fn({ store, htmlEl, metaTheme, toggleBtn, winListeners, triggerSystemThemeChange });
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
}

test('theme toggle switches classes, theme-color, ARIA state, and persists when matchMedia is absent', () => {
  withMockDom(({ store, htmlEl, metaTheme, toggleBtn }) => {
    const changes = [];
    const initial = initTheme({ onChange: (dark) => changes.push(dark) });

    assert.equal(initial, 'light');
    assert.equal(getSystemTheme(), null);
    assert.equal(isDarkTheme(), false);
    assert.equal(getCurrentTheme(), 'light');
    assert.equal(htmlEl.getAttribute('data-theme'), 'light');
    assert.equal(metaTheme.getAttribute('content'), LIGHT_THEME_COLOR);
    assert.equal(toggleBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(toggleBtn.title, '切換夜間深色模式');

    // 切換為夜間深色模式
    const next1 = toggleTheme();
    assert.equal(next1, 'dark');
    assert.equal(isDarkTheme(), true);
    assert.equal(getStoredTheme(), 'dark');
    assert.equal(store.get(THEME_STORAGE_KEY), 'dark');
    assert.equal(htmlEl.getAttribute('data-theme'), 'dark');
    assert.equal(metaTheme.getAttribute('content'), DARK_THEME_COLOR);
    assert.equal(toggleBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(toggleBtn.title, '切換日間淺色模式');
    assert.equal(toggleBtn.classList.contains('text-owl-gold'), true);
    assert.deepEqual(changes, [true]);

    // 再次切換回日間淺色模式
    const next2 = toggleTheme();
    assert.equal(next2, 'light');
    assert.equal(isDarkTheme(), false);
    assert.equal(getStoredTheme(), 'light');
    assert.equal(metaTheme.getAttribute('content'), LIGHT_THEME_COLOR);
    assert.equal(toggleBtn.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(changes, [true, false]);
  });
});

test('auto-enables dark mode when mobile/OS prefers-color-scheme is dark and follows live system changes', () => {
  withMockDom(
    ({ store, metaTheme, toggleBtn, triggerSystemThemeChange }) => {
      const changes = [];
      assert.equal(getSystemTheme(), 'dark');
      assert.equal(resolveInitialTheme(), 'dark');

      const initial = initTheme({ onChange: (dark) => changes.push(dark) });
      assert.equal(initial, 'dark');
      assert.equal(isDarkTheme(), true);
      assert.equal(getStoredTheme(), null);
      assert.equal(metaTheme.getAttribute('content'), DARK_THEME_COLOR);
      assert.equal(toggleBtn.getAttribute('aria-pressed'), 'true');

      // 手機自動切回淺色模式時，若無手動覆蓋應即時跟隨
      triggerSystemThemeChange(false);
      assert.equal(isDarkTheme(), false);
      assert.deepEqual(changes, [false]);

      // 手機日落自動切回深色模式時，即時跟隨
      triggerSystemThemeChange(true);
      assert.equal(isDarkTheme(), true);
      assert.deepEqual(changes, [false, true]);

      // 使用者在深色手機上手動切為淺色模式 -> 記住覆蓋，暫不跟隨系統
      toggleTheme();
      assert.equal(isDarkTheme(), false);
      assert.equal(store.get(THEME_STORAGE_KEY), 'light');
      triggerSystemThemeChange(false);
      triggerSystemThemeChange(true);
      assert.equal(isDarkTheme(), false);

      // 使用者再手動切回與系統一致的深色模式 -> 清除覆蓋，恢復隨系統自動切換
      toggleTheme();
      assert.equal(isDarkTheme(), true);
      assert.equal(getStoredTheme(), null);
      triggerSystemThemeChange(false);
      assert.equal(isDarkTheme(), false);
    },
    { systemDark: true }
  );
});

test('applyTheme normalizes invalid values safely and tolerates unavailable localStorage', () => {
  withMockDom(({ metaTheme }) => {
    globalThis.window.localStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('QuotaExceeded');
      },
    };

    assert.equal(getStoredTheme(), null);
    assert.equal(applyTheme('dark', { notify: false }), 'dark');
    assert.equal(isDarkTheme(), true);
    assert.equal(metaTheme.getAttribute('content'), DARK_THEME_COLOR);

    assert.equal(applyTheme('invalid-value', { notify: false }), 'light');
    assert.equal(isDarkTheme(), false);
    assert.equal(metaTheme.getAttribute('content'), LIGHT_THEME_COLOR);
  });
});

test('GOOGLE_MAP_NIGHT_STYLES provides warm dark geometry and legible labels', () => {
  assert.ok(Array.isArray(GOOGLE_MAP_NIGHT_STYLES));
  assert.ok(GOOGLE_MAP_NIGHT_STYLES.length >= 10);
  const baseGeom = GOOGLE_MAP_NIGHT_STYLES.find((s) => !s.featureType && s.elementType === 'geometry');
  const labelFill = GOOGLE_MAP_NIGHT_STYLES.find((s) => !s.featureType && s.elementType === 'labels.text.fill');
  assert.ok(baseGeom?.stylers?.[0]?.color?.startsWith('#1'));
  assert.ok(labelFill?.stylers?.[0]?.color);
});
