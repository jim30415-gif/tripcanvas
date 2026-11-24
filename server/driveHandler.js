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

export const DRIVE_SESSION_COOKIE = 'tc_drive_session';
export const OAUTH_STATE_COOKIE = 'tc_drive_oauth_state';
export const DRIVE_FOLDER_NAME = '漫步地圖 TripCanvas';
export const DRIVE_WORKSPACE_FILE_NAME = 'tripcanvas-workspace.json';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const OAUTH_SCOPES = ['openid', 'email', 'profile', DRIVE_FILE_SCOPE];

const SESSION_MAX_AGE_SEC = 180 * 24 * 60 * 60; // 180 天
const OAUTH_STATE_MAX_AGE_SEC = 10 * 60; // 10 分鐘
const MAX_WORKSPACE_BYTES = 3.8 * 1024 * 1024; // 低於 Vercel 4.5 MB 上限

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

function getHeaderValue(headers = {}, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : String(v || '');
    }
  }
  return '';
}

export function getRequestOrigin(headers = {}) {
  const forwardedHost = getHeaderValue(headers, 'x-forwarded-host').split(',')[0].trim();
  const host = forwardedHost || getHeaderValue(headers, 'host').split(',')[0].trim() || 'localhost:5173';
  const forwardedProto = getHeaderValue(headers, 'x-forwarded-proto').split(',')[0].trim().toLowerCase();
  const isLocalHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const proto = forwardedProto || (isLocalHost ? 'http' : 'https');
  return `${proto}://${host}`;
}

export function isSecureRequest(headers = {}) {
  return getRequestOrigin(headers).startsWith('https://');
}

export function getRedirectUri(headers = {}, env = {}) {
  const cfg = getGoogleOAuthConfig(env);
  if (cfg.explicitRedirectUri) return cfg.explicitRedirectUri;
  return `${getRequestOrigin(headers)}/api/drive-callback`;
}

function readSessionFromHeaders(headers, sessionKey) {
  if (!sessionKey) return null;
  const cookies = parseCookies(getHeaderValue(headers, 'cookie'));
  const raw = cookies[DRIVE_SESSION_COOKIE];
  if (!raw) return null;
  const session = decryptJsonPayload(raw, sessionKey);
  if (!session || typeof session !== 'object' || !session.refreshToken) return null;
  return session;
}

function buildSessionCookie(session, sessionKey, secure) {
  const compact = {
    refreshToken: session.refreshToken,
    accessToken: session.accessToken || '',
    accessTokenExpiresAt: Number(session.accessTokenExpiresAt) || 0,
    driveFileId: session.driveFileId || null,
    driveFolderId: session.driveFolderId || null,
    user: session.user
      ? {
          sub: String(session.user.sub || ''),
          email: String(session.user.email || ''),
          name: String(session.user.name || ''),
          picture: String(session.user.picture || ''),
        }
      : null,
  };
  const encrypted = encryptJsonPayload(compact, sessionKey);
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

async function safeReadJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
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

async function ensureFreshAccessToken(session, cfg, fetchImpl = fetch) {
  const now = Date.now();
  if (session.accessToken && Number(session.accessTokenExpiresAt) > now + 60_000) {
    return { session, changed: false };
  }

  const form = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: session.refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = await safeReadJson(res);

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
  return { session: updated, changed: true };
}

async function driveFetchJson(url, accessToken, options = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
  const data = await safeReadJson(res);
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
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) {
    throw new DriveAuthExpiredError('Google 存取憑證已失效，請重新登入');
  }
  if (res.status === 404) {
    return { notFound: true, workspace: null };
  }
  if (!res.ok) {
    const errBody = await safeReadJson(res);
    throw new Error(errBody?.error?.message || `讀取 Google Drive 行程檔失敗 (${res.status})`);
  }
  const text = await res.text();
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
  const secure = isSecureRequest(headers);
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
  const secure = isSecureRequest(headers);
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

  const cookies = parseCookies(getHeaderValue(headers, 'cookie'));
  const savedState = decryptJsonPayload(cookies[OAUTH_STATE_COOKIE], cfg.sessionKey);
  if (
    !savedState ||
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

  const redirectUri = getRedirectUri(headers, env);

  try {
    const form = new URLSearchParams({
      code: String(query.code),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: String(savedState.codeVerifier || ''),
    });

    const tokenRes = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const tokenData = await safeReadJson(tokenRes);

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

    const userRes = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await safeReadJson(userRes);
    const user = {
      sub: String(userInfo?.sub || ''),
      email: String(userInfo?.email || ''),
      name: String(userInfo?.name || userInfo?.email || 'Google 使用者'),
      picture: String(userInfo?.picture || ''),
    };

    const existingSession = readSessionFromHeaders(headers, cfg.sessionKey);
    const refreshToken =
      tokenData.refresh_token ||
      (existingSession && existingSession.user?.sub === user.sub ? existingSession.refreshToken : '');

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
      driveFileId: existingSession && existingSession.user?.sub === user.sub ? existingSession.driveFileId : null,
      driveFolderId:
        existingSession && existingSession.user?.sub === user.sub ? existingSession.driveFolderId : null,
      user,
    };

    const sessionCookie = buildSessionCookie(nextSession, cfg.sessionKey, secure);
    return {
      statusCode: 302,
      redirectUrl: '/?drive_auth=connected',
      cookies: [clearState, sessionCookie],
    };
  } catch {
    return {
      statusCode: 302,
      redirectUrl: '/?drive_auth=error',
      cookies: [clearState],
    };
  }
}

