/**
 * 繁體中文 ↔ 日本新字體（Shinjitai）↔ 簡體中文 地名搜尋轉換與統一比對工具
 * 解決搜尋「金澤」無法命中「金沢」、「淺草寺」無法命中「浅草寺」、「東京車站」無法命中「東京駅」等跨語系痛點
 */

// 常見旅遊地標與交通詞彙（繁中 → 日本當地常用寫法）
const ZH_TO_JP_PHRASES = [
  ['國際機場', '国際空港'],
  ['晴空塔', 'スカイツリー'],
  ['東京鐵塔', '東京タワー'],
  ['環球影城', 'ユニバーサル・スタジオ'],
  ['迪士尼海洋', 'ディズニーシー'],
  ['迪士尼樂園', 'ディズニーランド'],
  ['迪士尼', 'ディズニー'],
  ['輕井澤', '軽井沢'],
  ['白川鄉', '白川郷'],
  ['伏見稻荷', '伏見稲荷'],
  ['黑門市場', '黒門市場'],
  ['心齋橋', '心斎橋'],
  ['淺草寺', '浅草寺'],
  ['表參道', '表参道'],
  ['台場', 'お台場'],
  ['臺場', 'お台場'],
  ['車站', '駅'],
  ['機場', '空港'],
  ['地鐵', '地下鉄'],
  ['鐵道', '鉄道'],
  ['拉麵', 'ラーメン'],
  ['溫泉', '温泉'],
];

// 繁體中文 → 日本新字體 單字對照（涵蓋日本各大城市、車站、名勝高頻異體字）
const TRAD_TO_JP_SHINJITAI = {
  澤: '沢',
  淺: '浅',
  廣: '広',
  澀: '渋',
  繩: '縄',
  濱: '浜',
  橫: '横',
  櫻: '桜',
  臺: '台',
  關: '関',
  國: '国',
  學: '学',
  萬: '万',
  圓: '円',
  圖: '図',
  廳: '庁',
  縣: '県',
  區: '区',
  灣: '湾',
  龍: '竜',
  鐵: '鉄',
  藝: '芸',
  寶: '宝',
  壽: '寿',
  樂: '楽',
  氣: '気',
  實: '実',
  體: '体',
  號: '号',
  條: '条',
  邊: '辺',
  齋: '斎',
  舊: '旧',
  當: '当',
  會: '会',
  點: '点',
  總: '総',
  發: '発',
  經: '経',
  藥: '薬',
  鹽: '塩',
  豐: '豊',
  滿: '満',
  瀧: '滝',
  藏: '蔵',
  莊: '荘',
  榮: '栄',
  繪: '絵',
  覺: '覚',
  觀: '観',
  醫: '医',
  雙: '双',
  靈: '霊',
  歸: '帰',
  來: '来',
  賣: '売',
  讀: '読',
  寫: '写',
  變: '変',
  與: '与',
  兩: '両',
  傳: '伝',
  價: '価',
  兒: '児',
  黨: '党',
  單: '単',
  嚴: '厳',
  圍: '囲',
  壓: '圧',
  奧: '奥',
  寬: '寛',
  對: '対',
  專: '専',
  將: '将',
  屬: '属',
  嶽: '岳',
  峽: '峡',
  帶: '帯',
  彌: '弥',
  德: '徳',
  應: '応',
  戰: '戦',
  數: '数',
  晝: '昼',
  曉: '暁',
  樓: '楼',
  樣: '様',
  權: '権',
  歐: '欧',
  淨: '浄',
  濟: '済',
  燈: '灯',
  營: '営',
  獨: '独',
  畫: '画',
  疊: '畳',
  禮: '礼',
  禪: '禅',
  稻: '稲',
  穗: '穂',
  穩: '穏',
  絲: '糸',
  綠: '緑',
  繼: '継',
  續: '続',
  聽: '聴',
  腦: '脳',
  臟: '臓',
  螢: '蛍',
  蟲: '虫',
  裝: '装',
  覽: '覧',
  譯: '訳',
  讓: '譲',
  讚: '賛',
  轉: '転',
  輕: '軽',
  遲: '遅',
  遙: '遥',
  錢: '銭',
  險: '険',
  隱: '隠',
  雜: '雑',
  靜: '静',
  響: '響',
  顯: '顕',
  餘: '余',
  驛: '駅',
  驅: '駆',
  驗: '験',
  髮: '髪',
  齊: '斉',
  龜: '亀',
  麵: '麺',
  黑: '黒',
  步: '歩',
  涉: '渉',
  每: '毎',
  黃: '黄',
  戶: '戸',
  鄉: '郷',
  參: '参',
  姬: '姫',
  麥: '麦',
  齒: '歯',
  溫: '温',
  島: '島',
  嶋: '島',
  館: '館',
  橋: '橋',
  場: '場',
  東: '東',
  車: '車',
  門: '門',
  園: '園',
  華: '華',
  馬: '馬',
  鳥: '鳥',
  魚: '魚',
  鳳: '鳳',
  鳴: '鳴',
};

