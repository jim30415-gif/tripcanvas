export const STORAGE_KEY = 'tripcanvas_travel_planner_owl_v4';
export const WORKSPACE_STORAGE_KEY = 'tripcanvas_workspace_owl_v5';
export const ROUTE_CACHE_STORAGE_KEY = 'tripcanvas_route_cache_v2';

/* 支出分類定義（交通、食物、購物、其他） */
export const EXPENSE_CATEGORIES = [
  { id: 'transport', label: '交通', emoji: '🚆', color: '#5B758A' },
  { id: 'food', label: '食物', emoji: '🍜', color: '#C48F3B' },
  { id: 'shopping', label: '購物', emoji: '🛍️', color: '#A65D57' },
  { id: 'other', label: '其他', emoji: '✨', color: '#8C6A5D' },
];

export const EXPENSE_CATEGORY_MAP = Object.fromEntries(
  EXPENSE_CATEGORIES.map((c) => [c.id, c])
);

/* 天數圖層預設自然大地色系 */
export const DAY_COLORS = [
  '#A46C49', // 1. 暖焦糖咖
  '#5D8065', // 2. 森林鼠尾草
  '#C48F3B', // 3. 貓頭鷹金褐
  '#5B758A', // 4. 暮光灰藍
  '#A65D57', // 5. 莓果陶紅
  '#79854C', // 6. 苔蘚橄欖
  '#8C6A5D', // 7. 栗木暖棕
  '#647A78', // 8. 霧松青灰
];

/* 固定優先使用 Google 地圖（繁中），背景靜默備援 */
export const SILENT_TILE_SOURCES = [
  {
    id: 'google_zhtw',
    type: 'tile',
    url: 'https://mt{s}.google.com/vt/lyrs=m&hl=zh-TW&x={x}&y={y}&z={z}',
    options: {
      subdomains: ['1', '0', '2', '3'],
      maxZoom: 20,
      attribution: '&copy; Google Maps',
    },
  },
  {
    id: 'carto_voyager',
    type: 'tile',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    },
  },
  {
    id: 'osm_standard',
    type: 'tile',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    },
  },
  {
    id: 'offline_grid',
    type: 'canvas',
    options: {
      maxZoom: 20,
      attribution: 'TripCanvas 離線向量網格',
    },
  },
];

/* 五種交通方式設定（對應 Google Routes API、FOSSGIS OSRM 備援與 Google Maps 外部連結） */
export const TRANSPORT_MODES = {
  car: {
    id: 'car',
    label: '汽車',
    emoji: '🚗',
    fossgisService: 'routed-car',
    gmapsMode: 'driving',
    dashArray: null,
    weight: 4.8,
  },
  scooter: {
    id: 'scooter',
    label: '機車',
    emoji: '🛵',
    fossgisService: 'routed-car',
    gmapsMode: 'driving',
    dashArray: '11, 5',
    weight: 4.2,
  },
  transit: {
    id: 'transit',
    label: '大眾運輸',
    emoji: '🚆',
    fossgisService: null,
    gmapsMode: 'transit',
    dashArray: '6, 8',
    weight: 4.4,
  },
  bike: {
    id: 'bike',
    label: '自行車',
    emoji: '🚲',
    fossgisService: 'routed-bike',
    gmapsMode: 'bicycling',
    dashArray: '8, 6',
    weight: 4.0,
  },
  walk: {
    id: 'walk',
    label: '步行',
    emoji: '🚶',
    fossgisService: 'routed-foot',
    gmapsMode: 'walking',
    dashArray: '2, 8',
    weight: 3.8,
  },
};

/* 大眾運輸路線偏好（Google Routes API TransitRoutingPreference） */
export const TRANSIT_PREFERENCES = [
  { id: 'DEFAULT', label: '預設最佳' },
  { id: 'LESS_WALKING', label: '少步行' },
  { id: 'FEWER_TRANSFERS', label: '少轉乘' },
];

/* 大眾運輸手動紀錄可選工具類型 */
export const TRANSIT_TYPES = [
  { id: '捷運', emoji: '🚇', label: '捷運' },
  { id: '地鐵', emoji: '🚇', label: '地鐵' },
  { id: '公車', emoji: '🚌', label: '公車' },
  { id: '台鐵', emoji: '🚆', label: '台鐵' },
  { id: '高鐵', emoji: '🚄', label: '高鐵' },
  { id: 'JR', emoji: '🚆', label: 'JR' },
  { id: '新幹線', emoji: '🚄', label: '新幹線' },
  { id: '私鐵', emoji: '🚃', label: '私鐵' },
  { id: '飛機', emoji: '✈️', label: '飛機' },
  { id: '渡輪', emoji: '⛴️', label: '渡輪' },
  { id: '其他', emoji: '🎫', label: '其他' },
];

/* 手動支出支援的外幣選單（會即時自動換算為新台幣 NT$ 計入總支出） */
export const SUPPORTED_CURRENCIES = [
  { code: 'TWD', symbol: 'NT$', label: 'NT$ 台幣', shortLabel: 'NT$' },
  { code: 'JPY', symbol: '¥', label: '¥ 日圓', shortLabel: '¥ JPY' },
  { code: 'KRW', symbol: '₩', label: '₩ 韓元', shortLabel: '₩ KRW' },
  { code: 'USD', symbol: '$', label: '$ 美元', shortLabel: '$ USD' },
  { code: 'EUR', symbol: '€', label: '€ 歐元', shortLabel: '€ EUR' },
  { code: 'HKD', symbol: 'HK$', label: 'HK$ 港幣', shortLabel: 'HK$' },
  { code: 'THB', symbol: '฿', label: '฿ 泰銖', shortLabel: '฿ THB' },
  { code: 'SGD', symbol: 'S$', label: 'S$ 新幣', shortLabel: 'S$ SGD' },
  { code: 'GBP', symbol: '£', label: '£ 英鎊', shortLabel: '£ GBP' },
  { code: 'CNY', symbol: '¥', label: '¥ 人民幣', shortLabel: '¥ CNY' },
];

