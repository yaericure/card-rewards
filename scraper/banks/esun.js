// 玉山銀行（esun）信用卡回饋爬蟲 — v3 改版（扁平 rewards：見 ../../data/SCHEMA.md）
//
// v3 只收 SCHEMA 指定的 3 張卡（v2 的數位e卡／鈦金卡一律移除，不再出現在輸出中）：
//   esun-unicard／esun-pi／esun-ubear，皆使用 SCHEMA 指定的入口 URL。
//
// v3 改版重點（相對 v2 的差異）：
//   v2 用 category 大類 + merchants[] 陣列。v3 規則：一筆 reward 只對應一家商店，
//   官方清單列 N 家就拆成 N 筆；等級（tiers，用戶帳戶/消費狀態）與方案（plan，用戶自選
//   商店組合）分離。類別廢除只留 dining；國外消費併入 country（地名）。
//
// 解析假設（2026-07-11 實測，若改版需重新核對）：
//   - 三頁皆為靜態伺服器渲染頁面，fetch + cheerio 即可，不需 playwright。
//   - Unicard（使用者拍板改資格）：
//     * 簡單選/任意選/UP選是 tiers（資格，id：simple/any/up）不是 plan。每個百大項目
//       一筆 reward、pctByTier 三選組，%為含一般消費基礎 1% 的實際總%（細則對照表
//       「最高回饋 3% 3.5% 4.5%」列有明示總%，優先取用；備援＝基礎+加碼）。
//     * 帳單e化＋自動扣繳依 SCHEMA 核心原則 8 假設已完成 → 不建 ebill tier；
//       一般消費記 1%（僅帳單e化的 0.3% 寫進 note）。
//     * 百大列表類別對應：「行動支付」（9 個 canonical 支付）→ mobilepay；
//       「國外實體」（國家清單）→ country；其餘 8 類 → merchant。
//   - Pi拍錢包信用卡：帳單e化假設已申請（0.3% 寫 note），無 tiers——月消費級距加碼
//     需事先登錄（核心原則 9）不收。保費 1.2% 與全家便利商店 5% 各自 pct 固定。
//   - U Bear信用卡：基本回饋 tiers＝「帳單e化或自動扣繳擇一」0.5%／「兩者皆辦」1%
//     （後者標 assumedAchieved）。網路消費加碼以固定 pct=3%（含基本最高1%＋加碼2%）
//     為 general reward、note 詳列條件與上限。指定數位訂閱平台
//     （Netflix/ChatGPT/Gemini/Steam/Nintendo/PlayStation）加碼 10%，逐一拆成 merchant reward。
//   - 發卡組織檢查（核心原則 10，2026-07-11）：三卡指定頁面均無「不同發卡組織不同%」的
//     常態回饋（Unicard 的 Visa 境外現金回饋活動需報名、屬登錄型，本就不收）→ 皆不建組織 tier。
//
// 依 SCHEMA 核心原則 9 排除的「新卡/新戶/需登錄/限量」型活動（2026-07-11 掃描，不收錄）：
//   - Unicard：限時辦卡新戶加碼最高15.5%/舊戶5.5%（新戶/限期辦卡型）、開戶代碼CARD500
//     一般消費加碼10%（新開戶＋活動代碼）、Visa境外實體現金回饋（需報名綁定）。
//   - Pi拍錢包：月消費級距加碼（滿1萬+0.8%/滿3萬+2%，需登錄1次）、滿額贈500P/1,500P
//     （滿額贈）、新戶核卡3個月加碼5%＋AirPods滿額贈（新戶）、Pi拍錢包通路單筆滿399
//     登錄最高5%（需登錄）。
//   - U Bear：新戶指定五大通路加碼10%（新戶＋限期申辦）。
//   - 點數換算（皆為頁面原文所載）：玉山e point / Pi拍錢包P幣 皆為「1點=1元」；
//     U Bear為現金回饋直接折抵帳單。均在 note 註明點數型態。

