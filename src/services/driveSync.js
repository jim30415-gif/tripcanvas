import {
  flushLocalBackupNow,
  getWorkspace,
  normalizeWorkspace,
  onWorkspaceMutated,
  replaceWorkspace,
} from '../state/store.js';
import { mergeWorkspaces } from '../state/workspaceMerge.js';

const PUSH_DEBOUNCE_MS = 1400;
const KEEPALIVE_MAX_BYTES = 60_000;
const VISIBLE_RESYNC_COOLDOWN_MS = 15_000;

const syncState = {
  configured: false,
  authenticated: false,
  user: null,
  driveFolderName: '漫步地圖 TripCanvas',
  fileName: 'tripcanvas-workspace.json',
  status: 'idle', // idle | checking | syncing | synced | pending | error | auth_expired | offline | unconfigured
  lastSyncedAt: null,
  lastError: '',
  hasPendingChanges: false,
};

const listeners = new Set();
let onWorkspaceUpdatedCb = null;
let onToastCb = null;
let pushTimer = null;
let syncInFlight = false;
let dirtyWhileSyncing = false;
let initialized = false;
let localRevision = 0;
let authEpoch = 0;
let lastKnownModifiedTime = null;
let lastCompletedSyncMs = 0;

function emit() {
  const snapshot = getDriveSyncState();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) {
      console.warn('driveSync listener error:', err);
    }
  }
}

function updateState(patch) {
  Object.assign(syncState, patch);
  emit();
}

export function getDriveSyncState() {
  return { ...syncState };
}

export function subscribeDriveSync(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  listener(getDriveSyncState());
  return () => listeners.delete(listener);
}

function consumeAuthResultParam() {
  if (typeof window === 'undefined') return '';
  try {
    const url = new URL(window.location.href);
    const val = url.searchParams.get('drive_auth') || '';
    if (val) {
      url.searchParams.delete('drive_auth');
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    }
    return val;
  } catch {
    return '';
  }
}

async function fetchDriveJson(url, options = {}, timeoutMs = 15_000) {
  const useKeepalive = Boolean(options.keepalive);
  const controller = !useKeepalive && timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { res, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getUtf8ByteLength(str) {
  if (typeof Blob !== 'undefined') return new Blob([str]).size;
  return str.length * 2;
}

async function pushWorkspaceOnce({ silent = true, keepalive = false, isPageHide = false } = {}) {
  if (!syncState.authenticated) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    updateState({ status: 'offline', hasPendingChanges: true, lastError: '目前離線，恢復連線後將自動同步' });
    return false;
  }

  if (syncInFlight) {
    dirtyWhileSyncing = true;
    return false;
  }

  const startEpoch = authEpoch;
  const pushedRevision = localRevision;
  syncInFlight = true;
  dirtyWhileSyncing = false;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }

  updateState({ status: 'syncing', lastError: '' });

  let triggerConflictMerge = false;

  try {
    const payload = JSON.stringify({
      workspace: getWorkspace(),
      ...(lastKnownModifiedTime ? { expectedModifiedTime: lastKnownModifiedTime } : {}),
    });
    const byteLen = getUtf8ByteLength(payload);
    const canKeepalive = keepalive && byteLen <= KEEPALIVE_MAX_BYTES;
    // pagehide 時若體積超過瀏覽器 64 KiB keepalive 限制，避免拋 TypeError 改由下次開啟自動續傳
    if (isPageHide && keepalive && !canKeepalive) {
      updateState({ status: 'pending', hasPendingChanges: true });
      return false;
    }

    const { res, data } = await fetchDriveJson(
      '/api/drive?action=push',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: canKeepalive,
      },
      15_000
    );

    if (authEpoch !== startEpoch) return false;

    if (res.status === 401 && data?.status === 'auth_expired') {
      authEpoch++;
      lastKnownModifiedTime = null;
      updateState({
        authenticated: false,
        user: null,
        status: 'auth_expired',
        lastError: data?.message || 'Google 登入授權已過期，請重新登入',
      });
      if (!silent && typeof onToastCb === 'function') {
        onToastCb('Google 雲端授權已過期，請重新登入同步（本機資料皆已完整保留）', 'error');
      }
      return false;
    }

    // 偵測到其他裝置更新了雲端檔案 → 自動執行 pull + 無損合併再重推，絕不盲目覆蓋
    if (res.status === 409 && data?.status === 'conflict') {
      triggerConflictMerge = true;
      updateState({ status: 'syncing', hasPendingChanges: true, lastError: '' });
      return false;
    }

    if (!res.ok || data?.status !== 'ok') {
      const msg = data?.message || `同步至 Google 雲端硬碟失敗 (${res.status})`;
      updateState({ status: 'error', hasPendingChanges: true, lastError: msg });
      if (!silent && typeof onToastCb === 'function') {
        onToastCb(msg, 'error');
      }
      return false;
    }

    if (data.file?.modifiedTime) {
      lastKnownModifiedTime = data.file.modifiedTime;
    }
    lastCompletedSyncMs = Date.now();
    const stillDirty = localRevision !== pushedRevision || dirtyWhileSyncing;
    updateState({
      status: stillDirty ? 'pending' : 'synced',
      hasPendingChanges: stillDirty,
      lastSyncedAt: data.file?.modifiedTime || new Date().toISOString(),
      lastError: '',
      user: data.user || syncState.user,
    });
    return true;
  } catch {
    if (authEpoch !== startEpoch) return false;
    updateState({
      status: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error',
      hasPendingChanges: true,
      lastError: '連線異常，行程已安全存於本機，稍後將自動重試同步',
    });
    return false;
  } finally {
    syncInFlight = false;
    if (authEpoch === startEpoch && syncState.authenticated) {
      if (triggerConflictMerge) {
        void syncWithGoogleDrive({ isManual: false });
      } else if (dirtyWhileSyncing || localRevision !== pushedRevision) {
        scheduleAutoPush();
      }
    }
  }
}

