// 合作金庫商業銀行 (tcb) 信用卡回饋爬蟲
//
// 來源 URL（2026-07-10 人工驗證可 fetch，200 OK，伺服器端渲染，無需 JS 引擎）：
//   合庫利High卡（晶緻卡）           https://www.tcb-bank.com.tw/personal-banking/credit-card/intro/overview/ipass-intro
//   卡娜赫拉的小動物悠遊聯名卡(環保綠) https://www.tcb-bank.com.tw/personal-banking/credit-card/intro/overview/kanahei
//   晶片COMBO卡（鈦金卡）             https://www.tcb-bank.com.tw/personal-banking/credit-card/intro/overview/combo
//
// 官網「所有卡片」總覽頁 (intro/overview) 為前端動態載入清單，靜態 fetch 抓不到卡片清單本身，
// 但個別卡片詳情頁是伺服器端渲染，故本檔直接寫死已人工核對存在的 3 個現行卡詳情頁 URL；
// 若日後改版路徑失效，fetch 會回傳非 200，該卡會被跳過並記錄警告。
//
// 解析假設：
//   - 文字用 cheerio 取出 body 純文字後，以「穩定中文片語」regex 定位 %／上限／活動期間。
//   - 合庫官網日期格式不統一：kanahei 用「2026-07-01 ~ 2026-12-31」，ipass 用「2026/7/1~2026/12/31」，
//     兩種 parseDateRangeEnd 都嘗試。
//   - combo 卡為常態商品（依活期存款餘額分級回饋 0.1%~0.8%），頁面未標示到期日，validUntil 留空。

const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 CardRewardsBot/1.0';

const URLS = {
  ipass: 'https://www.tcb-bank.com.tw/personal-banking/credit-card/intro/overview/ipass-intro',
  kanahei: 'https://www.tcb-bank.com.tw/personal-banking/credit-card/intro/overview/kanahei',
  combo: 'https://www.tcb-bank.com.tw/personal-banking/credit-card/intro/overview/combo',
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

// 找離 nearIndex「絕對距離最近」的日期區間（不論前後），支援 "YYYY-MM-DD ~ YYYY-MM-DD" 與
// "YYYY/M/D~YYYY/M/D"（或省略結束年份）兩種格式。用絕對距離而非固定視窗內第一個 match，
// 避免抓到頁面中鄰近但不相關段落（例如另一個活動）的日期。
const ISO_DASH_DATE_RANGE_RE = /(\d{4})-(\d{2})-(\d{2})\s*~\s*(\d{4})-(\d{2})-(\d{2})/g;
const SLASH_DATE_RANGE_RE = /(\d{4})\/(\d{1,2})\/(\d{1,2})\s*[~-]\s*(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})/g;

function parseDateRangeEnd(text, nearIndex) {
  if (nearIndex == null) return null;
  let best = null;
  let bestDist = Infinity;
  for (const m of text.matchAll(ISO_DASH_DATE_RANGE_RE)) {
    const dist = Math.abs(m.index - nearIndex);
    if (dist < bestDist) {
      bestDist = dist;
      best = `${m[4]}-${m[5]}-${m[6]}`;
    }
  }
  for (const m of text.matchAll(SLASH_DATE_RANGE_RE)) {
    const dist = Math.abs(m.index - nearIndex);
    if (dist < bestDist) {
      bestDist = dist;
      const endYear = m[4] || m[1];
      best = `${endYear}-${String(m[5]).padStart(2, '0')}-${String(m[6]).padStart(2, '0')}`;
    }
  }
  return best;
}

function warn(cardName, msg) {
  console.error(`  [tcb/${cardName}] 警告：${msg}`);
}

