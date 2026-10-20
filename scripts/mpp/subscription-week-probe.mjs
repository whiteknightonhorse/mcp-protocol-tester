#!/usr/bin/env node
// T-0505: one-shot client for the T-0431 prod acceptance. One real `week` subscription on the demo
// shop: period 1 is paid with the MPP subscription intent, the renewal (period 2) is observed later.
//
//   PROBE_PRIVATE_KEY=<key> node scripts/mpp/subscription-week-probe.mjs start --i-am-the-dispatcher
//   node scripts/mpp/subscription-week-probe.mjs check
//
// start: quote demo-weekly (subscribe:true), assert the terms, pay period 1, read the subscription,
//        write reports/sub-week-probe.json.
// check: read that file, read the subscription; exit 0 = period 2 credited and active,
//        3 = still waiting, 1 = past_due / failed / anything else.
// The key comes only from PROBE_PRIVATE_KEY and is never printed. Optional PROBE_API_KEY (Bearer)
// pins the buyer identity; without it the identity is the caller's IP, the same for every call.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MERCHANT = 'apibase-demo';
export const SKU = 'demo-weekly';
export const DEFAULT_BASE = 'https://apibase.pro';
export const DEFAULT_MAX_USD = 2.0;
export const REPORT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reports', 'sub-week-probe.json');
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

async function main() {
  const [cmd, ...flags] = process.argv.slice(2);
  const env = process.env;
  const base = (env.PROBE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  try {
    if (cmd === 'start') {
      checkGuards({ base, flags, env }); // before the key is even looked at
      const key = env.PROBE_PRIVATE_KEY || '';
      if (!key) throw new Refusal('refused: PROBE_PRIVATE_KEY is not set');
      const require = createRequire(import.meta.url);
      const { privateKeyToAccount } = require('viem/accounts');
      const { Mppx, tempo } = require('mppx/client');
      const account = privateKeyToAccount(key);
      const client = Mppx.create({ polyfill: false, methods: [tempo.subscription({ account })] });
      await runStart({ fetchFn: fetch, payFetch: client.fetch.bind(client), base, env, flags });
    } else if (cmd === 'check') {
      process.exitCode = await runCheck({ fetchFn: fetch, base, env });
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
