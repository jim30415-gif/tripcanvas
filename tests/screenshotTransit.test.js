import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getScreenshotFeatureStatus,
  handleScreenshotBuildRouteRequest,
  handleScreenshotParseRequest,
  normalizeParsedScreenshotDraft,
  resetScreenshotQuotaStateForTest,
} from '../server/screenshotTransit.js';
import { encodePolyline } from '../src/services/polyline.js';

const FAKE_IMG_DATA_URL = `data:image/jpeg;base64,${Buffer.alloc(240, 0xab).toString('base64')}`;

const KANAZAWA_ORIGIN = { lat: 36.5621, lng: 136.6627 }; // 兼六園
const KANAZAWA_DEST = { lat: 36.5718, lng: 136.6565 }; // 近江町市場

function withMockedFetch(mockImpl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function makeJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeGeminiSuccess(parsedObj) {
  return makeJsonResponse({
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(parsedObj) }],
        },
      },
    ],
  });
}

test('getScreenshotFeatureStatus reports unconfigured without GEMINI_API_KEY and osm_free stopGeocoder with key', () => {
  resetScreenshotQuotaStateForTest();
  const s1 = getScreenshotFeatureStatus({});
  assert.equal(s1.enabled, false);
  assert.equal(s1.reason, 'UNCONFIGURED');
  assert.equal(s1.stopGeocoder, 'osm_free');

  const s2 = getScreenshotFeatureStatus({ GEMINI_API_KEY: 'free-key-123' });
  assert.equal(s2.enabled, true);
  assert.equal(s2.locked, false);
  assert.equal(s2.stopGeocoder, 'osm_free');
  assert.equal(s2.limits.dailyParseRemaining, 80);
});

