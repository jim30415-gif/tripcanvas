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

test('getScreenshotFeatureStatus reports unconfigured without GEMINI_API_KEY and enabled with key', () => {
  resetScreenshotQuotaStateForTest();
  const s1 = getScreenshotFeatureStatus({});
  assert.equal(s1.enabled, false);
  assert.equal(s1.reason, 'UNCONFIGURED');

  const s2 = getScreenshotFeatureStatus({ GEMINI_API_KEY: 'free-key-123' });
  assert.equal(s2.enabled, true);
  assert.equal(s2.locked, false);
  assert.equal(s2.limits.dailyParseRemaining, 80);
  assert.equal(s2.limits.dailyPlacesRemaining, 120);
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

test('handleScreenshotParseRequest parses Japan bus screenshot, anchors stops via Places, snaps real bus roads via OSRM, and caches stops', async () => {
  resetScreenshotQuotaStateForTest();
  const env = { GEMINI_API_KEY: 'free-gemini-key', GOOGLE_MAPS_API_KEY: 'places-key' };

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

  let placesCallCount = 0;
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
      if (u.includes('generativelanguage.googleapis.com')) {
        assert.equal(opts.headers['x-goog-api-key'], 'free-gemini-key');
        return makeGeminiSuccess(geminiParsed);
      }
      if (u.includes('places.googleapis.com/v1/places:searchText')) {
        placesCallCount += 1;
        const body = JSON.parse(opts.body);
        if (body.textQuery.includes('兼六園下')) {
          return makeJsonResponse({
            places: [
              // 刻意放一個超遠雜訊點，驗證走廊過濾會排除它
              { id: 'far', displayName: { text: '遠方雜訊' }, location: { latitude: 35.68, longitude: 139.76 }, types: ['bus_stop'] },
              { id: 's1', displayName: { text: '兼六園下・金沢城' }, location: { latitude: 36.5642, longitude: 136.6632 }, types: ['bus_stop'] },
            ],
          });
        }
        if (body.textQuery.includes('武蔵ヶ辻')) {
          return makeJsonResponse({
            places: [
              { id: 's2', displayName: { text: '武蔵ヶ辻・近江町市場' }, location: { latitude: 36.5712, longitude: 136.6562 }, types: ['bus_stop'] },
            ],
          });
        }
        if (body.textQuery.includes('香林坊')) {
          return makeJsonResponse({
            places: [
              { id: 's3', displayName: { text: '香林坊' }, location: { latitude: 36.5612, longitude: 136.6542 }, types: ['bus_stop'] },
            ],
          });
        }
        return makeJsonResponse({ places: [] });
      }
      if (u.includes('routing.openstreetmap.de/routed-car')) {
        osrmBusWaypoints = u;
        return makeJsonResponse({ code: 'Ok', routes: [{ geometry: sampleBusPoly, distance: 2650, duration: 540 }] });
      }
      if (u.includes('routing.openstreetmap.de/routed-foot')) {
        return makeJsonResponse({ code: 'Ok', routes: [{ geometry: sampleWalkPoly, distance: 220, duration: 180 }] });
      }
      if (u.includes('open.er-api.com') || u.includes('frankfurter')) {
        return makeJsonResponse({ rates: { TWD: 0.21 } });
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

      assert.equal(res1.statusCode, 200);
      assert.equal(res1.body.status, 'ok');
      assert.equal(res1.body.route.provider, 'screenshot');
      assert.equal(res1.body.route.durationMin, 18);
      assert.equal(res1.body.stopStats.totalStops, 3);
      assert.equal(res1.body.stopStats.matchedStops, 3);
      assert.equal(placesCallCount, 3);

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

      // 第二次同樣站名透過 screenshot-build 重建：應完全命中站牌快取（0 次 Google Places 呼叫、0 次 Gemini 呼叫）
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
      assert.equal(res2.body.stopStats.placesCallsUsed, 0);
      assert.equal(placesCallCount, 3);
    }
  );
});

test('Google Places 429 immediately trips circuit breaker and locks screenshot import to protect free quota', async () => {
  resetScreenshotQuotaStateForTest();
  const env = { GEMINI_API_KEY: 'free-key', GOOGLE_MAPS_API_KEY: 'places-key' };
  let geminiCalls = 0;

  await withMockedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        geminiCalls += 1;
        return makeGeminiSuccess({
          isTransitScreenshot: true,
          totalDurationMin: 15,
          segments: [
            {
              type: 'TRANSIT',
              vehicleType: 'BUS',
              lineName: '206',
              departureStopName: '京都駅前',
              arrivalStopName: '清水道',
              durationMin: 15,
            },
          ],
        });
      }
      if (u.includes('places.googleapis.com')) {
        return makeJsonResponse({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, 429);
      }
      return makeJsonResponse({}, 404);
    },
    async () => {
      const r1 = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '9.9.9.9', env }
      );
      assert.equal(r1.statusCode, 429);
      assert.equal(r1.body.status, 'quota_limited');
      assert.equal(r1.body.error, 'PLACES_QUOTA_EXCEEDED');

      const status = getScreenshotFeatureStatus(env);
      assert.equal(status.locked, true);
      assert.equal(status.reason, 'PLACES_QUOTA_EXCEEDED');

      // 鎖定後再呼叫 screenshot-parse 與 screenshot-build 皆直接被拒，且不再呼叫 Gemini
      const r2 = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '8.8.8.8', env }
      );
      assert.equal(r2.statusCode, 429);
      assert.equal(r2.body.status, 'quota_limited');
      assert.equal(geminiCalls, 1);

      const r3 = await handleScreenshotBuildRouteRequest(
        {
          draft: { segments: [{ type: 'TRANSIT', vehicleType: 'BUS', lineName: '206', departureStopName: 'A', arrivalStopName: 'B' }] },
          origin: KANAZAWA_ORIGIN,
          destination: KANAZAWA_DEST,
        },
        { env }
      );
      assert.equal(r3.statusCode, 429);
      assert.equal(r3.body.status, 'quota_limited');
    }
  );
});

