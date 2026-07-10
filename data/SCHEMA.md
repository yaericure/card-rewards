# 資料格式規格（cards.json / merchants.json）

所有產出資料的程式（爬蟲、前端、商店庫）都必須遵守本檔。欄位名一律 camelCase。

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
- **銀行 id 固定**：taishin 台新、esun 玉山、fubon 台北富邦、chb 彰化、sinopac 永豐、tcb 合作金庫、hncb 華南。
- 卡片若有不同方案／等級（如一般 vs 數位帳戶、御璽 vs 無限），每個一筆 `plans[]`；只有單一方案的卡也要有一個 plan（id: "default", name: "一般"）。
- `pct` 為數字（3.8 代表 3.8%）。回饋若為點數（如玉山 e 點、富邦 momo 幣），換算成等值 % 並在 `note` 註明點數型態。
- `validUntil`（YYYY-MM-DD）：活動頁有標「活動期間至」就必填；查不到留空並在 `note` 寫「效期未確認」。**不可編造日期**。
- `rewards[].merchants`（選填）：回饋限指定商店時列出商店名，需與 merchants.json 的 `name` 或 `aliases` 對得上為佳。
- 抓不到、不確定的值：留空＋note 標「未確認」，絕不憑印象填。

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

## 前端比對優先序（index.html 實作依據）

1. 用戶輸入商店名 → 正規化後與 merchants 的 name/aliases 比對（完全符合 > 前綴 > 子字串）。
2. 對每張用戶持有的卡（含所選方案）：先找 `rewards[].merchants` 直接點名該商店的（最優先），再找 category 相符的，最後 fallback 到 `general`。
3. `validUntil` 已過期的方案不參與計算，但可在 UI 標示「已到期，待下次更新」。
4. 取 pct 最高者為該卡代表回饋，排序取前三名。
