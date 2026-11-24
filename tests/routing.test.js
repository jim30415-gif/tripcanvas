import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePolyline,
  encodePolyline,
  stitchEncodedPolylines,
  getPolylineMidpoint,
} from '../src/services/polyline.js';
import {
  extractBusRouteNumber,
  formatLineDisplayName,
  handleComputeRoutes,
  handleStatusRequest,
  normalizeLandRoute,
  normalizeTransitRoute,
  parseDurationSeconds,
  pickBestPlaceFromGoogle,
} from '../server/routesHandler.js';
import { getTransportDisplayInfo, hasSegmentedTransit } from '../src/state/selectors.js';
import { buildTransitTransportRecord } from '../src/services/routeManager.js';

// Node 環境下補上簡易 localStorage mock（供 store/routeManager 匯入測試）
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

test('polyline encode/decode roundtrip 與多段拼接去重', () => {
  const seg1 = [
    [25.0478, 121.517],
    [25.0465, 121.5205],
    [25.045, 121.524],
  ];
  const seg2 = [
    [25.045, 121.524], // 與 seg1 尾點重合，拼接應自動去重
    [25.0445, 121.527],
    [25.0441, 121.5294],
  ];

  const enc1 = encodePolyline(seg1);
  const enc2 = encodePolyline(seg2);
  const decoded1 = decodePolyline(enc1);

  assert.equal(decoded1.length, 3);
  assert.ok(Math.abs(decoded1[0][0] - 25.0478) < 1e-5);
  assert.ok(Math.abs(decoded1[0][1] - 121.517) < 1e-5);

  const stitched = stitchEncodedPolylines([enc1, enc2]);
  assert.equal(stitched.length, 5);
  assert.ok(Math.abs(stitched[4][0] - 25.0441) < 1e-5);

  const mid = getPolylineMidpoint([
    [0, 0],
    [0, 1],
    [0, 10],
  ]);
  assert.ok(Math.abs(mid[1] - 5) < 1e-6);
});

test('parseDurationSeconds 正確解析 Google Protobuf duration 字串', () => {
  assert.equal(parseDurationSeconds('1085s'), 1085);
  assert.equal(parseDurationSeconds('92.6s'), 93);
  assert.equal(parseDurationSeconds('invalid'), 0);
});

test('handleStatusRequest 與未設定金鑰時的誠實回應', async () => {
  const statusOff = handleStatusRequest({ GOOGLE_MAPS_API_KEY: '' });
  assert.equal(statusOff.statusCode, 200);
  assert.equal(statusOff.body.configured, false);

  const statusOn = handleStatusRequest({ GOOGLE_MAPS_API_KEY: 'test-key-123' });
  assert.equal(statusOn.body.configured, true);

  const res = await handleComputeRoutes(
    {
      mode: 'transit',
      origin: { lat: 25.0478, lng: 121.517 },
      destination: { lat: 25.0441, lng: 121.5294 },
    },
    { GOOGLE_MAPS_API_KEY: '' }
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'api_unconfigured');
});

test('normalizeLandRoute 拼接步驟高精度折線並過濾跨海異常', () => {
  const origin = { lat: 25.0441, lng: 121.5294 };
  const dest = { lat: 25.0332, lng: 121.5296 };

  const step1 = encodePolyline([
    [25.0441, 121.5294],
    [25.04, 121.5295],
  ]);
  const step2 = encodePolyline([
    [25.04, 121.5295],
    [25.036, 121.5295],
    [25.0332, 121.5296],
  ]);

  const normalized = normalizeLandRoute(
    {
      distanceMeters: 1350,
      duration: '1020s',
      legs: [{ steps: [{ polyline: { encodedPolyline: step1 } }, { polyline: { encodedPolyline: step2 } }] }],
    },
    'walk',
    origin,
    dest
  );

  assert.ok(normalized);
  assert.equal(normalized.status, 'ok');
  assert.equal(normalized.distanceKm, 1.35);
  assert.equal(normalized.durationMin, 17);
  assert.equal(decodePolyline(normalized.encodedPolyline).length, 4);

  // 跨海大跳躍 (> 120km) 應被拒絕回傳 null
  const seaJump = encodePolyline([
    [25.0441, 121.5294],
    [26.5, 127.8],
  ]);
  const rejected = normalizeLandRoute(
    {
      distanceMeters: 650000,
      duration: '20000s',
      polyline: { encodedPolyline: seaJump },
    },
    'car',
    origin,
    { lat: 26.5, lng: 127.8 }
  );
  assert.equal(rejected, null);
});