const cheerio = require('cheerio');
const { fetchHtml } = require('../lib/util');

const URLS = {
  unicard: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/unicard#3',
  picard: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/co-branded-card/pi-card',
  ubear: 'https://www.esunbank.com/zh-tw/personal/credit-card/intro/bank-card/u-bear',
};

const EPOINT_NOTE = '玉山e point點數回饋（1點=1元）';
const PPOINT_NOTE = 'Pi拍錢包P幣回饋（1 P幣=1元）';
const CASH_NOTE = '現金回饋，於當期帳單直接折抵';

function rawTextOf(html) {
  const $ = cheerio.load(html);
  $('script,style').remove();
  return $('body')
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
function textOf(html) {
  return rawTextOf(html).replace(/\s+/g, ' ');
}
function toLines(text) {
  return text.split('\n').map((s) => s.trim());
}
function isoSlash(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
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
function near(text, markerIndex, pattern, span = 400) {
  if (markerIndex < 0) return null;
  const window = text.slice(markerIndex, markerIndex + span);
  const m = window.match(pattern);
  return m || null;
}

// ---------- 玉山Unicard ----------
// 使用者拍板：簡單選/任意選/UP選是「資格」（tiers）不是方案——同一商店在不同選組下
// %不同，前端要求用戶選定自己的選組。tiers id：simple/any/up。
// 帳單e化＋自動扣繳屬 assumedAchieved 類條件（SCHEMA 核心原則 8：網站假設已完成），
// 不另建 ebill tier——一般消費直接記假設達成後的 1%，未達成的 0.3% 寫進 note。
const UNI_TIER_SIMPLE = 'simple';
const UNI_TIER_ANY = 'any';
const UNI_TIER_UP = 'up';

// 百大指定消費列表的 10 個類別（「行動支付」→ mobilepay、「國外實體」→ country、其餘 → merchant）
const UNI_CATEGORY_LABELS = ['行動支付', '電商平台', '國內百貨', '生活採買', '餐飲美食', '加油交通', '航空旅遊', '國外實體', '精選商家', 'ESG消費'];

async function scrapeUnicard() {
  const html = await fetchHtml(URLS.unicard);
  const raw = rawTextOf(html);
  const flat = raw.replace(/\s+/g, ' ');
  const L = toLines(raw);
  const rewards = [];

  // 一般消費：0.3%（僅帳單e化）／1%（帳單e化＋自動扣繳）。依 assumedAchieved 規則
  // 假設已完成帳單e化＋自動扣繳 → 記 1%，0.3% 寫進 note。
  const ebillOnly = flat.match(/一般消費享(\d+(?:\.\d+)?)%\s*玉山e ?point回饋，需申辦帳單e化/);
  const ebillAutopay = flat.match(
    /一般消費享(\d+(?:\.\d+)?)%\s*玉山e ?point回饋，需同時申辦帳單e化及申辦玉山銀行臺幣帳戶自動扣繳/
  );
  const generalPeriod = flat.match(/一般消費最高享1%\s*活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const basePct = ebillAutopay ? parseFloat(ebillAutopay[1]) : null;
  if (basePct !== null) {
    const r = {
      targetType: 'general',
      pct: basePct,
      note: `${EPOINT_NOTE}；一般消費回饋無上限，需同時申辦帳單e化及臺幣帳戶自動扣繳且成功扣繳（本站假設已完成${
        ebillOnly ? `；僅帳單e化為${ebillOnly[1]}%` : ''
      }）；不含百大指定消費特店分期及歐盟實體交易、繳稅費及四大超商、全聯交易等；來源：${URLS.unicard}`,
    };
    if (generalPeriod) {
      r.validFrom = isoSlash(generalPeriod[1], generalPeriod[2], generalPeriod[3]);
      r.validUntil = isoSlash(generalPeriod[4], generalPeriod[5], generalPeriod[6]);
    }
    rewards.push(r);
  } else {
    console.error('esun: unicard 頁面抓不到一般消費回饋數字');
  }

  // 百大指定消費加碼（簡單選/任意選/UP選 三選組的加碼%）
  const listPeriod = flat.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})~(\d{4})\/(\d{1,2})\/(\d{1,2})適用百大指定消費列表如下/);
  const validFrom = listPeriod ? isoSlash(listPeriod[1], listPeriod[2], listPeriod[3]) : undefined;
  const validUntil = listPeriod ? isoSlash(listPeriod[4], listPeriod[5], listPeriod[6]) : undefined;
  // 「百大指定消費 +X% (歸戶月上限Y點)」在選組對照表中依序出現兩次：
  // 第一次對應【簡單選】、第二次對應【UP選】；【任意選】則是獨立的「任選8家指定消費 +X%」句型。
  const planPctMatches = [...flat.matchAll(/百大指定消費\s*\+(\d+(?:\.\d+)?)%\s*\(歸戶月上限([\d,]+)點\)/g)];
  const simplePct = planPctMatches[0];
  const upPct = planPctMatches[1];
  const anyPct = flat.match(/任選8家指定消費\s*\+(\d+(?:\.\d+)?)%\s*\(歸戶月上限([\d,]+)點\)/);
  // 對照表「最高回饋」列直接給出含基礎 1% 的實際總%（細則原文「最高回饋 3% 3.5% 4.5%」），
  // 優先採用此明示總%；抓不到再以「基礎+加碼」計算備援。
  const totalsRow = flat.match(/最高回饋\s*(\d+(?:\.\d+)?)%\s*(\d+(?:\.\d+)?)%\s*(\d+(?:\.\d+)?)%/);
  const totalOf = (bonusMatch, idx) => {
    if (totalsRow) return parseFloat(totalsRow[idx]);
    if (bonusMatch && basePct !== null) return basePct + parseFloat(bonusMatch[1]);
    return null;
  };
  const simpleTotal = totalOf(simplePct, 1);
  const anyTotal = totalOf(anyPct, 2);
  const upTotal = totalOf(upPct, 3);

  // 百大指定消費列表：類別 label + 緊接一行「、」分隔清單，連續 10 組（含國外實體）
  const listStart = L.indexOf('類別', L.indexOf('百大指定消費列表'));
  const listEnd = L.findIndex((l, i) => i > listStart && l.includes('百大指定消費列表注意事項'));
  const groups = [];
  if (listStart >= 0) {
    let i = listStart + 2; // 跳過「類別」「指定百大指定消費」表頭
    while (i < (listEnd > 0 ? listEnd : L.length) - 1) {
      const label = L[i];
      if (!label || !UNI_CATEGORY_LABELS.includes(label)) break;
      let content = L[i + 1] || '';
      // ESG消費該行後方緊接※註解，需切掉才拆分店名
      content = content.replace(/※.*$/, '');
      // 「A/B」多店合寫拆成獨立商店（如「萬家福/樂家康」＝原家樂福量販/超市，2026/7/1
      // 分別更名為兩家店；台新官網即分列兩項）。只拆「頂層斜線且兩側皆為純中日韓文字」
      // 的情況——含拉丁字母/數字/點號的品牌名（7-ELEVEN、Trip.com、Booking.com）不拆；
      // 括號內斜線（統一時代百貨(台北店/DREAM PLAZA)）已由 splitMerchantList 保護不會到頂層。
      const items = splitMerchantList(content).flatMap((item) => {
        const parts = splitMerchantList(item, '/');
        if (parts.length > 1 && parts.every((p) => /^[一-鿿぀-ヿ]+$/.test(p))) return parts;
        return [item];
      });
      groups.push({ label, items });
      i += 2;
    }
  }

  // 範圍限定詞處理（SCHEMA「範圍限定詞的處理」，2026-07-11）：多店合寫拆筆、
  // 「不含X」/交易類型限定移入 note。精確比對官方原文、比對不到保留原樣（避免通用規則誤拆）。
  // 依規則保留原文者：純別名/位置註記（遠東Garden City(大巨蛋)、55688(台灣大車隊、機場接送)）；
  // 「A(含B)」B 為同品牌通路（誠品生活(含誠品書店與誠品線上)——書店/線上為誠品自家通路，
  // 不確定是否應獨立拆筆，保留原樣）。
  const UNI_TARGET_RULES = {
    '統一時代百貨(台北店/DREAM PLAZA)': [
      { target: '統一時代百貨台北店', extraNote: '官方原文「統一時代百貨(台北店/DREAM PLAZA)」，兩店拆列' },
      { target: 'DREAM PLAZA', extraNote: '官方原文「統一時代百貨(台北店/DREAM PLAZA)」，兩店拆列' },
    ],
    '漢神百貨(不含漢神巨蛋)': [{ target: '漢神百貨', extraNote: '不含漢神巨蛋' }],
    '台灣中油(直營店)': [{ target: '台灣中油', extraNote: '限直營店' }],
    '新光三越百貨(含SKM Park Outlets高雄草衙)': [
      { target: '新光三越百貨', extraNote: '官方原文「新光三越百貨(含SKM Park Outlets高雄草衙)」，兩店拆列' },
      { target: 'SKM Park Outlets高雄草衙', extraNote: '官方原文「新光三越百貨(含SKM Park Outlets高雄草衙)」，兩店拆列' },
    ],
  };

  // 每個百大項目一筆 reward，% 用 pctByTier（simple/any/up 三選組、含基礎 1% 的實際總%）。
  // 加碼上限依選組不同（簡單選/任意選 1,000 點、UP選 5,000 點），寫進同一 cap 字串。
  if (simpleTotal !== null && anyTotal !== null && upTotal !== null && groups.length) {
    const capParts = [];
    if (simplePct) capParts.push(`簡單選/任意選每月歸戶上限${simplePct[2]}點`);
    if (upPct) capParts.push(`UP選每月歸戶上限${upPct[2]}點`);
    const cap = capParts.length ? `百大指定消費加碼部分：${capParts.join('、')}（玉山e point）；基礎1%無上限` : undefined;
    for (const g of groups) {
      const targetType = g.label === '行動支付' ? 'mobilepay' : g.label === '國外實體' ? 'country' : 'merchant';
      for (const item of g.items) {
        if (!item) continue;
        for (const spec of UNI_TARGET_RULES[item] || [{ target: item }]) {
          const extra = spec.extraNote ? `；${spec.extraNote}` : '';
          const r = {
            target: spec.target,
            targetType,
            pctByTier: { [UNI_TIER_SIMPLE]: simpleTotal, [UNI_TIER_ANY]: anyTotal, [UNI_TIER_UP]: upTotal },
            note: `${EPOINT_NOTE}；百大指定消費【${g.label}】，%含一般消費基礎1%（假設已完成帳單e化＋自動扣繳）＋選組加碼（簡單選+${
              simplePct ? simplePct[1] : '?'
            }%／任意選+${anyPct ? anyPct[1] : '?'}%／UP選+${upPct ? upPct[1] : '?'}%）；任意選需自行圈選最多8家始生效${extra}；來源：${URLS.unicard}`,
          };
          if (cap) r.cap = cap;
          if (validFrom) r.validFrom = validFrom;
          if (validUntil) r.validUntil = validUntil;
          rewards.push(r);
        }
      }
    }
  } else {
    console.error('esun: unicard 頁面抓不到百大指定消費三選組的%或清單，略過百大 rewards');
  }

  if (rewards.length < 5) {
    console.error('esun: unicard 頁面抓到的 reward 數量過少，跳過此卡');
    return null;
  }
  return {
    id: 'esun-unicard',
    name: '玉山Unicard',
    url: URLS.unicard,
    tiers: [
      { id: UNI_TIER_SIMPLE, name: '簡單選', condition: '核卡後預設選組，百大指定消費全部涵蓋，可於玉山Wallet切換' },
      { id: UNI_TIER_ANY, name: '任意選', condition: '於玉山Wallet自百大指定消費中任選最多8家生效（每月可切換，僅圈選的商店享加碼）' },
      { id: UNI_TIER_UP, name: 'UP選', condition: '訂閱制：同時符合上月刷卡滿3萬元及上月玉山平均資產滿30萬元可免費訂閱，或以149點玉山e point訂閱；百大指定消費全部涵蓋' },
    ],
    rewards,
  };
}

