// 華南銀行 (hncb) 信用卡回饋爬蟲
//
// 來源 URL（2026-07-10 人工驗證可 fetch，200 OK，伺服器端渲染，無需 JS 引擎）：
//   熊Q卡（VISA御璽/MasterCard鈦金/JCB晶緻） https://www.hncb.com.tw/wps/portal/HNCB/card/introduce/cash_feedback_card/BearQcard2026
//   超鑽現金回饋卡（無限/御璽/晶緻）         https://www.hncb.com.tw/wps/portal/HNCB/card/introduce/cash_feedback_card/card_diamond_cash_back
//   I網購生活卡                              https://www.hncb.com.tw/wps/portal/HNCB/card/introduce/cash_feedback_card/card_i_shopping
// （原 card.hncb.com.tw 網域會 302 導向 www.hncb.com.tw，故直接使用導向後網址。）
//
// 解析假設：
//   - 文字用 cheerio 取出 body 純文字後，以「穩定中文片語」regex 定位 %／上限／活動期間。
//   - 華南官網活動期間一律用民國年「115年X月X日至/~115年X月X日」，用 rocDateStr() 轉西元
//     （115 + 1911 = 2026；今日對照 2026-07-10 已驗證換算正確）。
//   - 熊Q卡回饋分三層：基礎回饋(A)＋加碼回饋(B，需1項資格條件)＋指定通路加碼回饋(C，需2項以上資格條件)，
//     官網有「合計最高回饋(A+B+C)」列出加總值，直接採用該加總值並在 note 附上分解。

const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 CardRewardsBot/1.0';