test('normalizeTransitRoute 合併連續步行並保留大眾運輸官方代表色與上下車站班次', () => {
  const walkA1 = encodePolyline([
    [25.0478, 121.517],
    [25.047, 121.5172],
  ]);
  const walkA2 = encodePolyline([
    [25.047, 121.5172],
    [25.0462, 121.5175],
  ]);
  const mrtLine = encodePolyline([
    [25.0462, 121.5175],
    [25.0448, 121.5232],
    [25.0423, 121.5329],
  ]);
  const walkB = encodePolyline([
    [25.0423, 121.5329],
    [25.0441, 121.5294],
  ]);

  const mockRoute = {
    distanceMeters: 2450,
    duration: '960s',
    legs: [
      {
        steps: [
          {
            travelMode: 'WALK',
            distanceMeters: 120,
            staticDuration: '100s',
            polyline: { encodedPolyline: walkA1 },
            navigationInstruction: { instructions: '往忠孝西路一段前進' },
          },
          {
            travelMode: 'WALK',
            distanceMeters: 130,
            staticDuration: '110s',
            polyline: { encodedPolyline: walkA2 },
          },
          {
            travelMode: 'TRANSIT',
            distanceMeters: 1800,
            staticDuration: '300s',
            polyline: { encodedPolyline: mrtLine },
            transitDetails: {
              headsign: '南港展覽館',
              stopCount: 2,
              headway: '240s',
              stopDetails: {
                departureStop: {
                  name: '台北車站',
                  location: { latLng: { latitude: 25.0462, longitude: 121.5175 } },
                },
                arrivalStop: {
                  name: '忠孝新生',
                  location: { latLng: { latitude: 25.0423, longitude: 121.5329 } },
                },
                departureTime: '2026-11-23T09:42:00+08:00',
                arrivalTime: '2026-11-23T09:47:00+08:00',
              },
              localizedValues: {
                departureTime: { time: { text: '上午9:42' } },
                arrivalTime: { time: { text: '上午9:47' } },
              },
              transitLine: {
                name: '板南線',
                nameShort: 'BL',
                color: '#0070bd',
                textColor: '#ffffff',
                vehicle: { type: 'SUBWAY', name: { text: '捷運' } },
                agencies: [{ name: '台北捷運' }],
              },
            },
          },
          {
            travelMode: 'WALK',
            distanceMeters: 400,
            staticDuration: '300s',
            polyline: { encodedPolyline: walkB },
          },
        ],
      },
    ],
  };

  const parsed = normalizeTransitRoute(mockRoute);
  assert.ok(parsed);
  // 前兩段連續 WALK 應合併為 1 段，總計：步行 → 板南線 → 步行（共 3 段）
  assert.equal(parsed.segments.length, 3);
  assert.equal(parsed.segments[0].type, 'WALK');
  assert.equal(parsed.segments[0].distanceMeters, 250);
  assert.equal(parsed.segments[0].instruction, '步行前往「台北車站」');
  assert.equal(decodePolyline(parsed.segments[0].encodedPolyline).length, 3);

  assert.equal(parsed.segments[1].type, 'TRANSIT');
  assert.equal(parsed.segments[1].displayLine, '板南線');
  assert.equal(parsed.segments[1].lineColor, '#0070BD');
  assert.equal(parsed.segments[1].stopCount, 2);
  assert.equal(parsed.segments[1].headwayMin, 4);
  assert.equal(parsed.segments[1].departureStop.timeText, '上午9:42');

  assert.equal(parsed.segments[2].type, 'WALK');
  assert.equal(parsed.durationMin, 16);
  assert.equal(parsed.transferCount, 0);

  // 驗證轉換為 pin.transportToNext 紀錄與 selector 呈現
  const record = buildTransitTransportRecord(parsed);
  assert.equal(hasSegmentedTransit(record), true);
  const display = getTransportDisplayInfo(record);
  assert.equal(display.kind, 'transit-segmented');
  assert.equal(display.leftTitle, '板南線');
  assert.equal(display.badge, '分段路線');
});