export async function handleDrivePull({ headers = {}, env = {}, fetchImpl = fetch } = {}) {
  const cfg = getGoogleOAuthConfig(env);
  const secure = isSecureRequest(headers);
  if (!cfg.configured) {
    return {
      statusCode: 503,
      cookies: [],
      body: { status: 'not_configured', message: '伺服器尚未設定 Google OAuth 環境變數' },
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
    let { session, changed } = await ensureFreshAccessToken(initialSession, cfg, fetchImpl);

    let fileMeta = null;
    let downloaded = null;

    // 1. 若 Cookie 裡已記住 fileId，先直接下載（最快 1 次 API）
    if (session.driveFileId) {
      downloaded = await downloadWorkspaceFile(session.accessToken, session.driveFileId, fetchImpl);
      if (downloaded.notFound) {
        session = { ...session, driveFileId: null };
        changed = true;
        downloaded = null;
      } else {
        fileMeta = {
          id: session.driveFileId,
          name: DRIVE_WORKSPACE_FILE_NAME,
        };
      }
    }

    // 2. 否則搜尋使用者 Google 雲端硬碟內的漫步地圖同步檔（跨裝置自動尋回）
    if (!downloaded) {
      fileMeta = await findWorkspaceFile(session.accessToken, fetchImpl);
      if (fileMeta?.id) {
        session = {
          ...session,
          driveFileId: fileMeta.id,
          driveFolderId: Array.isArray(fileMeta.parents) && fileMeta.parents[0] ? fileMeta.parents[0] : session.driveFolderId,
        };
        changed = true;
        downloaded = await downloadWorkspaceFile(session.accessToken, fileMeta.id, fetchImpl);
      }
    }

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
          message: '雲端同步檔內容異常，將保留本機行程並於下次儲存時修復',
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
    return {
      statusCode: 502,
      cookies: [],
      body: { status: 'upstream_error', message: err?.message || '讀取 Google 雲端硬碟失敗，請稍後重試' },
    };
  }
}

export async function handleDrivePush({ body = {}, headers = {}, env = {}, fetchImpl = fetch } = {}) {
  const cfg = getGoogleOAuthConfig(env);
  const secure = isSecureRequest(headers);
  if (!cfg.configured) {
    return {
      statusCode: 503,
      cookies: [],
      body: { status: 'not_configured', message: '伺服器尚未設定 Google OAuth 環境變數' },
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
    let { session, changed } = await ensureFreshAccessToken(initialSession, cfg, fetchImpl);
    let savedFile = null;

    // 1. 若已知 fileId，直接 PATCH 更新內容
    if (session.driveFileId) {
      savedFile = await patchWorkspaceMedia(session.accessToken, session.driveFileId, jsonText, fetchImpl);
      if (!savedFile) {
        session = { ...session, driveFileId: null };
        changed = true;
      }
    }

    // 2. 若尚無有效 fileId，先搜尋避免建立重複檔，找不到才於「漫步地圖 TripCanvas」資料夾建立新檔
    if (!savedFile) {
      const existing = await findWorkspaceFile(session.accessToken, fetchImpl);
      if (existing?.id) {
        savedFile = await patchWorkspaceMedia(session.accessToken, existing.id, jsonText, fetchImpl);
      }
    }

    if (!savedFile) {
      let folderId = session.driveFolderId || (await findOrCreateAppFolder(session.accessToken, fetchImpl));
      let created = await createWorkspaceFileMultipart(session.accessToken, folderId, jsonText, fetchImpl);

      // 若資料夾已被使用者手動刪除導致 404，自動重建資料夾後重試一次
      if (created.res.status === 404) {
        folderId = await findOrCreateAppFolder(session.accessToken, fetchImpl);
        created = await createWorkspaceFileMultipart(session.accessToken, folderId, jsonText, fetchImpl);
      }

      if (!created.res.ok || !created.data?.id) {
        throw new Error(created.data?.error?.message || `建立 Google Drive 行程檔失敗 (${created.res.status})`);
      }

      savedFile = created.data;
      session = {
        ...session,
        driveFileId: savedFile.id,
        driveFolderId: folderId,
      };
      changed = true;
    } else if (session.driveFileId !== savedFile.id) {
      session = {
        ...session,
        driveFileId: savedFile.id,
      };
      changed = true;
    }

    const cookies = changed ? [buildSessionCookie(session, cfg.sessionKey, secure)] : [];
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
    return {
      statusCode: 502,
      cookies: [],
      body: { status: 'upstream_error', message: err?.message || '同步至 Google 雲端硬碟失敗，請稍後重試' },
    };
  }
}

export function handleDriveLogout({ headers = {} } = {}) {
  const secure = isSecureRequest(headers);
  return {
    statusCode: 200,
    cookies: [clearCookie(DRIVE_SESSION_COOKIE, secure), clearCookie(OAUTH_STATE_COOKIE, secure)],
    body: { status: 'ok', authenticated: false },
  };
}
