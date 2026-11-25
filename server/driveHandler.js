import {
  deriveSessionKey,
  encryptJsonPayload,
  decryptJsonPayload,
  generateRandomHex,
  generatePkcePair,
  timingSafeEqualStr,
  parseCookies,
  serializeCookie,
} from './driveCrypto.js';
import {
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
  getHeader,
  isValidHostHeader,
} from './security.js';

export const DRIVE_SESSION_COOKIE = 'tc_drive_session';
export const OAUTH_STATE_COOKIE = 'tc_drive_oauth_state';
export const DRIVE_FOLDER_NAME = '漫步地圖 TripCanvas';
export const DRIVE_WORKSPACE_FILE_NAME = 'tripcanvas-workspace.json';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const OAUTH_SCOPES = ['openid', 'email', 'profile', DRIVE_FILE_SCOPE];

const SESSION_MAX_AGE_SEC = 180 * 24 * 60 * 60; // 180 天
const OAUTH_STATE_MAX_AGE_SEC = 10 * 60; // 10 分鐘
const MAX_WORKSPACE_BYTES = 3.8 * 1024 * 1024; // 低於 Vercel 4.5 MB 上限
const UPSTREAM_TIMEOUT_MS = 8500;

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';

export function getGoogleOAuthConfig(env = {}) {
  const clientId = (env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '').trim();
  const explicitRedirectUri = (env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  const sessionKey = deriveSessionKey(env);
  return {
    clientId,
    clientSecret,
    explicitRedirectUri,
    sessionKey,
    configured: Boolean(clientId && clientSecret && sessionKey),
  };
}

export function getRequestOrigin(headers = {}) {
  const rawForwardedHost = getHeader(headers, 'x-forwarded-host').split(',')[0].trim();
  const rawHost = getHeader(headers, 'host').split(',')[0].trim();
  const host = isValidHostHeader(rawForwardedHost)
    ? rawForwardedHost
    : isValidHostHeader(rawHost)
      ? rawHost
      : 'localhost:5173';
  const rawProto = getHeader(headers, 'x-forwarded-proto').split(',')[0].trim().toLowerCase();
  const isLocalHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : isLocalHost ? 'http' : 'https';
  return `${proto}://${host}`;
}

export function isSecureRequest(headers = {}, env = {}) {
  if (env?.VERCEL === '1' || env?.NODE_ENV === 'production') {
    const origin = getRequestOrigin(headers);
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return true;
    }
  }
  return getRequestOrigin(headers).startsWith('https://');
}

export function getRedirectUri(headers = {}, env = {}) {
  const cfg = getGoogleOAuthConfig(env);
  if (cfg.explicitRedirectUri) return cfg.explicitRedirectUri;
  return `${getRequestOrigin(headers)}/api/drive-callback`;
}

function readSessionFromHeaders(headers, sessionKey) {
  if (!sessionKey) return null;
  const cookies = parseCookies(getHeader(headers, 'cookie'));
  const raw = cookies[DRIVE_SESSION_COOKIE];
  if (!raw) return null;
  const session = decryptJsonPayload(raw, sessionKey);
  if (!session || typeof session !== 'object' || !session.refreshToken) return null;
  return session;
}

