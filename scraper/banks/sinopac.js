// 永豐銀行 (sinopac) 信用卡回饋爬蟲 v3
//
// 收錄卡（data/SCHEMA.md 收錄卡清單，唯一入口 URL）：
//   DAWHO現金回饋信用卡：
//   https://bank.sinopac.com/sinopacBT/personal/credit-card/introduction/bankcard/DAWHO.html
// v2 的「幣倍卡」「SPORT卡」不在 v3 收錄清單內，移除，不應出現在輸出中。
//
// 解析假設：
//   - 入口頁為伺服器端渲染，plain fetch 即可讀取全文。
//   - 「大戶等級晉升條件」細節（tiers 的 condition 說明文字）取自入口頁內連出的 FAQ 頁
//     （屬頁內連出的細則頁，可跟一層）：https://dawho.tw/faq/memberloyalty/
//     入口頁 <a> 文字「分級制度」/「_FAQ_」皆連到此頁，內容說明大大／大戶／大戶Plus三個
//     等級的晉升條件（如平均財富達新臺幣30萬/100萬元、單筆換匯、證券交易等）。
//
// v3 與 v2 的關鍵差異：
//   - DAWHO 為 SCHEMA 範例明訂的「等級型」卡：tiers=存款等級（大大／大戶／大戶Plus，用戶達成
//     的條件），對應官網「高額現金回饋 大好刷」活動中依等級而異的%數。無「方案」概念（無 plan）。
//   - 扁平 rewards[]：
//     1) targetType=general：官網基礎回饋「一般消費國內1%」+ 依等級而異的「指定任務加碼」
//        （大戶Plus+4%／大戶+2.5%／大大+0%），以 pctByTier 呈現加總後的實際% Domestic
//        （5% / 3.5% / 1%，其中5%、3.5%由程式加總基礎值+任務加碼算出，1%即基礎值本身）。
//     2) targetType=merchant, target="悠遊卡自動加值"：另一個依等級而異的獨立加碼項目
//        （大戶Plus 5%／大戶 3%），大大等級無此權益，pctByTier 省略 none 鍵。
//        悠遊卡自動加值屬「服務型」對象而非行動支付工具（canonical 支付清單中的是「悠遊付」，
//        與悠遊卡自動加值不同物），依 2026-07-11 使用者裁定維持 merchant、不改 mobilepay。
//     3) targetType=country, target="海外"：官方不分國家的「國外消費」回饋（SCHEMA 2026-07-11
//        補充規則：官方只寫國外/海外消費不分國家時，用 target="海外" 收錄）。基礎國外2%＋指定
//        任務加碼（大戶Plus+4%／大戶+2.5%）＝6%／4.5%／2%；6%為官網「國外消費最高6%」逐字加總
//        句，4.5%為程式加總（基礎2%+任務2.5%）非官網逐字，已於 note 註明。
//   - 排除「新戶限定指定行動支付最高20%刷卡金」（限新戶＋限量10,000戶）「首登APP禮」（需登錄＋
//     限量4,000名）「MAMA AWARDS抽獎」（需登錄之抽獎）等：皆為限新戶、限量、需登錄的活動型
//     回饋，依 SCHEMA v3 核心原則第9點（2026-07-11 使用者拍板）一律不收。保留的基礎回饋＋
//     指定任務加碼＋悠遊卡自動加值皆免活動登錄（指定任務＝自動扣繳＋電子帳單，屬 SCHEMA
//     規則8 假設已完成的條件，非活動登錄）。
//   - 發卡組織資格檢查（SCHEMA 第10點，2026-07-11 檢視）：DAWHO 為 Visa 單一組織（頁內
//     Mastercard/JCB 僅出現於通用「國際組織優惠」導覽區塊，非本卡回饋差異）——不需發卡組織 tiers。

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/util');

const CARD_URL = 'https://bank.sinopac.com/sinopacBT/personal/credit-card/introduction/bankcard/DAWHO.html';

const TIERS = [
  {
    id: 'plus',
    name: '大戶Plus',
    condition: '當月平均財富達新臺幣100萬元(含)以上，並同時完成「單筆換匯滿5,000元」或「證券台股現貨交易」任一任務，次月生效',
  },
  {
    id: 'standard',
    name: '大戶',
    condition: '當月平均財富達新臺幣30萬元(含)以上，或符合新戶禮/信貸自動扣繳帳戶/證券台股現貨交易/單筆換匯滿5,000元任一條件，次月生效',
  },
  { id: 'none', name: '大大', condition: '未達成大戶／大戶Plus資格之基礎等級' },
];

