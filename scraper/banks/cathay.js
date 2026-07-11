// 國泰世華銀行（cathay）信用卡回饋爬蟲 v3
//
// 收錄卡（data/SCHEMA.md 收錄卡清單，唯一入口 URL，2026-07-11 使用者指定）：
//   CUBE信用卡：https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube
//
// 來源端點（皆為 AEM 的 .model.json 結構化內容端點，plain fetch 即可取得，不需要 playwright）：
//   - 入口頁本身的 .model.json（權益分級 Level 1/2/3 百分比）：
//     https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube.model.json
//   - 入口頁的 ctaLink1 直接連到的「權益方案」頁（各方案通路商家完整清單與活動期間），
//     實測入口頁 .model.json 內容樹中即含
//     "ctaLink1":".../cards/cube-list#FPC" 這類連結，屬頁內連出的權益細則頁（可跟一層）：
//     https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube-list.model.json
//
// v3 與 v2 的關鍵差異：
//   - card.tiers = CUBE App「權益分級」Level 1/2/3（用戶達成的條件：核卡即享／自動扣繳或設定
//     電子帳單／財富管理貴賓），對應 SCHEMA 範例「Level也是用戶狀態」。
//   - reward.plan = CUBE App「權益方案」（玩數位/樂饗購/趣旅行/集精選/台塑家/全支付），
//     使用者自選、前端不詢問，同商店多方案命中時逐一列出。
//   - 扁平 rewards[]，一筆一家商店：官方每個方案下依 categoryName 分組列舉的商家，逐一拆成
//     一筆 reward（target=商家名，plan=方案名）。玩數位/樂饗購/趣旅行三方案受權益分級影響，
//     用 pctByTier；集精選/台塑家/全支付不分級，用 pct（flat 2%，來源頁原文「僅適用原一般
//     消費0.3%回饋。2%...」）。
//   - 「國內餐飲」（樂饗購）依聯合信用卡中心MCC code(5811/5812/5814/5462)認定，非官方逐一列舉
//     的商家清單 → 用 targetType=dining（v3 保留的唯一類別），不填 target。
//   - 「指定海外消費」（趣旅行）官方描述為海外實體消費（交易地點非台灣或交易幣別非台幣，
//     不分國家），依 SCHEMA 2026-07-11 補充規則用 targetType=country、target="海外" 收錄，
//     pctByTier 依 Level 分級。
//   - 「全支付國內合作通路」（全支付方案）回饋對象是「全支付」支付工具本身（凡貼TWQR標誌之
//     合作商店皆適用，不綁特定商店），依 SCHEMA 規則7 用 targetType=mobilepay、target="全支付"
//     （canonical 支付名）；同方案的全聯/大全聯兩筆是「用全支付在特定商店消費」→ 維持 merchant。
//   - card.tiers 的 Level 2（CUBE App繳費或自動扣繳）屬「帳單e化／自動扣繳」類條件，依 SCHEMA
//     規則8 標 assumedAchieved: true；Level 3（財富管理貴賓）維持詢問。
//   - 「慶生月」（限壽星生日月）與「童樂匯」（限與未成年子女共同開戶之家長資格）維持 v2 的排除
//     決定：兩者皆非「人人可切換」的方案，屬另一種資格限制，不收錄。
//   - 發卡組織資格檢查（SCHEMA 第10點，2026-07-11 檢視）：CUBE 為單一發卡組織（頁面僅出現
//     VISA），無依發卡組織而異的%——不需發卡組織 tiers。
//   - 排除新卡/新戶/需登錄活動檢查（SCHEMA 第9點，2026-07-11 檢視）：CUBE 權益方案為 App 內
//     隨時切換的常態權益（非活動登錄），現收 rewards 皆無「需事先登錄／限量名額／限新戶」條件。
//   - 全部方案回饋皆以小樹點(信用卡)發放，1點=1元，已在 note 註明。

const cheerio = require('cheerio');
const { UA } = require('../lib/util');

const LEVEL_URL = 'https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube.model.json';
const CHANNEL_URL = 'https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube-list.model.json';
const CARD_URL = 'https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube';

const POINT_NOTE = '小樹點(信用卡)回饋，1點=1元';

