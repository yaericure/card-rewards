# 台灣信用卡回饋查詢網站

用戶勾選持有的信用卡與資格 → 輸入商店/支付/地名 → 列出各卡實際回饋%（高到低、只列 ≥2%）。
純靜態網站＋JSON 資料；爬蟲每月自動重抓官網。**2026-07-11 上線 v3。**

- 線上：https://yaericure.github.io/card-rewards/ （GitHub Pages，main 分支根目錄）
- Repo：https://github.com/yaericure/card-rewards （公開）

## 最高原則（歷次重做換來的，違反必被使用者退件）

1. **`data/SCHEMA.md` 是資料格式唯一權威**——動任何爬蟲/前端/資料前先讀它。
2. **實際%，不是標語%**：必須細讀官方細則的回饋組成（基礎＋加碼、上限、條件）。
   例：Chill刷標語「最高10%」，蝦皮實際 3.3%；大全聯 JCB「12%」實為 7%＋贈券活動。
3. **絕不編造**：%數、日期、商店名必須來自實抓的官方頁面原文；抓不到標「未確認」。
4. **一筆 reward 一家商店**：官方清單 N 家拆 N 筆；範圍限定詞「(不含X)/(限X)」進 note、
   target 留乾淨店名；多店合寫「A/B」拆筆。
5. **只收常態回饋**：新戶/首刷/需登錄/限量名額的活動一律不收。
6. **只收 SCHEMA 收錄卡清單的 10 張卡**，各以使用者指定的 URL 為唯一入口（頁內連結可跟一層）。

## 核心概念（使用者親自定義，不可自行重新詮釋）

- **資格（tiers）**＝用戶的狀態/條件（存款等級、發卡組織、消費級距）→ 前端事先詢問。
  `assumedAchieved: true` 的 tier（帳單e化＋自動扣繳類）視為已完成、不問（頁首有聲明）。
- **方案（plan）**＝用戶可自選的商店組合（Chill刷、CUBE 權益方案）→ 不問；查詢結果
  直接標方案名，同卡多方案命中分列多行。`plan`＋`general`＝不限通路方案（如假日刷）。
- **六種回饋對象（targetType）**：merchant（指定商店）/ dining（餐飲）/ online（網路消費
  整通路，依商店 channel 判定命中）/ country（地名＋「海外」）/ mobilepay（行動支付，
  12 個 canonical 支付）/ general（一般消費）。
- **行動支付不是商店**：支付回饋只在「查支付名」或「該店確定收該支付」
  （mobilepay.json 的 acceptedMerchants）時出現。

## 檔案地圖

| 路徑 | 內容 | 維護方式 |
|---|---|---|
| `data/SCHEMA.md` | 資料格式規格（唯一權威） | 手動；改動需使用者同意 |
| `data/cards.json` | 10 卡回饋資料 | **爬蟲產出，勿手改**（每月 CI 覆蓋） |
| `data/merchants.json` | 商店名統一對照表（~400 筆，含 dining/channel 標記） | 手動維護資產，CI 不覆蓋 |
| `data/mobilepay.json` | 12 支付定義＋台新Pay 場域清單 | 手動維護資產，CI 不覆蓋 |
| `data/*.sample.json` | 前端開發用示範資料（載入失敗時 fallback） | 隨 SCHEMA 更新 |
| `index.html` | 單檔前端（CSS/JS 內嵌、無外部資源） | 手動 |
| `scraper/run.js` | 執行框架：逐銀行爬 → output/*.json → schema 驗證 → 合併 | 手動 |
| `scraper/banks/<id>.js` | 各銀行爬蟲（taishin/esun/fubon/cathay/sinopac） | 手動；檔頭註解記來源 URL、解析假設、排除清單 |
| `.github/workflows/update.yml` | 每月 2 號台北 06:00 自動重爬＋commit（Pages 自動重部署） | 手動 |

## 常用指令

```bash
cd scraper
node run.js                  # 爬全部 5 家＋合併 data/cards.json
node run.js taishin esun     # 只爬指定銀行（仍會合併）
node run.js --merge-only     # 不爬，只把 output/*.json 合併
```

- 本機看網站：`python3 -m http.server 8321` 後開 http://localhost:8321 （file:// 開會因 fetch 失敗退到 sample 資料）。
- 合併備援：某銀行本次抓不到會沿用上一版資料並標 `staleSince`（不會消失），下次抓到自動清除。

## 驗證要求（宣稱完成前必做）

1. `node run.js <改動的銀行>` 通過內建 schema 驗證。
2. 抽 2-3 筆 %/商店/日期回官方頁**原文**核對——WebFetch 的 AI 摘要會誤判，要用 raw HTML。
3. 前端行為用 playwright **真實事件**（locator.click()）實測；用 `evaluate` 直改 DOM 不觸發
   change 事件會得出假 bug。讀回饋 % 用 `.result-pct` 元素，別用正則掃整列文字（會誤抓
   備註裡的數字）。
4. 資料改動跑全量歸因審計（複刻前端比對邏輯，對每個商店名模擬查詢、每行結果需可追溯到
   合法命中原因、無重複列、全部 ≥2%、遞減）。歷史版本在 Claude session scratchpad 的
   audit-query.js，若遺失可依 SCHEMA「前端行為」重寫。

## 已知限制與陷阱

- Richart 權益頁（mkp.taishinbank.com.tw）與國泰 CUBE 需 playwright 渲染；CUBE 實際資料
  來自 AEM `.model.json` 內容 API（比渲染頁完整）。
- 台新Pay acceptedMerchants 只收錄 14 家文字可考的（官方完整清單是 logo 圖片無法機器擷取）。
- 商店 channel 標記（online/both/未標=純實體）影響 online 型回饋命中；邊界案例（航空、
  影城、SOGO）保守未標。
- 爬蟲 regex 綁定現行官方文案；銀行改版會抓不到（備援保舊資料），修時參考各檔頭的解析假設。
- CI（GitHub Actions）目前 5 家都抓得到；曾有銀行擋 GitHub IP 的前例（已移除的彰化/華南），
  新增銀行時要實測 CI 環境。
