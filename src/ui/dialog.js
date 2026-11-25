/**
 * 自訂 Toast（支援可選復原按鈕）與無障礙確認／輸入對話框（取代瀏覽器原生 alert / confirm）
 */

let activeDialogCleanup = null;

export function isCustomDialogOpen() {
  return typeof activeDialogCleanup === 'function';
}

export function showToast(message, type = 'info', options = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const { actionLabel = '', onAction = null, duration = actionLabel ? 5200 : 2800 } = options || {};

  const el = document.createElement('div');
  const styles = {
    info: 'bg-[#4A382B] text-[#FAF4EC]',
    success: 'bg-[#5D8065] text-white',
    warn: 'bg-[#B98232] text-white',
    error: 'bg-[#A65D57] text-white',
  };
  el.className = `${styles[type] || styles.info} px-4 py-2.5 rounded-2xl shadow-float text-xs font-bold flex items-center gap-2.5 transition-all duration-300 opacity-0 translate-y-2 pointer-events-auto max-w-[90vw] text-center`;

  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;
  el.appendChild(msgSpan);

  let dismissed = false;
  let hideTimer = null;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    el.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => el.remove(), 300);
  };

  if (actionLabel && typeof onAction === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className =
      'px-2.5 py-1 rounded-xl bg-white/20 hover:bg-white/30 active:scale-95 text-white text-xs font-extrabold transition shrink-0';
    actionBtn.textContent = actionLabel;
    actionBtn.addEventListener('click', () => {
      dismiss();
      try {
        onAction();
      } catch {
        // ignore
      }
    });
    el.appendChild(actionBtn);
  }

  container.appendChild(el);
  requestAnimationFrame(() => el.classList.remove('opacity-0', 'translate-y-2'));
  hideTimer = setTimeout(dismiss, duration);
}

export function openCustomDialog({
  title,
  message,
  confirmText = '確定',
  danger = false,
  inputValue = null,
  placeholder = '',
}) {
  if (typeof activeDialogCleanup === 'function') {
    activeDialogCleanup(null);
  }

  return new Promise((resolve) => {
    const modal = document.getElementById('modal-dialog');
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-message');
    const iconWrap = document.getElementById('dialog-icon-wrap');
    const inputWrap = document.getElementById('dialog-input-wrap');
    const inputEl = document.getElementById('dialog-input');
    const btnCancel = document.getElementById('dialog-btn-cancel');
    const btnConfirm = document.getElementById('dialog-btn-confirm');

    if (!modal || !titleEl || !msgEl || !btnCancel || !btnConfirm) {
      resolve(null);
      return;
    }

    const prevFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    titleEl.textContent = title;
    msgEl.textContent = message || '';
    btnConfirm.textContent = confirmText;

    iconWrap.className = danger
      ? 'w-10 h-10 rounded-2xl bg-[#F9EDEC] text-[#A65D57] flex items-center justify-center shrink-0'
      : 'w-10 h-10 rounded-2xl bg-owl-softBg text-owl-primaryDeep flex items-center justify-center shrink-0';
    btnConfirm.className = danger
      ? 'px-4 py-2 rounded-xl text-xs font-bold text-white bg-[#A65D57] hover:bg-[#8E4B45] transition'
      : 'px-4 py-2 rounded-xl text-xs font-bold text-white bg-owl-primary hover:bg-owl-primaryHover transition';

    const isPrompt = inputValue !== null;
    if (isPrompt) {
      inputWrap.classList.remove('hidden');
      inputEl.value = inputValue;
      inputEl.placeholder = placeholder;
    } else {
      inputWrap.classList.add('hidden');
    }

    modal.classList.remove('hidden');

    let settled = false;
    const onGlobalKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        cleanup(null);
        return;
      }
      if (e.key === 'Enter') {
        if (isPrompt && e.target === inputEl) {
          e.preventDefault();
          e.stopImmediatePropagation();
          cleanup(inputEl.value.trim());
        } else if (!isPrompt && e.target !== btnCancel) {
          e.preventDefault();
          e.stopImmediatePropagation();
          cleanup(true);
        }
      }
    };

    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      if (activeDialogCleanup === cleanup) {
        activeDialogCleanup = null;
      }
      modal.classList.add('hidden');
      modal.onclick = null;
      btnCancel.onclick = null;
      btnConfirm.onclick = null;
      document.removeEventListener('keydown', onGlobalKeydown, { capture: true });
      if (prevFocused && prevFocused.isConnected) {
        try {
          prevFocused.focus();
        } catch {
          // ignore
        }
      }
      resolve(result);
    };

    activeDialogCleanup = cleanup;
    document.addEventListener('keydown', onGlobalKeydown, { capture: true });

    modal.onclick = (e) => {
      if (e.target === modal) cleanup(null);
    };
    btnCancel.onclick = () => cleanup(null);
    btnConfirm.onclick = () => cleanup(isPrompt ? inputEl.value.trim() : true);

    setTimeout(() => {
      if (settled) return;
      if (isPrompt) {
        inputEl.focus();
        inputEl.select();
      } else {
        btnConfirm.focus();
      }
    }, 40);
  });
}
