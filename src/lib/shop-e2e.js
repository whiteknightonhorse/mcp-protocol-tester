/**
 * Pure helpers for phase 35 (first-party daily purchase). No network except
 * the injected readers, so scripts/test-shop-e2e.js can run them with a mock rail.
 */
const fs = require('fs');
const path = require('path');

const SPEND_CAP_USD = 0.05;
const TEST_SKU = '__apibase_test';
const INTERNAL_WALLETS_URL = 'https://raw.githubusercontent.com/whiteknightonhorse/APIbase/main/config/autopilot/internal-wallets.json';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DELIVERED_STATES = new Set(['FULFILLED', 'DELIVERED', 'CLOSED']);

// Opt-in gate: SKIP_PAYMENTS=false AND a wallet AND E2E_SHOP_PAID=true. Returns the SKIP reason, or null when the phase may spend.
function paidGate(config, env = process.env) {
  if (config.skipPayments) return 'SKIP_PAYMENTS=true';
  if (!config.privateKey) return 'no wallet key configured';
  if (env.E2E_SHOP_PAID !== 'true') return 'E2E_SHOP_PAID not set';
  return null;
}

// Collects every 0x address found anywhere in the parsed file, lowercased.
function parseInternalWallets(json) {
  const out = new Set();
  const visit = (v) => {
    if (typeof v === 'string') { if (/^0x[0-9a-fA-F]{40}$/.test(v)) out.add(v.toLowerCase()); }
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => { visit(k); visit(v[k]); });
  };
  visit(json);
  return out;
}

// Fail-closed: any error, bad JSON or a missing address means "not internal".
async function isInternalWallet(address, fetchJson) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, why: 'no signer address' };
  let json;
  try { json = await fetchJson(INTERNAL_WALLETS_URL); } catch (e) { return { ok: false, why: `internal-wallets.json unreadable: ${e.message}` }; }
  const set = parseInternalWallets(json);
  if (set.size === 0) return { ok: false, why: 'internal-wallets.json lists no addresses' };
  return set.has(address.toLowerCase()) ? { ok: true } : { ok: false, why: 'wallet not in internal-wallets.json' };
}

// Pre-flight: the quoted prices of every planned payment must fit the cap before the first pay call.
function capPreflight(totalsUsd, cap = SPEND_CAP_USD) {
  const nums = totalsUsd.map(Number);
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n) || n < 0)) return { ok: false, sum: NaN, why: 'a quote total is not a number' };
  const sum = Math.round(nums.reduce((a, b) => a + b, 0) * 1e6) / 1e6;
  return sum > cap ? { ok: false, sum, why: `planned spend $${sum} exceeds cap $${cap}` } : { ok: true, sum };
}

// Post-run verdict on measured spend.
function capVerdict(spentX402, spentMPP, cap = SPEND_CAP_USD) {
  const total = Math.round((spentX402 + spentMPP) * 1e6) / 1e6;
  return { total, ok: total <= cap };
}

// Same payment, same idempotency key -> same order, same receipt, and the wallet balance did not move on the replay.
// `balances` are micro-USDC values read after the first pay and after the replay.
function assertIdempotent(first, replay, balances) {
  const problems = [];
  if (!first || !replay) return { ok: false, problems: ['missing first or replay response'] };
  if (replay.status !== 200) problems.push(`replay status ${replay.status}`);
  if (first.order_id && replay.order_id !== first.order_id) problems.push('order_id differs');
  if (first.receipt && replay.receipt !== first.receipt) problems.push('receipt differs');
  if (balances) {
    const afterPay = BigInt(balances.afterPay);
    const afterReplay = BigInt(balances.afterReplay);
    if (afterReplay !== afterPay) problems.push(`second transfer: balance moved ${afterPay} -> ${afterReplay}`);
  }
  return { ok: problems.length === 0, problems };
}

// Receipt header is a bare id or a URL containing /r/<id>.
function receiptId(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const m = /\/r\/([A-Za-z0-9_-]+?)(?:\.json)?(?:$|[?#])/.exec(headerValue);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{8,}$/.test(headerValue.trim()) ? headerValue.trim() : null;
}

// reports/spend-YYYYMM.tsv, one row per rail per run.
function appendSpendLedger(rows, dir, now = new Date()) {
  const ym = now.toISOString().slice(0, 7).replace('-', '');
  const file = path.join(dir, `spend-${ym}.tsv`);
  const header = 'ts\trun_id\trail\tspent_usd\torder_id\treceipt\tverdict\n';
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const body = rows.map((r) => [now.toISOString(), r.runId, r.rail, Number(r.spentUsd).toFixed(4), r.orderId, r.receipt, r.verdict].map(clean).join('\t')).join('\n') + '\n';
  fs.mkdirSync(dir, { recursive: true });
  const fresh = !fs.existsSync(file);
  fs.appendFileSync(file, (fresh ? header : '') + body);
  return file;
}

module.exports = {
  SPEND_CAP_USD, TEST_SKU, INTERNAL_WALLETS_URL, USDC_BASE, DELIVERED_STATES,
  paidGate, parseInternalWallets, isInternalWallet, capPreflight, capVerdict, assertIdempotent, receiptId, appendSpendLedger,
};
