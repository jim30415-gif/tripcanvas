import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkRateLimit,
  checkSameOriginRequest,
  isValidHostHeader,
  parseOptionalFiniteNumber,
  resetRateLimitsForTests,
} from '../server/security.js';
import {
  handleComputeRoutes,
  handleReverseGeocode,
  handleSearchPlaces,
} from '../server/routesHandler.js';
import {
  DRIVE_SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  handleDriveCallback,
  handleDrivePull,
  handleDrivePush,
} from '../server/driveHandler.js';
import {
  deriveSessionKey,
  encryptJsonPayload,
} from '../server/driveCrypto.js';
import { createBlankTripState } from '../src/config/demoData.js';
import {
  duplicateTrip,
  getAllTrips,
  parseImportedState,
  replaceWorkspace,
} from '../src/state/store.js';
import { mergeWorkspaces } from '../src/state/workspaceMerge.js';
import {
  buildSearchQueryVariants,
  toTraditionalChinese,
} from '../src/utils/cjkNormalize.js';
import { inferCountryCodeFromCoord } from '../src/utils/geo.js';
import { decodePolyline, encodePolyline } from '../src/services/polyline.js';
import {
  pickReadableChipColor,
  renderImageContent,
  sanitizeExternalUrl,
  sanitizeHexColor,
  sanitizePinImage,
} from '../src/utils/format.js';

const TEST_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret-value-123456',
  SESSION_SECRET: 'test-session-secret-key-for-audit-tests',
};

const PROD_HEADERS = {
  host: 'tripcanvas-ten.vercel.app',
  'x-forwarded-proto': 'https',
  'x-forwarded-host': 'tripcanvas-ten.vercel.app',
};

test('server/security.js: 數字解析、Host 驗證、同源防跨站與速率限制', () => {
  // 1. parseOptionalFiniteNumber 絕不將 null 或空字串轉成 0（一律回傳 NaN）
  assert.equal(Number.isNaN(parseOptionalFiniteNumber(null)), true);
  assert.equal(Number.isNaN(parseOptionalFiniteNumber(undefined)), true);
  assert.equal(Number.isNaN(parseOptionalFiniteNumber('')), true);
  assert.equal(Number.isNaN(parseOptionalFiniteNumber('   ')), true);
  assert.equal(parseOptionalFiniteNumber('0'), 0);
  assert.equal(parseOptionalFiniteNumber(0), 0);
  assert.equal(parseOptionalFiniteNumber('25.0478'), 25.0478);
  assert.equal(Number.isNaN(parseOptionalFiniteNumber('not-a-num')), true);

  // 2. Host 標頭驗證
  assert.equal(isValidHostHeader('tripcanvas-ten.vercel.app'), true);
  assert.equal(isValidHostHeader('localhost:5173'), true);
  assert.equal(isValidHostHeader('evil.com@tripcanvas-ten.vercel.app'), false);
  assert.equal(isValidHostHeader('tripcanvas.app/evil'), false);
  assert.equal(isValidHostHeader(''), false);

  // 3. 同源檢查（防他站盜刷代理）
  assert.equal(
    checkSameOriginRequest({ ...PROD_HEADERS, origin: 'https://tripcanvas-ten.vercel.app' }).ok,
    true
  );
  assert.equal(
    checkSameOriginRequest({ ...PROD_HEADERS, origin: 'https://evil-scraper.example' }).ok,
    false
  );
  assert.equal(
    checkSameOriginRequest({ ...PROD_HEADERS, 'sec-fetch-site': 'cross-site' }).ok,
    false
  );
  assert.equal(
    checkSameOriginRequest(PROD_HEADERS, { VERCEL: '1' }, { requireBrowserSignal: true }).ok,
    false
  );

  // 4. 滑動視窗速率限制
  resetRateLimitsForTests();
  const r1 = checkRateLimit('unit-test', '203.0.113.42', 2, 60_000);
  const r2 = checkRateLimit('unit-test', '203.0.113.42', 2, 60_000);
  const r3 = checkRateLimit('unit-test', '203.0.113.42', 2, 60_000);
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, false);
  assert.equal(r3.statusCode, 429);
  assert.ok(r3.retryAfterSec >= 1);
  resetRateLimitsForTests();
});

