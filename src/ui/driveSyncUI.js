import {
  getDriveSyncState,
  logoutGoogleDrive,
  startGoogleDriveLogin,
  subscribeDriveSync,
  syncWithGoogleDrive,
} from '../services/driveSync.js';
import { escapeHTML, refreshIcons, sanitizeExternalUrl } from '../utils/format.js';
import { openTripsDrawer } from './tripsDrawer.js';
import { openCustomDialog } from './dialog.js';

function isDevEnvironment() {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

function formatSyncTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderHeaderSyncButton(state) {
  const btn = document.getElementById('btn-drive-sync-header');
  const mobileDot = document.getElementById('mobile-drive-sync-dot');

  let icon = 'cloud';
  let label = '登入雲端';
  let title = '連結您的 Google 雲端硬碟，重開網頁或換手機都能自動保存行程';
  let classes =
    'hidden md:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs sm:text-sm font-bold border transition active:scale-95 shrink-0 ';
  let dotClass = 'hidden';

  if (!state.configured) {
    icon = 'hard-drive';
    label = '本機備份';
    title = '目前已開啟本機雙重備份（localStorage + IndexedDB），點擊檢視同步與備份說明';
    classes += 'text-owl-subtext hover:text-owl-primaryDeep hover:bg-owl-softBg border-owl-border bg-owl-card';
  } else if (state.status === 'syncing' || state.status === 'checking') {
    icon = 'loader-2';
    label = '同步中';
    title = '正在與您的 Google 雲端硬碟同步行程…';
    classes += 'text-owl-primaryDeep bg-owl-softBg border-owl-accentBorder';
    dotClass = 'md:hidden absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-owl-primary border-2 border-owl-panel';
  } else if (state.authenticated && state.status === 'synced') {
    icon = 'check-circle-2';
    label = '雲端已同步';
    const timeStr = formatSyncTime(state.lastSyncedAt);
    const email = state.user?.email ? `${state.user.email} · ` : '';
    title = `${email}已自動同步至 Google 雲端硬碟${timeStr ? `（${timeStr}）` : ''}，點擊查看或立即同步`;
    classes += 'text-[#3F6347] bg-[#EBF3EC] hover:bg-[#DFECE1] border-[#BFD4C3]';
    dotClass = 'md:hidden absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#4F7D59] border-2 border-owl-panel';
  } else if (state.authenticated && state.status === 'pending') {
    icon = 'cloud-upload';
    label = '待同步';
    title = '已儲存至本機，即將自動上傳至 Google 雲端硬碟…';
    classes += 'text-[#8C6226] bg-[#FBF4E5] border-[#E7D4A9]';
    dotClass = 'md:hidden absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#C48F3B] border-2 border-owl-panel';
  } else if (state.authenticated && (state.status === 'error' || state.status === 'offline')) {
    icon = 'cloud-off';
    label = state.status === 'offline' ? '離線本機' : '重試同步';
    title = state.lastError || '雲端同步暫時異常，行程已安全保存於本機，點擊重試';
    classes += 'text-[#9B534B] bg-[#F9EDEC] hover:bg-[#F3E1DF] border-[#E3BDB8]';
    dotClass = 'md:hidden absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#A65D57] border-2 border-owl-panel';
  } else if (state.status === 'auth_expired') {
    icon = 'log-in';
    label = '重新登入';
    title = state.lastError || 'Google 雲端授權已過期，點擊重新登入（本機資料皆保留）';
    classes += 'text-[#9B534B] bg-[#F9EDEC] hover:bg-[#F3E1DF] border-[#E3BDB8]';
    dotClass = 'md:hidden absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#A65D57] border-2 border-owl-panel';
  } else {
    icon = 'cloud';
    label = '登入雲端';
    title = '登入自己的 Google 帳號，將旅遊計畫自動存入您的 Google 雲端硬碟';
    classes += 'text-owl-primaryDeep bg-owl-selectedBg hover:bg-owl-softBg border-owl-accentBorder';
  }

  if (mobileDot) {
    mobileDot.className = dotClass;
  }

  if (!btn) return;
  btn.className = classes;
  btn.title = title;
  const spinClass = icon === 'loader-2' ? ' animate-spin' : '';
  btn.innerHTML = `
    <i data-lucide="${icon}" class="w-4 h-4 shrink-0${spinClass}"></i>
    <span class="whitespace-nowrap">${escapeHTML(label)}</span>
  `;
  refreshIcons(btn);
}

function renderDrawerDriveCard(state) {
  const container = document.getElementById('trips-drive-sync-card');
  if (!container) return;

  const privacyFooterHtml = `
    <div class="pt-1 text-[11px] text-owl-muted flex items-center justify-between gap-2">
      <span>資料僅存於您的裝置與個人雲端</span>
      <a href="/privacy.html" target="_blank" rel="noopener noreferrer" class="font-bold text-owl-subtext hover:text-owl-primaryDeep underline shrink-0">隱私權政策</a>
    </div>
  `;

  if (!state.configured) {
    const devHint = isDevEnvironment()
      ? '（開發環境請設定 GOOGLE_OAUTH_CLIENT_ID 與 GOOGLE_OAUTH_CLIENT_SECRET）'
      : '';
    container.innerHTML = `
      <div class="rounded-2xl border border-owl-cardBorder bg-owl-card p-3.5 space-y-2">
        <div class="flex items-center gap-2.5">
          <span class="w-8 h-8 rounded-xl bg-owl-softBg text-owl-primaryDeep flex items-center justify-center shrink-0">
            <i data-lucide="hard-drive" class="w-4 h-4"></i>
          </span>
          <div class="min-w-0">
            <div class="text-sm font-extrabold text-owl-text">本機雙重備份運作中</div>
            <div class="text-xs text-owl-subtext">瀏覽器自動保存・隨時可匯出 JSON</div>
          </div>
        </div>
        <p class="text-xs text-owl-subtext leading-relaxed">
          所有旅遊計畫都會即時存於此裝置，亦可透過「匯出／匯入 JSON」自由跨裝置轉移。${escapeHTML(devHint)}
        </p>
        ${privacyFooterHtml}
      </div>
    `;
    refreshIcons(container);
    return;
  }

  if (!state.authenticated) {
    const expiredNote =
      state.status === 'auth_expired'
        ? `<div class="text-xs font-semibold text-[#9B534B] bg-[#F9EDEC] border border-[#E3BDB8] rounded-xl px-2.5 py-2">${escapeHTML(
            state.lastError || 'Google 登入授權已過期，請重新登入以恢復雲端同步。'
          )}</div>`
        : '';

    container.innerHTML = `
      <div class="rounded-2xl border border-owl-accentBorder/75 bg-owl-card p-3.5 space-y-2.5 shadow-2xs">
        <div class="flex items-center gap-2.5">
          <span class="w-8 h-8 rounded-xl bg-owl-softBg text-owl-primaryDeep flex items-center justify-center shrink-0">
            <i data-lucide="cloud" class="w-4 h-4"></i>
          </span>
          <div class="min-w-0">
            <div class="text-sm font-extrabold text-owl-text">Google 雲端硬碟個人同步</div>
            <div class="text-xs text-owl-subtext">資料只存在你自己的 Google 雲端空間</div>
          </div>
        </div>
        ${expiredNote}
        <p class="text-xs text-owl-subtext leading-relaxed">
          登入後會自動將所有旅遊計畫存至你的 Google Drive「<span class="font-bold text-owl-text">${escapeHTML(
            state.driveFolderName
          )}</span>」，換手機或重開網站都不會消失，且 App 無法讀取你的其他檔案。
        </p>
        <button
          id="btn-drawer-drive-login"
          type="button"
          class="w-full py-2.5 px-3 rounded-xl bg-owl-darkTop hover:bg-owl-darkBottom text-owl-cream text-sm font-extrabold flex items-center justify-center gap-1.5 shadow-xs transition active:scale-95"
        >
          <i data-lucide="log-in" class="w-4 h-4 text-owl-gold"></i>
          <span>${state.status === 'auth_expired' ? '重新連結 Google 雲端硬碟' : '登入 Google 雲端硬碟同步'}</span>
        </button>
        ${privacyFooterHtml}
      </div>
    `;
    refreshIcons(container);
    return;
  }

  const userName = state.user?.name || 'Google 使用者';
  const userEmail = state.user?.email || '';
  const initial = (userName || userEmail || 'G').slice(0, 1).toUpperCase();
  const timeStr = formatSyncTime(state.lastSyncedAt);

  let statusPill = `<span class="inline-flex items-center gap-1 text-xs font-bold text-[#3F6347] bg-[#EBF3EC] border border-[#BFD4C3] px-2 py-0.5 rounded-full"><i data-lucide="check" class="w-3 h-3"></i>已同步${timeStr ? ` ${timeStr}` : ''}</span>`;
  if (state.status === 'syncing') {
    statusPill =
      '<span class="inline-flex items-center gap-1 text-xs font-bold text-owl-primaryDeep bg-owl-softBg border border-owl-accentBorder px-2 py-0.5 rounded-full"><i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i>同步中…</span>';
  } else if (state.status === 'pending') {
    statusPill =
      '<span class="inline-flex items-center gap-1 text-xs font-bold text-[#8C6226] bg-[#FBF4E5] border border-[#E7D4A9] px-2 py-0.5 rounded-full">即將自動上傳…</span>';
  } else if (state.status === 'error' || state.status === 'offline') {
    statusPill = `<span class="inline-flex items-center gap-1 text-xs font-bold text-[#9B534B] bg-[#F9EDEC] border border-[#E3BDB8] px-2 py-0.5 rounded-full">${
      state.status === 'offline' ? '離線暫存本機' : '同步待重試'
    }</span>`;
  }

  const safePictureUrl = sanitizeExternalUrl(state.user?.picture, { httpsOnly: true });
  const avatarHtml = safePictureUrl
    ? `<img src="${escapeHTML(safePictureUrl)}" alt="" referrerpolicy="no-referrer" class="w-9 h-9 rounded-full border border-owl-border object-cover shrink-0 bg-owl-softBg" />`
    : `<span class="w-9 h-9 rounded-full bg-owl-primary text-white text-sm font-extrabold flex items-center justify-center shrink-0">${escapeHTML(
        initial
      )}</span>`;

  container.innerHTML = `
    <div class="rounded-2xl border border-[#BFD4C3] bg-owl-card p-3.5 space-y-2.5 shadow-2xs">
      <div class="flex items-center gap-2.5 min-w-0">
        ${avatarHtml}
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-1.5">
            <span class="text-sm font-extrabold text-owl-text truncate">${escapeHTML(userName)}</span>
            ${statusPill}
          </div>
          <div class="text-xs text-owl-subtext truncate mt-0.5">${escapeHTML(userEmail)}</div>
        </div>
      </div>

      <div class="text-xs text-owl-muted bg-owl-selectedBg/70 rounded-xl px-2.5 py-1.5 flex items-center gap-1.5">
        <i data-lucide="folder" class="w-3.5 h-3.5 text-owl-primary shrink-0"></i>
        <span class="truncate">Google 雲端硬碟 / ${escapeHTML(state.driveFolderName)}</span>
      </div>

      ${
        state.lastError
          ? `<div class="text-xs font-semibold text-[#9B534B] leading-relaxed">${escapeHTML(state.lastError)}</div>`
          : ''
      }

      <div class="flex items-center gap-2">
        <button
          id="btn-drawer-drive-sync-now"
          type="button"
          class="flex-1 py-2 px-3 rounded-xl bg-owl-softBg hover:bg-owl-border/70 border border-owl-border text-xs font-bold text-owl-primaryDeep flex items-center justify-center gap-1.5 transition active:scale-95"
        >
          <i data-lucide="refresh-cw" class="w-3.5 h-3.5${state.status === 'syncing' ? ' animate-spin' : ''}"></i>
          <span>立即同步</span>
        </button>
        <button
          id="btn-drawer-drive-logout"
          type="button"
          class="py-2 px-3 rounded-xl bg-white hover:bg-[#F9EDEC] border border-owl-border hover:border-[#E3BDB8] text-xs font-bold text-owl-subtext hover:text-[#9B534B] flex items-center justify-center gap-1.5 transition active:scale-95"
        >
          <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
          <span>登出</span>
        </button>
      </div>
      ${privacyFooterHtml}
    </div>
  `;
  refreshIcons(container);
}

export function renderDriveSyncUI(state = getDriveSyncState()) {
  renderHeaderSyncButton(state);
  renderDrawerDriveCard(state);
}

export function bindDriveSyncUI() {
  const headerBtn = document.getElementById('btn-drive-sync-header');
  if (headerBtn) {
    headerBtn.addEventListener('click', () => {
      const state = getDriveSyncState();
      if (!state.configured) {
        openTripsDrawer();
        return;
      }
      if (!state.authenticated) {
        void startGoogleDriveLogin();
        return;
      }
      if (state.status === 'error' || state.status === 'offline') {
        void syncWithGoogleDrive({ isManual: true });
        return;
      }
      openTripsDrawer();
    });
  }

  const drawerCard = document.getElementById('trips-drive-sync-card');
  if (drawerCard) {
    drawerCard.addEventListener('click', async (e) => {
      const loginBtn = e.target.closest('#btn-drawer-drive-login');
      if (loginBtn) {
        await startGoogleDriveLogin();
        return;
      }
      const syncBtn = e.target.closest('#btn-drawer-drive-sync-now');
      if (syncBtn) {
        await syncWithGoogleDrive({ isManual: true });
        return;
      }
      const logoutBtn = e.target.closest('#btn-drawer-drive-logout');
      if (logoutBtn) {
        const ok = await openCustomDialog({
          title: '登出 Google 雲端同步？',
          message: '登出後此裝置會暫停自動同步，但本機與您 Google 雲端硬碟裡既有的旅遊計畫都會完整保留。',
          confirmText: '確定登出',
        });
        if (ok) {
          await logoutGoogleDrive();
        }
      }
    });
  }

  subscribeDriveSync((state) => {
    renderDriveSyncUI(state);
  });
}
