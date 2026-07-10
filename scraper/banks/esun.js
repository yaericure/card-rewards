// 玉山銀行（esun）信用卡回饋爬蟲 — v2 改版（商店優先：見 ../../data/SCHEMA.md）
//
// v2 改版重點（相對 v1 的差異）：
//   v1 只在少數 reward 附了「範例商店」（如 e-card 的「里仁/棉花田/聖德科斯/主婦聯盟」），
//   Unicard 的「百大指定消費」加碼完全沒有商店清單（只有 category:'online' + cap）。
//   v2 規則：官方公告的完整指定通路清單（Unicard「百大指定消費列表」、e-card 各版本的
//   「指定百貨/美妝」「指定咖啡/支付」「指定類別」清單）必須逐家收錄，並標 merchantsComplete。
//
// 來源 URL（2026-07-10 人工核對過結構，之後若改版需重新核對）：
//   - 玉山數位e卡：https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/e-card
//   - 玉山Unicard： https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/unicard
//   - 玉山鈦金卡：  https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/titanium-card
//   - 玉山Pi拍錢包信用卡：https://www.esunbank.com/zh-tw/personal/credit-card/intro/co-branded-card/pi-card
//   - 玉山U Bear信用卡： https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/u-bear
//
// 解析假設（2026-07-10 實測）：
//   - 這五頁都是「靜態伺服器渲染」頁面（fetch 拿到的 HTML 已含完整行銷文案），不需要 playwright。
//   - Unicard「百大指定消費列表」（2026/7/1~2026/12/31 適用）在頁面上以「類別標籤」＋
//     「緊接一行、以、分隔的完整商店清單」的固定 pattern 連續出現 9 組（行動支付/電商平台/
//     國內百貨/生活採買/餐飲美食/加油交通/航空旅遊/國外實體/精選商家/ESG消費，其中「國外實體」
//     列的是國家不是商店，故該組不寫入 merchants，只在 note 說明），用逐行對照解析。
//     此清單為「UP選」「簡單選」皆涵蓋的完整範圍（差別只在加碼百分比與是否需訂閱）；
//     「任意選」是持卡人自行從此清單挑最多 8 家，故不把完整清單套用在「任意選」reward
//     （避免誤導成「任意選就能拿到全部清單的加碼」），只在 condition 說明其選店範圍同此清單。
//   - e-card 官網把「消費e起GO」（0.5%基本回饋，兩版共用）、「環保有機e起來」（指定類別加碼，
//     兩版共用）、「輕時尚版」專屬（指定百貨/美妝）、「寵生活版」專屬（指定咖啡/支付）
//     四個活動區塊分開列，各自完整列出商店清單（無需展開彈窗或 PDF）。玉山數位e卡有
//     兩種卡面（輕時尚版／寵生活版），持卡人核卡時只能選一種，故建為同一張卡下的兩個 plan
//     （非可切換），plans[].id 對應版本。
//   - Unicard 頁面清楚列出「僅帳單e化」vs「帳單e化＋自動扣繳」兩種一般消費回饋率（0.3% vs 1%），
//     這是 SCHEMA 要求的「方案／等級差異」範例；百大指定消費三方案（簡單選2%/任意選2.5%/UP選3.5%）
//     皆併入「帳單e化＋自動扣繳」方案的 rewards，並在 note 說明各方案差異。
//     Unicard 的多方案是「持卡人可自行申辦切換」的門檻差異（非資格分級），card.planKind 標 switchable。
//   - Pi拍錢包信用卡／U Bear信用卡皆只有單一常態方案（回饋率隨帳單e化/自動扣繳/消費滿額而變動，
//     屬同一方案內的條件差異，非可切換的多方案／多等級），故不需 card.planKind，比照鈦金卡模式
//     用單一 plan、把條件寫進 note。頁面上另有「新戶限定」加碼活動（僅新戶、時限申辦期間，
//     如 U Bear 的「指定五大通路加碼10%」），官方文字明講只是範例（如「等」字結尾）且僅新戶適用，
//     不確定所有使用者都適用，故不納入 rewards，只在模組註解記錄、不寫入資料。
//   - 點數換算（皆為頁面原文所載）：玉山e point / Pi拍錢包P幣 / U Bear現金回饋皆為官網文案
//     已講清楚等值百分比的點數/現金制，不需要額外換算，只在 note 註明點數型態（1點=1元）。
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

