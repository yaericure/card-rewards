// 台北富邦銀行（fubon）信用卡回饋爬蟲
//
// 來源 URL（2026-07-10 人工核對過結構，之後若改版需重新核對）：
//   - momo卡：        https://www.fubon.com/banking/personal/credit_card/all_card/momo/momo.htm
//   - 富邦數位生活卡： https://www.fubon.com/banking/personal/credit_card/all_card/digitallife/digitallife.htm
//   - 富邦Costco聯名卡：https://www.fubon.com/banking/personal/credit_card/all_card/costco/costco.htm
//
// 解析假設：
//   - 三頁皆為靜態伺服器渲染頁（fetch 拿到的 HTML 已含完整行銷文案），不需要 playwright。
//   - 富邦官網把回饋率寫在固定格式的中文句子裡（例：「momo通路消費享最高3% mo幣回饋」、
//     「Costco消費最高3%無上限 活動期間：即日起~2027/12/31」），用「固定短語 + 緊接百分比／日期」
//     的 regex 抓，比 CSS selector 穩定（這幾頁的活動區塊是行銷團隊手刻的長條 HTML，class 名稱不穩定）。
//   - momo卡／Costco卡屬「現金回饋 mo幣／好多金」，1點=1元，官網已直接講清楚等值百分比，不需換算。
//   - Costco聯名卡頁面內容極長（一整頁塞了十幾個活動），只抓「Costco消費」與「UberEats好市多專區」
//     兩個有明確活動期間與百分比的常態性優惠，其餘限時/需登錄的加碼活動不逐一收錄（避免抓錯或抓到
//     已過期活動），未來如需擴充可比照本檔案的 regex 寫法新增。
//   - 三張卡在既有版面上都只有單一方案（無「一般卡 vs 數位帳戶」等分級差異），故 plans 僅一筆
//     （id: "default"）；銀行等級差異的範例已由 esun/taishin/chb 模組涵蓋。

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/util');

const URLS = {
  momo: 'https://www.fubon.com/banking/personal/credit_card/all_card/momo/momo.htm',
  digitallife: 'https://www.fubon.com/banking/personal/credit_card/all_card/digitallife/digitallife.htm',
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
  const summary = text.match(
    /momo通路消費享最高(\d+(?:\.\d+)?)%\s*mo幣回饋．一般消費享(\d+(?:\.\d+)?)%現金回饋無上限．海外消費享(\d+(?:\.\d+)?)%現金回饋無上限/
  );
  if (!summary) {
    console.error('fubon: momo卡頁面抓不到回饋摘要句，跳過此卡');
    return null;
  }
  const cap = text.match(/momo通路消費享最高\d+(?:\.\d+)?%\s*mo幣回饋，係正附卡合併計算，歸戶每期帳單回饋上限([\d,]+)\s*mo幣/);
  const momoReward = {
    category: 'online',
    pct: parseFloat(summary[1]),
    merchants: ['momo購物網'],
    note: 'mo幣回饋（1點=1元）',
  };
  if (cap) momoReward.cap = `正附卡合併計算，歸戶每期帳單回饋上限${cap[1]} mo幣`;
  return {
    id: 'fubon-momo',
    name: 'momo卡',
    url: URLS.momo,
    plans: [
      {
        id: 'default',
        name: '一般',
        condition: '無條件',
        rewards: [
          momoReward,
          { category: 'general', pct: parseFloat(summary[2]), note: '現金回饋，無上限' },
          { category: 'overseas', pct: parseFloat(summary[3]), note: '現金回饋，無上限' },
        ],
      },
    ],
  };
}

async function scrapeDigitalLife() {
  const text = textOf(await fetchHtml(URLS.digitallife));
  const digital = text.match(
    /數位通路、海外\s*最高(\d+(?:\.\d+)?)%\s*\(([\d.]+)%回饋無上限\+\s*([\d.]+)%加碼回饋\)/
  );
  const general = text.match(/一般消費刷數位生活卡(?:\(含LINE FRIENDS卡\))?享(\d+(?:\.\d+)?)％現金回饋，回饋無上限/);
  const insurance = text.match(/保費交易刷數位生活卡(?:\(含LINE FRIENDS卡\))?享(\d+(?:\.\d+)?)％現金回饋，回饋無上限/);
  const cap = text.match(/每期帳單加碼回饋上限(\d+)元/);
  const period = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{4})\/(\d{1,2})\/(\d{1,2})結帳之信用卡帳單適用/);
  const validUntil = period ? isoFrom(period[4], period[5], period[6]) : undefined;

  const rewards = [];
  if (digital) {
    const note = `已含基本回饋${digital[2]}%＋加碼回饋${digital[3]}%（當期帳單新增消費滿NT$5,000才有加碼，否則以${digital[2]}%計算）` + (cap ? `；加碼部分每期帳單上限NT$${cap[1]}` : '');
    const rewardOnline = { category: 'online', pct: parseFloat(digital[1]), note };
    const rewardOverseas = { category: 'overseas', pct: parseFloat(digital[1]), note };
    if (validUntil) {
      rewardOnline.validUntil = validUntil;
      rewardOverseas.validUntil = validUntil;
    }
    rewards.push(rewardOnline, rewardOverseas);
  }
  if (general) rewards.push({ category: 'general', pct: parseFloat(general[1]), note: '現金回饋，回饋無上限' });
  if (insurance) rewards.push({ category: 'insurance', pct: parseFloat(insurance[1]), note: '現金回饋，回饋無上限' });

  if (!rewards.length) {
    console.error('fubon: 數位生活卡頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }

  return {
    id: 'fubon-digitallife',
    name: '富邦數位生活卡',
    url: URLS.digitallife,
    plans: [{ id: 'default', name: '一般', condition: '無條件', rewards }],
  };
}

async function scrapeCostco() {
  const text = textOf(await fetchHtml(URLS.costco));
  const rewards = [];

  const base = text.match(/Costco消費最高(\d+(?:\.\d+)?)%無上限\s*活動期間：即日起~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (base) {
    rewards.push({
      category: 'supermarket',
      pct: parseFloat(base[1]),
      merchants: ['好市多 Costco'],
      note: '好多金回饋（1點=1元），回饋無上限',
      validUntil: isoFrom(base[2], base[3], base[4]),
    });
  }

  const uberEats = text.match(
    /UberEats好市多專區消費(\d+(?:\.\d+)?)%回饋無上限\s*活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/
  );
  if (uberEats) {
    rewards.push({
      category: 'delivery',
      pct: parseFloat(uberEats[1]),
      merchants: ['Uber Eats'],
      note: '限UberEats好市多專區；好多金回饋，無上限',
      validUntil: isoFrom(uberEats[5], uberEats[6], uberEats[7]),
    });
  }

  if (!rewards.length) {
    console.error('fubon: Costco聯名卡頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }

  return {
    id: 'fubon-costco',
    name: '富邦Costco聯名卡',
    url: URLS.costco,
    plans: [{ id: 'default', name: '一般', condition: '無條件', rewards }],
  };
}

async function scrape() {
  const results = await Promise.all([scrapeMomo(), scrapeDigitalLife(), scrapeCostco()]);
  const cards = results.filter(Boolean);
  return { id: 'fubon', name: '台北富邦銀行', cards };
}

module.exports = { scrape };