export function scheduleAutoPush() {
  if (!syncState.authenticated) return;
  localRevision++;
  if (syncInFlight) {
    dirtyWhileSyncing = true;
    updateState({ hasPendingChanges: true, status: 'syncing' });
    return;
  }
  updateState({ hasPendingChanges: true, status: 'pending' });
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushWorkspaceOnce({ silent: true });
  }, PUSH_DEBOUNCE_MS);
}

/**
 * 執行完整雙向同步（先 Pull 雲端，安全合併，必要時 Push 回 Google Drive）
 */
export async function syncWithGoogleDrive({ isManual = false, isPostLogin = false } = {}) {
  if (!syncState.configured) return false;
  if (!syncState.authenticated) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    updateState({ status: 'offline', lastError: '目前離線，已載入本機備份' });
    if (isManual && typeof onToastCb === 'function') {
      onToastCb('目前無網路連線，恢復後會自動同步', 'info');
    }
    return false;
  }

  if (syncInFlight) {
    dirtyWhileSyncing = true;
    return false;
  }

  const startEpoch = authEpoch;
  const startRevision = localRevision;
  syncInFlight = true;
  dirtyWhileSyncing = false;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }

  updateState({ status: 'syncing', lastError: '' });

  try {
    const { res, data } = await fetchDriveJson('/api/drive?action=pull', { method: 'GET' }, 15_000);
    if (authEpoch !== startEpoch) return false;

    if (res.status === 401) {
      const expired = data?.status === 'auth_expired';
      authEpoch++;
      lastKnownModifiedTime = null;
      updateState({
        authenticated: false,
        user: null,
        status: expired ? 'auth_expired' : 'idle',
        lastError: expired ? data?.message || 'Google 登入授權已過期，請重新登入' : '',
      });
      if ((isManual || expired) && typeof onToastCb === 'function') {
        onToastCb(
          expired
            ? 'Google 雲端授權已過期，請重新登入同步（本機行程皆完整保留）'
            : '尚未登入 Google 雲端硬碟',
          'error'
        );
      }
      return false;
    }

    if (!res.ok) {
      const msg = data?.message || '無法讀取 Google 雲端硬碟行程檔';
      updateState({ status: 'error', lastError: msg });
      if ((isManual || isPostLogin) && typeof onToastCb === 'function') {
        onToastCb(msg, 'error');
      }
      return false;
    }

    const localWs = getWorkspace();

    // 雲端同步檔內容損毀時，絕不自動用範例行程覆蓋，僅允許使用者有真實本機編輯且手動點擊同步時修復
    if (data?.status === 'corrupted_file') {
      if (localWs?.isPristineDemo || !isManual) {
        const msg = data?.message || '雲端同步檔內容異常，已暫停自動覆寫以保護原檔';
        updateState({ status: 'error', lastError: msg });
        if (typeof onToastCb === 'function') {
          onToastCb(msg, 'error');
        }
        return false;
      }
    }

    if (data?.file?.modifiedTime) {
      lastKnownModifiedTime = data.file.modifiedTime;
    }

    const cloudWs = data?.exists && data?.workspace ? normalizeWorkspace(data.workspace) : null;
    const merged = mergeWorkspaces(localWs, cloudWs);

    let uiChanged = false;
    if (merged.action === 'use_cloud' || merged.action === 'merged_push') {
      replaceWorkspace(merged.workspace, { markEdited: false, skipCloudSync: true });
      uiChanged = true;
    }

    let pushNeeded = merged.action === 'push_local' || merged.action === 'merged_push';
    // 首次連結時即使雲端尚無檔案也立刻建立同步檔，讓使用者馬上在自己的雲端硬碟看得到備份
    if (!data?.exists) {
      pushNeeded = true;
    }

    let finalSyncedAt = data?.file?.modifiedTime || new Date().toISOString();

    if (pushNeeded) {
      const pushResp = await fetchDriveJson(
        '/api/drive?action=push',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace: getWorkspace(),
            ...(lastKnownModifiedTime ? { expectedModifiedTime: lastKnownModifiedTime } : {}),
          }),
        },
        15_000
      );

      if (authEpoch !== startEpoch) return false;

      if (pushResp.res.status === 401 && pushResp.data?.status === 'auth_expired') {
        authEpoch++;
        lastKnownModifiedTime = null;
        updateState({
          authenticated: false,
          user: null,
          status: 'auth_expired',
          lastError: pushResp.data?.message || 'Google 登入授權已過期，請重新登入',
        });
        if ((isManual || isPostLogin) && typeof onToastCb === 'function') {
          onToastCb('Google 雲端授權已過期，請重新登入同步（本機行程皆完整保留）', 'error');
        }
        return false;
      }

      if (!pushResp.res.ok || pushResp.data?.status !== 'ok') {
        const msg = pushResp.data?.message || '寫入 Google 雲端硬碟失敗，請稍後再試';
        updateState({ status: 'error', hasPendingChanges: true, lastError: msg });
        if ((isManual || isPostLogin) && typeof onToastCb === 'function') {
          onToastCb(msg, 'error');
        }
        if (uiChanged && typeof onWorkspaceUpdatedCb === 'function') {
          onWorkspaceUpdatedCb(true);
        }
        return false;
      }

      finalSyncedAt = pushResp.data.file?.modifiedTime || new Date().toISOString();
      if (pushResp.data.file?.modifiedTime) {
        lastKnownModifiedTime = pushResp.data.file.modifiedTime;
      }
    }

    lastCompletedSyncMs = Date.now();
    const stillDirty = localRevision !== startRevision || dirtyWhileSyncing;
    updateState({
      status: stillDirty ? 'pending' : 'synced',
      hasPendingChanges: stillDirty,
      lastSyncedAt: finalSyncedAt,
      lastError: '',
      user: data?.user || syncState.user,
    });

    if (uiChanged && typeof onWorkspaceUpdatedCb === 'function') {
      onWorkspaceUpdatedCb(true);
    }

    if (typeof onToastCb === 'function') {
      if (isPostLogin) {
        if (merged.action === 'use_cloud') {
          onToastCb('已登入 Google 雲端硬碟並載回您先前的旅遊計畫！', 'success');
        } else if (merged.action === 'merged_push') {
          onToastCb('已登入並自動合併本機與 Google 雲端硬碟的所有旅遊計畫！', 'success');
        } else {
          onToastCb('已連結 Google 雲端硬碟，所有旅遊計畫已同步備份！', 'success');
        }
      } else if (isManual) {
        onToastCb('已與您的 Google 雲端硬碟同步完成', 'success');
      }
    }

    return true;
  } catch {
    if (authEpoch !== startEpoch) return false;
    updateState({
      status: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error',
      lastError: '連線異常，已載入本機備份行程',
    });
    if ((isManual || isPostLogin) && typeof onToastCb === 'function') {
      onToastCb('同步 Google 雲端硬碟時發生連線問題，本機行程仍已安全保留', 'error');
    }
    return false;
  } finally {
    syncInFlight = false;
    if (authEpoch === startEpoch && syncState.authenticated && (dirtyWhileSyncing || localRevision !== startRevision)) {
      scheduleAutoPush();
    }
  }
}

