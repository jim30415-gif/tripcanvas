# 漫步地圖 TripCanvas

自由行旅遊地圖規劃網站（貓頭鷹淺咖啡主題 · Vite + 原生 Vanilla JS + Leaflet + Google Routes API v2 後端代理）。

## 核心特色

- **既有風格與核心機能完整保留**：貓頭鷹淺咖啡色系、單手拉大型傾斜白色行李箱圖示、全站「支出」用語、右側最大化天數圖層搭配底部 3 行精簡總支出卡片、Google 地圖（繁中）底圖、標點拍立得插圖／壓縮上傳／8 款內建插畫、備註與小景點支出、長按／拖曳手把排序、圖層眼睛開關與 JSON 匯出／匯入（向下相容舊版 JSON）。
- **高精度貼路路徑繪製**：汽車、機車、自行車、步行優先透過 Google Routes API v2（`polylineQuality: HIGH_QUALITY`＋逐段 `steps` 折線拼接），未設定金鑰時自動降級至依車種分流的 FOSSGIS OSRM（`routed-car` / `routed-bike` / `routed-foot`），並持久化快取折線，不再出現橫越街區的曲線。
- **大眾運輸分段路線與班次**：串接 Google Maps Routes API `TRANSIT` 模式，在地圖與側欄／彈窗呈現完整「🚶 步行（實景人行道虛線） → 🚇/🚌 大眾運輸（官方路線色實線、上下車站點、路線／方向／發車與抵達時間／經過站數） → 🚶 步行」，並支援指定出發時間、少步行／少轉乘偏好、替代方案切換，亦保留手動填寫紀錄模式。

---

## 本機開發啟動

```bash
npm install
cp .env.example .env.local
# 編輯 .env.local 填入 GOOGLE_MAPS_API_KEY=...
npm run dev
```

開啟終端機顯示的本機網址（預設 `http://localhost:5173`）即可使用。

> 若暫時未填入 `GOOGLE_MAPS_API_KEY`，網站仍可正常運作：汽車／機車／自行車／步行會自動改用免費 FOSSGIS OSRM 貼路引擎，大眾運輸則維持「手動填寫紀錄」模式。

---

## Google Maps Routes API 金鑰設定注意事項（重要）

本專案採用 **方案 A（伺服器端代理 `/api/routes`）**，API 金鑰僅存在伺服器環境變數（本機 `.env.local` 或 Vercel Environment Variables），絕不暴露在前端瀏覽器。

請在 Google Cloud Console 依以下方式設定金鑰限制：

1. 於 **API 和服務 → 程式庫** 啟用 **Routes API**（並確認已綁定計費帳戶，Google 提供每月免費額度）。
2. 於 **憑證** 建立 API 金鑰，在 **API 限制** 中**僅勾選 `Routes API`**。
3. **應用程式限制請保持「無」（勿設定「網站／HTTP 參照網址」網域限制）**：
   - 因為是透過 `/api/routes` 由伺服器端發出請求，請求不會帶有瀏覽器 `Referer` 標頭；若綁定網域限制，Google 會回傳 `API_KEY_HTTP_REFERRER_BLOCKED` 拒絕連線。
   - 若部署於固定 IP 的自架主機可改設「IP 位址」限制；若部署於 Vercel 等 Serverless 平台，請改於 Google Cloud Console 的 **配額（Quotas）** 設定每日／每分鐘上限與預算通知即可。

---

## 部署至 Vercel

1. 將此 GitHub 專案匯入 Vercel（框架選 **Vite**）。
2. 在 Vercel 專案設定 **Environment Variables** 新增 `GOOGLE_MAPS_API_KEY`。
3. **（選填）啟用日本大眾運輸自動查詢**：由於 Google 開發者 API 因日本鐵路業者授權限制不提供日本大眾運輸路線，可於 RapidAPI 免費訂閱 **NAVITIME Route(totalnavi)** 的 **Basic 方案（$0／月、500 次硬上限不扣款）**，並將 `X-RapidAPI-Key` 新增至 Vercel 環境變數 `RAPIDAPI_NAVITIME_KEY` 後重新部署，即可自動抓取全日本 JR／新幹線／地鐵／私鐵分段路線與日圓票價換算。
4. **（選填）啟用「使用者個人 Google 雲端硬碟」跨裝置同步（零資料庫成本）**：
   - 於 Google Cloud Console 啟用免費的 **Google Drive API**。
   - 前往 **Google Auth Platform（OAuth 同意畫面）** 設定為 **外部（External）**，在 **資料存取（Scopes）** 加入非敏感權限 `openid`、`email`、`profile` 與 `https://www.googleapis.com/auth/drive.file`，並於 **目標對象（Audience）** 點選「發布應用程式（Publish App）」成為正式版。
   - 建立 **OAuth 2.0 用戶端 ID（網頁應用程式）**，在「已授權的重新導向 URI」填入 `https://<你的 Vercel 網域>/api/drive-callback`（本機測試可另加 `http://localhost:5173/api/drive-callback`）。
   - 將產生的用戶端編號與密鑰新增至 Vercel 環境變數 `GOOGLE_OAUTH_CLIENT_ID` 與 `GOOGLE_OAUTH_CLIENT_SECRET` 後重新部署，每位使用者即可登入自己的 Google 帳號，把行程自動存於各自雲端硬碟的「`漫步地圖 TripCanvas`」資料夾中。
5. 部署完成後，前端靜態資源與 Serverless 端點 [api/routes.js](api/routes.js)（`/api/routes`）、[api/drive.js](api/drive.js)（`/api/drive`）、[api/drive-callback.js](api/drive-callback.js)（`/api/drive-callback`）會自動一起上線。

---

## 測試指令

```bash
npm test       # 執行單元與代理處理器測試
npm run build  # 驗證正式環境建置
```
