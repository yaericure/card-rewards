// 共用工具：HTTP 抓取（含 UA、重試、頁間 delay）。給 scraper/banks/*.js 使用。

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36 CardRewardsBot/1.0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 靜態頁抓取（fetch + 回傳 html 字串）。每次抓取後停頓 delayMs 作為頁間 delay；
// 失敗時重試一次，仍失敗則丟出例外讓呼叫端決定要不要跳過該卡。
async function fetchHtml(url, { retries = 1, delayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      await sleep(delayMs);
      return text;
    } catch (e) {
      lastErr = e;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = { UA, sleep, fetchHtml };
