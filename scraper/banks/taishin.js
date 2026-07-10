// 台新銀行（taishin）信用卡回饋爬蟲
//
// 來源 URL（2026-07-10 人工核對過結構，之後若改版需重新核對）：
//   - 信用卡總覽（含卡片清單）：https://www.taishinbank.com.tw/TSB/personal/credit/
//   - 台新Richart卡（cg047）／大全聯信用卡（cg010）／街口聯名卡（cg038）之卡片頁：
//     https://www.taishinbank.com.tw/TSB/personal/credit/intro/overview/<cgNNN>/
//   - 各卡的回饋細節在「活動/權益頁」，其 URL 是會變動的 GUID 或短網址，
//     因此不寫死，而是每次從卡片頁上的連結文字動態找出來（見下）。
//
// 解析假設：
//   - 總覽頁 /TSB/personal/credit/ 是靜態頁：卡片清單以
//     href="/TSB/personal/credit/intro/overview/cgNNN/?from=index" class="pic" ...
//     <div class="title"><p>卡名</p> 的固定結構出現，用 regex 抓 cg 編號→卡名 對照。
//   - 各卡片頁（cgNNN）的內容區是 JS 動態載入 → 需要 playwright 渲染後才能拿到
//     活動/權益頁連結；連結靠「連結文字關鍵字」找（比 GUID 網址穩定）：
//       * Richart卡：連結文字「Richart卡權益介紹」（tsbk.tw 短網址 → mkp.taishinbank.com.tw）
//       * 大全聯卡：連結文字含「新版權益」（→ /intro/overview/future/<GUID>）
//       * 街口卡：  連結文字含「回饋攻略」且不含「已結束」（→ future/<GUID>）
//   - Richart 權益頁（mkp.taishinbank.com.tw）也是 JS 渲染 → playwright innerText 後用
//     「方案名（天天刷/大筆刷/好饗刷/數趣刷/玩旅刷…）+ 緊接百分比」的 regex 抓。
//     Richart卡是「7+1大刷」切換方案制：每個「刷」是一個可切換方案 → 各記一筆 plan。
//   - 大全聯/街口的活動頁（/intro/overview/future/<GUID>）是靜態伺服器渲染 → fetch 即可。
//   - 點數換算（皆為頁面原文所載）：台新Point(信用卡)官網直接以 % 表述；
//     大全聯福利點「10點=NT$1」；街口幣「1元街口幣=新臺幣1元」。均在 note 註明點數型態。
//   - Richart 的 7大刷權益頁未標活動迄日（僅 Chill刷有 2026/7/8-9/30）→ 其餘 plan 不填
//     validUntil，note 註明效期未確認。

const cheerio = require('cheerio');
const { fetchHtml, sleep, UA } = require('../lib/util');

const OVERVIEW_URL = 'https://www.taishinbank.com.tw/TSB/personal/credit/';
const CARD_URL = (cg) => `https://www.taishinbank.com.tw/TSB/personal/credit/intro/overview/${cg}/`;

const POINT_NOTE_RICHART = '台新Point(信用卡)點數回饋';
const POINT_NOTE_PX = '福利點點數回饋（福利點10點=NT$1，可折抵全聯/大全聯店內消費）';
const POINT_NOTE_JKO = '街口幣回饋（1元街口幣=新臺幣1元）';

