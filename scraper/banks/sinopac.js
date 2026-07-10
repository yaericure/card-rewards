// 永豐銀行 (sinopac) 信用卡回饋爬蟲 v2
//
// 來源 URL（2026-07-10 人工驗證可 fetch，200 OK，內容為伺服器端渲染，無需 JS 引擎）：
//   幣倍卡     https://bank.sinopac.com/sinopacBT/personal/credit-card/introduction/bankcard/dual-currency-card.html
//   DAWHO      https://bank.sinopac.com/sinopacBT/personal/credit-card/introduction/bankcard/DAWHO.html
//   SPORT卡    https://bank.sinopac.com/sinopacBT/personal/credit-card/introduction/bankcard/sportcard.html
//
// 解析假設：
//   - 頁面內文以 cheerio 取出 body 純文字後，用「穩定中文片語」的 regex 定位回饋 %／上限／活動期間。
//     這些片語（如「國內1%、國外2%現金回饋無上限」「精選通路加碼4%現金回饋（上限800元/帳單週期）」）
//     是行銷文案標題，比 DOM class/id 更不容易在小改版時跑掉，但銀行大改版仍會失效——
//     若 regex 沒抓到，該筆 reward 會被跳過並記錄警告，不會用假數字頂替。
//   - 活動期間一律為「YYYY/M/D~YYYY/M/D」或「YYYY/M/D~M/D」（沿用起始年）格式，用 parseSlashDateRange 轉換。
//   - 永豐幣別點數/豐點回饋皆為「等值%」，非真點數換算，故直接以 pct 呈現，並在 note 註明「豐點/刷卡金回饋」。
//   - DAWHO 大戶Plus / 大戶兩個等級官網僅標「國內最高5%/國外最高6%」的加總結果，任務加碼本身的 4% / 2.5%
//     是另外於段落中列出的分量；因官網沒有把「基礎1%+任務加碼」這句加總文字用於大戶等級（只給大戶Plus的加總句），
//     大戶等級的 3.5%/4.5% 為程式加總基礎回饋(regex 抓到)+任務加碼(regex 抓到)，非官網逐字加總，已於 note 註明。
//
// v2 通路清單重點（相較 v1 的「精選代表性商家」，v2 全部改抓官方頁面上逐一列舉的完整清單）：
//   - 幣倍卡「精選通路」區塊官方原文以「網購消費：」「旅遊通路：」兩行分別列出完整商家清單（無「等」字
//     結尾，屬封閉清單），v2 用 parseLabelledList 逐行抓出並標 merchantsComplete:true；「國外實體」
//     該行官方只寫「交易地區非臺灣，且非新臺幣之實體商店一般消費」的概括式描述，非商家清單，
//     依 SCHEMA 規則 3(a) 不填 merchants。
//   - SPORT卡「指定支付／通路」區塊官方原文以「行動支付：」「運動健身：」「醫藥保健：」「電競娛樂：」
//     四行列出完整清單，v2 逐行拆出並各自建立一筆 reward（其中行動支付本身就是 mobilepay 通路，
//     其餘三行才是具體商家），merchants 已對照官方逐字收錄。
//   - 新戶首刷／新申辦行動支付加碼兩個活動列出的指定支付方式（LINE Pay、Apple Pay 等）官方原文同樣
//     無「等」字結尾，屬封閉清單，一併標 merchantsComplete:true。
//   - DAWHO 的「國內全通路」基礎回饋與任務加碼，官網通篇未列出任何指定商店，本質上是無指定通路的
//     整戶消費回饋，依 SCHEMA 規則 3(a) 維持純 category、不填 merchants。
//
// 反爬對策：合理 UA、頁間 delay 1.2s。目前測試皆為一般 fetch 可讀取，無需 playwright。

const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 CardRewardsBot/1.0';

