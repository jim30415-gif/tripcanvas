import { isDarkTheme } from './theme.js';

export const SHOOTING_STAR_CONFIG = Object.freeze({
  initialDelayMinMs: 14000,
  initialDelayMaxMs: 26000,
  checkIntervalMinMs: 24000,
  checkIntervalMaxMs: 42000,
  triggerProbability: 0.24,
  minCooldownMs: 55000,
  durationMinMs: 880,
  durationMaxMs: 1220,
  easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
});

let schedulerTimer = null;
let activeMeteorCleanup = null;
let lastMeteorEndedAt = 0;
let initialized = false;

function randomBetween(min, max, rng = Math.random) {
  return min + rng() * (max - min);
}

export function prefersReducedMotion() {
  try {
    return Boolean(
      typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

/**
 * 計算單顆流星的起點、斜落角度、尾跡長度與飛行距離（確保落於可視夜空區，不貼邊或過長）
 */
export function computeShootingStarGeometry(viewportWidth, viewportHeight, rng = Math.random) {
  const width = Math.max(320, Number(viewportWidth) || 1280);
  const height = Math.max(320, Number(viewportHeight) || 720);
  const isCompact = width < 640;

  // 72% 由右上斜滑向左下、28% 由左上斜滑向右下，保留自然隨機感
  const rightToLeft = rng() < 0.72;
  const angleDeg = rightToLeft
    ? randomBetween(142, 158, rng)
    : randomBetween(22, 38, rng);

  // 桌機避讓兩側浮動側欄中心區域，手機於中上夜空劃過
  const xMin = rightToLeft ? (isCompact ? 0.45 : 0.42) : isCompact ? 0.08 : 0.22;
  const xMax = rightToLeft ? (isCompact ? 0.92 : 0.78) : isCompact ? 0.55 : 0.58;
  const startX = Math.round(width * randomBetween(xMin, xMax, rng));
  const startY = Math.round(height * randomBetween(0.07, 0.38, rng));

  const distancePx = Math.round(
    isCompact
      ? randomBetween(165, 250, rng)
      : randomBetween(230, 360, rng)
  );
  const tailLengthPx = Math.round(
    isCompact
      ? randomBetween(76, 108, rng)
      : randomBetween(96, 142, rng)
  );
  const durationMs = Math.round(
    randomBetween(SHOOTING_STAR_CONFIG.durationMinMs, SHOOTING_STAR_CONFIG.durationMaxMs, rng)
  );
  const peakOpacity = Number(randomBetween(0.84, 0.96, rng).toFixed(2));

  return {
    startX,
    startY,
    angleDeg: Number(angleDeg.toFixed(1)),
    distancePx,
    tailLengthPx,
    durationMs,
    peakOpacity,
  };
}

function clearSchedulerTimer() {
  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

export function clearActiveShootingStar() {
  if (typeof activeMeteorCleanup === 'function') {
    const fn = activeMeteorCleanup;
    activeMeteorCleanup = null;
    fn();
  }
}

function canRunAmbientSky() {
  if (typeof document === 'undefined') return false;
  if (!isDarkTheme()) return false;
  if (document.visibilityState && document.visibilityState !== 'visible') return false;
  if (prefersReducedMotion()) return false;
  return true;
}

/**
 * 於夜空圖層發射一顆 GPU 合成流星（僅動畫化 transform 與 opacity，結束即銷毀 DOM 零殘留）
 */
export function spawnShootingStar({ container = null, force = false, rng = Math.random } = {}) {
  if (typeof document === 'undefined') return false;
  if (prefersReducedMotion()) return false;
  if (!force && !canRunAmbientSky()) return false;

  const layer = container || document.getElementById('night-sky-easter-egg');
  if (!layer || typeof layer.appendChild !== 'function') return false;

  clearActiveShootingStar();

  const rect =
    typeof layer.getBoundingClientRect === 'function'
      ? layer.getBoundingClientRect()
      : { width: window?.innerWidth || 1280, height: window?.innerHeight || 720 };
  const geo = computeShootingStarGeometry(
    rect.width || window?.innerWidth || 1280,
    rect.height || window?.innerHeight || 720,
    rng
  );

  const track = document.createElement('div');
  track.className = 'shooting-star-track';
  track.style.transform = `translate3d(${geo.startX}px, ${geo.startY}px, 0) rotate(${geo.angleDeg}deg)`;

  const streak = document.createElement('span');
  streak.className = 'shooting-star-streak';
  streak.style.width = `${geo.tailLengthPx}px`;

  track.appendChild(streak);
  layer.appendChild(track);

  let animation = null;
  let fallbackTimer = null;
  let cleaned = false;

  const cleanup = ({ markFinished = false } = {}) => {
    if (cleaned) return;
    cleaned = true;
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (animation) {
      try {
        animation.cancel();
      } catch {
        // ignore
      }
      animation = null;
    }
    track.remove();
    if (markFinished) {
      lastMeteorEndedAt = Date.now();
    }
    if (activeMeteorCleanup === cancelCleanup) {
      activeMeteorCleanup = null;
    }
  };

  const cancelCleanup = () => cleanup({ markFinished: false });
  activeMeteorCleanup = cancelCleanup;

  if (typeof streak.animate === 'function') {
    animation = streak.animate(
      [
        {
          opacity: 0,
          transform: 'translate3d(0px, 0px, 0) scaleX(0.38)',
          offset: 0,
          easing: SHOOTING_STAR_CONFIG.easing,
        },
        {
          opacity: geo.peakOpacity,
          transform: `translate3d(${Math.round(geo.distancePx * 0.32)}px, 0px, 0) scaleX(1)`,
          offset: 0.22,
          easing: SHOOTING_STAR_CONFIG.easing,
        },
        {
          opacity: Number((geo.peakOpacity * 0.78).toFixed(2)),
          transform: `translate3d(${Math.round(geo.distancePx * 0.82)}px, 0px, 0) scaleX(0.88)`,
          offset: 0.72,
          easing: 'ease-out',
        },
        {
          opacity: 0,
          transform: `translate3d(${geo.distancePx}px, 0px, 0) scaleX(0.42)`,
          offset: 1,
        },
      ],
      {
        duration: geo.durationMs,
        easing: 'linear',
        fill: 'forwards',
      }
    );
    animation.onfinish = () => cleanup({ markFinished: true });
    animation.oncancel = () => cleanup({ markFinished: false });
  } else {
    fallbackTimer = setTimeout(() => cleanup({ markFinished: true }), geo.durationMs);
  }

  return true;
}

function scheduleNextCheck(isInitial = false) {
  clearSchedulerTimer();
  if (!canRunAmbientSky()) return;

  const minMs = isInitial
    ? SHOOTING_STAR_CONFIG.initialDelayMinMs
    : SHOOTING_STAR_CONFIG.checkIntervalMinMs;
  const maxMs = isInitial
    ? SHOOTING_STAR_CONFIG.initialDelayMaxMs
    : SHOOTING_STAR_CONFIG.checkIntervalMaxMs;
  const delayMs = Math.round(randomBetween(minMs, maxMs));

  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;
    if (!canRunAmbientSky()) return;

    const now = Date.now();
    const cooldownReady = now - lastMeteorEndedAt >= SHOOTING_STAR_CONFIG.minCooldownMs;
    if (cooldownReady && !activeMeteorCleanup && Math.random() < SHOOTING_STAR_CONFIG.triggerProbability) {
      spawnShootingStar();
    }
    scheduleNextCheck(false);
  }, delayMs);
}

export function syncNightSkyActive(dark = isDarkTheme()) {
  if (!dark || prefersReducedMotion()) {
    clearSchedulerTimer();
    clearActiveShootingStar();
    return;
  }
  if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') {
    clearSchedulerTimer();
    clearActiveShootingStar();
    return;
  }
  if (schedulerTimer === null) {
    scheduleNextCheck(true);
  }
}

export function initNightSky() {
  if (!initialized && typeof document !== 'undefined') {
    initialized = true;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        syncNightSkyActive(isDarkTheme());
      } else {
        clearSchedulerTimer();
        clearActiveShootingStar();
      }
    });

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const onReducedChange = () => syncNightSkyActive(isDarkTheme());
      if (typeof reducedMq.addEventListener === 'function') {
        reducedMq.addEventListener('change', onReducedChange);
      } else if (typeof reducedMq.addListener === 'function') {
        reducedMq.addListener(onReducedChange);
      }
    }
  }

  syncNightSkyActive(isDarkTheme());
}
