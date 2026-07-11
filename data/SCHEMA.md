# 資料格式規格 v3（cards.json / merchants.json）

所有產出資料的程式（爬蟲、前端、商店對照表）都必須遵守本檔。欄位名一律 camelCase。

## v3 核心原則（使用者 2026-07-11 拍板）

1. **只收指定卡、只從指定頁抓**：收錄卡清單見下表，每張卡以使用者指定的 URL 為唯一入口。
   該頁內連出的權益細則、彈窗、PDF 視為頁面的一部分（可跟一層），其他來源不用。
2. **等級（tier）**：依「用戶達成的條件」決定同一商店的不同回饋%（如帳戶扣繳與否、存款等級、
   月消費級距）。前端**事先詢問**用戶勾選自己的等級。
3. **方案（plan）**：依「用戶選擇的方案」決定哪些商店組合有回饋（如 Richart 的 Chill刷/數趣刷、
   CUBE 權益方案、Unicard 選組）。前端**不詢問**；查詢結果直接顯示「%數＋對應方案名」。
   同一張卡對同一商店有多個方案命中時，**每個方案分列一行**。
4. **實際%，不是標語%**：必須細讀細則，記錄每個商店「實際拿得到」的%。
   例：Chill刷標語「最高10%」，細則中蝦皮實為 3.3% → 記 3.3%。細則沒有給出可證明適用
   該商店的具體% → 不收該筆或 note 標「未確認」，絕不記標語數字。
5. **消費類別廢除，只留餐飲**：不再有 18 類 taxonomy。回饋對象只有四種 targetType（見下）。
6. **國外消費統整到地名**：日本、韓國、美國、歐洲…（照頁面實際出現的地區寫）。

## 收錄卡清單（10 張，URL 為使用者指定）

| bank id | 卡 id | 卡名 | 入口 URL |
|---|---|---|---|
| taishin | taishin-richart | 台新Richart卡 | https://www.taishinbank.com.tw/TSB/personal/credit/intro/overview/cg047/card001/ |
| taishin | taishin-jko | 街口聯名卡 | https://www.taishinbank.com.tw/TSB/personal/credit/intro/overview/cg038/card001/ |
| taishin | taishin-pxmart | 大全聯信用卡 | https://www.taishinbank.com.tw/TSB/personal/credit/intro/overview/cg010/card001/ |
| esun | esun-unicard | 玉山Unicard | https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/unicard#3 |
| esun | esun-pi | 玉山Pi拍錢包信用卡 | https://www.esunbank.com/zh-tw/personal/credit-card/intro/co-branded-card/pi-card |
| esun | esun-ubear | 玉山U Bear信用卡 | https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/u-bear |
| fubon | fubon-momo | momo卡 | https://www.fubon.com/banking/Personal/credit_card/all_card/momo/momo.htm |
| fubon | fubon-costco | 富邦Costco聯名卡 | https://www.fubon.com/banking/personal/credit_card/all_card/costco/costco.htm |
| cathay | cathay-cube | CUBE信用卡 | https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube |
| sinopac | sinopac-dawho | DAWHO現金回饋信用卡 | https://bank.sinopac.com/sinopacBT/personal/credit-card/introduction/bankcard/DAWHO.html |

此清單以外的卡一律不收（v2 的玉山ecard/鈦金、富邦數位生活、永豐幣倍/SPORT 皆移除）。

## data/cards.json

```json
{
  "updatedAt": "2026-07-11T00:00:00.000Z",
  "banks": [
    {
      "id": "taishin",
      "name": "台新銀行",
      "cards": [
        {
          "id": "taishin-richart",
          "name": "台新Richart卡",
          "url": "（上表的指定 URL）",
          "tiers": [
            { "id": "autopay", "name": "已設定帳戶扣繳", "condition": "以台新帳戶自動扣繳卡費" },
            { "id": "none", "name": "未設定", "condition": "" }
          ],
          "rewards": [
            {
              "plan": "Chill刷",
              "target": "蝦皮購物",
              "targetType": "merchant",
              "pct": 3.3,
              "cap": "每期上限 NT$300",
              "validUntil": "2026-09-30",
              "note": "標語為最高10%，蝦皮實際適用 3.3%（基礎0.3%+加碼3%）"
            },
            { "targetType": "dining", "pct": 5, "plan": "好饗刷" },
            { "target": "日本", "targetType": "country", "pct": 3, "plan": "玩旅刷" },
            { "targetType": "general", "pctByTier": { "autopay": 0.8, "none": 0.3 } }
          ]
        }
      ]
    }
  ]
}
```

