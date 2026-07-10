// 彰化銀行（chb）信用卡回饋爬蟲
//
// 來源 URL（2026-07-10 人工核對過結構，之後若改版需重新核對）：
//   - My樂現金回饋卡：https://mylove.bankchb.com/
//   - My購卡（網路購物卡）：https://mylove.bankchb.com/MyGo_online_shopping/
//   - 馬偕認同卡：    https://creditcard.bankchb.com/MackayAffinity/index.html
//
// 解析假設：
//   - 彰化銀行主站 www.bankchb.com 的信用卡選單是 JS 動態展開、找不到穩定的「卡片總覽」清單頁，
//     因此改用彰銀信用卡行銷子站（mylove.bankchb.com、creditcard.bankchb.com）作為來源；
//     這幾個子站是靜態伺服器渲染頁，fetch 即可拿到完整文案，不需要 playwright。
//   - My樂卡首頁最上方有一張「指定6大通路」摘要表（國外/超市/量販/餐廳/百貨/電信），以
//     「(通路名) 最高回饋(N)%」的固定格式出現（頁面重複兩份相同的表），用 matchAll 取第一次
//     出現的值即可；比往下爬長篇活動細則穩定。
//   - My樂卡另有「行動支付刷My樂」活動：一般登錄享3%，新戶核卡後3個月享9%（同一活動的兩層
//     資格），視為兩個 plans，對應 SCHEMA 要求的「方案/等級差異」。
//   - 民國年日期（如 115/1/1、115年1月1日）一律 +1911 轉西元填入 validUntil。
//   - My購卡頁面用「LevelN」文案描述疊加式回饋（一般1% → 網購加碼+1% → 海外電商/旅遊/遊戲
//     最高6% → 指定數位通路最高6%）；同一張卡依消費通路自動適用，不是互斥方案，因此併入單一
//     plan 的多筆 rewards，而不拆成多個 plans。
//   - My購卡頁面未標活動期間 → validUntil 留空並在 note 註明「效期未確認」。
//   - 馬偕認同卡頁面只有「刷卡繳保費回饋」有明確百分比與效期，其餘（Mastercard卡友優惠、
//     康是美滿額贈）無法換算成 %，不收錄。

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/util');

const URLS = {
  mylove: 'https://mylove.bankchb.com/',
  mygo: 'https://mylove.bankchb.com/MyGo_online_shopping/',
  mackay: 'https://creditcard.bankchb.com/MackayAffinity/index.html',
};

