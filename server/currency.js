/**
 * 伺服器端匯率換算模組（將 Google Routes API 回傳的外幣大眾運輸票價自動換算為新台幣 TWD）
 * - 優先讀取 open.er-api.com 每日公開匯率並於記憶體快取 12 小時
 * - 若外部匯率服務暫時無法連線，自動使用內建參考匯率表保底，絕不阻斷路線查詢
 */

const FX_API_URL = 'https://open.er-api.com/v6/latest/TWD';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/* 參考匯率表：1 單位外幣約等於多少新台幣 (TWD)，作為離線或逾時保底 */
export const FALLBACK_TWD_PER_UNIT = {
  TWD: 1,
  JPY: 0.215,
  KRW: 0.0235,
  USD: 32.2,
  EUR: 34.8,
  GBP: 40.8,
  HKD: 4.13,
  MOP: 4.01,
  SGD: 24.0,
  CNY: 4.46,
  THB: 0.94,
  MYR: 7.25,
  VND: 0.00127,
  PHP: 0.55,
  IDR: 0.00202,
  AUD: 21.1,
  NZD: 19.2,
  CAD: 23.2,
  CHF: 36.6,
  INR: 0.382,
  SEK: 3.02,
  NOK: 2.94,
  DKK: 4.66,
  CZK: 1.38,
  PLN: 8.05,
  TRY: 0.94,
};

let cachedRatesFromTwd = null;
let cacheExpiresAt = 0;
let cacheUpdatedAtIso = null;
let failureCooldownUntil = 0;
let inFlightFxPromise = null;

async function fetchLiveRatesFromTwd() {
  const now = Date.now();
  if (cachedRatesFromTwd && now < cacheExpiresAt) {
    return cachedRatesFromTwd;
  }
  if (now < failureCooldownUntil) {
    return cachedRatesFromTwd;
  }
  if (inFlightFxPromise) return inFlightFxPromise;

  inFlightFxPromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(FX_API_URL, { signal: controller.signal });
      if (!res.ok) {
        failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
        return cachedRatesFromTwd;
      }
      const data = await res.json();
      if (data?.result === 'success' && data?.rates && typeof data.rates === 'object') {
        cachedRatesFromTwd = data.rates;
        cacheExpiresAt = Date.now() + CACHE_TTL_MS;
        cacheUpdatedAtIso = new Date().toISOString();
        failureCooldownUntil = 0;
        return cachedRatesFromTwd;
      }
      failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      return cachedRatesFromTwd;
    } catch {
      failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      return cachedRatesFromTwd;
    } finally {
      clearTimeout(timer);
      inFlightFxPromise = null;
    }
  })();

  return inFlightFxPromise;
}

/**
 * 解析 Google Money 物件 ({ currencyCode, units, nanos }) 並換算為新台幣整數
 * @param {{ currencyCode?: string, units?: string|number, nanos?: number } | null} moneyObj
 * @param {string} localizedText
 */
export async function convertMoneyToTwd(moneyObj, localizedText = '') {
  if (!moneyObj || typeof moneyObj !== 'object') return null;

  const currencyCode = String(moneyObj.currencyCode || '').trim().toUpperCase();
  const units = Number(moneyObj.units || 0);
  const nanos = Number(moneyObj.nanos || 0);
  const originalAmount = units + nanos / 1e9;

  if (!currencyCode || !Number.isFinite(originalAmount) || originalAmount <= 0) {
    return null;
  }

  const roundedOriginal = Number(originalAmount.toFixed(originalAmount >= 100 ? 0 : 2));

  if (currencyCode === 'TWD') {
    const amountTwd = Math.max(1, Math.round(originalAmount));
    return {
      amountTwd,
      originalAmount: roundedOriginal,
      originalCurrency: 'TWD',
      originalText: localizedText || `NT$ ${amountTwd}`,
      exchangeRate: 1,
      rateSource: 'native',
    };
  }

  // 外幣自動換算新台幣
  let twdPerUnit = null;
  let rateSource = 'fallback';

  const liveRates = await fetchLiveRatesFromTwd();
  if (liveRates && Number(liveRates[currencyCode]) > 0) {
    // open.er-api.com/v6/latest/TWD 回傳的是「1 TWD 可換多少外幣」，故反算 1 外幣 = 1 / rate TWD
    twdPerUnit = 1 / Number(liveRates[currencyCode]);
    rateSource = 'live';
  } else if (FALLBACK_TWD_PER_UNIT[currencyCode]) {
    twdPerUnit = FALLBACK_TWD_PER_UNIT[currencyCode];
    rateSource = 'fallback';
  }

  if (!twdPerUnit || !Number.isFinite(twdPerUnit)) {
    return null;
  }

  const amountTwd = Math.max(1, Math.round(originalAmount * twdPerUnit));
  return {
    amountTwd,
    originalAmount: roundedOriginal,
    originalCurrency: currencyCode,
    originalText: localizedText || `${currencyCode} ${roundedOriginal}`,
    exchangeRate: Number(twdPerUnit.toFixed(4)),
    rateSource,
  };
}

/**
 * 提供前端手動填寫外幣支出用的即時／保底匯率表（每 1 單位外幣可換算的新台幣）
 */
export async function getTwdRatesSummary() {
  const liveRates = await fetchLiveRatesFromTwd();
  const twdPerUnit = { ...FALLBACK_TWD_PER_UNIT };
  let source = 'fallback';

  if (liveRates && typeof liveRates === 'object') {
    source = 'live';
    for (const code of Object.keys(FALLBACK_TWD_PER_UNIT)) {
      if (code === 'TWD') {
        twdPerUnit.TWD = 1;
        continue;
      }
      const perTwd = Number(liveRates[code]);
      if (Number.isFinite(perTwd) && perTwd > 0) {
        twdPerUnit[code] = Number((1 / perTwd).toFixed(6));
      }
    }
  }

  return {
    base: 'TWD',
    source,
    twdPerUnit,
    updatedAt: source === 'live' && cacheUpdatedAtIso ? cacheUpdatedAtIso : new Date().toISOString(),
  };
}

