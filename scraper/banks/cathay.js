// 國泰世華銀行（cathay）信用卡回饋爬蟲 v2
//
// 來源 URL（2026-07-10 查證，皆為 AEM 的 .model.json 結構化內容端點，plain fetch 即可取得，
// 不需要 playwright；v1 曾用 playwright 渲染頁面再抓文字，但實測發現頁面背後直接吃這兩支
// .model.json，內容比渲染後的畫面文字更完整、更穩定（例如通路清單在畫面上要點開手風琴才看得到，
// 但 .model.json 一次就給全部項目），故 v2 改用這兩支端點）：
//   - CUBE信用卡權益分級（Level 1/2/3 百分比）：
//     https://www.cathaybk.com.tw/cathaybk/personal/product/credit-card/cards/cube.model.json
//   - CUBE信用卡權益方案（各方案通路商家「完整」清單與活動期間）：
//     https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube-list.model.json
//
// 解析假設／v2 重點：
//   - cube-list.model.json 是 AEM SPA 的內容樹，每個權益方案（玩數位/樂饗購/趣旅行/集精選/台塑家/
//     全支付）是一個 experienceFragment 節點，節點下依「categoryName」分組（如「國內指定百貨」
//     「國內外送平台」「指定航空公司」），每組底下的 itemText 就是官方逐一列舉的商家全名——這是
//     官方畫面上手風琴展開後才看得到的內容，直接讀 JSON 可一次拿到「完整清單」，不會漏抓。
//   - 為避免抓到改版後元件 key 改變而整組失效，不寫死 cub_experiencefragme_xxx 這種 key，
//     改用每個節點自帶的 mainTitle（如「樂饗購 適用期間：...」）比對方案中文名稱來定位。
//   - 「慶生月」（限壽星生日月，商家清單以特定城市在地店家為主，泛用性低）與「童樂匯」（限與未成年
//     子女共同開戶之家長資格，屬另一種資格制而非人人可切換的方案）維持 v1 的排除決定，未收錄。
//   - 部分官方分組本質上是「開放式類別」而非可窮舉的商家清單，v2 依 SCHEMA 規則 3(a)/2 處理：
//     「國內餐飲」分組官方是以聯合信用卡中心 MCC code（5811/5812/5814/5462）認定，幾乎涵蓋全台
//     餐飲業者，非封閉清單，故不填 merchants，只在 note 註明 MCC 規則與官方點名的麥當勞範例；
//     「指定海外消費」（趣旅行）為「海外實體消費」概括式描述，非商家清單，同樣不填 merchants；
//     「全支付國內合作通路」（全支付方案）是「凡貼 TWQR 標誌之全支付合作商店」的開放式定義，
//     並非官方逐一列舉的封閉清單，填 merchants:['全支付'] 並標 merchantsComplete:false 說明。
//   - SCHEMA 固定 18 類 category 沒有「藥妝」「充電」「居家」「健康生活」對應項，沿用 v1 的暫歸類
//     做法（分別歸 medical／gas／department／medical），並在 note 註明為暫歸類、請以官網為準。
//   - Level 1/2/3 加碼機制僅影響玩數位／樂饗購／趣旅行三個方案（官方頁面原文：「權益分級適用方案：
//     僅限玩數位、樂饗購、趣旅行權益方案」）；集精選／台塑家／全支付為不分級的固定 2%。
//     為避免高估使用者實際可得回饋，reward.pct 一律取 Level 1（任何持卡人核卡即享、無需額外條件）
//     之基礎值，Level 2/3 的加碼百分比與升級條件寫在 note 供使用者自行評估。
//   - 全部方案回饋皆以小樹點(信用卡)發放，1點=1元，已在 note 註明。
//   - card 層級 planKind 標為 "switchable"：CUBE App 可隨時切換以下 6 個方案，
//     每次消費依當下設定的方案計算回饋（非需要用戶預先選定等級/資格）。

const cheerio = require('cheerio');
const { UA } = require('../lib/util');

const LEVEL_URL = 'https://www.cathaybk.com.tw/cathaybk/personal/product/credit-card/cards/cube.model.json';
const CHANNEL_URL = 'https://www.cathay-cube.com.tw/cathaybk/personal/product/credit-card/cards/cube-list.model.json';
const CARD_URL = 'https://www.cathaybk.com.tw/cathaybk/personal/product/credit-card/cards/cube/';

