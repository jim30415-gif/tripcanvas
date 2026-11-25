import { TRANSPORT_MODES } from '../config/constants.js';

export function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.min(
    1,
    Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2
  );
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

export function buildGoogleMapsPlaceUrl(pin) {
  if (!pin || pin.lat == null || pin.lng == null) {
    return 'https://www.google.com/maps';
  }
  const coords = `${Number(pin.lat).toFixed(6)},${Number(pin.lng).toFixed(6)}`;
  const cleanName = (pin.name || '').trim();
  const hasRealName = cleanName && !/^自訂景點\s*\d*$/.test(cleanName);
  if (pin.placeId && hasRealName) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cleanName)}&query_place_id=${encodeURIComponent(pin.placeId)}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coords)}`;
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

export function isJapanCoord(pt) {
  if (!pt) return false;
  const lat = Number(pt.lat);
  const lng = Number(pt.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  if (lat >= 30.0 && lat <= 45.65 && lng >= 129.4 && lng <= 145.9) return true;
  if (lat >= 31.0 && lat <= 34.0 && lng >= 128.55 && lng < 129.4) return true;
  if (lat >= 24.0 && lat < 30.0 && lng >= 122.8 && lng <= 131.5) return true;
  return false;
}

export function isJapanTrip(pinA, pinB) {
  return isJapanCoord(pinA) && isJapanCoord(pinB);
}

export const NAVITIME_JP_WEB_URL = 'https://japantravel.navitime.com/zh-tw/area/jp/route/';

const COUNTRY_META = {
  TW: { code: 'TW', nameZh: '台灣', flag: '🇹🇼' },
  JP: { code: 'JP', nameZh: '日本', flag: '🇯🇵' },
  KR: { code: 'KR', nameZh: '韓國', flag: '🇰🇷' },
  HK: { code: 'HK', nameZh: '香港', flag: '🇭🇰' },
  MO: { code: 'MO', nameZh: '澳門', flag: '🇲🇴' },
  CN: { code: 'CN', nameZh: '中國大陸', flag: '🇨🇳' },
  TH: { code: 'TH', nameZh: '泰國', flag: '🇹🇭' },
  VN: { code: 'VN', nameZh: '越南', flag: '🇻🇳' },
  SG: { code: 'SG', nameZh: '新加坡', flag: '🇸🇬' },
  MY: { code: 'MY', nameZh: '馬來西亞', flag: '🇲🇾' },
  PH: { code: 'PH', nameZh: '菲律賓', flag: '🇵🇭' },
  ID: { code: 'ID', nameZh: '印尼', flag: '🇮🇩' },
  AU: { code: 'AU', nameZh: '澳洲', flag: '🇦🇺' },
  NZ: { code: 'NZ', nameZh: '紐西蘭', flag: '🇳🇿' },
  US: { code: 'US', nameZh: '美國', flag: '🇺🇸' },
  CA: { code: 'CA', nameZh: '加拿大', flag: '🇨🇦' },
  GB: { code: 'GB', nameZh: '英國', flag: '🇬🇧' },
  FR: { code: 'FR', nameZh: '法國', flag: '🇫🇷' },
  DE: { code: 'DE', nameZh: '德國', flag: '🇩🇪' },
  IT: { code: 'IT', nameZh: '義大利', flag: '🇮🇹' },
  ES: { code: 'ES', nameZh: '西班牙', flag: '🇪🇸' },
  CH: { code: 'CH', nameZh: '瑞士', flag: '🇨🇭' },
  NL: { code: 'NL', nameZh: '荷蘭', flag: '🇳🇱' },
  AT: { code: 'AT', nameZh: '奧地利', flag: '🇦🇹' },
};

export function getCountryDisplayMeta(code) {
  const upper = String(code || '').trim().toUpperCase();
  if (!upper) return { code: '', nameZh: '', flag: '🌐' };
  return COUNTRY_META[upper] || { code: upper, nameZh: upper, flag: '🌐' };
}

/**
 * 依據座標即時推斷 ISO-2 國家代碼（零網路延遲，供搜尋優先排序「本計畫已標點國家」使用）
 */
export function inferCountryCodeFromCoord(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return '';

  // 優先檢查範圍較精確的熱門島嶼／城市區域，避免被大陸邊界框覆蓋
  if (la >= 21.85 && la <= 26.45 && lo >= 118.15 && lo <= 122.15) return 'TW';
  if (isJapanCoord({ lat: la, lng: lo })) return 'JP';
  if (la >= 22.12 && la <= 22.57 && lo >= 113.82 && lo <= 114.45) return 'HK';
  if (la >= 22.1 && la <= 22.22 && lo >= 113.52 && lo <= 113.61) return 'MO';
  if (la >= 1.15 && la <= 1.48 && lo >= 103.6 && lo <= 104.06) return 'SG';
  if (la >= 33.1 && la <= 38.65 && lo >= 124.5 && lo <= 131.0) return 'KR';

  if (la >= 5.6 && la <= 20.5 && lo >= 97.3 && lo <= 105.65) return 'TH';
  if (la >= 8.4 && la <= 23.4 && lo >= 102.1 && lo <= 109.5) return 'VN';
  if (la >= 0.85 && la <= 7.4 && lo >= 99.6 && lo <= 119.3) return 'MY';
  if (la >= 4.5 && la <= 21.2 && lo >= 116.9 && lo <= 126.7) return 'PH';
  if (la >= -11.0 && la <= 5.9 && lo >= 95.0 && lo <= 141.0) return 'ID';
  if (la >= 18.0 && la <= 53.6 && lo >= 73.5 && lo <= 135.1) return 'CN';

  if (la >= -44.0 && la <= -10.0 && lo >= 112.9 && lo <= 154.0) return 'AU';
  if (la >= -47.5 && la <= -34.0 && lo >= 166.0 && lo <= 179.0) return 'NZ';

  if (la >= 49.8 && la <= 60.9 && lo >= -8.6 && lo <= 1.8) return 'GB';
  if (la >= 45.8 && la <= 47.9 && lo >= 5.9 && lo <= 10.6) return 'CH';
  if (la >= 50.7 && la <= 53.6 && lo >= 3.3 && lo <= 7.25) return 'NL';
  // 法國東部亞爾薩斯／洛林（史特拉斯堡、科爾馬、南錫）先於德國判定
  if (la >= 47.4 && la <= 49.1 && lo >= 5.8 && lo <= 7.8) return 'FR';
  // 德國巴伐利亞南部（慕尼黑、奧格斯堡、烏爾姆）先於奧地利判定
  if (la >= 47.65 && la <= 49.1 && lo >= 9.6 && lo <= 12.8) return 'DE';
  if (la >= 46.3 && la <= 49.05 && lo >= 9.5 && lo <= 17.2) return 'AT';
  if (la >= 47.2 && la <= 55.1 && lo >= 5.8 && lo <= 15.1) return 'DE';
  if (la >= 36.6 && la <= 47.1 && lo >= 6.6 && lo <= 18.6) return 'IT';
  if (la >= 41.3 && la <= 51.1 && lo >= -5.2 && lo <= 9.6) return 'FR';
  if (la >= 35.9 && la <= 43.8 && lo >= -9.3 && lo <= 4.35) return 'ES';

  // 加拿大南部主要都會區（溫哥華／維多利亞、多倫多／渥太華／蒙特婁／魁北克市）先於美國判定
  if (la >= 48.3 && la <= 50.5 && lo >= -125.0 && lo <= -122.0) return 'CA';
  if (la >= 43.2 && la <= 47.5 && lo >= -81.8 && lo <= -70.5) return 'CA';
  if (la >= 24.4 && la <= 49.0 && lo >= -125.0 && lo <= -66.9) return 'US';
  if (la >= 18.9 && la <= 22.3 && lo >= -160.3 && lo <= -154.8) return 'US'; // 夏威夷
  if (la >= 41.7 && la <= 83.1 && lo >= -141.0 && lo <= -52.6) return 'CA';

  return '';
}

/**
 * 分析目前旅遊計畫中已標點的國家分佈與中心點（按出現次數由多到少排列）
 */
export function inferTripCountryProfile(state) {
  const days = Array.isArray(state?.days) ? state.days : [];
  const counts = new Map();
  let sumLat = 0;
  let sumLng = 0;
  let totalPins = 0;

  let activeLat = 0;
  let activeLng = 0;
  let activeCount = 0;

  days.forEach((day) => {
    const isActive = day.id === state?.activeDayId;
    (day.pins || []).forEach((pin) => {
      const lat = Number(pin?.lat);
      const lng = Number(pin?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const cc = (pin.countryCode || inferCountryCodeFromCoord(lat, lng) || '').toUpperCase();
      if (cc) {
        counts.set(cc, (counts.get(cc) || 0) + (isActive ? 1.5 : 1));
      }
      sumLat += lat;
      sumLng += lng;
      totalPins += 1;
      if (isActive) {
        activeLat += lat;
        activeLng += lng;
        activeCount += 1;
      }
    });
  });

  const countryCodes = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([code]) => code);

  const focusCenter =
    activeCount > 0
      ? { lat: activeLat / activeCount, lng: activeLng / activeCount }
      : totalPins > 0
        ? { lat: sumLat / totalPins, lng: sumLng / totalPins }
        : null;

  return {
    countryCodes,
    primaryCountry: countryCodes[0] || '',
    focusCenter,
    totalPins,
  };
}


