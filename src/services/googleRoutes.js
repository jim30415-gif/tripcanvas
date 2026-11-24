/**
 * 前端 Google Routes Proxy 客戶端（統一透過同源 /api/routes 呼叫，不接觸任何 API Key）
 */

let cachedStatus = null;
let statusPromise = null;

export async function getGoogleRoutesStatus(forceRefresh = false) {
  if (!forceRefresh && cachedStatus !== null) {
    return cachedStatus;
  }
  if (!forceRefresh && statusPromise) {
    return statusPromise;
  }

  statusPromise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch('/api/routes', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        cachedStatus = { configured: false, navitimeConfigured: false, reachable: false };
        return cachedStatus;
      }
      const data = await res.json();
      cachedStatus = {
        configured: Boolean(data?.configured),
        navitimeConfigured: Boolean(data?.navitimeConfigured),
        reachable: true,
        provider: data?.provider || 'google_routes_v2',
      };
      return cachedStatus;
    } catch {
      cachedStatus = { configured: false, navitimeConfigured: false, reachable: false };
      return cachedStatus;
    } finally {
      statusPromise = null;
    }
  })();

  return statusPromise;
}

export async function queryGoogleRoutesProxy({
  mode,
  pinA,
  pinB,
  departureTime = '',
  transitPreference = 'DEFAULT',
}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 11000);

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
    clearTimeout(timer);

    const data = await res.json().catch(() => ({}));

    if (res.status === 503 || data?.status === 'api_unconfigured') {
      cachedStatus = {
        configured: false,
        navitimeConfigured: Boolean(cachedStatus?.navitimeConfigured),
        reachable: true,
      };
      return {
        status: 'api_unconfigured',
        error: data?.error || 'API_KEY_NOT_CONFIGURED',
        message: data?.message || '尚未設定 GOOGLE_MAPS_API_KEY 環境變數',
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
        configured: Boolean(cachedStatus?.configured),
        navitimeConfigured: true,
        reachable: true,
        provider: 'google_routes_v2',
      };
    } else if (data?.status === 'ok') {
      cachedStatus = {
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
  }
}
