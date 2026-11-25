import {
  TRANSPORT_MODES,
  TRANSIT_TYPES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_MAP,
} from '../config/constants.js';
import { formatDurationZh } from '../utils/format.js';

export function getActiveDay(state) {
  return state.days.find((d) => d.id === state.activeDayId) || state.days[0];
}

export function calcPinExpense(pin) {
  return (pin.subSpots || []).reduce((sum, s) => sum + Math.max(0, Math.round(Number(s.cost) || 0)), 0);
}

export function calcTransportExpense(pin) {
  return Math.max(0, Math.round(Number(pin?.transportToNext?.cost) || 0));
}

export function calcDayExpense(day) {
  const pins = day?.pins || [];
  return pins.reduce((sum, p, idx) => {
    const spotSum = calcPinExpense(p);
    // 僅非最後一個標點才可能有到下一點的交通支出
    const transportCost = idx < pins.length - 1 ? calcTransportExpense(p) : 0;
    return sum + spotSum + transportCost;
  }, 0);
}

export function calcTripPinCount(tripData) {
  return (tripData?.days || []).reduce((sum, d) => sum + (d.pins || []).length, 0);
}

/**
 * 計算整趟旅程的總支出、顯示中圖層小計、各分類開銷比例（交通／食物／住宿／購物／其他）與各天數開銷比例
 */
export function calcExpenseBreakdown(state) {
  const catTotals = {};
  EXPENSE_CATEGORIES.forEach((c) => {
    catTotals[c.id] = 0;
  });

  let grandTotal = 0;
  let visibleTotal = 0;
  let totalItemCount = 0;

  const dayItems = (state?.days || []).map((day) => {
    let daySum = 0;
    const pins = day.pins || [];

    pins.forEach((pin, idx) => {
      (pin.subSpots || []).forEach((s) => {
        const cost = Math.max(0, Math.round(Number(s.cost) || 0));
        const cat = EXPENSE_CATEGORY_MAP[s.category] ? s.category : 'other';
        catTotals[cat] += cost;
        daySum += cost;
        totalItemCount++;
      });

      if (idx < pins.length - 1) {
        const tCost = calcTransportExpense(pin);
        if (tCost > 0) {
          catTotals.transport += tCost;
          daySum += tCost;
          totalItemCount++;
        }
      }
    });

    grandTotal += daySum;
    if (day.visible) visibleTotal += daySum;

    return {
      id: day.id,
      name: day.name,
      color: day.color,
      visible: day.visible,
      amount: daySum,
      pct: 0,
    };
  });

  const categories = EXPENSE_CATEGORIES.map((c) => {
    const amount = catTotals[c.id] || 0;
    const pct = grandTotal > 0 ? Math.round((amount / grandTotal) * 1000) / 10 : 0;
    return {
      ...c,
      amount,
      pct,
    };
  });

  const days = dayItems.map((d) => ({
    ...d,
    pct: grandTotal > 0 ? Math.round((d.amount / grandTotal) * 1000) / 10 : 0,
  }));

  return {
    grandTotal,
    visibleTotal,
    totalItemCount,
    categories,
    days,
  };
}

export function hasManualTransitDetails(t) {
  if (!t) return false;
  return Boolean(
    (t.transitType && t.transitType.trim()) ||
      (t.line && t.line.trim()) ||
      (t.schedule && t.schedule.trim()) ||
      Number(t.duration) > 0 ||
      Number(t.cost) > 0 ||
      Boolean(t.roadSnapped && t.encodedPolyline)
  );
}

export function hasSegmentedTransit(t) {
  return Boolean(
    t &&
      t.mode === 'transit' &&
      t.status === 'ok' &&
      Array.isArray(t.segments) &&
      t.segments.length > 0
  );
}

/**
 * 解析各類交通設定的誠實展示資訊（涵蓋 Google / NAVITIME / Transitous 分段大眾運輸、貼路公車手動紀錄、陸路實查與交通支出）
 */