function scrapeIpass(text) {
  const plans = [];

  // 基礎：「國內一般消費享1%現金回饋」「國外一般消費享1%現金回饋」
  const domM = text.match(/國內一般消費享(\d+(?:\.\d+)?)%現金回饋/);
  const ovsM = text.match(/國外一般消費享(\d+(?:\.\d+)?)%現金回饋/);
  if (domM || ovsM) {
    const rewards = [];
    if (domM) rewards.push({ category: 'general', pct: parseFloat(domM[1]), note: '國內一般消費基礎回饋' });
    if (ovsM) rewards.push({ category: 'overseas', pct: parseFloat(ovsM[1]), note: '國外一般消費基礎回饋（不含日本加碼期間）' });
    plans.push({ id: 'base', name: '一般消費基礎回饋', condition: '無條件', rewards });
  } else {
    warn('利High卡', '找不到國內外基礎回饋文字');
  }

  // 全新卡戶/數位申辦加碼：各 +1%，月上限100元，2026/7/1~2026/12/31
  {
    const m = text.match(/全新卡戶享(\d+(?:\.\d+)?)%加碼回饋/);
    const m2 = text.match(/數位申辦享(\d+(?:\.\d+)?)%加碼回饋/);
    if (m && domM) {
      const idx = text.indexOf(m[0]);
      const validUntil = parseDateRangeEnd(text, idx);
      const capMatch = text.match(/加碼回饋]?各?月上限(\d+)元|月上限各?(\d+)元/);
      const cap = capMatch ? `月上限NT$${capMatch[1] || capMatch[2]}` : '月上限NT$100（未確認：來源文字提及「各100元」，抓取時未鎖定精確句型）';
      plans.push({
        id: 'new-customer-bonus',
        name: '全新卡戶／數位申辦加碼',
        condition: '2026/7/1~2026/12/31期間核卡之全新卡戶，或透過合庫網銀/APP數位申辦者；核卡日至次月起三個月內',
        rewards: [
          {
            category: 'general',
            pct: parseFloat((parseFloat(domM[1]) + parseFloat(m[1])).toFixed(2)),
            cap,
            validUntil,
            note: `國內基礎${domM[1]}%+全新卡戶加碼${m[1]}%（與數位申辦加碼${m2 ? m2[1] : '?'}%擇一或可疊加，官網未明示是否可疊加，請以官網為準）`,
          },
        ],
      });
    }
  }

  // 日本/其他國家加碼：「日本一般消費享加碼2%現金回饋」「其他國家一般消費享加碼1%現金回饋」
  {
    const jpM = text.match(/日本一般消費享加碼(\d+(?:\.\d+)?)%現金回饋/);
    const otherM = text.match(/其他國家一般消費享加碼(\d+(?:\.\d+)?)%現金回饋/);
    if (jpM && ovsM) {
      const idx = text.indexOf(jpM[0]);
      const validUntil = parseDateRangeEnd(text, idx);
      const rewards = [
        {
          category: 'overseas',
          pct: parseFloat((parseFloat(ovsM[1]) + parseFloat(jpM[1])).toFixed(2)),
          merchants: ['日本'],
          validUntil,
          note: `國外基礎${ovsM[1]}%+日本加碼${jpM[1]}%（活動期間限定）`,
        },
      ];
      if (otherM) {
        rewards.push({
          category: 'overseas',
          pct: parseFloat((parseFloat(ovsM[1]) + parseFloat(otherM[1])).toFixed(2)),
          validUntil,
          note: `國外基礎${ovsM[1]}%+其他國家加碼${otherM[1]}%（活動期間限定，日本除外）`,
        });
      }
      plans.push({ id: 'overseas-bonus', name: '國外消費加碼（活動期間）', condition: '2026/7/1~2026/12/31活動期間', rewards });
    }
  }

  // 日本櫻花季加碼：「加碼5%回饋(上限2,000元)」，活動期間 2026-03-01~2026-04-30（已過期，仍如實記錄）
  {
    const m = text.match(/加碼(\d+(?:\.\d+)?)%回饋\(上限([\d,]+)元\)/);
    if (m) {
      const idx = text.indexOf(m[0]);
      plans.push({
        id: 'japan-sakura',
        name: '日本櫻花季百貨加碼',
        condition: '日本地區大丸百貨、伊勢丹百貨、高島屋及阪急阪神百貨實體店面消費並登錄成功；限實體卡片交易',
        rewards: [
          {
            category: 'department',
            pct: parseFloat(m[1]),
            merchants: ['大丸百貨', '伊勢丹百貨', '高島屋', '阪急阪神百貨'],
            cap: `活動加碼上限NT$${m[2]}`,
            validUntil: parseDateRangeEnd(text, idx),
            note: '限日本地區實體店面、須完成活動登錄',
          },
        ],
      });
    }
  }

  if (!plans.length) throw new Error('利High卡：所有 plan 解析失敗');
  return { id: 'tcb-ipass', name: '合庫利High卡', url: URLS.ipass, plans };
}

