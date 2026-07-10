// 國泰世華銀行（cathay）信用卡回饋爬蟲
//
// 來源 URL（2026-07-10 以 playwright 實際渲染核對過結構）：
//   - CUBE信用卡權益分級（Level 1/2/3 百分比）：
//     https://www.cathaybk.com.tw/cathaybk/personal/product/credit-card/cards/cube/
//   - CUBE信用卡權益方案（各方案通路清單與活動期間）：
//     https://www.cathay-cube.com.tw/content/cub-aem-cs/zh-tw/cathaybk/personal/product/credit-card/cards/cube-list.html
//
// 解析假設：
//   - 兩頁皆為 React SPA（純 fetch 只拿到殼「You need to enable JavaScript to run this app.」），
//     需 playwright networkidle + 額外等待後取 innerText 才有內容。
//   - 權益分級頁：Level 1/2/3 區塊各自出現一次
//     「玩數位X%樂饗購X%趣旅行X%集精選X%一般消費享0.3%」，依序對應
//     Level 1（核卡即享，無條件）→ Level 2（CUBE App繳費或申請自動扣繳，次月生效）→
//     Level 3（財富管理貴賓，次月生效）。玩數位/樂饗購/趣旅行三個方案的 pct 隨等級變動
//     （2%/3%/3.3%），集精選固定2%不分級。為避免高估使用者實際可得回饋，
//     reward.pct 一律取 Level 1（任何持卡人核卡即享、無需額外條件）之基礎值，
//     Level 2/3 的加碼百分比與條件寫在 note 供使用者自行評估。
//   - 權益方案頁：每個方案標題後緊接「適用期間：YYYY/M/D~YYYY/M/D」與一段固定免責句；
//     集精選/台塑家/全支付三個「不分等級、固定回饋」的方案在免責句後緊接單一 flat %
//     （目前皆為2%），用該固定值取代等級頁的基礎值。
//   - 通路商家清單無結構化 API，人工從 2026-07-10 的 playwright 渲染結果讀取後寫入程式
//     （精選代表性商家，非窮舉全部清單）；日後改版需重新核對。
//   - 刻意排除「慶生月」（限壽星生日月才適用，商家清單以特定城市在地店家為主，
//     泛用性低）與「童樂匯」（限與未成年子女共同開戶之家長資格，屬另一種資格制而非
//     人人可切換的方案）。這兩個方案若未來要收錄，可比照本檔案模式另外新增。
//   - 全部方案回饋皆以小樹點(信用卡)發放，1點=1元，已在 note 註明。
//   - card 層級 planKind 標為 "switchable"：CUBE App 可隨時切換以下 6 個方案，
//     每次消費依當下設定的方案計算回饋（非需要用戶預先選定等級/資格）。

const { UA, sleep } = require('../lib/util');

const LEVEL_URL = 'https://www.cathaybk.com.tw/cathaybk/personal/product/credit-card/cards/cube/';
const CHANNEL_URL =
  'https://www.cathay-cube.com.tw/content/cub-aem-cs/zh-tw/cathaybk/personal/product/credit-card/cards/cube-list.html';
const CARD_URL = 'https://www.cathaybk.com.tw/cathaybk/personal/product/credit-card/cards/cube/';

const POINT_NOTE = '小樹點(信用卡)回饋，1點=1元';

function isoFrom(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function renderText(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2000);
  return page.innerText('body');
}

