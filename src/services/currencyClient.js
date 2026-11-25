import { SUPPORTED_CURRENCIES } from '../config/constants.js';

const FX_CACHE_KEY = 'tripcanvas_fx_rates_twd_v1';
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ZERO_DECIMAL_CURRENCIES = new Set(['TWD', 'JPY', 'KRW', 'VND', 'IDR']);

/* 離線保底參考匯率（1 單位外幣 ≈ TWD），與伺服器端 server/currency.js 保持一致 */
const FALLBACK_TWD_PER_UNIT = {
  TWD: 1,
  JPY: 0.215,
  KRW: 0.0235,
  USD: 32.2,
  EUR: 34.8,
  GBP: 40.8,
  HKD: 4.13,
  SGD: 24.0,
  CNY: 4.46,
  THB: 0.94,
};

const CURRENCY_META = Object.fromEntries(SUPPORTED_CURRENCIES.map((c) => [c.code, c]));

let ratesState = loadCachedRates();
let fetchPromise = null;

function loadCachedRates() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(FX_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          parsed.twdPerUnit &&
          typeof parsed.expiresAt === 'number' &&
          Date.now() < parsed.expiresAt
        ) {
          return {
            twdPerUnit: { ...FALLBACK_TWD_PER_UNIT, ...parsed.twdPerUnit },
            source: parsed.source || 'fallback',
            loadedFromServer: true,
            expiresAt: parsed.expiresAt,
          };
        }
      }
    }
  } catch {
    // 忽略本機快取異常
  }
  return {
    twdPerUnit: { ...FALLBACK_TWD_PER_UNIT },
    source: 'fallback',
    loadedFromServer: false,
    expiresAt: 0,
  };
}

/**
 * 背景向同源 /api/routes?rates=1 抓取最新即時匯率（不阻斷輸入，離線自動使用參考匯率）
 */
export async function ensureFxRatesLoaded(forceRefresh = false) {
  if (!forceRefresh && ratesState.loadedFromServer && Date.now() < (ratesState.expiresAt || 0)) {
    return ratesState;
  }
  if (!forceRefresh && fetchPromise) {
    return fetchPromise;
  }

  const currentTask = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch('/api/routes?rates=1', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return ratesState;
      const data = await res.json();
      if (data?.twdPerUnit && typeof data.twdPerUnit === 'object') {
        const expiresAt = Date.now() + FX_CACHE_TTL_MS;
        ratesState = {
          twdPerUnit: { ...FALLBACK_TWD_PER_UNIT, ...data.twdPerUnit },
          source: data.source === 'live' ? 'live' : 'fallback',
          loadedFromServer: true,
          expiresAt,
        };
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(
              FX_CACHE_KEY,
              JSON.stringify({
                twdPerUnit: ratesState.twdPerUnit,
                source: ratesState.source,
                expiresAt,
              })
            );
          }
        } catch {
          // 忽略寫入失敗
        }
      }
    } catch {
      // 保留內建保底匯率
    } finally {
      clearTimeout(timer);
      if (fetchPromise === currentTask) {
        fetchPromise = null;
      }
    }
    return ratesState;
  })();

  fetchPromise = currentTask;
  return currentTask;
}

export function getCurrencyMeta(code = 'TWD') {
  return CURRENCY_META[String(code || 'TWD').toUpperCase()] || CURRENCY_META.TWD;
}

export function formatCurrencyAmount(amount, currencyCode = 'TWD') {
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) return '';
  const meta = getCurrencyMeta(currencyCode);
  const rounded = ZERO_DECIMAL_CURRENCIES.has(meta.code)
    ? Math.round(num).toLocaleString('en-US')
    : Number(num.toFixed(2)).toLocaleString('en-US', {
        minimumFractionDigits: Number.isInteger(num) ? 0 : 2,
        maximumFractionDigits: 2,
      });
  return `${meta.symbol}${rounded}`;
}

/**
 * 同步將任意外幣金額即時換算為新台幣整數（供輸入框打字當下即時預覽與存檔）
 */
export function convertToTwdSync(amount, currencyCode = 'TWD', customRates = null) {
  const code = String(currencyCode || 'TWD').toUpperCase();
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) {
    return {
      amountTwd: 0,
      originalAmount: 0,
      originalCurrency: code,
      rate: code === 'TWD' ? 1 : (customRates?.[code] ?? ratesState.twdPerUnit[code] ?? 1),
      rateSource: code === 'TWD' ? 'native' : ratesState.source,
    };
  }

  if (code === 'TWD') {
    const rounded = Math.round(num);
    return {
      amountTwd: rounded,
      originalAmount: rounded,
      originalCurrency: 'TWD',
      rate: 1,
      rateSource: 'native',
    };
  }

  const rate = Number(customRates?.[code] ?? ratesState.twdPerUnit[code] ?? FALLBACK_TWD_PER_UNIT[code] ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      amountTwd: Math.round(num),
      originalAmount: num,
      originalCurrency: code,
      rate: 1,
      rateSource: 'fallback',
    };
  }

  return {
    amountTwd: Math.max(1, Math.round(num * rate)),
    originalAmount: num,
    originalCurrency: code,
    rate,
    rateSource: customRates ? 'live' : ratesState.source,
  };
}

export function buildCurrencyOptionsHTML(selectedCode = 'TWD') {
  const target = String(selectedCode || 'TWD').toUpperCase();
  return SUPPORTED_CURRENCIES.map(
    (c) => `<option value="${c.code}" ${c.code === target ? 'selected' : ''}>${c.shortLabel}</option>`
  ).join('');
}
