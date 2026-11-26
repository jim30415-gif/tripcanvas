import test from 'node:test';
import assert from 'node:assert/strict';

import { handleStaticMapRequest } from '../server/staticMap.js';
import {
  A4_HEIGHT,
  A4_WIDTH,
  buildAllTripA4PageSpecs,
  calcDaysSummaryStats,
  computeMapViewport,
  computeScaleBar,
  latLngToWorldPx,
  planA4DayPages,
  planA4OverviewPages,
  projectLatLngToMapPx,
  sanitizeExportFilename,
  worldYToLat,
} from '../src/services/a4PosterExporter.js';

function withMockedFetch(mockImpl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function makePins(count, baseLat = 22.66, baseLng = 121.48) {
  return Array.from({ length: count }, (_, idx) => ({
    id: `pin_${idx + 1}`,
    name: `景點 ${idx + 1}`,
    lat: baseLat + idx * 0.004,
    lng: baseLng + idx * 0.003,
    notes: `備註 ${idx + 1}`,
    subSpots: [{ id: `s_${idx}`, name: '門票', cost: 100, category: 'other' }],
    transportToNext:
      idx < count - 1
        ? { mode: 'scooter', distanceKm: 2.5, duration: 7, cost: 50 }
        : null,
  }));
}

test('handleStaticMapRequest returns unconfigured when GOOGLE_MAPS_API_KEY is missing', async () => {
  const res = await handleStaticMapRequest(
    { lat: 22.66, lng: 121.48, zoom: 13, width: 620, height: 248 },
    {}
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'unconfigured');
  assert.equal(res.body.provider, 'none');
});

test('handleStaticMapRequest rejects invalid coordinates with 400', async () => {
  const res1 = await handleStaticMapRequest(
    { lat: 95, lng: 121.5, zoom: 13 },
    { GOOGLE_MAPS_API_KEY: 'test-key' }
  );
  assert.equal(res1.statusCode, 400);
  assert.equal(res1.body.error, 'INVALID_COORDS');

  const res2 = await handleStaticMapRequest(
    { lat: 'abc', lng: 121.5 },
    { GOOGLE_MAPS_API_KEY: 'test-key' }
  );
  assert.equal(res2.statusCode, 400);
  assert.equal(res2.body.error, 'INVALID_COORDS');
});

test('handleStaticMapRequest gracefully degrades on Google 403 without leaking API key', async () => {
  await withMockedFetch(
    async () => ({
      ok: false,
      status: 403,
      headers: { get: () => 'text/plain' },
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
    async () => {
      const res = await handleStaticMapRequest(
        { lat: 22.66, lng: 121.48, zoom: 13, width: 620, height: 248 },
        { GOOGLE_MAPS_API_KEY: 'SECRET_KEY_12345' }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'unavailable');
      assert.equal(res.body.reason, 'STATIC_MAP_FORBIDDEN');
      assert.ok(!JSON.stringify(res).includes('SECRET_KEY_12345'));
    }
  );
});

test('handleStaticMapRequest fetches clamped 2x PNG and returns Base64 data URL', async () => {
  let capturedUrl = '';
  const fakePng = Buffer.alloc(512, 0x89);

  await withMockedFetch(
    async (url) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => fakePng.buffer.slice(fakePng.byteOffset, fakePng.byteOffset + fakePng.byteLength),
      };
    },
    async () => {
      const res = await handleStaticMapRequest(
        { lat: 22.661234, lng: 121.485678, zoom: 14, width: 999, height: 50, language: 'bad lang!!' },
        { GOOGLE_MAPS_API_KEY: 'test-static-key' }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.provider, 'google');
      // width clamped to 640 -> 2x = 1280; height clamped to 120 -> 2x = 240
      assert.equal(res.body.width, 1280);
      assert.equal(res.body.height, 240);
      assert.ok(res.body.dataUrl.startsWith('data:image/png;base64,'));

      const parsed = new URL(capturedUrl);
      assert.equal(parsed.searchParams.get('size'), '640x120');
      assert.equal(parsed.searchParams.get('scale'), '2');
      assert.equal(parsed.searchParams.get('format'), 'png');
      assert.equal(parsed.searchParams.get('language'), 'zh-TW');
      assert.equal(parsed.searchParams.get('zoom'), '14');
    }
  );
});

test('handleStaticMapRequest marks undersized image payload as STATIC_MAP_EMPTY', async () => {
  await withMockedFetch(
    async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array(64).buffer,
    }),
    async () => {
      const res = await handleStaticMapRequest(
        { lat: 25.033, lng: 121.565, zoom: 13 },
        { GOOGLE_MAPS_API_KEY: 'test-key' }
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'unavailable');
      assert.equal(res.body.reason, 'STATIC_MAP_EMPTY');
    }
  );
});

