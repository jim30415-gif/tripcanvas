import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveSessionKey,
  encryptJsonPayload,
  decryptJsonPayload,
  parseCookies,
  serializeCookie,
} from '../server/driveCrypto.js';
import {
  DRIVE_FILE_SCOPE,
  DRIVE_SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  handleDriveCallback,
  handleDriveLogin,
  handleDriveLogout,
  handleDrivePull,
  handleDrivePush,
  handleDriveStatus,
} from '../server/driveHandler.js';
import { mergeWorkspaces } from '../src/state/workspaceMerge.js';
import { createDemoState, createBlankTripState } from '../src/config/demoData.js';

const TEST_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret-xyz',
};

const PROD_HEADERS = {
  host: 'tripcanvas-ten.vercel.app',
  'x-forwarded-proto': 'https',
};

function extractCookiePair(setCookieStr) {
  return String(setCookieStr || '').split(';')[0];
}

test('AES-256-GCM session cookie encryption round-trip and tamper resistance', () => {
  const key = deriveSessionKey(TEST_ENV);
  assert.equal(key.length, 32);

  const original = { refreshToken: 'rt_123', user: { email: 'solo@example.com' } };
  const token = encryptJsonPayload(original, key);
  assert.deepEqual(decryptJsonPayload(token, key), original);

  // 竄改任一字元皆應解密失敗
  const tampered = `${token.slice(0, -2)}AA`;
  assert.equal(decryptJsonPayload(tampered, key), null);

  const wrongKey = deriveSessionKey({
    GOOGLE_OAUTH_CLIENT_ID: 'other',
    GOOGLE_OAUTH_CLIENT_SECRET: 'other',
  });
  assert.equal(decryptJsonPayload(token, wrongKey), null);

  const serialized = serializeCookie('tc_test', 'hello=world', { maxAge: 3600, secure: true });
  assert.match(serialized, /HttpOnly/);
  assert.match(serialized, /SameSite=Lax/);
  assert.match(serialized, /Secure/);
  const parsedCookie = parseCookies(extractCookiePair(serialized));
  assert.equal(Object.getPrototypeOf(parsedCookie), null);
  assert.equal(parsedCookie.tc_test, 'hello=world');
});

test('handleDriveStatus reflects unconfigured vs configured state and dynamic redirect URI', () => {
  const uncfg = handleDriveStatus({ headers: PROD_HEADERS, env: {} });
  assert.equal(uncfg.statusCode, 200);
  assert.equal(uncfg.body.configured, false);
  assert.equal(uncfg.body.authenticated, false);

  const cfg = handleDriveStatus({ headers: PROD_HEADERS, env: TEST_ENV });
  assert.equal(cfg.statusCode, 200);
  assert.equal(cfg.body.configured, true);
  assert.equal(cfg.body.authenticated, false);
  assert.equal(cfg.body.redirectUri, 'https://tripcanvas-ten.vercel.app/api/drive-callback');
});