function sanitizeUserPicture(raw) {
  const str = String(raw || '').trim().slice(0, 512);
  if (!str) return '';
  try {
    const u = new URL(str);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function buildSessionCookie(session, sessionKey, secure) {
  const compact = {
    refreshToken: String(session.refreshToken || ''),
    accessToken: String(session.accessToken || ''),
    accessTokenExpiresAt: Number(session.accessTokenExpiresAt) || 0,
    driveFileId: session.driveFileId || null,
    driveFolderId: session.driveFolderId || null,
    user: session.user
      ? {
          sub: String(session.user.sub || '').slice(0, 128),
          email: String(session.user.email || '').slice(0, 256),
          name: String(session.user.name || '').slice(0, 128),
          picture: sanitizeUserPicture(session.user.picture),
        }
      : null,
  };
  let encrypted = encryptJsonPayload(compact, sessionKey);
  // 若 Google 核發過長 accessToken 導致 Cookie 逼近瀏覽器 4096 bytes 上限，自動改為省略快取 accessToken（保留 refreshToken）
  if (encrypted.length > 3600 && compact.accessToken) {
    compact.accessToken = '';
    compact.accessTokenExpiresAt = 0;
    encrypted = encryptJsonPayload(compact, sessionKey);
  }
  return serializeCookie(DRIVE_SESSION_COOKIE, encrypted, {
    maxAge: SESSION_MAX_AGE_SEC,
    httpOnly: true,
    sameSite: 'Lax',
    secure,
  });
}

function clearCookie(name, secure) {
  return serializeCookie(name, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'Lax',
    secure,
  });
}

class DriveAuthExpiredError extends Error {
  constructor(message = 'Google 登入授權已過期，請重新登入') {
    super(message);
    this.code = 'AUTH_EXPIRED';
  }
}

class DriveScopeError extends Error {
  constructor(message = '缺少 Google 雲端硬碟存取權限，請重新登入並勾選允許') {
    super(message);
    this.code = 'INSUFFICIENT_SCOPE';
  }
}

async function ensureFreshAccessToken(session, cfg, fetchImpl = fetch, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && session.accessToken && Number(session.accessTokenExpiresAt) > now + 60_000) {
    return { session, changed: false, refreshedNow: false };
  }

  const form = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: session.refreshToken,
    grant_type: 'refresh_token',
  });

  const { res, data } = await fetchJsonWithTimeout(
    fetchImpl,
    GOOGLE_TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
    UPSTREAM_TIMEOUT_MS
  );

  if (!res.ok || !data?.access_token) {
    const errCode = data?.error || '';
    if (res.status === 400 || res.status === 401 || errCode === 'invalid_grant') {
      throw new DriveAuthExpiredError('Google 登入授權已失效或過期，請重新登入');
    }
    throw new Error(data?.error_description || `Google Token 更新失敗 (${res.status})`);
  }

  const expiresInSec = Number(data.expires_in) || 3500;
  const updated = {
    ...session,
    accessToken: data.access_token,
    accessTokenExpiresAt: now + expiresInSec * 1000,
    refreshToken: data.refresh_token || session.refreshToken,
  };
  return { session: updated, changed: true, refreshedNow: true };
}

/**
 * 若使用快取中的 accessToken 遇到 401，先強制更新一次 refresh_token 後重試，
 * 避免 Google 提早撤銷單一 accessToken 或時鐘偏移導致使用者被誤登出。
 */
async function runWithTokenRetry(initialSession, cfg, fetchImpl, workFn) {
  let { session, changed, refreshedNow } = await ensureFreshAccessToken(initialSession, cfg, fetchImpl);
  try {
    const output = await workFn(session);
    return { session: output.session || session, changed: changed || Boolean(output.changed), result: output.result };
  } catch (err) {
    if (!refreshedNow && (err instanceof DriveAuthExpiredError || err?.code === 'AUTH_EXPIRED')) {
      const refreshed = await ensureFreshAccessToken(session, cfg, fetchImpl, { forceRefresh: true });
      session = refreshed.session;
      changed = true;
      const output = await workFn(session);
      return { session: output.session || session, changed: true, result: output.result };
    }
    throw err;
  }
}

async function driveFetchJson(url, accessToken, options = {}, fetchImpl = fetch) {
  const { res, data } = await fetchJsonWithTimeout(
    fetchImpl,
    url,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
    },
    UPSTREAM_TIMEOUT_MS
  );
  if (res.status === 401) {
    throw new DriveAuthExpiredError('Google 存取憑證已失效，請重新登入');
  }
  if (res.status === 403) {
    const reason = data?.error?.errors?.[0]?.reason || '';
    if (reason === 'insufficientPermissions' || reason === 'insufficientFilePermissions') {
      throw new DriveScopeError();
    }
  }
  return { res, data };
}

