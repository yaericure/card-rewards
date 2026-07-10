// 台北富邦銀行（fubon）信用卡回饋爬蟲 v2
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
//   - Costco聯名卡頁面內容極長（一整頁塞了十幾個活動），只抓「Costco消費」「UberEats好市多專區」
//     「精選海外旅遊」三個有明確活動期間、百分比、且（精選海外旅遊）附完整指定通路清單的常態性優惠，
//     其餘限時/需登錄且無固定通路清單的加碼活動（日本千家商店、韓國當地商店等）不逐一收錄
//     （避免抓錯或抓到已過期活動），未來如需擴充可比照本檔案的 regex 寫法新增。
//   - 三張卡在既有版面上都只有單一方案（無「一般卡 vs 數位帳戶」等分級差異），故 plans 僅一筆
//     （id: "default"）；銀行等級差異的範例已由 esun/taishin/chb 模組涵蓋。
//
// v2 通路清單重點：
//   - momo卡的「momo通路」官網原文明確定義為「包含momo購物網、電視購物、型錄、mo店+、跨境電商」
//     （無「等」字結尾，屬封閉定義），v2 收錄此 5 項為 merchants，merchantsComplete:true。
//   - 富邦數位生活卡的「數位通路消費」官網原文以「如：Yahoo奇摩購物中心/...等」列舉，屬示例性質
//     （非封閉清單，官方明確用「如...等」），依 SCHEMA 規則 2 標 merchantsComplete:false 並在 note
//     說明來源與缺漏原因；但「四大電視/網路/型錄購物 (momo、東森、森森、Viva)」「電信手機資費自動
//     扣繳(台灣大哥大、中華電信、遠傳)」兩段官網原文為封閉清單（無「等」字），標 true。
//   - Costco聯名卡新增「精選海外旅遊最高回饋5%」活動，官網以表格＋條列逐一列出「精選航空」
//     「精選旅行社」「指定訂房網」「指定免稅店」四組完整商家清單，v2 收錄並標 true；「國外實體商店」
//     為概括式描述非商家清單，依 SCHEMA 規則 3(a) 不填 merchants。

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
  // 官網原文：「momo通路定義：包含momo購物網、電視購物、型錄、mo店+、跨境電商」，無「等」字結尾，
  // 屬封閉定義
  const channelDef = text.match(/momo通路定義：包含([^。]+)/);
  const momoChannels = channelDef ? channelDef[1].split('、').map((s) => s.trim()) : ['momo購物網'];
  const momoReward = {
    category: 'online',
    pct: parseFloat(summary[1]),
    merchants: momoChannels,
    merchantsComplete: !!channelDef,
    note: 'mo幣回饋（1點=1元）；momo通路官方定義之完整通路清單',
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
    const baseNote =
      `已含基本回饋${digital[2]}%＋加碼回饋${digital[3]}%（當期帳單新增消費滿NT$5,000才有加碼，否則以${digital[2]}%計算）` +
      (cap ? `；加碼部分每期帳單上限NT$${cap[1]}` : '');
    const pct = parseFloat(digital[1]);

    // 「網路購物(如Yahoo奇摩購物中心/超級商城/拍賣、PChome線上購物、...等)」：官方用「如...等」，
    // 屬示例性質非封閉清單
    const onlineShoppingM = text.match(/網路購物\(如([^)]+)\)/);
    if (onlineShoppingM) {
      const merchants = onlineShoppingM[1]
        .replace(/等$/, '')
        .split(/[、/]/)
        .map((s) => s.trim())
        .filter(Boolean);
      rewards.push({
        category: 'online',
        pct,
        merchants,
        merchantsComplete: false,
        validUntil,
        note: `${baseNote}；網路購物（官網原文用「如...等」列舉範例，非封閉清單，來源：${URLS.digitallife}，已收錄官網列出的所有範例商店）`,
      });
    }

    // 「四大電視/網路/型錄購物 (momo、東森、森森、Viva)」：無「等」字，封閉清單
    const tvShoppingM = text.match(/四大電視\/網路\/型錄購物\s*\(([^)]+)\)/);
    if (tvShoppingM) {
      rewards.push({
        category: 'online',
        pct,
        merchants: tvShoppingM[1].split('、').map((s) => s.trim()),
        merchantsComplete: true,
        validUntil,
        note: `${baseNote}；四大電視/網路/型錄購物`,
      });
    }

    // 「電信手機資費自動扣繳(台灣大哥大、中華電信、遠傳)」：無「等」字，封閉清單
    const telecomM = text.match(/電信手機資費自動扣繳\(([^)]+)\)/);
    if (telecomM) {
      rewards.push({
        category: 'telecom',
        pct,
        merchants: telecomM[1].split('、').map((s) => s.trim()),
        merchantsComplete: true,
        validUntil,
        note: `${baseNote}；電信手機資費自動扣繳`,
      });
    }

    // 「手機APP綁定支付( LINE PAY、街口、GOMAJI Pay、歐付寶行動支付、Pi錢包、friDay錢包...等)」：
    // 有「等」字，屬示例性質非封閉清單
    const mobilePayM = text.match(/手機APP綁定支付\(\s*([^)]+)\)/);
    if (mobilePayM) {
      const merchants = mobilePayM[1]
        .replace(/\.\.\.等$/, '')
        .split('、')
        .map((s) => s.trim())
        .filter(Boolean);
      rewards.push({
        category: 'mobilepay',
        pct,
        merchants,
        merchantsComplete: false,
        validUntil,
        note: `${baseNote}；手機APP綁定支付（官網原文用「...等」列舉範例，非封閉清單，來源：${URLS.digitallife}，已收錄官網列出的所有範例支付工具）`,
      });
    }

    // 海外一般消費：官網僅描述「消費國別非台灣或消費幣別非台幣」，非商家清單
    rewards.push({ category: 'overseas', pct, validUntil, note: `${baseNote}；海外一般消費，屬概括式描述非限定商店清單` });
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
      merchantsComplete: true,
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
      merchantsComplete: true,
      note: '限UberEats好市多專區；好多金回饋，無上限',
      validUntil: isoFrom(uberEats[5], uberEats[6], uberEats[7]),
    });
  }

  // 精選海外旅遊最高回饋5%：官網以表格列出「精選旅遊通路」與各自最高回饋率，並在注意事項段落
  // 用「精選航空：...」「精選旅行社：...」「指定訂房網：...」「指定免稅店：...」逐一列出完整商家清單
  {
    const period = text.match(/精選海外旅遊最高回饋5%\s*活動日期：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    const airlinesM = text.match(/精選航空：([^。]+?)(?=精選旅行社)/);
    const agenciesM = text.match(/精選旅行社：([^。]+?)(?=指定訂房網)/);
    const bookingM = text.match(/指定訂房網：([^。]+?)(?=指定免稅店)/);
    const dutyFreeM = text.match(/指定免稅店：([^。]+?)(?=以富邦Costco聯名卡於特約商店分期付款|$)/);
    if (period) {
      const validFrom = isoFrom(period[1], period[2], period[3]);
      const validUntil = isoFrom(period[4], period[5], period[6]);
      const cap = '正附卡合併計算，每月每戶加碼回饋合計上限600元好多金（含原權益1%），需每月至指定管道登錄始生效';
      const baseNote = '好多金回饋（1點=1元）；原權益1%回饋無上限＋精選海外旅遊加碼';
      // 國外實體商店：官網僅描述「消費地於國外實體商店」，非商家清單
      rewards.push({
        category: 'overseas',
        pct: 5,
        cap,
        validFrom,
        validUntil,
        note: `${baseNote}最高4%＝5%；國外實體商店消費，屬概括式描述非限定商店清單`,
      });
      if (airlinesM) {
        rewards.push({
          category: 'travel',
          pct: 3,
          merchants: airlinesM[1].split('、').map((s) => s.trim()),
          merchantsComplete: true,
          cap,
          validFrom,
          validUntil,
          note: `${baseNote}最高2%＝3%；精選航空公司`,
        });
      }
      if (agenciesM) {
        rewards.push({
          category: 'travel',
          pct: 3,
          merchants: agenciesM[1].split('、').map((s) => s.trim()),
          merchantsComplete: true,
          cap,
          validFrom,
          validUntil,
          note: `${baseNote}最高2%＝3%；精選旅行社`,
        });
      }
      if (bookingM) {
        rewards.push({
          category: 'travel',
          pct: 3,
          merchants: bookingM[1].split('、').map((s) => s.trim()),
          merchantsComplete: true,
          cap,
          validFrom,
          validUntil,
          note: `${baseNote}最高2%＝3%；指定訂房平台`,
        });
      }
      if (dutyFreeM) {
        rewards.push({
          category: 'overseas',
          pct: 3,
          merchants: dutyFreeM[1].split('、').map((s) => s.trim()),
          merchantsComplete: true,
          cap,
          validFrom,
          validUntil,
          note: `${baseNote}最高2%＝3%；指定免稅店`,
        });
      }
    } else {
      console.error('fubon: Costco聯名卡「精選海外旅遊」活動抓不到活動期間，跳過此組 reward');
    }
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