const TIERS = [
  { id: 'lv1', name: 'Level 1', condition: '核卡即享' },
  // Level 2 為「帳單e化／自動扣繳」類達成條件，依 SCHEMA 規則8（網站假設用戶每張卡已完成
  // 帳單e化＋自動扣繳）標 assumedAchieved: true，前端自動選定此 tier、不再詢問；
  // Level 3（財富管理貴賓）非此類條件，維持列出供用戶自選（每卡最多一個 assumedAchieved）
  { id: 'lv2', name: 'Level 2', condition: '以CUBE App繳費或申請自動扣繳，次月生效', assumedAchieved: true },
  { id: 'lv3', name: 'Level 3', condition: '財富管理貴賓，次月生效' },
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function htmlToText(html) {
  if (!html) return '';
  return cheerio.load(html).text().replace(/\s+/g, ' ').trim();
}

function isoFrom(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Level 1/2/3 的玩數位/樂饗購/趣旅行/集精選/一般消費 %，依序回傳陣列 [Level1, Level2, Level3]
function parseLevels(fullText) {
  const re = /玩數位([\d.]+)%\s*樂饗購([\d.]+)%\s*趣旅行([\d.]+)%\s*集精選([\d.]+)%\s*一般消費享([\d.]+)%/g;
  const levels = [];
  for (const m of fullText.matchAll(re)) {
    levels.push({
      digital: parseFloat(m[1]),
      dining: parseFloat(m[2]),
      travel: parseFloat(m[3]),
      essential: parseFloat(m[4]),
      general: parseFloat(m[5]),
    });
  }
  return levels;
}

// 收集 model.json 內所有字串節點轉文字後串接，供正則比對用（分級表格文字分散於多個 html 片段）
function collectText(node, out) {
  if (typeof node === 'string') {
    if (node.includes('<') || /[一-鿿]/.test(node)) out.push(htmlToText(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v) => collectText(v, out));
    return;
  }
  if (node && typeof node === 'object') {
    Object.values(node).forEach((v) => collectText(v, out));
  }
}

// 找出 cube-list.model.json 中 cub_main 底下代表各權益方案的節點，用 mainTitle 開頭中文名稱比對
// （而非寫死元件 key），較能抵抗改版時元件 key 變動
function findPlanNodes(channelJson) {
  const items = channelJson[':items']?.root?.[':items']?.responsivegrid?.[':items']?.cub_main?.[':items'] || {};
  const plans = {};
  for (const val of Object.values(items)) {
    const titleNode = val?.experienceFragment?.[':items']?.root?.[':items']?.cub_cubelisttitle_co;
    if (!titleNode) continue;
    const titleText = htmlToText(titleNode.mainTitle);
    const nameMatch = titleText.match(/^([一-鿿]+)/);
    if (!nameMatch) continue;
    plans[nameMatch[1]] = { titleText, titleNode };
  }
  return plans;
}

function parseValidity(titleText) {
  const m = titleText.match(/適用期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return { validFrom: isoFrom(m[1], m[2], m[3]), validUntil: isoFrom(m[4], m[5], m[6]) };
}

// 從單一權益方案節點中，依官方 categoryName（如「國內指定百貨」）取出該分組底下逐一列舉的商家清單
function extractMerchants(titleNode, categoryName) {
  const cats = titleNode[':items'] || {};
  for (const cv of Object.values(cats)) {
    if (cv.categoryName !== categoryName) continue;
    const merchants = [];
    for (const ct of cv.contentTrees || []) {
      const trees = ct.contentTrees;
      if (!trees || typeof trees !== 'object') continue;
      for (const iv of Object.values(trees)) {
        if (!iv || typeof iv !== 'object') continue;
        if (iv.itemType === 'link') continue;
        const txt = (iv.itemText || '').trim();
        if (txt) merchants.push(txt);
      }
    }
    return merchants;
  }
  return null;
}

// 集精選/台塑家/全支付：mainTitle 末尾緊接單一 flat %（不分等級）
function parseFlatPct(titleText) {
  const m = titleText.match(/僅適用原一般消費0\.3%回饋。\s*([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

// 範圍限定詞處理（SCHEMA「範圍限定詞的處理」節，2026-07-11 使用者案例：統一時代台北店
// (不含DREAM PLAZA)）：target 必須是乾淨的單一商店名，「不含X」「限X」「限實體門市」等
// 範圍限定詞移入 note；「A/B」多店合寫拆成多筆。以下對照表為 2026-07-11 對官方頁面原文
// 逐一人工核定；未列入的新原文由 normalizeTarget 的 generic fallback 處理「(不含…)」「(限…)」。
const TARGET_OVERRIDES = {
  '統一時代台北店(不含DREAM PLAZA)': { target: '統一時代百貨台北店', qualifier: '不含DREAM PLAZA' },
  '全聯福利中心 實體門市(不含大全聯)': { target: '全聯福利中心', qualifier: '限實體門市、不含大全聯' },
  'PChome 24h購物(不含儲值及電子票券)': { target: 'PChome 24h購物', qualifier: '不含儲值及電子票券' },
  '小樹購(不含電子票券)': { target: '小樹購', qualifier: '不含電子票券' },
  '車麻吉(不含加油、充電)': { target: '車麻吉', qualifier: '不含加油、充電' },
  'uTagGo(不含月租停車)': { target: 'uTagGo', qualifier: '不含月租停車' },
  'Coupang 酷澎(台灣)': { target: 'Coupang 酷澎', qualifier: '限台灣站' },
  '淘寶/天貓': { split: ['淘寶', '天貓'] },
  'Mitsui Shopping Park LaLaport(南港、台中)': { target: 'Mitsui Shopping Park LaLaport', qualifier: '限南港、台中' },
  'MITSUI OUTLET PARK(林口、台中港、台南)': { target: 'MITSUI OUTLET PARK', qualifier: '限林口、台中港、台南' },
  'Apple錢包指定交通卡 (SUICA 、PASMO、ICOCA)': { target: 'Apple錢包指定交通卡', qualifier: '限SUICA、PASMO、ICOCA' },
  '台灣中油-直營站': { target: '台灣中油', qualifier: '限直營站' },
  '統一速邁樂(限本島)加油站': { target: '統一速邁樂加油站', qualifier: '限本島' },
  '7-ELEVEN (7-11) 實體門市': { target: '7-ELEVEN', qualifier: '限實體門市' },
  '全家便利商店 實體門市': { target: '全家便利商店', qualifier: '限實體門市' },
  '萊爾富實體門市': { target: '萊爾富', qualifier: '限實體門市' },
  '台塑生醫實體門市': { target: '台塑生醫', qualifier: '限實體門市' },
  '長庚生技實體門市': { target: '長庚生技', qualifier: '限實體門市' },
  '台塑蔬菜實體門市': { target: '台塑蔬菜', qualifier: '限實體門市' },
  // 「大阪環球影城(USJ)」的 (USJ) 為別名非範圍限定詞，依 SCHEMA（A(含B)/附屬可保留原文）不列入
};

// 官方原文 → [{ target, qualifier? }, ...]（多店合寫回傳多項）
function normalizeTarget(raw) {
  const o = TARGET_OVERRIDES[raw];
  if (o) {
    if (o.split) return o.split.map((t) => ({ target: t, qualifier: `官方合寫「${raw}」拆列` }));
    return [{ target: o.target, qualifier: o.qualifier }];
  }
  // generic fallback：A(不含B)／A(限B) → target=A（含括號後殘餘字尾）、限定詞進 note
  const m = raw.match(/^(.+?)\s*[（(]((?:不含|限)[^）)]*)[）)]\s*(.*)$/);
  if (m) return [{ target: (m[1] + (m[3] || '')).trim(), qualifier: m[2] }];
  return [{ target: raw }];
}

// 將單一方案節點的各 categoryName 商家清單，逐店拆成 reward 物件推入 out[]
// （v3 schema 的 reward 只定義 validUntil，不含 validFrom，故此處不收 validFrom）
function pushMerchantRewards(out, { titleNode, categories, planName, pctOrByTier, validUntil, noteSuffix }) {
  for (const categoryName of categories) {
    const merchants = extractMerchants(titleNode, categoryName);
    if (!merchants || !merchants.length) continue;
    for (const raw of merchants) {
      for (const { target, qualifier } of normalizeTarget(raw)) {
        const qualNote = qualifier ? `；${qualifier}（官方原文「${raw}」）` : '';
        out.push({
          plan: planName,
          target,
          targetType: 'merchant',
          ...pctOrByTier,
          validUntil,
          note: `${POINT_NOTE}；${planName}方案／${categoryName}（官方逐一列舉，來源：${CHANNEL_URL}）${qualNote}${noteSuffix || ''}`,
        });
      }
    }
  }
}

async function scrape() {
  const cards = [];
  const [levelJson, channelJson] = await Promise.all([fetchJson(LEVEL_URL), fetchJson(CHANNEL_URL)]);

  const levelTextParts = [];
  collectText(levelJson, levelTextParts);
  const levels = parseLevels(levelTextParts.join(' '));
  if (levels.length < 3) {
    console.error('cathay: 權益分級頁抓不到完整3級百分比，CUBE卡跳過');
    return { id: 'cathay', name: '國泰世華銀行', cards: [] };
  }
  const [lv1, lv2, lv3] = levels;
  const planNodes = findPlanNodes(channelJson);
  const rewards = [];

  function byTier(field) {
    return { pctByTier: { lv1: lv1[field], lv2: lv2[field], lv3: lv3[field] } };
  }

  // ---------- 玩數位（Level制）----------
  {
    const node = planNodes['玩數位'];
    const v = node && parseValidity(node.titleText);
    if (v && !Number.isNaN(lv1.digital)) {
      pushMerchantRewards(rewards, {
        titleNode: node.titleNode,
        categories: ['AI工具', '數位/串流平台', '網購平台', '國際電商'],
        planName: '玩數位',
        pctOrByTier: byTier('digital'),
        validUntil: v.validUntil,
        noteSuffix: `；回饋依CUBE App當月權益分級而異：Level1 ${lv1.digital}%／Level2 ${lv2.digital}%／Level3 ${lv3.digital}%`,
      });
    } else {
      console.error('cathay: 玩數位方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 樂饗購（Level制，另含國內餐飲 dining）----------
  {
    const node = planNodes['樂饗購'];
    const v = node && parseValidity(node.titleText);
    if (v && !Number.isNaN(lv1.dining)) {
      pushMerchantRewards(rewards, {
        titleNode: node.titleNode,
        categories: ['國內指定百貨', '國內外送平台', '國內藥妝'],
        planName: '樂饗購',
        pctOrByTier: byTier('dining'),
        validUntil: v.validUntil,
        noteSuffix: `；回饋依CUBE App當月權益分級而異：Level1 ${lv1.dining}%／Level2 ${lv2.dining}%／Level3 ${lv3.dining}%`,
      });
      // 國內餐飲：依聯合信用卡中心MCC code(5811/5812/5814/5462)認定，非封閉商家清單，用 dining targetType
      rewards.push({
        plan: '樂饗購',
        targetType: 'dining',
        ...byTier('dining'),
        validUntil: v.validUntil,
        note: `${POINT_NOTE}；樂饗購方案／國內餐飲(不含餐券)，依聯合信用卡中心MCC code(5811/5812/5814/5462)認定，非限定商店清單；官方另點名「連鎖速食－麥當勞」為例，但不限於此；回饋依CUBE App當月權益分級而異：Level1 ${lv1.dining}%／Level2 ${lv2.dining}%／Level3 ${lv3.dining}%`,
      });
    } else {
      console.error('cathay: 樂饗購方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 趣旅行（Level制）----------
  {
    const node = planNodes['趣旅行'];
    const v = node && parseValidity(node.titleText);
    if (v && !Number.isNaN(lv1.travel)) {
      pushMerchantRewards(rewards, {
        titleNode: node.titleNode,
        categories: ['日本指定遊樂園', '指定國內外交通', '指定航空公司', '指定飯店住宿', '指定旅遊/訂房平台', '指定旅行社'],
        planName: '趣旅行',
        pctOrByTier: byTier('travel'),
        validUntil: v.validUntil,
        noteSuffix: `；回饋依CUBE App當月權益分級而異：Level1 ${lv1.travel}%／Level2 ${lv2.travel}%／Level3 ${lv3.travel}%`,
      });
      // 指定海外消費：官方定義為海外實體消費（交易地點非台灣或交易幣別非台幣，須實體卡過卡或
      // 行動支付面對面交易），不分國家，依 SCHEMA 補充規則用 target="海外" 收錄
      rewards.push({
        plan: '趣旅行',
        target: '海外',
        targetType: 'country',
        ...byTier('travel'),
        validUntil: v.validUntil,
        note: `${POINT_NOTE}；趣旅行方案／指定海外消費：海外實體消費(含國外餐飲、飯店到店付款等；交易地點非台灣或交易幣別非台幣，限實體過卡或Apple/Samsung/Google/Garmin Pay面對面交易，交通卡儲值不列入)；回饋依CUBE App當月權益分級而異：Level1 ${lv1.travel}%／Level2 ${lv2.travel}%／Level3 ${lv3.travel}%`,
      });
    } else {
      console.error('cathay: 趣旅行方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 集精選（不分等級，flat）----------
  {
    const node = planNodes['集精選'];
    const v = node && parseValidity(node.titleText);
    const pct = node && parseFlatPct(node.titleText);
    if (v && pct != null) {
      pushMerchantRewards(rewards, {
        titleNode: node.titleNode,
        categories: ['充電站', '停車費', '量販超市', '指定加油', '指定超商', '生活家居'],
        planName: '集精選',
        pctOrByTier: { pct },
        validUntil: v.validUntil,
        noteSuffix: '；集精選不分CUBE權益分級，統一回饋',
      });
    } else {
      console.error('cathay: 集精選方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 台塑家（不分等級，flat）----------
  {
    const node = planNodes['台塑家'];
    const v = node && parseValidity(node.titleText);
    const pct = node && parseFlatPct(node.titleText);
    if (v && pct != null) {
      pushMerchantRewards(rewards, {
        titleNode: node.titleNode,
        categories: ['加油站', '健康生活', '指定超商'],
        planName: '台塑家',
        pctOrByTier: { pct },
        validUntil: v.validUntil,
        noteSuffix: '；台塑家不分CUBE權益分級，統一回饋',
      });
    } else {
      console.error('cathay: 台塑家方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 全支付（不分等級，flat）----------
  {
    const node = planNodes['全支付'];
    const v = node && parseValidity(node.titleText);
    const pct = node && parseFlatPct(node.titleText);
    if (v && pct != null) {
      pushMerchantRewards(rewards, {
        titleNode: node.titleNode,
        categories: ['量販超市'],
        planName: '全支付',
        pctOrByTier: { pct },
        validUntil: v.validUntil,
        noteSuffix: '；全支付不分CUBE權益分級，統一回饋；須選定「全支付」方案並以全支付綁定CUBE信用卡刷卡消費方可獲回饋',
      });
      // 全支付國內合作通路：回饋對象是「全支付」這個支付工具本身（凡貼TWQR標誌之全支付合作
      // 商店皆適用，不綁特定商店），依 SCHEMA 規則7 用 targetType=mobilepay、target=canonical
      // 支付名「全支付」
      const merchants = extractMerchants(node.titleNode, '全支付國內通路');
      if (merchants && merchants.length) {
        rewards.push({
          plan: '全支付',
          target: '全支付',
          targetType: 'mobilepay',
          pct,
          validUntil: v.validUntil,
          note: `${POINT_NOTE}；全支付方案／全支付國內合作通路：以全支付綁定CUBE信用卡刷卡消費，適用於官方定義之開放式通路（登記於我國境內且以新台幣交易、貼有TWQR標誌等，並得接受全支付支付之通路，來源：${CHANNEL_URL}）；不分CUBE權益分級，統一回饋`,
        });
      }
    } else {
      console.error('cathay: 全支付方案資料不完整，跳過此 plan');
    }
  }

  if (!rewards.length) {
    console.error('cathay: 所有 CUBE 權益方案皆抓取失敗，CUBE卡跳過');
  } else {
    cards.push({
      id: 'cathay-cube',
      name: 'CUBE信用卡',
      url: CARD_URL,
      tiers: TIERS,
      rewards,
    });
  }
  return { id: 'cathay', name: '國泰世華銀行', cards };
}

module.exports = { scrape };