test('handleScreenshotParseRequest validates image format, size, and coordinates', async () => {
  resetScreenshotQuotaStateForTest();
  const env = { GEMINI_API_KEY: 'free-key' };

  const badImg = await handleScreenshotParseRequest(
    { imageDataUrl: 'data:text/plain;base64,AAAA', origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
    { env }
  );
  assert.equal(badImg.statusCode, 400);
  assert.equal(badImg.body.error, 'INVALID_IMAGE');

  const hugeImg = `data:image/jpeg;base64,${Buffer.alloc(1.7 * 1024 * 1024, 0xaa).toString('base64')}`;
  const oversized = await handleScreenshotParseRequest(
    { imageDataUrl: hugeImg, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
    { env }
  );
  assert.equal(oversized.statusCode, 400);
  assert.equal(oversized.body.error, 'INVALID_IMAGE');

  const badCoord = await handleScreenshotParseRequest(
    { imageDataUrl: FAKE_IMG_DATA_URL, origin: { lat: 99, lng: 136 }, destination: KANAZAWA_DEST },
    { env }
  );
  assert.equal(badCoord.statusCode, 400);
  assert.equal(badCoord.body.error, 'INVALID_COORDS');
});

test('handleScreenshotParseRequest anchors stops via 100% free Photon/OSM (zero Google Places calls even with GOOGLE_MAPS_API_KEY) and snaps real bus roads via OSRM', async () => {
  resetScreenshotQuotaStateForTest();
  // 即使環境有設定 GOOGLE_MAPS_API_KEY，截圖站牌定位也絕不可呼叫 Google Places API
  const env = { GEMINI_API_KEY: 'free-gemini-key', GOOGLE_MAPS_API_KEY: 'should-never-be-called' };

  const geminiParsed = {
    isTransitScreenshot: true,
    confidence: 'high',
    warning: '',
    totalDurationMin: 18,
    departureTimeText: '09:12',
    arrivalTimeText: '09:30',
    fareAmount: 210,
    fareCurrency: 'JPY',
    segments: [
      { type: 'WALK', durationMin: 3 },
      {
        type: 'TRANSIT',
        vehicleType: 'BUS',
        lineName: '城下まち金沢周遊バス 左回り',
        lineShortName: 'RL',
        headsign: '金沢駅行',
        durationMin: 13,
        stopCount: 4,
        departureStopName: '兼六園下・金沢城',
        arrivalStopName: '武蔵ヶ辻・近江町市場',
        intermediateStopNames: ['香林坊'],
        departureTimeText: '09:15',
        arrivalTimeText: '09:28',
        colorHex: '#2E7D32',
      },
      { type: 'WALK', durationMin: 2 },
    ],
  };

  let googlePlacesCalls = 0;
  let photonCalls = 0;
  let osrmBusWaypoints = '';
  const sampleBusPoly = encodePolyline([
    [36.5642, 136.6632],
    [36.5612, 136.6542],
    [36.5712, 136.6562],
  ]);
  const sampleWalkPoly = encodePolyline([
    [36.5621, 136.6627],
    [36.5642, 136.6632],
  ]);

  await withMockedFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('places.googleapis.com')) {
        googlePlacesCalls += 1;
        throw new Error('Google Places must NEVER be called for screenshot stop anchoring!');
      }
      if (u.includes('generativelanguage.googleapis.com')) {
        assert.equal(opts.headers['x-goog-api-key'], 'free-gemini-key');
        return makeGeminiSuccess(geminiParsed);
      }
      if (u.includes('photon.komoot.io/api/')) {
        photonCalls += 1;
        const q = new URL(u).searchParams.get('q') || '';
        if (q.includes('兼六園下')) {
          return makeJsonResponse({
            features: [
              // 遠方雜訊點（應被走廊過濾排除）
              { geometry: { coordinates: [139.76, 35.68] }, properties: { name: '兼六園下遠方', osm_key: 'highway', osm_value: 'bus_stop' } },
              // 非站牌設施（得分低於公車站牌）
              { geometry: { coordinates: [136.6630, 36.5640] }, properties: { name: '兼六園下交差点', osm_key: 'highway', osm_value: 'traffic_signals' } },
              // 精準公車站牌（應獲選）
              { geometry: { coordinates: [136.6632, 36.5642] }, properties: { name: '兼六園下・金沢城', osm_key: 'highway', osm_value: 'bus_stop' } },
            ],
          });
        }
        if (q === '武蔵ヶ辻') {
          // 驗證複合站名「武蔵ヶ辻・近江町市場」完整查無時會自動退回主站名「武蔵ヶ辻」命中
          return makeJsonResponse({
            features: [
              { geometry: { coordinates: [136.6562, 36.5712] }, properties: { name: '武蔵ヶ辻・近江町市場', osm_key: 'highway', osm_value: 'bus_stop' } },
            ],
          });
        }
        if (q.includes('香林坊')) {
          return makeJsonResponse({
            features: [
              { geometry: { coordinates: [136.6542, 36.5612] }, properties: { name: '香林坊', osm_key: 'highway', osm_value: 'bus_stop' } },
            ],
          });
        }
        return makeJsonResponse({ features: [] });
      }
      if (u.includes('routing.openstreetmap.de/routed-car')) {
        osrmBusWaypoints = u;
        return makeJsonResponse({ code: 'Ok', routes: [{ geometry: sampleBusPoly, distance: 2650, duration: 540 }] });
      }
      if (u.includes('routing.openstreetmap.de/routed-foot')) {
        return makeJsonResponse({ code: 'Ok', routes: [{ geometry: sampleWalkPoly, distance: 220, duration: 180 }] });
      }
      if (u.includes('open.er-api.com') || u.includes('frankfurter')) {
        return makeJsonResponse({ result: 'success', rates: { JPY: 4.7 } });
      }
      return makeJsonResponse({}, 404);
    },
    async () => {
      const res1 = await handleScreenshotParseRequest(
        {
          imageDataUrl: FAKE_IMG_DATA_URL,
          origin: KANAZAWA_ORIGIN,
          destination: KANAZAWA_DEST,
          originName: '兼六園',
          destinationName: '近江町市場',
        },
        { ip: '1.2.3.4', env }
      );

      assert.equal(googlePlacesCalls, 0);
      assert.equal(res1.statusCode, 200);
      assert.equal(res1.body.status, 'ok');
      assert.equal(res1.body.route.provider, 'screenshot');
      assert.equal(res1.body.route.durationMin, 18);
      assert.equal(res1.body.stopStats.totalStops, 3);
      assert.equal(res1.body.stopStats.matchedStops, 3);
      assert.equal(res1.body.stopStats.placesCallsUsed, 0);
      assert.equal(res1.body.stopStats.geocoder, 'osm_free');

      // 驗證 OSRM 公車段有把上車站→中途站(香林坊)→下車站串成 3 個中繼點
      assert.ok(osrmBusWaypoints.includes('136.663200,36.564200;136.654200,36.561200;136.656200,36.571200'));
      assert.ok(osrmBusWaypoints.includes('exclude=motorway'));

      // 驗證分段結構（WALK -> BUS -> WALK）與票價換算
      const segs = res1.body.route.segments;
      assert.equal(segs.length, 3);
      assert.equal(segs[0].type, 'WALK');
      assert.equal(segs[1].type, 'TRANSIT');
      assert.equal(segs[1].vehicleType, 'BUS');
      assert.equal(segs[1].departureStop.name, '兼六園下・金沢城');
      assert.equal(segs[1].departureStop.lat, 36.5642);
      assert.equal(segs[1].arrivalStop.name, '武蔵ヶ辻・近江町市場');
      assert.equal(segs[2].type, 'WALK');
      assert.equal(res1.body.route.fare.originalCurrency, 'JPY');
      assert.equal(res1.body.route.fare.originalAmount, 210);
      assert.ok(res1.body.route.fare.amountTwd > 0);

      // 第二次透過 screenshot-build 重建：應完全命中站牌快取（0 次 Photon / 0 次 Places / 0 次 Gemini）
      const prevPhotonCalls = photonCalls;
      const res2 = await handleScreenshotBuildRouteRequest(
        {
          draft: res1.body.draft,
          origin: KANAZAWA_ORIGIN,
          destination: KANAZAWA_DEST,
        },
        { env }
      );
      assert.equal(res2.statusCode, 200);
      assert.equal(res2.body.status, 'ok');
      assert.equal(res2.body.stopStats.freeLookupsUsed, 0);
      assert.equal(res2.body.stopStats.placesCallsUsed, 0);
      assert.equal(photonCalls, prevPhotonCalls);
      assert.equal(googlePlacesCalls, 0);
    }
  );
});