test('A4 canvas dimensions strictly match 150 DPI A4 portrait ratio (210x297mm)', () => {
  assert.equal(A4_WIDTH, 1240);
  assert.equal(A4_HEIGHT, 1754);
  const ratio = A4_HEIGHT / A4_WIDTH;
  const isoA4Ratio = 297 / 210;
  assert.ok(Math.abs(ratio - isoA4Ratio) < 0.001);
});

test('Web Mercator projection round-trips accurately and keeps all points inside viewport bounds', () => {
  for (const lat of [0, 22.658, 25.033, 35.681, 43.062]) {
    const [, y] = latLngToWorldPx(lat, 121.5, 12);
    const backLat = worldYToLat(y, 12);
    assert.ok(Math.abs(backLat - lat) < 1e-6, `Expected round-trip latitude near ${lat}, got ${backLat}`);
  }

  const greenIslandPts = [
    [22.6776, 121.4717],
    [22.6627, 121.4694],
    [22.6406, 121.5008],
    [22.6378, 121.4919],
    [22.6716, 121.4981],
  ];
  const cssW = 620;
  const cssH = 248;
  const vp = computeMapViewport(greenIslandPts, cssW, cssH);
  assert.ok(vp.zoom >= 11 && vp.zoom <= 16);

  for (const [lat, lng] of greenIslandPts) {
    const [px, py] = projectLatLngToMapPx(lat, lng, vp, cssW, cssH, 2);
    assert.ok(px >= 60 && px <= cssW * 2 - 60, `x=${px} out of safe horizontal bounds`);
    assert.ok(py >= 30 && py <= cssH * 2 - 30, `y=${py} out of safe vertical bounds`);
  }

  const singleVp = computeMapViewport([[25.033, 121.565]], cssW, cssH);
  assert.equal(singleVp.zoom, 15);
  assert.equal(singleVp.centerLat, 25.033);
});

test('computeScaleBar yields readable rounded metric labels and bounded bar width', () => {
  const s1 = computeScaleBar(22.66, 13, 2);
  assert.match(s1.label, /^\d+\s(?:m|km)$/);
  assert.ok(s1.pxWidth >= 54 && s1.pxWidth <= 180);

  const s2 = computeScaleBar(35.68, 16, 2);
  assert.ok(s2.meters < s1.meters);
});