export async function startGoogleDriveLogin() {
  await flushLocalBackupNow();
  if (typeof window !== 'undefined') {
    window.location.href = '/api/drive?action=login';
  }
}

export async function logoutGoogleDrive() {
  authEpoch++;
  lastKnownModifiedTime = null;
  dirtyWhileSyncing = false;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  try {
    await fetchDriveJson('/api/drive?action=logout', { method: 'POST' }, 6000);
  } catch {
    // 即使離線也先切換為未登入狀態
  }
  updateState({
    authenticated: false,
    user: null,
    status: syncState.configured ? 'idle' : 'unconfigured',
    hasPendingChanges: false,
    lastSyncedAt: null,
    lastError: '',
  });
  if (typeof onToastCb === 'function') {
    onToastCb('已登出 Google 雲端硬碟（本機旅遊計畫仍完整保留）', 'info');
  }
}

async function checkDriveStatusAndSync(authOutcome = '') {
  updateState({ status: 'checking', lastError: '' });
  try {
    const { res, data } = await fetchDriveJson('/api/drive?action=status', { method: 'GET' }, 5000);
    if (!res.ok || !data) {
      updateState({
        status: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error',
        lastError: '無法取得雲端同步狀態，行程已暫存於本機',
      });
      return;
    }

    updateState({
      configured: Boolean(data.configured),
      authenticated: Boolean(data.authenticated),
      user: data.user || null,
      driveFolderName: data.driveFolderName || '漫步地圖 TripCanvas',
      fileName: data.fileName || 'tripcanvas-workspace.json',
      status: !data.configured ? 'unconfigured' : data.authenticated ? 'syncing' : 'idle',
    });

    if (data.configured && data.authenticated) {
      await syncWithGoogleDrive({ isPostLogin: authOutcome === 'connected' });
    }
  } catch {
    updateState({
      status: 'offline',
      lastError: '目前離線或連線逾時，已使用本機雙重備份',
    });
  }
}