function isoFrom(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 從總覽頁靜態 HTML 抓 cg編號 → 卡名
async function fetchCardIndex() {
  const html = await fetchHtml(OVERVIEW_URL);
  const map = {};
  const re =
    /href="\/TSB\/personal\/credit\/intro\/overview\/(cg\d+)\/\?from=index"[^>]*class="pic"[\s\S]{0,2000}?<div class="title">\s*<p>([\s\S]*?)<\/p>/g;
  for (const m of html.matchAll(re)) {
    const name = m[2].replace(/<[^>]+>/g, '').trim();
    if (name && !map[m[1]]) map[m[1]] = name;
  }
  return map;
}

// 用 playwright 渲染卡片頁並回傳頁上所有連結
async function renderCardLinks(page, cg) {
  await page.goto(CARD_URL(cg), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  return page.$$eval('a', (as) => as.map((a) => ({ href: a.href, text: a.innerText.trim() })));
}

// ---------- Richart 卡 ----------
async function scrapeRichart(page, cardName) {
  const links = await renderCardLinks(page, 'cg047');
  const rightsLink = links.find((l) => l.text.includes('Richart卡權益介紹'));
  if (!rightsLink) {
    console.error('taishin: cg047 頁面找不到「Richart卡權益介紹」連結，跳過 Richart 卡');
    return null;
  }
  // mkp 權益頁常有長輪詢，networkidle 會逾時 → 用 domcontentloaded + 固定等待
  await page.goto(rightsLink.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);
  const text = (await page.innerText('body')).replace(/\s+/g, ' ');

  const noExpiry = '效期未確認（權益頁未標活動迄日）';
  const plans = [];

  // Chill刷（限時方案，有明確期間）
  const chillPeriod = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*-\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*快樂上市/);
  const chillDining = text.match(/【歡聚微醺】([\d.]+)%/);
  const chillStream = text.match(/【熬夜追更】([\d.]+)%/);
  const chillOnline = text.match(/【數位外掛】([\d.]+)%/);
  if (chillDining) {
    const validUntil = chillPeriod ? isoFrom(chillPeriod[4], chillPeriod[5], chillPeriod[6]) : undefined;
    const rewards = [];
    const add = (category, m, note, merchants) => {
      if (!m) return;
      const r = { category, pct: parseFloat(m[1]), note: `${POINT_NOTE_RICHART}；${note}` };
      if (merchants) r.merchants = merchants;
      if (validUntil) r.validUntil = validUntil;
      rewards.push(r);
    };
    add('dining', chillDining, 'Chill刷【歡聚微醺】【日常續命】指定餐飲/手搖飲通路', ['海底撈', '50嵐', '貳樓']);
    add('streaming', chillStream, 'Chill刷【熬夜追更】指定串流/內容平台', ['Netflix', 'Disney+', '巴哈姆特']);
    add('online', chillOnline, 'Chill刷【數位外掛】指定通路', ['蝦皮購物', '淘寶', 'Uber Eats']);
    if (rewards.length) {
      plans.push({
        id: 'chill',
        name: 'Chill刷',
        condition: '需於Richart Life APP切換至「Chill刷」方案；限指定支付方式',
        validFrom: chillPeriod ? isoFrom(chillPeriod[1], chillPeriod[2], chillPeriod[3]) : undefined,
        validUntil,
        rewards,
      });
    }
  }

  // Pay著刷（行動支付）
  const tsPay = text.match(/台新Pay\s*及\s*台新Pay\+\s*綁定支付享\s*([\d.]+)\s*%/);
  const linePay = text.match(/LINE Pay\s*及\s*全盈\+Pay[^綁]*綁定支付享\s*([\d.]+)\s*%/);
  if (tsPay || linePay) {
    const rewards = [];
    if (tsPay)
      rewards.push({
        category: 'mobilepay',
        pct: parseFloat(tsPay[1]),
        note: `${POINT_NOTE_RICHART}；台新Pay及台新Pay+綁定支付（全家、7-11、新光三越等指定場域）；${noExpiry}`,
      });
    if (linePay)
      rewards.push({
        category: 'mobilepay',
        pct: parseFloat(linePay[1]),
        note: `${POINT_NOTE_RICHART}；LINE Pay及全盈+Pay綁定支付；${noExpiry}`,
      });
    plans.push({
      id: 'pay',
      name: 'Pay著刷',
      condition: '需於Richart Life APP切換至「Pay著刷」方案',
      rewards,
    });
  }

  // 其餘五大刷 + 假日刷：方案名 + 緊接百分比
  const simplePlans = [
    {
      id: 'daily',
      name: '天天刷',
      re: /天天刷\s*([\d.]+)\s*%/,
      rewards: (pct) => [
        { category: 'convenience', pct, merchants: ['全家', '7-ELEVEN'], note: '日常採買（兩大超商限台新Pay）' },
        { category: 'supermarket', pct, merchants: ['唐吉訶德'], note: '日常採買（萬家福、樂家康、大買家、唐吉訶德等）' },
        { category: 'transport', pct, merchants: ['台灣高鐵', 'Uber', '台灣大車隊'], note: '通勤交通（臺鐵/高鐵/計程車/Uber）' },
        { category: 'gas', pct, merchants: ['中油直營'], note: '加油充電（中油直營、全國加油、充電樁業者）' },
      ],
    },
    {
      id: 'department',
      name: '大筆刷',
      re: /大筆刷\s*([\d.]+)\s*%/,
      rewards: (pct) => [
        {
          category: 'department',
          pct,
          merchants: ['新光三越', '遠東百貨', '遠東SOGO', '台北101', 'IKEA', 'UNIQLO'],
          note: '指定百貨/Outlet/居家裝修/時尚品牌',
        },
      ],
    },
    {
      id: 'dining',
      name: '好饗刷',
      re: /好饗刷\s*([\d.]+)\s*%/,
      rewards: (pct) => [
        { category: 'dining', pct, note: '全臺餐飲（不含餐券）' },
        { category: 'delivery', pct, merchants: ['Uber Eats', 'foodpanda'], note: '外送平台' },
        { category: 'entertainment', pct, merchants: ['拓元售票', 'KKTIX', '錢櫃', '好樂迪'], note: '購票/指定KTV' },
        { category: 'travel', pct, merchants: ['晶華國際酒店集團', '老爺酒店集團'], note: '指定飯店（不含餐券/住宿券）' },
      ],
    },
    {
      id: 'digital',
      name: '數趣刷',
      re: /數趣刷\s*([\d.]+)\s*%/,
      rewards: (pct) => [
        { category: 'online', pct, merchants: ['蝦皮購物', 'momo購物網', 'PChome線上購物', '淘寶', 'Amazon'], note: '網購平台' },
        { category: 'streaming', pct, merchants: ['Netflix', 'Disney+', 'ChatGPT'], note: '遊戲影音/AI服務/線上課程' },
        { category: 'entertainment', pct, merchants: ['MyCard', 'Steam', 'PlayStation', 'Nintendo'], note: '遊戲平台' },
      ],
    },
    {
      id: 'travel',
      name: '玩旅刷',
      re: /玩旅刷\s*([\d.]+)\s*%/,
      rewards: (pct) => [
        { category: 'overseas', pct, note: '海外消費（含實體及線上、歐洲國家交易）' },
        {
          category: 'travel',
          pct,
          merchants: ['中華航空', '長榮航空', '星宇航空', 'Klook', 'KKday', 'Agoda', 'Booking.com', '雄獅旅遊', '易遊網'],
          note: '航空公司/訂房平台/旅行社',
        },
      ],
    },
    {
      id: 'holiday',
      name: '假日刷',
      re: /節假日不限通路\(含保費\)消費享([\d.]+)%/,
      rewards: (pct) => [{ category: 'general', pct, note: '限節假日消費，不限通路（含保費、LINE Pay及全盈+Pay綁定）' }],
    },
  ];
  for (const sp of simplePlans) {
    const m = text.match(sp.re);
    if (!m) continue;
    const pct = parseFloat(m[1]);
    plans.push({
      id: sp.id,
      name: sp.name,
      condition: sp.id === 'holiday' ? '免切換，節假日適用' : `需於Richart Life APP切換至「${sp.name}」方案`,
      rewards: sp.rewards(pct).map((r) => ({ ...r, note: `${POINT_NOTE_RICHART}；${r.note}；${noExpiry}` })),
    });
  }

  // 保費（免切換）
  const insurance = text.match(/保費\s*免切換免領券\s*最高([\d.]+)%/);
  if (insurance) {
    plans.push({
      id: 'insurance-base',
      name: '保費回饋（免切換）',
      condition: '免切換免領券，所有方案皆適用',
      rewards: [
        {
          category: 'insurance',
          pct: parseFloat(insurance[1]),
          note: `${POINT_NOTE_RICHART}；${noExpiry}`,
        },
      ],
    });
  }

  if (!plans.length) {
    console.error('taishin: Richart 權益頁抓不到任何方案回饋，跳過此卡');
    return null;
  }
  return { id: 'taishin-richart', name: cardName || '台新Richart卡', url: CARD_URL('cg047'), planKind: 'switchable', plans };
}

// ---------- 大全聯信用卡 ----------
async function scrapePxmart(page, cardName) {
  const links = await renderCardLinks(page, 'cg010');
  const link = links.find((l) => l.text.includes('新版權益') && l.href.includes('/future/'));
  if (!link) {
    console.error('taishin: cg010 頁面找不到「新版權益」活動連結，跳過大全聯卡');
    return null;
  }
  const html = await fetchHtml(link.href);
  const $ = cheerio.load(html);
  $('script,style').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const period = text.match(/適用期間：(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const validUntil = period ? isoFrom(period[4], period[5], period[6]) : undefined;
  const instore = text.match(/大全聯店內消費享每\s*100\s*元給最高\s*\d+\s*福利點\s*\(最高([\d.]+)%\)/);
  const qpay = text.match(/全支付消費[\s\S]{0,300}?每消費100元給\d+點\(最高([\d.]+)%\)/);
  const genAutopay = text.match(/每消費100元給8點\(最高([\d.]+)%\)/);
  const genNone = text.match(/每消費100元給3點\(最高([\d.]+)%\)/);
  const cap = text.match(/店外全支付消費及其他一般消費合計每期最高回饋福利點([\d,]+)點/);
  const capNote = cap ? `店外消費合計每期回饋上限${cap[1]}福利點（正附卡合併）` : undefined;

  function buildRewards(generalMatch, generalCond) {
    const rewards = [];
    if (instore) {
      const r = {
        category: 'supermarket',
        pct: parseFloat(instore[1]),
        merchants: ['大全聯'],
        note: `${POINT_NOTE_PX}；大全聯店內消費，回饋無上限，需綁定PX Pay會員`,
      };
      if (validUntil) r.validUntil = validUntil;
      rewards.push(r);
    }
    if (qpay) {
      const r = {
        category: 'mobilepay',
        pct: parseFloat(qpay[1]),
        note: `${POINT_NOTE_PX}；全支付店外消費（不含大全聯/全聯）`,
      };
      if (capNote) r.cap = capNote;
      if (validUntil) r.validUntil = validUntil;
      rewards.push(r);
    }
    if (generalMatch) {
      const r = {
        category: 'general',
        pct: parseFloat(generalMatch[1]),
        note: `${POINT_NOTE_PX}；其他一般消費（不含全支付、大全聯、全聯）；${generalCond}`,
      };
      if (capNote) r.cap = capNote;
      if (validUntil) r.validUntil = validUntil;
      rewards.push(r);
    }
    return rewards;
  }

  const plans = [];
  const autopayRewards = buildRewards(genAutopay, '有設定台新帳戶扣繳台新信用卡帳款');
  if (autopayRewards.length) {
    plans.push({
      id: 'autopay',
      name: '台新帳戶扣繳卡款',
      condition: '有設定台新帳戶扣繳台新信用卡帳款',
      rewards: autopayRewards,
    });
  }
  const defaultRewards = buildRewards(genNone, '未設定台新帳戶扣繳');
  if (defaultRewards.length) {
    plans.push({
      id: 'default',
      name: '一般（未設定扣繳）',
      condition: '未設定台新帳戶扣繳台新信用卡帳款',
      rewards: defaultRewards,
    });
  }

  if (!plans.length) {
    console.error('taishin: 大全聯活動頁抓不到任何回饋數字，跳過此卡');
    return null;
  }
  return { id: 'taishin-pxmart', name: cardName || '大全聯信用卡', url: CARD_URL('cg010'), planKind: 'tier', plans };
}

// ---------- 街口聯名卡 ----------
async function scrapeJko(page, cardName) {
  const links = await renderCardLinks(page, 'cg038');
  const link = links.find((l) => l.text.includes('回饋攻略') && !l.text.includes('已結束') && l.href.includes('/future/'));
  if (!link) {
    console.error('taishin: cg038 頁面找不到「回饋攻略」活動連結，跳過街口卡');
    return null;
  }
  const html = await fetchHtml(link.href);
  const $ = cheerio.load(html);
  $('script,style').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const period = text.match(/活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const validUntil = period ? isoFrom(period[4], period[5], period[6]) : undefined;
  const featured = text.match(/【精選通路\s*最高\s*([\d.]+)\s*%街口幣】/);
  const general = text.match(/【一般消費享\s*([\d.]+)\s*%街口幣\s*無上限】/);
  const bills = text.match(/街口APP繳費享基本\s*([\d.]+)\s*%回饋無上限/);
  const cap = text.match(/精選消費加碼合計\s*每月上限\$?([\d,]+)(?:元)?街口幣/);
  const capNote = cap ? `精選通路加碼合計每月上限${cap[1]}街口幣` : undefined;

  const rewards = [];
  if (general) {
    const r = { category: 'general', pct: parseFloat(general[1]), note: `${POINT_NOTE_JKO}；一般消費回饋無上限，不限交易形式` };
    if (validUntil) r.validUntil = validUntil;
    rewards.push(r);
  }
  if (featured) {
    const pct = parseFloat(featured[1]);
    const featuredGroups = [
      { category: 'travel', merchants: ['Klook', 'KKday', '易遊網', 'Agoda', 'Airbnb'], note: '精選旅遊通路' },
      { category: 'transport', merchants: ['台灣高鐵', 'Uber'], note: '精選交通通路（高鐵/Uber/叫車吧/停車）' },
      { category: 'department', merchants: ['新光三越', '遠東百貨', '遠東巨城', 'LaLaport'], note: '精選百貨通路' },
      { category: 'delivery', merchants: ['Uber Eats', 'foodpanda', 'Foodomo'], note: '精選外送通路' },
      { category: 'dining', merchants: ['EZTABLE', '85度C', '清心福全'], note: '精選美食通路' },
      { category: 'entertainment', merchants: ['威秀影城', '國賓影城', '錢櫃', '好樂迪'], note: '精選影城/KTV通路' },
    ];
    for (const g of featuredGroups) {
      const r = {
        category: g.category,
        pct,
        merchants: g.merchants,
        note: `${POINT_NOTE_JKO}；${g.note}，最高回饋（含一般消費1%＋精選加碼）`,
      };
      if (capNote) r.cap = capNote;
      if (validUntil) r.validUntil = validUntil;
      rewards.push(r);
    }
  }
  if (bills) {
    const r = {
      category: 'utilities',
      pct: parseFloat(bills[1]),
      note: '街口APP繳費（水電瓦斯/電信/稅費等）基本回饋無上限；當月繳費滿NT$1,000另有限量升級2%街口券',
    };
    if (validUntil) r.validUntil = validUntil;
    rewards.push(r);
  }

  if (!rewards.length) {
    console.error('taishin: 街口活動頁抓不到任何回饋數字，跳過此卡');
    return null;
  }
  return {
    id: 'taishin-jko',
    name: cardName || '街口聯名卡',
    url: CARD_URL('cg038'),
    plans: [{ id: 'default', name: '一般', condition: '無條件（部分通路限街口支付綁定始享最高回饋）', rewards }],
  };
}

async function scrape() {
  let cardIndex = {};
  try {
    cardIndex = await fetchCardIndex();
  } catch (e) {
    console.error('taishin: 總覽頁抓取失敗（' + e.message + '），卡名改用固定備援');
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const cards = [];
  try {
    const page = await browser.newPage({ userAgent: UA });
    const jobs = [
      [scrapeRichart, 'cg047'],
      [scrapePxmart, 'cg010'],
      [scrapeJko, 'cg038'],
    ];
    for (const [fn, cg] of jobs) {
      try {
        const card = await fn(page, cardIndex[cg]);
        if (card) cards.push(card);
      } catch (e) {
        console.error(`taishin: ${cg} 抓取失敗（${e.message}），跳過此卡`);
      }
      await sleep(600);
    }
  } finally {
    await browser.close();
  }
  return { id: 'taishin', name: '台新銀行', cards };
}

module.exports = { scrape };
