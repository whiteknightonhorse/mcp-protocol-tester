// node --test scripts/mpp/subscription-week-probe.test.mjs   (mocked HTTP, no network, no real key)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { paymentHeaderValue, runStart, runCheck, checkGuards, assertTerms, Refusal, runStartBase, runCheckBase, buildTypedData, checkAuthorization, loadBuyerToken } from './subscription-week-probe.mjs';

const require = createRequire(import.meta.url);
const { privateKeyToAccount } = require('viem/accounts');
const { verifyTypedData } = require('viem');

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

// ---- T-0508: Base pull mode (mocked HTTP; the signer is a throwaway test key, not a wallet) --------

const TEST_KEY = '0x' + '11'.repeat(32);
const ACCOUNT = privateKeyToAccount(TEST_KEY);
const PAY_TO = '0x1234567890abcdef1234567890abcdef12345678';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const END = '2026-10-27T05:30:00.000Z';
const END_S = Math.floor(Date.parse(END) / 1000);
const NONCE = '0x' + '07'.repeat(32);
const BQUOTE = { ...QUOTE, pay: { x402: { payTo: PAY_TO, amount: '1000000', network: 'eip155:8453', asset: USDC, extra: { quote_id: 'q-1' } } } };
const RESOURCE = { url: 'https://apibase.test/api/v1/shop/quotes/q-1/pay', mimeType: 'application/json', description: 'Order payment: quote:q-1' };
const ACCEPT = { scheme: 'exact', network: 'eip155:8453', amount: '1000000', asset: USDC, payTo: PAY_TO };

function baseMock({ quote = BQUOTE, accepts = [ACCEPT], resource = RESOURCE, sub2 = {} } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/quotes')) return res(201, quote);
    if (url.endsWith('/pay')) {
      return init.headers?.['X-PAYMENT'] ? res(200, { order_id: 'o-1', subscription: { id: SUB_ID, period_no: 1 } }) : res(402, { accepts, ...(resource ? { resource } : {}) });
    }
    if (url.endsWith('/preauthorize')) return res(201, { subscription_id: SUB_ID, pull_mode: 'base_preauth', preauthorized_periods: [{ period_no: 2, status: 'pending' }] });
    if (url.includes('/subscriptions/')) {
      const stored = calls.some((c) => c.url.endsWith('/preauthorize'));
      return res(200, { subscription_id: SUB_ID, status: 'active', period_no: 1, current_period_end: END, next_charge_at: END, pull_mode: stored ? 'base_preauth' : 'none', preauthorized_periods: stored ? [{ period_no: 2, status: 'pending' }] : [], ...sub2 });
    }
    return res(404, {});
  };
  fn.calls = calls;
  return fn;
}
const signX402 = async () => ({ 'PAYMENT-SIGNATURE': 'eDQwMi1oZWFkZXI=' });
const preCalls = (f) => f.calls.filter((c) => c.url.endsWith('/preauthorize'));
const baseRun = (over = {}) => runStartBase({
  fetchFn: baseMock(), signX402, signer: ACCOUNT, base: BASE, env: {}, flags: FLAGS, reportPath: tmpReport(), secretPath: tmpReport(), log: () => {}, nonceFn: () => NONCE, ...over,
});

test('base start happy path: pays period 1, stores ONE period-2 authorization, report holds no signature or key', async () => {
  const reportPath = tmpReport();
  const fetchFn = baseMock();
  const out = await baseRun({ fetchFn, reportPath });
  assert.equal(preCalls(fetchFn).length, 1);
  const body = JSON.parse(preCalls(fetchFn)[0].init.body);
  assert.equal(body.authorizations.length, 1);
  const [item] = body.authorizations;
  assert.equal(item.period_no, 2);
  assert.deepEqual(item.authorization, {
    from: ACCOUNT.address, to: PAY_TO, value: '1000000', validAfter: String(END_S), validBefore: String(END_S + 86400), nonce: NONCE,
  });
  assert.ok(await verifyTypedData({ address: ACCOUNT.address, ...buildTypedData(item.authorization), signature: item.signature }));
  assert.equal(fetchFn.calls.find((c) => c.url.endsWith('/pay') && c.init.headers?.['X-PAYMENT']).init.headers['X-PAYMENT'], 'eDQwMi1oZWFkZXI=');
  assert.equal(out.stored_authorization.status, 'pending');
  const saved = readFileSync(reportPath, 'utf8');
  assert.equal(JSON.parse(saved).subscription_id, SUB_ID);
  assert.equal(saved.includes(item.signature), false);
  assert.equal(saved.includes('11'.repeat(32)), false);
});

test('base typed data equals an independently built EIP-712 fixture', () => {
  const a = { from: ACCOUNT.address, to: PAY_TO, value: '1000000', validAfter: '1792000000', validBefore: '1792086400', nonce: NONCE };
  const fixture = {
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: { from: a.from, to: a.to, value: 1000000n, validAfter: 1792000000n, validBefore: 1792086400n, nonce: NONCE },
  };
  assert.deepEqual(buildTypedData(a), fixture);
});