// 簡體中文／日本新字體 → 統一繁體中文（用於反向轉換與跨語系相似度比對）
const VARIANT_TO_TRAD = {
  // 日本新字體 → 繁中
  沢: '澤',
  浅: '淺',
  広: '廣',
  渋: '澀',
  縄: '繩',
  浜: '濱',
  横: '橫',
  桜: '櫻',
  関: '關',
  国: '國',
  学: '學',
  万: '萬',
  円: '圓',
  図: '圖',
  庁: '廳',
  県: '縣',
  区: '區',
  湾: '灣',
  竜: '龍',
  鉄: '鐵',
  芸: '藝',
  宝: '寶',
  寿: '壽',
  楽: '樂',
  気: '氣',
  実: '實',
  体: '體',
  号: '號',
  条: '條',
  辺: '邊',
  斎: '齋',
  旧: '舊',
  当: '當',
  会: '會',
  点: '點',
  総: '總',
  発: '發',
  経: '經',
  薬: '藥',
  塩: '鹽',
  豊: '豐',
  満: '滿',
  滝: '瀧',
  蔵: '藏',
  荘: '莊',
  栄: '榮',
  絵: '繪',
  覚: '覺',
  観: '觀',
  医: '醫',
  双: '雙',
  霊: '靈',
  帰: '歸',
  来: '來',
  売: '賣',
  読: '讀',
  写: '寫',
  変: '變',
  与: '與',
  両: '兩',
  伝: '傳',
  価: '價',
  児: '兒',
  党: '黨',
  単: '單',
  厳: '嚴',
  囲: '圍',
  圧: '壓',
  奥: '奧',
  寛: '寬',
  対: '對',
  専: '專',
  将: '將',
  属: '屬',
  峡: '峽',
  帯: '帶',
  弥: '彌',
  徳: '德',
  応: '應',
  戦: '戰',
  数: '數',
  昼: '晝',
  暁: '曉',
  楼: '樓',
  様: '樣',
  権: '權',
  欧: '歐',
  浄: '淨',
  済: '濟',
  灯: '燈',
  営: '營',
  独: '獨',
  画: '畫',
  畳: '疊',
  礼: '禮',
  禅: '禪',
  稲: '稻',
  穂: '穗',
  穏: '穩',
  緑: '綠',
  継: '繼',
  続: '續',
  聴: '聽',
  脳: '腦',
  臓: '臟',
  蛍: '螢',
  虫: '蟲',
  装: '裝',
  覧: '覽',
  訳: '譯',
  譲: '讓',
  賛: '讚',
  転: '轉',
  軽: '輕',
  遅: '遲',
  遥: '遙',
  銭: '錢',
  険: '險',
  隠: '隱',
  雑: '雜',
  静: '靜',
  顕: '顯',
  余: '餘',
  駅: '站',
  駆: '驅',
  験: '驗',
  髪: '髮',
  斉: '齊',
  亀: '龜',
  麺: '麵',
  黒: '黑',
  歩: '步',
  渉: '涉',
  毎: '每',
  黄: '黃',
  戸: '戶',
  郷: '鄉',
  参: '參',
  姫: '姬',
  麦: '麥',
  歯: '齒',
  温: '溫',
  臺: '台',
  // 簡體中文高頻旅遊字 → 繁中
  泽: '澤',
  广: '廣',
  涩: '澀',
  绳: '繩',
  滨: '濱',
  东: '東',
  门: '門',
  馆: '館',
  园: '園',
  岛: '島',
  桥: '橋',
  车: '車',
  机: '機',
  场: '場',
  华: '華',
  铁: '鐵',
  龙: '龍',
  乐: '樂',
  庙: '廟',
  岭: '嶺',
  宫: '宮',
  乡: '鄉',
  斋: '齋',
  丰: '豐',
  满: '滿',
  湾: '灣',
  县: '縣',
  区: '區',
  驿: '站',
  轻: '輕',
  岛: '島',
  风: '風',
  景: '景',
  观: '觀',
  艺: '藝',
  术: '術',
  博: '博',
  物: '物',
  书: '書',
  店: '店',
  饭: '飯',
  面: '麵',
  鱼: '魚',
  鸟: '鳥',
  马: '馬',
  阳: '陽',
  阴: '陰',
  云: '雲',
  电: '電',
  线: '線',
  号: '號',
  条: '條',
  边: '邊',
  旧: '舊',
  当: '當',
  会: '會',
  点: '點',
  总: '總',
  发: '發',
  经: '經',
  药: '藥',
  盐: '鹽',
  宝: '寶',
  寿: '壽',
  气: '氣',
  实: '實',
  体: '體',
  图: '圖',
  厅: '廳',
  学: '學',
  关: '關',
};