test('Stop geocoder falls back cleanly to free OSM Nominatim when Photon has no match', async () => {
  resetScreenshotQuotaStateForTest();
  let nominatimCalled = false;

  await withMockedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('photon.komoot.io')) {
        return makeJsonResponse({ features: [] });
      }
      if (u.includes('nominatim.openstreetmap.org')) {
        nominatimCalled = true;
        return makeJsonResponse([
          { lat: '36.5645', lon: '136.6635', class: 'highway', type: 'bus_stop' },
        ]);
      }
      return makeJsonResponse({ code: 'NoRoute' }, 200);
    },
    async () => {
      const res = await handleScreenshotBuildRouteRequest(
        {
          draft: {
            totalDurationMin: 12,
            segments: [
              {
                type: 'TRANSIT',
                vehicleType: 'BUS',
                lineName: '90',
                departureStopName: '兼六園下',
                arrivalStopName: '近江町市場',
                durationMin: 12,
              },
            ],
          },
          origin: KANAZAWA_ORIGIN,
          destination: KANAZAWA_DEST,
        },
        { env: { GOOGLE_MAPS_API_KEY: 'never-used' } }
      );
      assert.equal(nominatimCalled, true);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.stopStats.matchedStops, 2);
      assert.equal(res.body.stopStats.placesCallsUsed, 0);
    }
  );
});

test('Per-IP daily limit, global daily parse cap, and Gemini 429 cooldown lock prevent abuse cleanly', async () => {
  resetScreenshotQuotaStateForTest();
  const env = {
    GEMINI_API_KEY: 'free-key',
    SCREENSHOT_MAX_PER_IP_DAY: '1',
    SCREENSHOT_DAILY_LIMIT: '2',
  };

  await withMockedFetch(
    async (url) => {
      if (String(url).includes('generativelanguage.googleapis.com')) {
        return makeGeminiSuccess({
          isTransitScreenshot: true,
          totalDurationMin: 12,
          segments: [{ type: 'WALK', durationMin: 12 }],
        });
      }
      return makeJsonResponse({ code: 'NoRoute' }, 200);
    },
    async () => {
      const ok1 = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '10.0.0.1', env }
      );
      assert.equal(ok1.statusCode, 200);

      // 同 IP 第 2 次超過每 IP 每日上限
      const blockedIp = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '10.0.0.1', env }
      );
      assert.equal(blockedIp.statusCode, 429);
      assert.equal(blockedIp.body.error, 'IP_DAILY_LIMIT');

      // 換 IP 消耗第 2 次 -> 觸發全站每日上限鎖定
      const ok2 = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '10.0.0.2', env }
      );
      assert.equal(ok2.statusCode, 200);
      assert.equal(getScreenshotFeatureStatus(env).locked, true);
      assert.equal(getScreenshotFeatureStatus(env).reason, 'DAILY_PARSE_CAP');
    }
  );

  // Gemini 429 冷卻鎖定驗證
  resetScreenshotQuotaStateForTest();
  await withMockedFetch(
    async () => makeJsonResponse({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Free tier rate limit' } }, 429),
    async () => {
      const g429 = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '10.0.0.3', env: { GEMINI_API_KEY: 'free-key' } }
      );
      assert.equal(g429.statusCode, 429);
      assert.equal(g429.body.error, 'GEMINI_QUOTA_EXCEEDED');
      assert.equal(getScreenshotFeatureStatus({ GEMINI_API_KEY: 'free-key' }).locked, true);
    }
  );
});