function textOf(html) {
  const $ = cheerio.load(html);
  $('script,style,nav,header,footer').remove();
  return $('body').text().replace(/[\t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

async function fetchText(url) {
  const html = await fetchHtml(url);
  return textOf(html);
}

function isoFrom(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function scrapeDawho() {
  const text = await fetchText(CARD_URL);
  const rewards = [];

  // 活動期間：2026/7/1-2026/12/31（高額現金回饋 大好刷）
  const periodM = text.match(/活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{4})\/(\d{1,2})\/(\d{1,2})\n活動內容：國內消費最高\d/);
  const validUntil = periodM ? isoFrom(periodM[4], periodM[5], periodM[6]) : null;
  if (!validUntil) console.error('sinopac/DAWHO: 找不到「高額現金回饋 大好刷」活動期間，validUntil 將缺漏');

  // 【一般消費】國內1%、國外2% 現金回饋無上限！
  const baseM = text.match(/【一般消費】國內(\d+(?:\.\d+)?)%、國外(\d+(?:\.\d+)?)%\s*現金回饋無上限/);
  // 【完成指定任務】大戶Plus等級加碼4%，回饋上限NT$1,000/月帳單週期、大戶等級加碼2.5%，回饋上限NT$400/月帳單週期、大大等級無加碼優惠
  const taskM = text.match(
    /大戶Plus等級加碼(\d+(?:\.\d+)?)%，回饋上限NT\$([\d,]+)\/月帳單週期、大戶等級加碼(\d+(?:\.\d+)?)%，回饋上限NT\$([\d,]+)\/月帳單週期/
  );
  // 【悠遊卡自動加值】大戶Plus等級回饋5%，回饋上限NT$500/月帳單週期、大戶等級回饋3%，回饋上限NT$100/月帳單週期
  const easycardM = text.match(
    /【悠遊卡自動加值】大戶Plus等級回饋(\d+(?:\.\d+)?)%，回饋上限NT\$([\d,]+)\/月帳單週期、大戶等級回饋(\d+(?:\.\d+)?)%，回饋上限NT\$([\d,]+)\/月帳單週期/
  );

  if (baseM && taskM) {
    const baseDomestic = parseFloat(baseM[1]);
    const baseOverseas = parseFloat(baseM[2]);
    const plusTaskPct = parseFloat(taskM[1]);
    const plusTaskCap = taskM[2];
    const stdTaskPct = parseFloat(taskM[3]);
    const stdTaskCap = taskM[4];
    const taskNote = `指定任務加碼（大戶Plus ${plusTaskPct}%／大戶 ${stdTaskPct}%），任務為①DAWHO數位存款帳戶自動扣繳信用卡費＋②設定電子/行動帳單（需同時達成）`;
    const taskCap = `指定任務加碼部分月帳單上限：大戶Plus NT$${plusTaskCap}／大戶 NT$${stdTaskCap}；大大無加碼（基礎回饋無上限）`;
    rewards.push({
      targetType: 'general',
      pctByTier: {
        plus: parseFloat((baseDomestic + plusTaskPct).toFixed(2)),
        standard: parseFloat((baseDomestic + stdTaskPct).toFixed(2)),
        none: baseDomestic,
      },
      cap: taskCap,
      validUntil,
      note: `國內一般消費現金回饋；基礎${baseDomestic}%（大大即此值）＋${taskNote}`,
    });
    // 海外消費（官方不分國家，依 SCHEMA 補充規則用 target="海外" 收錄）
    rewards.push({
      target: '海外',
      targetType: 'country',
      pctByTier: {
        plus: parseFloat((baseOverseas + plusTaskPct).toFixed(2)),
        standard: parseFloat((baseOverseas + stdTaskPct).toFixed(2)),
        none: baseOverseas,
      },
      cap: taskCap,
      validUntil,
      note: `國外一般消費（限外幣：交易國別非台灣且交易幣別非新臺幣）現金回饋；基礎${baseOverseas}%（大大即此值）＋${taskNote}；大戶Plus ${parseFloat((baseOverseas + plusTaskPct).toFixed(2))}%即官網「國外消費最高6%」，大戶${parseFloat((baseOverseas + stdTaskPct).toFixed(2))}%為基礎+任務加碼程式加總，非官網逐字引用`,
    });
  } else {
    console.error('sinopac/DAWHO: 找不到一般消費基礎回饋或指定任務加碼文字，略過 general/海外 reward');
  }

  if (easycardM) {
    rewards.push({
      target: '悠遊卡自動加值',
      targetType: 'merchant',
      pctByTier: { plus: parseFloat(easycardM[1]), standard: parseFloat(easycardM[3]) },
      cap: `每月帳單上限：大戶Plus NT$${easycardM[2]}／大戶 NT$${easycardM[4]}`,
      validUntil,
      note: '悠遊卡自動加值加碼；限完成指定任務（DAWHO帳戶自動扣繳信用卡費＋電子/行動帳單）之大戶／大戶Plus等級適用，大大等級無此權益（不含基本消費回饋及指定任務加碼回饋）',
    });
  } else {
    console.error('sinopac/DAWHO: 找不到悠遊卡自動加值回饋文字，略過此筆 reward');
  }

  if (!rewards.length) {
    console.error('sinopac/DAWHO: 所有 reward 解析失敗，DAWHO卡跳過');
    return null;
  }

  return { id: 'sinopac-dawho', name: 'DAWHO現金回饋信用卡', url: CARD_URL, tiers: TIERS, rewards };
}

async function scrape() {
  const card = await scrapeDawho();
  return { id: 'sinopac', name: '永豐銀行', cards: card ? [card] : [] };
}

module.exports = { scrape };