const URLS = {
  dual: 'https://bank.sinopac.com/sinopacBT/personal/credit-card/introduction/bankcard/dual-currency-card.html',
  dawho: 'https://bank.sinopac.com/sinopacBT/personal/credit-card/introduction/bankcard/DAWHO.html',
  sport: 'https://bank.sinopac.com/sinopacBT/personal/credit-card/introduction/bankcard/sportcard.html',
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

// "2026/7/1~2026/12/31"、"2026/7/1~12/31" 或 "2026/7/1-12/31"（沿用起始年）→ "2026-12-31"
// 採「全文比對取絕對距離最近者」而非固定視窗內第一個 match，避免抓到鄰近但不相關段落的日期
// （例如某張卡頁面中間穿插了不同活動的日期區間，離目標句子更近的才是正確答案）。
const SLASH_DATE_RANGE_RE = /(\d{4})\/(\d{1,2})\/(\d{1,2})\s*[~-]\s*(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})/g;

function parseSlashDateRangeEnd(text, nearIndex) {
  if (nearIndex == null) return null;
  let best = null;
  let bestDist = Infinity;
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
  console.error(`  [sinopac/${cardName}] 警告：${msg}`);
}

// 依「、」切分商家清單，但括號內的「、」不切（例：「日本三大交通卡(SUICA、PASMO、ICOCA)儲值」要
// 保持為單一項目，不能被拆成三項）。官方頁面的指定通路清單皆以全形頓號分隔逐一列舉。
function splitMerchants(str) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(' || ch === '（') depth++;
    if (ch === ')' || ch === '）') depth--;
    if (ch === '、' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// 抓「標籤：項目、項目、項目」這種官方逐行列舉清單的一段文字，回傳 { 標籤: [項目...] } 的物件。
// labels 是要抓的標籤陣列（依官方頁面上出現的順序），每個標籤各自佔一行，直到下一個換行結束。
function parseLabelledLists(text, labels) {
  const out = {};
  for (const label of labels) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '：([^\\n]*)\\n');
    const m = text.match(re);
    out[label] = m ? splitMerchants(m[1]) : [];
  }
  return out;
}