test('handleScreenshotParseRequest falls back on 404 model unavailable, skips thought parts, retries without responseSchema on 400, and reports invalid API key clearly', async () => {
  // 1. 404 模型不可用時自動跳到下一個可用模型 + 略過 thought=true 區塊 + 400 schema 降級純 JSON
  resetScreenshotQuotaStateForTest();
  const seenModels = [];
  let schemaFallbackCount = 0;

  await withMockedFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        const modelMatch = u.match(/\/models\/([^:]+):generateContent/);
        const model = modelMatch?.[1] || '';
        seenModels.push(model);
        const payload = JSON.parse(opts.body);

        if (model === 'gemini-3.5-flash-lite') {
          return makeJsonResponse({ error: { status: 'NOT_FOUND', message: 'model not found' } }, 404);
        }
        if (model === 'gemini-3.1-flash-lite' && payload.generationConfig?.responseSchema) {
          schemaFallbackCount += 1;
          return makeJsonResponse({ error: { status: 'INVALID_ARGUMENT', message: 'Schema too complex' } }, 400);
        }
        return makeJsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'Analyzing image...', thought: true },
                  {
                    text: JSON.stringify({
                      isTransitScreenshot: false,
                      warning: '這是一張風景照片，不含交通路線資訊。',
                      segments: [],
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      return makeJsonResponse({}, 404);
    },
    async () => {
      const res = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '5.5.5.5', env: { GEMINI_API_KEY: 'free-key' } }
      );
      assert.equal(schemaFallbackCount, 1);
      assert.deepEqual(seenModels, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite']);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'not_transit');
      assert.ok(res.body.message.includes('風景'));
    }
  );

  // 2. 金鑰無效時立刻回報明確錯誤且不再重打其他模型
  resetScreenshotQuotaStateForTest();
  let authAttempts = 0;
  await withMockedFetch(
    async () => {
      authAttempts += 1;
      return makeJsonResponse({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid.' } }, 400);
    },
    async () => {
      const res = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '5.5.5.6', env: { GEMINI_API_KEY: 'bad-key' } }
      );
      assert.equal(authAttempts, 1);
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.error, 'GEMINI_AUTH_ERROR');
      assert.ok(res.body.message.includes('GEMINI_API_KEY'));
    }
  );

  // 3. 單一模型免費層 limit: 0 時自動切換下一個可用免費模型，不誤觸全站冷卻鎖定
  resetScreenshotQuotaStateForTest();
  const limitZeroTried = [];
  await withMockedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        const model = u.match(/\/models\/([^:]+):generateContent/)?.[1] || '';
        limitZeroTried.push(model);
        if (model === 'gemini-3.5-flash-lite') {
          return makeJsonResponse(
            { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric, limit: 0, model: gemini-3.5-flash-lite' } },
            429
          );
        }
        return makeGeminiSuccess({
          isTransitScreenshot: true,
          totalDurationMin: 10,
          segments: [{ type: 'WALK', durationMin: 10 }],
        });
      }
      return makeJsonResponse({ code: 'NoRoute' }, 200);
    },
    async () => {
      const res = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '5.5.5.7', env: { GEMINI_API_KEY: 'free-key' } }
      );
      assert.deepEqual(limitZeroTried, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(getScreenshotFeatureStatus({ GEMINI_API_KEY: 'free-key' }).locked, false);
    }
  );
});

test('normalizeParsedScreenshotDraft cleans stop names, limits intermediate stops, and defaults currency by region', () => {
  const draft = normalizeParsedScreenshotDraft(
    {
      isTransitScreenshot: true,
      fareAmount: 230,
      segments: [
        {
          type: 'TRANSIT',
          vehicleType: 'BUS',
          lineName: '京都市営バス 205',
          departureStopName: '京都駅前',
          arrivalStopName: '金閣寺道',
          intermediateStopNames: ['京都駅前', '四条大宮', '西ノ京円町', '北野白梅町'],
          durationMin: 38,
        },
      ],
    },
    { inJapan: true }
  );

  assert.equal(draft.fareCurrency, 'JPY');
  assert.equal(draft.segments.length, 1);
  // 排除與上車站重複的「京都駅前」，並上限截斷為 2 站
  assert.deepEqual(draft.segments[0].intermediateStopNames, ['四条大宮', '西ノ京円町']);
});