const URLS = {
  bearq: 'https://www.hncb.com.tw/wps/portal/HNCB/card/introduce/cash_feedback_card/BearQcard2026',
  diamond: 'https://www.hncb.com.tw/wps/portal/HNCB/card/introduce/cash_feedback_card/card_diamond_cash_back',
  ishopping: 'https://www.hncb.com.tw/wps/portal/HNCB/card/introduce/cash_feedback_card/card_i_shopping',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' } });
  if (!res.ok) throw new Error(`fetch ${url} 失敗：HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script,style,nav,header,footer').remove();
  const text = $('body')
    .text()
    .replace(/[\t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text;
}

// "115年7月27日" → "2026-07-27"（民國年 + 1911）
function rocToIso(rocYear, month, day) {
  const year = parseInt(rocYear, 10) + 1911;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 找離 nearIndex「絕對距離最近」的「115年X月X日至/~115年X月X日」區間，回傳結束日 ISO。
// 用絕對距離而非固定視窗內第一個 match，避免抓到頁面中鄰近但不相關段落（例如另一個活動或
// 另一個卡別等級）的日期。
const ROC_DATE_RANGE_RE = /(\d{2,3})年(\d{1,2})月(\d{1,2})日\s*[至~]\s*(\d{2,3})年(\d{1,2})月(\d{1,2})日/g;

// 這幾個 hncb 頁面常把同一句回饋文案重複出現在頁面多處（例如首頁摘要 teaser + 實際 accordion
// modal 內文），但只有 modal 內文旁邊才緊跟著正確的「活動期間」。若直接用 text.match() 只拿到
// 第一個出現位置，可能誤配到頁面上「距離較近但不相關」的另一個活動日期（例如稅費減免活動）。
// 因此改用 matchAll 找出全部出現位置，each 位置各自找最近日期，取「與日期距離最小」的那一組，
// 藉此逼近「這個出現位置就在 modal 內、旁邊那個日期才是它的」的真相。
function findOccurrenceNearestDate(text, regex) {
  const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let best = null;
  for (const m of text.matchAll(g)) {
    let bestDist = Infinity;
    let bestDate = null;
    for (const dm of text.matchAll(ROC_DATE_RANGE_RE)) {
      const dist = Math.abs(dm.index - m.index);
      if (dist < bestDist) {
        bestDist = dist;
        bestDate = rocToIso(dm[4], dm[5], dm[6]);
      }
    }
    if (!best || (bestDate != null && bestDist < best.dist)) {
      best = { match: m, validUntil: bestDate, dist: bestDist };
    }
  }
  return best;
}

function warn(cardName, msg) {
  console.error(`  [hncb/${cardName}] 警告：${msg}`);
}

function scrapeBearQ(text) {
  const plans = [];

  // 活動期間：「115年7月27日至115年12月31日」
  const periodM = text.match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日至(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  const validUntil = periodM ? rocToIso(periodM[4], periodM[5], periodM[6]) : null;

  // 分級表：基礎回饋(A) 0.8% / 1.6% / 2% ；加碼回饋(B) 0.2% / 0.4% / 0.4%；指定通路加碼回饋(C) 1% / 1% / 1%；
  // 合計最高回饋(A+B+C) 2% / 3% / 3.4%
  const tableM = text.match(
    /基礎回饋\(A\)\n(\d+(?:\.\d+)?)%\n(\d+(?:\.\d+)?)%\n(\d+(?:\.\d+)?)%\n無上限\n加碼回饋\(B\)\n(\d+(?:\.\d+)?)%\n(\d+(?:\.\d+)?)%\n(\d+(?:\.\d+)?)%\n(\d+)點\n指定通路加碼回饋\(C\)\n(\d+(?:\.\d+)?)%\n(\d+(?:\.\d+)?)%\n(\d+(?:\.\d+)?)%\n(\d+)點\n合計最高回饋\(A\+B\+C\)\n(\d+(?:\.\d+)?)%\n(\d+(?:\.\d+)?)%\n(\d+(?:\.\d+)?)%/
  );

  if (tableM) {
    // 表格欄位順序為：VISA御璽/MasterCard鈦金(國內、國外) | JCB晶緻卡(國內、國外、日韓)，
    // 但基礎/加碼/通路加碼三層各自的「卡別對應欄位」在文字流中會交錯，無法穩定逐格對應；
    // 此處採「保守只用官網已給的合計欄(A+B+C)」策略，避免誤配對個別分層數字到錯的卡別。
    const capB = tableM[7];
    const capC = tableM[11];
    const domesticTotal = parseFloat(tableM[12]);
    const overseasTotal = parseFloat(tableM[13]);
    const jpKrTotal = parseFloat(tableM[14]);
    plans.push({
      id: 'default',
      name: '一般消費現金點數回饋（VISA御璽卡/MasterCard鈦金卡/JCB晶緻卡通用）',
      condition: '基礎回饋無條件；加碼回饋需符合1項熊Q資格條件；指定通路加碼回饋需符合2項以上資格條件（依通路排序，未設定採預設排序：百貨→餐飲→旅遊交通→網購量販→台灣Pay）',
      validFrom: undefined,
      validUntil,
      rewards: [
        {
          category: 'general',
          pct: domesticTotal,
          cap: `加碼回饋+指定通路加碼回饋合計每期帳單上限${capB}點+${capC}點`,
          validUntil,
          note: `合計最高回饋(A+B+C)國內消費${domesticTotal}%；需集滿全部資格條件才達最高值，基礎回饋本身無上限`,
        },
        {
          category: 'overseas',
          pct: overseasTotal,
          cap: `加碼回饋+指定通路加碼回饋合計每期帳單上限${capB}點+${capC}點`,
          validUntil,
          note: `合計最高回饋(A+B+C)國外消費${overseasTotal}%；需集滿全部資格條件才達最高值`,
        },
        {
          category: 'overseas',
          pct: jpKrTotal,
          merchants: ['日本', '韓國'],
          cap: `加碼回饋+指定通路加碼回饋合計每期帳單上限${capB}點+${capC}點`,
          validUntil,
          note: `JCB晶緻卡日韓地區消費合計最高回饋${jpKrTotal}%；需集滿全部資格條件才達最高值`,
        },
        {
          category: 'department',
          pct: parseFloat(tableM[8]),
          merchants: ['新光三越', '遠東百貨', '遠東SOGO', 'Big City遠東巨城購物中心', '誠品生活', '台北101', '漢神百貨', '夢時代購物中心'],
          note: '指定通路加碼回饋（百貨通路，預設排序第1），需符合2項以上資格條件；限實體卡（含Apple Pay/Google Pay）',
          validUntil,
        },
        {
          category: 'dining',
          pct: parseFloat(tableM[8]),
          note: '指定通路加碼回饋（餐飲通路，MCC 5811/5812/5814/5462），需符合2項以上資格條件',
          validUntil,
        },
        {
          category: 'transport',
          pct: parseFloat(tableM[8]),
          merchants: ['國內旅行社', '訂房網', '航空公司', '高鐵', '臺鐵'],
          note: '指定通路加碼回饋（旅遊交通通路），需符合2項以上資格條件',
          validUntil,
        },
        {
          category: 'gas',
          pct: parseFloat(tableM[8]),
          note: '指定通路加碼回饋（旅遊交通通路內含加油站，MCC 5541/5542），需符合2項以上資格條件；與旅遊交通共用同一通路名額',
          validUntil,
        },
        {
          category: 'online',
          pct: parseFloat(tableM[8]),
          merchants: ['蝦皮購物', 'MOMO購物', 'PChome 24h購物', 'YAHOO購物中心', '酷澎'],
          note: '指定通路加碼回饋（網購量販通路），需符合2項以上資格條件',
          validUntil,
        },
        {
          category: 'mobilepay',
          pct: parseFloat(tableM[8]),
          merchants: ['台灣Pay'],
          note: '指定通路加碼回饋（台灣Pay掃碼交易），需符合2項以上資格條件',
          validUntil,
        },
      ],
    });
  } else {
    warn('熊Q卡', '回饋分級表格文字比對失敗，改用基礎回饋句作為 fallback');
    const m = text.match(/基礎回饋：一般消費國內(\d+(?:\.\d+)?)%、國外(\d+(?:\.\d+)?)%回饋無上限/);
    if (m) {
      plans.push({
        id: 'default',
        name: '一般消費現金點數回饋（基礎回饋，未含加碼）',
        condition: '無條件（加碼回饋需另符合資格條件，本次解析未取得加碼表格，請人工確認官網）',
        rewards: [
          { category: 'general', pct: parseFloat(m[1]), validUntil, note: '基礎回饋；加碼回饋部分未確認' },
          { category: 'overseas', pct: parseFloat(m[2]), validUntil, note: '基礎回饋；加碼回饋部分未確認' },
        ],
      });
    }
  }

  if (!plans.length) throw new Error('熊Q卡：所有 plan 解析失敗');
  return { id: 'hncb-bearq', name: '華南熊Q卡', url: URLS.bearq, plans };
}

function scrapeDiamond(text) {
  const plans = [];
  const found = findOccurrenceNearestDate(text, /國內消費(\d+(?:\.\d+)?)%、國外消費(\d+(?:\.\d+)?)%之現金回饋無上限/);
  const m = found ? found.match : null;
  if (m) {
    const validUntil = found.validUntil;
    plans.push({
      id: 'default',
      name: '一般消費現金回饋',
      condition: '無條件（無限卡/御璽卡/晶緻卡/商務御璽卡通用）',
      rewards: [
        { category: 'general', pct: parseFloat(m[1]), validUntil, note: '國內一般消費，無上限' },
        { category: 'overseas', pct: parseFloat(m[2]), validUntil, note: '國外一般消費，無上限' },
      ],
    });
  } else {
    warn('超鑽現金回饋卡', '找不到「國內消費X%、國外消費X%之現金回饋無上限」文字');
  }

  if (!plans.length) throw new Error('超鑽現金回饋卡：所有 plan 解析失敗');
  return { id: 'hncb-diamond', name: '超鑽現金回饋卡', url: URLS.diamond, plans };
}

function scrapeIShopping(text) {
  const plans = [];

  // 「申請「信用卡電子帳單」及綁定「華南銀行LINE官方帳號個人化通知服務」，當期信用卡帳單網購消費單筆達300元(含)以上，
  //   每筆最高享2％現金回饋，當期帳單現金回饋上限200元。」
  const found = findOccurrenceNearestDate(text, /每筆最高享(\d+(?:\.\d+)?)％現金回饋，當期帳單現金回饋上限(\d+)元/);
  const m = found ? found.match : null;
  if (m) {
    const validUntil = found.validUntil;
    plans.push({
      id: 'online-cashback',
      name: '網購現金回饋',
      condition: '需申請信用卡電子帳單並綁定華南銀行LINE官方帳號個人化通知服務；單筆網購消費達NT$300(含)以上',
      rewards: [
        {
          category: 'online',
          pct: parseFloat(m[1]),
          cap: `每期帳單現金回饋上限NT$${m[2]}，正附卡合併計算，未折抵回饋金效期6個月`,
          validUntil,
        },
      ],
    });
  } else {
    warn('I網購生活卡', '找不到網購現金回饋文字');
  }

  // 一般消費紅利加倍（非現金回饋，屬紅利點數，不寫入 pct，因非現金%）
  // 依 SCHEMA 僅收現金回饋等值%，紅利點數方案缺乏對外已知兌換率，故略過不硬轉換以免編造。

  if (!plans.length) throw new Error('I網購生活卡：所有 plan 解析失敗');
  return { id: 'hncb-ishopping', name: 'I網購生活卡', url: URLS.ishopping, plans };
}

async function scrape() {
  const cards = [];
  const scrapers = [
    { key: 'bearq', url: URLS.bearq, fn: scrapeBearQ },
    { key: 'diamond', url: URLS.diamond, fn: scrapeDiamond },
    { key: 'ishopping', url: URLS.ishopping, fn: scrapeIShopping },
  ];
  for (const s of scrapers) {
    try {
      const text = await fetchText(s.url);
      cards.push(s.fn(text));
    } catch (e) {
      console.error(`  [hncb] ${s.key} 抓取/解析失敗：${e.message}`);
    }
    await sleep(1200);
  }
  return {
    id: 'hncb',
    name: '華南銀行',
    cards,
  };
}

module.exports = { scrape };