test('Google OAuth login -> callback -> pull -> push -> refresh -> logout lifecycle', async () => {
  // 1. 登入重導向至 Google OAuth（含 PKCE 與 drive.file 非敏感權限）
  const loginRes = handleDriveLogin({ headers: PROD_HEADERS, env: TEST_ENV });
  assert.equal(loginRes.statusCode, 302);
  const authUrl = new URL(loginRes.redirectUrl);
  assert.equal(authUrl.origin, 'https://accounts.google.com');
  assert.equal(authUrl.searchParams.get('client_id'), TEST_ENV.GOOGLE_OAUTH_CLIENT_ID);
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://tripcanvas-ten.vercel.app/api/drive-callback');
  assert.equal(authUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authUrl.searchParams.get('scope').includes(DRIVE_FILE_SCOPE));
  const oauthState = authUrl.searchParams.get('state');
  const stateCookiePair = extractCookiePair(loginRes.cookies[0]);
  assert.ok(stateCookiePair.startsWith(`${OAUTH_STATE_COOKIE}=`));

  // 2. Callback 驗證 CSRF state 不符應拒絕
  const badStateRes = await handleDriveCallback({
    query: { code: 'abc', state: 'wrong_state' },
    headers: { ...PROD_HEADERS, cookie: stateCookiePair },
    env: TEST_ENV,
  });
  assert.equal(badStateRes.redirectUrl, '/?drive_auth=state_error');

  // 3. Callback 驗證缺少 drive.file 權限應引導重新勾選
  const missingScopeRes = await handleDriveCallback({
    query: { code: 'auth_code_1', state: oauthState },
    headers: { ...PROD_HEADERS, cookie: stateCookiePair },
    env: TEST_ENV,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'at_initial',
        refresh_token: 'rt_perm',
        expires_in: 3600,
        scope: 'openid email profile',
      }),
    }),
  });
  assert.equal(missingScopeRes.redirectUrl, '/?drive_auth=missing_scope');

  // 4. 正常 Callback 換取 token 並寫入加密 session cookie
  const okCallbackRes = await handleDriveCallback({
    query: { code: 'auth_code_2', state: oauthState },
    headers: { ...PROD_HEADERS, cookie: stateCookiePair },
    env: TEST_ENV,
    fetchImpl: async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'at_live_1',
            refresh_token: 'rt_live_1',
            expires_in: 3600,
            scope: `openid email profile ${DRIVE_FILE_SCOPE}`,
          }),
        };
      }
      if (String(url).includes('userinfo')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sub: 'user_sub_99',
            email: 'traveler@gmail.com',
            name: '獨旅旅人',
            picture: 'https://example.com/avatar.png',
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(okCallbackRes.statusCode, 302);
  assert.equal(okCallbackRes.redirectUrl, '/?drive_auth=connected');
  const sessionSetCookie = okCallbackRes.cookies.find((c) => c.startsWith(`${DRIVE_SESSION_COOKIE}=`));
  assert.ok(sessionSetCookie);
  const sessionCookiePair = extractCookiePair(sessionSetCookie);

  // 5. Status 應顯示已登入與使用者資訊
  const authedStatus = handleDriveStatus({
    headers: { ...PROD_HEADERS, cookie: sessionCookiePair },
    env: TEST_ENV,
  });
  assert.equal(authedStatus.body.authenticated, true);
  assert.equal(authedStatus.body.user.email, 'traveler@gmail.com');

  // 6. 首次 Pull（雲端尚無同步檔）
  const emptyPull = await handleDrivePull({
    headers: { ...PROD_HEADERS, cookie: sessionCookiePair },
    env: TEST_ENV,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ files: [] }),
    }),
  });
  assert.equal(emptyPull.statusCode, 200);
  assert.equal(emptyPull.body.exists, false);

  // 7. 首次 Push（建立資料夾＋multipart 上傳 tripcanvas-workspace.json）
  const sampleWorkspace = {
    version: 5,
    activeTripId: 'trip_tokyo',
    updatedAt: '2026-11-24T05:00:00.000Z',
    isPristineDemo: false,
    deletedTripIds: {},
    trips: [
      {
        id: 'trip_tokyo',
        name: '東京 5 日獨旅',
        createdAt: '2026-11-24T05:00:00.000Z',
        updatedAt: '2026-11-24T05:00:00.000Z',
        data: createBlankTripState(),
      },
    ],
  };

  let savedCloudJson = '';
  const firstPush = await handleDrivePush({
    body: { workspace: sampleWorkspace },
    headers: { ...PROD_HEADERS, cookie: sessionCookiePair },
    env: TEST_ENV,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.includes('/drive/v3/files?') && opts.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ files: [] }) };
      }
      if (u.includes('/drive/v3/files?fields=id,name') && opts.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'folder_tc_1', name: '漫步地圖 TripCanvas' }) };
      }
      if (u.includes('/upload/drive/v3/files?uploadType=multipart') && opts.method === 'POST') {
        savedCloudJson = String(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'file_ws_1',
            name: 'tripcanvas-workspace.json',
            modifiedTime: '2026-11-24T05:01:00.000Z',
            size: '512',
          }),
        };
      }
      throw new Error(`Unexpected push URL: ${opts.method} ${u}`);
    },
  });
  assert.equal(firstPush.statusCode, 200);
  assert.equal(firstPush.body.file.id, 'file_ws_1');
  assert.ok(savedCloudJson.includes('東京 5 日獨旅'));
  assert.ok(firstPush.cookies.length === 1);
  const updatedCookiePair = extractCookiePair(firstPush.cookies[0]);

  // 8. 第二次 Push 應直接走快速 PATCH 媒體更新（已知 fileId）
  let patchCalled = false;
  const secondPush = await handleDrivePush({
    body: { workspace: sampleWorkspace },
    headers: { ...PROD_HEADERS, cookie: updatedCookiePair },
    env: TEST_ENV,
    fetchImpl: async (url, opts) => {
      if (String(url).includes('/upload/drive/v3/files/file_ws_1?uploadType=media') && opts.method === 'PATCH') {
        patchCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'file_ws_1',
            name: 'tripcanvas-workspace.json',
            modifiedTime: '2026-11-24T05:02:00.000Z',
            trashed: false,
          }),
        };
      }
      throw new Error(`Unexpected second push URL: ${opts.method} ${url}`);
    },
  });
  assert.equal(secondPush.statusCode, 200);
  assert.equal(patchCalled, true);

  // 9. Access token 過期且 refresh token 被撤銷時，應回傳 401 auth_expired 並清除 Cookie
  const key = deriveSessionKey(TEST_ENV);
  const expiredTokenCookie = `${DRIVE_SESSION_COOKIE}=${encodeURIComponent(
    encryptJsonPayload(
      {
        refreshToken: 'rt_revoked',
        accessToken: 'at_old',
        accessTokenExpiresAt: Date.now() - 10_000,
        user: { email: 'traveler@gmail.com' },
      },
      key
    )
  )}`;
  const expiredPull = await handleDrivePull({
    headers: { ...PROD_HEADERS, cookie: expiredTokenCookie },
    env: TEST_ENV,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    }),
  });
  assert.equal(expiredPull.statusCode, 401);
  assert.equal(expiredPull.body.status, 'auth_expired');
  assert.ok(expiredPull.cookies.some((c) => c.includes('Max-Age=0')));

  // 10. 登出清除 Cookie
  const logoutRes = handleDriveLogout({ headers: PROD_HEADERS });
  assert.equal(logoutRes.statusCode, 200);
  assert.ok(logoutRes.cookies.some((c) => c.startsWith(`${DRIVE_SESSION_COOKIE}=`) && c.includes('Max-Age=0')));
});

