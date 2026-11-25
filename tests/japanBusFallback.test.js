import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePolyline, encodePolyline } from '../src/services/polyline.js';
import { normalizeTransitousItinerary, formatJstHHmm } from '../server/transitous.js';
import { handleComputeRoutes } from '../server/routesHandler.js';
import { estimateBusDurationFromCarMin } from '../src/services/routeManager.js';
import { getTransportDisplayInfo, hasManualTransitDetails } from '../src/state/selectors.js';
import { normalizeState } from '../src/state/store.js';

function encodePolylineWithPrecision(coords, precision = 6) {
  const factor = 10 ** precision;
  const encodeSigned = (num) => {
    let sgn = num << 1;
    if (num < 0) sgn = ~sgn;
    let out = '';
    while (sgn >= 0x20) {
      out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
      sgn >>= 5;
    }
    out += String.fromCharCode(sgn + 63);
    return out;
  };
  let prevLat = 0;
  let prevLng = 0;
  let result = '';
  for (const [lat, lng] of coords) {
    const iLat = Math.round(lat * factor);
    const iLng = Math.round(lng * factor);
    result += encodeSigned(iLat - prevLat);
    result += encodeSigned(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return result;
}

test('decodePolyline 支援 MOTIS 2 / Transitous precision=6 且不與 Google precision=5 快取衝突', () => {
  // 日本金澤座標（經度 > 136°，測試 precision=6 精確解碼）
  const coords = [
    [36.571712, 136.656431],
    [36.566518, 136.659124],
    [36.562104, 136.662615],
  ];
  const poly6 = encodePolylineWithPrecision(coords, 6);
  const decoded6 = decodePolyline(poly6, 6);
  assert.equal(decoded6.length, 3);
  assert.ok(Math.abs(decoded6[0][0] - coords[0][0]) < 1e-5);
  assert.ok(Math.abs(decoded6[0][1] - coords[0][1]) < 1e-5);
  assert.ok(Math.abs(decoded6[2][0] - coords[2][0]) < 1e-5);
  assert.ok(Math.abs(decoded6[2][1] - coords[2][1]) < 1e-5);

  // 同字串若先以 precision=5 解碼不應污染 precision=6 快取結果
  const poly5 = encodePolyline(coords);
  const decoded5 = decodePolyline(poly5, 5);
  assert.equal(decoded5.length, 3);
  assert.ok(Math.abs(decoded5[1][0] - coords[1][0]) < 1e-4);
});

test('Transitous (MOTIS 2) itinerary 正規化：保留公車站點、轉換 precision-6 折線、JST 時刻與日圓票價', async () => {
  const walkCoords = [
    [36.5717, 136.6564],
    [36.5712, 136.6572],
  ];
  const busCoords = [
    [36.5712, 136.6572],
    [36.5668, 136.6594],
    [36.5632, 136.6615],
  ];
  const walk2Coords = [
    [36.5632, 136.6615],
    [36.5621, 136.6626],
  ];

  // 純步行 itinerary 應回傳 null（交由 NAVITIME / 方案 A 處理）
  const walkOnly = await normalizeTransitousItinerary({
    duration: 1440,
    transfers: 0,
    legs: [
      {
        mode: 'WALK',
        duration: 1440,
        distance: 1800,
        from: { name: 'START', lat: 36.5717, lon: 136.6564 },
        to: { name: 'END', lat: 36.5621, lon: 136.6626 },
        legGeometry: { points: encodePolylineWithPrecision(walkCoords, 6), precision: 6, length: 2 },
      },
    ],
  });
  assert.equal(walkOnly, null);

  // 含公車之 itinerary
  const parsed = await normalizeTransitousItinerary({
    duration: 660, // 11 分鐘
    transfers: 0,
    startTime: '2026-11-26T01:00:00Z', // JST 10:00
    endTime: '2026-11-26T01:11:00Z', // JST 10:11
    fareTransfers: [
      {
        rule: 'A_AB_B',
        effectiveFareLegProducts: [[[{ name: '大人運賃', amount: 210, currency: 'JPY' }]]],
      },
    ],
    legs: [
      {
        mode: 'WALK',
        duration: 120,
        distance: 160,
        from: { name: 'START', lat: 36.5717, lon: 136.6564 },
        to: { name: '武蔵ヶ辻・近江町市場', lat: 36.5712, lon: 136.6572 },
        legGeometry: { points: encodePolylineWithPrecision(walkCoords, 6), precision: 6, length: 2 },
      },
      {
        mode: 'BUS',
        duration: 420,
        distance: 1450,
        startTime: '2026-11-26T01:02:00Z', // JST 10:02
        endTime: '2026-11-26T01:09:00Z', // JST 10:09
        routeShortName: 'RL',
        routeLongName: '城下町金沢周遊バス',
        displayName: '城下町金沢周遊バス RL',
        routeColor: '2E7D32',
        agencyName: '北陸鉄道',
        headsign: '兼六園下・金沢城',
        from: { name: '武蔵ヶ辻・近江町市場', lat: 36.5712, lon: 136.6572 },
        to: { name: '兼六園下・金沢城', lat: 36.5632, lon: 136.6615 },
        intermediateStops: [
          { name: '南町・尾山神社', lat: 36.5675, lon: 136.6585 },
          { name: '香林坊', lat: 36.5648, lon: 136.6598 },
        ],
        legGeometry: { points: encodePolylineWithPrecision(busCoords, 6), precision: 6, length: 3 },
      },
      {
        mode: 'WALK',
        duration: 120,
        distance: 190,
        from: { name: '兼六園下・金沢城', lat: 36.5632, lon: 136.6615 },
        to: { name: 'END', lat: 36.5621, lon: 136.6626 },
        legGeometry: { points: encodePolylineWithPrecision(walk2Coords, 6), precision: 6, length: 2 },
      },
    ],
  });

  assert.ok(parsed);
  assert.equal(parsed.provider, 'transitous');
  assert.equal(parsed.hasTransit, true);
  assert.equal(parsed.durationMin, 11);
  assert.equal(parsed.segments.length, 3);
  assert.equal(parsed.segments[0].type, 'WALK');
  assert.equal(parsed.segments[1].type, 'TRANSIT');
  assert.equal(parsed.segments[1].vehicleType, 'BUS');
  assert.equal(parsed.segments[1].vehicleEmoji, '🚌');
  assert.equal(parsed.segments[1].displayLine, 'RL');
  assert.equal(parsed.segments[1].lineColor, '#2E7D32');
  assert.equal(parsed.segments[1].stopCount, 3);
  assert.equal(parsed.segments[1].departureStop.timeText, '10:02');
  assert.equal(parsed.segments[1].arrivalStop.timeText, '10:09');
  assert.equal(formatJstHHmm('2026-11-26T01:02:00Z'), '10:02');
  // 已重編碼為前端標準 precision=5 折線
  const decodedBus = decodePolyline(parsed.segments[1].encodedPolyline);
  assert.equal(decodedBus.length, 3);
  assert.ok(Math.abs(decodedBus[1][0] - 36.5668) < 1e-3);
  // 票價自動由 JPY 轉 TWD
  assert.equal(parsed.fare.originalCurrency, 'JPY');
  assert.equal(parsed.fare.originalAmount, 210);
  assert.ok(parsed.fare.amountTwd > 0);
});

test('日本大眾運輸雙層備援鏈（先 B 次 A）：NAVITIME 有電車不打 Transitous；純步行時自動轉查 Transitous；皆無則標記 walkOnly', async () => {
  const omicho = { lat: 36.5717, lng: 136.6564 };
  const kenrokuen = { lat: 36.5621, lng: 136.6626 };
  const busPoly6 = encodePolylineWithPrecision(
    [
      [36.5712, 136.6572],
      [36.5632, 136.6615],
    ],
    6
  );

  const originalFetch = globalThis.fetch;

  // 情境 1：NAVITIME 純步行 -> Transitous 成功找到日本公車（方案 B 命中）
  let transitousUrl = '';
  let transitousUA = '';
  globalThis.fetch = async (url, opts) => {
    const s = String(url);
    if (s.includes('navitime-route-totalnavi.p.rapidapi.com')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                summary: { move: { time: 24, distance: 1800, transit_count: 0 } },
                sections: [
                  { type: 'point', name: 'start', coord: { lat: 36.5717, lon: 136.6564 } },
                  { type: 'move', move: 'walk', time: 24, distance: 1800 },
                  { type: 'point', name: 'goal', coord: { lat: 36.5621, lon: 136.6626 } },
                ],
              },
            ],
          }),
      };
    }
    if (s.includes('api.transitous.org/api/v5/plan')) {
      transitousUrl = s;
      transitousUA = opts?.headers?.['User-Agent'] || '';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          itineraries: [
            {
              duration: 540,
              transfers: 0,
              startTime: '2026-11-26T02:00:00Z',
              endTime: '2026-11-26T02:09:00Z',
              legs: [
                {
                  mode: 'BUS',
                  duration: 480,
                  distance: 1500,
                  startTime: '2026-11-26T02:01:00Z',
                  endTime: '2026-11-26T02:09:00Z',
                  routeShortName: '18',
                  routeLongName: '金沢ふらっとバス',
                  agencyName: '金沢市',
                  from: { name: '近江町市場', lat: 36.5712, lon: 136.6572 },
                  to: { name: '兼六園下', lat: 36.5632, lon: 136.6615 },
                  intermediateStops: [{ name: '尾山神社', lat: 36.567, lon: 136.659 }],
                  legGeometry: { points: busPoly6, precision: 6, length: 2 },
                },
              ],
            },
          ],
        }),
      };
    }
    throw new Error(`Unexpected fetch URL: ${s}`);
  };

  try {
    const hitB = await handleComputeRoutes(
      { origin: omicho, destination: kenrokuen, mode: 'transit' },
      { RAPIDAPI_NAVITIME_KEY: 'nav-key' }
    );
    assert.equal(hitB.statusCode, 200);
    assert.equal(hitB.body.status, 'ok');
    assert.equal(hitB.body.provider, 'transitous');
    assert.equal(hitB.body.hasTransit, true);
    assert.equal(hitB.body.fallbackFrom, 'navitime');
    assert.ok(transitousUrl.includes('directModes='));
    assert.ok(transitousUA.includes('TripCanvas/'));
    assert.equal(hitB.body.routes[0].segments[0].vehicleType, 'BUS');
    assert.equal(hitB.body.routes[0].segments[0].displayLine, '18');

    // 情境 2：NAVITIME 純步行且 Transitous 也無公開公車 -> 回傳 NAVITIME walkOnly 觸發方案 A
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes('navitime-route-totalnavi.p.rapidapi.com')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [
                {
                  summary: { move: { time: 24, distance: 1800, transit_count: 0 } },
                  sections: [
                    { type: 'point', name: 'start', coord: { lat: 36.5717, lon: 136.6564 } },
                    { type: 'move', move: 'walk', time: 24, distance: 1800 },
                    { type: 'point', name: 'goal', coord: { lat: 36.5621, lon: 136.6626 } },
                  ],
                },
              ],
            }),
        };
      }
      if (s.includes('api.transitous.org/api/v5/plan')) {
        return { ok: true, status: 200, json: async () => ({ itineraries: [] }) };
      }
      throw new Error(`Unexpected fetch URL: ${s}`);
    };

    const fallbackA = await handleComputeRoutes(
      { origin: omicho, destination: kenrokuen, mode: 'transit' },
      { RAPIDAPI_NAVITIME_KEY: 'nav-key' }
    );
    assert.equal(fallbackA.statusCode, 200);
    assert.equal(fallbackA.body.status, 'ok');
    assert.equal(fallbackA.body.provider, 'navitime');
    assert.equal(fallbackA.body.hasTransit, false);
    assert.equal(fallbackA.body.walkOnly, true);
    assert.equal(fallbackA.body.transitousChecked, true);

    // 情境 3：NAVITIME 本身已有鐵道乘車段 -> 絕不額外呼叫 Transitous
    let transitousCalled = false;
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes('api.transitous.org')) {
        transitousCalled = true;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                summary: { move: { time: 12, distance: 3500, transit_count: 0 } },
                sections: [
                  { type: 'point', name: '東京', coord: { lat: 35.6812, lon: 139.7671 } },
                  {
                    type: 'move',
                    move: 'local_train',
                    line_name: 'JR山手線',
                    time: 12,
                    distance: 3500,
                    transport: { name: 'JR山手線', color: '#80C241' },
                  },
                  { type: 'point', name: '上野', coord: { lat: 35.7141, lon: 139.7774 } },
                ],
              },
            ],
          }),
      };
    };

    const railRes = await handleComputeRoutes(
      {
        origin: { lat: 35.6812, lng: 139.7671 },
        destination: { lat: 35.7141, lng: 139.7774 },
        mode: 'transit',
      },
      { RAPIDAPI_NAVITIME_KEY: 'nav-key' }
    );
    assert.equal(railRes.body.provider, 'navitime');
    assert.equal(railRes.body.hasTransit, true);
    assert.equal(transitousCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('方案 A：手動貼路公車估時、展示標籤、純步行警示標籤與 store 持久化保留', () => {
  // 1. 依汽車車程估算公車時間
  assert.equal(estimateBusDurationFromCarMin(5), 8);
  assert.equal(estimateBusDurationFromCarMin(10), 15);
  assert.equal(estimateBusDurationFromCarMin(60), 77);
  assert.equal(estimateBusDurationFromCarMin(0), null);

  // 2. Transitous 公車分段顯示標籤
  const transitousInfo = getTransportDisplayInfo({
    mode: 'transit',
    status: 'ok',
    provider: 'transitous',
    duration: 11,
    segments: [
      { type: 'TRANSIT', vehicleType: 'BUS', vehicleEmoji: '🚌', displayLine: 'RL', durationMin: 7 },
    ],
  });
  assert.equal(transitousInfo.badge, '日本公車');
  assert.equal(transitousInfo.emoji, '🚌');

  // 3. 純步行分段（無乘車段）應明確標示「僅步行」而非誤導為大眾運輸
  const walkOnlyInfo = getTransportDisplayInfo({
    mode: 'transit',
    status: 'ok',
    provider: 'navitime',
    duration: 24,
    segments: [{ type: 'WALK', durationMin: 24, distanceMeters: 1800 }],
  });
  assert.equal(walkOnlyInfo.badge, '僅步行');
  assert.equal(walkOnlyInfo.emoji, '🚶');
  assert.ok(walkOnlyInfo.leftTitle.includes('純步行'));

  // 4. 手動貼路公車：即使不填路線名與時間，靠自動貼路折線與估算時間也能完整顯示
  const roadPoly = encodePolyline([
    [36.5717, 136.6564],
    [36.5621, 136.6626],
  ]);
  const manualBus = {
    mode: 'transit',
    status: 'manual',
    provider: 'manual-google',
    transitType: '公車',
    line: '',
    schedule: '',
    duration: 8,
    distanceKm: 1.8,
    encodedPolyline: roadPoly,
    roadSnapped: true,
    durationEstimated: true,
    cost: 44,
  };
  assert.equal(hasManualTransitDetails(manualBus), true);
  const manualInfo = getTransportDisplayInfo(manualBus);
  assert.equal(manualInfo.badge, '貼路公車');
  assert.equal(manualInfo.emoji, '🚌');
  assert.ok(manualInfo.leftSub.includes('約 8 分'));
  assert.ok(manualInfo.leftSub.includes('1.8 km'));

  // 5. store.js 匯入／正規化應完整保留 roadSnapped 與 durationEstimated
  const jsonText = JSON.stringify({
    version: 6,
    activeDayId: 'd1',
    days: [
      {
        id: 'd1',
        name: 'Day 1',
        color: '#8E6D4F',
        visible: true,
        pins: [
          { id: 'p1', name: '近江町市場', lat: 36.5717, lng: 136.6564, transportToNext: manualBus },
          { id: 'p2', name: '兼六園', lat: 36.5621, lng: 136.6626, transportToNext: null },
        ],
      },
    ],
  });
  const imported = normalizeState(JSON.parse(jsonText));
  assert.ok(imported);
  const savedT = imported.days[0].pins[0].transportToNext;
  assert.equal(savedT.roadSnapped, true);
  assert.equal(savedT.durationEstimated, true);
  assert.equal(savedT.encodedPolyline, roadPoly);
});
