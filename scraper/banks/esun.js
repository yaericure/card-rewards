// 玉山銀行（esun）信用卡回饋爬蟲
//
// 來源 URL（2026-07-10 人工核對過結構，之後若改版需重新核對）：
//   - 玉山數位e卡：https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/e-card
//   - 玉山Unicard： https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/unicard
//   - 玉山鈦金卡：  https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/titanium-card
//   - 玉山Pi拍錢包信用卡：https://www.esunbank.com/zh-tw/personal/credit-card/intro/co-branded-card/pi-card
//   - 玉山U Bear信用卡： https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/u-bear
//
// 解析假設：
//   - 這五頁都是「靜態伺服器渲染」頁面（fetch 拿到的 HTML 已含完整行銷文案），不需要 playwright。
//   - 玉山把回饋率直接寫在文案句子裡（例：「國內外一般消費享0.5%玉山e point回饋」），
//     所以用「固定中文短語 + 緊接的百分比」的 regex 去抓，比硬 parse DOM 結構穩定
//     （這幾頁的 class name 明顯是行銷團隊手刻、經常換）。
//   - 玉山e point / Pi拍錢包P幣 / U Bear現金回饋皆為官網文案已講清楚等值百分比的點數/現金制，
//     不需要額外換算，只在 note 註明點數型態（1點=1元）。
//   - Unicard 頁面清楚列出「僅帳單e化」vs「帳單e化＋自動扣繳」兩種一般消費回饋率（0.3% vs 1%），
//     這是 SCHEMA 要求的「方案／等級差異」範例；另有百大指定消費三方案（簡單選/任意選/UP選），
//     這裡只取加碼最高的 UP選 併入「帳單e化＋自動扣繳」方案的 rewards，並在 note 說明。
//     Unicard 的兩個方案是「持卡人可自行申辦切換」的門檻差異（非資格分級），card.planKind 標 switchable。
//   - Pi拍錢包信用卡／U Bear信用卡皆只有單一常態方案（回饋率隨帳單e化/自動扣繳/消費滿額而變動，
//     屬同一方案內的條件差異，非可切換的多方案／多等級），故不需 card.planKind，比照鈦金卡模式
//     用單一 plan、把條件寫進 note。頁面上另有「新戶限定」加碼活動（僅新戶、時限申辦期間），
//     不確定所有使用者都適用，故不納入 rewards，只在模組註解記錄、不寫入資料。
//   - 若改版後抓不到某張卡的任何 reward，該卡會被跳過（不寫入空卡），並把原因印到 stderr，
//     由 run.js 的 schema 驗證負責在完全抓不到時讓這個模組失敗。

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/util');