test('Per-IP daily limit, Places daily cap, and Gemini 429 lock prevent abuse cleanly', async () => {
  resetScreenshotQuotaStateForTest();
  const env = {
    GEMINI_API_KEY: 'free-key',
    GOOGLE_MAPS_API_KEY: 'places-key',
    SCREENSHOT_MAX_PER_IP_DAY: '1',
    SCREENSHOT_PLACES_DAILY_LIMIT: '1',
  };

  await withMockedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
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

      // 同 IP 第 2 次超過每日上限
      const blockedIp = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '10.0.0.1', env }
      );
      assert.equal(blockedIp.statusCode, 429);
      assert.equal(blockedIp.body.error, 'IP_DAILY_LIMIT');
    }
  );

  // Gemini 429 冷卻鎖定驗證
  resetScreenshotQuotaStateForTest();
  await withMockedFetch(
    async () => makeJsonResponse({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Free tier rate limit' } }, 429),
    async () => {
      const g429 = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '10.0.0.2', env: { GEMINI_API_KEY: 'free-key' } }
      );
      assert.equal(g429.statusCode, 429);
      assert.equal(g429.body.error, 'GEMINI_QUOTA_EXCEEDED');
      assert.equal(getScreenshotFeatureStatus({ GEMINI_API_KEY: 'free-key' }).locked, true);
    }
  );
});

test('handleScreenshotParseRequest rejects non-transit screenshots and retries without thinkingConfig on 400', async () => {
  resetScreenshotQuotaStateForTest();
  let attempt = 0;

  await withMockedFetch(
    async (url, opts) => {
      if (String(url).includes('generativelanguage.googleapis.com')) {
        attempt += 1;
        const payload = JSON.parse(opts.body);
        if (attempt === 1) {
          assert.ok(payload.generationConfig.thinkingConfig);
          return makeJsonResponse({ error: { message: 'Unknown field thinkingConfig' } }, 400);
        }
        assert.equal(payload.generationConfig.thinkingConfig, undefined);
        return makeGeminiSuccess({
          isTransitScreenshot: false,
          warning: '這是一張風景照片，不含交通路線資訊。',
          segments: [],
        });
      }
      return makeJsonResponse({}, 404);
    },
    async () => {
      const res = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '5.5.5.5', env: { GEMINI_API_KEY: 'free-key' } }
      );
      assert.equal(attempt, 2);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'not_transit');
      assert.ok(res.body.message.includes('風景'));
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
