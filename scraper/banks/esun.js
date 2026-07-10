// 玉山銀行（esun）信用卡回饋爬蟲
//
// 來源 URL（2026-07-10 人工核對過結構，之後若改版需重新核對）：
//   - 玉山數位e卡：https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/e-card
//   - 玉山Unicard： https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/unicard
//   - 玉山鈦金卡：  https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/titanium-card
//
// 解析假設：
//   - 這三頁都是「靜態伺服器渲染」頁面（fetch 拿到的 HTML 已含完整行銷文案），不需要 playwright。
//   - 玉山把回饋率直接寫在文案句子裡（例：「國內外一般消費享0.5%玉山e point回饋」），
//     所以用「固定中文短語 + 緊接的百分比」的 regex 去抓，比硬 parse DOM 結構穩定
//     （這幾頁的 class name 明顯是行銷團隊手刻、經常換）。
//   - 玉山e point 為點數制，官網文案本身已經把「N%玉山e point回饋」講清楚等值百分比，
//     不需要額外換算，只在 note 註明是 e point。
//   - Unicard 頁面清楚列出「僅帳單e化」vs「帳單e化＋自動扣繳」兩種一般消費回饋率（0.3% vs 1%），
//     這是 SCHEMA 要求的「方案／等級差異」範例；另有百大指定消費三方案（簡單選/任意選/UP選），
//     這裡只取加碼最高的 UP選 併入「帳單e化＋自動扣繳」方案的 rewards，並在 note 說明。
//   - 若改版後抓不到某張卡的任何 reward，該卡會被跳過（不寫入空卡），並把原因印到 stderr，
//     由 run.js 的 schema 驗證負責在完全抓不到時讓這個模組失敗。

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/util');

const URLS = {
  ecard: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/e-card',
  unicard: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/unicard',
  titanium: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/titanium-card',
};

