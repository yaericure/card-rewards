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
const BANK_IDS = ['taishin', 'esun', 'fubon', 'cathay', 'sinopac'];

const TARGET_TYPES = ['merchant', 'dining', 'country', 'mobilepay', 'general'];

function validateBank(bank, id) {
  const errs = [];
  if (bank.id !== id) errs.push(`id 應為 ${id}，實際 ${bank.id}`);
  if (!bank.name) errs.push('缺 name');
  if (!Array.isArray(bank.cards) || bank.cards.length === 0) errs.push('cards 為空');
  for (const card of bank.cards || []) {
    if (!card.id || !card.name || !card.url) errs.push(`卡片缺 id/name/url: ${JSON.stringify(card).slice(0, 80)}`);
    const tierIds = new Set((card.tiers || []).map((t) => t.id));
    if (card.tiers && card.tiers.length < 2) errs.push(`${card.name} tiers 存在但少於 2 個（無等級概念就省略欄位）`);
    if (!Array.isArray(card.rewards) || card.rewards.length === 0) errs.push(`${card.name} 無 rewards`);
    for (const r of card.rewards || []) {
      const tag = `${card.name}/${r.plan || '基本'}/${r.target || r.targetType}`;
      if (!TARGET_TYPES.includes(r.targetType)) errs.push(`${tag} targetType 非法：${r.targetType}`);
      if ((r.targetType === 'merchant' || r.targetType === 'country') && !r.target)
        errs.push(`${tag} targetType=${r.targetType} 但缺 target`);
      const hasPct = typeof r.pct === 'number';
      const hasByTier = r.pctByTier && typeof r.pctByTier === 'object';
      if (hasPct === hasByTier) errs.push(`${tag} pct 與 pctByTier 必須二選一`);
      if (hasByTier) {
        for (const k of Object.keys(r.pctByTier)) {
          if (!tierIds.has(k)) errs.push(`${tag} pctByTier key「${k}」不在 tiers 內`);
          if (typeof r.pctByTier[k] !== 'number') errs.push(`${tag} pctByTier.${k} 不是數字`);
        }
      }
      if (r.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(r.validUntil)) errs.push(`${tag} validUntil 格式錯誤`);
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
      // 舊資料須通過現行 schema 驗證才可沿用（避免規格改版後，舊格式資料經備援混回新檔）
      if (validateBank(old, id).length === 0) {
        console.warn(`warn: ${id} 本次無新資料，整家沿用上一版`);
        banks.push({ ...old, staleSince: old.staleSince || prevStamp });
        stale++;
      } else {
        console.warn(`warn: ${id} 本次無新資料，且上一版不符現行 schema，捨棄`);
      }
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