function scrapeDualCurrency(text) {
  const rewards = [];
  const plans = [];

  // 基本回饋：「幣倍卡新增一般消費享國內1%、國外2%現金回饋無上限」
  {
    const m = text.match(/一般消費享國內(\d+(?:\.\d+)?)%、國外(\d+(?:\.\d+)?)%現金回饋無上限/);
    if (m) {
      const idx = text.indexOf(m[0]);
      const validUntil = parseSlashDateRangeEnd(text, idx);
      rewards.push({ category: 'general', pct: parseFloat(m[1]), validUntil, note: '國內一般消費，無上限' });
      rewards.push({
        category: 'overseas',
        pct: parseFloat(m[2]),
        validUntil,
        note: '國外一般消費，回饋存入外幣帳戶，無上限',
      });
    } else {
      warn('幣倍卡', '找不到「一般消費享國內X%、國外X%現金回饋無上限」，略過基本回饋');
    }
  }
  // 保費代繳：「代繳保費(含壽險+產險) 享1.2%現金回饋無上限」
  {
    const m = text.match(/代繳保費[^。]*?享(\d+(?:\.\d+)?)%現金回饋無上限/);
    if (m) {
      const idx = text.indexOf(m[0]);
      rewards.push({
        category: 'insurance',
        pct: parseFloat(m[1]),
        validUntil: parseSlashDateRangeEnd(text, idx),
        note: '代繳保費（含壽險、產險），無上限',
      });
    }
  }
  if (rewards.length) {
    plans.push({ id: 'default', name: '一般消費（無條件）', condition: '無條件', rewards });
  }

  // 精選通路加碼：「精選通路加碼4%現金回饋（上限800元/帳單週期）」，通路清單見官方原文
  // 「國外實體：...」「網購消費：...」「旅遊通路：...」三行（詳檔頭 v2 說明）
  {
    const m = text.match(/精選通路加碼(\d+(?:\.\d+)?)%現金回饋（上限(\d+)元\/帳單週期）/);
    if (m) {
      const idx = text.indexOf(m[0]);
      const validUntil = parseSlashDateRangeEnd(text, idx);
      const pct = parseFloat(m[1]);
      const cap = `每帳單週期上限NT$${m[2]}（與精選通路其他子項共用）`;
      const condition =
        '需完成永豐台外幣帳戶自動扣繳＋電子/行動帳單設定，且前月往來資產規模達新臺幣10萬元以上或當月為大戶／大戶Plus等級';
      const lists = parseLabelledLists(text, ['國外實體', '網購消費', '旅遊通路']);
      const rewards = [];
      if (lists['旅遊通路'].length) {
        rewards.push({
          category: 'travel',
          pct,
          merchants: lists['旅遊通路'],
          merchantsComplete: true,
          cap,
          validUntil,
          note: '旅遊通路加碼（官方逐一列舉之完整清單，含航空公司/旅行社/訂房平台/機場停車）',
        });
      }
      if (lists['網購消費'].length) {
        rewards.push({
          category: 'online',
          pct,
          merchants: lists['網購消費'],
          merchantsComplete: true,
          cap,
          validUntil,
          note: '網購消費通路加碼（官方逐一列舉之完整清單，含海外藥妝與交通卡儲值）',
        });
      }
      // 「國外實體」為概括式描述（交易地區非臺灣且非新臺幣之實體商店），非官方逐一列舉的商家清單，
      // 依 SCHEMA 規則 3(a) 不填 merchants
      rewards.push({
        category: 'overseas',
        pct,
        cap,
        validUntil,
        note: `國外實體消費加碼：${lists['國外實體'].join('、') || '交易地區非臺灣且非新臺幣之實體商店一般消費'}，屬概括式描述非限定商店清單`,
      });
      plans.push({ id: 'select-channel-bonus', name: '精選通路加碼', condition, rewards });
    } else {
      warn('幣倍卡', '找不到精選通路加碼 4% 文字，略過此 plan');
    }
  }

  // 新申辦指定行動支付加碼：「Apple Pay、Google Pay加碼2%現金回饋（上限200元/消費月份）」
  {
    const m = text.match(/Apple Pay、Google Pay加碼(\d+(?:\.\d+)?)%現金回饋（上限(\d+)元\/消費月份）/);
    if (m) {
      const idx = text.indexOf(m[0]);
      plans.push({
        id: 'new-applicant-mobilepay',
        name: '新申辦指定行動支付加碼',
        condition: '活動期間內新申辦永豐幣倍卡（含既有卡友加辦不同幣別）',
        rewards: [
          {
            category: 'mobilepay',
            pct: parseFloat(m[1]),
            merchants: ['Apple Pay', 'Google Pay'],
            merchantsComplete: true,
            cap: `每消費月份上限NT$${m[2]}`,
            validUntil: parseSlashDateRangeEnd(text, idx),
          },
        ],
      });
    }
  }

  // 新戶首刷：「享最高20%刷卡金回饋(回饋上限500元)」
  {
    const m = text.match(/享最高(\d+(?:\.\d+)?)%刷卡金回饋\(回饋上限(\d+)元\)/);
    if (m) {
      const idx = text.indexOf(m[0]);
      plans.push({
        id: 'new-customer',
        name: '新戶首刷指定行動支付',
        condition: '新戶（從未持有永豐信用卡或停卡滿6個月），核卡後30日內綁定指定行動支付',
        rewards: [
          {
            category: 'mobilepay',
            pct: parseFloat(m[1]),
            merchants: ['LINE Pay', 'Apple Pay', 'Google Pay', 'Samsung Pay', '全支付', '55688 APP', 'Mitsui Shopping Park Pay'],
            merchantsComplete: true,
            cap: `單筆最高NT$${m[2]}，回饋為刷卡金非現金回饋，回饋名額5,200名（額滿為止）`,
            validUntil: parseSlashDateRangeEnd(text, idx),
          },
        ],
      });
    }
  }

  if (!plans.length) throw new Error('幣倍卡：所有 plan 解析失敗');
  return {
    id: 'sinopac-dual-currency',
    name: '永豐幣倍卡',
    url: URLS.dual,
    planKind: 'tier',
    plans,
  };
}

