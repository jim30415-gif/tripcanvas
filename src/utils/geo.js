import { TRANSPORT_MODES } from '../config/constants.js';

export function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* 柔和弧線僅用於「手動紀錄大眾運輸（尚未透過 Google Routes 實查）」或「不支援陸路提示」 */
export function generateCurvedPath(lat1, lng1, lat2, lng2, steps = 24) {
  const midLat = (lat1 + lat2) / 2;
  const midLng = (lng1 + lng2) / 2;
  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const curvature = 0.14;
  const ctrlLat = midLat - dLng * curvature;
  const ctrlLng = midLng + dLat * curvature;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lat = (1 - t) * (1 - t) * lat1 + 2 * (1 - t) * t * ctrlLat + t * t * lat2;
    const lng = (1 - t) * (1 - t) * lng1 + 2 * (1 - t) * t * ctrlLng + t * t * lng2;
    pts.push([lat, lng]);
  }
  return pts;
}

export function buildGoogleMapsDirUrl(pinA, pinB, mode) {
  const travelmode = TRANSPORT_MODES[mode]?.gmapsMode || 'transit';
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(pinA.lat + ',' + pinA.lng)}&destination=${encodeURIComponent(pinB.lat + ',' + pinB.lng)}&travelmode=${travelmode}`;
}

export function makeRouteCacheKey(mode, pinA, pinB, extra = {}) {
  const base = `${mode}|${Number(pinA.lat).toFixed(5)},${Number(pinA.lng).toFixed(5)}|${Number(pinB.lat).toFixed(5)},${Number(pinB.lng).toFixed(5)}`;
  if (mode === 'transit') {
    const dep = extra.departureTime || 'now';
    const pref = extra.transitPreference || 'DEFAULT';
    return `${base}|${pref}|${dep}`;
  }
  return base;
}