test('handleComputeRoutes 參數規範驗證（walk 不帶 routingPreference、scooter 區域自動降級、Referer 錯誤診斷）', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  try {
    // 1. 驗證 walk 請求不帶 routingPreference / routeModifiers
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(init.body);
      calls.push({ url, headers: init.headers, payload });
      const enc = encodePolyline([
        [25.0441, 121.5294],
        [25.0332, 121.5296],
      ]);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            routes: [{ distanceMeters: 1200, duration: '900s', polyline: { encodedPolyline: enc } }],
          }),
      };
    };

    const walkRes = await handleComputeRoutes(
      {
        mode: 'walk',
        origin: { lat: 25.0441, lng: 121.5294 },
        destination: { lat: 25.0332, lng: 121.5296 },
      },
      { GOOGLE_MAPS_API_KEY: 'fake-key' }
    );
    assert.equal(walkRes.statusCode, 200);
    assert.equal(walkRes.body.status, 'ok');
    assert.equal(calls[0].payload.travelMode, 'WALK');
    assert.equal(calls[0].payload.polylineQuality, 'HIGH_QUALITY');
    assert.equal('routingPreference' in calls[0].payload, false);
    assert.equal('routeModifiers' in calls[0].payload, false);

    // 2. 驗證 scooter 在不支援 TWO_WHEELER 區域自動降級為 DRIVE + avoidHighways
    calls.length = 0;
    let attempt = 0;
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      attempt++;
      if (attempt === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({}) };
      }
      const enc = encodePolyline([
        [35.6812, 139.7671],
        [35.6895, 139.6917],
      ]);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            routes: [{ distanceMeters: 7800, duration: '1260s', polyline: { encodedPolyline: enc } }],
          }),
      };
    };

    const scooterRes = await handleComputeRoutes(
      {
        mode: 'scooter',
        origin: { lat: 35.6812, lng: 139.7671 },
        destination: { lat: 35.6895, lng: 139.6917 },
      },
      { GOOGLE_MAPS_API_KEY: 'fake-key' }
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].travelMode, 'TWO_WHEELER');
    assert.equal(calls[1].travelMode, 'DRIVE');
    assert.equal(calls[1].routeModifiers.avoidHighways, true);
    assert.equal(scooterRes.body.status, 'ok');
    assert.ok(scooterRes.body.fallbackNote.includes('避開高速公路'));

    // 3. 驗證 Referer 限制錯誤能給出明確繁中提示
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'Requests from referer <empty> are blocked.',
            details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }],
          },
        }),
    });

    const refErr = await handleComputeRoutes(
      {
        mode: 'transit',
        origin: { lat: 25.0478, lng: 121.517 },
        destination: { lat: 25.0441, lng: 121.5294 },
      },
      { GOOGLE_MAPS_API_KEY: 'fake-key' }
    );
    assert.equal(refErr.statusCode, 502);
    assert.equal(refErr.body.error, 'GOOGLE_API_REFERER_BLOCKED');
    assert.ok(refErr.body.message.includes('網域限制'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('舊版 v4 JSON 匯入向下相容驗證（保留支出明細、備註與手動大眾運輸，無分類自動歸入其他）', async () => {
  const { parseImportedState } = await import('../src/state/store.js');
  const { calcDayExpense, calcExpenseBreakdown } = await import('../src/state/selectors.js');

  const legacyJson = JSON.stringify({
    activeDayId: 'day_legacy',
    addMode: false,
    days: [
      {
        id: 'day_legacy',
        name: 'Day 1 · 舊版匯出測試',
        color: '#A46C49',
        visible: true,
        pins: [
          {
            id: 'p1',
            name: '台北車站',
            lat: 25.0478,
            lng: 121.517,
            image: { type: 'preset', value: 'museum' },
            notes: '舊版備註',
            subSpots: [
              { id: 's1', name: '置物櫃', cost: 120 },
              { id: 's2', name: '咖啡', cost: 165 },
            ],
            transportToNext: {
              mode: 'transit',
              status: 'manual',
              duration: 9,
              distanceKm: null,
              transitType: '捷運',
              line: '板南線',
              schedule: '往南港展覽館',
            },
          },
          {
            id: 'p2',
            name: '華山文創園區',
            lat: 25.0441,
            lng: 121.5294,
            image: null,
            notes: '',
            subSpots: [{ id: 's3', name: '門票', cost: 380 }],
            transportToNext: null,
          },
        ],
      },
    ],
  });

  const imported = parseImportedState(legacyJson);
  assert.equal(imported.data.days.length, 1);
  assert.equal(imported.data.addMode, false);
  assert.equal(calcDayExpense(imported.data.days[0]), 665);

  const bd = calcExpenseBreakdown(imported.data);
  assert.equal(bd.grandTotal, 665);
  assert.equal(bd.categories.find((c) => c.id === 'other').amount, 665);

  const display = getTransportDisplayInfo(imported.data.days[0].pins[0].transportToNext);
  assert.equal(display.kind, 'transit-manual');
  assert.equal(display.badge, '手動紀錄');
  assert.ok(display.leftTitle.includes('板南線'));
});

test('外幣大眾運輸票價自動換算新台幣（TWD 原幣、JPY 即時匯率與離線保底）', async () => {
  const { convertMoneyToTwd } = await import('../server/currency.js');
  const originalFetch = globalThis.fetch;

  try {
    // 1. 新台幣原幣不需換算
    const twdFare = await convertMoneyToTwd({ currencyCode: 'TWD', units: '25', nanos: 0 }, 'NT$25');
    assert.equal(twdFare.amountTwd, 25);
    assert.equal(twdFare.originalCurrency, 'TWD');
    assert.equal(twdFare.rateSource, 'native');

    // 2. 模擬即時匯率 API（1 TWD = 4.5 JPY → 450 JPY = NT$ 100）
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        result: 'success',
        base_code: 'TWD',
        rates: { TWD: 1, JPY: 4.5, USD: 0.03125 },
      }),
    });

    const jpyFare = await convertMoneyToTwd({ currencyCode: 'JPY', units: '450', nanos: 0 }, '¥450');
    assert.equal(jpyFare.amountTwd, 100);
    assert.equal(jpyFare.originalCurrency, 'JPY');
    assert.equal(jpyFare.originalAmount, 450);
    assert.equal(jpyFare.rateSource, 'live');

    // 3. 含 nanos 小數外幣（USD 2.50 @ 1/0.03125 = 32 → NT$ 80）
    const usdFare = await convertMoneyToTwd(
      { currencyCode: 'USD', units: '2', nanos: 500000000 },
      '$2.50'
    );
    assert.equal(usdFare.amountTwd, 80);
    assert.equal(usdFare.originalAmount, 2.5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('分類開銷比例（交通／食物／購物／其他）與各天數開銷比例計算（含交通工具支出）', async () => {
  const { calcExpenseBreakdown } = await import('../src/state/selectors.js');

  const mockState = {
    activeDayId: 'd1',
    days: [
      {
        id: 'd1',
        name: 'Day 1',
        color: '#A46C49',
        visible: true,
        pins: [
          {
            id: 'p1',
            subSpots: [
              { id: 's1', name: '拉麵', cost: 300, category: 'food' },
              { id: 's2', name: '伴手禮', cost: 200, category: 'shopping' },
            ],
            transportToNext: { mode: 'transit', status: 'ok', cost: 100 },
          },
          {
            id: 'p2',
            subSpots: [{ id: 's3', name: '門票', cost: 100, category: 'other' }],
            transportToNext: null,
          },
        ],
      },
      {
        id: 'd2',
        name: 'Day 2',
        color: '#5D8065',
        visible: false,
        pins: [
          {
            id: 'p3',
            subSpots: [{ id: 's4', name: '咖啡', cost: 200, category: 'food' }],
            transportToNext: { mode: 'car', status: 'ok', cost: 100 },
          },
          {
            id: 'p4',
            subSpots: [],
            transportToNext: null,
          },
        ],
      },
    ],
  };

  const bd = calcExpenseBreakdown(mockState);
  assert.equal(bd.grandTotal, 1000);
  assert.equal(bd.visibleTotal, 700);
  assert.equal(bd.totalItemCount, 6);

  const byCat = Object.fromEntries(bd.categories.map((c) => [c.id, c]));
  assert.equal(byCat.food.amount, 500);
  assert.equal(byCat.food.pct, 50);
  assert.equal(byCat.transport.amount, 200);
  assert.equal(byCat.transport.pct, 20);
  assert.equal(byCat.shopping.amount, 200);
  assert.equal(byCat.shopping.pct, 20);
  assert.equal(byCat.other.amount, 100);
  assert.equal(byCat.other.pct, 10);

  assert.equal(bd.days[0].amount, 700);
  assert.equal(bd.days[0].pct, 70);
  assert.equal(bd.days[1].amount, 300);
  assert.equal(bd.days[1].pct, 30);
});

test('多旅遊計畫管理：新增、切換、改名、複製與保留舊計畫', async () => {
  const {
    getAllTrips,
    getActiveTrip,
    createNewTrip,
    switchTrip,
    renameTrip,
    duplicateTrip,
    deleteTrip,
  } = await import('../src/state/store.js');

  const initialCount = getAllTrips().length;
  const firstId = getActiveTrip().id;

  const tokyo = createNewTrip('東京 5 日獨旅', { blank: true });
  assert.equal(getAllTrips().length, initialCount + 1);
  assert.equal(getActiveTrip().id, tokyo.id);
  assert.equal(getActiveTrip().name, '東京 5 日獨旅');

  renameTrip(tokyo.id, '東京 6 日獨旅');
  assert.equal(getActiveTrip().name, '東京 6 日獨旅');

  const copy = duplicateTrip(tokyo.id);
  assert.ok(copy.name.includes('副本'));
  assert.equal(getAllTrips().length, initialCount + 2);

  // 切換回原計畫確認資料完整保留
  switchTrip(firstId);
  assert.equal(getActiveTrip().id, firstId);

  // 清理測試新增的計畫
  assert.equal(deleteTrip(copy.id), true);
  assert.equal(deleteTrip(tokyo.id), true);
  assert.equal(getAllTrips().length, initialCount);
});

test('日本座標判斷與 JST 時間格式化（涵蓋本州／北海道／沖繩，精準排除台灣與韓國）', async () => {
  const { isJapanCoord, isJapanTrip, formatJstDateTime } = await import('../server/navitime.js');

  assert.equal(isJapanCoord({ lat: 35.6812, lng: 139.7671 }), true); // 東京車站
  assert.equal(isJapanCoord({ lat: 34.9858, lng: 135.7588 }), true); // 京都車站
  assert.equal(isJapanCoord({ lat: 34.7025, lng: 135.496 }), true); // 大阪車站
  assert.equal(isJapanCoord({ lat: 43.0687, lng: 141.3508 }), true); // 札幌車站
  assert.equal(isJapanCoord({ lat: 26.2124, lng: 127.6809 }), true); // 沖繩那霸

  assert.equal(isJapanCoord({ lat: 25.0478, lng: 121.517 }), false); // 台北車站
  assert.equal(isJapanCoord({ lat: 25.1276, lng: 121.7392 }), false); // 基隆
  assert.equal(isJapanCoord({ lat: 37.5665, lng: 126.978 }), false); // 首爾
  assert.equal(isJapanCoord({ lat: 35.1796, lng: 129.0756 }), false); // 釜山

  assert.equal(
    isJapanTrip({ lat: 35.6812, lng: 139.7671 }, { lat: 35.7148, lng: 139.7967 }),
    true
  );
  assert.equal(
    isJapanTrip({ lat: 25.0478, lng: 121.517 }, { lat: 35.6812, lng: 139.7671 }),
    false
  );

  // UTC 2026-11-24T01:30:00Z 應為 JST 2026-11-24T10:30:00（無時區後綴）
  assert.equal(formatJstDateTime('2026-11-24T01:30:00.000Z'), '2026-11-24T10:30:00');
});

test('NAVITIME 日本大眾運輸正規化與分流（含轉乘分段、官方代表色、GeoJSON 折線與日圓票價自動換算）', async () => {
  const { handleRatesRequest } = await import('../server/routesHandler.js');
  const { convertToTwdSync } = await import('../src/services/currencyClient.js');

  const tokyo = { lat: 35.6812, lng: 139.7671 };
  const sensoji = { lat: 35.7148, lng: 139.7967 };

  // 1. 狀態端點回報 navitimeConfigured
  assert.equal(handleStatusRequest({ GOOGLE_MAPS_API_KEY: 'g', RAPIDAPI_NAVITIME_KEY: '' }).body.navitimeConfigured, false);
  assert.equal(handleStatusRequest({ GOOGLE_MAPS_API_KEY: 'g', RAPIDAPI_NAVITIME_KEY: 'nav-key' }).body.navitimeConfigured, true);

  // 2. 日本大眾運輸未設定 NAVITIME Key 時，應直接回傳 japan_transit_requires_navitime（不浪費 Google 配額）
  const originalFetch = globalThis.fetch;
  let fetchCalled = 0;
  try {
    globalThis.fetch = async () => {
      fetchCalled++;
      throw new Error('不應呼叫外部 API');
    };
    const noKeyRes = await handleComputeRoutes(
      { mode: 'transit', origin: tokyo, destination: sensoji },
      { GOOGLE_MAPS_API_KEY: 'g-only', RAPIDAPI_NAVITIME_KEY: '' }
    );
    assert.equal(fetchCalled, 0);
    assert.equal(noKeyRes.statusCode, 200);
    assert.equal(noKeyRes.body.status, 'japan_transit_requires_navitime');
    assert.equal(noKeyRes.body.region, 'JP');

    // 3. 設定 RAPIDAPI_NAVITIME_KEY 時，自動分流至 NAVITIME 並回傳標準分段路線＋日圓換台幣
    let requestedUrl = '';
    let requestedHeaders = {};
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('open.er-api.com')) {
        return {
          ok: true,
          json: async () => ({
            result: 'success',
            rates: { TWD: 1, JPY: 5.0, USD: 0.03125 },
          }),
        };
      }
      requestedUrl = String(url);
      requestedHeaders = init?.headers || {};
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                summary: {
                  move: {
                    time: 23,
                    distance: 5400,
                    transit_count: 1,
                    from_time: '2026-11-24T10:00:00+09:00',
                    to_time: '2026-11-24T10:23:00+09:00',
                    reference_fare: { lowest_total_ic: 350, lowest_total_ticket: 360 },
                  },
                },
                sections: [
                  { type: 'point', name: 'start', coord: { lat: 35.6812, lon: 139.7671 } },
                  { type: 'move', move: 'walk', time: 2, distance: 150, from_time: '2026-11-24T10:00:00+09:00', to_time: '2026-11-24T10:02:00+09:00' },
                  { type: 'point', name: '東京', coord: { lat: 35.6814, lon: 139.7672 }, node_types: ['station'] },
                  {
                    type: 'move',
                    move: 'local_train',
                    line_name: 'JR山手線',
                    time: 3,
                    distance: 1300,
                    from_time: '2026-11-24T10:03:00+09:00',
                    to_time: '2026-11-24T10:06:00+09:00',
                    transport: {
                      color: '#80C241',
                      company: { name: 'JR東日本' },
                      links: [{ destination: { name: '上野・池袋方面' } }],
                    },
                  },
                  { type: 'point', name: '神田', coord: { lat: 35.6917, lon: 139.7709 }, node_types: ['station'] },
                  {
                    type: 'move',
                    move: 'local_train',
                    line_name: '東京メトロ銀座線',
                    time: 10,
                    distance: 3500,
                    from_time: '2026-11-24T10:08:00+09:00',
                    to_time: '2026-11-24T10:18:00+09:00',
                    transport: {
                      company: { name: '東京メトロ' },
                      links: [{ destination: { name: '浅草' } }],
                    },
                  },
                  { type: 'point', name: '浅草', coord: { lat: 35.7119, lon: 139.7982 }, node_types: ['station'] },
                  { type: 'move', move: 'walk', time: 5, distance: 450, from_time: '2026-11-24T10:18:00+09:00', to_time: '2026-11-24T10:23:00+09:00' },
                  { type: 'point', name: 'goal', coord: { lat: 35.7148, lon: 139.7967 } },
                ],
                shapes: {
                  type: 'FeatureCollection',
                  features: [
                    {
                      type: 'Feature',
                      geometry: { type: 'LineString', coordinates: [[139.7671, 35.6812], [139.7672, 35.6814]] },
                      properties: { ways: 'walk', inline: { color: '#BFBFBF' } },
                    },
                    {
                      type: 'Feature',
                      geometry: { type: 'LineString', coordinates: [[139.7672, 35.6814], [139.769, 35.686], [139.7709, 35.6917]] },
                      properties: { ways: 'transport', inline: { color: '#80C241' } },
                    },
                    {
                      type: 'Feature',
                      geometry: { type: 'LineString', coordinates: [[139.7709, 35.6917], [139.785, 35.702], [139.7982, 35.7119]] },
                      properties: { ways: 'transport', inline: { color: '#FF9500' } },
                    },
                    {
                      type: 'Feature',
                      geometry: { type: 'LineString', coordinates: [[139.7982, 35.7119], [139.7975, 35.7135], [139.7967, 35.7148]] },
                      properties: { ways: 'walk', inline: { color: '#BFBFBF' } },
                    },
                  ],
                },
              },
            ],
          }),
      };
    };

    const jpRes = await handleComputeRoutes(
      {
        mode: 'transit',
        origin: tokyo,
        destination: sensoji,
        departureTime: '2026-11-24T01:00:00.000Z',
        transitPreference: 'FEWER_TRANSFERS',
      },
      { GOOGLE_MAPS_API_KEY: '', RAPIDAPI_NAVITIME_KEY: 'test-navitime-key' }
    );

    assert.equal(jpRes.statusCode, 200);
    assert.equal(jpRes.body.status, 'ok');
    assert.equal(jpRes.body.provider, 'navitime');
    assert.ok(requestedUrl.includes('navitime-route-totalnavi.p.rapidapi.com/route_transit'));
    assert.ok(requestedUrl.includes('datum=wgs84'));
    assert.ok(requestedUrl.includes('coord_unit=degree'));
    assert.ok(requestedUrl.includes('shape_color=railway_line'));
    assert.ok(requestedUrl.includes('order=transit'));
    assert.equal(requestedHeaders['x-rapidapi-key'], 'test-navitime-key');

    const route = jpRes.body.routes[0];
    assert.equal(route.segments.length, 4);
    assert.equal(route.segments[0].type, 'WALK');
    assert.equal(route.segments[1].displayLine, 'JR山手線');
    assert.equal(route.segments[1].lineColor, '#80C241');
    assert.equal(route.segments[1].departureStop.timeText, '10:03');
    assert.equal(route.segments[2].displayLine, '東京メトロ銀座線');
    assert.equal(route.segments[2].vehicleType, 'SUBWAY');
    // 銀座線 transport.color 未填時應自動從 GeoJSON inline.color 取得代表色 #FF9500
    assert.equal(route.segments[2].lineColor, '#FF9500');
    assert.equal(decodePolyline(route.segments[2].encodedPolyline).length, 3);
    // 350 JPY 應自動換算為新台幣正整數並標示原幣 ¥350
    assert.equal(route.fare.originalCurrency, 'JPY');
    assert.equal(route.fare.originalAmount, 350);
    assert.ok(route.fare.amountTwd > 0);

    const record = buildTransitTransportRecord(route, { provider: 'navitime' });
    assert.equal(record.provider, 'navitime');
    assert.equal(getTransportDisplayInfo(record).badge, '日本分段');

    // 4. 匯率摘要端點與前端同步換算工具
    const ratesRes = await handleRatesRequest();
    assert.equal(ratesRes.statusCode, 200);
    assert.equal(ratesRes.body.base, 'TWD');
    assert.ok(ratesRes.body.twdPerUnit.JPY > 0);

    const manualJpy = convertToTwdSync(1000, 'JPY', { JPY: 0.21 });
    assert.equal(manualJpy.amountTwd, 210);
    assert.equal(manualJpy.originalCurrency, 'JPY');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('公車路線顯示優先以號碼為主，無號碼時才退回名稱（Google Routes 與日本 NAVITIME）', async () => {
  // 1. Google Routes formatLineDisplayName 與 extractBusRouteNumber
  assert.equal(formatLineDisplayName('撫遠街－板橋', '307', 'BUS'), '307');
  assert.equal(formatLineDisplayName('捷運淡水站－漁人碼頭', '紅26', 'BUS'), '紅26');
  assert.equal(formatLineDisplayName('台北－桃園機場', '1819', 'INTERCITY_BUS'), '1819');
  assert.equal(formatLineDisplayName('307 撫遠街－板橋', '', 'BUS'), '307');
  assert.equal(formatLineDisplayName('撫遠街－板橋', '307 撫遠街－板橋', 'BUS'), '307');
  assert.equal(formatLineDisplayName('仁愛幹線', '', 'BUS'), '仁愛幹線');
  assert.equal(formatLineDisplayName('東湖－台北車站', '內湖幹線', 'BUS'), '內湖幹線');
  assert.equal(formatLineDisplayName('撫遠街－板橋', '', 'BUS'), '撫遠街－板橋');
  // 非公車（捷運）仍維持完整中文線名
  assert.equal(formatLineDisplayName('板南線', 'BL', 'SUBWAY'), '板南線');
  assert.equal(extractBusRouteNumber('京都市バス ２０５系統'), '205');
  assert.equal(extractBusRouteNumber('都01(T01)'), '都01');

  // 2. normalizeTransitRoute 實際整合驗證（公車 307 不會被撫遠街－板橋覆蓋）
  const busLine = encodePolyline([
    [25.0478, 121.517],
    [25.0441, 121.5294],
  ]);
  const busParsed = normalizeTransitRoute({
    distanceMeters: 1600,
    duration: '420s',
    legs: [
      {
        steps: [
          {
            travelMode: 'TRANSIT',
            distanceMeters: 1600,
            staticDuration: '420s',
            polyline: { encodedPolyline: busLine },
            transitDetails: {
              headsign: '撫遠街',
              stopCount: 3,
              stopDetails: {
                departureStop: { name: '台北車站(忠孝)' },
                arrivalStop: { name: '華山公園' },
              },
              transitLine: {
                name: '撫遠街－板橋',
                nameShort: '307',
                vehicle: { type: 'BUS', name: { text: '公車' } },
              },
            },
          },
        ],
      },
    ],
  });
  assert.ok(busParsed);
  assert.equal(busParsed.segments[0].displayLine, '307');

  // 3. NAVITIME 日本公車優先擷取番號，無號碼時退回名稱並移除冗餘起迄括號
  const { normalizeNavitimeRoute } = await import('../server/navitime.js');
  const kyotoBusItem = {
    summary: { move: { time: 15, distance: 3200, transit_count: 1 } },
    sections: [
      { type: 'point', name: '京都駅前', coord: { lat: 34.9858, lon: 135.7588 } },
      {
        type: 'move',
        move: 'local_bus',
        line_name: '京都市バス ２０５系統',
        time: 8,
        distance: 1800,
        transport: { company: { name: '京都市交通局' } },
      },
      { type: 'point', name: '四条河原町', coord: { lat: 35.0037, lon: 135.7688 } },
      {
        type: 'move',
        move: 'local_bus',
        line_name: '金沢ふらっとバス 此花ルート[金沢駅-近江町市場]',
        time: 7,
        distance: 1400,
        transport: { company: { name: '西日本JRバス' } },
      },
      { type: 'point', name: '近江町市場', coord: { lat: 35.01, lon: 135.775 } },
    ],
  };
  const navBus = await normalizeNavitimeRoute(kyotoBusItem);
  assert.ok(navBus);
  assert.equal(navBus.segments[0].displayLine, '205');
  assert.equal(navBus.segments[1].displayLine, '金沢ふらっとバス 此花ルート');
});