function scrapeKanahei(text) {
  const plans = [];

  // 基礎：「國內、外一般消費回饋金1%，無最低門檻，回饋無上限。」
  const baseM = text.match(/國內、外一般消費回饋金(\d+(?:\.\d+)?)%，無最低門檻，回饋無上限/);
  if (baseM) {
    const idx = text.indexOf(baseM[0]);
    const validUntil = parseDateRangeEnd(text, idx);
    plans.push({
      id: 'base',
      name: '一般消費基礎回饋',
      condition: '無條件',
      rewards: [
        { category: 'general', pct: parseFloat(baseM[1]), validUntil, note: '國內一般消費，無上限' },
        { category: 'overseas', pct: parseFloat(baseM[1]), validUntil, note: '國外一般消費，無上限' },
      ],
    });
  } else {
    warn('卡娜赫拉悠遊聯名卡', '找不到基礎回饋文字');
  }

  // 三大通路加碼：「三大通路加碼10%回饋」「每項通路上限100元，每卡總回饋最高300元」
  {
    const m = text.match(/三大通路加碼(\d+(?:\.\d+)?)%回饋/);
    const capM = text.match(/每項通路上限(\d+)元，每卡總回饋最高(\d+)元/);
    if (m) {
      const idx = text.indexOf(m[0]);
      const validUntil = parseDateRangeEnd(text, idx);
      const pct = parseFloat(m[1]);
      const cap = capM ? `每項通路上限NT$${capM[1]}，每卡每月總回饋最高NT$${capM[2]}` : undefined;
      const condition = '當期帳單新增一般消費達NT$2,999以上，享三大通路加碼資格';
      plans.push({
        id: 'triple-channel-bonus',
        name: '三大通路加碼',
        condition,
        rewards: [
          {
            category: 'mobilepay',
            pct,
            merchants: ['LINE Pay', '街口支付', '悠遊付', 'icash Pay', '歐付寶', '台灣Pay'],
            cap,
            validUntil,
            note: '行動支付通路加碼',
          },
          {
            category: 'entertainment',
            pct,
            merchants: ['Gogoro Network', 'GoShare', 'WeMo Scooter', '特斯拉充電'],
            cap,
            validUntil,
            note: '綠能通路加碼；官網無「綠能」對應類別，暫歸類 entertainment，請以官網為準',
          },
          {
            category: 'streaming',
            pct,
            merchants: ['Nintendo', 'PlayStation', 'KKBOX', 'Netflix', 'Spotify', 'Youtube Premium', 'Disney+'],
            cap,
            validUntil,
            note: '遊戲影音通路加碼',
          },
        ],
      });
    } else {
      warn('卡娜赫拉悠遊聯名卡', '找不到三大通路加碼文字');
    }
  }

  if (!plans.length) throw new Error('卡娜赫拉悠遊聯名卡：所有 plan 解析失敗');
  return { id: 'tcb-kanahei', name: '卡娜赫拉的小動物悠遊聯名卡(環保綠)', url: URLS.kanahei, plans };
}

function scrapeCombo(text) {
  const plans = [];

  // 分級表：0.1% / 0.3% / 0.5% / 0.8%，依活期性存款近3個月平均餘額
  const tierMatches = [...text.matchAll(/(\d(?:\.\d+)?)%/g)].map((m) => parseFloat(m[1]));
  const capM = text.match(/每月現金回饋上限為(\d+(?:,\d+)?)元/);
  const cap = capM ? `每月現金回饋上限NT$${capM[1]}` : undefined;

  // 找出常見四個分級數值（0.1/0.3/0.5/0.8）是否都存在於文字中，存在才建立 reward
  const expectedTiers = [
    { threshold: '未滿NT$50,000', pct: 0.1 },
    { threshold: 'NT$50,000（含）以上', pct: 0.3 },
    { threshold: 'NT$200,000（含）以上', pct: 0.5 },
    { threshold: 'NT$2,000,000（含）以上', pct: 0.8 },
  ];
  const foundTiers = expectedTiers.filter((t) => tierMatches.includes(t.pct));

  if (foundTiers.length >= 3) {
    plans.push({
      id: 'balance-tier',
      name: '依存款餘額分級現金回饋',
      condition: '依活期性存款近3個月平均餘額分級，餘額越高回饋越高',
      rewards: foundTiers.map((t) => ({
        category: 'general',
        pct: t.pct,
        cap,
        note: `活期性存款近3個月平均餘額${t.threshold}；常態商品，官網未標示到期日`,
      })),
    });
  } else {
    warn('晶片COMBO卡', `分級回饋數值比對不足（找到 ${foundTiers.length}/4），略過此卡`);
  }

  if (!plans.length) throw new Error('晶片COMBO卡：所有 plan 解析失敗');
  return { id: 'tcb-combo', name: '晶片COMBO卡（鈦金卡）', url: URLS.combo, plans };
}

async function scrape() {
  const cards = [];
  const scrapers = [
    { key: 'ipass', url: URLS.ipass, fn: scrapeIpass },
    { key: 'kanahei', url: URLS.kanahei, fn: scrapeKanahei },
    { key: 'combo', url: URLS.combo, fn: scrapeCombo },
  ];
  for (const s of scrapers) {
    try {
      const text = await fetchText(s.url);
      cards.push(s.fn(text));
    } catch (e) {
      console.error(`  [tcb] ${s.key} 抓取/解析失敗：${e.message}`);
    }
    await sleep(1200);
  }
  return {
    id: 'tcb',
    name: '合作金庫銀行',
    cards,
  };
}

module.exports = { scrape };