test('mergeWorkspaces protects cloud data from pristine demo browsers and merges cross-device edits safely', () => {
  const demoWs = {
    version: 5,
    activeTripId: 'trip_demo_fresh',
    updatedAt: '2026-11-24T06:00:00.000Z',
    isPristineDemo: true,
    deletedTripIds: {},
    trips: [
      {
        id: 'trip_demo_fresh',
        name: '台北 2 日示範行程',
        createdAt: '2026-11-24T06:00:00.000Z',
        updatedAt: '2026-11-24T06:00:00.000Z',
        data: createDemoState(),
      },
    ],
  };

  const cloudWs = {
    version: 5,
    activeTripId: 'trip_kyoto',
    updatedAt: '2026-11-23T12:00:00.000Z',
    isPristineDemo: false,
    deletedTripIds: {},
    trips: [
      {
        id: 'trip_kyoto',
        name: '京都關西 5 日',
        createdAt: '2026-11-20T10:00:00.000Z',
        updatedAt: '2026-11-23T12:00:00.000Z',
        data: createBlankTripState(),
      },
    ],
  };

  // 1. 全新瀏覽器預設示範絕不覆蓋雲端既有行程
  const freshRes = mergeWorkspaces(demoWs, cloudWs);
  assert.equal(freshRes.action, 'use_cloud');
  assert.equal(freshRes.workspace.trips.length, 1);
  assert.equal(freshRes.workspace.trips[0].id, 'trip_kyoto');

  // 2. 兩台裝置各有不同新計畫 → 雙向合併保留兩者，並濾除重複的未修改示範行程
  const phoneEditedWs = {
    version: 5,
    activeTripId: 'trip_okinawa',
    updatedAt: '2026-11-24T07:00:00.000Z',
    isPristineDemo: false,
    deletedTripIds: {},
    trips: [
      {
        id: 'trip_okinawa',
        name: '沖繩 4 日自駕',
        createdAt: '2026-11-24T07:00:00.000Z',
        updatedAt: '2026-11-24T07:00:00.000Z',
        data: createBlankTripState(),
      },
      {
        id: 'trip_phone_demo',
        name: '台北 2 日示範行程',
        createdAt: '2026-11-24T06:50:00.000Z',
        updatedAt: '2026-11-24T06:50:00.000Z',
        data: createDemoState(),
      },
    ],
  };

  const mergedRes = mergeWorkspaces(phoneEditedWs, cloudWs);
  assert.equal(mergedRes.action, 'merged_push');
  assert.deepEqual(
    mergedRes.workspace.trips.map((t) => t.id),
    ['trip_okinawa', 'trip_kyoto']
  );
  assert.equal(mergedRes.workspace.activeTripId, 'trip_okinawa');

  // 3. 若某裝置明確刪除行程（deletedTripIds 時間新於該行程 updatedAt），合併時不應復活
  const cloudWithDeletion = {
    ...cloudWs,
    updatedAt: '2026-11-24T08:00:00.000Z',
    deletedTripIds: { trip_okinawa: '2026-11-24T08:00:00.000Z' },
  };
  const delRes = mergeWorkspaces(phoneEditedWs, cloudWithDeletion);
  assert.deepEqual(
    delRes.workspace.trips.map((t) => t.id),
    ['trip_kyoto']
  );
});