async function getWorkspaceFileMeta(accessToken, fileId, fetchImpl = fetch) {
  const url = `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime,size,trashed,parents`;
  const { res, data } = await driveFetchJson(url, accessToken, { method: 'GET' }, fetchImpl);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(data?.error?.message || `查詢 Google Drive 檔案資訊失敗 (${res.status})`);
  }
  return data;
}

export async function findWorkspaceFile(accessToken, fetchImpl = fetch) {
  const q =
    "appProperties has { key='app' and value='tripcanvas' } and appProperties has { key='kind' and value='workspace' } and trashed = false";
  const params = new URLSearchParams({
    q,
    spaces: 'drive',
    orderBy: 'modifiedTime desc',
    pageSize: '5',
    fields: 'files(id,name,modifiedTime,size,parents)',
  });
  const { res, data } = await driveFetchJson(
    `${DRIVE_FILES_ENDPOINT}?${params.toString()}`,
    accessToken,
    { method: 'GET' },
    fetchImpl
  );
  if (!res.ok) {
    throw new Error(data?.error?.message || `查詢 Google Drive 檔案失敗 (${res.status})`);
  }
  const files = Array.isArray(data?.files) ? data.files : [];
  return files[0] || null;
}

export async function findOrCreateAppFolder(accessToken, fetchImpl = fetch) {
  const q =
    "appProperties has { key='app' and value='tripcanvas' } and appProperties has { key='kind' and value='root_folder' } and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const params = new URLSearchParams({
    q,
    spaces: 'drive',
    orderBy: 'modifiedTime desc',
    pageSize: '3',
    fields: 'files(id,name)',
  });
  const listResp = await driveFetchJson(
    `${DRIVE_FILES_ENDPOINT}?${params.toString()}`,
    accessToken,
    { method: 'GET' },
    fetchImpl
  );
  if (!listResp.res.ok) {
    throw new Error(listResp.data?.error?.message || `查詢 Google Drive 資料夾失敗 (${listResp.res.status})`);
  }
  const existing = Array.isArray(listResp.data?.files) ? listResp.data.files[0] : null;
  if (existing?.id) return existing.id;

  const createResp = await driveFetchJson(
    `${DRIVE_FILES_ENDPOINT}?fields=id,name`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: {
          app: 'tripcanvas',
          kind: 'root_folder',
        },
      }),
    },
    fetchImpl
  );
  if (!createResp.res.ok || !createResp.data?.id) {
    throw new Error(createResp.data?.error?.message || `建立 Google Drive 資料夾失敗 (${createResp.res.status})`);
  }
  return createResp.data.id;
}

async function downloadWorkspaceFile(accessToken, fileId, fetchImpl = fetch) {
  const url = `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`;
  const { res, text } = await fetchTextWithTimeout(
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    UPSTREAM_TIMEOUT_MS
  );
  if (res.status === 401) {
    throw new DriveAuthExpiredError('Google 存取憑證已失效，請重新登入');
  }
  if (res.status === 403) {
    let errData = null;
    try {
      errData = text ? JSON.parse(text) : null;
    } catch {
      errData = null;
    }
    const reason = errData?.error?.errors?.[0]?.reason || '';
    if (reason === 'insufficientPermissions' || reason === 'insufficientFilePermissions') {
      throw new DriveScopeError();
    }
    throw new Error(errData?.error?.message || `讀取 Google Drive 行程檔權限不足 (${res.status})`);
  }
  if (res.status === 404) {
    return { notFound: true, workspace: null };
  }
  if (!res.ok) {
    throw new Error(`讀取 Google Drive 行程檔失敗 (${res.status})`);
  }
  try {
    return { notFound: false, workspace: JSON.parse(text) };
  } catch {
    return { notFound: false, corrupted: true, workspace: null };
  }
}

