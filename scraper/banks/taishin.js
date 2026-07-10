// 台新銀行（taishin）信用卡回饋爬蟲 — v2 改版（商店優先：見 ../../data/SCHEMA.md）
//
// v2 改版重點（相對 v1 的差異）：
//   v1 把「指定通路清單」壓扁成 category 大類（例：Richart卡「天天刷」的日常採買，
//   v1 只記 supermarket/convenience 大類，官方原始清單裡的每一家店都遺失）。
//   v2 規則：每個回饋方案，只要官方頁面列出「指定通路清單」，rewards[].merchants
//   就必須逐家收錄，並用 merchantsComplete 標記是否為官方全清單。
//
// 來源 URL（2026-07-10 人工核對過結構，之後若改版需重新核對）：
//   - 信用卡總覽（含卡片清單）：https://www.taishinbank.com.tw/TSB/personal/credit/
//   - 台新Richart卡（cg047）／大全聯信用卡（cg010）／街口聯名卡（cg038）之卡片頁：
//     https://www.taishinbank.com.tw/TSB/personal/credit/intro/overview/<cgNNN>/
//   - 各卡的回饋細節在「活動/權益頁」，其 URL 是會變動的 GUID 或短網址，
//     因此不寫死，而是每次從卡片頁上的連結文字動態找出來（見 renderCardLinks）。
//
// 解析假設（2026-07-10 實測）：
//   - Richart 權益頁（mkp.taishinbank.com.tw，經 tsbk.tw 短網址導向）是單頁滾動式版面
//     （不是分頁籤切換），playwright innerText('body') 一次即可拿到「Pay著刷／天天刷／
//     大筆刷／好饗刷／數趣刷／玩旅刷／假日刷／保費」全部方案的完整指定通路清單，
//     以及期間限定「Chill刷」（瘋聚會/沉浸娛樂/獨自升級 三大類、共 9 個子方案）的完整清單。
//     清單在頁面上以「子類別標籤」＋「緊接一行的商店清單（｜分隔大項、、分隔同項內的店）」
//     或（Chill刷區塊）「【子類別】pct%」＋「緊接一行以 / 分隔的商店清單」出現，
//     故用「lines() 陣列 + 逐行對照」解析，而非單一 regex，避免把不同子類別的商店混在一起。
//   - 好饗刷「指定飯店」的完整品牌清單另外出現在頁尾「注意事項」段落
//     （＊【好饗刷3.3%｜指定飯店適用品牌】...），比正文的精簡列表更完整，故取用該段。
//   - Pay著刷（台新Pay／台新Pay+ 綁定支付）官方文字明講「詳見台新Pay官網」/「詳見台灣Pay場域」，
//     只列出範例商店、非完整清單 → merchantsComplete: false，note 附來源頁 URL。
//   - 大全聯信用卡／街口聯名卡的活動頁是靜態伺服器渲染 → fetch 即可；兩頁皆把完整指定
//     通路清單直接寫在文案裡（大全聯只需綁定 PX Pay 本身即為通路；街口聯名卡的「精選通路」
//     依「旅遊/交通/百貨/日常/外送/美食/影城/K歌」分類逐家列出）。
//   - 點數換算（皆為頁面原文所載）：台新Point(信用卡)官網直接以 % 表述；
//     大全聯福利點「10點=NT$1」；街口幣「1元街口幣=新臺幣1元」。均在 note 註明點數型態。
//   - Richart 的 7+1 大刷權益頁未標「天天刷」等常態方案的活動迄日（僅 Chill刷有明確期間）
//     → 常態方案不填 validUntil，note 註明效期未確認；Chill刷、大全聯、街口皆有明確活動期間。

const cheerio = require('cheerio');
const { fetchHtml, sleep, UA } = require('../lib/util');

const OVERVIEW_URL = 'https://www.taishinbank.com.tw/TSB/personal/credit/';
const CARD_URL = (cg) => `https://www.taishinbank.com.tw/TSB/personal/credit/intro/overview/${cg}/`;

const POINT_NOTE_RICHART = '台新Point(信用卡)點數回饋';
const POINT_NOTE_PX = '福利點點數回饋（福利點10點=NT$1，可折抵全聯/大全聯店內消費）';
const POINT_NOTE_JKO = '街口幣回饋（1元街口幣=新臺幣1元）';
const NO_EXPIRY = '效期未確認（權益頁未標活動迄日）';

