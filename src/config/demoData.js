import { DAY_COLORS } from './constants.js';

/* 預設 2 天台北自由行示範行程（內含支出分類與交通支出示範） */
export function createDemoState() {
  return {
    activeDayId: 'day_1',
    addMode: true,
    days: [
      {
        id: 'day_1',
        name: 'Day 1 · 台北城文青散步',
        color: DAY_COLORS[0],
        visible: true,
        pins: [
          {
            id: 'p_d1_1',
            name: '台北車站',
            lat: 25.0478,
            lng: 121.517,
            image: { type: 'preset', value: 'museum' },
            notes: '於東三門集合出發，先在 B1 寄放隨身行李並加值悠遊卡，買杯手沖咖啡展開台北自由行。',
            subSpots: [
              { id: 's_101', name: '車站行李置物櫃', cost: 120, category: 'other' },
              { id: 's_102', name: '早安手沖咖啡與可頌', cost: 165, category: 'food' },
            ],
            transportToNext: {
              mode: 'transit',
              status: 'manual',
              autoUpgradeOnGoogle: true,
              duration: 9,
              distanceKm: null,
              cost: 20,
              transitType: '捷運',
              line: '板南線',
              schedule: '往南港展覽館（手動紀錄範例）',
            },
          },
          {
            id: 'p_d1_2',
            name: '華山 1914 文創園區',
            lat: 25.0441,
            lng: 121.5294,
            image: { type: 'preset', value: 'cafe' },
            notes: '紅磚老酒廠建築群，逛限定主題特展與選物小店，中午在園區木質調咖啡廳享用早午餐。',
            subSpots: [
              { id: 's_103', name: '特展入場門票', cost: 380, category: 'other' },
              { id: 's_104', name: '園區手作咖啡與早午餐', cost: 420, category: 'food' },
              { id: 's_105', name: '原創設計文創小物', cost: 290, category: 'shopping' },
            ],
            transportToNext: {
              mode: 'walk',
              status: 'pending',
              duration: null,
              distanceKm: null,
              cost: 0,
              transitType: '',
              line: '',
              schedule: '',
            },
          },
          {
            id: 'p_d1_3',
            name: '永康街美食商圈',
            lat: 25.0332,
            lng: 121.5296,
            image: { type: 'preset', value: 'ramen' },
            notes: '散步巷弄品嚐經典牛肉麵、現煎蔥抓餅與季節芒果冰，順路逛特色茶行。',
            subSpots: [
              { id: 's_106', name: '永康經典牛肉麵 / 拉麵', cost: 320, category: 'food' },
              { id: 's_107', name: '季節鮮果芒果雪花冰', cost: 240, category: 'food' },
              { id: 's_108', name: '排隊手工蔥抓餅', cost: 65, category: 'food' },
            ],
            transportToNext: {
              mode: 'transit',
              status: 'manual',
              autoUpgradeOnGoogle: true,
              duration: 17,
              distanceKm: null,
              cost: 25,
              transitType: '捷運',
              line: '淡水信義線',
              schedule: '往象山（手動紀錄範例）',
            },
          },
          {
            id: 'p_d1_4',
            name: '象山親山步道',
            lat: 25.0273,
            lng: 121.5706,
            image: { type: 'preset', value: 'mountain' },
            notes: '從靈雲宮登山口出發約 20 分鐘抵達六巨石平台，拍攝 101 黃金夕陽與百萬夜景。',
            subSpots: [{ id: 's_109', name: '登山口愛玉冰與飲品', cost: 90, category: 'food' }],
            transportToNext: null,
          },
        ],
      },
      {
        id: 'day_2',
        name: 'Day 2 · 淡水古蹟與海港夕陽',
        color: DAY_COLORS[1],
        visible: true,
        pins: [
          {
            id: 'p_d2_1',
            name: '淡水老街',
            lat: 25.1704,
            lng: 121.4408,
            image: { type: 'preset', value: 'nightmarket' },
            notes: '沿著金色水岸漫步老街，必吃老牌淡水阿給、魚丸湯與古早味現烤蛋糕。',
            subSpots: [
              { id: 's_201', name: '淡水阿給 + 魚丸湯套餐', cost: 135, category: 'food' },
              { id: 's_202', name: '阿婆鐵蛋與魚酥伴手禮', cost: 340, category: 'shopping' },
            ],
            transportToNext: {
              mode: 'walk',
              status: 'pending',
              duration: null,
              distanceKm: null,
              cost: 0,
              transitType: '',
              line: '',
              schedule: '',
            },
          },
          {
            id: 'p_d2_2',
            name: '淡水紅毛城',
            lat: 25.1754,
            lng: 121.4329,
            image: { type: 'preset', value: 'temple' },
            notes: '走訪百年紅磚古蹟與前清英國領事官邸，在山丘草坪眺望觀音山與淡水河口。',
            subSpots: [
              { id: 's_203', name: '紅毛城古蹟園區門票', cost: 80, category: 'other' },
              { id: 's_204', name: '領事館文青明信片', cost: 120, category: 'shopping' },
            ],
            transportToNext: {
              mode: 'transit',
              status: 'manual',
              autoUpgradeOnGoogle: true,
              duration: 14,
              distanceKm: null,
              cost: 15,
              transitType: '公車',
              line: '紅 26 號公車',
              schedule: '往漁人碼頭（手動紀錄範例）',
            },
          },
          {
            id: 'p_d2_3',
            name: '淡水漁人碼頭',
            lat: 25.183,
            lng: 121.4106,
            image: { type: 'preset', value: 'coast' },
            notes: '漫步白色情人橋與木棧道欣賞台灣海峽落日餘暉，晚餐於港邊景觀餐廳享用海鮮。',
            subSpots: [
              { id: 's_205', name: '港邊海鮮夕陽晚餐', cost: 680, category: 'food' },
              { id: 's_206', name: '渡輪返回淡水老街船票', cost: 60, category: 'transport' },
            ],
            transportToNext: null,
          },
        ],
      },
    ],
  };
}

export function createBlankTripState() {
  return {
    activeDayId: 'day_1',
    addMode: true,
    days: [
      {
        id: 'day_1',
        name: 'Day 1 · 旅程起點',
        color: DAY_COLORS[0],
        visible: true,
        pins: [],
      },
    ],
  };
}