async function patchWorkspaceMedia(accessToken, fileId, jsonText, fetchImpl = fetch) {
  const url = `${DRIVE_UPLOAD_ENDPOINT}/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,modifiedTime,size,trashed`;
  const { res, data } = await driveFetchJson(
    url,
    accessToken,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: jsonText,
    },
    fetchImpl
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(data?.error?.message || `更新 Google Drive 行程檔失敗 (${res.status})`);
  }
  // 若使用者把舊檔丟進垃圾桶，改為建立全新檔案避免同步寫進垃圾桶
  if (data?.trashed) return null;
  return data;
}

async function createWorkspaceFileMultipart(accessToken, folderId, jsonText, fetchImpl = fetch) {
  const boundary = `tripcanvas_${generateRandomHex(8)}`;
  const metadata = {
    name: DRIVE_WORKSPACE_FILE_NAME,
    mimeType: 'application/json',
    parents: folderId ? [folderId] : undefined,
    appProperties: {
      app: 'tripcanvas',
      kind: 'workspace',
      schemaVersion: '5',
    },
  };
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${jsonText}\r\n` +
    `--${boundary}--`;

  const url = `${DRIVE_UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,name,modifiedTime,size,parents`;
  const { res, data } = await driveFetchJson(
    url,
    accessToken,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
    fetchImpl
  );
  return { res, data };
}

export function handleDriveStatus({ headers = {}, env = {} } = {}) {
  const cfg = getGoogleOAuthConfig(env);
  const session = cfg.configured ? readSessionFromHeaders(headers, cfg.sessionKey) : null;
  return {
    statusCode: 200,
    cookies: [],
    body: {
      configured: cfg.configured,
      authenticated: Boolean(session),
      user: session?.user || null,
      driveFolderName: DRIVE_FOLDER_NAME,
      fileName: DRIVE_WORKSPACE_FILE_NAME,
      redirectUri: getRedirectUri(headers, env),
    },
  };
}

export function handleDriveLogin({ headers = {}, env = {} } = {}) {
  const cfg = getGoogleOAuthConfig(env);
  const secure = isSecureRequest(headers, env);
  if (!cfg.configured) {
    return {
      statusCode: 302,
      redirectUrl: '/?drive_auth=not_configured',
      cookies: [],
    };
  }

  const state = generateRandomHex(24);
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const redirectUri = getRedirectUri(headers, env);

  const statePayload = encryptJsonPayload(
    {
      state,
      codeVerifier,
      redirectUri,
      createdAt: Date.now(),
    },
    cfg.sessionKey
  );

  const stateCookie = serializeCookie(OAUTH_STATE_COOKIE, statePayload, {
    maxAge: OAUTH_STATE_MAX_AGE_SEC,
    httpOnly: true,
    sameSite: 'Lax',
    secure,
  });

  const authParams = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent select_account',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return {
    statusCode: 302,
    redirectUrl: `${GOOGLE_AUTH_ENDPOINT}?${authParams.toString()}`,
    cookies: [stateCookie],
  };
}

export async function handleDriveCallback({ query = {}, headers = {}, env = {}, fetchImpl = fetch } = {}) {
  const cfg = getGoogleOAuthConfig(env);
  const secure = isSecureRequest(headers, env);
  const clearState = clearCookie(OAUTH_STATE_COOKIE, secure);

  if (!cfg.configured) {
    return {
      statusCode: 302,
      redirectUrl: '/?drive_auth=not_configured',
      cookies: [clearState],
    };
  }

  if (query.error) {
    const code = query.error === 'access_denied' ? 'cancelled' : 'error';
    return {
      statusCode: 302,
      redirectUrl: `/?drive_auth=${code}`,
      cookies: [clearState],
    };
  }

  const cookies = parseCookies(getHeader(headers, 'cookie'));
  const savedState = decryptJsonPayload(cookies[OAUTH_STATE_COOKIE], cfg.sessionKey);
  const stateAgeMs = savedState ? Date.now() - Number(savedState.createdAt) : NaN;
  const isStateExpired =
    !Number.isFinite(stateAgeMs) || stateAgeMs < -5000 || stateAgeMs > OAUTH_STATE_MAX_AGE_SEC * 1000;

  if (
    !savedState ||
    isStateExpired ||
    !savedState.codeVerifier ||
    !query.code ||
    !query.state ||
    !timingSafeEqualStr(String(query.state), String(savedState.state || ''))
  ) {
    return {
      statusCode: 302,
      redirectUrl: '/?drive_auth=state_error',
      cookies: [clearState],
    };
  }

  const redirectUri = savedState.redirectUri || getRedirectUri(headers, env);

  try {
    const form = new URLSearchParams({
      code: String(query.code),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: String(savedState.codeVerifier),
    });

    const { res: tokenRes, data: tokenData } = await fetchJsonWithTimeout(
      fetchImpl,
      GOOGLE_TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      UPSTREAM_TIMEOUT_MS
    );

    if (!tokenRes.ok || !tokenData?.access_token) {
      return {
        statusCode: 302,
        redirectUrl: '/?drive_auth=token_error',
        cookies: [clearState],
      };
    }

    const grantedScopes = String(tokenData.scope || '').split(/\s+/).filter(Boolean);
    if (!grantedScopes.includes(DRIVE_FILE_SCOPE)) {
      return {
        statusCode: 302,
        redirectUrl: '/?drive_auth=missing_scope',
        cookies: [clearState],
      };
    }

    const { res: userRes, data: userInfo } = await fetchJsonWithTimeout(
      fetchImpl,
      GOOGLE_USERINFO_ENDPOINT,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
      UPSTREAM_TIMEOUT_MS
    );

    // 強制驗證 userinfo 回應與穩定主鍵 sub，避免失敗時產生空 sub 誤沿用前帳號 Session
    const userSub = String(userInfo?.sub || '').trim();
    if (!userRes.ok || !userSub) {
      return {
        statusCode: 302,
        redirectUrl: '/?drive_auth=token_error',
        cookies: [clearState],
      };
    }

    const user = {
      sub: userSub,
      email: String(userInfo?.email || ''),
      name: String(userInfo?.name || userInfo?.email || 'Google 使用者'),
      picture: sanitizeUserPicture(userInfo?.picture),
    };

    const existingSession = readSessionFromHeaders(headers, cfg.sessionKey);
    const isSameUser = Boolean(user.sub && existingSession?.user?.sub === user.sub);
    const refreshToken = tokenData.refresh_token || (isSameUser ? existingSession.refreshToken : '');

    if (!refreshToken) {
      return {
        statusCode: 302,
        redirectUrl: '/?drive_auth=token_error',
        cookies: [clearState],
      };
    }

    const expiresInSec = Number(tokenData.expires_in) || 3500;
    const nextSession = {
      refreshToken,
      accessToken: tokenData.access_token,
      accessTokenExpiresAt: Date.now() + expiresInSec * 1000,
      driveFileId: isSameUser ? existingSession.driveFileId : null,
      driveFolderId: isSameUser ? existingSession.driveFolderId : null,
      user,
    };

    const sessionCookie = buildSessionCookie(nextSession, cfg.sessionKey, secure);
    return {
      statusCode: 302,
      redirectUrl: '/?drive_auth=connected',
      cookies: [clearState, sessionCookie],
    };
  } catch (err) {
    console.error('[driveHandler] callback error:', err?.message || err);
    return {
      statusCode: 302,
      redirectUrl: '/?drive_auth=error',
      cookies: [clearState],
    };
  }
}

export async function handleDrivePull({ headers = {}, env = {}, fetchImpl = fetch } = {}) {
  const cfg = getGoogleOAuthConfig(env);
  const secure = isSecureRequest(headers, env);
  if (!cfg.configured) {
    return {
      statusCode: 503,
      cookies: [],
      body: { status: 'not_configured', message: '雲端同步服務目前未啟用' },
    };
  }

  const initialSession = readSessionFromHeaders(headers, cfg.sessionKey);
  if (!initialSession) {
    return {
      statusCode: 401,
      cookies: [],
      body: { status: 'unauthenticated', authenticated: false, message: '尚未登入 Google 雲端硬碟' },
    };
  }

  try {
    const { session, changed, result } = await runWithTokenRetry(initialSession, cfg, fetchImpl, async (activeSession) => {
      let curSession = activeSession;
      let sessionChanged = false;
      let fileMeta = null;
      let downloaded = null;

      // 1. 若 Cookie 裡已記住 fileId，先確認該檔未進垃圾桶並取得最新 modifiedTime，再下載內容
      if (curSession.driveFileId) {
        const meta = await getWorkspaceFileMeta(curSession.accessToken, curSession.driveFileId, fetchImpl);
        if (!meta || meta.trashed) {
          curSession = { ...curSession, driveFileId: null };
          sessionChanged = true;
        } else {
          downloaded = await downloadWorkspaceFile(curSession.accessToken, curSession.driveFileId, fetchImpl);
          if (downloaded.notFound) {
            curSession = { ...curSession, driveFileId: null };
            sessionChanged = true;
            downloaded = null;
          } else {
            fileMeta = {
              id: meta.id || curSession.driveFileId,
              name: meta.name || DRIVE_WORKSPACE_FILE_NAME,
              modifiedTime: meta.modifiedTime || null,
              size: meta.size || null,
            };
          }
        }
      }

      // 2. 否則搜尋使用者 Google 雲端硬碟內的漫步地圖同步檔（跨裝置自動尋回）
      if (!downloaded) {
        fileMeta = await findWorkspaceFile(curSession.accessToken, fetchImpl);
        if (fileMeta?.id) {
          curSession = {
            ...curSession,
            driveFileId: fileMeta.id,
            driveFolderId:
              Array.isArray(fileMeta.parents) && fileMeta.parents[0] ? fileMeta.parents[0] : curSession.driveFolderId,
          };
          sessionChanged = true;
          downloaded = await downloadWorkspaceFile(curSession.accessToken, fileMeta.id, fetchImpl);
        }
      }

      return { session: curSession, changed: sessionChanged, result: { fileMeta, downloaded } };
    });

    const { fileMeta, downloaded } = result;
    const cookies = changed ? [buildSessionCookie(session, cfg.sessionKey, secure)] : [];

    if (!fileMeta?.id || !downloaded || downloaded.notFound) {
      return {
        statusCode: 200,
        cookies,
        body: {
          status: 'ok',
          exists: false,
          workspace: null,
          file: null,
          user: session.user,
        },
      };
    }

    if (downloaded.corrupted) {
      return {
        statusCode: 200,
        cookies,
        body: {
          status: 'corrupted_file',
          exists: true,
          workspace: null,
          file: fileMeta,
          user: session.user,
          message: '雲端同步檔內容異常，已暫停自動覆寫以保護資料，請先檢視或備份本機行程後手動同步。',
        },
      };
    }

    return {
      statusCode: 200,
      cookies,
      body: {
        status: 'ok',
        exists: true,
        workspace: downloaded.workspace,
        file: {
          id: fileMeta.id,
          name: fileMeta.name || DRIVE_WORKSPACE_FILE_NAME,
          modifiedTime: fileMeta.modifiedTime || null,
          size: fileMeta.size || null,
        },
        user: session.user,
      },
    };
  } catch (err) {
    if (err instanceof DriveAuthExpiredError || err?.code === 'AUTH_EXPIRED') {
      return {
        statusCode: 401,
        cookies: [clearCookie(DRIVE_SESSION_COOKIE, secure)],
        body: { status: 'auth_expired', authenticated: false, message: err.message },
      };
    }
    if (err instanceof DriveScopeError || err?.code === 'INSUFFICIENT_SCOPE') {
      return {
        statusCode: 403,
        cookies: [],
        body: { status: 'insufficient_scope', message: err.message },
      };
    }
    console.error('[driveHandler] pull error:', err?.message || err);
    return {
      statusCode: 502,
      cookies: [],
      body: { status: 'upstream_error', message: '讀取 Google 雲端硬碟失敗，請稍後重試' },
    };
  }
}

export async function handleDrivePush({ body = {}, headers = {}, env = {}, fetchImpl = fetch } = {}) {
  const cfg = getGoogleOAuthConfig(env);
  const secure = isSecureRequest(headers, env);
  if (!cfg.configured) {
    return {
      statusCode: 503,
      cookies: [],
      body: { status: 'not_configured', message: '雲端同步服務目前未啟用' },
    };
  }

  const initialSession = readSessionFromHeaders(headers, cfg.sessionKey);
  if (!initialSession) {
    return {
      statusCode: 401,
      cookies: [],
      body: { status: 'unauthenticated', authenticated: false, message: '尚未登入 Google 雲端硬碟' },
    };
  }

  const workspace = body?.workspace;
  if (!workspace || typeof workspace !== 'object' || !Array.isArray(workspace.trips) || workspace.trips.length === 0) {
    return {
      statusCode: 400,
      cookies: [],
      body: { status: 'invalid_payload', message: '無效的旅遊計畫工作區資料' },
    };
  }

  const expectedModifiedTime =
    typeof body?.expectedModifiedTime === 'string' && body.expectedModifiedTime.trim()
      ? body.expectedModifiedTime.trim()
      : null;

  const jsonText = JSON.stringify(workspace);
  if (Buffer.byteLength(jsonText, 'utf8') > MAX_WORKSPACE_BYTES) {
    return {
      statusCode: 413,
      cookies: [],
      body: {
        status: 'payload_too_large',
        message: '行程含圖片檔案過大（超過 3.8 MB），請移除部分照片或改用匯出 JSON 備份',
      },
    };
  }

  try {
    const { session, changed, result } = await runWithTokenRetry(initialSession, cfg, fetchImpl, async (activeSession) => {
      let curSession = activeSession;
      let sessionChanged = false;
      let savedFile = null;

      // 0. 若前端提供 expectedModifiedTime，先做樂觀併發檢查，避免覆寫其他裝置較新的雲端修改
      if (expectedModifiedTime && curSession.driveFileId) {
        const meta = await getWorkspaceFileMeta(curSession.accessToken, curSession.driveFileId, fetchImpl);
        if (!meta || meta.trashed) {
          curSession = { ...curSession, driveFileId: null };
          sessionChanged = true;
        } else if (meta.modifiedTime && meta.modifiedTime !== expectedModifiedTime) {
          return {
            session: curSession,
            changed: sessionChanged,
            result: { conflict: true, cloudModifiedTime: meta.modifiedTime },
          };
        }
      }

      // 1. 若已知 fileId，直接 PATCH 更新內容
      if (curSession.driveFileId) {
        savedFile = await patchWorkspaceMedia(curSession.accessToken, curSession.driveFileId, jsonText, fetchImpl);
        if (!savedFile) {
          curSession = { ...curSession, driveFileId: null };
          sessionChanged = true;
        }
      }

      // 2. 若尚無有效 fileId，先搜尋避免建立重複檔，找不到才於「漫步地圖 TripCanvas」資料夾建立新檔
      if (!savedFile) {
        const existing = await findWorkspaceFile(curSession.accessToken, fetchImpl);
        if (existing?.id) {
          if (expectedModifiedTime && existing.modifiedTime && existing.modifiedTime !== expectedModifiedTime) {
            curSession = { ...curSession, driveFileId: existing.id };
            sessionChanged = true;
            return {
              session: curSession,
              changed: sessionChanged,
              result: { conflict: true, cloudModifiedTime: existing.modifiedTime },
            };
          }
          savedFile = await patchWorkspaceMedia(curSession.accessToken, existing.id, jsonText, fetchImpl);
        }
      }

      if (!savedFile) {
        let folderId = curSession.driveFolderId || null;
        if (folderId) {
          // 確認快取資料夾未被使用者移至垃圾桶，避免把新同步檔建在垃圾桶內
          const folderMeta = await getWorkspaceFileMeta(curSession.accessToken, folderId, fetchImpl);
          if (!folderMeta || folderMeta.trashed) {
            folderId = null;
          }
        }
        if (!folderId) {
          folderId = await findOrCreateAppFolder(curSession.accessToken, fetchImpl);
        }

        let created = await createWorkspaceFileMultipart(curSession.accessToken, folderId, jsonText, fetchImpl);

        // 若資料夾已被使用者手動刪除導致 404，自動重建資料夾後重試一次
        if (created.res.status === 404) {
          folderId = await findOrCreateAppFolder(curSession.accessToken, fetchImpl);
          created = await createWorkspaceFileMultipart(curSession.accessToken, folderId, jsonText, fetchImpl);
        }

        if (!created.res.ok || !created.data?.id) {
          throw new Error(created.data?.error?.message || `建立 Google Drive 行程檔失敗 (${created.res.status})`);
        }

        savedFile = created.data;
        curSession = {
          ...curSession,
          driveFileId: savedFile.id,
          driveFolderId: folderId,
        };
        sessionChanged = true;
      } else if (curSession.driveFileId !== savedFile.id) {
        curSession = {
          ...curSession,
          driveFileId: savedFile.id,
        };
        sessionChanged = true;
      }

      return { session: curSession, changed: sessionChanged, result: { conflict: false, savedFile } };
    });

    const cookies = changed ? [buildSessionCookie(session, cfg.sessionKey, secure)] : [];

    if (result.conflict) {
      return {
        statusCode: 409,
        cookies,
        body: {
          status: 'conflict',
          cloudModifiedTime: result.cloudModifiedTime || null,
          message: '偵測到雲端有其他裝置的較新修改，正在自動拉取合併後重新儲存。',
        },
      };
    }

    const savedFile = result.savedFile;
    return {
      statusCode: 200,
      cookies,
      body: {
        status: 'ok',
        file: {
          id: savedFile.id,
          name: savedFile.name || DRIVE_WORKSPACE_FILE_NAME,
          modifiedTime: savedFile.modifiedTime || new Date().toISOString(),
          size: savedFile.size || String(Buffer.byteLength(jsonText, 'utf8')),
        },
        user: session.user,
      },
    };
  } catch (err) {
    if (err instanceof DriveAuthExpiredError || err?.code === 'AUTH_EXPIRED') {
      return {
        statusCode: 401,
        cookies: [clearCookie(DRIVE_SESSION_COOKIE, secure)],
        body: { status: 'auth_expired', authenticated: false, message: err.message },
      };
    }
    if (err instanceof DriveScopeError || err?.code === 'INSUFFICIENT_SCOPE') {
      return {
        statusCode: 403,
        cookies: [],
        body: { status: 'insufficient_scope', message: err.message },
      };
    }
    console.error('[driveHandler] push error:', err?.message || err);
    return {
      statusCode: 502,
      cookies: [],
      body: { status: 'upstream_error', message: '同步至 Google 雲端硬碟失敗，請稍後重試' },
    };
  }
}

export function handleDriveLogout({ headers = {}, env = {} } = {}) {
  const secure = isSecureRequest(headers, env);
  return {
    statusCode: 200,
    cookies: [clearCookie(DRIVE_SESSION_COOKIE, secure), clearCookie(OAUTH_STATE_COOKIE, secure)],
    body: { status: 'ok', authenticated: false },
  };
}
