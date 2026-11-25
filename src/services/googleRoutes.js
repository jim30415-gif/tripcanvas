/**
 * 前端 Google Routes Proxy 客戶端（統一透過同源 /api/routes 呼叫，不接觸任何伺服器端 API Key）
 * 與 googleEngine.js 共用同一份 /api/routes 狀態快取，避免啟動時重複打兩次 API。
 */

const UNREACHABLE_TTL_MS = 20_000;

let cachedStatus = null;
let unreachableExpiresAt = 0;
let statusPromise = null;
let onlineResetBound = false;

function bindOnlineReset() {
  if (onlineResetBound || typeof window === 'undefined') return;
  onlineResetBound = true;
  window.addEventListener('online', () => {
    if (cachedStatus && !cachedStatus.reachable) {
      cachedStatus = null;
      unreachableExpiresAt = 0;
    }
  });
}

export async function getGoogleRoutesStatus(forceRefresh = false) {
  bindOnlineReset();

  if (!forceRefresh && cachedStatus !== null) {
    if (cachedStatus.reachable || Date.now() < unreachableExpiresAt) {
      return cachedStatus;
    }
  }
  if (!forceRefresh && statusPromise) {
    return statusPromise;
  }

  const currentTask = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch('/api/routes', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        cachedStatus = {
          configured: false,
          navitimeConfigured: false,
          mapsJsConfigured: false,
          mapsJsKey: '',
          reachable: false,
        };
        unreachableExpiresAt = Date.now() + UNREACHABLE_TTL_MS;
        return cachedStatus;
      }
      const data = await res.json();
      cachedStatus = {
        configured: Boolean(data?.configured),
        navitimeConfigured: Boolean(data?.navitimeConfigured),
        mapsJsConfigured: Boolean(data?.mapsJsConfigured),
        mapsJsKey: String(data?.mapsJsKey || '').trim(),
        reachable: true,
        provider: data?.provider || 'google_routes_v2',
      };
      unreachableExpiresAt = 0;
      return cachedStatus;
    } catch {
      cachedStatus = {
        configured: false,
        navitimeConfigured: false,
        mapsJsConfigured: false,
        mapsJsKey: '',
        reachable: false,
      };
      unreachableExpiresAt = Date.now() + UNREACHABLE_TTL_MS;
      return cachedStatus;
    } finally {
      clearTimeout(timer);
      if (statusPromise === currentTask) {
        statusPromise = null;
      }
    }
  })();

  statusPromise = currentTask;
  return currentTask;
}

export async function queryGoogleRoutesProxy({
  mode,
  pinA,
  pinB,
  departureTime = '',
  transitPreference = 'DEFAULT',
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 11000);
  try {
    const res = await fetch('/api/routes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        mode,
        origin: { lat: Number(pinA.lat), lng: Number(pinA.lng) },
        destination: { lat: Number(pinB.lat), lng: Number(pinB.lng) },
        departureTime: departureTime || undefined,
        transitPreference: transitPreference || 'DEFAULT',
      }),
      signal: controller.signal,
    });

    const data = await res.json().catch(() => ({}));

    // 僅在伺服器明確回傳 status === 'api_unconfigured' 時才標記未設定金鑰，避免一般 503 誤判
    if (data?.status === 'api_unconfigured') {
      cachedStatus = {
        ...(cachedStatus || {}),
        configured: false,
        navitimeConfigured: Boolean(cachedStatus?.navitimeConfigured),
        reachable: true,
      };
      return {
        status: 'api_unconfigured',
        error: data?.error || 'API_KEY_NOT_CONFIGURED',
        message: data?.message || '路線服務目前未啟用，已改用備援方案',
      };
    }

    if (!res.ok) {
      return {
        status: data?.status || 'network_error',
        provider: data?.provider,
        region: data?.region,
        error: data?.error || `HTTP_${res.status}`,
        message: data?.message || '無法連線至路線代理服務',
      };
    }

    if (data?.provider === 'navitime') {
      cachedStatus = {
        ...(cachedStatus || {}),
        configured: Boolean(cachedStatus?.configured),
        navitimeConfigured: true,
        reachable: true,
        provider: 'google_routes_v2',
      };
    } else if (data?.status === 'ok') {
      cachedStatus = {
        ...(cachedStatus || {}),
        configured: true,
        navitimeConfigured: Boolean(cachedStatus?.navitimeConfigured),
        reachable: true,
        provider: 'google_routes_v2',
      };
    }
    return data;
  } catch (err) {
    return {
      status: 'network_error',
      error: err?.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_ERROR',
      message: '路線服務連線逾時或網路異常',
    };
  } finally {
    clearTimeout(timer);
  }
}