function textOf(html) {
  const $ = cheerio.load(html);
  $('script,style').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function rocToIso(rocYear, month, day) {
  const year = parseInt(rocYear, 10) + 1911;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function scrapeMyLove() {
  const text = textOf(await fetchHtml(URLS.mylove));

  // 頁首「指定6大通路」摘要表
  const categoryMap = {
    國外: 'overseas',
    超市: 'supermarket',
    量販: 'supermarket', // SCHEMA 的 supermarket 涵蓋「超市／量販」
    餐廳: 'dining',
    百貨: 'department',
    電信: 'telecom',
  };
  const seenLabels = {};
  for (const m of text.matchAll(/(國外|超市|量販|餐廳|百貨|電信)\s*最高回饋(\d+(?:\.\d+)?)%/g)) {
    if (!(m[1] in seenLabels)) seenLabels[m[1]] = m[2];
  }
  // 頁面通則：「如無特別說明，上述各項權益及活動期間均為115/1/1起至115/6/30止」
  const blanket = text.match(
    /上述各項權益及活動期間均為(\d{2,3})\/(\d{1,2})\/(\d{1,2})起至(\d{2,3})\/(\d{1,2})\/(\d{1,2})止/
  );
  const blanketUntil = blanket ? rocToIso(blanket[4], blanket[5], blanket[6]) : null;
  const defaultRewards = [];
  const addedCategories = new Set();
  for (const [label, pct] of Object.entries(seenLabels)) {
    const category = categoryMap[label];
    if (addedCategories.has(category)) continue; // 量販/超市同為 supermarket，避免重複
    addedCategories.add(category);
    const r = {
      category,
      pct: parseFloat(pct),
      note: `指定6大通路之「${label}」最高回饋`,
    };
    if (blanketUntil) {
      r.validUntil = blanketUntil;
      r.note += '（依頁面通則「如無特別說明，各項權益及活動期間」認定效期）';
    } else {
      r.note += '；效期未確認';
    }
    defaultRewards.push(r);
  }

  // 保費現金回饋（含活動期間，民國年）
  const insurance = text.match(
    /刷彰銀信用卡扣繳任一筆保費，享(\d+(?:\.\d+)?)%現金回饋\(含卡片原始回饋\)或分期(\d+)期0利率二選一。活動期間：(\d{2,3})年(\d{1,2})月(\d{1,2})日至(\d{2,3})年(\d{1,2})月(\d{1,2})日/
  );
  if (insurance) {
    defaultRewards.push({
      category: 'insurance',
      pct: parseFloat(insurance[1]),
      note: `現金回饋（含卡片原始回饋），或改選分期${insurance[2]}期0利率（二選一，需登錄活動）`,
      validUntil: rocToIso(insurance[6], insurance[7], insurance[8]),
    });
  }

  // 行動支付刷My樂：一般登錄 3%／新戶核卡後3個月 9%
  const mobilepayBase = text.match(/指定之6款錢包\(註1\)當月消費享(\d+(?:\.\d+)?)%現金回饋/);
  const mobilepayNew = text.match(/則享核卡後3個月(\d+(?:\.\d+)?)%現金回饋/);
  const mobilepayCap = text.match(/每歸戶每月加碼回饋上限(\d+)元/);
  const mobilepayPeriod = text.match(
    /「行動支付刷My樂[^」]*」\s*活動辦法\s*活動期間：(\d{2,3})年(\d{1,2})月(\d{1,2})日至(\d{2,3})年(\d{1,2})月(\d{1,2})日/
  );
  const capNote = mobilepayCap ? `每歸戶每月加碼回饋上限NT$${mobilepayCap[1]}` : null;
  const mobilepayUntil = mobilepayPeriod
    ? rocToIso(mobilepayPeriod[4], mobilepayPeriod[5], mobilepayPeriod[6])
    : null;
  const wallets = '台灣Pay、Google Pay、LINE Pay、街口支付、Pi拍錢包、悠遊付';

  if (mobilepayBase) {
    const r = {
      category: 'mobilepay',
      pct: parseFloat(mobilepayBase[1]),
      note: `限${wallets}等6款指定電子錢包綁定消費（加碼，不含卡片原始回饋）；需每月登錄活動`,
    };
    if (capNote) r.cap = capNote;
    if (mobilepayUntil) r.validUntil = mobilepayUntil;
    defaultRewards.push(r);
  }

  const plans = [];
  if (defaultRewards.length) {
    plans.push({
      id: 'default',
      name: '一般',
      condition: '部分加碼活動需登錄',
      rewards: defaultRewards,
    });
  }
  if (mobilepayNew) {
    const r = {
      category: 'mobilepay',
      pct: parseFloat(mobilepayNew[1]),
      note: `限${wallets}等6款指定電子錢包綁定消費（加碼，不含卡片原始回饋）；核卡後3個月內適用，需登錄活動`,
    };
    if (capNote) r.cap = capNote;
    if (mobilepayUntil) r.validUntil = mobilepayUntil;
    plans.push({
      id: 'newcard',
      name: '新戶核卡後3個月',
      condition: '未曾申辦過My樂現金回饋卡正卡之新戶，核卡後3個月內',
      rewards: [r],
    });
  }

  if (!plans.length) {
    console.error('chb: My樂卡頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }

  return { id: 'chb-mylove', name: 'My樂現金回饋卡', url: URLS.mylove, plans };
}

async function scrapeMyGo() {
  const text = textOf(await fetchHtml(URLS.mygo));

  const general = text.match(/申請即享一般消費(\d+(?:\.\d+)?)%回饋無上限/);
  const domesticBonus = text.match(/網購消費加碼(\d+(?:\.\d+)?)%/);
  const level3 = text.match(/指定海外電商\/旅遊平台\/遊戲平台\s*消費最高(\d+(?:\.\d+)?)%/);
  const level4 = text.match(/指定數位通路消費，最高(\d+(?:\.\d+)?)%/);
  const insurance = text.match(/刷卡扣繳保費即享\s*現金\s*(\d+(?:\.\d+)?)%\s*高回饋/);

  if (!general) {
    console.error('chb: My購卡頁面抓不到一般消費回饋數字，跳過此卡');
    return null;
  }

  const expiryNote = '效期未確認（My購卡頁未標活動期間）';
  const rewards = [{ category: 'general', pct: parseFloat(general[1]), note: `回饋無上限；${expiryNote}` }];

  if (domesticBonus) {
    rewards.push({
      category: 'online',
      pct: parseFloat(general[1]) + parseFloat(domesticBonus[1]),
      merchants: ['momo購物網', '蝦皮購物', 'PChome線上購物', 'Yahoo奇摩購物'],
      note: `含一般消費基本回饋${general[1]}%＋網購加碼${domesticBonus[1]}%；指定國內電商週六日另有加碼；${expiryNote}`,
    });
  }
  if (level3) {
    const pct = parseFloat(level3[1]);
    rewards.push({
      category: 'online',
      pct,
      merchants: ['Amazon', 'iHerb', 'ASOS', 'Selfridges', 'Farfetch', 'Shopbop', 'SSENSE', 'Coupang酷澎'],
      note: `指定海外電商最高回饋（已含基本回饋）；${expiryNote}`,
    });
    rewards.push({
      category: 'travel',
      pct,
      merchants: ['Agoda', 'Klook', 'Trip.com'],
      note: `指定旅遊平台最高回饋（已含基本回饋）；${expiryNote}`,
    });
    rewards.push({
      category: 'entertainment',
      pct,
      merchants: ['PlayStation', 'XBOX', 'Nintendo', 'Steam', 'Garena', 'Blizzard', 'MyCard'],
      note: `指定遊戲平台最高回饋（已含基本回饋）；${expiryNote}`,
    });
  }
  if (level4) {
    rewards.push({
      category: 'streaming',
      pct: parseFloat(level4[1]),
      merchants: ['Disney+', 'Netflix', 'Apple TV+', 'Apple Music', 'KKTV', 'KKBOX', 'Spotify', 'YouTube Premium'],
      note: `指定串流影音通路最高回饋（已含基本回饋）；${expiryNote}`,
    });
  }
  if (insurance) {
    rewards.push({
      category: 'insurance',
      pct: parseFloat(insurance[1]),
      note: `現金回饋，或改選分期6期0利率（需登錄）；${expiryNote}`,
    });
  }

  return {
    id: 'chb-mygo',
    name: 'My購卡',
    url: URLS.mygo,
    plans: [{ id: 'default', name: '一般', condition: '無條件（依消費通路自動適用對應回饋率）', rewards }],
  };
}

async function scrapeMackay() {
  const text = textOf(await fetchHtml(URLS.mackay));
  const insurance = text.match(
    /刷彰銀信用卡扣繳任一筆保費，享(\d+(?:\.\d+)?)%現金回饋\(含卡片原始回饋\)或分期(\d+)期0利率二選一/
  );
  const period = text.match(
    /上述各項權益及活動期間均為(\d{2,3})\/(\d{1,2})\/(\d{1,2})起至(\d{2,3})\/(\d{1,2})\/(\d{1,2})止/
  );

  if (!insurance) {
    console.error('chb: 馬偕認同卡頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }

  const reward = {
    category: 'insurance',
    pct: parseFloat(insurance[1]),
    note: `現金回饋（含卡片原始回饋），或改選分期${insurance[2]}期0利率（二選一，需登錄活動）`,
  };
  if (period) reward.validUntil = rocToIso(period[4], period[5], period[6]);

  return {
    id: 'chb-mackay',
    name: '馬偕認同卡',
    url: URLS.mackay,
    plans: [{ id: 'default', name: '一般', condition: '需登錄活動', rewards: [reward] }],
  };
}

async function scrape() {
  const results = await Promise.all([scrapeMyLove(), scrapeMyGo(), scrapeMackay()]);
  const cards = results.filter(Boolean);
  return { id: 'chb', name: '彰化銀行', cards };
}

module.exports = { scrape };
