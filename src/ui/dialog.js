/**
 * 自訂 Toast 與確認／輸入對話框（取代瀏覽器原生 alert / confirm）
 */

export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  const styles = {
    info: 'bg-[#4A382B] text-[#FAF4EC]',
    success: 'bg-[#5D8065] text-white',
    warn: 'bg-[#B98232] text-white',
    error: 'bg-[#A65D57] text-white',
  };
  el.className = `${styles[type] || styles.info} px-4 py-2.5 rounded-2xl shadow-float text-xs font-bold flex items-center gap-2 transition-all duration-300 opacity-0 translate-y-2 pointer-events-auto max-w-[90vw] text-center`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.remove('opacity-0', 'translate-y-2'));
  setTimeout(() => {
    el.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

export function openCustomDialog({
  title,
  message,
  confirmText = '確定',
  danger = false,
  inputValue = null,
  placeholder = '',
}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-dialog');
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-message');
    const iconWrap = document.getElementById('dialog-icon-wrap');
    const inputWrap = document.getElementById('dialog-input-wrap');
    const inputEl = document.getElementById('dialog-input');
    const btnCancel = document.getElementById('dialog-btn-cancel');
    const btnConfirm = document.getElementById('dialog-btn-confirm');

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
    if (isPrompt) {
      setTimeout(() => {
        inputEl.focus();
        inputEl.select();
      }, 50);
    }

    const cleanup = (result) => {
      modal.classList.add('hidden');
      modal.onclick = null;
      btnCancel.onclick = null;
      btnConfirm.onclick = null;
      inputEl.onkeydown = null;
      resolve(result);
    };

    modal.onclick = (e) => {
      if (e.target === modal) cleanup(null);
    };
    btnCancel.onclick = () => cleanup(null);
    btnConfirm.onclick = () => cleanup(isPrompt ? inputEl.value.trim() : true);
    inputEl.onkeydown = (e) => {
      if (e.key === 'Enter') cleanup(inputEl.value.trim());
      if (e.key === 'Escape') cleanup(null);
    };
  });
}
