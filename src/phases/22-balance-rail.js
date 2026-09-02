/**
 * Phase 22 — Balance-rail E2E (Э3, Fable's audit 2026-09-02, defect Д3).
 *
 * Д3 was: the balance-funded escrow path (an authenticated agent with a
 * prepaid balance and no per-call x402/MPP signature) was structurally
 * unreachable — `escrow.stage.ts`'s guard was a tautology given the control
 * flow above it, so a real prepaid-balance customer could never actually
 * pay from balance. No probe ever tried a plain Bearer-key call against a
 * priced tool without ALSO attaching a payment header, so nothing caught
 * this for months.
 *
 * Requires a real, operator-funded balance-rail test agent
 * (BALANCE_RAIL_TEST_KEY) — SKIPs cleanly without one. Verifies via the
 * account.usage/account.timeseries platform tools (already public MCP
 * tools), not direct DB access, so this stays a genuine black-box probe.
 */
const { sf, drain } = require('../lib/http');
const { pickSafeProbeTool } = require('../utils/assert');

const PHASE = 'P22';

async function readBalance(config, key) {
  const r = await sf(`${config.apiUrl}/tools/account.usage/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ period: '1d' }),
  });
  if (r.status !== 200) { await drain(r); return null; }
  let body = null;
  try { body = await r.json(); } catch { await drain(r); }
  const balance = body?.data?.balance_usd ?? body?.balance_usd ?? body?.metadata?.balance_usd;
  return typeof balance === 'number' ? balance : (balance != null ? parseFloat(balance) : null);
}

module.exports = async function phase22(scorer, config, context) {
  console.log('\n--- Phase 22: Balance-rail E2E ---');

  if (!config.balanceRailTestKey) {
    scorer.skip(PHASE, 'no BALANCE_RAIL_TEST_KEY configured — operator must provision an agent ' +
      'with a real prepaid balance (topping up an account balance is a real-money action, ' +
      'not something this tester invents for itself)');
    return;
  }

  const before = await readBalance(config, config.balanceRailTestKey);
  scorer.rec(PHASE, '22.1 balance readable before call', 'number', before === null ? 'unreadable' : before,
    before !== null, before === null ? 'account.usage did not return a balance_usd field' : 'ok');
  if (before === null) return;
  if (before <= 0) {
    scorer.skip(PHASE, `BALANCE_RAIL_TEST_KEY has $${before} balance — operator needs to top it up ` +
      'to actually exercise the reserve() path (a $0 balance would 402 correctly either way, ' +
      'proving nothing about whether the rail itself is reachable)');
    return;
  }

  const probe = pickSafeProbeTool(context.catalog);
  const probeId = probe.id || probe.name;
  const price = parseFloat(probe.pricing?.price_usd ?? probe.price_usd ?? '0');

  // The defect: a plain Bearer key with NO x402/MPP payment header should
  // pay from balance, not 402. This is the literal reproduction of Д3.
  let r;
  try {
    r = await sf(`${config.apiUrl}/tools/${probeId}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.balanceRailTestKey}` },
      body: JSON.stringify({}),
    });
  } catch (e) {
    scorer.recCatch(PHASE, '22.2 balance-funded call (no payment header)', '200', e);
    return;
  }
  let body = null;
  try { body = await r.json(); } catch { await drain(r); }

  // RED: this is the money-e2e class by name in Fable's verdict layer — a
  // balance customer unable to pay is a real customer-facing outage.
  scorer.redRec(PHASE, '22.2 balance-funded call (no payment header)', '200', String(r.status),
    r.status === 200, r.status === 200 ? `paid from balance, cost=${body?.metadata?.cost_usd ?? '?'}`
      : 'CRITICAL: balance rail unreachable — an authenticated agent with funds could not pay');

  if (r.status !== 200) return;

  const billingStatus = body?.metadata?.billing_status;
  scorer.rec(PHASE, '22.3 response names the rail', 'PAID/billing_status set', billingStatus || 'missing',
    !!billingStatus);

  await new Promise((res) => setTimeout(res, 2000));
  const after = await readBalance(config, config.balanceRailTestKey);
  const decreased = after !== null && after < before;
  scorer.redRec(PHASE, '22.4 balance actually decreased', `< $${before}`, after === null ? 'unreadable' : `$${after}`,
    decreased, decreased ? `debited ~$${(before - after).toFixed(6)} (tool price $${price})`
      : 'CRITICAL: call succeeded but balance did not move — money/ledger mismatch');

  console.log(`  Balance rail: before=$${before} after=$${after} tool=${probeId}`);
};