export function getTransportDisplayInfo(t) {
  if (!t) return null;
  const modeMeta = TRANSPORT_MODES[t.mode] || TRANSPORT_MODES.car;
  const cost = Math.max(0, Math.round(Number(t.cost) || 0));

  // 1. 大眾運輸
  if (t.mode === 'transit') {
    if (hasSegmentedTransit(t)) {
      const transitSegs = t.segments.filter((s) => s.type === 'TRANSIT');
      const isWalkOnly = transitSegs.length === 0;
      const primaryEmoji = isWalkOnly ? '🚶' : transitSegs[0]?.vehicleEmoji || '🚆';
      const durStr = formatDurationZh(t.duration);
      const lineNames = transitSegs.map((s) => s.displayLine).filter(Boolean);
      const leftTitle = lineNames.length > 0 ? lineNames.join(' → ') : '純步行（無鐵道／公車）';

      const timeRange =
        !isWalkOnly && t.departureTimeText && t.arrivalTimeText
          ? `${t.departureTimeText}–${t.arrivalTimeText}`
          : '';
      const transferText = transitSegs.length > 1 ? `轉乘 ${transitSegs.length - 1} 次` : '';
      const subParts = [durStr, timeRange, transferText].filter(Boolean);

      const pillLines = lineNames.length > 0 ? lineNames.slice(0, 2).join('→') : '純步行';
      const mapPill = durStr ? `${primaryEmoji} ${pillLines} · ${durStr}` : `${primaryEmoji} ${pillLines}`;

      const isNavitime = t.provider === 'navitime';
      const isTransitous = t.provider === 'transitous';
      const badge = isWalkOnly
        ? '僅步行'
        : isTransitous
          ? transitSegs[0]?.vehicleType === 'BUS'
            ? '日本公車'
            : '日本開放'
          : isNavitime
            ? '日本分段'
            : '分段路線';
      const fallbackSub = isWalkOnly
        ? '此段無鐵道／公開公車，僅步行估算'
        : isTransitous
          ? '日本開放資料公車／大眾運輸分段'
          : isNavitime
            ? '日本 NAVITIME 分段路線'
            : 'Google 分段路線';

      return {
        kind: 'transit-segmented',
        emoji: primaryEmoji,
        leftTitle,
        leftSub: subParts.join(' · ') || fallbackSub,
        badge,
        mapPill,
        segments: t.segments,
        cost,
        fare: t.fare || null,
      };
    }

    if (t.status === 'pending') {
      return {
        kind: 'pending',
        emoji: '🚆',
        leftTitle: '大眾運輸',
        leftSub: '正在查詢分段路線與班次...',
        badge: '查詢中',
        mapPill: '🚆 查詢大眾運輸中...',
        cost,
      };
    }

    if (t.status === 'network_error') {
      return {
        kind: 'network_error',
        emoji: '⚠️',
        leftTitle: '無法連線取得大眾運輸班次',
        leftSub: '點此重新查詢、改手動紀錄或查 Google Maps',
        badge: '連線失敗',
        mapPill: '⚠️ 無法取得班次',
        cost,
      };
    }

    if (t.status === 'unsupported') {
      return {
        kind: 'unsupported',
        emoji: '⚠️',
        leftTitle: '查無可用大眾運輸路線',
        leftSub: '可調整出發時間、改填貼路公車或查 Google Maps',
        badge: '無班次',
        mapPill: '⚠️ 查無大眾運輸',
        cost,
      };
    }

    if (!hasManualTransitDetails(t)) {
      return {
        kind: 'transit-empty',
        emoji: '🚆',
        leftTitle: '大眾運輸',
        leftSub: '點此查詢分段路線或手動記錄',
        badge: '未記錄',
        mapPill: '🚆 大眾運輸（點此設定）',
        cost,
      };
    }

    const tTypeObj = TRANSIT_TYPES.find((x) => x.id === t.transitType);
    const emoji = tTypeObj?.emoji || '🚆';
    const isRoadSnapped = Boolean(t.roadSnapped && t.encodedPolyline);
    const mainText = [t.transitType, t.line].filter(Boolean).join(' ') || '大眾運輸';
    const rawDurText = Number(t.duration) > 0 ? formatDurationZh(t.duration) : '';
    const durText = rawDurText ? (t.durationEstimated ? `約 ${rawDurText}` : rawDurText) : '';
    const distText =
      isRoadSnapped && Number(t.distanceKm) > 0 ? `${Number(t.distanceKm).toFixed(1)} km` : '';
    const subParts = [t.schedule, durText, !t.schedule ? distText : ''].filter(Boolean);
    const cleanSched = t.schedule ? t.schedule.replace('（手動紀錄範例）', '').trim() : '';
    const mapParts = [mainText, cleanSched, durText ? `(${durText})` : ''].filter(Boolean);
    const badge = isRoadSnapped ? (t.transitType === '公車' ? '貼路公車' : '貼路紀錄') : '手動紀錄';

    return {
      kind: 'transit-manual',
      emoji,
      leftTitle: mainText,
      leftSub: subParts.length ? subParts.join(' · ') : isRoadSnapped ? '實際馬路路線' : '手動紀錄',
      badge,
      mapPill: `${emoji} ${mapParts.join(' · ')}`,
      cost,
    };
  }

  // 2. 陸路交通：不支援 / 斷線 / 查詢中 / 成功
  if (t.status === 'unsupported') {
    return {
      kind: 'unsupported',
      emoji: '⚠️',
      leftTitle: `此兩點不支援${modeMeta.label}路線`,
      leftSub: '可能跨海或無可達道路',
      badge: '不支援',
      mapPill: '⚠️ 不支援陸路',
      cost,
    };
  }

  if (t.status === 'network_error') {
    return {
      kind: 'network_error',
      emoji: '⚠️',
      leftTitle: `無法連線取得${modeMeta.label}路線`,
      leftSub: '點此重新查詢或改用 Google Maps',
      badge: '連線失敗',
      mapPill: '⚠️ 無法取得路線',
      cost,
    };
  }

  if (t.status === 'pending' || t.duration == null || t.distanceKm == null) {
    return {
      kind: 'pending',
      emoji: modeMeta.emoji,
      leftTitle: modeMeta.label,
      leftSub: '正在查詢實際道路路線...',
      badge: '查詢中',
      mapPill: `${modeMeta.emoji} 查詢路線中...`,
      cost,
    };
  }

  const durStr = formatDurationZh(t.duration);
  const distStr = `${Number(t.distanceKm).toFixed(1)} km`;
  const extraNote = t.fallbackNote
    ? ` · ${t.fallbackNote}`
    : t.mode === 'scooter' && t.provider !== 'google'
      ? ' · 依一般道路估算'
      : '';

  return {
    kind: 'land-ok',
    emoji: modeMeta.emoji,
    leftTitle: modeMeta.label,
    leftSub: `${durStr} · 約 ${distStr}${extraNote}`,
    badge: t.provider === 'google' ? 'Google 路網' : '道路路線',
    mapPill: `${modeMeta.emoji} ${modeMeta.label} · ${durStr}`,
    cost,
  };
}
