import { TRANSPORT_MODES } from '../config/constants.js';
import { calcDistanceKm } from '../utils/geo.js';
import { encodePolyline } from './polyline.js';

/**
 * 免費陸路備援引擎：使用正確依交通方式分流的 FOSSGIS OSRM 實例
 * （routed-car / routed-bike / routed-foot），並以低並發排隊避免觸發限流。
 */

const MAX_CONCURRENCY = 2;
const MIN_GAP_MS = 160;
let activeCount = 0;
let lastStartTime = 0;
let drainTimer = null;
let scooterExcludeSupported = true;
const queue = [];

function enqueueRequest(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  if (activeCount >= MAX_CONCURRENCY || queue.length === 0) return;

  const waitMs = Math.max(0, MIN_GAP_MS - (Date.now() - lastStartTime));
  if (waitMs > 0) {
    if (!drainTimer) {
      drainTimer = setTimeout(() => {
        drainTimer = null;
        drainQueue();
      }, waitMs);
    }
    return;
  }

  const task = queue.shift();
  activeCount++;
  lastStartTime = Date.now();

  Promise.resolve()
    .then(() => task.fn())
    .then(task.resolve, task.reject)
    .finally(() => {
      activeCount--;
      drainQueue();
    });
}

function extractRoadCoordsFromOSRM(route) {
  const steps = route?.legs?.[0]?.steps;
  if (Array.isArray(steps) && steps.length > 0) {
    const merged = [];
    for (const step of steps) {
      const raw = step?.geometry?.coordinates;
      if (!Array.isArray(raw)) continue;
      for (const [lng, lat] of raw) {
        if (merged.length > 0) {
          const last = merged[merged.length - 1];
          if (Math.abs(last[0] - lat) < 1e-6 && Math.abs(last[1] - lng) < 1e-6) continue;
        }
        merged.push([lat, lng]);
      }
    }
    if (merged.length >= 2) return merged;
  }

  const rawCoords = route?.geometry?.coordinates;
  if (Array.isArray(rawCoords) && rawCoords.length >= 2) {
    return rawCoords.map(([lng, lat]) => [lat, lng]);
  }
  return [];
}

function validateOSRMResponse(data, coords, pinA, pinB) {
  const route = data?.routes?.[0];
  if (!route || coords.length < 2) return false;

  const straightKm = calcDistanceKm(pinA.lat, pinA.lng, pinB.lat, pinB.lng);

  if (Array.isArray(data.waypoints) && data.waypoints.length >= 2) {
    const wpA = data.waypoints[0];
    const wpB = data.waypoints[data.waypoints.length - 1];
    const wpADistKm = wpA?.location
      ? calcDistanceKm(pinA.lat, pinA.lng, wpA.location[1], wpA.location[0])
      : 0;
    const wpBDistKm = wpB?.location
      ? calcDistanceKm(pinB.lat, pinB.lng, wpB.location[1], wpB.location[0])
      : 0;
    if ((wpA?.distance || 0) > 5000 || (wpB?.distance || 0) > 5000 || wpADistKm > 5 || wpBDistKm > 5) {
      return false;
    }
  }

  const startErrKm = calcDistanceKm(pinA.lat, pinA.lng, coords[0][0], coords[0][1]);
  const endErrKm = calcDistanceKm(
    pinB.lat,
    pinB.lng,
    coords[coords.length - 1][0],
    coords[coords.length - 1][1]
  );
  if (startErrKm > 5 || endErrKm > 5) return false;

  if (straightKm > 0.3 && (!route.distance || route.distance < 10)) return false;
  for (let i = 1; i < coords.length; i++) {
    const stepKm = calcDistanceKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    if (stepKm > 120) return false;
  }

  return true;
}

