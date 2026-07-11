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
//   - Costco聯名卡「精選海外旅遊最高5%」活動中，「精選航空」「精選旅行社」「指定訂房網」
//     「指定免稅店」四組官方逐一列出的完整商家清單，依 v3 規則3「一筆reward一家商店」拆成
//     N 筆（各自 pct=3、cap/validUntil 相同）；「國外實體商店」（最高5%＝原權益1%＋加碼4%，
//     消費地於國外實體商店）為不分國家的海外消費，依上述補充規則以 target="海外" 收錄。
//   - 排除項目（皆為需另外登錄、限量、限時或限新戶的活動，非持卡人常態可得的%回饋，不符合
//     v3「用戶查詢商店/類別即得知%」的資料模型；亦與 SCHEMA 的 tiers/plan 兩種模型皆不吻合）：
//     momo卡「新戶刷卡禮」「店外滿額店內加碼」「momo館內精選品牌加碼」「保費回饋」（保費不是
//     merchant/dining/country/general 任一 targetType）；Costco卡「新戶刷卡禮」「國內樂遊滿額」
//     「高鐵/臺鐵購票回饋」（依卡片子等級世界卡/鈦商卡而異，本檔僅處理單一 fubon-costco 卡，
//     不拆子卡）、「頂級美饌85折／8折」（為商店折扣不是信用卡回饋%，且逐店依卡別而不同）。

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

// 依「、」切分商家清單，括號內的「、」不切
function splitMerchants(str) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(' || ch === '（') depth++;
    if (ch === ')' || ch === '）') depth--;
    if (ch === '、' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
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

  // 精選海外旅遊最高回饋5%：官網逐一列出四組完整商家清單（精選航空/精選旅行社/指定訂房網/指定免稅店），
  // 依 v3 規則「一筆reward一家商店」逐店拆筆；「國外實體商店5%」為不分國家的海外實體消費，
  // 依 SCHEMA 補充規則用 target="海外" 收錄。
  {
    const period = text.match(/精選海外旅遊最高回饋5%\s*活動日期：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    const overseasM = text.match(/國外實體商店\s*(\d+(?:\.\d+)?)%\s*消費地於國外實體商店/);
    const airlinesM = text.match(/精選航空：([^。]+?)(?=精選旅行社)/);
    const agenciesM = text.match(/精選旅行社：([^。]+?)(?=指定訂房網)/);
    const bookingM = text.match(/指定訂房網：([^。]+?)(?=指定免稅店)/);
    const dutyFreeM = text.match(/指定免稅店：([^。]+?)(?=以富邦Costco聯名卡於特約商店分期付款|$)/);
    if (period) {
      const validUntil = isoFrom(period[4], period[5], period[6]);
      const cap = '正附卡合併計算，每月每戶加碼回饋合計上限600元好多金（含原權益1%），需每月至指定管道登錄始生效';
      if (overseasM) {
        rewards.push({
          target: '海外',
          targetType: 'country',
          pct: parseFloat(overseasM[1]),
          cap,
          validUntil,
          note: '精選海外旅遊活動：國外實體商店消費（交易地點非台灣且交易幣別非新臺幣之實體一般消費）；最高回饋率=原權益1%＋加碼4%＝5%，好多金回饋',
        });
      } else {
        console.error('fubon: Costco聯名卡「精選海外旅遊」抓不到「國外實體商店X%」，略過海外筆');
      }
      const groups = [
        { m: airlinesM, note: '精選海外旅遊活動：精選航空公司' },
        { m: agenciesM, note: '精選海外旅遊活動：精選旅行社' },
        { m: bookingM, note: '精選海外旅遊活動：指定訂房平台' },
        { m: dutyFreeM, note: '精選海外旅遊活動：指定免稅店' },
      ];
      let anyGroup = false;
      for (const g of groups) {
        if (!g.m) continue;
        for (const merchant of splitMerchants(g.m[1])) {
          rewards.push({
            target: merchant,
            targetType: 'merchant',
            pct: 3,
            cap,
            validUntil,
            note: `${g.note}；最高回饋率=原權益1%＋加碼2%＝3%，好多金回饋`,
          });
          anyGroup = true;
        }
      }
      if (!anyGroup) console.error('fubon: Costco聯名卡「精選海外旅遊」活動抓不到任何商家清單，跳過此組 reward');
    } else {
      console.error('fubon: Costco聯名卡「精選海外旅遊」活動抓不到活動期間，跳過此組 reward');
    }
  }

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