### 欄位規則

- `tiers`（card 層級，選填）：卡有「等級」概念才填（≥2 個）。`id` 短英文、`name` 顯示名、
  `condition` 達成條件說明。無等級概念的卡省略整個欄位。
- `rewards[]` 為卡的**扁平**回饋清單，每筆：
  - `plan`（選填字串）：所屬方案名（使用者可自選的方案）。非方案型回饋（基本回饋、
    全卡通用活動）省略。
  - `targetType`（必填）：`"merchant"`（指定商店）｜`"dining"`（餐飲，唯一保留的類別）｜
    `"country"`（國外地區）｜`"general"`（一般消費）。
  - `target`：targetType=merchant 時必填＝商店名（照官方頁原文寫法）；country 時必填＝
    地名（日本/韓國/美國/歐洲…；官方只寫「國外/海外消費」不分國家時用 `"海外"`）；
    dining/general 省略。
  - **一筆 reward 只對應一家商店**：官方清單列 N 家 → 拆成 N 筆 reward（各自可有相同
    pct/cap/validUntil）。這讓「同卡同商店不同方案分列」與跨銀行商店名統一都變簡單。
  - `pct`（數字）或 `pctByTier`（物件，key 必須是該卡 tiers 的 id，值為數字）——二選一必填。
  - `cap`、`validUntil`（YYYY-MM-DD）、`note`：同 v2 規則（有期限必填 validUntil；
    不確定的標「未確認」，絕不編造）。
- 商店名寫**官方頁原文**；跨銀行統一交給 merchants.json 對照表與前端正規化，爬蟲不要自行改名。

## data/merchants.json（v3：商店名統一對照表）

```json
{
  "merchants": [
    { "name": "蝦皮購物", "aliases": ["蝦皮", "shopee", "蝦皮商城"] },
    { "name": "遠東巨城購物中心", "aliases": ["Big City遠東巨城購物中心", "遠東巨城", "巨城", "Big City"], "dining": false },
    { "name": "鼎泰豐", "aliases": [], "dining": true }
  ]
}
```

- 作用：(1) 跨銀行同店異名統一（同一家店的各種官方寫法都放進同一筆的 name/aliases）；
  (2) `dining: true` 標記餐飲商店，讓用戶查該店時能命中 dining 型回饋。
- 對照表以「實際出現在 cards.json 的商店名」為基礎建立，再補常見俗稱。

## 前端行為（index.html 實作依據）

1. 步驟一：勾選持有的卡（10 張）。
2. 步驟二：只對有 `tiers` 的卡詢問用戶等級（單選）；沒有任何卡需要選就跳過。
3. 查詢：輸入商店名 → 正規化（小寫、去空白與連字號）後經 merchants.json 統一為 canonical，
   再比對 rewards：
   - targetType=merchant 且 target（同樣經對照表統一後）相符 → 命中
   - 商店標記 dining=true → 也命中 dining 型 rewards
   - 每張卡的 general 回饋列為「基本回饋」行（墊底參考）
   - 也可直接輸入地名（日本、韓國…）查 country 型回饋
4. 結果**全列出**（不取前三名），每行＝一個（卡×方案）組合：卡名｜方案名（無方案顯示「基本」）｜
   實際%（依所選等級解析 pctByTier）｜上限｜期限｜備註。同卡不同方案分列。% 由高到低排序。
5. `validUntil` 過期的 reward 不列（或摺疊標示「已到期」）。