// ---------- 玉山Pi拍錢包信用卡 ----------
// 帳單e化屬 assumedAchieved 類條件（本站假設已申請），0.3% 寫進 note。
// 「月消費級距加碼」（滿1萬加碼0.8%、滿3萬加碼2%）官方細則明載「活動期間僅需登錄1次
// 即可參加每月刷卡活動，自登錄當月始計算…不溯及既往」＝需事先登錄的活動型回饋 →
// 依 SCHEMA 核心原則 9 不收，故本卡無 tiers、一般消費只記常態基本回饋 1%。
async function scrapePiCard() {
  const html = await fetchHtml(URLS.picard);
  const text = textOf(html);
  const rewards = [];

  const baseIdx = text.indexOf('基本回饋 1%P幣無上限');
  const base = near(text, baseIdx, /基本回饋 ?(\d+(?:\.\d+)?)%P幣無上限 ?\(需申請帳單e化，未申辦帳單e化者享(\d+(?:\.\d+)?)% ?P幣回饋無上限/);
  const periodAnchorIdx = text.indexOf('消費最高享');
  const basePeriod = near(text, periodAnchorIdx, /消費最高享 ?[\d.]+% P幣 活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/, 200);

  if (base && basePeriod) {
    const validFrom = isoSlash(basePeriod[1], basePeriod[2], basePeriod[3]);
    const validUntil = isoSlash(basePeriod[4], basePeriod[5], basePeriod[6]);
    rewards.push({
      targetType: 'general',
      pct: parseFloat(base[1]),
      validFrom,
      validUntil,
      note: `${PPOINT_NOTE}；一般消費基本回饋${base[1]}%無上限，需申請帳單e化（本站假設已申請；未申辦帳單e化者僅${base[2]}%）；官方另有月消費級距加碼（最高3%）與滿額贈，均需事先登錄，不收錄；來源：${URLS.picard}`,
    });
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
      targetType: 'general',
      pct: parseFloat(insurance[1]),
      validFrom: isoSlash(insurance[2], insurance[3], insurance[4]),
      validUntil: isoSlash(insurance[5], insurance[6], insurance[7]),
      note: `${PPOINT_NOTE}；保費一次付清享回饋無上限，免登錄；不含國外保險/躉繳保費等（來源：${URLS.picard}）`,
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
      target: '全家便利商店',
      targetType: 'merchant',
      pct: parseFloat(family[1]),
      cap: famCap ? `每月每卡上限${famCap[1]} P幣` : undefined,
      validFrom: isoSlash(family[2], family[3], family[4]),
      validUntil: isoSlash(family[5], family[6], family[7]),
      note: `${PPOINT_NOTE}；限綁定Pi拍錢包APP於全家便利商店消費（來源：${URLS.picard}）`,
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
    rewards,
  };
}

// ---------- U Bear信用卡 ----------
const UBEAR_TIER_EITHER = 'either';
const UBEAR_TIER_BOTH = 'both';

async function scrapeUBear() {
  const html = await fetchHtml(URLS.ubear);
  const text = textOf(html);
  const rewards = [];

  const baseIdx = text.indexOf('熊任務 基本回饋');
  const basePeriod = near(text, baseIdx, /活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const baseCond = near(
    text,
    baseIdx,
    /需綁定帳單e化或申辦玉山銀行臺幣帳戶自動扣繳享(\d+(?:\.\d+)?)%現金回饋，申辦上述兩者享(\d+(?:\.\d+)?)%現金回饋/,
    500
  );
  if (baseCond && basePeriod) {
    rewards.push({
      targetType: 'general',
      pctByTier: { [UBEAR_TIER_EITHER]: parseFloat(baseCond[1]), [UBEAR_TIER_BOTH]: parseFloat(baseCond[2]) },
      validFrom: isoSlash(basePeriod[1], basePeriod[2], basePeriod[3]),
      validUntil: isoSlash(basePeriod[4], basePeriod[5], basePeriod[6]),
      note: `${CASH_NOTE}；國內外一般消費基本回饋，回饋無上限（不含指定數位訂閱平台消費）；來源：${URLS.ubear}`,
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
      targetType: 'general',
      pct: parseFloat(onlinePct[1]),
      cap: onlineCap ? `網路消費加碼(2%)部分每期回饋上限NT$${onlineCap[1]}（正附卡合併），達上限後僅享基本回饋最高1%` : undefined,
      validFrom: isoSlash(onlinePeriod[1], onlinePeriod[2], onlinePeriod[3]),
      validUntil: isoSlash(onlinePeriod[4], onlinePeriod[5], onlinePeriod[6]),
      note: `${CASH_NOTE}；網路消費最高回饋＝基本回饋最高1%（需綁定帳單e化及自動扣繳皆辦）＋網路消費加碼2%（需綁定帳單e化）；網路消費含行動支付/國內外線上消費/App綁卡付款，不含保費/超商/小額支付平台/指定數位訂閱平台；來源：${URLS.ubear}`,
    });
  } else {
    console.error('esun: u-bear 頁面抓不到網路消費回饋數字，略過此 reward');
  }

  const streamIdx = text.indexOf('熊潮流');
  const streamPct = near(text, streamIdx, /指定數位訂閱平台消費最高享 ?(\d+(?:\.\d+)?)%現金回饋/);
  const streamList = near(text, streamIdx, /指定數位訂閱平台包含([^，。※]+?)(?:，需限於|。|※)/, 800);
  const streamCap = near(text, streamIdx, /每期回饋金額上限(\d+)元/, 400);
  const streamPeriod = near(text, streamIdx, /活動期間：(\d{4})\/(\d{1,2})\/(\d{1,2})[~～](\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (streamPct && streamPeriod && streamList) {
    const merchants = splitMerchantList(streamList[1]);
    const validFrom = isoSlash(streamPeriod[1], streamPeriod[2], streamPeriod[3]);
    const validUntil = isoSlash(streamPeriod[4], streamPeriod[5], streamPeriod[6]);
    const cap = streamCap
      ? `每期回饋金額上限NT$${streamCap[1]}（正附卡合併），不與一般消費/網路消費回饋累計，達上限後不再享任何回饋`
      : undefined;
    for (const m of merchants) {
      if (!m) continue;
      rewards.push({
        target: m,
        targetType: 'merchant',
        pct: parseFloat(streamPct[1]),
        cap,
        validFrom,
        validUntil,
        note: `${CASH_NOTE}；指定數位訂閱平台消費（來源：${URLS.ubear}）；Gemini需直接綁卡於Google消費且請款名稱顯示Google One/Google Services`,
      });
    }
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
    tiers: [
      { id: UBEAR_TIER_EITHER, name: '僅綁定帳單e化或僅申辦自動扣繳其中一項', condition: '僅綁定帳單e化(Email電子帳單或簡訊帳單)，或僅申辦玉山銀行臺幣帳戶自動扣繳卡費（擇一）' },
      { id: UBEAR_TIER_BOTH, name: '帳單e化＋自動扣繳皆申辦', condition: '同時綁定帳單e化及申辦玉山銀行臺幣帳戶自動扣繳卡費，且成功扣繳卡費', assumedAchieved: true },
    ],
    rewards,
  };
}

async function scrape() {
  const results = await Promise.all([scrapeUnicard(), scrapePiCard(), scrapeUBear()]);
  const cards = results.filter(Boolean);
  return { id: 'esun', name: '玉山銀行', cards };
}

module.exports = { scrape };
