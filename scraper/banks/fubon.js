// 台北富邦銀行（fubon）信用卡回饋爬蟲 v3
//
// 收錄卡（data/SCHEMA.md 收錄卡清單，唯一入口 URL）：
//   - momo卡：       https://www.fubon.com/banking/Personal/credit_card/all_card/momo/momo.htm
//   - 富邦Costco聯名卡：https://www.fubon.com/banking/personal/credit_card/all_card/costco/costco.htm
// v2 的「富邦數位生活卡」不在 v3 收錄清單內，移除。
//
// 解析假設：
//   - 兩頁皆為靜態伺服器渲染頁，fetch 拿到的 HTML 已含完整行銷文案，不需要 playwright。
//   - 用「固定短語 + 緊接百分比／日期」的 regex 抓取（比 CSS selector 穩定，這幾頁的活動區塊
//     是行銷團隊手刻的長條 HTML，class 名稱不穩定）。
//   - 只抓兩頁本身內容；頁面連到 Fubon+ App 登錄、活動網頁等外部連結不跟隨（非細則頁/PDF/彈窗）。
//
// v3 與 v2 的關鍵差異：
//   - 不再有 category/plans 巢狀結構，改用扁平 rewards[]，一筆對應一家商店。
//   - 兩張卡皆無「等級」概念（無 tiers），momo卡也無「方案」概念（無 plan）。
//   - momo通路（momo購物網、電視購物、型錄、mo店+、跨境電商）為同一品牌的多種通路，非官方逐一
//     列舉的「N 家不同商店」，故視為一筆 target="momo" 的 merchant reward，而非拆成 5 筆。
//   - 官方不分國家的「海外消費」回饋（SCHEMA 2026-07-11 補充規則）：用 targetType=country、
//     target="海外" 收錄。momo卡「海外消費享1%現金回饋無上限」依此收錄一筆。
//   - 發卡組織資格檢查（SCHEMA 第10點，2026-07-11 檢視）：momo卡回饋不依發卡組織而異
//     （「momo卡 X Mastercard海外消費回饋」為需另行註冊之活動，本就排除）；Costco聯名卡
//     為 Mastercard 單一組織（世界卡/鈦商卡/鈦金卡是卡片等級非發卡組織）——兩卡皆不需
//     發卡組織 tiers。
//   - 排除項目（依 SCHEMA v3 核心原則：限新戶、首刷、需事先登錄、限量名額的活動型回饋一律
//     不收，2026-07-11 使用者拍板）：
//     momo卡「新戶刷卡禮」「店外滿額店內加碼」（需登錄、限量15,000名）「momo館內精選品牌加碼」
//     「保費回饋」（保費非 merchant/dining/country/mobilepay/general 任一 targetType）；
//     Costco卡「精選海外旅遊最高5%」（需每月登錄、每月限5萬名）「新戶刷卡禮」「國內樂遊滿額」
//     （需登錄、限量5,000名）「高鐵/臺鐵購票回饋」（需每月登錄，且依卡等世界卡/鈦商卡而異）、
//     「頂級美饌85折／8折」（為商店折扣不是信用卡回饋%，且逐店依卡等而不同）。
//     保留的 Costco 3%（原權益，免登錄）與 UberEats好市多專區2%（官網注意事項無登錄要求，
//     自動回饋）不受影響。

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/util');

const URLS = {
  momo: 'https://www.fubon.com/banking/Personal/credit_card/all_card/momo/momo.htm',
  costco: 'https://www.fubon.com/banking/personal/credit_card/all_card/costco/costco.htm',
};