async function fetchOSRMUrl(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function queryFossgisOSRM(mode, pinA, pinB) {
  const modeMeta = TRANSPORT_MODES[mode];
  if (!modeMeta || !modeMeta.fossgisService) {
    return { status: 'unsupported', provider: 'osrm', encodedPolyline: '', distanceKm: null, durationMin: null };
  }

  return enqueueRequest(async () => {
    const coordStr = `${pinA.lng},${pinA.lat};${pinB.lng},${pinB.lat}`;
    const baseParams = 'overview=full&geometries=geojson&steps=true';

    const candidateUrls = [];
    if (mode === 'scooter') {
      if (scooterExcludeSupported) {
        candidateUrls.push({
          url: `https://routing.openstreetmap.de/${modeMeta.fossgisService}/route/v1/driving/${coordStr}?${baseParams}&exclude=motorway`,
          host: 'routing.openstreetmap.de',
          hasExclude: true,
        });
      }
      candidateUrls.push({
        url: `https://routing.openstreetmap.de/${modeMeta.fossgisService}/route/v1/driving/${coordStr}?${baseParams}`,
        host: 'routing.openstreetmap.de',
        hasExclude: false,
      });
    } else {
      candidateUrls.push({
        url: `https://routing.openstreetmap.de/${modeMeta.fossgisService}/route/v1/driving/${coordStr}?${baseParams}`,
        host: 'routing.openstreetmap.de',
        hasExclude: false,
      });
    }

    if (mode === 'car') {
      candidateUrls.push({
        url: `https://router.project-osrm.org/route/v1/driving/${coordStr}?${baseParams}`,
        host: 'router.project-osrm.org',
        hasExclude: false,
      });
    }

    let lastStatus = 'network_error';
    const rateLimitedHosts = new Set();

    for (const cand of candidateUrls) {
      if (rateLimitedHosts.has(cand.host)) continue;
      try {
        const res = await fetchOSRMUrl(cand.url);

        if (res.status === 429) {
          rateLimitedHosts.add(cand.host);
          lastStatus = 'network_error';
          continue;
        }

        if (res.status === 400) {
          if (cand.hasExclude && (res.data?.code === 'InvalidValue' || res.data?.code === 'InvalidOptions')) {
            scooterExcludeSupported = false;
            continue;
          }
          if (res.data?.code === 'NoRoute' || res.data?.code === 'NoSegment') {
            if (cand.hasExclude) continue;
            return {
              status: 'unsupported',
              provider: 'osrm',
              encodedPolyline: '',
              distanceKm: null,
              durationMin: null,
            };
          }
          lastStatus = 'unsupported';
          continue;
        }

        if (!res.ok || !res.data) {
          lastStatus = 'network_error';
          continue;
        }

        if (res.data.code !== 'Ok' || !Array.isArray(res.data.routes) || res.data.routes.length === 0) {
          if (cand.hasExclude) continue;
          return {
            status: 'unsupported',
            provider: 'osrm',
            encodedPolyline: '',
            distanceKm: null,
            durationMin: null,
          };
        }

        const route = res.data.routes[0];
        const coords = extractRoadCoordsFromOSRM(route);
        if (!validateOSRMResponse(res.data, coords, pinA, pinB)) {
          return {
            status: 'unsupported',
            provider: 'osrm',
            encodedPolyline: '',
            distanceKm: null,
            durationMin: null,
          };
        }

        const distanceKm = Number((route.distance / 1000).toFixed(2));
        let durationMin = Math.max(1, Math.round(route.duration / 60));
        if (mode === 'scooter') {
          durationMin = Math.max(1, Math.round((route.duration / 60) * 1.12));
        }

        return {
          status: 'ok',
          provider: 'osrm',
          mode,
          distanceKm,
          durationMin,
          encodedPolyline: encodePolyline(coords),
          fallbackNote: mode === 'scooter' ? '依一般道路估算（免費備援路網）' : '',
        };
      } catch {
        lastStatus = 'network_error';
      }
    }

    return {
      status: lastStatus,
      provider: 'osrm',
      encodedPolyline: '',
      distanceKm: null,
      durationMin: null,
    };
  });
}
