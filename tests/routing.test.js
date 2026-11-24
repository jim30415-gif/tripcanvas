import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePolyline,
  encodePolyline,
  stitchEncodedPolylines,
  getPolylineMidpoint,
} from '../src/services/polyline.js';
import {
  handleComputeRoutes,
  handleStatusRequest,
  normalizeLandRoute,
  normalizeTransitRoute,
  parseDurationSeconds,
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