test('新增支出分類（住宿）與 11 款內建預設圖示（含機場／車站／民宿）驗證', async () => {
  const { EXPENSE_CATEGORIES } = await import('../src/config/constants.js');
  const { PRESET_ARTWORKS } = await import('../src/config/presets.js');
  const { calcExpenseBreakdown } = await import('../src/state/selectors.js');

  assert.ok(EXPENSE_CATEGORIES.some((c) => c.id === 'lodging' && c.label === '住宿'));
  assert.equal(Object.keys(PRESET_ARTWORKS).length, 11);
  assert.equal(PRESET_ARTWORKS.airport?.name, '機場');
  assert.equal(PRESET_ARTWORKS.station?.name, '車站');
  assert.equal(PRESET_ARTWORKS.homestay?.name, '民宿');

  const bd = calcExpenseBreakdown({
    activeDayId: 'd1',
    days: [
      {
        id: 'd1',
        name: 'Day 1',
        color: '#A46C49',
        visible: true,
        pins: [
          {
            id: 'p1',
            subSpots: [
              { id: 's1', name: '溫泉民宿一晚', cost: 3600, category: 'lodging' },
              { id: 's2', name: '晚餐', cost: 400, category: 'food' },
            ],
            transportToNext: null,
          },
        ],
      },
    ],
  });
  assert.equal(bd.grandTotal, 4000);
  const lodgingCat = bd.categories.find((c) => c.id === 'lodging');
  assert.equal(lodgingCat.amount, 3600);
  assert.equal(lodgingCat.pct, 90);
});

