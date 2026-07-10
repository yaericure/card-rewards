#!/usr/bin/env node
// 用法：
//   node run.js                 爬所有 banks/*.js，輸出 output/<bank>.json，再合併成 ../data/cards.json
//   node run.js taishin esun    只爬指定銀行（仍會用 output/ 現有檔合併）
//   node run.js --merge-only    不爬，只把 output/*.json 合併成 ../data/cards.json
const fs = require('fs');
const path = require('path');

const BANKS_DIR = path.join(__dirname, 'banks');
const OUT_DIR = path.join(__dirname, 'output');
const DATA_FILE = path.join(__dirname, '..', 'data', 'cards.json');
const BANK_IDS = ['taishin', 'esun', 'fubon', 'chb', 'sinopac', 'tcb', 'hncb'];

function validateBank(bank, id) {
  const errs = [];
  if (bank.id !== id) errs.push(`id 應為 ${id}，實際 ${bank.id}`);
  if (!bank.name) errs.push('缺 name');
  if (!Array.isArray(bank.cards) || bank.cards.length === 0) errs.push('cards 為空');
  for (const card of bank.cards || []) {
    if (!card.id || !card.name) errs.push(`卡片缺 id/name: ${JSON.stringify(card).slice(0, 80)}`);
    if (!Array.isArray(card.plans) || card.plans.length === 0) errs.push(`${card.name} 無 plans`);
    for (const plan of card.plans || []) {
      for (const r of plan.rewards || []) {
        if (typeof r.pct !== 'number') errs.push(`${card.name}/${plan.name} 有 reward 的 pct 不是數字`);
      }
    }
  }
  return errs;
}

async function scrapeBanks(targets) {
  let failed = 0;
  for (const id of targets) {
    const modPath = path.join(BANKS_DIR, id + '.js');
    if (!fs.existsSync(modPath)) {
      console.error(`skip ${id}: 找不到 banks/${id}.js`);
      failed++;
      continue;
    }
    process.stdout.write(`scraping ${id} ... `);
    try {
      const bank = await require(modPath).scrape();
      const errs = validateBank(bank, id);
      if (errs.length) throw new Error('schema 驗證失敗：' + errs.join('；'));
      fs.writeFileSync(path.join(OUT_DIR, id + '.json'), JSON.stringify(bank, null, 2));
      console.log(`ok（${bank.cards.length} 張卡）`);
    } catch (e) {
      console.error(`FAIL: ${e.message}`);
      failed++;
    }
  }
  return failed;
}

function merge() {
  // 以上一版 data/cards.json 作備援：本次沒抓到的銀行／卡片沿用舊資料並標 staleSince，
  // 避免暫時性抓取失敗（如 CI 的 IP 被銀行擋）讓銀行從網站上消失；下次抓到即自動覆蓋。
  let prev = { banks: [] };
  try {
    prev = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  const prevBanks = Object.fromEntries((prev.banks || []).map((b) => [b.id, b]));
  const prevStamp = prev.updatedAt || null;

  const banks = [];
  let stale = 0;
  for (const id of BANK_IDS) {
    // 只合併已知銀行的檔案，避免 output/ 內其他工具產物（報告、測試結果）混入資料
    const file = path.join(OUT_DIR, id + '.json');
    const old = prevBanks[id];
    if (fs.existsSync(file)) {
      const fresh = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (old) {
        const freshIds = new Set(fresh.cards.map((c) => c.id));
        for (const c of old.cards) {
          if (!freshIds.has(c.id)) {
            console.warn(`warn: ${id}/${c.id} 本次未抓到，沿用上一版`);
            fresh.cards.push({ ...c, staleSince: c.staleSince || prevStamp });
            stale++;
          }
        }
      }
      banks.push(fresh);
    } else if (old) {
      console.warn(`warn: ${id} 本次無新資料，整家沿用上一版`);
      banks.push({ ...old, staleSince: old.staleSince || prevStamp });
      stale++;
    }
  }
  const data = { updatedAt: new Date().toISOString(), banks };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`merged ${banks.length} 家銀行 → data/cards.json${stale ? `（${stale} 筆沿用舊資料）` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = process.argv.slice(2);
  let failed = 0;
  if (!args.includes('--merge-only')) {
    const targets = args.filter((a) => !a.startsWith('--'));
    failed = await scrapeBanks(targets.length ? targets : BANK_IDS);
  }
  merge();
  // 部分銀行失敗仍合併其餘結果，但以非零碼結束讓排程看得到
  if (failed) process.exitCode = 1;
})();