const POINT_NOTE = '小樹點(信用卡)回饋，1點=1元';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function htmlToText(html) {
  if (!html) return '';
  return cheerio.load(html).text().replace(/\s+/g, ' ').trim();
}

function isoFrom(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Level 1/2/3 的玩數位/樂饗購/趣旅行/集精選/一般消費 %，依序回傳陣列 [Level1, Level2, Level3]
function parseLevels(fullText) {
  const re = /玩數位([\d.]+)%\s*樂饗購([\d.]+)%\s*趣旅行([\d.]+)%\s*集精選([\d.]+)%\s*一般消費享([\d.]+)%/g;
  const levels = [];
  for (const m of fullText.matchAll(re)) {
    levels.push({
      digital: parseFloat(m[1]),
      dining: parseFloat(m[2]),
      travel: parseFloat(m[3]),
      essential: parseFloat(m[4]),
      general: parseFloat(m[5]),
    });
  }
  return levels;
}

// 收集 model.json 內所有字串（用來對權益分級頁跑正則，因為分級表格文字分散在多個 html 片段中，
// 直接把整棵樹的字串節點轉文字後串在一起，跟原本 playwright innerText('body') 效果一致）
function collectText(node, out) {
  if (typeof node === 'string') {
    if (node.includes('<') || /[一-鿿]/.test(node)) out.push(htmlToText(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v) => collectText(v, out));
    return;
  }
  if (node && typeof node === 'object') {
    Object.values(node).forEach((v) => collectText(v, out));
  }
}

// 找出 cube-list.model.json 中 cub_main 底下代表各權益方案的節點，用 mainTitle 開頭中文名稱比對
// （而非寫死元件 key），較能抵抗改版時元件 key 變動
function findPlanNodes(channelJson) {
  const items = channelJson[':items']?.root?.[':items']?.responsivegrid?.[':items']?.cub_main?.[':items'] || {};
  const plans = {};
  for (const val of Object.values(items)) {
    const titleNode = val?.experienceFragment?.[':items']?.root?.[':items']?.cub_cubelisttitle_co;
    if (!titleNode) continue;
    const titleText = htmlToText(titleNode.mainTitle);
    const nameMatch = titleText.match(/^([一-鿿]+)/);
    if (!nameMatch) continue;
    plans[nameMatch[1]] = { titleText, titleNode };
  }
  return plans;
}

function parseValidity(titleText) {
  const m = titleText.match(/適用期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return { validFrom: isoFrom(m[1], m[2], m[3]), validUntil: isoFrom(m[4], m[5], m[6]) };
}

// 從單一權益方案節點中，依官方 categoryName（如「國內指定百貨」）取出該分組底下逐一列舉的商家清單
function extractMerchants(titleNode, categoryName) {
  const cats = titleNode[':items'] || {};
  for (const cv of Object.values(cats)) {
    if (cv.categoryName !== categoryName) continue;
    const merchants = [];
    for (const ct of cv.contentTrees || []) {
      const trees = ct.contentTrees;
      if (!trees || typeof trees !== 'object') continue;
      for (const iv of Object.values(trees)) {
        if (!iv || typeof iv !== 'object') continue;
        if (iv.itemType === 'link') continue;
        const txt = (iv.itemText || '').trim();
        if (txt) merchants.push(txt);
      }
    }
    return merchants;
  }
  return null;
}

// 集精選/台塑家/全支付：mainTitle 末尾緊接單一 flat %（不分等級）
function parseFlatPct(titleText) {
  const m = titleText.match(/僅適用原一般消費0\.3%回饋。\s*([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

async function scrape() {
  const cards = [];
  const [levelJson, channelJson] = await Promise.all([fetchJson(LEVEL_URL), fetchJson(CHANNEL_URL)]);

  const levelTextParts = [];
  collectText(levelJson, levelTextParts);
  const levels = parseLevels(levelTextParts.join(' '));
  if (levels.length < 3) {
    console.error('cathay: 權益分級頁抓不到完整3級百分比，CUBE卡跳過');
    return { id: 'cathay', name: '國泰世華銀行', cards: [] };
  }
  const [lv1, lv2, lv3] = levels;
  const planNodes = findPlanNodes(channelJson);
  const plans = [];

  function levelNote(field) {
    return `${POINT_NOTE}；回饋依CUBE App當月權益分級而異：Level 1（核卡即享）${lv1[field]}%、Level 2（以CUBE App繳費或申請自動扣繳，次月生效）${lv2[field]}%、Level 3（財富管理貴賓，次月生效）${lv3[field]}%；此處採任何持卡人皆可得之Level 1基礎值`;
  }

  // ---------- 玩數位（Level制，取Level1基礎值）----------
  {
    const node = planNodes['玩數位'];
    const v = node && parseValidity(node.titleText);
    if (v && !Number.isNaN(lv1.digital)) {
      const note = levelNote('digital');
      const aiTools = extractMerchants(node.titleNode, 'AI工具') || [];
      const streaming = extractMerchants(node.titleNode, '數位/串流平台') || [];
      const shopping = extractMerchants(node.titleNode, '網購平台') || [];
      const crossBorder = extractMerchants(node.titleNode, '國際電商') || [];
      const rewards = [];
      if (aiTools.length || streaming.length) {
        rewards.push({
          category: 'streaming',
          pct: lv1.digital,
          merchants: [...aiTools, ...streaming],
          merchantsComplete: true,
          note: `${note}；AI工具＋數位/串流平台（官方分組，來源：${CHANNEL_URL}）`,
        });
      }
      if (shopping.length || crossBorder.length) {
        rewards.push({
          category: 'online',
          pct: lv1.digital,
          merchants: [...shopping, ...crossBorder],
          merchantsComplete: true,
          note: `${note}；網購平台＋國際電商（官方分組，來源：${CHANNEL_URL}）`,
        });
      }
      if (rewards.length) {
        plans.push({
          id: 'digital',
          name: '玩數位',
          condition: '需於CUBE App切換至「玩數位」權益方案，可隨時切換，當日零時起生效',
          validFrom: v.validFrom,
          validUntil: v.validUntil,
          rewards,
        });
      } else {
        console.error('cathay: 玩數位方案抓不到任何通路清單，跳過此 plan');
      }
    } else {
      console.error('cathay: 玩數位方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 樂饗購（Level制，取Level1基礎值）----------
  {
    const node = planNodes['樂饗購'];
    const v = node && parseValidity(node.titleText);
    if (v && !Number.isNaN(lv1.dining)) {
      const note = levelNote('dining');
      const department = extractMerchants(node.titleNode, '國內指定百貨') || [];
      const delivery = extractMerchants(node.titleNode, '國內外送平台') || [];
      const drugstore = extractMerchants(node.titleNode, '國內藥妝') || [];
      const rewards = [];
      if (department.length) {
        rewards.push({
          category: 'department',
          pct: lv1.dining,
          merchants: department,
          merchantsComplete: true,
          note: `${note}；國內指定百貨（不含店中櫃，來源：${CHANNEL_URL}）`,
        });
      }
      if (delivery.length) {
        rewards.push({
          category: 'delivery',
          pct: lv1.dining,
          merchants: delivery,
          merchantsComplete: true,
          note: `${note}；國內外送平台`,
        });
      }
      // 國內餐飲：官方以聯合信用卡中心 MCC code(5811/5812/5814/5462)認定，非封閉商家清單，
      // 依 SCHEMA 3(a) 不填 merchants，僅在 note 說明規則與官方點名的麥當勞範例
      rewards.push({
        category: 'dining',
        pct: lv1.dining,
        note: `${note}；國內餐飲(不含餐券)，依聯合信用卡中心MCC code(5811/5812/5814/5462)認定，非限定商店清單，幾乎涵蓋全台合格餐飲業者；官方另點名「連鎖速食－麥當勞」為例，但不限於此`,
      });
      if (drugstore.length) {
        rewards.push({
          category: 'medical',
          pct: lv1.dining,
          merchants: drugstore,
          merchantsComplete: true,
          note: `${note}；國內藥妝（SCHEMA無「藥妝」分類，暫歸類medical，請以官網為準）`,
        });
      }
      plans.push({
        id: 'dining',
        name: '樂饗購',
        condition: '需於CUBE App切換至「樂饗購」權益方案，可隨時切換，當日零時起生效',
        validFrom: v.validFrom,
        validUntil: v.validUntil,
        rewards,
      });
    } else {
      console.error('cathay: 樂饗購方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 趣旅行（Level制，取Level1基礎值）----------
  {
    const node = planNodes['趣旅行'];
    const v = node && parseValidity(node.titleText);
    if (v && !Number.isNaN(lv1.travel)) {
      const note = levelNote('travel');
      const parks = extractMerchants(node.titleNode, '日本指定遊樂園') || [];
      const transport = extractMerchants(node.titleNode, '指定國內外交通') || [];
      const airlines = extractMerchants(node.titleNode, '指定航空公司') || [];
      const hotels = extractMerchants(node.titleNode, '指定飯店住宿') || [];
      const bookingPlatforms = extractMerchants(node.titleNode, '指定旅遊/訂房平台') || [];
      const agencies = extractMerchants(node.titleNode, '指定旅行社') || [];
      const rewards = [];
      // 指定海外消費：官方僅描述「海外實體消費」，非商家清單，依 SCHEMA 3(a) 不填 merchants
      rewards.push({
        category: 'overseas',
        pct: lv1.travel,
        note: `${note}；海外實體消費(含國外餐飲、飯店到店付款等)，屬概括式描述非限定商店清單`,
      });
      if (parks.length) {
        rewards.push({
          category: 'entertainment',
          pct: lv1.travel,
          merchants: parks,
          merchantsComplete: true,
          note: `${note}；日本指定遊樂園（SCHEMA無「主題樂園」分類，暫歸類entertainment）`,
        });
      }
      if (transport.length) {
        rewards.push({
          category: 'transport',
          pct: lv1.travel,
          merchants: transport,
          merchantsComplete: true,
          note: `${note}；指定國內外交通`,
        });
      }
      if (airlines.length) {
        rewards.push({
          category: 'travel',
          pct: lv1.travel,
          merchants: airlines,
          merchantsComplete: true,
          note: `${note}；指定航空公司`,
        });
      }
      if (hotels.length) {
        rewards.push({
          category: 'travel',
          pct: lv1.travel,
          merchants: hotels,
          merchantsComplete: true,
          note: `${note}；指定飯店住宿`,
        });
      }
      if (bookingPlatforms.length) {
        rewards.push({
          category: 'travel',
          pct: lv1.travel,
          merchants: bookingPlatforms,
          merchantsComplete: true,
          note: `${note}；指定旅遊/訂房平台`,
        });
      }
      if (agencies.length) {
        rewards.push({
          category: 'travel',
          pct: lv1.travel,
          merchants: agencies,
          merchantsComplete: true,
          note: `${note}；指定旅行社`,
        });
      }
      plans.push({
        id: 'travel',
        name: '趣旅行',
        condition: '需於CUBE App切換至「趣旅行」權益方案，可隨時切換，當日零時起生效',
        validFrom: v.validFrom,
        validUntil: v.validUntil,
        rewards,
      });
    } else {
      console.error('cathay: 趣旅行方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 集精選（不分等級，flat 2%）----------
  {
    const node = planNodes['集精選'];
    const v = node && parseValidity(node.titleText);
    const pct = node && parseFlatPct(node.titleText);
    if (v && pct != null) {
      const note = `${POINT_NOTE}；集精選不分CUBE權益分級，統一回饋${pct}%`;
      const charging = extractMerchants(node.titleNode, '充電站') || [];
      const parking = extractMerchants(node.titleNode, '停車費') || [];
      const supermarket = extractMerchants(node.titleNode, '量販超市') || [];
      const gas = extractMerchants(node.titleNode, '指定加油') || [];
      const convenience = extractMerchants(node.titleNode, '指定超商') || [];
      const home = extractMerchants(node.titleNode, '生活家居') || [];
      const rewards = [];
      if (gas.length || charging.length) {
        rewards.push({
          category: 'gas',
          pct,
          merchants: [...gas, ...charging],
          merchantsComplete: true,
          note: `${note}；指定加油站＋充電站（SCHEMA無「充電」分類，歸類於gas）`,
        });
      }
      if (parking.length) {
        rewards.push({ category: 'transport', pct, merchants: parking, merchantsComplete: true, note: `${note}；停車費` });
      }
      if (supermarket.length) {
        rewards.push({
          category: 'supermarket',
          pct,
          merchants: supermarket,
          merchantsComplete: true,
          note: `${note}；量販超市`,
        });
      }
      if (convenience.length) {
        rewards.push({
          category: 'convenience',
          pct,
          merchants: convenience,
          merchantsComplete: true,
          note: `${note}；指定超商實體門市`,
        });
      }
      if (home.length) {
        rewards.push({
          category: 'department',
          pct,
          merchants: home,
          merchantsComplete: true,
          note: `${note}；生活家居（SCHEMA無「居家」分類，暫歸類department）`,
        });
      }
      plans.push({
        id: 'essential',
        name: '集精選',
        condition: '需於CUBE App切換至「集精選」權益方案，可隨時切換，當日零時起生效',
        validFrom: v.validFrom,
        validUntil: v.validUntil,
        rewards,
      });
    } else {
      console.error('cathay: 集精選方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 台塑家（不分等級，flat 2%）----------
  {
    const node = planNodes['台塑家'];
    const v = node && parseValidity(node.titleText);
    const pct = node && parseFlatPct(node.titleText);
    if (v && pct != null) {
      const note = `${POINT_NOTE}；台塑家不分CUBE權益分級，統一回饋${pct}%`;
      const gas = extractMerchants(node.titleNode, '加油站') || [];
      const healthAll = extractMerchants(node.titleNode, '健康生活') || [];
      const onlineShop = healthAll.filter((m) => m.includes('購物網'));
      const healthStores = healthAll.filter((m) => !m.includes('購物網'));
      const convenience = extractMerchants(node.titleNode, '指定超商') || [];
      const rewards = [];
      if (gas.length) {
        rewards.push({ category: 'gas', pct, merchants: gas, merchantsComplete: true, note: `${note}；台塑通路指定加油站` });
      }
      if (healthStores.length) {
        rewards.push({
          category: 'medical',
          pct,
          merchants: healthStores,
          merchantsComplete: true,
          note: `${note}；健康生活實體門市（SCHEMA無「健康生活」分類，暫歸類medical，請以官網為準）`,
        });
      }
      if (onlineShop.length) {
        rewards.push({ category: 'online', pct, merchants: onlineShop, merchantsComplete: true, note: `${note}；台塑集團購物網` });
      }
      if (convenience.length) {
        rewards.push({
          category: 'convenience',
          pct,
          merchants: convenience,
          merchantsComplete: true,
          note: `${note}；指定超商實體門市`,
        });
      }
      plans.push({
        id: 'formosa',
        name: '台塑家',
        condition: '需於CUBE App切換至「台塑家」權益方案，可隨時切換，當日零時起生效',
        validFrom: v.validFrom,
        validUntil: v.validUntil,
        rewards,
      });
    } else {
      console.error('cathay: 台塑家方案資料不完整，跳過此 plan');
    }
  }

  // ---------- 全支付（不分等級，flat 2%）----------
  {
    const node = planNodes['全支付'];
    const v = node && parseValidity(node.titleText);
    const pct = node && parseFlatPct(node.titleText);
    if (v && pct != null) {
      const note = `${POINT_NOTE}；全支付不分CUBE權益分級，統一回饋${pct}%；須選定「全支付」方案並以全支付綁定CUBE信用卡刷卡消費方可獲回饋`;
      const supermarket = extractMerchants(node.titleNode, '量販超市') || [];
      const rewards = [];
      if (supermarket.length) {
        rewards.push({ category: 'supermarket', pct, merchants: supermarket, merchantsComplete: true, note: `${note}；量販超市` });
      }
      // 全支付國內合作通路：官方定義為「凡貼TWQR標誌並以全支付綁定CUBE卡消費之合作商店」，
      // 屬開放式通路而非官方逐一列舉的封閉清單，依 SCHEMA 規則2標註不完整
      rewards.push({
        category: 'mobilepay',
        pct,
        merchants: ['全支付'],
        merchantsComplete: false,
        note: `${note}；全支付國內合作通路，官方定義為「登記於我國境內且以新台幣交易、貼有TWQR標誌等，並得接受全支付綁定CUBE信用卡支付之通路」，屬開放式通路非封閉清單（來源：${CHANNEL_URL}），已收錄「全支付」作為代表性商家名稱`,
      });
      plans.push({
        id: 'qpay',
        name: '全支付',
        condition: '需於CUBE App切換至「全支付」權益方案，並以全支付綁定CUBE信用卡刷卡消費，可隨時切換',
        validFrom: v.validFrom,
        validUntil: v.validUntil,
        rewards,
      });
    } else {
      console.error('cathay: 全支付方案資料不完整，跳過此 plan');
    }
  }

  if (!plans.length) {
    console.error('cathay: 所有 CUBE 權益方案皆抓取失敗，CUBE卡跳過');
  } else {
    cards.push({
      id: 'cathay-cube',
      name: 'CUBE信用卡',
      url: CARD_URL,
      planKind: 'switchable',
      plans,
    });
  }
  return { id: 'cathay', name: '國泰世華銀行', cards };
}

module.exports = { scrape };
