/**
 * Nominatim 地點搜尋與反向地理編碼服務
 */

export async function searchPlaces(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=zh-TW&q=${encodeURIComponent(query)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error('Search HTTP error');
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function reverseGeocode(lat, lng) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=zh-TW&zoom=17`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return (
      data.name ||
      data.address?.amenity ||
      data.address?.tourism ||
      data.address?.road ||
      data.address?.suburb ||
      null
    );
  } catch {
    return null;
  }
}
