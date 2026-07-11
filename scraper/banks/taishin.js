// 台新銀行（taishin）信用卡回饋爬蟲 — v3 改版（扁平 rewards：見 ../../data/SCHEMA.md）
//
// v3 改版重點（相對 v2 的差異）：
//   v2 用 category 大類 + merchants[] 陣列（一個 reward 可含多家店）。
//   v3 規則：一筆 reward 只對應一家商店，官方清單列 N 家就拆成 N 筆；
//   等級（tiers，用戶帳戶狀態）與方案（plan，用戶自選商店組合）分離：
//   tiers 寫在 card.tiers + reward.pctByTier，plan 寫在 reward.plan（字串）。
//   類別廢除只留 dining；國外消費併入 country（地名）。
//
// 只收 SCHEMA 指定的 3 張卡、指定 URL（可跟一層內部連結/PDF）：
//   taishin-richart（cg047）／taishin-jko（cg038）／taishin-pxmart（cg010）
//
// 解析假設（2026-07-11 實測，若改版需重新核對）：
//   - Richart 卡的入口 URL（cg047/card001/）連到「Richart卡權益介紹」（tsbk.tw 短網址
//     導向 mkp.taishinbank.com.tw 的單頁滾動式版面，playwright 渲染）。權益方案本身在
//     頁面預設可見；但「卡友身分升級」LEVEL1/LEVEL2 的精確%對照表要點擊「身分升級」
//     分頁再點「升級詳情」彈窗才會渲染出來，故用 playwright 點擊兩次分頁/連結後
//     一次性 innerText('body') 取得完整內容。
//   - 2026/7/11 實測：LEVEL1（僅核卡未設定台新帳戶扣繳）固定為 1.3%，不論方案；
//     LEVEL2（已設定台新帳戶扣繳）才享頁面上列出的各方案完整%數。故本模組把
//     LEVEL1 寫死為 1.3（來源：升級詳情彈窗之對照表），LEVEL2 的%從各方案文字動態解析。
//     保費(1.3%)與一般消費(0.3%)不受身分限制，兩者皆為固定 pct、無 tiers、無 plan。
//   - Chill刷為期間限定活動（本次為 2026/7/8~2026/9/30），其餘方案
//     （Pay著刷/天天刷/大筆刷/好饗刷/數趣刷/玩旅刷/假日刷/保費/一般消費）為常態方案，
//     頁面未標活動迄日 → 不填 validUntil。
//   - 好饗刷【指定飯店】正文精簡列表不完整，改用頁尾注意事項「＊【好饗刷...指定飯店
//     適用品牌】」段落的完整品牌清單。
//   - Pay著刷依付款工具給回饋 → targetType=mobilepay、target=canonical 支付名，4 筆：
//     台新Pay/台新Pay+ 各 3.8%、LINE Pay/全盈+PAY 各 2.3%（LEVEL2；LEVEL1 一律 1.3%）。
//     台新Pay 可用商店（場域）清單放 data/mobilepay.json，不在 cards.json 建商店型 reward。
//   - 玩旅刷【海外消費】＝國外消費不分國家 → targetType=country、target=「海外」。
//   - 假日刷為「節假日不限通路」的方案：plan=假日刷＋targetType=general（SCHEMA「不限
//     通路的方案」組合），前端照方案名顯示、note 標明限節假日。
//   - 大全聯信用卡／街口聯名卡的活動頁是靜態伺服器渲染 → fetch 即可。
//   - 大全聯：tiers＝發卡組織（jcb/other，見 scrapePxmart 前註解）；台新帳戶扣繳維度
//     依 assumedAchieved 折入數值。全支付店外 1.5% 不受扣繳/組織影響。
//   - 街口聯名卡無 tiers、無 plan（精選通路所有商店同時生效，非用戶可選方案）。
//   - 點數換算（皆為頁面原文所載）：台新Point(信用卡)官網直接以 % 表述；
//     大全聯福利點「10點=NT$1」；街口幣「1元街口幣=新臺幣1元」。均在 note 註明點數型態。
//
// 依 SCHEMA 核心原則 9 排除的「新卡/新戶/需登錄/限量」型活動（2026-07-11 掃描，不收錄）：
//   - Richart：新申辦限定 LEVEL2 試用（核卡60天內）、保費新戶最高8%（領券）、
//     LINE Pay領券最高3.8%（需綁台新官方LINE領券）、童玩券最高11%（領券）、
//     北捷券最高50點（領券）、一般消費達檻機車停車/機場接送（滿額贈非%回饋）。
//   - 大全聯：週末卡友日滿額贈NT$100抵用券（贈券型；官方「最高12%」標語中的5%即此）、
//     全聯卡友日滿額贈（2026/6/26-8/6限期滿額贈點）、天天卡友日滿額贈抵用券、
//     生日禮、JCB禮遇（外部組織網頁＋限量）。
//   - 街口：街口APP繳費滿額升級2%（需手動領券、每月限量55,000名先領先贏）、
//     新戶消費最高13.5%（已結束/新戶限定）、推薦好友辦卡、街口鈦金商務卡/晶緻卡
//     Mastercard/JCB獨享優惠（限量預約/登錄型，且細節在外部組織網頁、超出一層）。