function scrapeDawho(text) {
  const plans = [];

  // 基礎：「【一般消費】國內1%、國外2% 現金回饋無上限」
  const baseM = text.match(/【一般消費】國內(\d+(?:\.\d+)?)%、國外(\d+(?:\.\d+)?)%\s*現金回饋無上限/);
  const baseDomestic = baseM ? parseFloat(baseM[1]) : null;
  const baseOverseas = baseM ? parseFloat(baseM[2]) : null;
  if (!baseM) warn('DAWHO', '找不到一般消費基礎回饋文字');

  // 加總句：「國內消費最高5%、國外消費最高6%現金回饋」
  const summaryM = text.match(/國內消費最高(\d+(?:\.\d+)?)%、國外消費最高(\d+(?:\.\d+)?)%現金回饋/);
  const validUntilGlobal = summaryM ? parseSlashDateRangeEnd(text, text.indexOf(summaryM[0])) : null;

  // 指定任務加碼：「大戶Plus等級加碼4%，回饋上限NT$1,000/月帳單週期、大戶等級加碼2.5%，回饋上限NT$400/月帳單週期」
  const taskM = text.match(
    /大戶Plus等級加碼(\d+(?:\.\d+)?)%，回饋上限NT\$([\d,]+)\/月帳單週期、大戶等級加碼(\d+(?:\.\d+)?)%，回饋上限NT\$([\d,]+)\/月帳單週期/
  );
  // 悠遊卡自動加值：「大戶Plus等級回饋5%，回饋上限NT$500/月帳單週期、大戶等級回饋3%，回饋上限NT$100/月帳單週期」
  const easycardM = text.match(
    /【悠遊卡自動加值】大戶Plus等級回饋(\d+(?:\.\d+)?)%，回饋上限NT\$([\d,]+)\/月帳單週期、大戶等級回饋(\d+(?:\.\d+)?)%，回饋上限NT\$([\d,]+)\/月帳單週期/
  );

  if (baseM) {
    plans.push({
      id: 'base',
      name: '數位帳戶基礎方案',
      condition: '需持有DAWHO數位帳戶',
      rewards: [
        { category: 'general', pct: baseDomestic, validUntil: validUntilGlobal, note: '國內一般消費，無上限' },
        { category: 'overseas', pct: baseOverseas, validUntil: validUntilGlobal, note: '國外一般消費，無上限' },
      ],
    });
  }

  if (summaryM && taskM) {
    const plusTaskPct = parseFloat(taskM[1]);
    const plusTaskCap = taskM[2];
    plans.push({
      id: 'dawho-plus',
      name: '大戶Plus加碼方案',
      condition: '持有DAWHO數位帳戶且達成指定任務（大戶Plus等級）',
      rewards: [
        {
          category: 'general',
          pct: parseFloat(summaryM[1]),
          cap: `月帳單上限NT$${plusTaskCap}（任務加碼部分，不含悠遊卡自動加值）`,
          validUntil: validUntilGlobal,
          note: `官網標示國內最高${summaryM[1]}%；為基礎${baseDomestic}%+任務加碼${plusTaskPct}%`,
        },
        {
          category: 'overseas',
          pct: parseFloat(summaryM[2]),
          cap: `月帳單上限NT$${plusTaskCap}（任務加碼部分，不含悠遊卡自動加值）`,
          validUntil: validUntilGlobal,
          note: `官網標示國外最高${summaryM[2]}%；為基礎${baseOverseas}%+任務加碼${plusTaskPct}%`,
        },
      ],
    });
    if (easycardM) {
      plans[plans.length - 1].rewards.push({
        category: 'transport',
        pct: parseFloat(easycardM[1]),
        cap: `每月帳單上限NT$${easycardM[2]}`,
        validUntil: validUntilGlobal,
        note: '悠遊卡自動加值加碼（大戶Plus等級）',
      });
    }
  }

  if (taskM) {
    const stdTaskPct = parseFloat(taskM[3]);
    const stdTaskCap = taskM[4];
    if (baseM) {
      plans.push({
        id: 'dawho-standard',
        name: '大戶加碼方案',
        condition: '持有DAWHO數位帳戶且達成指定任務（大戶等級）',
        rewards: [
          {
            category: 'general',
            pct: parseFloat((baseDomestic + stdTaskPct).toFixed(2)),
            cap: `月帳單上限NT$${stdTaskCap}（任務加碼部分，不含悠遊卡自動加值）`,
            validUntil: validUntilGlobal,
            note: `官網未直接標示加總後%；為基礎${baseDomestic}%+任務加碼${stdTaskPct}%程式加總，非官網逐字引用`,
          },
          {
            category: 'overseas',
            pct: parseFloat((baseOverseas + stdTaskPct).toFixed(2)),
            cap: `月帳單上限NT$${stdTaskCap}（任務加碼部分，不含悠遊卡自動加值）`,
            validUntil: validUntilGlobal,
            note: `官網未直接標示加總後%；為基礎${baseOverseas}%+任務加碼${stdTaskPct}%程式加總，非官網逐字引用`,
          },
        ],
      });
      if (easycardM) {
        const stdEasy = parseFloat(easycardM[3]);
        plans[plans.length - 1].rewards.push({
          category: 'transport',
          pct: stdEasy,
          cap: `每月帳單上限NT$${easycardM[4]}`,
          validUntil: validUntilGlobal,
          note: '悠遊卡自動加值加碼（大戶等級）',
        });
      }
    }
  }

  // 新戶首刷
  {
    const m = text.match(/享最高(\d+(?:\.\d+)?)%刷卡金回饋\(回饋上限(\d+)元\)/);
    if (m) {
      const idx = text.indexOf(m[0]);
      plans.push({
        id: 'new-customer',
        name: '新戶首刷指定行動支付',
        condition: '新戶限定，核卡後30日內綁定指定行動支付',
        rewards: [
          {
            category: 'mobilepay',
            pct: parseFloat(m[1]),
            merchants: ['LINE Pay', 'Apple Pay', 'Google Pay', 'Samsung Pay', '全支付', '55688 APP', 'Mitsui Shopping Park Pay'],
            merchantsComplete: true,
            cap: `單筆最高NT$${m[2]}，回饋為刷卡金非現金回饋，回饋名額10,000名（額滿為止）`,
            validUntil: parseSlashDateRangeEnd(text, idx),
          },
        ],
      });
    }
  }

  if (!plans.length) throw new Error('DAWHO：所有 plan 解析失敗');
  return {
    id: 'sinopac-dawho',
    name: 'DAWHO現金回饋信用卡',
    url: URLS.dawho,
    planKind: 'tier',
    plans,
  };
}

