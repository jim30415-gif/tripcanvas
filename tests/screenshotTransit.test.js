import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getScreenshotFeatureStatus,
  handleScreenshotBuildRouteRequest,
  handleScreenshotParseRequest,
  normalizeParsedScreenshotDraft,
  pruneOutlierIntermediateCoords,
  resetScreenshotQuotaStateForTest,
  selectEvenlySpacedIntermediateStops,
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

test('handleScreenshotParseRequest falls back on 404 model unavailable, stages 400 fallback, upgrades hollow parses to gemini-3.6-flash, and reports invalid API key clearly', async () => {
  // 1. 404 模型不可用時自動跳到下一個可用模型 + 驗證 HIGH 畫質/LOW 思考/全必填 schema + 400 分階段降級 + 略過 thought=true 區塊
  resetScreenshotQuotaStateForTest();
  const seenStages = [];

  await withMockedFetch(
    async (url, opts) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        const modelMatch = u.match(/\/models\/([^:]+):generateContent/);
        const model = modelMatch?.[1] || '';
        const payload = JSON.parse(opts.body);
        const cfg = payload.generationConfig || {};
        seenStages.push({
          model,
          hasSchema: Boolean(cfg.responseSchema),
          hasEnhanced: Boolean(cfg.mediaResolution && cfg.thinkingConfig),
        });

        if (model === 'gemini-3.5-flash-lite') {
          // 驗證新版預設會帶出高解析度、LOW 思考與完整必填欄位
          assert.equal(cfg.mediaResolution, 'MEDIA_RESOLUTION_HIGH');
          assert.equal(cfg.thinkingConfig?.thinkingLevel, 'LOW');
          assert.ok(cfg.responseSchema?.required?.includes('departureTimeText'));
          assert.ok(cfg.responseSchema?.properties?.segments?.items?.required?.includes('departureStopName'));
          assert.ok(cfg.responseSchema?.properties?.segments?.items?.required?.includes('lineName'));
          return makeJsonResponse({ error: { status: 'NOT_FOUND', message: 'model not found' } }, 404);
        }
        if (model === 'gemini-3.1-flash-lite' && cfg.responseSchema) {
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
      assert.deepEqual(seenStages, [
        { model: 'gemini-3.5-flash-lite', hasSchema: true, hasEnhanced: true },
        { model: 'gemini-3.1-flash-lite', hasSchema: true, hasEnhanced: true },
        { model: 'gemini-3.1-flash-lite', hasSchema: true, hasEnhanced: false },
        { model: 'gemini-3.1-flash-lite', hasSchema: false, hasEnhanced: false },
      ]);
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

  // 4. 輕量模型若回傳空殼 TRANSIT（無路線名且無上下車站名），自動以免費 gemini-3.6-flash 補讀並採用更完整結果
  resetScreenshotQuotaStateForTest();
  const upgradeModels = [];
  await withMockedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        const model = u.match(/\/models\/([^:]+):generateContent/)?.[1] || '';
        upgradeModels.push(model);
        if (model === 'gemini-3.5-flash-lite') {
          return makeGeminiSuccess({
            isTransitScreenshot: true,
            totalDurationMin: 20,
            fareAmount: 210,
            fareCurrency: 'JPY',
            segments: [
              { type: 'WALK', durationMin: 1 },
              { type: 'TRANSIT' },
              { type: 'WALK', durationMin: 10 },
            ],
          });
        }
        return makeGeminiSuccess({
          isTransitScreenshot: true,
          departureTimeText: '下午1:54',
          arrivalTimeText: '下午2:14',
          totalDurationMin: 20,
          fareAmount: 210,
          fareCurrency: 'JPY',
          segments: [
            { type: 'WALK', durationMin: 1 },
            {
              type: 'TRANSIT',
              vehicleType: 'BUS',
              lineName: '循環バス [金沢駅～金沢駅]',
              headsign: '広坂・２１世紀美術館・兼六園下・金沢城経由橋場町・ひがし茶屋街行',
              durationMin: 9,
              stopCount: 4,
              departureStopName: '武蔵ヶ辻・近江町市場（バス）',
              arrivalStopName: '兼六園下',
              intermediateStopNames: ['Minami-cho・Oyama Jinja Shrine', '香林坊', '広坂・２１世紀美術館（バス）'],
              departureTimeText: '下午1:55',
              arrivalTimeText: '下午2:04',
            },
            { type: 'WALK', durationMin: 10 },
          ],
        });
      }
      return makeJsonResponse({ features: [] }, 200);
    },
    async () => {
      const res = await handleScreenshotParseRequest(
        { imageDataUrl: FAKE_IMG_DATA_URL, origin: KANAZAWA_ORIGIN, destination: KANAZAWA_DEST },
        { ip: '5.5.5.8', env: { GEMINI_API_KEY: 'free-key' } }
      );
      assert.deepEqual(upgradeModels, ['gemini-3.5-flash-lite', 'gemini-3.6-flash']);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.draft.departureTimeText, '13:54');
      assert.equal(res.body.draft.arrivalTimeText, '14:14');
      const busSeg = res.body.draft.segments[1];
      assert.equal(busSeg.lineName, '循環バス [金沢駅~金沢駅]');
      assert.equal(busSeg.durationMin, 9);
      assert.equal(busSeg.stopCount, 4);
      assert.equal(busSeg.departureStopName, '武蔵ヶ辻・近江町市場');
      assert.equal(busSeg.arrivalStopName, '兼六園下');
      assert.deepEqual(busSeg.intermediateStopNames, ['Minami-cho・Oyama Jinja Shrine', '香林坊', '広坂・21世紀美術館']);
    }
  );
});