export async function initDriveSync({ onWorkspaceUpdated, onToast } = {}) {
  onWorkspaceUpdatedCb = onWorkspaceUpdated || null;
  onToastCb = onToast || null;

  if (!initialized) {
    initialized = true;

    onWorkspaceMutated(() => {
      if (syncState.authenticated) {
        scheduleAutoPush();
      }
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && syncState.authenticated && syncState.hasPendingChanges) {
          void pushWorkspaceOnce({ silent: true, keepalive: true, isPageHide: false });
        } else if (
          document.visibilityState === 'visible' &&
          syncState.authenticated &&
          !syncInFlight &&
          Date.now() - lastCompletedSyncMs > VISIBLE_RESYNC_COOLDOWN_MS
        ) {
          // 切回分頁時自動檢查雲端是否有他裝置的新修改並無損合併
          void syncWithGoogleDrive({ isManual: false });
        }
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        if (syncState.authenticated && syncState.hasPendingChanges) {
          void pushWorkspaceOnce({ silent: true, keepalive: true, isPageHide: true });
        }
      });
      window.addEventListener('online', () => {
        if (!syncState.authenticated && (syncState.status === 'offline' || syncState.status === 'error')) {
          void checkDriveStatusAndSync();
        } else if (
          syncState.authenticated &&
          (syncState.hasPendingChanges || syncState.status === 'offline' || syncState.status === 'error')
        ) {
          void syncWithGoogleDrive({ isManual: false });
        }
      });
    }
  }

  const authOutcome = consumeAuthResultParam();
  if (typeof onToastCb === 'function') {
    if (authOutcome === 'cancelled') {
      onToastCb('已取消 Google 雲端硬碟連結', 'info');
    } else if (authOutcome === 'missing_scope') {
      onToastCb('請在 Google 授權畫面勾選允許「雲端硬碟檔案」權限，才能儲存與同步行程', 'error');
    } else if (authOutcome === 'state_error') {
      onToastCb('Google 登入驗證逾時，請再按一次登入', 'error');
    } else if (authOutcome === 'not_configured') {
      onToastCb('雲端同步功能目前未啟用，行程已自動儲存在本機瀏覽器', 'info');
    } else if (authOutcome === 'token_error' || authOutcome === 'error') {
      onToastCb('Google 登入驗證失敗，請再試一次', 'error');
    }
  }

  await checkDriveStatusAndSync(authOutcome);
}