// 保留換行的版本（Unicard 百大指定消費列表需要逐行對照解析）
function rawTextOf(html) {
  const $ = cheerio.load(html);
  $('script,style').remove();
  return $('body')
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
// 攤平成單行的版本（大部分 regex 用這個，較不受換行位置影響）
function textOf(html) {
  return rawTextOf(html).replace(/\s+/g, ' ');
}
function toLines(text) {
  return text.split('\n').map((s) => s.trim());
}
function isoSlash(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// 依分隔字元拆商店清單，但不拆括號內的內容（例：「55688(台灣大車隊、機場接送)」是 1 家商店，
// 括號內的頓號是附註不是分隔符）。支援半形/全形括號。
function splitMerchantList(str, delimiter = '、') {
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

async function scrapeECard() {
  const html = await fetchHtml(URLS.ecard);
  const flat = textOf(html);
  const cards = [];

  const basePeriod = flat.match(/消費e起GO 活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const base = flat.match(/國內外一般消費享(\d+(?:\.\d+)?)%玉山e ?point回饋，需同時申請帳單e化及玉山銀行臺幣帳戶自動扣繳卡費/);
  const baseReward = base
    ? {
        category: 'general',
        pct: parseFloat(base[1]),
        note: '玉山e point點數回饋（1點=1元）；需同時申請帳單e化及玉山銀行臺幣帳戶自動扣繳卡費',
      }
    : null;
  if (baseReward && basePeriod) {
    baseReward.validFrom = isoSlash(basePeriod[1], basePeriod[2], basePeriod[3]);
    baseReward.validUntil = isoSlash(basePeriod[4], basePeriod[5], basePeriod[6]);
  }

  const ecoPeriod = flat.match(/環保、有機e起來 活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const ecoPct = flat.match(/指定類別消費登錄最高享(\d+(?:\.\d+)?)%玉山e ?point回饋\(含基本回饋([\d.]+)%\+指定類別消費加碼([\d.]+)%\)/);
  const ecoOnline = flat.match(/網路消費：([^。]+)。/);
  const ecoBoth = flat.match(/網路消費\+實體消費：([^。]+)。/);
  const ecoCap = flat.match(/加碼([\d.]+)%歸戶每期回饋上限(\d+)點/);
  const ecoRewards = [];
  if (ecoPct) {
    const validFrom = ecoPeriod ? isoSlash(ecoPeriod[1], ecoPeriod[2], ecoPeriod[3]) : undefined;
    const validUntil = ecoPeriod ? isoSlash(ecoPeriod[4], ecoPeriod[5], ecoPeriod[6]) : undefined;
    const cap = ecoCap ? `加碼${ecoCap[1]}%歸戶每期回饋上限${ecoCap[2]}點（玉山e point）` : undefined;
    if (ecoOnline) {
      ecoRewards.push({
        category: 'transport',
        pct: parseFloat(ecoPct[1]),
        merchants: splitMerchantList(ecoOnline[1]),
        merchantsComplete: true,
        cap,
        validFrom,
        validUntil,
        note: `玉山e point點數回饋；環保有機e起來【網路消費】類（含基本回饋${ecoPct[2]}%＋加碼${ecoPct[3]}%）；需同時申請帳單e化及自動扣繳卡費；來源：${URLS.ecard}`,
      });
    }
    if (ecoBoth) {
      ecoRewards.push({
        category: 'supermarket',
        pct: parseFloat(ecoPct[1]),
        merchants: splitMerchantList(ecoBoth[1]),
        merchantsComplete: true,
        cap,
        validFrom,
        validUntil,
        note: `玉山e point點數回饋；環保有機e起來【網路+實體消費】類（含基本回饋${ecoPct[2]}%＋加碼${ecoPct[3]}%）；僅限開立該店發票之門市，需同時申請帳單e化及自動扣繳卡費；來源：${URLS.ecard}`,
      });
    }
  }

  // 輕時尚版：消費e起GO + 環保有機e起來 + 指定百貨/美妝
  const lightPeriod = flat.match(/輕時尚版 專屬優惠 活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const lightPct = flat.match(/指定百貨\/美妝通路消費最高享(\d+(?:\.\d+)?)%玉山e ?point回饋\(含基本回饋([\d.]+)%\+指定百貨\/美妝加碼([\d.]+)%\)/);
  const lightMall = flat.match(/指定百貨消費包含：([^。]+)。/);
  const lightBeauty = flat.match(/指定美妝消費包含：([^。]+)。/);
  const lightRewards = [];
  if (baseReward) lightRewards.push({ ...baseReward });
  lightRewards.push(...ecoRewards.map((r) => ({ ...r })));
  if (lightPct && (lightMall || lightBeauty)) {
    const validFrom = lightPeriod ? isoSlash(lightPeriod[1], lightPeriod[2], lightPeriod[3]) : undefined;
    const validUntil = lightPeriod ? isoSlash(lightPeriod[4], lightPeriod[5], lightPeriod[6]) : undefined;
    const merchants = [
      ...(lightMall ? splitMerchantList(lightMall[1]) : []),
      ...(lightBeauty ? splitMerchantList(lightBeauty[1]) : []),
    ].filter(Boolean);
    lightRewards.push({
      category: 'department',
      pct: parseFloat(lightPct[1]),
      merchants,
      merchantsComplete: true,
      cap: `加碼${lightPct[3]}%歸戶每期回饋上限250點（玉山e point）`,
      validFrom,
      validUntil,
      note: `玉山e point點數回饋；【輕時尚版】指定百貨/美妝通路（含基本回饋${lightPct[2]}%＋加碼${lightPct[3]}%）；除特別標註外僅限實體消費並以玉山Wallet/Apple Pay/Google Pay/Garmin Pay/Fitbit Pay/Samsung Pay支付；需同時申請帳單e化及自動扣繳卡費；來源：${URLS.ecard}`,
    });
  }
  if (lightRewards.length) {
    cards.push({
      id: 'esun-ecard',
      name: '玉山數位e卡',
      url: URLS.ecard,
      planKind: 'tier',
      plans: [{ id: 'light', name: '輕時尚版', condition: '核卡時選擇輕時尚版卡面；需同時申請帳單e化及玉山銀行臺幣帳戶自動扣繳卡費', rewards: lightRewards }],
    });
  }

  // 寵生活版：消費e起GO + 環保有機e起來 + 指定咖啡/支付
  const petPeriod = flat.match(/寵生活版 專屬優惠 活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const petPct = flat.match(/指定咖啡\/支付通路消費最高享(\d+(?:\.\d+)?)%玉山e ?point回饋\(含基本回饋([\d.]+)%\+指定咖啡\/支付加碼([\d.]+)%\)/);
  const petCoffee = flat.match(/指定咖啡消費包含：([^。]+)。/);
  const petPay = flat.match(/指定支付消費包含：([^。]+?)(?:\(政府服務[^)]*\))?。/);
  const petRewards = [];
  if (baseReward) petRewards.push({ ...baseReward });
  petRewards.push(...ecoRewards.map((r) => ({ ...r })));
  if (petPct && (petCoffee || petPay)) {
    const validFrom = petPeriod ? isoSlash(petPeriod[1], petPeriod[2], petPeriod[3]) : undefined;
    const validUntil = petPeriod ? isoSlash(petPeriod[4], petPeriod[5], petPeriod[6]) : undefined;
    if (petCoffee) {
      petRewards.push({
        category: 'dining',
        pct: parseFloat(petPct[1]),
        merchants: splitMerchantList(petCoffee[1]),
        merchantsComplete: true,
        cap: `加碼${petPct[3]}%歸戶每期回饋上限250點（玉山e point）`,
        validFrom,
        validUntil,
        note: `玉山e point點數回饋；【寵生活版】指定咖啡通路（含基本回饋${petPct[2]}%＋加碼${petPct[3]}%）；僅限開立該店發票之門市；來源：${URLS.ecard}`,
      });
    }
    if (petPay) {
      petRewards.push({
        category: 'mobilepay',
        pct: parseFloat(petPct[1]),
        merchants: splitMerchantList(petPay[1]),
        merchantsComplete: true,
        cap: `加碼${petPct[3]}%歸戶每期回饋上限250點（玉山e point）`,
        validFrom,
        validUntil,
        note: `玉山e point點數回饋；【寵生活版】指定支付通路（含基本回饋${petPct[2]}%＋加碼${petPct[3]}%）；於超商/政府服務/學校服務等非一般消費通路不適用加碼；來源：${URLS.ecard}`,
      });
    }
  }
  if (petRewards.length) {
    cards.push({
      id: 'esun-ecard',
      name: '玉山數位e卡',
      url: URLS.ecard,
      planKind: 'tier',
      plans: [{ id: 'pet', name: '寵生活版', condition: '核卡時選擇寵生活版卡面；需同時申請帳單e化及玉山銀行臺幣帳戶自動扣繳卡費', rewards: petRewards }],
    });
  }

  if (!cards.length) {
    console.error('esun: e-card 頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }
  // 兩版合併成同一張卡的兩個 plan
  return {
    id: 'esun-ecard',
    name: '玉山數位e卡',
    url: URLS.ecard,
    planKind: 'tier',
    plans: cards.flatMap((c) => c.plans),
  };
}

async function scrapeUnicard() {
  const html = await fetchHtml(URLS.unicard);
  const raw = rawTextOf(html);
  const flat = raw.replace(/\s+/g, ' ');
  const L = toLines(raw);

  const ebillOnly = flat.match(/一般消費享(\d+(?:\.\d+)?)%\s*玉山e ?point回饋，需申辦帳單e化/);
  const ebillAutopay = flat.match(
    /一般消費享(\d+(?:\.\d+)?)%\s*玉山e ?point回饋，需同時申辦帳單e化及申辦玉山銀行臺幣帳戶自動扣繳/
  );
  const listPeriod = flat.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})適用百大指定消費列表如下/);
  const validFrom = listPeriod ? isoSlash(listPeriod[1], listPeriod[2], listPeriod[3]) : undefined;
  const validUntil = listPeriod ? isoSlash(listPeriod[4], listPeriod[5], listPeriod[6]) : undefined;
  const tierPct = flat.match(/百大指定消費加碼回饋以分期交易總金額計算1次\(簡單選([\d.]+)%、任意選([\d.]+)%、UP選([\d.]+)%\)/);
  const capMatch = flat.match(/百大指定消費[^(]*\(每月回饋上限([\d,]+)點\)/);
  const cap = capMatch ? `每月回饋上限${capMatch[1]}點（玉山e point，正附卡合併）` : '每月回饋上限5,000點（玉山e point，正附卡合併）';

  // 百大指定消費列表：類別 label + 緊接一行「、」分隔清單，連續 9 組
  const CATEGORY_MAP = {
    行動支付: 'mobilepay',
    電商平台: 'online',
    國內百貨: 'department',
    生活採買: 'department',
    餐飲美食: 'delivery',
    加油交通: 'gas',
    航空旅遊: 'travel',
    國外實體: 'overseas',
    精選商家: 'department',
    ESG消費: 'general',
  };
  const listStart = L.indexOf('類別', L.indexOf('百大指定消費列表'));
  const listEnd = L.findIndex((l, i) => i > listStart && l.includes('百大指定消費列表注意事項'));
  const groups = [];
  if (listStart >= 0) {
    let i = listStart + 2; // 跳過「類別」「指定百大指定消費」表頭
    while (i < (listEnd > 0 ? listEnd : L.length) - 1) {
      const label = L[i];
      const content = L[i + 1];
      if (!label || !CATEGORY_MAP[label]) break;
      groups.push({ label, category: CATEGORY_MAP[label], merchants: splitMerchantList(content) });
      i += 2;
    }
  }
  const upMerchantRewards = (pct, planTag) =>
    groups
      .filter((g) => g.label !== '國外實體')
      .map((g) => ({
        category: g.category,
        pct,
        merchants: g.merchants,
        merchantsComplete: true,
        cap,
        validFrom,
        validUntil,
        note: `玉山e point點數回饋（1點=1元）；百大指定消費【${g.label}】${planTag}加碼；來源：${URLS.unicard}`,
      }))
      .concat(
        groups.some((g) => g.label === '國外實體')
          ? [
              {
                category: 'overseas',
                pct,
                cap,
                validFrom,
                validUntil,
                note: `玉山e point點數回饋；百大指定消費【國外實體】${planTag}加碼；指定國家：${groups.find((g) => g.label === '國外實體').merchants.join('、')}（為國家非商店，故不列入merchants）；來源：${URLS.unicard}`,
              },
            ]
          : []
      );

  const plans = [];
  if (ebillOnly) {
    plans.push({
      id: 'ebill-only',
      name: '僅申辦帳單e化',
      condition: '僅申辦帳單e化（Email電子帳單或簡訊帳單），適用「簡單選」百大指定消費（全部涵蓋，加碼較低）',
      rewards: [
        { category: 'general', pct: parseFloat(ebillOnly[1]), note: '玉山e point點數回饋（1點=1元）' },
        ...(tierPct && groups.length ? upMerchantRewards(parseFloat(tierPct[1]), '簡單選（預設方案，涵蓋全部100項）') : []),
      ],
    });
  }
  if (ebillAutopay) {
    const rewards = [{ category: 'general', pct: parseFloat(ebillAutopay[1]), note: '玉山e point點數回饋（1點=1元），回饋無上限' }];
    if (tierPct && groups.length) {
      rewards.push(...upMerchantRewards(parseFloat(tierPct[3]), 'UP選（訂閱後涵蓋全部100項，需符合免費訂閱任務或以149點升級）'));
    }
    plans.push({ id: 'ebill-autopay', name: '帳單e化＋臺幣帳戶自動扣繳（UP選）', condition: '需同時申辦帳單e化及玉山銀行臺幣帳戶自動扣繳卡費；並訂閱「UP選」方案', rewards });

    if (tierPct) {
      plans.push({
        id: 'ebill-autopay-choice8',
        name: '帳單e化＋臺幣帳戶自動扣繳（任意選）',
        condition: `需同時申辦帳單e化及玉山銀行臺幣帳戶自動扣繳卡費；「任意選」需自行從百大指定消費清單中最多選8家，每月可切換，本店家範圍與「UP選」相同（見 esun-unicard 卡「帳單e化＋臺幣帳戶自動扣繳（UP選）」plan 之 merchants），僅實際生效的最多8家可享加碼，不等同全清單皆適用`,
        rewards: [
          { category: 'general', pct: parseFloat(ebillAutopay[1]), note: '玉山e point點數回饋（1點=1元），回饋無上限' },
          {
            category: 'general',
            pct: parseFloat(tierPct[2]),
            cap,
            validFrom,
            validUntil,
            note: `玉山e point點數回饋；百大指定消費「任意選」加碼，需自行指定最多8家（範圍同百大指定消費列表），故不列出merchants以免誤導為全清單適用；來源：${URLS.unicard}`,
          },
        ],
      });
    }
  }

  if (!plans.length) {
    console.error('esun: unicard 頁面抓不到任何回饋數字，跳過此卡');
    return null;
  }

  return { id: 'esun-unicard', name: '玉山Unicard', url: URLS.unicard, planKind: 'switchable', plans };
}

async function scrapeTitanium() {
  const html = await fetchHtml(URLS.titanium);
  const text = textOf(html);
  // 注意：頁面 <script type="application/ld+json"> 的 meta 描述可能殘留舊版文案，
  // 已透過移除 script/style 節點避開；實際內文（含活動期間）以內文為準。
  const period = text.match(/活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
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
    reward.validFrom = isoSlash(period[1], period[2], period[3]);
    reward.validUntil = isoSlash(period[4], period[5], period[6]);
  }
  return {
    id: 'esun-titanium',
    name: '玉山幸運鈦金卡',
    url: URLS.titanium,
    plans: [{ id: 'default', name: '一般', condition: '無條件', rewards: [reward] }],
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

async function scrapePiCard() {
  const html = await fetchHtml(URLS.picard);
  const text = textOf(html);
  const rewards = [];

  const baseIdx = text.indexOf('基本回饋 1%P幣無上限');
  const base = near(text, baseIdx, /基本回饋 ?(\d+(?:\.\d+)?)%P幣無上限 ?\(需申請帳單e化，未申辦帳單e化者享(\d+(?:\.\d+)?)% ?P幣回饋無上限/);
  const basePeriod = near(text, text.indexOf('消費最高享'), /消費最高享 ?[\d.]+% P幣 活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const tier1 = near(
    text,
    text.indexOf('每月國內外一般消費累積滿10'),
    /每月國內外一般消費累積滿[\d,]+~[\d,]+元 ?加碼(\d+(?:\.\d+)?)%P幣，? ?最高(\d+(?:\.\d+)?)% ?P幣/
  );
  const tier2 = near(
    text,
    text.indexOf('每月國內外一般消費累積滿30'),
    /每月國內外一般消費累積滿[\d,]+元\(含\)以上 ?加碼(\d+(?:\.\d+)?)%P幣，? ?最高(\d+(?:\.\d+)?)% ?P幣 ?\(每月每歸戶上限([\d,]+) ?P幣\)/
  );

  if (base && basePeriod) {
    const validFrom = isoSlash(basePeriod[1], basePeriod[2], basePeriod[3]);
    const validUntil = isoSlash(basePeriod[4], basePeriod[5], basePeriod[6]);
    let note = `玉山Pi拍錢包P幣回饋（1 P幣=1元）；需申請帳單e化，未申辦帳單e化者僅${base[2]}%`;
    if (tier1 && tier2) {
      note += `；每月國內外一般消費累積滿NT$10,000~29,999加碼至最高${tier1[2]}%，滿NT$30,000(含)以上加碼至最高${tier2[2]}%（每月每歸戶上限${tier2[3]}P幣，需登錄活動）`;
    }
    rewards.push({ category: 'general', pct: parseFloat(base[1]), validFrom, validUntil, note });
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
      validFrom: isoSlash(insurance[2], insurance[3], insurance[4]),
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
      merchantsComplete: true,
      cap: famCap ? `每月每卡上限${famCap[1]} P幣` : undefined,
      validFrom: isoSlash(family[2], family[3], family[4]),
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
  const html = await fetchHtml(URLS.ubear);
  const text = textOf(html);
  const rewards = [];

  const baseIdx = text.indexOf('熊任務 基本回饋');
  const basePct = near(text, baseIdx, /國內外一般消費最高享 ?(\d+(?:\.\d+)?)%現金回饋/);
  const baseCond = near(text, baseIdx, /需\s*綁定帳單e化\s*或\s*申辦玉山銀行臺幣帳戶自動扣繳\s*享(\d+(?:\.\d+)?)%現金回饋，申辦上述兩者享(\d+(?:\.\d+)?)%現金回饋/);
  const basePeriod = near(text, baseIdx, /活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (basePct && baseCond && basePeriod) {
    rewards.push({
      category: 'general',
      pct: parseFloat(basePct[1]),
      validFrom: isoSlash(basePeriod[1], basePeriod[2], basePeriod[3]),
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
      validFrom: isoSlash(onlinePeriod[1], onlinePeriod[2], onlinePeriod[3]),
      validUntil: isoSlash(onlinePeriod[4], onlinePeriod[5], onlinePeriod[6]),
      note: '現金回饋；已含基本回饋1%＋網路消費加碼2%（加碼2%需綁定帳單e化），於當期帳單直接折抵；不限指定商店（行動支付/國內外線上消費/App綁卡付款皆適用，保費/超商/小額支付平台/指定數位訂閱平台除外）',
    });
  } else {
    console.error('esun: u-bear 頁面抓不到網路消費回饋數字，略過此 reward');
  }

  const streamIdx = text.indexOf('熊潮流');
  const streamPct = near(text, streamIdx, /指定數位訂閱平台消費最高享 ?(\d+(?:\.\d+)?)%現金回饋/);
  const streamList = near(text, streamIdx, /指定數位訂閱平台包含([^，。※]+?)(?:，需限於|。|※)/, 800);
  const streamCap = near(text, streamIdx, /每期回饋上限(\d+)元，於當期帳單直接折抵/, 400);
  const streamPeriod = near(text, streamIdx, /活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (streamPct && streamPeriod && streamList) {
    // 只在頁面實際列出清單時寫入 merchants（不用寫死備援，避免頁面改版後寫入過時清單）
    const merchants = splitMerchantList(streamList[1]);
    rewards.push({
      category: 'streaming',
      pct: parseFloat(streamPct[1]),
      merchants,
      merchantsComplete: true,
      cap: streamCap ? `每期回饋上限NT$${streamCap[1]}（正附卡合併計算）` : undefined,
      validFrom: isoSlash(streamPeriod[1], streamPeriod[2], streamPeriod[3]),
      validUntil: isoSlash(streamPeriod[4], streamPeriod[5], streamPeriod[6]),
      note: `現金回饋；指定數位訂閱平台（官方公告全清單，來源：${URLS.ubear}），於當期帳單直接折抵；Gemini限直接綁卡於Google消費且請款名稱顯示Google One/Google Services`,
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
