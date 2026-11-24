/**
 * Google Encoded Polyline Algorithm Format (precision 1e5) 解碼、編碼與座標串接工具
 * 前後端（Node Proxy 與瀏覽器）共用此純函式模組。
 */

/**
 * 將 Google Encoded Polyline 字串解碼為 [[lat, lng], ...] 座標陣列
 * @param {string} encoded
 * @returns {Array<[number, number]>}
 */
export function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];

  const coords = [];
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;

  while (index < len) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      if (index >= len) return coords;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    shift = 0;
    result = 0;
    do {
      if (index >= len) return coords;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    coords.push([lat / 1e5, lng / 1e5]);
  }

  return coords;
}

function encodeSignedNumber(num) {
  let sgnNum = num << 1;
  if (num < 0) {
    sgnNum = ~sgnNum;
  }
  let encoded = '';
  while (sgnNum >= 0x20) {
    encoded += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  encoded += String.fromCharCode(sgnNum + 63);
  return encoded;
}

/**
 * 將 [[lat, lng], ...] 座標陣列編碼為精簡的 Google Encoded Polyline 字串
 * @param {Array<[number, number]>} coords
 * @returns {string}
 */
export function encodePolyline(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return '';

  let prevLat = 0;
  let prevLng = 0;
  let result = '';

  for (let i = 0; i < coords.length; i++) {
    const pt = coords[i];
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const lat = Math.round(pt[0] * 1e5);
    const lng = Math.round(pt[1] * 1e5);
    result += encodeSignedNumber(lat - prevLat);
    result += encodeSignedNumber(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }

  return result;
}

/**
 * 將多段 encoded polyline 依序解碼並無縫拼接（自動去除相鄰重複交界點）
 * @param {string[]} encodedList
 * @returns {Array<[number, number]>}
 */
export function stitchEncodedPolylines(encodedList) {
  const merged = [];
  for (const encoded of encodedList || []) {
    if (!encoded) continue;
    const pts = decodePolyline(encoded);
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      if (merged.length > 0) {
        const last = merged[merged.length - 1];
        if (Math.abs(last[0] - pt[0]) < 1e-6 && Math.abs(last[1] - pt[1]) < 1e-6) {
          continue;
        }
      }
      merged.push(pt);
    }
  }
  return merged;
}

/**
 * 依據累計距離取得折線的真實幾何中點，讓路徑資訊膠囊貼準路線中央
 * @param {Array<[number, number]>} coords
 * @returns {[number, number] | null}
 */
export function getPolylineMidpoint(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  if (coords.length === 1) return coords[0];

  const cumDist = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const dLat = coords[i][0] - coords[i - 1][0];
    const dLng = coords[i][1] - coords[i - 1][1];
    total += Math.hypot(dLat, dLng);
    cumDist.push(total);
  }

  if (total === 0) return coords[Math.floor(coords.length / 2)];
  const half = total / 2;

  for (let i = 1; i < cumDist.length; i++) {
    if (cumDist[i] >= half) {
      const segLen = cumDist[i] - cumDist[i - 1];
      const ratio = segLen > 0 ? (half - cumDist[i - 1]) / segLen : 0;
      const lat = coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * ratio;
      const lng = coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * ratio;
      return [lat, lng];
    }
  }

  return coords[Math.floor(coords.length / 2)];
}
