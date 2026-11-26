/**
 * 前端大眾運輸截圖解析客戶端：
 * - 自動於瀏覽器端縮圖與 JPEG 壓縮（最長邊 1280px），減少傳輸與伺服器負擔
 * - 支援相簿上傳、拖放與剪貼簿貼上圖片（Ctrl+V / Cmd+V 與按鈕讀取剪貼簿）
 * - 透過同源 /api/routes?action=screenshot-* 代理呼叫 Google AI Studio 免費視覺模型與站牌定位
 */

function loadImageFromObjectUrl(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('IMAGE_DECODE_FAILED'));
    };
    img.src = url;
  });
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('IMAGE_READ_FAILED'));
    reader.readAsDataURL(blob);
  });
}

export async function compressScreenshotBlob(fileOrBlob, { maxDim = 1600, quality = 0.9 } = {}) {
  if (!fileOrBlob || !(fileOrBlob instanceof Blob)) {
    throw new Error('INVALID_FILE');
  }
  const mime = String(fileOrBlob.type || '').toLowerCase();
  if (mime && !mime.startsWith('image/')) {
    throw new Error('NOT_AN_IMAGE');
  }

  const img = await loadImageFromObjectUrl(fileOrBlob);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) throw new Error('EMPTY_IMAGE');

  // 原本就是清晰且小於 600 KB、尺寸未超標的 PNG / WebP 截圖直接無損保留，避免 JPEG 壓縮模糊日文／漢字小字
  if (
    (mime === 'image/png' || mime === 'image/webp') &&
    Math.max(srcW, srcH) <= maxDim &&
    fileOrBlob.size > 0 &&
    fileOrBlob.size <= 600_000
  ) {
    const rawDataUrl = await readBlobAsDataUrl(fileOrBlob);
    if (rawDataUrl.startsWith('data:image/') && rawDataUrl.length <= 1_650_000) {
      return rawDataUrl;
    }
  }

  const encodeWith = (limit, q) => {
    const scale = Math.min(1, limit / Math.max(srcW, srcH));
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, dstW, dstH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, dstW, dstH);
    return canvas.toDataURL('image/jpeg', q);
  };

  let dataUrl = encodeWith(maxDim, quality);
  // 若解碼大小接近 1.5 MB 上限，自動二次壓縮確保順暢上傳
  if (dataUrl.length > 1_650_000) {
    dataUrl = encodeWith(1280, 0.8);
  }
  if (dataUrl.length > 1_850_000) {
    dataUrl = encodeWith(960, 0.72);
  }
  return dataUrl;
}

export function extractImageFromClipboardEvent(e) {
  const items = e?.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind === 'file' && String(item.type || '').startsWith('image/')) {
      return item.getAsFile();
    }
  }
  return null;
}

export async function readClipboardImageBlob() {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
    return { status: 'unsupported' };
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = (item.types || []).find((t) => t.startsWith('image/'));
      if (imgType) {
        const blob = await item.getType(imgType);
        return { status: 'ok', blob };
      }
    }
    return { status: 'empty' };
  } catch (err) {
    if (err?.name === 'NotAllowedError') {
      return { status: 'denied' };
    }
    return { status: 'unsupported' };
  }
}

export async function fetchScreenshotImportStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('/api/routes?action=screenshot-status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function parseTransitScreenshot({
  imageDataUrl,
  origin,
  destination,
  originName = '',
  destinationName = '',
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28000);
  try {
    const res = await fetch('/api/routes?action=screenshot-parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        imageDataUrl,
        origin: { lat: Number(origin.lat), lng: Number(origin.lng) },
        destination: { lat: Number(destination.lat), lng: Number(destination.lng) },
        originName,
        destinationName,
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (data && typeof data === 'object') {
      return { httpStatus: res.status, ...data };
    }
    return {
      httpStatus: res.status,
      status: 'network_error',
      message: '截圖解析回應異常，請稍後再試。',
    };
  } catch (err) {
    return {
      httpStatus: 0,
      status: 'network_error',
      message: err?.name === 'AbortError' ? '截圖辨識逾時，請重新嘗試。' : '無法連線至截圖辨識服務，請檢查網路。',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function rebuildScreenshotTransitRoute({ draft, origin, destination }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 16000);
  try {
    const res = await fetch('/api/routes?action=screenshot-build', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        draft,
        origin: { lat: Number(origin.lat), lng: Number(origin.lng) },
        destination: { lat: Number(destination.lat), lng: Number(destination.lng) },
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (data && typeof data === 'object') {
      return { httpStatus: res.status, ...data };
    }
    return {
      httpStatus: res.status,
      status: 'network_error',
      message: '站牌路線定位失敗，請稍後再試。',
    };
  } catch (err) {
    return {
      httpStatus: 0,
      status: 'network_error',
      message: err?.name === 'AbortError' ? '站牌定位逾時，請再試一次。' : '無法連線至站牌定位服務。',
    };
  } finally {
    clearTimeout(timer);
  }
}
