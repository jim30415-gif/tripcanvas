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

test('GOOGLE_MAP_NIGHT_STYLES provides Google-Maps-inspired cool dark slate geometry and legible labels', () => {
  assert.ok(Array.isArray(GOOGLE_MAP_NIGHT_STYLES));
  assert.ok(GOOGLE_MAP_NIGHT_STYLES.length >= 10);
  const baseGeom = GOOGLE_MAP_NIGHT_STYLES.find((s) => !s.featureType && s.elementType === 'geometry');
  const waterGeom = GOOGLE_MAP_NIGHT_STYLES.find((s) => s.featureType === 'water' && s.elementType === 'geometry');
  const labelFill = GOOGLE_MAP_NIGHT_STYLES.find((s) => !s.featureType && s.elementType === 'labels.text.fill');
  assert.equal(baseGeom?.stylers?.[0]?.color, '#21262D');
  assert.equal(waterGeom?.stylers?.[0]?.color, '#122234');
  assert.ok(labelFill?.stylers?.[0]?.color);
});

test('nightSky computes bounded shooting star trajectories for desktop and mobile', async () => {
  const { computeShootingStarGeometry, SHOOTING_STAR_CONFIG } = await import('../src/ui/nightSky.js');

  const desktopGeo = computeShootingStarGeometry(1440, 900, () => 0.5);
  assert.ok(desktopGeo.startX >= 1440 * 0.56 && desktopGeo.startX <= 1440 * 0.84);
  assert.ok(desktopGeo.startY >= 900 * 0.06 && desktopGeo.startY <= 900 * 0.32);
  assert.ok(desktopGeo.angleDeg >= 144 && desktopGeo.angleDeg <= 158);
  assert.ok(desktopGeo.distancePx >= 460 && desktopGeo.distancePx <= 900);
  assert.ok(desktopGeo.tailLengthPx >= 158 && desktopGeo.tailLengthPx <= 255);
  assert.ok(
    desktopGeo.durationMs >= SHOOTING_STAR_CONFIG.durationMinMs &&
      desktopGeo.durationMs <= SHOOTING_STAR_CONFIG.durationMaxMs
  );

  const mobileLeftToRight = computeShootingStarGeometry(390, 844, () => 0.85);
  assert.ok(mobileLeftToRight.angleDeg >= 22 && mobileLeftToRight.angleDeg <= 36);
  assert.ok(mobileLeftToRight.distancePx >= 240 && mobileLeftToRight.distancePx <= 340);
});

test('spawnShootingStar respects dark mode, reduced motion, and uses decoupled composite-only WAAPI tracks without velocity kinks or scale(0)', async () => {
  const { spawnShootingStar, clearActiveShootingStar, SHOOTING_STAR_CONFIG } = await import('../src/ui/nightSky.js');

  const origDoc = globalThis.document;
  const origWin = globalThis.window;

  let reducedMotion = false;
  const capturedCalls = [];
  let cancelledCount = 0;

  const createDomNode = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      className: '',
      style: {},
      children: [],
      removed: false,
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      remove() {
        this.removed = true;
      },
      getBoundingClientRect() {
        return { width: 1280, height: 720 };
      },
      animate(keyframes, options) {
        capturedCalls.push({ className: this.className, keyframes, options });
        return {
          onfinish: null,
          oncancel: null,
          cancel() {
            cancelledCount += 1;
          },
        };
      },
    };
    return node;
  };

  const htmlEl = createMockElement('html');
  const layer = createDomNode('div');

  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 720,
    matchMedia: (query) => ({
      matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
      addEventListener() {},
    }),
  };
  globalThis.document = {
    documentElement: htmlEl,
    visibilityState: 'visible',
    getElementById: (id) => (id === 'night-sky-easter-egg' ? layer : null),
    createElement: (tag) => createDomNode(tag),
  };

  try {
    // 淺色模式下不應發射流星
    assert.equal(spawnShootingStar(), false);
    assert.equal(layer.children.length, 0);

    // 切換深色模式後發射流星：位移(2關鍵幀連續曲線)、透明度、尾跡伸縮三軌獨立，僅使用 GPU 合成屬性且不用 scale(0)
    htmlEl.classList.add('dark');
    assert.equal(spawnShootingStar({ rng: () => 0.4 }), true);
    assert.equal(layer.children.length, 1);
    assert.equal(capturedCalls.length, 3);

    const [moveCall, opacityCall, tailCall] = capturedCalls;
    assert.equal(moveCall.className, 'shooting-star-mover');
    assert.equal(moveCall.keyframes.length, 2);
    assert.equal(moveCall.options.easing, SHOOTING_STAR_CONFIG.easing);

    assert.equal(opacityCall.className, 'shooting-star-mover');
    assert.equal(tailCall.className, 'shooting-star-tail');

    for (const call of capturedCalls) {
      for (const frame of call.keyframes) {
        const propKeys = Object.keys(frame).filter((k) => k !== 'offset' && k !== 'easing');
        for (const prop of propKeys) {
          assert.ok(prop === 'transform' || prop === 'opacity', `non-composited property: ${prop}`);
        }
        if (typeof frame.transform === 'string') {
          assert.equal(frame.transform.includes('scaleX(0)'), false);
          assert.equal(frame.transform.includes('scale(0)'), false);
        }
      }
    }

    // 清除進行中流星：三條 WAAPI 軌道皆取消且 DOM 移除
    clearActiveShootingStar();
    assert.equal(cancelledCount, 3);
    assert.equal(layer.children[0].removed, true);

    // 開啟減少動態偏好時完全停用
    reducedMotion = true;
    assert.equal(spawnShootingStar({ force: true }), false);
  } finally {
    clearActiveShootingStar();
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
});
