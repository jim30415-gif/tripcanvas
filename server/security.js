/**
 * 伺服器端共用安全、輸入解析、同源驗證、滑動視窗頻率限制與逾時控制工具
 * 適用於 Vercel Serverless Functions 與 Vite Dev/Preview Middleware
 */

const MAX_RATE_BUCKETS = 2000;
const rateBuckets = new Map();

export function getHeader(headers = {}, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = String(name || '').toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? String(v[0] || '') : String(v || '');
    }
  }
  return '';
}

/**
 * 嚴格解析選填數字參數：遇到 null / undefined / 空字串 / 陣列 / 布林一律回傳 NaN，
 * 徹底避免 Number(null) === 0 或 Number('') === 0 誤判為合法座標 (0, 0) 或 zoom 0。
 */
export function parseOptionalFiniteNumber(value) {
  if (value == null || typeof value === 'boolean' || Array.isArray(value)) {
    return NaN;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return NaN;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

export function isValidHostHeader(host) {
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(String(host || '').trim());
}

export function extractClientIp(headers = {}) {
  const xff = getHeader(headers, 'x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  const realIp = getHeader(headers, 'x-real-ip').trim();
  if (realIp) return realIp.slice(0, 64);
  return 'local';
}

export function isJsonContentType(headers = {}) {
  const ct = getHeader(headers, 'content-type').toLowerCase();
  return ct.includes('application/json');
}

function collectAllowedHosts(headers = {}, env = {}) {
  const hosts = new Set();
  const addHost = (raw) => {
    const clean = String(raw || '').trim().toLowerCase();
    if (!clean) return;
    try {
      const h = clean.includes('://') ? new URL(clean).host.toLowerCase() : clean.split('/')[0];
      if (isValidHostHeader(h)) hosts.add(h);
    } catch {
      // ignore invalid entry
    }
  };

  addHost(getHeader(headers, 'x-forwarded-host').split(',')[0]);
  addHost(getHeader(headers, 'host').split(',')[0]);
  addHost(env?.VERCEL_URL);
  addHost(env?.VERCEL_BRANCH_URL);
  addHost(env?.VERCEL_PROJECT_PRODUCTION_URL);

  const extra = String(env?.ALLOWED_ORIGINS || '').trim();
  if (extra) {
    extra.split(',').forEach((entry) => addHost(entry));
  }
  return hosts;
}

/**
 * 檢查請求是否來自同源頁面（防跨站盜刷付費 API 與 CSRF 寫入）：
 * 1. 若帶 Sec-Fetch-Site，必須為 same-origin
 * 2. 若帶 Origin 或 Referer，其主機必須符合目前部署網域或 ALLOWED_ORIGINS
 * 3. 在正式 Vercel 環境對計費／寫入端點要求至少具備同源標頭訊號（阻擋跨站與無標頭爬蟲）
 */
export function checkSameOriginRequest(headers = {}, env = {}, { requireBrowserSignal = false } = {}) {
  const secFetchSite = getHeader(headers, 'sec-fetch-site').trim().toLowerCase();
  if (secFetchSite && secFetchSite !== 'same-origin') {
    return {
      ok: false,
      statusCode: 403,
      body: { status: 'forbidden', error: 'FORBIDDEN_ORIGIN', message: '僅允許同源網站存取此服務' },
    };
  }

  const allowedHosts = collectAllowedHosts(headers, env);
  const originHeader = getHeader(headers, 'origin').trim();
  const refererHeader = getHeader(headers, 'referer').trim();
  let verifiedHostSignal = secFetchSite === 'same-origin';

  if (originHeader) {
    if (originHeader === 'null') {
      return {
        ok: false,
        statusCode: 403,
        body: { status: 'forbidden', error: 'FORBIDDEN_ORIGIN', message: '不允許的來源網域' },
      };
    }
    try {
      const originHost = new URL(originHeader).host.toLowerCase();
      if (!allowedHosts.has(originHost)) {
        return {
          ok: false,
          statusCode: 403,
          body: { status: 'forbidden', error: 'FORBIDDEN_ORIGIN', message: '僅允許同源網站存取此服務' },
        };
      }
      verifiedHostSignal = true;
    } catch {
      return {
        ok: false,
        statusCode: 403,
        body: { status: 'forbidden', error: 'FORBIDDEN_ORIGIN', message: '無效的來源標頭' },
      };
    }
  } else if (refererHeader) {
    try {
      const refHost = new URL(refererHeader).host.toLowerCase();
      if (!allowedHosts.has(refHost)) {
        return {
          ok: false,
          statusCode: 403,
          body: { status: 'forbidden', error: 'FORBIDDEN_ORIGIN', message: '僅允許同源網站存取此服務' },
        };
      }
      verifiedHostSignal = true;
    } catch {
      return {
        ok: false,
        statusCode: 403,
        body: { status: 'forbidden', error: 'FORBIDDEN_ORIGIN', message: '無效的參照來源標頭' },
      };
    }
  }

  const isProdRuntime = env?.VERCEL === '1' || env?.NODE_ENV === 'production';
  if (requireBrowserSignal && isProdRuntime && !verifiedHostSignal) {
    return {
      ok: false,
      statusCode: 403,
      body: { status: 'forbidden', error: 'MISSING_ORIGIN', message: '請透過漫旅網頁存取此服務' },
    };
  }

  return { ok: true };
}

/**
 * 記憶體上限有界的滑動視窗頻率限制（單一 Serverless 實例防短時間刷量）
 */
export function checkRateLimit(bucket, ip, maxRequests, windowMs = 60_000, now = Date.now()) {
  const key = `${bucket}:${ip || 'local'}`;
  const cutoff = now - windowMs;

  if (rateBuckets.size >= MAX_RATE_BUCKETS && !rateBuckets.has(key)) {
    // 優先清除過期或最舊的紀錄，維持記憶體有界
    for (const [k, stamps] of rateBuckets.entries()) {
      const fresh = stamps.filter((t) => t > cutoff);
      if (fresh.length === 0) rateBuckets.delete(k);
      else rateBuckets.set(k, fresh);
      if (rateBuckets.size < MAX_RATE_BUCKETS) break;
    }
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      const oldestKey = rateBuckets.keys().next().value;
      if (oldestKey) rateBuckets.delete(oldestKey);
    }
  }

  const prev = rateBuckets.get(key) || [];
  const active = prev.filter((t) => t > cutoff);
  if (active.length >= maxRequests) {
    const retryAfterSec = Math.max(1, Math.ceil((active[0] + windowMs - now) / 1000));
    rateBuckets.set(key, active);
    return {
      allowed: false,
      retryAfterSec,
      statusCode: 429,
      body: {
        status: 'rate_limited',
        error: 'RATE_LIMITED',
        message: '操作頻率過高，請稍候片刻再試。',
      },
    };
  }

  active.push(now);
  rateBuckets.set(key, active);
  return { allowed: true, remaining: maxRequests - active.length };
}

export function resetRateLimitsForTests() {
  rateBuckets.clear();
}

/**
 * 帶逾時與 finally 釋放的 fetch 包裝器（涵蓋回應 body 讀取階段）
 */
export async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 8000) {
  const fn = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fn(url, {
      ...options,
      signal: controller.signal,
    });
    return {
      res,
      clear: () => clearTimeout(timer),
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function fetchJsonWithTimeout(fetchImpl, url, options = {}, timeoutMs = 8000) {
  const { res, clear } = await fetchWithTimeout(fetchImpl, url, options, timeoutMs);
  try {
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { res, data };
  } finally {
    clear();
  }
}

export async function fetchTextWithTimeout(fetchImpl, url, options = {}, timeoutMs = 8000) {
  const { res, clear } = await fetchWithTimeout(fetchImpl, url, options, timeoutMs);
  try {
    const text = await res.text();
    return { res, text };
  } finally {
    clear();
  }
}