test('server/routesHandler.js: null 座標不誤判為 (0,0)、查詢長度限制與極近／跨洲短路保護', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let fetchCalls = 0;
    let capturedSearchBody = null;
    globalThis.fetch = async (url, opts) => {
      fetchCalls++;
      if (String(url).includes('places:searchText')) {
        capturedSearchBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ places: [] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    // 1. handleReverseGeocode(null, null) 必須回傳 400 而非查詢 (0, 0)
    const revNull = await handleReverseGeocode(null, null, { GOOGLE_MAPS_API_KEY: 'test-key' });
    assert.equal(revNull.statusCode, 400);
    assert.equal(fetchCalls, 0);

    // 2. handleSearchPlaces 帶 lat=null, lng=null 時絕不可附加 (0,0) locationBias
    const searchRes = await handleSearchPlaces(
      { q: '台北101', lat: null, lng: null },
      { GOOGLE_MAPS_API_KEY: 'test-key' }
    );
    assert.equal(searchRes.statusCode, 200);
    assert.ok(capturedSearchBody);
    assert.equal(capturedSearchBody.locationBias, undefined);

    // 3. 查詢字串過短 (<2) 直接回傳空清單且不觸發 Google API 計費
    fetchCalls = 0;
    const shortQ = await handleSearchPlaces({ q: '台' }, { GOOGLE_MAPS_API_KEY: 'test-key' });
    assert.equal(shortQ.statusCode, 200);
    assert.deepEqual(shortQ.body.results, []);
    assert.equal(fetchCalls, 0);

    // 4. 起終點距離 < 5m 與 > 3000km 的陸路請求應於計費前短路
    fetchCalls = 0;
    const sameSpot = await handleComputeRoutes(
      {
        mode: 'walk',
        origin: { lat: 25.0478, lng: 121.517 },
        destination: { lat: 25.047801, lng: 121.517001 },
      },
      { GOOGLE_MAPS_API_KEY: 'test-key' }
    );
    assert.equal(sameSpot.statusCode, 200);
    assert.equal(sameSpot.body.status, 'unsupported');
    assert.equal(fetchCalls, 0);

    const transOcean = await handleComputeRoutes(
      {
        mode: 'car',
        origin: { lat: 25.0478, lng: 121.517 },
        destination: { lat: 48.8566, lng: 2.3522 },
      },
      { GOOGLE_MAPS_API_KEY: 'test-key' }
    );
    assert.equal(transOcean.statusCode, 200);
    assert.equal(transOcean.body.status, 'unsupported');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server/driveHandler.js: OAuth state 過期拒收、userinfo fail-closed、409 樂觀鎖衝突與 401 自動刷新重試', async () => {
  const key = deriveSessionKey(TEST_ENV);

  // 1. 過期超過 10 分鐘的 OAuth state Cookie 必須被伺服器端拒絕
  const expiredState = encryptJsonPayload(
    {
      state: 'expired_state_123',
      codeVerifier: 'verifier_abc_1234567890',
      redirectUri: 'https://tripcanvas-ten.vercel.app/api/drive-callback',
      createdAt: Date.now() - 15 * 60 * 1000,
    },
    key
  );
  const expiredCb = await handleDriveCallback({
    query: { code: 'auth-code', state: 'expired_state_123' },
    headers: { ...PROD_HEADERS, cookie: `${OAUTH_STATE_COOKIE}=${expiredState}` },
    env: TEST_ENV,
  });
  assert.equal(expiredCb.statusCode, 302);
  assert.equal(expiredCb.redirectUrl, '/?drive_auth=state_error');

  // 2. userinfo 失敗或缺少 sub 時 fail-closed，不可建立匿名工作階段
  const freshState = encryptJsonPayload(
    {
      state: 'valid_state_456',
      codeVerifier: 'verifier_xyz_1234567890',
      redirectUri: 'https://tripcanvas-ten.vercel.app/api/drive-callback',
      createdAt: Date.now(),
    },
    key
  );
  let userinfoCalled = false;
  const failClosedCb = await handleDriveCallback({
    query: { code: 'auth-code', state: 'valid_state_456' },
    headers: { ...PROD_HEADERS, cookie: `${OAUTH_STATE_COOKIE}=${freshState}` },
    env: TEST_ENV,
    fetchImpl: async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'at_123',
            refresh_token: 'rt_123',
            expires_in: 3600,
            scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
          }),
        };
      }
      userinfoCalled = true;
      return { ok: false, status: 500, json: async () => ({ error: 'internal' }) };
    },
  });
  assert.equal(userinfoCalled, true);
  assert.equal(failClosedCb.statusCode, 302);
  assert.equal(failClosedCb.redirectUrl, '/?drive_auth=token_error');
  assert.equal(
    failClosedCb.cookies.some((c) => c.startsWith(`${DRIVE_SESSION_COOKIE}=`) && !c.includes('Max-Age=0')),
    false
  );

  // 3. Push 樂觀鎖：expectedModifiedTime 與雲端最新版不符時應回傳 409 Conflict
  const sessionToken = encryptJsonPayload(
    {
      accessToken: 'at_active',
      refreshToken: 'rt_active',
      accessTokenExpiresAt: Date.now() + 3600_000,
      user: { sub: 'u_1', email: 'a@example.com', name: 'A', picture: '' },
      driveFolderId: 'folder_1',
      driveFileId: 'file_1',
    },
    key
  );
  const conflictPush = await handleDrivePush({
    body: {
      expectedModifiedTime: '2026-11-24T05:00:00.000Z',
      workspace: { version: 5, activeTripId: 't1', trips: [{ id: 't1', name: 'Test', data: createBlankTripState() }] },
    },
    headers: { ...PROD_HEADERS, cookie: `${DRIVE_SESSION_COOKIE}=${sessionToken}` },
    env: TEST_ENV,
    fetchImpl: async (url) => {
      if (String(url).includes('/drive/v3/files/file_1?fields=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'file_1',
            name: 'tripcanvas-workspace.json',
            modifiedTime: '2026-11-24T06:00:00.000Z',
            trashed: false,
          }),
        };
      }
      throw new Error(`Unexpected URL during conflict check: ${url}`);
    },
  });
  assert.equal(conflictPush.statusCode, 409);
  assert.equal(conflictPush.body.status, 'conflict');
  assert.equal(conflictPush.body.cloudModifiedTime, '2026-11-24T06:00:00.000Z');

  // 4. Pull 遇到 Drive API 401 時應自動強制刷新 accessToken 並單次重試成功
  let metaAttempts = 0;
  let refreshed = false;
  const retryPull = await handleDrivePull({
    headers: { ...PROD_HEADERS, cookie: `${DRIVE_SESSION_COOKIE}=${sessionToken}` },
    env: TEST_ENV,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        refreshed = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at_refreshed_999', expires_in: 3600 }),
        };
      }
      if (u.includes('/drive/v3/files/file_1?fields=')) {
        metaAttempts++;
        if (metaAttempts === 1) {
          return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials' } }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'file_1',
            name: 'tripcanvas-workspace.json',
            modifiedTime: '2026-11-24T06:00:00.000Z',
            trashed: false,
          }),
        };
      }
      if (u.includes('/drive/v3/files/file_1?alt=media')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ version: 5, activeTripId: 't1', trips: [] }),
        };
      }
      throw new Error(`Unexpected URL during 401 retry test: ${u}`);
    },
  });
  assert.equal(refreshed, true);
  assert.equal(metaAttempts, 2);
  assert.equal(retryPull.statusCode, 200);
  assert.equal(retryPull.body.exists, true);
  assert.equal(retryPull.body.file.modifiedTime, '2026-11-24T06:00:00.000Z');
});