function isoFrom(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------- 共用文字解析工具 ----------
function toLines(text) {
  return text.split('\n').map((s) => s.trim());
}
// 依單一分隔字元拆商店清單，但不拆括號內的內容（例：「Mitsui Shopping Park LaLaport(南港/台中)」
// 是 1 家商店，括號內是附註不是分隔符）。支援半形/全形括號。
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
// 「全家及7-11(兩大超商限台新Pay)｜萬家福、樂家康｜...」→ 依｜、、拆成單店陣列
function splitPipeComma(str) {
  return splitOutsideParens(str, '｜').flatMap((seg) => splitOutsideParens(seg, '、'));
}
// Chill刷區塊「詹記麻辣火鍋 / 萬客什鍋 / 海底撈 / ...」→ 依 / 拆（括號內的 / 不拆）
function splitSlash(str) {
  return splitOutsideParens(str, '/');
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
  await page.goto(rightsLink.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);
  const rawText = await page.innerText('body');
  const rightsUrl = page.url();
  const L = toLines(rawText);
  const flat = rawText.replace(/\s+/g, ' ');

  const plans = [];

  // --- Chill刷（期間限定）：瘋聚會／沉浸娛樂／獨自升級，共 9 個子方案 ---
  const chillPeriod = flat.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*-\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*快樂上市/);
  if (chillPeriod) {
    const validFrom = isoFrom(chillPeriod[1], chillPeriod[2], chillPeriod[3]);
    const validUntil = isoFrom(chillPeriod[4], chillPeriod[5], chillPeriod[6]);
    // 【子類別】pct% 這一行 + 緊接商店清單一行（/ 分隔），一路蒐集到「Pay著刷」出現為止
    const CHILL_CATEGORY = {
      歡聚微醺: 'dining',
      日常續命: 'dining',
      約會犒賞: 'dining',
      應援追星: 'entertainment',
      熬夜追更: 'streaming',
      數位外掛: 'online',
      營養補給: 'medical',
      體態養成: 'entertainment',
      運動品牌: 'department',
    };
    const rewards = [];
    const startIdx = L.indexOf('瘋聚會');
    const endIdx = L.indexOf('Pay著刷');
    for (let i = startIdx; i >= 0 && i < endIdx; i++) {
      const m = L[i] && L[i].match(/^【(.+?)】([\d.]+)%$/);
      if (!m) continue;
      const subLabel = m[1];
      const pct = parseFloat(m[2]);
      const merchants = splitSlash(L[i + 1]);
      const category = CHILL_CATEGORY[subLabel] || 'general';
      if (!merchants.length) continue;
      rewards.push({
        category,
        pct,
        merchants,
        merchantsComplete: true,
        validFrom,
        validUntil,
        note: `${POINT_NOTE_RICHART}；Chill刷【${subLabel}】期間限定加碼（來源：${rightsUrl}）`,
      });
    }
    if (rewards.length) {
      plans.push({
        id: 'chill',
        name: 'Chill刷',
        condition: `需於Richart Life APP切換至「Chill刷」方案；限指定支付方式；活動期間 ${validFrom} ~ ${validUntil}`,
        validFrom,
        validUntil,
        rewards,
      });
    }
  }

  // --- Pay著刷（行動支付綁定）：官方僅列範例商店，非完整清單 ---
  const tsPay = flat.match(/台新Pay\s*及\s*台新Pay\+\s*綁定支付享\s*([\d.]+)\s*%/);
  const linePay = flat.match(/LINE Pay\s*及\s*全盈\+Pay[^綁]*綁定支付享\s*([\d.]+)\s*%/);
  const tsPayExamples = flat.match(/台新Pay｜([^*]+?)，詳見台新Pay官網/);
  const twPayExamples = flat.match(/台新Pay\(TWQR、台灣Pay\)｜([^*]+?)，詳見台灣Pay場域/);
  if (tsPay || linePay) {
    const rewards = [];
    if (tsPay) {
      const merchants = [
        ...splitPipeComma(tsPayExamples ? tsPayExamples[1] : ''),
        ...splitPipeComma(twPayExamples ? twPayExamples[1] : ''),
      ];
      const r = {
        category: 'mobilepay',
        pct: parseFloat(tsPay[1]),
        note: `${POINT_NOTE_RICHART}；台新Pay及台新Pay+綁定支付；官方頁面僅列部分範例商店，完整清單請見台新Pay官網／台灣Pay官方場域公告（來源：${rightsUrl}）；${NO_EXPIRY}`,
      };
      if (merchants.length) {
        r.merchants = merchants;
        r.merchantsComplete = false;
      }
      rewards.push(r);
    }
    if (linePay)
      rewards.push({
        category: 'mobilepay',
        pct: parseFloat(linePay[1]),
        note: `${POINT_NOTE_RICHART}；LINE Pay及全盈+Pay綁定支付（不限特定商店）；${NO_EXPIRY}`,
      });
    plans.push({
      id: 'pay',
      name: 'Pay著刷',
      condition: '需於Richart Life APP切換至「Pay著刷」方案',
      rewards,
    });
  }

  // --- 天天刷／大筆刷／好饗刷／數趣刷（label + 緊接一行商店清單，重複 N 組） ---
  const TOP_LABELS = ['天天刷', '大筆刷', '好饗刷', '數趣刷', '玩旅刷', '假日刷'];
  function readPct3Lines(label) {
    const idx = L.indexOf(label);
    if (idx < 0 || L[idx + 2] !== '%') return null;
    return { idx, pct: parseFloat(L[idx + 1]) };
  }
  function collectSubPairs(startIdx) {
    const subs = [];
    let i = startIdx;
    while (i < L.length && L[i] && !TOP_LABELS.includes(L[i]) && L[i] !== '保費') {
      const subLabel = L[i];
      const merchants = splitPipeComma(L[i + 1]);
      subs.push({ subLabel, merchants, raw: L[i + 1] });
      i += 2;
    }
    return subs;
  }

  // 天天刷
  const daily = readPct3Lines('天天刷');
  if (daily) {
    const subs = collectSubPairs(daily.idx + 3);
    const rewards = [];
    for (const s of subs) {
      if (s.subLabel === '日常採買') {
        // 「全家及7-11(兩大超商限台新Pay)」是 2 家超商合寫，拆成獨立商店；其餘維持原文
        const combo = '全家及7-11(兩大超商限台新Pay)';
        const rest = s.merchants.filter((m) => m !== combo);
        if (s.merchants.includes(combo)) {
          rewards.push({
            category: 'convenience',
            pct: daily.pct,
            merchants: ['全家', '7-ELEVEN'],
            merchantsComplete: true,
            note: `${POINT_NOTE_RICHART}；天天刷【日常採買】兩大超商，限台新Pay；${NO_EXPIRY}`,
          });
        }
        if (rest.length) {
          rewards.push({
            category: 'supermarket',
            pct: daily.pct,
            merchants: rest,
            merchantsComplete: true,
            note: `${POINT_NOTE_RICHART}；天天刷【日常採買】量販/超市；${NO_EXPIRY}`,
          });
        }
      } else if (s.subLabel === '通勤交通') {
        rewards.push({
          category: 'transport',
          pct: daily.pct,
          merchants: s.merchants,
          merchantsComplete: true,
          note: `${POINT_NOTE_RICHART}；天天刷【通勤交通】；${NO_EXPIRY}`,
        });
      } else if (s.subLabel === '加油充電') {
        rewards.push({
          category: 'gas',
          pct: daily.pct,
          merchants: s.merchants,
          merchantsComplete: true,
          note: `${POINT_NOTE_RICHART}；天天刷【加油充電】；${NO_EXPIRY}`,
        });
      } else if (s.subLabel === '藥妝藥局') {
        rewards.push({
          category: 'medical',
          pct: daily.pct,
          merchants: s.merchants,
          merchantsComplete: true,
          note: `${POINT_NOTE_RICHART}；天天刷【藥妝藥局】；${NO_EXPIRY}`,
        });
      }
    }
    if (rewards.length) plans.push({ id: 'daily', name: '天天刷', condition: '需於Richart Life APP切換至「天天刷」方案', rewards });
  }

  // 大筆刷（指定百貨／指定Outlet／居家裝修／時尚品味 → 全併入 department）
  const dept = readPct3Lines('大筆刷');
  if (dept) {
    const subs = collectSubPairs(dept.idx + 3);
    const merchants = subs.flatMap((s) => s.merchants);
    if (merchants.length) {
      plans.push({
        id: 'department',
        name: '大筆刷',
        condition: '需於Richart Life APP切換至「大筆刷」方案',
        rewards: [
          {
            category: 'department',
            pct: dept.pct,
            merchants,
            merchantsComplete: true,
            note: `${POINT_NOTE_RICHART}；大筆刷（指定百貨/Outlet/居家裝修/時尚品牌，來源：${rightsUrl}）；${NO_EXPIRY}`,
          },
        ],
      });
    }
  }

  // 好饗刷（全臺餐飲／外送平台／購票娛樂+指定KTV→entertainment／指定飯店）
  const dining = readPct3Lines('好饗刷');
  if (dining) {
    const subs = collectSubPairs(dining.idx + 3);
    const rewards = [];
    for (const s of subs) {
      if (s.subLabel === '全臺餐飲') {
        rewards.push({
          category: 'dining',
          pct: dining.pct,
          note: `${POINT_NOTE_RICHART}；好饗刷【全臺餐飲】不含餐券；另享王品瘋Pay加碼；不限指定商店；${NO_EXPIRY}`,
        });
      } else if (s.subLabel === '外送平台') {
        rewards.push({
          category: 'delivery',
          pct: dining.pct,
          merchants: s.merchants,
          merchantsComplete: true,
          note: `${POINT_NOTE_RICHART}；好饗刷【外送平台】；${NO_EXPIRY}`,
        });
      } else if (s.subLabel === '購票娛樂' || s.subLabel === '指定KTV') {
        rewards.push({
          category: 'entertainment',
          pct: dining.pct,
          merchants: s.merchants,
          merchantsComplete: true,
          note: `${POINT_NOTE_RICHART}；好饗刷【${s.subLabel}】；${NO_EXPIRY}`,
        });
      }
    }
    // 指定飯店：正文精簡列表不完整，改用頁尾注意事項的完整品牌清單
    const hotelNote = flat.match(/＊【好饗刷[\d.]*%｜指定飯店適用品牌】\s*([^＊]+?)(?:謹慎理財|$)/);
    if (hotelNote) {
      const hotels = splitOutsideParens(hotelNote[1].replace(/。\s*/g, ''), '、');
      if (hotels.length) {
        rewards.push({
          category: 'travel',
          pct: dining.pct,
          merchants: hotels,
          merchantsComplete: true,
          note: `${POINT_NOTE_RICHART}；好饗刷【指定飯店】不含餐券/住宿券等票券（品牌全清單，來源：${rightsUrl} 注意事項）；${NO_EXPIRY}`,
        });
      }
    }
    if (rewards.length) plans.push({ id: 'dining', name: '好饗刷', condition: '需於Richart Life APP切換至「好饗刷」方案', rewards });
  }

  // 數趣刷（網購平台→online；線上課程/遊戲影音/AI服務→streaming）
  const digital = readPct3Lines('數趣刷');
  if (digital) {
    const subs = collectSubPairs(digital.idx + 3);
    const rewards = [];
    for (const s of subs) {
      if (s.subLabel === '網購平台') {
        rewards.push({
          category: 'online',
          pct: digital.pct,
          merchants: s.merchants,
          merchantsComplete: true,
          note: `${POINT_NOTE_RICHART}；數趣刷【網購平台】；${NO_EXPIRY}`,
        });
      }
    }
    const streamMerchants = subs
      .filter((s) => ['線上課程', '遊戲影音', 'AI服務'].includes(s.subLabel))
      .flatMap((s) => s.merchants);
    if (streamMerchants.length) {
      rewards.push({
        category: 'streaming',
        pct: digital.pct,
        merchants: streamMerchants,
        merchantsComplete: true,
        note: `${POINT_NOTE_RICHART}；數趣刷（線上課程/遊戲影音/AI服務）；${NO_EXPIRY}`,
      });
    }
    if (rewards.length) plans.push({ id: 'digital', name: '數趣刷', condition: '需於Richart Life APP切換至「數趣刷」方案', rewards });
  }

  // 玩旅刷（第一行是「海外消費」敘述、非 label+清單配對；其後才是航空公司/海外交通網路/訂房平台/旅行社）
  const travel = readPct3Lines('玩旅刷');
  if (travel) {
    const rewards = [
      {
        category: 'overseas',
        pct: travel.pct,
        note: `${POINT_NOTE_RICHART}；玩旅刷【海外消費】含實體及線上、歐洲國家交易；不限指定商店；${NO_EXPIRY}`,
      },
    ];
    const subs = collectSubPairs(travel.idx + 4); // idx+3 是「海外消費(...)」單行敘述，故從 +4 開始配對
    const travelMerchants = subs.flatMap((s) => s.merchants);
    if (travelMerchants.length) {
      rewards.push({
        category: 'travel',
        pct: travel.pct,
        merchants: travelMerchants,
        merchantsComplete: true,
        note: `${POINT_NOTE_RICHART}；玩旅刷（航空公司/海外交通網路/訂房平台/旅行社，來源：${rightsUrl}）；${NO_EXPIRY}`,
      });
    }
    plans.push({ id: 'travel', name: '玩旅刷', condition: '需於Richart Life APP切換至「玩旅刷」方案', rewards });
  }

  // 假日刷
  const holiday = readPct3Lines('假日刷');
  if (holiday) {
    plans.push({
      id: 'holiday',
      name: '假日刷',
      condition: '免切換，節假日適用',
      rewards: [
        {
          category: 'general',
          pct: holiday.pct,
          note: `${POINT_NOTE_RICHART}；限節假日消費，不限通路（含保費、LINE Pay及全盈+Pay綁定）`,
        },
      ],
    });
  }

  // 保費（免切換）
  const insurance = flat.match(/保費\s*免切換免領券\s*最高([\d.]+)%/);
  if (insurance) {
    plans.push({
      id: 'insurance-base',
      name: '保費回饋（免切換）',
      condition: '免切換免領券，所有方案皆適用',
      rewards: [{ category: 'insurance', pct: parseFloat(insurance[1]), note: `${POINT_NOTE_RICHART}；${NO_EXPIRY}` }],
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
  const cap = text.match(/店外全支付消費及其他一般消費合計每期最高回饋福利點([\d,]+)點/);
  const capNote = cap ? `店外消費合計每期回饋上限${cap[1]}福利點（正附卡合併）` : undefined;
  // 店外消費依序有 3 組「每消費100元給N點(最高X%)」：全支付／已扣繳一般消費／未扣繳一般消費。
  // 注意：店內消費的「基本權益+加碼回饋」拆解表也用同樣的句型（例：8點0.8%+4點0.4%=12點1.2%），
  // 必須從「店外消費享」錨點之後截取，否則會誤抓到店內拆解表的前 2 筆數字。
  const outStoreSection = text.slice(text.indexOf('店外消費享每'));
  const outStoreValues = [...outStoreSection.matchAll(/每消費100元給\d+點\(最高([\d.]+)%\)/g)].map((m) => parseFloat(m[1]));
  const [qpayPct, autopayPct, defaultPct] = outStoreValues;

  function buildRewards(generalPct, generalCond) {
    const rewards = [];
    if (instore) {
      const r = {
        category: 'supermarket',
        pct: parseFloat(instore[1]),
        merchants: ['大全聯'],
        merchantsComplete: true,
        note: `${POINT_NOTE_PX}；大全聯店內消費，回饋無上限，需綁定PX Pay會員`,
      };
      if (validUntil) r.validUntil = validUntil;
      rewards.push(r);
    }
    if (qpayPct !== undefined) {
      const r = {
        category: 'mobilepay',
        pct: qpayPct,
        note: `${POINT_NOTE_PX}；全支付店外消費（不含大全聯/全聯）`,
      };
      if (capNote) r.cap = capNote;
      if (validUntil) r.validUntil = validUntil;
      rewards.push(r);
    }
    if (generalPct !== undefined) {
      const r = {
        category: 'general',
        pct: generalPct,
        note: `${POINT_NOTE_PX}；其他一般消費（不含全支付、大全聯、全聯）；${generalCond}`,
      };
      if (capNote) r.cap = capNote;
      if (validUntil) r.validUntil = validUntil;
      rewards.push(r);
    }
    return rewards;
  }

  const plans = [];
  const autopayRewards = buildRewards(autopayPct, '有設定台新帳戶扣繳台新信用卡帳款');
  if (autopayRewards.length) {
    plans.push({ id: 'autopay', name: '台新帳戶扣繳卡款', condition: '有設定台新帳戶扣繳台新信用卡帳款', rewards: autopayRewards });
  }
  const defaultRewards = buildRewards(defaultPct, '未設定台新帳戶扣繳');
  if (defaultRewards.length) {
    plans.push({ id: 'default', name: '一般（未設定扣繳）', condition: '未設定台新帳戶扣繳台新信用卡帳款', rewards: defaultRewards });
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
  const text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const flat = text.replace(/\s+/g, ' ');
  const jkoUrl = link.href;

  const period = flat.match(/活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const validFrom = period ? isoFrom(period[1], period[2], period[3]) : undefined;
  const validUntil = period ? isoFrom(period[4], period[5], period[6]) : undefined;
  const featured = flat.match(/【精選通路\s*最高([\d.]+)\s*%街口幣】/);
  const general = flat.match(/【一般消費享\s*([\d.]+)\s*%街口幣\s*無上限】/);
  const billsBase = flat.match(/街口APP繳費享基本([\d.]+)%回饋無上限/);
  const billsBonus = flat.match(/滿NT\$?([\d,]+)[，,]\s*升級再享([\d.]+)%回饋/);
  const cap = flat.match(/精選消費加碼合計每月上限\$?([\d,]+)街口幣/);
  const capNote = cap ? `精選通路加碼合計每月上限${cap[1]}街口幣` : undefined;

  function merchantsAfterLabel(label) {
    const re = new RegExp(label + '｜([^\\n*]+)');
    const m = text.match(re);
    return m ? splitOutsideParens(m[1], '、') : [];
  }

  const rewards = [];
  if (general) {
    const r = { category: 'general', pct: parseFloat(general[1]), note: `${POINT_NOTE_JKO}；一般消費回饋無上限，不限交易形式（4大超商及Apple媒體服務限街口支付綁定始享）` };
    if (validFrom) r.validFrom = validFrom;
    if (validUntil) r.validUntil = validUntil;
    rewards.push(r);
  }
  if (featured) {
    const pct = parseFloat(featured[1]);
    const groups = [
      { category: 'travel', label: '旅遊' },
      { category: 'transport', label: '交通' },
      { category: 'department', label: '百貨' },
      { category: 'supermarket', label: '日常' },
      { category: 'delivery', label: '外送' },
      { category: 'dining', label: '美食' },
      { category: 'entertainment', label: '影城' },
      { category: 'entertainment', label: 'Ｋ歌' },
    ];
    for (const g of groups) {
      const merchants = merchantsAfterLabel(g.label);
      if (!merchants.length) continue;
      const r = {
        category: g.category,
        pct,
        merchants,
        merchantsComplete: true,
        note: `${POINT_NOTE_JKO}；精選通路【${g.label}】，最高回饋（含一般消費1%＋精選加碼2.5%，來源：${jkoUrl}）`,
      };
      if (capNote) r.cap = capNote;
      if (validFrom) r.validFrom = validFrom;
      if (validUntil) r.validUntil = validUntil;
      rewards.push(r);
    }
  }
  if (billsBase) {
    let note = `街口APP繳費（水電瓦斯/電信/稅費/保費/學雜費等）基本回饋${billsBase[1]}%無上限`;
    if (billsBonus) note += `；當月繳費滿NT$${billsBonus[1]}另升級享${billsBonus[2]}%回饋（每月每人上限20元街口券，限量）`;
    const r = { category: 'utilities', pct: parseFloat(billsBase[1]), note };
    if (validFrom) r.validFrom = validFrom;
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
    plans: [{ id: 'default', name: '一般', condition: '無條件（部分通路限街口支付/LINE Pay/Apple Pay綁定始享最高回饋）', rewards }],
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