test('base guard: to differs from the quote payout wallet', async () => {
  const fetchFn = baseMock();
  await assert.rejects(baseRun({ fetchFn, authTo: '0x' + 'aa'.repeat(20) }), Refusal);
  assert.equal(preCalls(fetchFn).length, 0);
});

test('base guard: value differs from price x 1e6', async () => {
  const fetchFn = baseMock();
  await assert.rejects(baseRun({ fetchFn, authValue: '1000001' }), Refusal);
  assert.equal(preCalls(fetchFn).length, 0);
});

test('base guard: validBefore - validAfter outside 1..72 h', async () => {
  for (const authWindowS of [3599, 72 * 3600 + 1]) {
    const fetchFn = baseMock();
    await assert.rejects(baseRun({ fetchFn, authWindowS }), Refusal);
    assert.equal(preCalls(fetchFn).length, 0);
  }
  await baseRun({ authWindowS: 3600 });
  await baseRun({ authWindowS: 72 * 3600 });
});

test('base guard: period_no other than 2, and more than one authorization', async () => {
  const fetchFn = baseMock({ sub2: { period_no: 2 } }); // already at period 2 -> the next would be 3
  await assert.rejects(baseRun({ fetchFn }), Refusal);
  assert.equal(preCalls(fetchFn).length, 0);
  const auth = { to: PAY_TO, value: '1000000', validAfter: '1', validBefore: '86401' };
  assert.throws(() => checkAuthorization({ auth, periodNo: 2, expectedTo: PAY_TO, price: 1, count: 2 }), Refusal);
  assert.doesNotThrow(() => checkAuthorization({ auth, periodNo: 2, expectedTo: PAY_TO, price: 1 }));
});

test('base guard: a 402 challenge that differs from the quote is never signed', async () => {
  let signed = false;
  const fetchFn = baseMock({ accepts: [{ ...ACCEPT, payTo: '0x' + 'bb'.repeat(20) }] });
  await assert.rejects(baseRun({ fetchFn, signX402: async () => { signed = true; return 'h'; } }), Refusal);
  assert.equal(signed, false);
});

test('base guards: dispatcher flag, PROBE_MAX_USD, quote without x402', async () => {
  await assert.rejects(baseRun({ flags: [] }), Refusal);
  await assert.rejects(baseRun({ env: { PROBE_MAX_USD: '1.99' } }), Refusal);
  await assert.rejects(baseRun({ fetchFn: baseMock({ quote: QUOTE }) }), Refusal);
});

test('CLI: start --rail base without the dispatcher flag refuses; unknown rail is a usage error', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'start', '--rail', 'base'], { encoding: 'utf8', env: { PATH: process.env.PATH, ['PROBE_' + 'PRIVATE_KEY']: TEST_KEY } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refused: .*mainnet/);
  assert.equal((r.stdout + r.stderr).includes('11'.repeat(32)), false);
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'check', '--rail', 'solana'], { encoding: 'utf8' }).status, 2);
});

test('base check exit codes and authorization status / tx hash', async () => {
  const reportPath = tmpReport();
  writeFileSync(reportPath, JSON.stringify({ subscription_id: SUB_ID }));
  const tx = '0x' + 'ab'.repeat(32);
  const lines = [];
  const run = (sub, log = () => {}) => runCheckBase({ fetchFn: async () => res(200, { subscription_id: SUB_ID, ...sub }), base: BASE, env: {}, reportPath, log });
  assert.equal(await run({ status: 'active', period_no: 2, preauthorized_periods: [{ period_no: 2, status: 'settled', tx_hash: tx }] }, (l) => lines.push(l)), 0);
  assert.ok(lines.join('\n').includes(tx));
  assert.equal(await run({ status: 'active', period_no: 1, preauthorized_periods: [{ period_no: 2, status: 'pending' }] }), 3);
  assert.equal(await run({ status: 'active', period_no: 1, preauthorized_periods: [{ period_no: 2, status: 'submitted' }] }), 3);
  assert.equal(await run({ status: 'past_due', period_no: 1, preauthorized_periods: [{ period_no: 2, status: 'failed' }] }), 1);
  assert.equal(await run({ status: 'active', period_no: 1, preauthorized_periods: [{ period_no: 2, status: 'failed' }] }), 1);
  assert.equal(await run({ status: 'past_due', period_no: 1, preauthorized_periods: [] }), 1);
});

// ---- T-0509: the X-PAYMENT value must decode with the server's own decoder ----------------------------

test('T-0509: the real shop /pay 402 fixture signs (throwaway key) into a header the server decoder accepts', async () => {
  const require = createRequire(import.meta.url);
  const { decodePaymentSignatureHeader } = require('@x402/core/http');
  const { generatePrivateKey } = require('viem/accounts');
  const x402 = require('../../src/lib/x402-client.js');
  const body402 = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'shop-pay-402.json'), 'utf8'));
  assert.ok(x402.initX402(generatePrivateKey()));
  const raw = await x402.makeX402Payment(body402);
  // The regression: the raw value is an object, not a string; the server decoder refuses its string form.
  assert.equal(typeof raw, 'object');
  assert.throws(() => decodePaymentSignatureHeader(String(raw)), /Invalid payment signature header/);
  const value = paymentHeaderValue(raw);
  const decoded = decodePaymentSignatureHeader(value);
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepted.payTo, body402.accepts[0].payTo);
  assert.equal(decoded.payload.authorization.value, body402.accepts[0].amount);
  assert.equal(decoded.resource.url, body402.resource.url);
});

