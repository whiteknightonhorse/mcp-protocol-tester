/**
 * Phase 29 — Subscriptions on the demo shop (demo-daily), $0 (T-0349).
 *
 * Covered without paying: the subscribe quote and its terms (daily, 72 h
 * renewal window, cancel anytime), the 402 challenge carrying the subscription
 * binding, refusals (non-subscription SKU, quantity 2), and 404 for a
 * subscription that is not the caller's on every subscription route.
 * SKIPPED (BLOCKED list): everything that needs an ACTIVE subscription, which
 * exists only after period 1 is paid on-chain: setup, renewal quote in the
 * window, cancel of an active subscription, double-renew guard
 * (T-INT-48/49), past_due after an unpaid period (also needs a clock the
 * tester does not control).
 */
const shop = require('../lib/shop-api');
const { sf, drain } = require('../lib/http');
const { mcpRequest } = require('../lib/mcp-client');

const PHASE = 'P29';
const SKU = 'demo-daily';
const NO_SUB = '00000000-0000-4000-8000-000000000000';

module.exports = async function phase29(scorer, config, context) {
  console.log('\n--- Phase 29: Subscriptions (demo-daily, $0) ---');
  await mppSubscriptionMode(scorer, config, context);
  const buyer = shop.newBuyerToken();
  let quote = null;

  try {
    const q = await shop.createQuote(config, SKU, { subscribe: true }, undefined, buyer);
    quote = q.json;
    const ok = q.status === 201 && !!quote?.quote_id;
    scorer.rec(PHASE, '29.1 POST /quotes demo-daily subscribe:true', '201 + quote_id', `${q.status} ${quote?.quote_id || '(none)'}`, ok);
    if (!ok) quote = null;
    if (quote) {
      const t = quote.subscription_terms;
      scorer.rec(PHASE, '29.1 subscription_terms', 'daily, renewal_window_h 72, cancel_anytime, max_periods >= 1',
        JSON.stringify(t || null).slice(0, 100),
        t?.period?.unit === 'day' && t?.period?.count === 1 && t?.renewal_window_h === 72 && t?.cancel_anytime === true && t?.max_periods >= 1);
      scorer.rec(PHASE, '29.1 period 1 price equals terms amount', 'total_usd == terms.amount',
        `${quote.total_usd} vs ${t?.amount}`, quote.total_usd === t?.amount);
    }
  } catch (e) {
    scorer.recCatch(PHASE, '29.1 subscribe quote', '201', e);
  }

  if (quote) {
    try {
      const c = await shop.call(config, 'GET', `/quotes/${quote.quote_id}/pay`);
      scorer.rec(PHASE, '29.2 subscribe quote pay challenge', '402 payment_required, amount 1000000',
        `${c.status} ${c.json?.accepts?.[0]?.amount}`, c.status === 402 && c.json?.accepts?.[0]?.amount === '1000000');
    } catch (e) {
      scorer.recCatch(PHASE, '29.2 pay challenge', '402', e);
    }
  }

  // 29.3 — refusals.
  try {
    const noSub = await shop.createQuote(config, 'demo-bundle', { subscribe: true }, undefined, buyer);
    scorer.rec(PHASE, '29.3 subscribe:true on a non-subscription SKU', '422 validation_failed',
      `${noSub.status} ${noSub.json?.error}`, noSub.status === 422 && noSub.json?.error === 'validation_failed');
    const two = await shop.call(config, 'POST', '/quotes', { merchant: shop.SLUG, items: [{ sku: SKU, qty: 2 }], subscribe: true });
    scorer.rec(PHASE, '29.3 subscribe:true with quantity 2', '422 validation_failed',
      `${two.status} ${two.json?.error}`, two.status === 422 && two.json?.error === 'validation_failed');
  } catch (e) {
    scorer.recCatch(PHASE, '29.3 subscribe refusals', '422', e);
  }

  // 29.4 — someone else's / unknown subscription is a plain 404 on every route.
  try {
    const routes = [
      ['GET', `/subscriptions/${NO_SUB}`, undefined],
      ['POST', `/subscriptions/${NO_SUB}/cancel`, {}],
      ['POST', `/subscriptions/${NO_SUB}/preauthorize`, { authorizations: [] }],
      ['POST', `/subscriptions/${NO_SUB}/confirm-pull`, {}],
    ];
    const bad = [];
    for (const [m, p, b] of routes) {
      const r = await shop.call(config, m, p, b);
      if (r.status !== 404) bad.push(`${m} ${p.split('/').pop()} -> ${r.status}`);
    }
    scorer.rec(PHASE, '29.4 unknown subscription id on get/cancel/preauthorize/confirm-pull', '404 each',
      bad.length ? bad.join('; ') : '4 x 404', bad.length === 0);
  } catch (e) {
    scorer.recCatch(PHASE, '29.4 unknown subscription', '404', e);
  }

  // 29.5 — the paid half cannot run at $0.
  const why = 'an active subscription exists only after period 1 is paid on-chain; no demo-mode settlement, cost would not be $0';
  for (const step of [
    '29.5 setup: pay period 1 -> subscription active',
    '29.5 renewal quote inside the 72 h window',
    '29.5 cancel an active subscription',
    '29.5 double-renew guard (T-INT-48/49)',
  ]) scorer.blocked(PHASE, step, 'SKIPPED', why);
  scorer.blocked(PHASE, '29.5 past_due after an unpaid period', 'SKIPPED', `${why}; the period also has to elapse (daily) and the tester has no clock control`);

  if (quote) {
    try {
      const foreign = await shop.cancelOrder(config, quote.order_id, shop.newBuyerToken());
      scorer.rec(PHASE, '29.6 cancel with a foreign buyer identity', '404 (not your order)', String(foreign.status), foreign.status === 404);
      const c = await shop.cancelOrder(config, quote.order_id, buyer);
      scorer.rec(PHASE, '29.6 cancel the unpaid subscribe order (free)', '200 CANCELLED', `${c.status} ${c.json?.state}`, c.status === 200 && c.json?.state === 'CANCELLED');
    } catch (e) {
      scorer.recCatch(PHASE, '29.6 cancel unpaid order', '200', e);
    }
  }
};