function textOf(html) {
  const $ = cheerio.load(html);
  $('script,style').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function isoFrom(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function scrapeMomo() {
  const text = textOf(await fetchHtml(URLS.momo));
  const rewards = [];

  // ．momo通路消費享最高3% mo幣回饋．一般消費享1%現金回饋無上限．海外消費享1%現金回饋無上限
  // 活動期間：2026/4/1~2026/12/31
  const period = text.match(/活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})\s*．momo通路消費享最高(\d+(?:\.\d+)?)%\s*mo幣回饋．一般消費享(\d+(?:\.\d+)?)%現金回饋無上限．海外消費享(\d+(?:\.\d+)?)%現金回饋無上限/);
  if (!period) {
    console.error('fubon: momo卡頁面抓不到回饋摘要句＋活動期間，跳過此卡');
    return null;
  }
  const validUntil = isoFrom(period[4], period[5], period[6]);
  const momoPct = parseFloat(period[7]);
  const generalPct = parseFloat(period[8]);
  const overseasPct = parseFloat(period[9]);

  const cap = text.match(/momo通路消費享最高\d+(?:\.\d+)?%\s*mo幣回饋，係正附卡合併計算，歸戶每期帳單回饋上限([\d,]+)\s*mo幣/);
  rewards.push({
    target: 'momo',
    targetType: 'merchant',
    pct: momoPct,
    cap: cap
      ? `正附卡合併計算，歸戶每期帳單回饋上限${cap[1]} mo幣（mo幣1點=1元）`
      : undefined,
    validUntil,
    note: 'momo通路消費（含momo購物網、電視購物、型錄、mo店+、跨境電商），mo幣回饋',
  });

  rewards.push({
    targetType: 'general',
    pct: generalPct,
    validUntil,
    note: '國內一般消費，現金回饋無上限（不含momo通路、保費、指定網路平台等除外項目，詳官網）',
  });
  // 海外消費（官方不分國家，依 SCHEMA 補充規則用 target="海外" 收錄）
  rewards.push({
    target: '海外',
    targetType: 'country',
    pct: overseasPct,
    validUntil,
    note: '海外一般消費（消費幣別非台幣或消費國別非台灣，不含歐洲經濟區實體商店交易等除外項目），現金回饋無上限',
  });

  if (!rewards.length) {
    console.error('fubon: momo卡頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }

  return { id: 'fubon-momo', name: 'momo卡', url: URLS.momo, rewards };
}

async function scrapeCostco() {
  const text = textOf(await fetchHtml(URLS.costco));
  const rewards = [];

  // Costco消費最高3%無上限 活動期間：即日起~2027/12/31
  const base = text.match(/Costco消費最高(\d+(?:\.\d+)?)%無上限\s*活動期間：即日起~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (base) {
    rewards.push({
      target: '好市多 Costco',
      targetType: 'merchant',
      pct: parseFloat(base[1]),
      validUntil: isoFrom(base[2], base[3], base[4]),
      note: '好多金回饋（1點=1元），無上限',
    });
  } else {
    console.error('fubon: Costco聯名卡抓不到「Costco消費最高X%無上限」基本回饋，略過');
  }

  // UberEats好市多專區消費2%回饋無上限 活動期間：2026/7/1~2026/12/31
  const uberEats = text.match(
    /UberEats好市多專區消費(\d+(?:\.\d+)?)%回饋無上限\s*活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/
  );
  if (uberEats) {
    rewards.push({
      target: 'Uber Eats',
      targetType: 'merchant',
      pct: parseFloat(uberEats[1]),
      validUntil: isoFrom(uberEats[5], uberEats[6], uberEats[7]),
      note: '限UberEats好市多專區消費；好多金回饋＝原權益1%＋加碼1%，無上限',
    });
  } else {
    console.error('fubon: Costco聯名卡抓不到「UberEats好市多專區」活動，略過');
  }

  // 「精選海外旅遊最高5%」（國外實體商店5%＋精選航空/旅行社/訂房網/免稅店各3%）：
  // 官網原文「每月於登錄期間至本行網路銀行/Fubon+或登錄專線…登錄…登錄名額限量，額滿將提前終止
  // 活動」「每月登錄名額共5萬名」——屬「需事先登錄＋限量名額」活動型回饋，依 SCHEMA v3 核心原則
  // 排除新卡/新戶/需登錄活動（2026-07-11 使用者拍板），不收錄。

  if (!rewards.length) {
    console.error('fubon: Costco聯名卡頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }

  return { id: 'fubon-costco', name: '富邦Costco聯名卡', url: URLS.costco, rewards };
}

async function scrape() {
  const results = await Promise.all([scrapeMomo(), scrapeCostco()]);
  const cards = results.filter(Boolean);
  return { id: 'fubon', name: '台北富邦銀行', cards };
}

module.exports = { scrape };
