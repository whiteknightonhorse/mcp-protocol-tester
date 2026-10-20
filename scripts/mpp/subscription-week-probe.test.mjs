// node --test scripts/mpp/subscription-week-probe.test.mjs   (mocked HTTP, no network, no real key)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runStart, runCheck, checkGuards, assertTerms, Refusal } from './subscription-week-probe.mjs';

const BASE = 'https://apibase.pro';
const FLAGS = ['--i-am-the-dispatcher'];
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'subscription-week-probe.mjs');
const SUB_ID = '11111111-1111-4111-8111-111111111111';
const TERMS = { period: { unit: 'week', count: 1 }, amount: 1, max_periods: 2, renewal_window_h: 72, cancel_anytime: true };
const QUOTE = { quote_id: 'q-1', total_usd: 1, subscription_terms: TERMS };
const res = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const tmpReport = () => join(mkdtempSync(join(tmpdir(), 'swp-')), 'sub.json');

function mockFetch({ quote = QUOTE, sub = {} } = {}) {
  return async (url) => {
    if (url.endsWith('/quotes')) return res(201, quote);
    if (url.includes('/subscriptions/')) {
      return res(200, { subscription_id: SUB_ID, status: 'active', period_no: 1, current_period_end: 'e', next_charge_at: 'n', pull_mode: 'mpp_subscription', ...sub });
    }
    return res(404, {});
  };
}
const payOk = async (url) => { payOk.url = url; return res(200, { order_id: 'o-1', subscription: { id: SUB_ID, period_no: 1 } }); };

test('start happy path pays period 1 via the subscription intent and writes the report', async () => {
  const reportPath = tmpReport();
  const lines = [];
  const out = await runStart({ fetchFn: mockFetch(), payFetch: payOk, base: BASE, env: {}, flags: FLAGS, reportPath, log: (l) => lines.push(l) });
  assert.equal(payOk.url, `${BASE}/api/v1/shop/quotes/q-1/pay?intent=subscription`);
  assert.deepEqual(Object.keys(out), ['subscription_id', 'status', 'period_no', 'current_period_end', 'next_charge_at', 'pull_mode']);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).subscription_id, SUB_ID);
  assert.equal(JSON.parse(lines[0]).pull_mode, 'mpp_subscription');
});

test('check exit codes: 0 credited, 3 waiting, 1 past_due / failed', async () => {
  const reportPath = tmpReport();
  writeFileSync(reportPath, JSON.stringify({ subscription_id: SUB_ID }));
  const run = (sub) => runCheck({ fetchFn: mockFetch({ sub }), base: BASE, env: {}, reportPath, log: () => {} });
  assert.equal(await run({ status: 'active', period_no: 2 }), 0);
  assert.equal(await run({ status: 'active', period_no: 1 }), 3);
  assert.equal(await run({ status: 'past_due', period_no: 1 }), 1);
  assert.equal(await run({ status: 'failed', period_no: 2 }), 1);
});

test('check prints the period 2 tx hash when the view carries one', async () => {
  const reportPath = tmpReport();
  writeFileSync(reportPath, JSON.stringify({ subscription_id: SUB_ID }));
  const tx = '0x' + 'ab'.repeat(32);
  const lines = [];
  await runCheck({ fetchFn: mockFetch({ sub: { status: 'active', period_no: 2, last_tx: tx } }), base: BASE, env: {}, reportPath, log: (l) => lines.push(l) });
  assert.ok(lines.join('\n').includes(tx));
});

test('guard: PROBE_MAX_USD below amount x max_periods refuses before paying', async () => {
  let paid = false;
  await assert.rejects(
    runStart({ fetchFn: mockFetch(), payFetch: async () => { paid = true; return res(200, {}); }, base: BASE, env: { PROBE_MAX_USD: '1.99' }, flags: FLAGS, reportPath: tmpReport(), log: () => {} }),
    Refusal,
  );
  assert.equal(paid, false);
  assert.doesNotThrow(() => checkGuards({ base: BASE, flags: FLAGS, env: { PROBE_MAX_USD: '2.00' }, amount: 1, maxPeriods: 2 }));
});

test('guard: any merchant other than apibase-demo and any sku other than demo-weekly', () => {
  assert.throws(() => checkGuards({ base: BASE, flags: FLAGS, env: {}, merchant: 'other-shop' }), Refusal);
  assert.throws(() => checkGuards({ base: BASE, flags: FLAGS, env: {}, sku: 'demo-daily' }), Refusal);
});

test('guard: wrong terms (period, amount, max_periods) refuse', () => {
  for (const bad of [
    { ...TERMS, period: { unit: 'day', count: 1 } },
    { ...TERMS, amount: 5 },
    { ...TERMS, max_periods: 12 },
  ]) {
    assert.throws(() => assertTerms({ ...QUOTE, subscription_terms: bad }), Refusal);
  }
});

test('guard: mainnet without the dispatcher flag refuses (function and CLI), the flag is accepted', () => {
  assert.throws(() => checkGuards({ base: BASE, flags: [], env: {} }), Refusal);
  assert.doesNotThrow(() => checkGuards({ base: BASE, flags: FLAGS, env: {} }));
  assert.doesNotThrow(() => checkGuards({ base: 'http://127.0.0.1:1', flags: [], env: {} }));
  const r = spawnSync(process.execPath, [SCRIPT, 'start'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refused: .*mainnet/);
});

test('the signing key is never logged', () => {
  const dummy = '0x' + 'cd'.repeat(32);
  const r = spawnSync(process.execPath, [SCRIPT, 'start', '--i-am-the-dispatcher'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ['PROBE_' + 'PRIVATE_KEY']: dummy, PROBE_BASE_URL: 'http://127.0.0.1:9' },
  });
  assert.notEqual(r.status, 0);
  assert.equal((r.stdout + r.stderr).includes('cd'.repeat(32)), false);
});
