/* 8 款貓頭鷹大地色系 SVG 旅遊主題插畫 */
export const PRESET_ARTWORKS = {
  nightmarket: {
    name: '夜市',
    svg: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
      <defs><linearGradient id="nmBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3D2E23"/><stop offset="100%" stop-color="#5B4333"/></linearGradient></defs>
      <rect width="120" height="120" fill="url(#nmBg)"/>
      <path d="M0 24 Q60 35 120 24" stroke="#E5C59E" stroke-width="2" fill="none"/>
      <ellipse cx="26" cy="39" rx="11" ry="14" fill="#C25D49"/><rect x="22" y="24" width="8" height="4" fill="#E5C59E"/>
      <ellipse cx="60" cy="42" rx="11" ry="14" fill="#D49540"/><rect x="56" y="27" width="8" height="4" fill="#A64B38"/>
      <ellipse cx="94" cy="39" rx="11" ry="14" fill="#C25D49"/><rect x="90" y="24" width="8" height="4" fill="#E5C59E"/>
      <rect x="14" y="64" width="92" height="14" rx="4" fill="#A65D57"/>
      <rect x="20" y="78" width="80" height="36" rx="4" fill="#FAF4EC"/>
      <circle cx="45" cy="96" r="10" fill="#D49540"/><circle cx="75" cy="96" r="10" fill="#C47D4E"/>
      <path d="M40 95 Q45 89 50 95" stroke="#4A382B" stroke-width="2" fill="none"/>
    </svg>`,
  },
  temple: {
    name: '古蹟',
    svg: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
      <defs><linearGradient id="tpBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#EAD8C0"/><stop offset="100%" stop-color="#FBF3E6"/></linearGradient></defs>
      <rect width="120" height="120" fill="url(#tpBg)"/>
      <circle cx="90" cy="28" r="13" fill="#D68C6B" opacity="0.85"/>
      <path d="M14 54 Q60 22 106 54 L94 60 L26 60 Z" fill="#8C483E"/>
      <path d="M26 38 Q60 16 94 38 L86 44 L34 44 Z" fill="#A65D57"/>
      <rect x="30" y="60" width="60" height="40" fill="#FFFDF9"/>
      <rect x="34" y="60" width="7" height="40" fill="#8C483E"/>
      <rect x="79" y="60" width="7" height="40" fill="#8C483E"/>
      <rect x="51" y="72" width="18" height="28" rx="2" fill="#5D4130"/>
      <rect x="16" y="100" width="88" height="12" rx="3" fill="#6B513A"/>
    </svg>`,
  },
  coast: {
    name: '海港',
    svg: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
      <defs><linearGradient id="csSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#C98A5B"/><stop offset="55%" stop-color="#E4B591"/><stop offset="100%" stop-color="#F6E2C5"/></linearGradient></defs>
      <rect width="120" height="120" fill="url(#csSky)"/>
      <circle cx="60" cy="56" r="18" fill="#FAF0D7"/>
      <rect x="0" y="66" width="120" height="32" fill="#5B758A"/>
      <path d="M0 78 Q30 72 60 78 T120 78 L120 98 L0 98 Z" fill="#496175"/>
      <ellipse cx="60" cy="76" rx="22" ry="3.5" fill="#F6D99B" opacity="0.72"/>
      <path d="M0 94 Q45 86 85 96 T120 92 L120 120 L0 120 Z" fill="#E6D2B5"/>
      <path d="M18 96 L38 74 L52 96 Z" fill="#4A382B"/>
      <rect x="86" y="54" width="6" height="22" fill="#FAF4EC"/>
      <polygon points="84,54 94,54 89,45" fill="#A65D57"/>
    </svg>`,
  },
  mountain: {
    name: '山景',
    svg: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
      <defs><linearGradient id="mtSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#8A7665"/><stop offset="100%" stop-color="#ECDAC4"/></linearGradient></defs>
      <rect width="120" height="120" fill="url(#mtSky)"/>
      <circle cx="88" cy="30" r="13" fill="#FAF0D7"/>
      <polygon points="0,120 46,38 92,120" fill="#4C6B54"/>
      <polygon points="46,38 35,58 46,54 57,58" fill="#F5EFE6" opacity="0.88"/>
      <polygon points="38,120 88,52 120,120" fill="#5D8065"/>
      <path d="M36 120 Q56 96 50 78 T66 64" stroke="#F5E6CC" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    </svg>`,
  },
  cafe: {
    name: '咖啡館',
    svg: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
      <rect width="120" height="120" fill="#F2E6D6"/>
      <path d="M44 36 Q40 26 48 20 M60 34 Q56 24 64 18 M74 36 Q70 26 78 20" stroke="#9A7B5C" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M28 48 H84 V78 A24 24 0 0 1 60 100 H52 A24 24 0 0 1 28 78 Z" fill="#FFFDF9" stroke="#6B513A" stroke-width="4"/>
      <path d="M84 56 H94 A10 10 0 0 1 94 76 H84" fill="none" stroke="#6B513A" stroke-width="4"/>
      <ellipse cx="56" cy="50" rx="24" ry="5" fill="#5B412D"/>
      <rect x="20" y="102" width="76" height="8" rx="4" fill="#9A7B5C"/>
    </svg>`,
  },
  museum: {
    name: '車站館舍',
    svg: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
      <rect width="120" height="120" fill="#ECE2D4"/>
      <polygon points="16,48 60,20 104,48" fill="#7D5C43"/>
      <rect x="20" y="48" width="80" height="8" fill="#5D4330"/>
      <rect x="26" y="56" width="10" height="38" fill="#FFFDF9"/>
      <rect x="46" y="56" width="10" height="38" fill="#FFFDF9"/>
      <rect x="64" y="56" width="10" height="38" fill="#FFFDF9"/>
      <rect x="84" y="56" width="10" height="38" fill="#FFFDF9"/>
      <rect x="14" y="94" width="92" height="12" rx="3" fill="#6B513A"/>
      <rect x="8" y="106" width="104" height="8" rx="2" fill="#4A382B"/>
    </svg>`,
  },
  ramen: {
    name: '美食',
    svg: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
      <rect width="120" height="120" fill="#F5E6DC"/>
      <line x1="76" y1="18" x2="108" y2="48" stroke="#6B513A" stroke-width="4" stroke-linecap="round"/>
      <line x1="64" y1="22" x2="104" y2="56" stroke="#8C6849" stroke-width="4" stroke-linecap="round"/>
      <ellipse cx="58" cy="60" rx="40" ry="16" fill="#FBF2DF" stroke="#9B4D45" stroke-width="4"/>
      <circle cx="42" cy="58" r="10" fill="#C97F4B"/>
      <circle cx="72" cy="56" r="8" fill="#FFFDF9"/><circle cx="72" cy="56" r="4" fill="#D49540"/>
      <path d="M18 60 A40 38 0 0 0 98 60 Z" fill="#A65D57"/>
      <rect x="42" y="96" width="32" height="8" rx="3" fill="#7D413C"/>
    </svg>`,
  },
  park: {
    name: '森系公園',
    svg: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="w-full h-full">
      <defs><linearGradient id="pkSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#DCE6DC"/><stop offset="100%" stop-color="#F5EFE6"/></linearGradient></defs>
      <rect width="120" height="120" fill="url(#pkSky)"/>
      <circle cx="94" cy="24" r="11" fill="#E5C588"/>
      <path d="M0 86 Q45 72 80 84 T120 80 L120 120 L0 120 Z" fill="#79854C"/>
      <rect x="32" y="64" width="8" height="32" rx="2" fill="#6B513A"/>
      <circle cx="36" cy="52" r="19" fill="#5D8065"/>
      <circle cx="24" cy="58" r="13" fill="#6F9176"/>
      <rect x="64" y="84" width="38" height="6" rx="2" fill="#8C6244"/>
      <rect x="68" y="90" width="4" height="12" fill="#5D4130"/>
      <rect x="94" y="90" width="4" height="12" fill="#5D4130"/>
    </svg>`,
  },
};