test('src/state & format.js: XSS 消毒、多計畫備份檔匯入、複製計畫新 ID 與 tombstone 保護', () => {
  // 1. 匯入含惡意欄位之 JSON 應自動清洗所有顏色、ID、圖片 URL 與交通模式
  const maliciousPayload = JSON.stringify({
    tripName: '消毒測試',
    activeDayId: 'day_1',
    days: [
      {
        id: 'day_1" onclick="alert(1)',
        name: 'Day 1',
        color: '#ff0000;background:url(javascript:alert(1))',
        visible: true,
        pins: [
          {
            id: 'pin"><img src=x onerror=alert(1)>',
            name: '台北車站',
            lat: 25.0478,
            lng: 121.517,
            image: { type: 'url', value: 'javascript:alert(1)' },
            transportToNext: { mode: 'teleport', status: 'ok', evilHtml: '<img onerror=1>' },
          },
        ],
      },
    ],
  });
  const parsed = parseImportedState(maliciousPayload);
  assert.equal(parsed.isWorkspace, false);
  const d0 = parsed.data.days[0];
  assert.match(d0.id, /^[A-Za-z0-9_-]+$/);
  assert.match(d0.color, /^#[0-9A-Fa-f]{6}$/);
  assert.match(d0.pins[0].id, /^[A-Za-z0-9_-]+$/);
  assert.equal(d0.pins[0].image, null);
  assert.equal(d0.pins[0].transportToNext?.mode, 'car');
  assert.equal(d0.pins[0].transportToNext?.evilHtml, undefined);

  // 2. 支援匯入完整工作區備份檔（tripcanvas-workspace.json）
  const wsBackup = JSON.stringify({
    version: 5,
    activeTripId: 'trip_b',
    trips: [
      { id: 'trip_a', name: 'A 行程', data: createBlankTripState() },
      { id: 'trip_b', name: 'B 行程', data: createBlankTripState() },
    ],
  });
  const parsedWs = parseImportedState(wsBackup);
  assert.equal(parsedWs.isWorkspace, true);
  assert.equal(parsedWs.workspace.trips.length, 2);
  assert.equal(parsedWs.tripName, 'B 行程');

  // 3. duplicateTrip 應產生全新 Day/Pin/SubSpot ID（與原行程不重疊）
  const baseTripData = createBlankTripState();
  baseTripData.days[0].pins.push({
    id: 'pin_orig_1',
    name: '原景點',
    lat: 25.0478,
    lng: 121.517,
    image: null,
    notes: '',
    subSpots: [{ id: 'sub_orig_1', name: '咖啡', cost: 120, category: 'food' }],
    transportToNext: null,
  });
  replaceWorkspace({
    version: 5,
    activeTripId: 'trip_orig',
    isPristineDemo: false,
    trips: [{ id: 'trip_orig', name: '原行程', data: baseTripData }],
  });
  const copy = duplicateTrip('trip_orig');
  assert.ok(copy);
  assert.notEqual(copy.data.days[0].id, baseTripData.days[0].id);
  assert.notEqual(copy.data.days[0].pins[0].id, 'pin_orig_1');
  assert.notEqual(copy.data.days[0].pins[0].subSpots[0].id, 'sub_orig_1');
  assert.equal(getAllTrips().length, 2);

  // 4. mergeWorkspaces 若所有計畫皆被刪除而復活保留最後一份，須移除該計畫的 tombstone
  const onlyTrip = {
    id: 'trip_last',
    name: '最後計畫',
    createdAt: '2026-11-24T01:00:00.000Z',
    updatedAt: '2026-11-24T01:00:00.000Z',
    data: createBlankTripState(),
  };
  const allDeletedMerge = mergeWorkspaces(
    {
      version: 5,
      activeTripId: 'trip_last',
      updatedAt: '2026-11-24T02:00:00.000Z',
      isPristineDemo: false,
      deletedTripIds: { trip_last: '2026-11-24T02:00:00.000Z' },
      trips: [onlyTrip],
    },
    {
      version: 5,
      activeTripId: 'trip_last',
      updatedAt: '2026-11-24T02:00:00.000Z',
      isPristineDemo: false,
      deletedTripIds: { trip_last: '2026-11-24T02:00:00.000Z' },
      trips: [onlyTrip],
    }
  );
  assert.equal(allDeletedMerge.workspace.trips.length, 1);
  assert.equal(allDeletedMerge.workspace.deletedTripIds[allDeletedMerge.workspace.trips[0].id], undefined);

  // 5. format.js 工具消毒與內建 SVG data-URI 隔離（不含 inline onerror）
  assert.equal(sanitizeExternalUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeExternalUrl('http://example.com/a.png', { httpsOnly: true }), '');
  assert.equal(sanitizeExternalUrl('https://example.com/a.png', { httpsOnly: true }), 'https://example.com/a.png');
  assert.equal(sanitizePinImage({ type: 'preset', value: 'airport' })?.value, 'airport');
  assert.equal(sanitizePinImage({ type: 'preset', value: '__proto__' }), null);
  assert.equal(sanitizeHexColor('red', '#9A7B5C'), '#9A7B5C');
  assert.equal(pickReadableChipColor('#FFFFFF', '#6B513A'), '#6B513A');
  const presetImgHtml = renderImageContent({ type: 'preset', value: 'nightmarket' });
  assert.ok(presetImgHtml.startsWith('<img src="data:image/svg+xml;charset=utf-8,'));
  assert.equal(presetImgHtml.includes('onerror='), false);
});

test('cjkNormalize / geo / polyline 邊界修正驗證', () => {
  // 1. 不可誤將「對面／西面」轉成「麵」，但片語「拉面」應轉為「拉麵」
  assert.equal(toTraditionalChinese('車站對面'), '車站對面');
  assert.equal(toTraditionalChinese('釜山西面'), '釜山西面');
  assert.equal(toTraditionalChinese('一蘭拉面'), '一蘭拉麵');

  // 2. 「お台場」不可疊加為「おお台場」，「台場」應能產出「お台場」
  const odaibaVariants = buildSearchQueryVariants('お台場', ['JP']).variants;
  assert.equal(odaibaVariants.some((v) => v.includes('おお')), false);
  const daibaVariants = buildSearchQueryVariants('台場', ['JP']).variants;
  assert.equal(daibaVariants.includes('お台場'), true);

  // 3. 北美與歐洲邊界城市國家碼準確度
  assert.equal(inferCountryCodeFromCoord(43.6532, -79.3832), 'CA'); // Toronto
  assert.equal(inferCountryCodeFromCoord(49.2827, -123.1207), 'CA'); // Vancouver
  assert.equal(inferCountryCodeFromCoord(48.1351, 11.582), 'DE'); // Munich
  assert.equal(inferCountryCodeFromCoord(48.5734, 7.7521), 'FR'); // Strasbourg

  // 4. Polyline 濾除 NaN 與越界座標，解碼損毀字串不拋錯且不產出 NaN
  const encoded = encodePolyline([
    [NaN, 121.5],
    [25.0478, 121.517],
    [999, 121.52],
    [25.0339, 121.5645],
  ]);
  const decoded = decodePolyline(encoded);
  assert.equal(decoded.length, 2);
  const corrupt = decodePolyline('~~~~~~~~~~~');
  assert.ok(Array.isArray(corrupt));
  assert.equal(corrupt.some(([la, ln]) => !Number.isFinite(la) || !Number.isFinite(ln)), false);
});
