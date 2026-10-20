#!/usr/bin/env node
// T-0505: one-shot client for the T-0431 prod acceptance. One real `week` subscription on the demo
// shop: period 1 is paid with the MPP subscription intent, the renewal (period 2) is observed later.
//
//   PROBE_PRIVATE_KEY=<key> node scripts/mpp/subscription-week-probe.mjs start --i-am-the-dispatcher
//   node scripts/mpp/subscription-week-probe.mjs check
//
// T-0508: `--rail base` runs the Base pull variant instead (works with the platform fee off):
//   PROBE_PRIVATE_KEY=<key> node scripts/mpp/subscription-week-probe.mjs start --rail base --i-am-the-dispatcher
//   node scripts/mpp/subscription-week-probe.mjs check --rail base
// start --rail base: pay period 1 on Base (x402), then sign ONE EIP-3009 authorization for period 2
//        and store it with shop.subscription.preauthorize; the hourly worker pull renews it.
//        Report: reports/sub-week-probe-base.json (never the key or a signature).
// check --rail base: as check, plus the stored authorization status and its tx_hash.
//
// start: quote demo-weekly (subscribe:true), assert the terms, pay period 1, read the subscription,
//        write reports/sub-week-probe.json.
// check: read that file, read the subscription; exit 0 = period 2 credited and active,
//        3 = still waiting, 1 = past_due / failed / anything else.
// The key comes only from PROBE_PRIVATE_KEY and is never printed. Optional PROBE_API_KEY (Bearer)
// pins the buyer identity; without it the identity is the caller's IP, the same for every call.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MERCHANT = 'apibase-demo';
export const SKU = 'demo-weekly';
export const DEFAULT_BASE = 'https://apibase.pro';
export const DEFAULT_MAX_USD = 2.0;
export const REPORT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'sub-week-probe.json');
export const REPORT_BASE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'sub-week-probe-base.json');
export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_CHAIN_ID = 8453;
const HOUR_S = 3600;
const DISPATCHER_FLAG = '--i-am-the-dispatcher';
const TX_RE = /0x[0-9a-fA-F]{64}/;

export class Refusal extends Error {}

const isMainnet = (base) => {
  try {
    const h = new URL(base).hostname;
    return h === 'apibase.pro' || h.endsWith('.apibase.pro');
  } catch {
    return true; // unparseable: treat as the dangerous case
  }
};

// Guards that need no network: the money cap, the merchant/sku pin, the mainnet flag.
export function checkGuards({ base, flags, env, merchant = MERCHANT, sku = SKU, amount, maxPeriods }) {
  if (merchant !== MERCHANT) throw new Refusal(`refused: merchant ${merchant} is not ${MERCHANT}`);
  if (sku !== SKU) throw new Refusal(`refused: sku ${sku} is not ${SKU}`);
  if (isMainnet(base) && !flags.includes(DISPATCHER_FLAG)) {
    throw new Refusal(`refused: ${base} is mainnet; only the dispatcher passes ${DISPATCHER_FLAG}`);
  }
  if (amount !== undefined) {
    const cap = Number(env.PROBE_MAX_USD ?? DEFAULT_MAX_USD);
    const worst = amount * maxPeriods;
    if (!Number.isFinite(cap) || cap < worst) {
      throw new Refusal(`refused: PROBE_MAX_USD ${env.PROBE_MAX_USD ?? DEFAULT_MAX_USD} < amount ${amount} x max_periods ${maxPeriods}`);
    }
  }
}

export function assertTerms(quote) {
  const t = quote?.subscription_terms;
  const ok = t && t.period?.unit === 'week' && t.period?.count === 1 && Number(t.amount) === 1 && t.max_periods === 2 &&
    Number(quote.total_usd) === 1;
  if (!ok) throw new Refusal(`refused: unexpected terms ${JSON.stringify(t || null).slice(0, 200)}`);
  return t;
}

const parse = async (res) => {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
};

function headers(env, json) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (env.PROBE_API_KEY) h.Authorization = `Bearer ${env.PROBE_API_KEY}`;
  return h;
}

