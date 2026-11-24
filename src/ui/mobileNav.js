import { invalidateMapSize } from '../map/mapInit.js';

export function setMobileTab(tabName) {
  const left = document.getElementById('panel-left');
  const mapPanel = document.getElementById('panel-map');
  const right = document.getElementById('panel-right');
  if (!left || !mapPanel || !right) return;

  left.classList.add('hidden', 'lg:flex');
  mapPanel.classList.add('hidden', 'lg:block');
  right.classList.add('hidden', 'lg:flex');

  if (tabName === 'left') {
    left.classList.remove('hidden');
    left.classList.add('flex');
  } else if (tabName === 'map') {
    mapPanel.classList.remove('hidden');
    mapPanel.classList.add('block');
  } else if (tabName === 'right') {
    right.classList.remove('hidden');
    right.classList.add('flex');
  }

  document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
    const active = btn.dataset.mobileTab === tabName;
    btn.className = active
      ? 'mobile-tab-btn flex flex-col items-center justify-center rounded-xl text-owl-primaryDeep bg-owl-softBg font-bold text-xs gap-0.5 transition'
      : 'mobile-tab-btn flex flex-col items-center justify-center rounded-xl text-owl-subtext font-medium text-xs gap-0.5 transition';
  });

  if (tabName === 'map') {
    setTimeout(() => invalidateMapSize(), 120);
    setTimeout(() => invalidateMapSize(), 350);
  }
}

export function bindMobileNav() {
  document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMobileTab(btn.dataset.mobileTab));
  });
}