function scrapeSport(text) {
  const plans = [];

  // 「一般消費最高享2%豐點，指定支付/通路享最高5%豐點」
  const summaryM = text.match(/一般消費最高享(\d+(?:\.\d+)?)%豐點，指定支付\/通路享最高(\d+(?:\.\d+)?)%豐點/);
  const validUntil = summaryM ? parseSlashDateRangeEnd(text, text.indexOf(summaryM[0])) : null;

  // 「卡片基本回饋1%(含0.3%+電子化帳單加碼0.7%)、運動獎勵+1%、指定支付/通路+3%」
  const breakdownM = text.match(
    /基本回饋(\d+(?:\.\d+)?)%\(含(\d+(?:\.\d+)?)%\+電子化帳單加碼(\d+(?:\.\d+)?)%\)、運動獎勵\+(\d+(?:\.\d+)?)%、指定支付\/通路\+(\d+(?:\.\d+)?)%/
  );

  if (breakdownM) {
    const baseNoStatement = parseFloat(breakdownM[2]);
    const baseWithStatement = parseFloat(breakdownM[1]);
    plans.push({
      id: 'base',
      name: '基礎豐點回饋',
      condition: '需下載註冊大咖DACARD APP並串接運動數據；完成電子/行動帳單設定才達滿額',
      rewards: [
        {
          category: 'general',
          pct: baseWithStatement,
          validUntil,
          note: `豐點回饋換算；未設定電子/行動帳單僅${baseNoStatement}%，設定後為${baseWithStatement}%`,
        },
      ],
    });
    if (summaryM) {
      plans.push({
        id: 'exercise-bonus',
        name: '運動獎勵加碼',
        condition: '當月累積10,000大卡或Apple Watch圓滿畫圈10次，且設定永豐/京城銀行帳戶自動扣繳',
        rewards: [
          {
            category: 'general',
            pct: parseFloat(summaryM[1]),
            validUntil,
            note: `豐點回饋換算；基礎${baseWithStatement}%+運動獎勵加碼${breakdownM[4]}%`,
          },
        ],
      });
      const channelPct = parseFloat(summaryM[2]);
      // 官方原文以「行動支付：」「運動健身：」「醫藥保健：」「電競娛樂：」四行列出「指定支付／通路」
      // 完整清單（詳檔頭 v2 說明），逐行拆出後各自建立一筆 reward
      const channelLists = parseLabelledLists(text, ['運動健身', '醫藥保健', '電競娛樂']);
      // 「行動支付：一般消費綁定Apple Pay／Google Pay／Samsung Pay／Garmin Pay支付」句型特殊
      // （用「／」分隔且無「、」，parseLabelledLists 的頓號切分法不適用），另外用專屬 regex 解析
      const mobilePayM = text.match(/行動支付：.*?綁定(.+?)支付\n/);
      const mobilePay = mobilePayM ? mobilePayM[1].split('／').map((s) => s.trim()) : [];
      const rewards = [];
      if (mobilePay.length) {
        rewards.push({
          category: 'mobilepay',
          pct: channelPct,
          merchants: mobilePay,
          merchantsComplete: true,
          validUntil,
          note: `豐點回饋換算；基礎+運動獎勵${summaryM[1]}%+指定支付加碼${breakdownM[5]}%；指定行動支付綁定消費`,
        });
      }
      if (channelLists['運動健身'].length) {
        rewards.push({
          category: 'entertainment',
          pct: channelPct,
          merchants: channelLists['運動健身'],
          merchantsComplete: true,
          validUntil,
          note: '運動健身通路加碼；官網無「健身房」對應類別，暫歸類 entertainment，請以官網為準',
        });
      }
      if (channelLists['電競娛樂'].length) {
        rewards.push({
          category: 'entertainment',
          pct: channelPct,
          merchants: channelLists['電競娛樂'],
          merchantsComplete: true,
          validUntil,
          note: '電競娛樂通路加碼',
        });
      }
      if (channelLists['醫藥保健'].length) {
        rewards.push({
          category: 'medical',
          pct: channelPct,
          merchants: channelLists['醫藥保健'],
          merchantsComplete: true,
          validUntil,
          note: '醫藥保健通路加碼',
        });
      }
      if (rewards.length) {
        plans.push({
          id: 'designated-channel',
          name: '指定支付／通路加碼',
          condition: '同運動獎勵加碼條件達成後，再疊加指定支付/通路',
          rewards,
        });
      } else {
        warn('SPORT卡', '找不到指定支付／通路的官方通路清單，略過此 plan');
      }
    }
  } else {
    warn('SPORT卡', '找不到基本回饋分解句，略過基礎/加碼 plan');
  }

  // 新戶首刷
  {
    const m = text.match(/享最高(\d+(?:\.\d+)?)%刷卡金回饋\(回饋上限(\d+)元\)/);
    if (m) {
      const idx = text.indexOf(m[0]);
      plans.push({
        id: 'new-customer',
        name: '新戶首刷指定行動支付',
        condition: '新戶限定，核卡後30日內綁定指定行動支付',
        rewards: [
          {
            category: 'mobilepay',
            pct: parseFloat(m[1]),
            merchants: ['LINE Pay', 'Apple Pay', 'Google Pay', 'Samsung Pay', '全支付', '55688 APP', 'Mitsui Shopping Park Pay'],
            merchantsComplete: true,
            cap: `單筆最高NT$${m[2]}，回饋為刷卡金非現金回饋，回饋名額1,800名（額滿為止）`,
            validUntil: parseSlashDateRangeEnd(text, idx),
          },
        ],
      });
    }
  }

  if (!plans.length) throw new Error('SPORT卡：所有 plan 解析失敗');
  return {
    id: 'sinopac-sport',
    name: '永豐SPORT卡',
    url: URLS.sport,
    planKind: 'tier',
    plans,
  };
}

async function scrape() {
  const cards = [];
  const scrapers = [
    { key: 'dual', url: URLS.dual, fn: scrapeDualCurrency },
    { key: 'dawho', url: URLS.dawho, fn: scrapeDawho },
    { key: 'sport', url: URLS.sport, fn: scrapeSport },
  ];
  for (const s of scrapers) {
    try {
      const text = await fetchText(s.url);
      cards.push(s.fn(text));
    } catch (e) {
      console.error(`  [sinopac] ${s.key} 抓取/解析失敗：${e.message}`);
    }
    await sleep(1200);
  }
  return {
    id: 'sinopac',
    name: '永豐銀行',
    cards,
  };
}

module.exports = { scrape };