// Level 1/2/3 的玩數位/樂饗購/趣旅行/集精選/一般消費 %，依序回傳陣列 [Level1, Level2, Level3]
function parseLevels(text) {
  const re = /玩數位([\d.]+)%\s*樂饗購([\d.]+)%\s*趣旅行([\d.]+)%\s*集精選([\d.]+)%\s*一般消費享([\d.]+)%/g;
  const levels = [];
  for (const m of text.matchAll(re)) {
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

function parsePlanValidity(text, planName) {
  const re = new RegExp(esc(planName) + '\\s*適用期間：(\\d{4})/(\\d{1,2})/(\\d{1,2})[~～](\\d{4})/(\\d{1,2})/(\\d{1,2})');
  const m = text.match(re);
  if (!m) return null;
  return { validFrom: isoFrom(m[1], m[2], m[3]), validUntil: isoFrom(m[4], m[5], m[6]) };
}

// 集精選/台塑家/全支付：免責句後緊接單一 flat %（不分等級）
function parseFlatPct(text, planName) {
  const re = new RegExp(
    esc(planName) +
      '\\s*適用期間：[^\\n]*\\n\\n自2024/2/1起於特約商店分期付款消費（含提前結清），僅適用原一般消費0.3%回饋。\\s*([\\d.]+)%'
  );
  const m = text.match(re);
  return m ? parseFloat(m[1]) : null;
}

async function scrape() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const cards = [];
  try {
    const page = await browser.newPage({ userAgent: UA });
    const levelText = await renderText(page, LEVEL_URL);
    await sleep(600);
    const channelText = await renderText(page, CHANNEL_URL);

    const levels = parseLevels(levelText);
    if (levels.length < 3) {
      console.error('cathay: 權益分級頁抓不到完整3級百分比，CUBE卡跳過');
      return { id: 'cathay', name: '國泰世華銀行', cards: [] };
    }
    const [lv1, lv2, lv3] = levels;
    const plans = [];

    // ---------- 玩數位（Level制，取Level1基礎值）----------
    {
      const v = parsePlanValidity(channelText, '玩數位');
      if (v && !Number.isNaN(lv1.digital)) {
        const note = `${POINT_NOTE}；回饋依CUBE App當月權益分級而異：Level 1（核卡即享）${lv1.digital}%、Level 2（以CUBE App繳費或申請自動扣繳，次月生效）${lv2.digital}%、Level 3（財富管理貴賓，次月生效）${lv3.digital}%；此處採任何持卡人皆可得之Level 1基礎值`;
        plans.push({
          id: 'digital',
          name: '玩數位',
          condition: '需於CUBE App切換至「玩數位」權益方案，可隨時切換，當日零時起生效',
          validFrom: v.validFrom,
          validUntil: v.validUntil,
          rewards: [
            {
              category: 'streaming',
              pct: lv1.digital,
              merchants: ['Netflix', 'Disney+', 'Spotify', 'YouTube Premium', 'Apple 媒體服務', 'Google Play', 'ChatGPT', 'Claude'],
              note: `${note}；AI工具/數位串流平台`,
            },
            {
              category: 'online',
              pct: lv1.digital,
              merchants: ['蝦皮購物', 'momo購物網', 'PChome 24h購物', '小樹購', 'Coupang酷澎(台灣)', '淘寶/天貓'],
              note: `${note}；網購平台/國際電商`,
            },
          ],
        });
      } else {
        console.error('cathay: 玩數位方案資料不完整，跳過此 plan');
      }
    }

    // ---------- 樂饗購（Level制，取Level1基礎值）----------
    {
      const v = parsePlanValidity(channelText, '樂饗購');
      if (v && !Number.isNaN(lv1.dining)) {
        const note = `${POINT_NOTE}；回饋依CUBE App當月權益分級而異：Level 1（核卡即享）${lv1.dining}%、Level 2（以CUBE App繳費或申請自動扣繳，次月生效）${lv2.dining}%、Level 3（財富管理貴賓，次月生效）${lv3.dining}%；此處採任何持卡人皆可得之Level 1基礎值`;
        plans.push({
          id: 'dining',
          name: '樂饗購',
          condition: '需於CUBE App切換至「樂饗購」權益方案，可隨時切換，當日零時起生效',
          validFrom: v.validFrom,
          validUntil: v.validUntil,
          rewards: [
            {
              category: 'department',
              pct: lv1.dining,
              merchants: ['新光三越', '遠東SOGO百貨', '遠東百貨', '台北101', '微風廣場', '誠品生活', '大江國際購物中心'],
              note: `${note}；國內指定百貨（不含店中櫃）`,
            },
            {
              category: 'delivery',
              pct: lv1.dining,
              merchants: ['Uber Eats', 'foodpanda'],
              note: `${note}；國內外送平台`,
            },
            {
              category: 'dining',
              pct: lv1.dining,
              merchants: ['麥當勞'],
              note: `${note}；國內餐飲(不含餐券)及連鎖速食`,
            },
            {
              category: 'medical',
              pct: lv1.dining,
              merchants: ['康是美', '屈臣氏'],
              note: `${note}；國內藥妝（SCHEMA無「藥妝」分類，暫歸類medical，請以官網為準）`,
            },
          ],
        });
      } else {
        console.error('cathay: 樂饗購方案資料不完整，跳過此 plan');
      }
    }

    // ---------- 趣旅行（Level制，取Level1基礎值）----------
    {
      const v = parsePlanValidity(channelText, '趣旅行');
      if (v && !Number.isNaN(lv1.travel)) {
        const note = `${POINT_NOTE}；回饋依CUBE App當月權益分級而異：Level 1（核卡即享）${lv1.travel}%、Level 2（以CUBE App繳費或申請自動扣繳，次月生效）${lv2.travel}%、Level 3（財富管理貴賓，次月生效）${lv3.travel}%；此處採任何持卡人皆可得之Level 1基礎值`;
        plans.push({
          id: 'travel',
          name: '趣旅行',
          condition: '需於CUBE App切換至「趣旅行」權益方案，可隨時切換，當日零時起生效',
          validFrom: v.validFrom,
          validUntil: v.validUntil,
          rewards: [
            {
              category: 'overseas',
              pct: lv1.travel,
              merchants: ['東京迪士尼樂園', '大阪環球影城(USJ)', '東京華納兄弟哈利波特影城'],
              note: `${note}；海外實體消費(含國外餐飲/飯店到店付款)及日本指定遊樂園`,
            },
            {
              category: 'transport',
              pct: lv1.travel,
              merchants: ['Uber', 'Grab', '台灣高鐵', 'yoxi', '台灣大車隊', 'iRent', '和運租車', '格上租車'],
              note: `${note}；指定國內外交通(含短程叫車/高鐵/租車/Apple錢包SUICA·PASMO·ICOCA)`,
            },
            {
              category: 'travel',
              pct: lv1.travel,
              merchants: ['中華航空', '長榮航空', '星宇航空', 'KKday', 'Klook', 'Agoda', 'Airbnb', 'Booking.com', '雄獅旅遊', '可樂旅遊'],
              note: `${note}；指定航空公司/飯店住宿/旅遊訂房平台/旅行社`,
            },
          ],
        });
      } else {
        console.error('cathay: 趣旅行方案資料不完整，跳過此 plan');
      }
    }

    // ---------- 集精選（不分等級，flat 2%）----------
    {
      const v = parsePlanValidity(channelText, '集精選');
      const pct = parseFlatPct(channelText, '集精選');
      if (v && pct != null) {
        const note = `${POINT_NOTE}；集精選不分CUBE權益分級，統一回饋${pct}%`;
        plans.push({
          id: 'essential',
          name: '集精選',
          condition: '需於CUBE App切換至「集精選」權益方案，可隨時切換，當日零時起生效',
          validFrom: v.validFrom,
          validUntil: v.validUntil,
          rewards: [
            {
              category: 'gas',
              pct,
              merchants: ['台灣中油-直營站', 'U-POWER', 'EVOASIS', 'EVALUE', 'TAIL', 'iCharging'],
              note: `${note}；指定加油站及充電站(SCHEMA無「充電」分類，歸類於gas)`,
            },
            { category: 'transport', pct, merchants: ['車麻吉', 'uTagGo'], note: `${note}；停車費` },
            {
              category: 'supermarket',
              pct,
              merchants: ['家樂福', 'LOPIA台灣', '全聯福利中心'],
              note: `${note}；量販超市(全聯限實體門市，不含大全聯)`,
            },
            { category: 'convenience', pct, merchants: ['7-ELEVEN', '全家便利商店'], note: `${note}；指定超商實體門市` },
            {
              category: 'department',
              pct,
              merchants: ['IKEA宜家家居'],
              note: `${note}；生活家居(SCHEMA無「居家」分類，暫歸類department)`,
            },
          ],
        });
      } else {
        console.error('cathay: 集精選方案資料不完整，跳過此 plan');
      }
    }

    // ---------- 台塑家（不分等級，flat 2%）----------
    {
      const v = parsePlanValidity(channelText, '台塑家');
      const pct = parseFlatPct(channelText, '台塑家');
      if (v && pct != null) {
        const note = `${POINT_NOTE}；台塑家不分CUBE權益分級，統一回饋${pct}%`;
        plans.push({
          id: 'formosa',
          name: '台塑家',
          condition: '需於CUBE App切換至「台塑家」權益方案，可隨時切換，當日零時起生效',
          validFrom: v.validFrom,
          validUntil: v.validUntil,
          rewards: [
            {
              category: 'gas',
              pct,
              merchants: ['台塑石油加油站', '台亞加油站', '福懋加油站', '統一速邁樂加油站'],
              note: `${note}；台塑通路指定加油站(限本島統一速邁樂)`,
            },
            {
              category: 'medical',
              pct,
              merchants: ['台塑生醫', '長庚生技', '台塑蔬菜'],
              note: `${note}；健康生活實體門市(SCHEMA無「健康生活」分類，暫歸類medical，請以官網為準)`,
            },
            { category: 'online', pct, merchants: ['台塑購物網'], note: `${note}；台塑購物網` },
            {
              category: 'convenience',
              pct,
              merchants: ['7-ELEVEN', '全家便利商店', '萊爾富'],
              note: `${note}；指定超商實體門市`,
            },
          ],
        });
      } else {
        console.error('cathay: 台塑家方案資料不完整，跳過此 plan');
      }
    }

    // ---------- 全支付（不分等級，flat 2%）----------
    {
      const v = parsePlanValidity(channelText, '全支付');
      const pct = parseFlatPct(channelText, '全支付');
      if (v && pct != null) {
        const note = `${POINT_NOTE}；全支付不分CUBE權益分級，統一回饋${pct}%；須選定「全支付」方案並以全支付綁定CUBE信用卡刷卡消費方可獲回饋`;
        plans.push({
          id: 'qpay',
          name: '全支付',
          condition: '需於CUBE App切換至「全支付」權益方案，並以全支付綁定CUBE信用卡刷卡消費，可隨時切換',
          validFrom: v.validFrom,
          validUntil: v.validUntil,
          rewards: [
            { category: 'supermarket', pct, merchants: ['全聯福利中心', '大全聯'], note: `${note}；量販超市` },
            { category: 'mobilepay', pct, merchants: ['全支付'], note: `${note}；全支付國內通路及合作通路` },
          ],
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
  } finally {
    await browser.close();
  }
  return { id: 'cathay', name: '國泰世華銀行', cards };
}

module.exports = { scrape };