const URLS = {
  ecard: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/e-card',
  unicard: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/unicard',
  titanium: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/titanium-card',
  picard: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/co-branded-card/pi-card',
  ubear: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/u-bear',
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

  return { id: 'esun-unicard', name: '玉山Unicard', url: URLS.unicard, planKind: 'switchable', plans };
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

// ---------- Pi拍錢包信用卡 ----------
// 官網把「基本回饋」「保費」「全家便利商店加碼」分成三個獨立區塊各自標活動期間，
// 用 near() 局部搜尋（從各標題往後取一段文字）避免抓到其他區塊/新戶限定活動的相似句型。
function near(text, markerIndex, pattern, span = 400) {
  if (markerIndex < 0) return null;
  const window = text.slice(markerIndex, markerIndex + span);
  const m = window.match(pattern);
  return m || null;
}

function isoSlash(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function scrapePiCard() {
  const text = textOf(await fetchHtml(URLS.picard));
  const rewards = [];

  const baseIdx = text.indexOf('基本回饋 1%P幣無上限');
  const base = near(text, baseIdx, /基本回饋 ?(\d+(?:\.\d+)?)%P幣無上限 ?\(需申請帳單e化，未申辦帳單e化者享(\d+(?:\.\d+)?)% P幣回饋無上限/);
  const basePeriod = near(
    text,
    text.indexOf('消費最高享'),
    /消費最高享 ?[\d.]+% P幣 活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/
  );
  const tier1 = near(
    text,
    text.indexOf('每月國內外一般消費累積滿10'),
    /每月國內外一般消費累積滿[\d,]+~[\d,]+元 ?加碼(\d+(?:\.\d+)?)%P幣，? ?最高(\d+(?:\.\d+)?)% P幣/
  );
  const tier2 = near(
    text,
    text.indexOf('每月國內外一般消費累積滿30'),
    /每月國內外一般消費累積滿[\d,]+元\(含\)以上 ?加碼(\d+(?:\.\d+)?)%P幣，? ?最高(\d+(?:\.\d+)?)% P幣 ?\(每月每歸戶上限([\d,]+) ?P幣\)/
  );

  if (base && basePeriod) {
    const validUntil = isoSlash(basePeriod[4], basePeriod[5], basePeriod[6]);
    let note = `玉山Pi拍錢包P幣回饋（1 P幣=1元）；需申請帳單e化，未申辦帳單e化者僅${base[2]}%`;
    if (tier1 && tier2) {
      note += `；每月國內外一般消費累積滿NT$10,000~29,999加碼至最高${tier1[2]}%，滿NT$30,000(含)以上加碼至最高${tier2[2]}%（每月每歸戶上限${tier2[3]}P幣，需登錄活動）`;
    }
    rewards.push({ category: 'general', pct: parseFloat(base[1]), validUntil, note });
  } else {
    console.error('esun: pi-card 頁面抓不到基本回饋數字，略過一般消費 reward');
  }

  const insIdx = text.indexOf('保費享');
  const insurance = near(
    text,
    insIdx,
    /保費享 ?(\d+(?:\.\d+)?)% P幣無上限 或12期0利率 活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/
  );
  if (insurance) {
    rewards.push({
      category: 'insurance',
      pct: parseFloat(insurance[1]),
      validUntil: isoSlash(insurance[5], insurance[6], insurance[7]),
      note: '玉山Pi拍錢包P幣回饋（1 P幣=1元）；保費一次付清享回饋無上限；或單筆滿NT$6,000登錄6期0利率、滿NT$15,000登錄12期0利率（不含躉繳保費）',
    });
  } else {
    console.error('esun: pi-card 頁面抓不到保費回饋數字，略過保費 reward');
  }

  const famIdx = text.indexOf('全家便利商店 最高享');
  const family = near(
    text,
    famIdx,
    /全家便利商店 最高享(\d+(?:\.\d+)?)% P幣 活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/
  );
  const famCap = near(text, famIdx, /每月每卡上限(\d+) ?P幣/, 600);
  if (family) {
    rewards.push({
      category: 'convenience',
      pct: parseFloat(family[1]),
      merchants: ['全家'],
      cap: famCap ? `每月每卡上限${famCap[1]} P幣` : undefined,
      validUntil: isoSlash(family[5], family[6], family[7]),
      note: '玉山Pi拍錢包P幣回饋（1 P幣=1元）；限綁定Pi拍錢包APP於全家便利商店消費',
    });
  } else {
    console.error('esun: pi-card 頁面抓不到全家便利商店回饋數字，略過此 reward');
  }

  if (!rewards.length) {
    console.error('esun: pi-card 頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }
  return {
    id: 'esun-pi',
    name: '玉山Pi拍錢包信用卡',
    url: URLS.picard,
    plans: [{ id: 'default', name: '一般', condition: '需註冊並綁定Pi拍錢包APP，申請玉山信用卡帳單e化始享P幣回饋', rewards }],
  };
}

// ---------- U Bear信用卡 ----------
async function scrapeUBear() {
  const text = textOf(await fetchHtml(URLS.ubear));
  const rewards = [];

  const baseIdx = text.indexOf('熊任務 基本回饋');
  const basePct = near(text, baseIdx, /國內外一般消費最高享 ?(\d+(?:\.\d+)?)%現金回饋/);
  const baseCond = near(text, baseIdx, /需\s*綁定帳單e化\s*或\s*申辦玉山銀行臺幣帳戶自動扣繳\s*享(\d+(?:\.\d+)?)%現金回饋，申辦上述兩者享(\d+(?:\.\d+)?)%現金回饋/);
  const basePeriod = near(text, baseIdx, /活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (basePct && baseCond && basePeriod) {
    rewards.push({
      category: 'general',
      pct: parseFloat(basePct[1]),
      validUntil: isoSlash(basePeriod[4], basePeriod[5], basePeriod[6]),
      note: `現金回饋，回饋無上限，於當期帳單直接折抵；需綁定帳單e化或申辦玉山銀行臺幣帳戶自動扣繳享${baseCond[1]}%，兩者皆辦享${baseCond[2]}%`,
    });
  } else {
    console.error('esun: u-bear 頁面抓不到基本回饋數字，略過一般消費 reward');
  }

  const onlineIdx = text.indexOf('熊好刷');
  const onlinePct = near(text, onlineIdx, /網路消費最高享 ?(\d+(?:\.\d+)?)%現金回饋/);
  const onlineCap = near(text, onlineIdx, /每期回饋上限(\d+)元，於當期帳單直接折抵/, 600);
  const onlinePeriod = near(text, onlineIdx, /活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (onlinePct && onlinePeriod) {
    rewards.push({
      category: 'online',
      pct: parseFloat(onlinePct[1]),
      cap: onlineCap ? `每期回饋上限NT$${onlineCap[1]}` : undefined,
      validUntil: isoSlash(onlinePeriod[4], onlinePeriod[5], onlinePeriod[6]),
      note: '現金回饋；已含基本回饋1%＋網路消費加碼2%（加碼2%需綁定帳單e化），於當期帳單直接折抵',
    });
  } else {
    console.error('esun: u-bear 頁面抓不到網路消費回饋數字，略過此 reward');
  }

  const streamIdx = text.indexOf('熊潮流');
  const streamPct = near(text, streamIdx, /指定數位訂閱平台消費最高享 ?(\d+(?:\.\d+)?)%現金回饋/);
  const streamCap = near(text, streamIdx, /每期回饋上限(\d+)元，於當期帳單直接折抵/, 400);
  const streamPeriod = near(text, streamIdx, /活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (streamPct && streamPeriod) {
    rewards.push({
      category: 'streaming',
      pct: parseFloat(streamPct[1]),
      merchants: ['Netflix', 'ChatGPT', 'Gemini', 'Steam', 'Nintendo', 'PlayStation'],
      cap: streamCap ? `每期回饋上限NT$${streamCap[1]}（正附卡合併計算）` : undefined,
      validUntil: isoSlash(streamPeriod[4], streamPeriod[5], streamPeriod[6]),
      note: '現金回饋；指定數位訂閱平台，於當期帳單直接折抵',
    });
  } else {
    console.error('esun: u-bear 頁面抓不到指定數位訂閱平台回饋數字，略過此 reward');
  }

  if (!rewards.length) {
    console.error('esun: u-bear 頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }
  return {
    id: 'esun-ubear',
    name: '玉山U Bear信用卡',
    url: URLS.ubear,
    plans: [{ id: 'default', name: '一般', condition: '無條件（部分回饋需綁定帳單e化或申辦自動扣繳始達最高比率）', rewards }],
  };
}

async function scrape() {
  const results = await Promise.all([scrapeECard(), scrapeUnicard(), scrapeTitanium(), scrapePiCard(), scrapeUBear()]);
  const cards = results.filter(Boolean);
  return { id: 'esun', name: '玉山銀行', cards };
}

module.exports = { scrape };