test('planA4DayPages adapts between single-col, two-col, and multi-page A4 pagination', () => {
  const daySmall = { id: 'd1', name: 'Day 1', color: '#C46D4E', pins: makePins(4) };
  const smallPages = planA4DayPages(daySmall, { density: 'detailed' });
  assert.equal(smallPages.length, 1);
  assert.equal(smallPages[0].layout, 'single-col');
  assert.equal(smallPages[0].includeMap, true);
  assert.equal(smallPages[0].includeBudget, true);

  const dayMed = { id: 'd2', name: 'Day 2', color: '#4E7D5E', pins: makePins(8) };
  const medPages = planA4DayPages(dayMed, { density: 'detailed' });
  assert.equal(medPages.length, 1);
  assert.equal(medPages[0].layout, 'two-col');
  assert.equal(medPages[0].pinStart, 0);
  assert.equal(medPages[0].pinEnd, 8);

  const dayLarge = { id: 'd3', name: 'Day 3', color: '#50729B', pins: makePins(15) };
  const largeDetailed = planA4DayPages(dayLarge, { density: 'detailed' });
  assert.equal(largeDetailed.length, 2);
  assert.equal(largeDetailed[0].pinStart, 0);
  assert.equal(largeDetailed[0].pinEnd, 10);
  assert.equal(largeDetailed[0].includeMap, true);
  assert.equal(largeDetailed[0].includeBudget, false);
  assert.equal(largeDetailed[1].pinStart, 10);
  assert.equal(largeDetailed[1].pinEnd, 15);
  assert.equal(largeDetailed[1].includeMap, false);
  assert.equal(largeDetailed[1].includeBudget, true);

  const largeCompact = planA4DayPages(dayLarge, { density: 'compact' });
  assert.equal(largeCompact.length, 2);
  assert.equal(largeCompact[0].pinEnd, 12);
  assert.equal(largeCompact[1].pinStart, 12);
  assert.equal(largeCompact[1].pinEnd, 15);
});

test('planA4OverviewPages & buildAllTripA4PageSpecs paginate long trips cleanly', () => {
  const eightDays = Array.from({ length: 8 }, (_, idx) => ({
    id: `day_${idx + 1}`,
    name: `Day ${idx + 1}`,
    color: '#9A7B5C',
    pins: makePins(3),
  }));

  const overviewPages = planA4OverviewPages(eightDays);
  assert.equal(overviewPages.length, 2);
  assert.equal(overviewPages[0].days.length, 6);
  assert.equal(overviewPages[0].includeMap, true);
  assert.equal(overviewPages[0].includeBudget, false);
  assert.equal(overviewPages[1].days.length, 2);
  assert.equal(overviewPages[1].includeMap, false);
  assert.equal(overviewPages[1].includeBudget, true);

  const allSpecs = buildAllTripA4PageSpecs({ days: eightDays });
  assert.equal(allSpecs.length, 2 + 8);
  assert.equal(allSpecs[0].kind, 'overview');
  assert.equal(allSpecs[2].kind, 'day');
  assert.equal(allSpecs[2].dayId, 'day_1');
});

test('calcDaysSummaryStats aggregates sub-spot categories and transport expenses', () => {
  const days = [
    {
      id: 'd1',
      name: 'Day 1',
      pins: [
        {
          id: 'p1',
          name: 'A',
          subSpots: [
            { name: '拉麵', cost: 280, category: 'food' },
            { name: '門票', cost: 150, category: 'other' },
          ],
          transportToNext: { mode: 'transit', distanceKm: 4.2, duration: 18, cost: 65 },
        },
        {
          id: 'p2',
          name: 'B',
          subSpots: [{ name: '飯店', cost: 3200, category: 'lodging' }],
          transportToNext: null,
        },
      ],
    },
  ];
  const stats = calcDaysSummaryStats(days);
  assert.equal(stats.pinCount, 2);
  assert.equal(stats.totalKm, 4.2);
  assert.equal(stats.totalDurationMin, 18);
  assert.equal(stats.catTotals.food, 280);
  assert.equal(stats.catTotals.other, 150);
  assert.equal(stats.catTotals.transport, 65);
  assert.equal(stats.catTotals.lodging, 3200);
  assert.equal(stats.totalCost, 3695);
});

test('sanitizeExportFilename removes invalid filename characters', () => {
  assert.equal(sanitizeExportFilename('綠島 3天2夜 / 潛水:行程*?'), '綠島_3天2夜_潛水_行程');
  assert.equal(sanitizeExportFilename('   '), '漫旅行程');
});