test('T-0509: paymentHeaderValue accepts the object or the bare base64, refuses anything else', () => {
  assert.equal(paymentHeaderValue({ 'PAYMENT-SIGNATURE': 'YWJj' }), 'YWJj');
  assert.equal(paymentHeaderValue('YWJj'), 'YWJj');
  for (const bad of [{}, null, undefined, '', '[object Object]', 42, { 'PAYMENT-SIGNATURE': 7 }]) {
    assert.throws(() => paymentHeaderValue(bad), Refusal);
  }
});

test('T-0509: a 402 challenge without resource.url is refused before anything is signed', async () => {
  for (const resource of [null, { url: '' }]) {
    let signed = false;
    const fetchFn = baseMock({ resource });
    await assert.rejects(baseRun({ fetchFn, signX402: async () => { signed = true; return 'YWJj'; } }), /no resource\.url/);
    assert.equal(signed, false);
  }
});

test('T-0509: the X-PAYMENT header sent to /pay is the bare base64 string, not an object', async () => {
  const fetchFn = baseMock();
  await baseRun({ fetchFn });
  const paid = fetchFn.calls.find((c) => c.url.endsWith('/pay') && c.init.headers?.['X-PAYMENT']);
  assert.equal(paid.init.headers['X-PAYMENT'], 'eDQwMi1oZWFkZXI=');
});

// ---- T-0510: the probe acts as the buyer identity the quote created -----------------------------------
const BT = 'bt_' + 'c3'.repeat(32);
const authOf = (c) => c.init.headers?.Authorization;

test('T-0510: buyer_token from the quote is saved (mode 600) and sent on pay, get and preauthorize', async () => {
  const secretPath = tmpReport();
  const fetchFn = baseMock({ quote: { ...BQUOTE, buyer_token: BT } });
  await baseRun({ fetchFn, secretPath, env: { PROBE_API_KEY: 'other-key' } });
  assert.equal(JSON.parse(readFileSync(secretPath, 'utf8')).buyer_token, BT);
  assert.equal(statSync(secretPath).mode & 0o777, 0o600);
  const after = fetchFn.calls.filter((c) => !c.url.endsWith('/quotes'));
  assert.ok(after.length >= 4);
  for (const c of after) assert.equal(authOf(c), `Bearer ${BT}`, c.url);
});

test('T-0510: the credential is on disk even when /pay fails, and the report and stdout never hold it', async () => {
  const secretPath = tmpReport();
  const reportPath = tmpReport();
  const lines = [];
  const quote = { ...BQUOTE, buyer_token: BT };
  const failing = async (url, init = {}) => (url.endsWith('/pay') ? res(500, {}) : baseMock({ quote })(url, init));
  await assert.rejects(baseRun({ fetchFn: failing, secretPath, reportPath, log: (l) => lines.push(l) }));
  assert.equal(loadBuyerToken(secretPath), BT);
  const ok = baseMock({ quote });
  await baseRun({ fetchFn: ok, secretPath, reportPath, log: (l) => lines.push(l) });
  assert.equal(lines.join('\n').includes(BT), false);
  assert.equal(readFileSync(reportPath, 'utf8').includes(BT), false);
});

test('T-0510: check reuses the saved buyer token, and falls back to PROBE_API_KEY without one', async () => {
  const reportPath = tmpReport();
  const secretPath = tmpReport();
  writeFileSync(reportPath, JSON.stringify({ subscription_id: SUB_ID }));
  writeFileSync(secretPath, JSON.stringify({ buyer_token: BT }));
  const seen = [];
  const fetchFn = async (url, init) => { seen.push(init.headers.Authorization); return res(200, { subscription_id: SUB_ID, status: 'active', period_no: 1, preauthorized_periods: [] }); };
  const lines = [];
  await runCheckBase({ fetchFn, base: BASE, env: {}, reportPath, secretPath, log: (l) => lines.push(l) });
  assert.deepEqual(seen, [`Bearer ${BT}`]);
  assert.equal(lines.join('\n').includes(BT), false);
  await runCheckBase({ fetchFn, base: BASE, env: { PROBE_API_KEY: 'k' }, reportPath, secretPath: tmpReport(), log: () => {} });
  assert.equal(seen[1], 'Bearer k');
});

test('T-0510: a malformed buyer_token in the quote is ignored, not saved', async () => {
  const secretPath = tmpReport();
  await baseRun({ fetchFn: baseMock({ quote: { ...BQUOTE, buyer_token: 'junk' } }), secretPath });
  assert.equal(loadBuyerToken(secretPath), undefined);
});