const cheerio = require('cheerio');
const { fetchHtml, sleep, UA } = require('../lib/util');

// SCHEMA.md 收錄卡清單指定的入口 URL 含尾段 card001/（卡片頁），輸出與導覽皆用此完整 URL
const CARD_URL = (cg) => `https://www.taishinbank.com.tw/TSB/personal/credit/intro/overview/${cg}/card001/`;

const POINT_NOTE_RICHART = '台新Point(信用卡)點數回饋';
const POINT_NOTE_PX = '福利點點數回饋（福利點10點=NT$1，可折抵全聯/大全聯店內消費）';
const POINT_NOTE_JKO = '街口幣回饋（1元街口幣=新臺幣1元）';

function isoFrom(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------- 共用文字解析工具 ----------
function toLines(text) {
  return text.split('\n').map((s) => s.trim());
}
// 依單一分隔字元拆商店清單，但不拆括號內的內容（半形/全形括號皆支援）。
function splitOutsideParens(str, delimiter) {
  if (!str) return [];
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(' || ch === '（') depth++;
    if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
function splitPipeComma(str) {
  return splitOutsideParens(str, '｜').flatMap((seg) => splitOutsideParens(seg, '、'));
}
function splitSlash(str) {
  return splitOutsideParens(str, '/');
}

// 從總覽頁靜態 HTML 抓 cg編號 → 卡名
async function fetchCardIndex() {
  const html = await fetchHtml('https://www.taishinbank.com.tw/TSB/personal/credit/');
  const map = {};
  const re =
    /href="\/TSB\/personal\/credit\/intro\/overview\/(cg\d+)\/\?from=index"[^>]*class="pic"[\s\S]{0,2000}?<div class="title">\s*<p>([\s\S]*?)<\/p>/g;
  for (const m of html.matchAll(re)) {
    const name = m[2].replace(/<[^>]+>/g, '').trim();
    if (name && !map[m[1]]) map[m[1]] = name;
  }
  return map;
}

async function renderCardLinks(page, cg) {
  await page.goto(CARD_URL(cg), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  return page.$$eval('a', (as) => as.map((a) => ({ href: a.href, text: a.innerText.trim() })));
}

// ---------- Richart 卡 ----------
const RICHART_TIER_AUTOPAY = 'autopay';
const RICHART_TIER_NONE = 'none';
const LEVEL1_PCT = 1.3; // 未設定扣繳（LEVEL1），所有方案型 reward 一律 1.3%（來源：升級詳情對照表）

async function scrapeRichart(page, cardName) {
  const links = await renderCardLinks(page, 'cg047');
  const rightsLink = links.find((l) => l.text.includes('Richart卡權益介紹'));
  if (!rightsLink) {
    console.error('taishin: cg047 頁面找不到「Richart卡權益介紹」連結，跳過 Richart 卡');
    return null;
  }
  await page.goto(rightsLink.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  // 點「身分升級」分頁 + 「升級詳情」彈窗，一次性取得完整內容（含 LEVEL1/LEVEL2 對照表）
  try {
    await page.locator('text=身分升級').first().click({ timeout: 5000 });
    await page.waitForTimeout(1200);
    await page.locator('text=升級詳情').first().click({ timeout: 5000 });
    await page.waitForTimeout(1200);
  } catch (e) {
    console.error(`taishin: Richart 權益頁分頁切換失敗（${e.message}），改用預設分頁內容`);
  }
  const rawText = await page.innerText('body');
  const rightsUrl = page.url();
  const L = toLines(rawText);
  const flat = rawText.replace(/\s+/g, ' ');

  const rewards = [];
  // 頁面在正文之前有一段「權益一覽表」摘要區塊，會重複出現 Chill刷/Pay著刷/天天刷/…
  // 等 label（但格式與詳細段落不同，無法用同一套 pct+商店解析）。以「瘋聚會」（僅在
  // 詳細段落出現一次）之後的位置為搜尋起點，避免誤抓摘要區塊。
  const SEARCH_FROM = L.indexOf('瘋聚會');

  function pushMerchants(plan, merchants, autopayPct, opts = {}) {
    for (const m of merchants) {
      if (!m) continue;
      const r = {
        plan,
        target: m,
        targetType: 'merchant',
        pctByTier: { [RICHART_TIER_AUTOPAY]: autopayPct, [RICHART_TIER_NONE]: LEVEL1_PCT },
      };
      if (opts.validFrom) r.validFrom = opts.validFrom;
      if (opts.validUntil) r.validUntil = opts.validUntil;
      if (opts.cap) r.cap = opts.cap;
      r.note = `${POINT_NOTE_RICHART}；${opts.note || `${plan}方案`}（來源：${rightsUrl}）`;
      rewards.push(r);
    }
  }

  // --- Chill刷（期間限定）：瘋聚會／沉浸娛樂／獨自升級，共 9 個子方案 ---
  const chillPeriod = flat.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*-\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*快樂上市/);
  if (chillPeriod) {
    const validFrom = isoFrom(chillPeriod[1], chillPeriod[2], chillPeriod[3]);
    const validUntil = isoFrom(chillPeriod[4], chillPeriod[5], chillPeriod[6]);
    const startIdx = SEARCH_FROM;
    const endIdx = L.indexOf('Pay著刷', SEARCH_FROM);
    for (let i = startIdx; i >= 0 && i < endIdx; i++) {
      const m = L[i] && L[i].match(/^【(.+?)】([\d.]+)%$/);
      if (!m) continue;
      const subLabel = m[1];
      const pct = parseFloat(m[2]);
      const merchants = splitSlash(L[i + 1]);
      if (!merchants.length) continue;
      pushMerchants('Chill刷', merchants, pct, {
        validFrom,
        validUntil,
        note: `Chill刷【${subLabel}】期間限定加碼`,
      });
    }
  } else {
    console.error('taishin: Richart 權益頁找不到 Chill刷活動期間，跳過 Chill刷方案');
  }

  // --- Pay著刷（行動支付綁定 → targetType=mobilepay，target 用 SCHEMA canonical 支付名）---
  // 細則原文（2026-07-11 核對）：「台新Pay 及 台新Pay+ 綁定支付享 3.8%」
  //                          「LINE Pay 及 全盈+Pay(7/8起新增)綁定支付享 2.3%」
  // 台新Pay 場域清單（範例商店＋官網合作通路頁）放在 data/mobilepay.json，不在此建商店型 reward。
  const tsPay = flat.match(/台新Pay\s*及\s*台新Pay\+\s*綁定支付享\s*([\d.]+)\s*%/);
  const linePay = flat.match(/LINE Pay\s*及\s*全盈\+Pay[^綁]*綁定支付享\s*([\d.]+)\s*%/);
  if (tsPay) {
    for (const payName of ['台新Pay', '台新Pay+']) {
      rewards.push({
        plan: 'Pay著刷',
        target: payName,
        targetType: 'mobilepay',
        pctByTier: { [RICHART_TIER_AUTOPAY]: parseFloat(tsPay[1]), [RICHART_TIER_NONE]: LEVEL1_PCT },
        note: `${POINT_NOTE_RICHART}；${payName}綁定支付；細則原文「台新Pay 及 台新Pay+ 綁定支付享 ${tsPay[1]}%」；可用商店見 data/mobilepay.json 場域清單（來源：${rightsUrl}）`,
      });
    }
  }
  if (linePay) {
    for (const payName of ['LINE Pay', '全盈+PAY']) {
      rewards.push({
        plan: 'Pay著刷',
        target: payName,
        targetType: 'mobilepay',
        pctByTier: { [RICHART_TIER_AUTOPAY]: parseFloat(linePay[1]), [RICHART_TIER_NONE]: LEVEL1_PCT },
        note: `${POINT_NOTE_RICHART}；${payName}綁定支付；細則原文「LINE Pay 及 全盈+Pay(7/8起新增)綁定支付享 ${linePay[1]}%」；限交易地為臺灣且交易幣別為新臺幣（來源：${rightsUrl}）`,
      });
    }
  }

  // --- 天天刷／大筆刷／好饗刷／數趣刷／玩旅刷（label + 緊接一行商店清單，重複 N 組） ---
  const TOP_LABELS = ['天天刷', '大筆刷', '好饗刷', '數趣刷', '玩旅刷', '假日刷'];
  function readPct3Lines(label) {
    const idx = L.indexOf(label, SEARCH_FROM);
    if (idx < 0 || L[idx + 2] !== '%') return null;
    return { idx, pct: parseFloat(L[idx + 1]) };
  }
  function collectSubPairs(startIdx) {
    const subs = [];
    let i = startIdx;
    while (i < L.length && L[i] && !TOP_LABELS.includes(L[i]) && L[i] !== '保費') {
      const subLabel = L[i];
      const merchants = splitPipeComma(L[i + 1]);
      subs.push({ subLabel, merchants });
      i += 2;
    }
    return subs;
  }

  // 天天刷
  const daily = readPct3Lines('天天刷');
  if (daily) {
    const subs = collectSubPairs(daily.idx + 3);
    for (const s of subs) {
      if (s.subLabel === '日常採買') {
        const combo = '全家及7-11(兩大超商限台新Pay)';
        const rest = s.merchants.filter((m) => m !== combo);
        if (s.merchants.includes(combo)) {
          pushMerchants('天天刷', ['全家', '7-11'], daily.pct, {
            note: '天天刷【日常採買】兩大超商，限台新Pay綁定支付',
          });
        }
        pushMerchants('天天刷', rest, daily.pct, { note: '天天刷【日常採買】量販/超市/生活雜貨' });
      } else if (['通勤交通', '加油充電', '藥妝藥局'].includes(s.subLabel)) {
        pushMerchants('天天刷', s.merchants, daily.pct, { note: `天天刷【${s.subLabel}】` });
      }
    }
  }

  // 大筆刷
  const dept = readPct3Lines('大筆刷');
  if (dept) {
    const subs = collectSubPairs(dept.idx + 3);
    for (const s of subs) {
      pushMerchants('大筆刷', s.merchants, dept.pct, { note: `大筆刷【${s.subLabel}】` });
    }
  }

  // 好饗刷
  const dining = readPct3Lines('好饗刷');
  if (dining) {
    const subs = collectSubPairs(dining.idx + 3);
    for (const s of subs) {
      if (s.subLabel === '全臺餐飲') {
        // 「全臺餐飲(不含餐券)」代表全類餐飲（非單一商店）→ dining；「王品瘋Pay」為指定商店
        rewards.push({
          plan: '好饗刷',
          targetType: 'dining',
          pctByTier: { [RICHART_TIER_AUTOPAY]: dining.pct, [RICHART_TIER_NONE]: LEVEL1_PCT },
          note: `${POINT_NOTE_RICHART}；好饗刷【全臺餐飲】不含餐券，限交易地為臺灣且收單行業類別為餐廳之交易（來源：${rightsUrl}）`,
        });
        pushMerchants('好饗刷', s.merchants.filter((m) => m !== '全臺餐飲(不含餐券)'), dining.pct, {
          note: '好饗刷【全臺餐飲】加碼',
        });
      } else if (s.subLabel === '外送平台' || s.subLabel === '購票娛樂' || s.subLabel === '指定KTV') {
        pushMerchants('好饗刷', s.merchants, dining.pct, { note: `好饗刷【${s.subLabel}】` });
      }
    }
    // 指定飯店：正文精簡列表不完整，改用頁尾注意事項的完整品牌清單
    const hotelNote = flat.match(/＊【好饗刷[\d.]*%｜指定飯店適用品牌】\s*([^＊。]+)。/);
    if (hotelNote) {
      const hotels = splitOutsideParens(hotelNote[1].replace(/。\s*/g, ''), '、');
      pushMerchants('好饗刷', hotels, dining.pct, {
        note: '好饗刷【指定飯店】不含餐券/住宿券等票券（頁尾注意事項之品牌全清單）',
      });
    }
  }

  // 數趣刷
  const digital = readPct3Lines('數趣刷');
  if (digital) {
    const subs = collectSubPairs(digital.idx + 3);
    for (const s of subs) {
      if (s.subLabel === '網購平台') {
        pushMerchants('數趣刷', s.merchants, digital.pct, { note: '數趣刷【網購平台】' });
      }
    }
    const streamMerchants = subs
      .filter((s) => ['線上課程', '遊戲影音', 'AI服務'].includes(s.subLabel))
      .flatMap((s) => s.merchants.map((m) => ({ m, sub: s.subLabel })));
    for (const { m, sub } of streamMerchants) {
      pushMerchants('數趣刷', [m], digital.pct, { note: `數趣刷【${sub}】` });
    }
  }

  // 玩旅刷（第一行是「海外消費」敘述、非 label+清單配對；其後才是航空公司/海外交通網路/訂房平台/旅行社）
  // 細則原文「海外消費(含實體及線上、歐洲國家交易)」＝國外消費不分國家 → targetType=country、
  // target=「海外」（SCHEMA 規則）。不可記成 general（否則任何國內商店查詢都會誤中玩旅刷）。
  const travel = readPct3Lines('玩旅刷');
  if (travel) {
    rewards.push({
      plan: '玩旅刷',
      target: '海外',
      targetType: 'country',
      pctByTier: { [RICHART_TIER_AUTOPAY]: travel.pct, [RICHART_TIER_NONE]: LEVEL1_PCT },
      note: `${POINT_NOTE_RICHART}；玩旅刷【海外消費】含實體及線上、歐洲國家交易（海外＝交易幣別為外幣或交易國別非臺灣），不限指定商店（來源：${rightsUrl}）`,
    });
    const subs = collectSubPairs(travel.idx + 4); // idx+3 是「海外消費(...)」單行敘述，故從 +4 開始配對
    for (const s of subs) {
      pushMerchants('玩旅刷', s.merchants, travel.pct, { note: `玩旅刷【${s.subLabel}】` });
    }
  }

  // 假日刷：細則為「節假日不限通路消費享2%」＝不限通路的方案型一般回饋。
  // 使用者拍板（2026-07-11）：plan+general 表「不限通路方案」，前端照方案名顯示並標明限節假日。
  const holiday = readPct3Lines('假日刷');
  if (holiday) {
    rewards.push({
      plan: '假日刷',
      targetType: 'general',
      pctByTier: { [RICHART_TIER_AUTOPAY]: holiday.pct, [RICHART_TIER_NONE]: LEVEL1_PCT },
      note: `${POINT_NOTE_RICHART}；限國內節假日消費，不限通路（含保費、LINE Pay及全盈+Pay綁定）`,
    });
  }

  // 保費（免切換免領券，不受卡友身分限制）
  const insurance = flat.match(/保費\s*免切換免領券\s*最高([\d.]+)%/);
  if (insurance) {
    rewards.push({
      targetType: 'general',
      pct: parseFloat(insurance[1]),
      note: `${POINT_NOTE_RICHART}；保費一次付清，免切換免領券，不受卡友身分限制皆享回饋；不含國外保險/躉繳保費/投資型保費等`,
    });
  }

  // 一般消費（不受卡友身分限制）
  rewards.push({
    targetType: 'general',
    pct: 0.3,
    note: `${POINT_NOTE_RICHART}；一般消費回饋無上限，不受卡友身分限制皆享回饋`,
  });

  if (rewards.length < 5) {
    console.error('taishin: Richart 權益頁抓到的 reward 數量過少，跳過此卡');
    return null;
  }
  return {
    id: 'taishin-richart',
    name: cardName || '台新Richart卡',
    url: CARD_URL('cg047'),
    tiers: [
      { id: RICHART_TIER_AUTOPAY, name: '已設定台新帳戶扣繳', condition: '成功設定以台新帳戶（活期儲蓄存款或Richart數位存款帳戶）自動扣繳台新信用卡帳款，於完成設定之次期帳單結帳後生效（LEVEL2）', assumedAchieved: true },
      { id: RICHART_TIER_NONE, name: '未設定扣繳（僅核卡）', condition: '核卡消費即享，未設定台新帳戶自動扣繳（LEVEL1）' },
    ],
    rewards,
  };
}

// ---------- 大全聯信用卡 ----------
// 發卡組織資格（SCHEMA 核心原則 10，使用者實例即本卡）：JCB 版另有「週年大回饋」加碼
// （2026-07-11 查證，cg010 頁連出之活動頁）——大全聯店內：基本1.2%＋週年加碼1.8%（單筆滿
// 1,000元）＋全支付加碼4%（綁定全支付且單筆滿1,000元）＝最高 7%（頁面明示「天天 最高7%
// 回饋」，2026/7/1-12/31，原文「不限新舊戶」、無需登錄）。標語「最高12%」的另 5% 是週末
// 卡友日「滿額贈NT$100抵用券」（週六日全支付自助結帳單筆滿2,000）＝贈券型滿額贈，依核心
// 原則 9 不收，故 JCB 記 7% 並在 note 說明組成與條件。Visa/MasterCard 等其他組織無此加碼
// ＝1.2%。原「台新帳戶扣繳」維度依 assumedAchieved 假設折入數值（其他一般消費記已扣繳的
// 0.8%，未扣繳 0.3% 寫進 note）。
const PX_TIER_JCB = 'jcb';
const PX_TIER_OTHER = 'other';

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
  const capMatch = text.match(/店外全支付消費及其他一般消費合計每期最高回饋福利點([\d,]+)點/);
  const capNote = capMatch ? `店外消費（全支付＋其他一般消費）合計每期回饋上限福利點${capMatch[1]}點（正附卡合併）` : undefined;
  const outStoreSection = text.slice(text.indexOf('店外消費享每'));
  const outStoreValues = [...outStoreSection.matchAll(/每消費100元給\d+點\(最高([\d.]+)%\)/g)].map((m) => parseFloat(m[1]));
  const [qpayPct, autopayPct, defaultPct] = outStoreValues;

  // JCB 週年大回饋活動頁（cg010 頁連出、一層內）：解析 JCB 版大全聯店內加碼後的實際總%
  let jcb = null; // { pct, validUntil, note }
  const jcbLink = links.find((l) => /JCB卡最高[\d.]+%/.test(l.text) && l.href.includes('/future/'));
  if (jcbLink) {
    try {
      const jcbHtml = await fetchHtml(jcbLink.href);
      const $j = cheerio.load(jcbHtml);
      $j('script,style').remove();
      const jt = $j('body').text().replace(/\s+/g, ' ').trim();
      const total = jt.match(/天天 最高([\d.]+)%回饋\(適用消費期間(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{4})\/(\d{1,2})\/(\d{1,2})\)/);
      const anniv = jt.match(/單筆滿([\d,]+)元 每消費100元給\d+點 \(最高([\d.]+)%\)/);
      const qpayBonus = jt.match(/綁定全支付消費 單筆滿([\d,]+)元 享每消費100元 ?\d+點 \(最高([\d.]+)%\)/);
      if (total && anniv && qpayBonus) {
        jcb = {
          pct: parseFloat(total[1]),
          validUntil: isoFrom(total[5], total[6], total[7]),
          note:
            `JCB版週年加碼：基本1.2%＋週年加碼${anniv[2]}%（單筆滿${anniv[1]}元，每月上限1千福利點）` +
            `＋全支付加碼${qpayBonus[2]}%（綁定全支付且單筆滿${qpayBonus[1]}元，每月上限3千福利點）＝最高${total[1]}%，` +
            `不限新舊戶、無需登錄；未滿額/未用全支付時遞減；官方標語12%另含週末卡友日滿額贈抵用券（贈券型，不列入%）；來源：${jcbLink.href}`,
        };
      } else {
        console.error('taishin: 大全聯JCB週年活動頁結構已變，解析不到加碼數字，本次輸出不含 JCB 差異');
      }
    } catch (e) {
      console.error(`taishin: 大全聯JCB週年活動頁抓取失敗（${e.message}），本次輸出不含 JCB 差異`);
    }
  } else {
    console.error('taishin: cg010 頁面找不到 JCB 週年活動連結，本次輸出不含 JCB 差異');
  }

  const rewards = [];
  if (instore) {
    const basePct = parseFloat(instore[1]);
    const r = {
      target: '大全聯',
      targetType: 'merchant',
      validUntil,
      note: `${POINT_NOTE_PX}；大全聯量販賣場內消費（含實體卡/全支付/PX Pay/台新Pay綁定），基本回饋無上限，不受扣繳身分影響，需綁定PX Pay會員；來源：${link.href}`,
    };
    if (jcb) {
      r.pctByTier = { [PX_TIER_JCB]: jcb.pct, [PX_TIER_OTHER]: basePct };
      r.note += `；${jcb.note}`;
      if (jcb.validUntil) r.validUntil = jcb.validUntil;
    } else {
      r.pct = basePct;
    }
    rewards.push(r);
  }
  if (qpayPct !== undefined) {
    // 回饋對象是「全支付」這個支付工具（店外消費）→ targetType=mobilepay（SCHEMA canonical 支付名）
    const r = {
      target: '全支付',
      targetType: 'mobilepay',
      pct: qpayPct,
      validUntil,
      note: `${POINT_NOTE_PX}；全支付店外消費（不含大全聯/全聯），不受扣繳身分與發卡組織影響；來源：${link.href}`,
    };
    if (capNote) r.cap = capNote;
    rewards.push(r);
  }
  if (autopayPct !== undefined) {
    // 台新帳戶扣繳屬 assumedAchieved 類條件 → 折入數值：記已扣繳的 %，未扣繳 % 寫 note
    const r = {
      targetType: 'general',
      pct: autopayPct,
      validUntil,
      note: `${POINT_NOTE_PX}；其他一般消費（不含全支付、大全聯、全聯），需設定台新帳戶扣繳卡款（本站假設已設定${
        defaultPct !== undefined ? `；未設定為${defaultPct}%` : ''
      }）；來源：${link.href}`,
    };
    if (capNote) r.cap = capNote;
    rewards.push(r);
  }

  if (!rewards.length) {
    console.error('taishin: 大全聯活動頁抓不到任何回饋數字，跳過此卡');
    return null;
  }
  const card = {
    id: 'taishin-pxmart',
    name: cardName || '大全聯信用卡',
    url: CARD_URL('cg010'),
    rewards,
  };
  if (jcb) {
    card.tiers = [
      { id: PX_TIER_JCB, name: 'JCB卡', condition: '持大全聯信用卡JCB版（發卡組織為JCB）' },
      { id: PX_TIER_OTHER, name: '其他發卡組織', condition: '持大全聯信用卡Visa/MasterCard等非JCB版本' },
    ];
  }
  return card;
}

// ---------- 街口聯名卡 ----------
async function scrapeJko(page, cardName) {
  const links = await renderCardLinks(page, 'cg038');
  const link = links.find(
    (l) => l.text.includes('回饋攻略') && !l.text.includes('已結束') && l.href.includes('/future/')
  );
  if (!link) {
    console.error('taishin: cg038 頁面找不到現行「回饋攻略」活動連結，跳過街口卡');
    return null;
  }
  const html = await fetchHtml(link.href);
  const $ = cheerio.load(html);
  $('script,style').remove();
  const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const flat = text.replace(/\s+/g, ' ');
  const jkoUrl = link.href;

  const period = flat.match(/活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const validFrom = period ? isoFrom(period[1], period[2], period[3]) : undefined;
  const validUntil = period ? isoFrom(period[4], period[5], period[6]) : undefined;
  const general = flat.match(/【一般消費享\s*([\d.]+)\s*%街口幣\s*無上限】/);
  const billsBase = flat.match(/街口APP繳費享基本([\d.]+)%回饋無上限/);
  // 街口APP繳費「滿額升級2%」：需手動領券且每月限量55,000名（先領先贏）→ 依核心原則 9
  // （限量名額/登錄型活動不收）排除，只收常態的基本 0.15%。

  const rewards = [];
  if (general) {
    rewards.push({
      targetType: 'general',
      pct: parseFloat(general[1]),
      validFrom,
      validUntil,
      note: `${POINT_NOTE_JKO}；一般消費回饋無上限，不限交易形式（4大超商/Apple媒體服務限街口支付綁定始享）`,
    });
  }
  if (billsBase) {
    rewards.push({
      targetType: 'general',
      pct: parseFloat(billsBase[1]),
      validFrom,
      validUntil,
      note: `${POINT_NOTE_JKO}；街口APP繳費（水電瓦斯/電信/稅費/保費/學雜費等）基本回饋，無上限`,
    });
  }

  // 精選通路：label｜商店清單（、分隔），連續 8 組（旅遊/交通/百貨/日常/外送/美食/影城/Ｋ歌）
  const groupRe = /^(旅遊|交通|百貨|日常|外送|美食|影城|Ｋ歌)｜(.+)$/;
  const lines = text.split('\n');
  const featuredPct = flat.match(/【精選通路\s*最高([\d.]+)\s*%街口幣】/);
  if (featuredPct) {
    const pct = parseFloat(featuredPct[1]);
    for (const line of lines) {
      const m = line.match(groupRe);
      if (!m) continue;
      const groupLabel = m[1];
      // 各項目後方可能附帶「*名稱: 含...」註解，先切掉星號註解再依頓號拆分店名
      const cleaned = m[2].replace(/\*[＊*].*$/, '');
      const items = splitOutsideParens(cleaned, '、');
      for (const raw of items) {
        // 日本PayPay 另有加碼註記與獨立%（1%一般+1%加碼=2%，非精選通路的3.5%）
        const isJapanPayPay = raw.includes('日本PayPay');
        const name = raw.replace(/\(限使用街口支付\)/, '').trim();
        if (isJapanPayPay) {
          rewards.push({
            target: name,
            targetType: name === '韓國' ? 'country' : 'merchant',
            pct: 2,
            validFrom,
            validUntil,
            note: `${POINT_NOTE_JKO}；精選通路【${groupLabel}】限使用街口支付綁街口聯名卡付款；一般消費1%+精選加碼1%，另享免1.5%海外交易手續費（來源：${jkoUrl}）`,
          });
          continue;
        }
        const targetType = name === '韓國' ? 'country' : 'merchant';
        rewards.push({
          target: name,
          targetType,
          pct,
          validFrom,
          validUntil,
          cap: '精選消費加碼合計每月上限NT$10,000街口幣',
          note: `${POINT_NOTE_JKO}；精選通路【${groupLabel}】，一般消費1%+精選加碼2.5%（來源：${jkoUrl}）`,
        });
      }
    }
  }

  if (!rewards.length) {
    console.error('taishin: 街口活動頁抓不到任何回饋數字，跳過此卡');
    return null;
  }
  return {
    id: 'taishin-jko',
    name: cardName || '街口聯名卡',
    url: CARD_URL('cg038'),
    rewards,
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