function textOf(html) {
  const $ = cheerio.load(html);
  $('script,style').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

async function scrapeECard() {
  const text = textOf(await fetchHtml(URLS.ecard));
  const rewards = [];

  const general = text.match(/國內外一般消費享(\d+(?:\.\d+)?)%玉山e ?point回饋/);
  if (general) {
    rewards.push({
      category: 'general',
      pct: parseFloat(general[1]),
      note: '玉山e point點數回饋（1點=1元）；需同時申請帳單e化及玉山銀行臺幣帳戶自動扣繳卡費',
    });
  }

  const dept = text.match(/指定百貨\/美妝通路消費最高(?:享)?(\d+(?:\.\d+)?)%玉山e ?point回饋/);
  if (dept) {
    rewards.push({
      category: 'department',
      pct: parseFloat(dept[1]),
      cap: '加碼部分歸戶每期回饋上限250點（玉山e point）',
      note: '玉山e point點數回饋；已含基本回饋0.5%＋指定百貨/美妝加碼；需同時申請帳單e化及自動扣繳卡費',
    });
  }

  const coffee = text.match(/指定咖啡\/支付通路消費最高(?:享)?(\d+(?:\.\d+)?)%玉山e ?point回饋/);
  if (coffee) {
    rewards.push({
      category: 'dining',
      pct: parseFloat(coffee[1]),
      cap: '加碼部分歸戶每期回饋上限250點（玉山e point）',
      note: '玉山e point點數回饋；指定咖啡／行動支付通路，已含基本回饋0.5%＋加碼2.5%；需同時申請帳單e化及自動扣繳卡費',
    });
  }

  const eco = text.match(/指定類別消費(?:登錄)?最高(?:享)?(\d+(?:\.\d+)?)%玉山e ?point回饋/);
  if (eco) {
    rewards.push({
      category: 'supermarket',
      pct: parseFloat(eco[1]),
      cap: '加碼部分歸戶每期回饋上限250點（玉山e point）',
      merchants: ['里仁', '棉花田', '聖德科斯', '主婦聯盟'],
      note: '玉山e point點數回饋；指定類別（含里仁/棉花田/聖德科斯/主婦聯盟等及部分電動車能源通路），已含基本回饋0.5%＋加碼4.5%；需同時申請帳單e化及自動扣繳卡費',
    });
  }

  if (!rewards.length) {
    console.error('esun: e-card 頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }

  return {
    id: 'esun-ecard',
    name: '玉山數位e卡',
    url: URLS.ecard,
    plans: [
      {
        id: 'digital-autopay',
        name: '帳單e化＋自動扣繳方案',
        condition: '需同時申請帳單e化及玉山銀行臺幣帳戶自動扣繳卡費',
        rewards,
      },
    ],
  };
}

async function scrapeUnicard() {
  const text = textOf(await fetchHtml(URLS.unicard));

  const ebillOnly = text.match(/一般消費享(\d+(?:\.\d+)?)%\s*玉山e ?point回饋，需申辦帳單e化/);
  const ebillAutopay = text.match(
    /一般消費享(\d+(?:\.\d+)?)%\s*玉山e ?point回饋，需同時申辦帳單e化及申辦玉山銀行臺幣帳戶自動扣繳/
  );
  const period = text.match(/活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const validUntil = period
    ? `${period[4]}-${String(period[5]).padStart(2, '0')}-${String(period[6]).padStart(2, '0')}`
    : null;

  const upMatches = [...text.matchAll(/百大指定消費\s*\+(\d+(?:\.\d+)?)%\s*\(歸戶月上限([\d,]+)點\)/g)];
  const upSelect = upMatches.length ? upMatches[upMatches.length - 1] : null;

  const plans = [];

  if (ebillOnly) {
    plans.push({
      id: 'ebill-only',
      name: '僅申辦帳單e化',
      condition: '僅申辦帳單e化（Email電子帳單或簡訊帳單）',
      rewards: [
        { category: 'general', pct: parseFloat(ebillOnly[1]), note: '玉山e point點數回饋（1點=1元）' },
      ],
    });
  }

  if (ebillAutopay) {
    const rewards = [
      { category: 'general', pct: parseFloat(ebillAutopay[1]), note: '玉山e point點數回饋（1點=1元），回饋無上限' },
    ];
    if (upSelect) {
      const reward = {
        category: 'online',
        pct: parseFloat(upSelect[1]),
        cap: `每月（歸戶）回饋上限${upSelect[2]}點（玉山e point）`,
        note: '百大指定消費「UP選」方案加碼（行動支付、加油交通、生活採買、國內百貨等通路可自選）；需另於玉山Wallet完成任務或以點數訂閱',
      };
      if (validUntil) reward.validUntil = validUntil;
      rewards.push(reward);
    }
    plans.push({
      id: 'ebill-autopay',
      name: '帳單e化＋臺幣帳戶自動扣繳',
      condition: '需同時申辦帳單e化及玉山銀行臺幣帳戶自動扣繳卡費',
      rewards,
    });
  }

  if (!plans.length) {
    console.error('esun: unicard 頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }

  return { id: 'esun-unicard', name: '玉山Unicard', url: URLS.unicard, plans };
}

async function scrapeTitanium() {
  const text = textOf(await fetchHtml(URLS.titanium));
  // 注意：頁面 <script type="application/ld+json"> 的 meta 描述殘留舊版「0.6%」文案，
  // 已透過移除 script/style 節點避開；實際內文（含活動期間）目前是 0.4%，以內文為準。
  const period = text.match(/活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})\s*每筆一般消費最高可享/);
  const general = text.match(/每筆一般消費最高可享\s*(\d+(?:\.\d+)?)%\s*現金回饋，回饋無上限/);
  const tier = text.match(/([\d,]+)元\s*\(含\)\s*以下\s*(\d+(?:\.\d+)?)%現金回饋\s*([\d,]+)元\s*\(含\)\s*以上\s*(\d+(?:\.\d+)?)[%％]現金回饋/);
  if (!general) {
    console.error('esun: titanium-card 頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }
  const reward = { category: 'general', pct: parseFloat(general[1]), note: '現金直接折抵次期帳單消費，回饋無上限' };
  if (tier) {
    reward.note += `；單筆消費${tier[1]}元(含)以下回饋${tier[2]}%，${tier[3]}元(含)以上回饋${tier[4]}%`;
  }
  if (period) {
    reward.validUntil = `${period[4]}-${String(period[5]).padStart(2, '0')}-${String(period[6]).padStart(2, '0')}`;
  }
  return {
    id: 'esun-titanium',
    name: '玉山幸運鈦金卡',
    url: URLS.titanium,
    plans: [
      {
        id: 'default',
        name: '一般',
        condition: '無條件',
        rewards: [reward],
      },
    ],
  };
}

async function scrape() {
  const results = await Promise.all([scrapeECard(), scrapeUnicard(), scrapeTitanium()]);
  const cards = results.filter(Boolean);
  return { id: 'esun', name: '玉山銀行', cards };
}

module.exports = { scrape };