test('normalizeParsedScreenshotDraft cleans stop names, converts 12-hour CJK times, evenly samples 5 intermediate stops, and defaults currency by region', () => {
  const draft = normalizeParsedScreenshotDraft(
    {
      isTransitScreenshot: true,
      departureTimeText: '下午1:54',
      arrivalTimeText: '下午2:14',
      fareAmount: 230,
      segments: [
        {
          type: 'TRANSIT',
          vehicleType: 'BUS',
          lineName: '94 金沢大学線',
          departureStopName: '兼六園下（バス）',
          arrivalStopName: 'Kanazawadaigakushizenkenmae Bus Stop',
          intermediateStopNames: [
            '兼六園下',
            '横山町 (バス)',
            '暁町 (バス)',
            '桜町 (バス)',
            '田井町 (バス)',
            '旭町口 (バス)',
            '旭町 [金沢市]',
            '若松橋 (バス)',
            '若松西 (バス)',
            '若松',
            '角間新町 (バス)',
          ],
          departureTimeText: '上午9:05',
          arrivalTimeText: '上午9:43',
          durationMin: 0,
        },
      ],
    },
    { inJapan: true }
  );

  assert.equal(draft.fareCurrency, 'JPY');
  assert.equal(draft.departureTimeText, '13:54');
  assert.equal(draft.arrivalTimeText, '14:14');
  assert.equal(draft.totalDurationMin, 20);
  assert.equal(draft.segments.length, 1);
  assert.equal(draft.segments[0].departureStopName, '兼六園下');
  assert.equal(draft.segments[0].arrivalStopName, 'Kanazawadaigakushizenkenmae');
  assert.equal(draft.segments[0].departureTimeText, '09:05');
  assert.equal(draft.segments[0].arrivalTimeText, '09:43');
  // durationMin 未填時可由上下車時刻自動推算 38 分
  assert.equal(draft.segments[0].durationMin, 38);
  // 排除與上車站重複的「兼六園下」，從 10 站中均勻挑選 5 站（同時涵蓋前、中、後段並清除 (バス)/[金沢市]）
  assert.deepEqual(draft.segments[0].intermediateStopNames, ['横山町', '桜町', '旭町', '若松西', '角間新町']);
  assert.deepEqual(selectEvenlySpacedIntermediateStops(['A', 'B', 'C'], 5), ['A', 'B', 'C']);
});

test('Role-biased geocoder rejects unrelated distant stops & pruneOutlierIntermediateCoords removes backtracking spikes', async () => {
  resetScreenshotQuotaStateForTest();
  const origin = { lat: 36.5698, lng: 136.6626 }; // 寺島蔵人邸
  const destination = { lat: 36.5449, lng: 136.7095 }; // 金沢大学角間

  // 驗證幾何過濾器：保留正常沿線中途點，剔除往反方向跳到金沢站的折返尖刺
  const pruned = pruneOutlierIntermediateCoords(
    { lat: 36.5654, lng: 136.6623 },
    [
      { name: '横山町', lat: 36.5635, lng: 136.6703 },
      { name: '旭町', lat: 36.5531, lng: 136.6827 },
      { name: '誤吸折返點', lat: 36.5787, lng: 136.6472 },
      { name: '角間新町', lat: 36.5538, lng: 136.6983 },
    ],
    { lat: 36.5445, lng: 136.7068 }
  );
  assert.deepEqual(
    pruned.map((p) => p.name),
    ['横山町', '旭町', '角間新町']
  );

  // 驗證 role-aware 步行半徑與站名重疊防護：下車站若誤回 6.5km 外的無關站牌，必須拒收而不把公車折返拉走
  await withMockedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('photon.komoot.io')) {
        const q = new URL(u).searchParams.get('q') || '';
        if (q.includes('兼六園下')) {
          return makeJsonResponse({
            features: [
              {
                geometry: { coordinates: [136.6623, 36.5654] },
                properties: { name: '兼六園下・金沢城', osm_key: 'highway', osm_value: 'bus_stop' },
              },
            ],
          });
        }
        // 模擬誤吸到遠離終點 6.5km 的金沢站公車站牌
        return makeJsonResponse({
          features: [
            {
              geometry: { coordinates: [136.6472, 36.5787] },
              properties: { name: '金沢駅東口', osm_key: 'highway', osm_value: 'bus_stop' },
            },
          ],
        });
      }
      if (u.includes('nominatim.openstreetmap.org')) {
        return makeJsonResponse([]);
      }
      return makeJsonResponse({ code: 'NoRoute' }, 200);
    },
    async () => {
      const res = await handleScreenshotBuildRouteRequest(
        {
          origin,
          destination,
          draft: {
            totalDurationMin: 35,
            segments: [
              { type: 'WALK', durationMin: 8 },
              {
                type: 'TRANSIT',
                vehicleType: 'BUS',
                lineName: '94 金沢大学線',
                departureStopName: '兼六園下',
                arrivalStopName: 'Kanazawadaigakushizenkenmae Bus Stop',
                durationMin: 16,
              },
              { type: 'WALK', durationMin: 12 },
            ],
          },
        },
        { env: {} }
      );
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.draft.segments[1].departureCoord);
      assert.equal(res.body.draft.segments[1].arrivalCoord, null);
    }
  );
});