test('單景點 Google Maps 跳轉連結與「標點優先、次順位路名」命名邏輯', async () => {
  const { buildGoogleMapsPlaceUrl } = await import('../src/utils/geo.js');
  const { pickPlaceNameFromNominatim } = await import('../src/services/geocoder.js');

  // 1. 單景點 Google Maps URL
  assert.equal(
    buildGoogleMapsPlaceUrl({
      name: '華山 1914 文化創意產業園區',
      lat: 25.0441,
      lng: 121.5294,
      placeId: 'ChIJ_abc123',
    }),
    'https://www.google.com/maps/search/?api=1&query=%E8%8F%AF%E5%B1%B1%201914%20%E6%96%87%E5%8C%96%E5%89%B5%E6%84%8F%E7%94%A2%E6%A5%AD%E5%9C%92%E5%8D%80&query_place_id=ChIJ_abc123'
  );
  assert.equal(
    buildGoogleMapsPlaceUrl({
      name: '自訂景點 1',
      lat: 25.0441,
      lng: 121.5294,
      placeId: 'ChIJ_abc123',
    }),
    'https://www.google.com/maps/search/?api=1&query=25.044100%2C121.529400'
  );
  assert.equal(
    buildGoogleMapsPlaceUrl({ name: '忠孝東路二段', lat: 25.042, lng: 121.531 }),
    'https://www.google.com/maps/search/?api=1&query=25.042000%2C121.531000'
  );
  assert.equal(buildGoogleMapsPlaceUrl(null), 'https://www.google.com/maps');

  // 2. Google Places / Geocoding：略過純行政區與道路，優先取 POI，無 POI 時取路名
  const gPoi = pickBestPlaceFromGoogle(
    {
      places: [
        { id: 'area1', displayName: { text: '中正區' }, primaryType: 'sublocality', types: ['sublocality', 'political'] },
        { id: 'poi1', displayName: { text: '興波咖啡 Simple Kaffa' }, primaryType: 'cafe', types: ['cafe', 'point_of_interest'] },
      ],
    },
    null
  );
  assert.deepEqual(gPoi, { name: '興波咖啡 Simple Kaffa', placeId: 'poi1', source: 'google_poi' });

  const gRoad = pickBestPlaceFromGoogle(
    { places: [{ id: 'area2', displayName: { text: '台北市' }, primaryType: 'locality', types: ['locality', 'political'] }] },
    {
      results: [
        {
          types: ['route'],
          address_components: [
            { long_name: '忠孝東路二段', types: ['route'] },
            { long_name: '中正區', types: ['administrative_area_level_3', 'political'] },
          ],
        },
      ],
    }
  );
  assert.deepEqual(gRoad, { name: '忠孝東路二段', placeId: '', source: 'google_road' });

  const gUnnamed = pickBestPlaceFromGoogle(null, {
    results: [{ types: ['route'], address_components: [{ long_name: 'Unnamed Road', types: ['route'] }] }],
  });
  assert.equal(gUnnamed, null);

  // 3. Nominatim：POI 優先 → 路名次之 → 街區保底
  assert.equal(
    pickPlaceNameFromNominatim({
      category: 'tourism',
      name: '國立中正紀念堂',
      address: { road: '中山南路', suburb: '中正區' },
    }),
    '國立中正紀念堂'
  );
  assert.equal(
    pickPlaceNameFromNominatim({
      category: 'highway',
      name: '仁愛路二段',
      address: { road: '仁愛路二段', suburb: '中正區' },
    }),
    '仁愛路二段'
  );
  assert.equal(
    pickPlaceNameFromNominatim({
      category: 'place',
      name: '',
      address: { pedestrian: '迪化街一段', suburb: '大同區' },
    }),
    '迪化街一段'
  );
  assert.equal(
    pickPlaceNameFromNominatim({
      category: 'boundary',
      name: '陽明山',
      address: { suburb: '北投區' },
    }),
    '北投區'
  );
});