function mapChars(text, table) {
  let out = '';
  for (const ch of text) {
    out += table[ch] || ch;
  }
  return out;
}

/**
 * 將繁體中文／簡體中文查詢轉為日本當地常見新字體寫法（如：金澤 → 金沢、東京車站 → 東京駅）
 */
export function toJapaneseShinjitai(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  // 先統一簡體 → 繁體，再轉日文詞彙與新字體（確保「金泽」也能通「金沢」）
  let text = mapChars(trimmed, VARIANT_TO_TRAD);
  for (const [zh, jp] of ZH_TO_JP_PHRASES) {
    if (text.includes(zh)) {
      text = text.split(zh).join(jp);
    }
  }
  return mapChars(text, TRAD_TO_JP_SHINJITAI);
}

/**
 * 將日本新字體／簡體中文查詢轉為台灣繁體中文（如：金沢 → 金澤、浅草 → 淺草、金沢駅 → 金澤車站）
 */
export function toTraditionalChinese(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  let text = trimmed.replace(/国際空港/g, '國際機場').replace(/空港/g, '機場').replace(/地下鉄/g, '地鐵').replace(/駅/g, '車站');
  return mapChars(text, VARIANT_TO_TRAD);
}

/**
 * 產生跨語系比對用的標準化字串（繁中／日文新字體／簡中／全半形／臺台 均收斂成同一形式）
 * 例：canonicalizePlaceName('金澤車站') === canonicalizePlaceName('金沢駅') === canonicalizePlaceName('金泽车站')
 */
export function canonicalizePlaceName(raw = '') {
  const base = String(raw || '')
    .normalize('NFKC')
    .toLowerCase()
    .trim();
  if (!base) return '';
  const unified = base
    .replace(/車站/g, '站')
    .replace(/车站/g, '站')
    .replace(/駅/g, '站')
    .replace(/國際機場/g, '機場')
    .replace(/国際空港/g, '機場')
    .replace(/空港/g, '機場');
  const mapped = mapChars(unified, VARIANT_TO_TRAD);
  return mapped.replace(/[\s・·\-_,，、.()（）【】\[\]「」『』/]+/g, '');
}

/**
 * 依查詢字與本計畫國家產生去重後的跨語系搜尋變體清單
 * 回傳 { primary, variants, convertedHint }
 */
export function buildSearchQueryVariants(rawQuery = '', tripCountries = []) {
  const original = String(rawQuery || '').trim();
  if (!original) return { primary: '', variants: [], convertedHint: '' };

  const jpVariant = toJapaneseShinjitai(original);
  const twVariant = toTraditionalChinese(original);
  const prefersJapan = Array.isArray(tripCountries) && tripCountries[0] === 'JP';

  const seen = new Set();
  const variants = [];
  const push = (q) => {
    const clean = String(q || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    variants.push(clean);
  };

  if (prefersJapan && jpVariant && jpVariant !== original) {
    push(jpVariant);
    push(original);
    push(twVariant);
  } else {
    push(original);
    if (jpVariant && jpVariant !== original) push(jpVariant);
    if (twVariant && twVariant !== original) push(twVariant);
  }

  let convertedHint = '';
  if (jpVariant && jpVariant !== original) {
    convertedHint = jpVariant;
  } else if (twVariant && twVariant !== original) {
    convertedHint = twVariant;
  }

  return {
    primary: variants[0] || original,
    variants: variants.slice(0, 3),
    convertedHint,
  };
}