export async function getSubscription({ fetchFn, base, env, id }) {
  const res = await fetchFn(`${base}/api/v1/shop/subscriptions/${id}`, { headers: headers(env, false) });
  const body = await parse(res);
  if (res.status !== 200) throw new Error(`subscription get: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const summary = (s) => ({
  subscription_id: s.subscription_id,
  status: s.status,
  period_no: s.period_no,
  current_period_end: s.current_period_end,
  next_charge_at: s.next_charge_at,
  pull_mode: s.pull_mode,
});

// payFetch(url, init) is an mppx client fetch bound to the payer's account (injected in tests).
export async function runStart({ fetchFn, payFetch, base, env, flags, reportPath = REPORT, log = console.log }) {
  checkGuards({ base, flags, env });
  const qres = await fetchFn(`${base}/api/v1/shop/quotes`, {
    method: 'POST',
    headers: headers(env, true),
    body: JSON.stringify({ merchant: MERCHANT, items: [{ sku: SKU, qty: 1 }], subscribe: true }),
  });
  const quote = await parse(qres);
  if (qres.status !== 201 || !quote.quote_id) throw new Error(`quote: HTTP ${qres.status} ${JSON.stringify(quote).slice(0, 200)}`);
  const terms = assertTerms(quote);
  checkGuards({ base, flags, env, amount: Number(terms.amount), maxPeriods: terms.max_periods });

  const pres = await payFetch(`${base}/api/v1/shop/quotes/${quote.quote_id}/pay?intent=subscription`, {
    method: 'POST',
    headers: headers(env, true),
    body: '{}',
  });
  const paid = await parse(pres);
  if (pres.status !== 200 && pres.status !== 201) throw new Error(`pay: HTTP ${pres.status} ${JSON.stringify(paid).slice(0, 200)}`);

  let id = paid.subscription?.id || paid.subscription_id || null;
  if (!id && paid.order_id) {
    const ores = await fetchFn(`${base}/api/v1/shop/orders/${paid.order_id}`, { headers: headers(env, false) });
    id = (await parse(ores)).subscription?.id || null;
  }
  if (!id) throw new Error('pay succeeded but no subscription id was returned; look the order up by hand');

  const out = summary(await getSubscription({ fetchFn, base, env, id }));
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ ...out, quote_id: quote.quote_id, started_at: new Date().toISOString() }, null, 2) + '\n');
  log(JSON.stringify(out));
  return out;
}

// Returns the exit code.
// check only reads, so it needs no dispatcher flag.
export async function runCheck({ fetchFn, base, env, reportPath = REPORT, log = console.log }) {
  const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
  const sub = await getSubscription({ fetchFn, base, env, id: saved.subscription_id });
  log(JSON.stringify({ ...summary(sub) }));
  if (sub.status === 'active' && sub.period_no === 2) {
    const tx = TX_RE.exec(JSON.stringify(sub));
    log(`period 2 credited; tx ${tx ? tx[0] : 'not in the subscription view'}`);
    return 0;
  }
  if (sub.status === 'active' || sub.status === 'pending') {
    log(`waiting: status ${sub.status}, period_no ${sub.period_no}`);
    return 3;
  }
  log(`failed: status ${sub.status}, period_no ${sub.period_no}, reason ${sub.status_reason ?? 'none'}`);
  return 1;
}

// ---- T-0508: Base pull mode ------------------------------------------------------------------

export const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

// The EIP-712 payload viem signs: USDC domain on Base, built only from the authorization.
export function buildTypedData(a) {
  return {
    domain: { name: 'USD Coin', version: '2', chainId: BASE_CHAIN_ID, verifyingContract: USDC_BASE },
    types: TRANSFER_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
  };
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// T-0509: makeX402Payment returns the x402HTTPClient header OBJECT ({'PAYMENT-SIGNATURE': <base64>});
// the T-0508 probe put that object into X-PAYMENT, which fetch sent as "[object Object]" and the
// server's decodePaymentSignatureHeader refused. Accept the object or the bare string, return the
// base64 value, and refuse anything the server's decoder would reject.
export function paymentHeaderValue(raw) {
  const v = raw && typeof raw === 'object' ? (raw['PAYMENT-SIGNATURE'] ?? raw['X-PAYMENT']) : raw;
  if (typeof v !== 'string' || !B64_RE.test(v)) throw new Refusal('refused: the signed x402 payment is not a base64 header value; not sending it');
  return v;
}

const lc = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

// Guards on the authorization itself, run before anything is signed.
export function checkAuthorization({ auth, periodNo, expectedTo, price, count = 1 }) {
  if (count !== 1) throw new Refusal(`refused: ${count} authorizations; exactly one per run`);
  if (periodNo !== 2) throw new Refusal(`refused: period_no ${periodNo} is not 2`);
  if (typeof expectedTo !== 'string' || lc(auth.to) !== lc(expectedTo)) {
    throw new Refusal(`refused: to ${auth.to} is not the payout wallet the quote named (${expectedTo})`);
  }
  if (!Number.isFinite(price) || String(auth.value) !== String(Math.round(price * 1e6))) {
    throw new Refusal(`refused: value ${auth.value} is not price ${price} x 1e6`);
  }
  const span = Number(auth.validBefore) - Number(auth.validAfter);
  if (!Number.isFinite(span) || span < HOUR_S || span > 72 * HOUR_S) {
    throw new Refusal(`refused: validBefore - validAfter = ${span}s is outside 1..72 h`);
  }
}

const stripSecrets = (o) => {
  if (Array.isArray(o)) return o.map(stripSecrets);
  if (o && typeof o === 'object') {
    return Object.fromEntries(Object.entries(o).filter(([k]) => !/signature|private/i.test(k)).map(([k, v]) => [k, stripSecrets(v)]));
  }
  return o;
};

const authView = (sub, periodNo) => (sub.preauthorized_periods || []).find((p) => p.period_no === periodNo) || null;

// signer: {address, signTypedData(typedData)}; signX402(body402) -> X-PAYMENT header value.
// authWindowS / authTo / authValue are test seams for the guards; production uses the defaults.
export async function runStartBase({ fetchFn, signX402, signer, base, env, flags, reportPath = REPORT_BASE, log = console.log, nonceFn = () => `0x${randomBytes(32).toString('hex')}`, authWindowS = 24 * HOUR_S, authTo, authValue }) {
  checkGuards({ base, flags, env });
  const qres = await fetchFn(`${base}/api/v1/shop/quotes`, {
    method: 'POST',
    headers: headers(env, true),
    body: JSON.stringify({ merchant: MERCHANT, items: [{ sku: SKU, qty: 1 }], subscribe: true }),
  });
  const quote = await parse(qres);
  if (qres.status !== 201 || !quote.quote_id) throw new Error(`quote: HTTP ${qres.status} ${JSON.stringify(quote).slice(0, 200)}`);
  const terms = assertTerms(quote);
  checkGuards({ base, flags, env, amount: Number(terms.amount), maxPeriods: terms.max_periods });
  const x = quote.pay?.x402;
  if (!x || typeof x.payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(x.payTo)) throw new Refusal('refused: the quote has no x402 payment on Base');
  const price = Number(terms.amount);
  const payTo = x.payTo;
  if (String(x.amount) !== String(Math.round(price * 1e6))) throw new Refusal(`refused: quote x402 amount ${x.amount} is not price ${price} x 1e6`);

  // Period 1: unpaid POST -> 402 challenge -> it must name the quote's payee and amount -> sign -> pay.
  const payUrl = `${base}/api/v1/shop/quotes/${quote.quote_id}/pay`;
  const c = await fetchFn(payUrl, { method: 'POST', headers: headers(env, true), body: '{}' });
  const challenge = await parse(c);
  if (c.status !== 402 || !Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
    throw new Error(`pay challenge: HTTP ${c.status} ${JSON.stringify(challenge).slice(0, 200)}`);
  }
  if (typeof challenge.resource?.url !== 'string' || challenge.resource.url === '') {
    throw new Refusal('refused: the 402 challenge carries no resource.url; not signing');
  }
  for (const a of challenge.accepts) {
    if (lc(a.payTo) !== lc(payTo) || String(a.amount) !== String(x.amount) || a.network !== 'eip155:8453' || lc(a.asset) !== USDC_BASE) {
      throw new Refusal('refused: the 402 challenge differs from the quote (payee, amount, network or asset)');
    }
  }
  const pres = await fetchFn(payUrl, {
    method: 'POST',
    headers: { ...headers(env, true), 'X-PAYMENT': paymentHeaderValue(await signX402(challenge)) },
    body: '{}',
  });
  const paid = await parse(pres);
  if (pres.status !== 200 && pres.status !== 201) throw new Error(`pay: HTTP ${pres.status} ${JSON.stringify(paid).slice(0, 200)}`);
  let id = paid.subscription?.id || paid.subscription_id || null;
  if (!id && paid.order_id) {
    const ores = await fetchFn(`${base}/api/v1/shop/orders/${paid.order_id}`, { headers: headers(env, false) });
    id = (await parse(ores)).subscription?.id || null;
  }
  if (!id) throw new Error('pay succeeded but no subscription id was returned; look the order up by hand');

  const sub = await getSubscription({ fetchFn, base, env, id });
  const end = Date.parse(sub.current_period_end);
  if (!Number.isFinite(end)) throw new Error(`subscription has no usable current_period_end: ${sub.current_period_end}`);
  const nextPeriod = sub.period_no + 1;
  const validAfter = Math.floor(end / 1000);
  const auth = {
    from: signer.address,
    to: authTo ?? payTo,
    value: authValue ?? String(Math.round(price * 1e6)),
    validAfter: String(validAfter),
    validBefore: String(validAfter + authWindowS),
    nonce: nonceFn(),
  };
  checkAuthorization({ auth, periodNo: nextPeriod, expectedTo: payTo, price });
  const signature = await signer.signTypedData(buildTypedData(auth));

  const pre = await fetchFn(`${base}/api/v1/shop/subscriptions/${id}/preauthorize`, {
    method: 'POST',
    headers: headers(env, true),
    body: JSON.stringify({ authorizations: [{ period_no: nextPeriod, authorization: auth, signature }] }),
  });
  const preBody = await parse(pre);
  if (pre.status !== 200 && pre.status !== 201) throw new Error(`preauthorize: HTTP ${pre.status} ${JSON.stringify(stripSecrets(preBody)).slice(0, 200)}`);

  const after = await getSubscription({ fetchFn, base, env, id });
  const out = {
    ...summary(after),
    quote_id: quote.quote_id,
    payout_wallet: payTo,
    authorization: { period_no: nextPeriod, valid_after: auth.validAfter, valid_before: auth.validBefore, value: auth.value },
    preauthorize_response: stripSecrets(preBody),
    stored_authorization: authView(after, nextPeriod),
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ ...out, started_at: new Date().toISOString() }, null, 2) + '\n');
  log(JSON.stringify(out));
  return out;
}

// Returns the exit code: 0 period 2 credited and active, 3 waiting, 1 failed / past_due / anything else.
export async function runCheckBase({ fetchFn, base, env, reportPath = REPORT_BASE, log = console.log }) {
  const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
  const sub = await getSubscription({ fetchFn, base, env, id: saved.subscription_id });
  const a = authView(sub, 2);
  log(JSON.stringify({ ...summary(sub), authorization_status: a?.status ?? null, tx_hash: a?.tx_hash ?? null }));
  if (sub.status === 'active' && sub.period_no === 2) {
    log(`period 2 credited; authorization ${a?.status ?? 'not shown'}; tx ${a?.tx_hash ?? 'not shown'}`);
    return 0;
  }
  if (a?.status === 'failed' || a?.status === 'canceled') {
    log(`failed: authorization ${a.status}, subscription ${sub.status}, period_no ${sub.period_no}`);
    return 1;
  }
  if (sub.status === 'active' || sub.status === 'pending') {
    log(`waiting: status ${sub.status}, period_no ${sub.period_no}, authorization ${a?.status ?? 'none'}`);
    return 3;
  }
  log(`failed: status ${sub.status}, period_no ${sub.period_no}, reason ${sub.status_reason ?? 'none'}`);
  return 1;
}

async function main() {
  const [cmd, ...flags] = process.argv.slice(2);
  const env = process.env;
  const ri = flags.findIndex((f) => f === '--rail' || f.startsWith('--rail='));
  const rail = ri < 0 ? 'tempo' : flags[ri].includes('=') ? flags[ri].split('=')[1] : flags[ri + 1];
  if (rail !== 'tempo' && rail !== 'base') {
    process.stderr.write('usage: --rail tempo|base\n');
    process.exitCode = 2;
    return;
  }
  const base = (env.PROBE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  try {
    if (cmd === 'start') {
      checkGuards({ base, flags, env }); // before the key is even looked at
      const key = env.PROBE_PRIVATE_KEY || '';
      if (!key) throw new Refusal('refused: PROBE_PRIVATE_KEY is not set');
      const require = createRequire(import.meta.url);
      const { privateKeyToAccount } = require('viem/accounts');
      if (rail === 'base') {
        const x402 = require('../../src/lib/x402-client.js');
        if (!x402.initX402(key)) throw new Error('x402 client init failed');
        await runStartBase({ fetchFn: fetch, signX402: x402.makeX402Payment, signer: privateKeyToAccount(key), base, env, flags });
        return;
      }
      const { Mppx, tempo } = require('mppx/client');
      const account = privateKeyToAccount(key);
      const client = Mppx.create({ polyfill: false, methods: [tempo.subscription({ account })] });
      await runStart({ fetchFn: fetch, payFetch: client.fetch.bind(client), base, env, flags });
    } else if (cmd === 'check') {
      process.exitCode = await (rail === 'base' ? runCheckBase : runCheck)({ fetchFn: fetch, base, env });
    } else {
      process.stderr.write('usage: subscription-week-probe.mjs start|check [--i-am-the-dispatcher]\n');
      process.exitCode = 2;
    }
  } catch (e) {
    const msg = String(e?.message || e);
    process.stderr.write(`${msg.split(env.PROBE_PRIVATE_KEY || '\u0000').join('[redacted]')}\n`);
    process.exitCode = e instanceof Refusal ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
