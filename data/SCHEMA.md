# 資料格式規格 v2（cards.json / merchants.json）

所有產出資料的程式（爬蟲、前端、商店庫）都必須遵守本檔。欄位名一律 camelCase。

## v2 核心原則：商店優先，不得壓扁成大類別

v1 的致命錯誤：把「指定通路清單」簡化成 category（例：Richart 天天刷的指定通路含 IKEA、
全聯等具體商店，v1 只記成 supermarket 大類，導致用戶查 IKEA 對不到回饋）。v2 規則：

1. 回饋若有**官方指定通路清單**（頁面、彈窗、PDF 內列舉的商店），`rewards[].merchants`
   **必須收錄完整清單**，一家不漏。清單在 PDF 就解析 PDF；在彈窗就用 playwright 展開。
2. 真的無法取得完整清單時：收錄已確認的部分＋`note` 標「官方清單未完整收錄（來源：<URL>），
   已收錄 N/總數」。**寧可標註不完整，不可用 category 頂替商店清單。**
3. `category` 只用於兩種情況：(a) 整類通用、官方本來就沒有列舉商店的回饋（如「國內一般消費
   1%」「海外消費 2%」）；(b) 有 merchants 清單時的輔助分類標籤（供 UI 分組與類別 fallback）。
4. 前端搜尋必須直接比對 cards.json 內所有 rewards[].merchants（不只 merchants.json）。

## 通路類別（category）固定清單

前端、爬蟲、商店庫三方共用，**只能用以下 id**，不可自創：

| id | 中文 |
|---|---|
| general | 一般消費（無指定通路） |
| online | 網購 |
| convenience | 超商 |
| supermarket | 超市／量販 |
| department | 百貨 |
| dining | 餐飲 |
| delivery | 外送平台 |
| transport | 交通（捷運/公車/計程車/高鐵/台鐵/停車） |
| gas | 加油 |
| travel | 旅遊（訂房/機票/旅行社） |
| overseas | 海外消費 |
| streaming | 影音串流／數位訂閱 |
| mobilepay | 行動支付（Line Pay/街口/Apple Pay 等） |
| telecom | 電信費 |
| insurance | 保費 |
| utilities | 稅費／公用事業／學費 |
| medical | 醫療 |
| entertainment | 娛樂（電影/遊戲/票券） |

## data/cards.json

```json
{
  "updatedAt": "2026-07-10T00:00:00.000Z",
  "banks": [
    {
      "id": "taishin",
      "name": "台新銀行",
      "cards": [
        {
          "id": "taishin-gogo",
          "name": "@GoGo 卡",
          "url": "https://（該卡官方頁面，實際抓取來源）",
          "plans": [
            {
              "id": "digital",
              "name": "數位帳戶方案",
              "condition": "需綁定 Richart 帳戶自動扣繳（無條件方案的 condition 填「無條件」）",
              "validFrom": "2026-01-01",
              "validUntil": "2026-12-31",
              "rewards": [
                {
                  "category": "online",
                  "pct": 3.8,
                  "merchants": ["momo購物網", "蝦皮購物"],
                  "cap": "每期回饋上限 NT$500",
                  "note": "限指定通路；來源頁未列完整名單"
                },
                { "category": "general", "pct": 0.3 }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

規則：
- **銀行 id 固定**：taishin 台新、esun 玉山、fubon 台北富邦、cathay 國泰世華、sinopac 永豐。
- 卡片若有不同方案／等級（如一般 vs 數位帳戶、御璽 vs 無限），每個一筆 `plans[]`；只有單一方案的卡也要有一個 plan（id: "default", name: "一般"）。
- `planKind`（card 層級，**多 plans 的卡必填**，單一 plan 免填）：
  - `"switchable"`＝**方案**：持卡人可自行切換（如國泰 CUBE 權益方案、台新 Richart 切換方案、玉山 Unicard）。前端**不**在第二步詢問；結果頁對每個消費情境自動取回饋最高的方案，並附註「建議方案：○○」。
  - `"tier"`＝**等級／資格**：回饋取決於持卡人的等級或資格（如永豐 DAWHO 依存款等級、新戶限定、帳戶自動扣繳與否）。前端第二步請用戶選擇自己適用的等級。
  - 前端對「多 plans 但缺 planKind」的卡按 `"tier"` 處理（保守：寧可多問一次，不替用戶假設）。
- `pct` 為數字（3.8 代表 3.8%）。回饋若為點數（如玉山 e 點、富邦 momo 幣），換算成等值 % 並在 `note` 註明點數型態。
- `validUntil`（YYYY-MM-DD）：活動頁有標「活動期間至」就必填；查不到留空並在 `note` 寫「效期未確認」。**不可編造日期**。
- `rewards[].merchants`：回饋限指定通路時**必填且必須完整**（見 v2 核心原則）；商店名用官方清單上的原文寫法。
- `rewards[].merchantsComplete`（布林，有 merchants 時必填）：true＝已收錄官方全清單；false＝不完整（note 必須說明來源與缺漏）。
- 抓不到、不確定的值：留空＋note 標「未確認」，絕不憑印象填。
- `staleSince`（bank 或 card 層級，選填，由 run.js 合併時自動加）：該筆資料在最近一次更新中未能重抓、沿用舊資料的時間戳（ISO）。爬蟲模組不要自己寫這個欄位；重抓成功後會自動消失。

## data/merchants.json

```json
{
  "merchants": [
    { "name": "momo購物網", "aliases": ["momo", "momoshop", "富邦momo"], "category": "online" },
    { "name": "7-ELEVEN", "aliases": ["711", "7-11", "seven", "小七", "統一超商"], "category": "convenience" }
  ]
}
```

- `name` 用最常見的正式寫法；`aliases` 收常見別稱／英文／簡寫（比對時前端會做正規化：轉小寫、去空白與連字號）。
- `category` 必須是上表的 id。

## 前端比對優先序（index.html 實作依據，v2）

1. 用戶輸入商店名 → 正規化（轉小寫、去空白與連字號）後比對**兩個來源**：
   (a) cards.json 所有 rewards[].merchants 的商店名（主要）；(b) merchants.json 的
   name/aliases（用於 autocomplete 與類別 fallback）。完全符合 > 前綴 > 子字串。
2. 對每張用戶持有的卡（含所選/取優方案）依序找適用回饋：
   ① `rewards[].merchants` 直接命中該商店（最優先）→ ② 商店經 merchants.json 對到
   category、且卡有該 category 的「整類通用」回饋 → ③ fallback 到 `general`。
3. 結果需標示命中原因：「指定通路命中：IKEA」／「類別回饋：超市量販」／「一般消費回饋」。
4. `validUntil` 已過期的方案不參與計算，但可在 UI 標示「已到期，待下次更新」。
5. 取 pct 最高者為該卡代表回饋，排序取前三名。
