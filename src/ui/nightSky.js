import { isDarkTheme } from './theme.js';

export const SHOOTING_STAR_CONFIG = Object.freeze({
  initialDelayMinMs: 14000,
  initialDelayMaxMs: 26000,
  checkIntervalMinMs: 24000,
  checkIntervalMaxMs: 42000,
  triggerProbability: 0.24,
  minCooldownMs: 55000,
  durationMinMs: 1350,
  durationMaxMs: 1850,
  easing: 'cubic-bezier(0.2, 0.45, 0.55, 0.88)',
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
 * 計算單顆流星的起點、斜落角度、尾跡長度與飛行距離（依螢幕寬度等比延伸，大螢幕更具優雅延伸感）
 */
export function computeShootingStarGeometry(viewportWidth, viewportHeight, rng = Math.random) {
  const width = Math.max(320, Number(viewportWidth) || 1280);
  const height = Math.max(320, Number(viewportHeight) || 720);
  const isCompact = width < 640;

  // 72% 由右上斜滑向左下、28% 由左上斜滑向右下，保留自然隨機感
  const rightToLeft = rng() < 0.72;
  const angleDeg = rightToLeft
    ? randomBetween(144, 158, rng)
    : randomBetween(22, 36, rng);

  // 為更長的滑行距離預留充足夜空跑道，同時橫越畫面中段可視區
  const xMin = rightToLeft ? (isCompact ? 0.62 : 0.56) : isCompact ? 0.08 : 0.16;
  const xMax = rightToLeft ? (isCompact ? 0.92 : 0.84) : isCompact ? 0.38 : 0.44;
  const startX = Math.round(width * randomBetween(xMin, xMax, rng));
  const startY = Math.round(height * randomBetween(0.06, 0.32, rng));

  const distancePx = Math.round(
    isCompact
      ? Math.min(Math.max(width * randomBetween(0.62, 0.78, rng), 240), 340)
      : Math.min(Math.max(width * randomBetween(0.36, 0.5, rng), 460), 900)
  );
  const tailLengthPx = Math.round(
    isCompact
      ? randomBetween(112, 152, rng)
      : Math.min(Math.max(width * randomBetween(0.11, 0.16, rng), 158), 255)
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

  const mover = document.createElement('div');
  mover.className = 'shooting-star-mover';
  mover.style.width = `${geo.tailLengthPx}px`;

  const tail = document.createElement('span');
  tail.className = 'shooting-star-tail';

  const head = document.createElement('span');
  head.className = 'shooting-star-head';
  head.style.transform = `translateY(-50%) rotate(${(-geo.angleDeg).toFixed(1)}deg)`;

  mover.appendChild(tail);
  mover.appendChild(head);
  track.appendChild(mover);
  layer.appendChild(track);

  let animations = [];
  let fallbackTimer = null;
  let cleaned = false;

  const cleanup = ({ markFinished = false } = {}) => {
    if (cleaned) return;
    cleaned = true;
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    for (const anim of animations) {
      try {
        anim.cancel();
      } catch {
        // ignore
      }
    }
    animations = [];
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

  if (typeof mover.animate === 'function') {
    // 1. 位移採單一雙關鍵幀連續曲線，速度全程 C∞ 滑順、絕無分段急煞頓挫
    const moveAnim = mover.animate(
      [
        { transform: 'translate3d(0px, 0px, 0)' },
        { transform: `translate3d(${geo.distancePx}px, 0px, 0)` },
      ],
      {
        duration: geo.durationMs,
        easing: SHOOTING_STAR_CONFIG.easing,
        fill: 'forwards',
      }
    );

    // 2. 亮度包絡與位移解耦，各自於合成執行緒獨立運行
    const opacityAnim = mover.animate(
      [
        { opacity: 0, offset: 0, easing: 'ease-out' },
        { opacity: geo.peakOpacity, offset: 0.16, easing: 'linear' },
        { opacity: Number((geo.peakOpacity * 0.82).toFixed(2)), offset: 0.68, easing: 'ease-in' },
        { opacity: 0, offset: 1 },
      ],
      {
        duration: geo.durationMs,
        easing: 'linear',
        fill: 'forwards',
      }
    );

    animations.push(moveAnim, opacityAnim);

    // 3. 尾跡伸縮僅作用於 tail（不壓扁星頭），0.36 處 ease-out 接 ease-in 導數連續無拉扯
    if (typeof tail.animate === 'function') {
      const tailAnim = tail.animate(
        [
          { transform: 'scaleX(0.42)', offset: 0, easing: 'ease-out' },
          { transform: 'scaleX(1)', offset: 0.36, easing: 'ease-in' },
          { transform: 'scaleX(0.32)', offset: 1 },
        ],
        {
          duration: geo.durationMs,
          easing: 'linear',
          fill: 'forwards',
        }
      );
      animations.push(tailAnim);
    }

    moveAnim.onfinish = () => cleanup({ markFinished: true });
    moveAnim.oncancel = () => cleanup({ markFinished: false });
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