// T-0433 (T-0431): the third pull mode `mpp_subscription` is only asserted when
// the integrator docs enumerate it, so a tester run against an older build is
// not red. No money moves: this reads the docs and the tool description.
async function mppSubscriptionMode(scorer, config, context) {
  try {
    const r = await sf(`${config.apiBaseUrl}/integrator/docs`, { headers: { Accept: 'text/markdown' } });
    const docs = r.status === 200 ? await r.text() : (await drain(r), '');
    const shipped = docs.indexOf('mpp_subscription') !== -1;
    if (!shipped) {
      scorer.blocked(PHASE, '29.7 mpp_subscription pull mode', 'NOT-SHIPPED',
        'pull_mode enum in /integrator/docs does not list mpp_subscription yet (T-0431 not deployed)');
      return;
    }
    const mcpUrl = `${config.apiBaseUrl}/mcp/m/${shop.SLUG}`;
    const init = await mcpRequest(mcpUrl, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-protocol-tester', version: '1.0' },
    });
    const list = await mcpRequest(mcpUrl, 'tools/list', {}, init.sessionId);
    const t = (list.body?.result?.tools || []).find((x) => x.name === 'shop.subscription.get');
    const desc = t ? String(t.description || '') : '';
    scorer.rec(PHASE, '29.7 shop.subscription.get describes mpp_subscription', 'description names mpp_subscription',
      t ? (desc.indexOf('mpp_subscription') !== -1 ? 'present' : 'absent') : 'tool missing',
      !!t && desc.indexOf('mpp_subscription') !== -1);
  } catch (e) {
    scorer.recCatch(PHASE, '29.7 mpp_subscription pull mode', 'docs fetched', e);
  }
}
