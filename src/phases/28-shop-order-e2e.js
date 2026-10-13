/**
 * Phase 28 — Shop order flow on the demo shop: quote -> 402 challenge -> pay (T-0349).
 *
 * Demo shop only (apibase-demo). Cost is $0: no payment is ever signed.
 * Covered: quote shape, 402 challenge (amount, payee is not a platform wallet,
 * rails x402 + MPP), replay of the same quote -> same binding, amount mismatch
 * -> 402 and the order stays QUOTED.
 * Tempo exception (ruling T-0349 q-1): apibase-demo's Tempo payout IS the platform
 * Tempo wallet by design; the stream pilot key must equal it (docs/integrator.md:94,
 * src/shop/stream-session.ts:187-219). So for slug apibase-demo only, the MPP
 * "not the platform wallet" sub-check is SKIPPED; the recipient is still required to be
 * a well-formed address. Any other slug keeps the full hard check on both rails.
 * SKIPPED (stated in the BLOCKED list): the paid half (pay -> DELIVERED, receipt
 * idempotent on replay). The server has no demo-mode settlement switch; a real
 * pay needs a funded on-chain USDC authorization, which this phase never makes.
 */
const crypto = require('crypto');
const shop = require('../lib/shop-api');
const { sf, drain } = require('../lib/http');

const PHASE = 'P28';
const SKU = 'demo-bundle';
const PRICE_MICRO = '5000000';

module.exports = async function phase28(scorer, config) {
  console.log('\n--- Phase 28: Shop order flow (demo shop, $0) ---');
  const idem = `tester-p28-${crypto.randomUUID()}`;
  let quote = null;

  // 28.1 — quote.
  try {
    const q = await shop.createQuote(config, SKU, undefined, idem);
    quote = q.json;
    const ok = q.status === 201 && !!quote?.quote_id && !!quote?.order_id;
    scorer.rec(PHASE, '28.1 POST /quotes demo-bundle', '201 + quote_id + order_id', `${q.status} ${quote?.quote_id || '(none)'}`, ok);
    if (!ok) quote = null;
    if (quote) {
      scorer.rec(PHASE, '28.1 quote total and item', 'total_usd 5, sku demo-bundle',
        `total_usd=${quote.total_usd} sku=${quote.items?.[0]?.sku}`, quote.total_usd === 5 && quote.items?.[0]?.sku === SKU);
      scorer.rec(PHASE, '28.1 quote offers both rails', 'pay.x402 + pay.mpp',
        `x402=${!!quote.pay?.x402} mpp=${!!quote.pay?.mpp}`, !!quote.pay?.x402 && !!quote.pay?.mpp);
    }
  } catch (e) {
    scorer.recCatch(PHASE, '28.1 POST /quotes', '201', e);
  }
  if (!quote) {
    scorer.rec(PHASE, '28.x remaining steps', 'a quote', 'no quote', false, 'quote creation failed, rest of the phase cannot run');
    return;
  }
  const qid = quote.quote_id;
  const payPath = `/quotes/${qid}/pay`;

  try {
    // 28.2 — the 402 challenge.
    const c1 = await shop.call(config, 'GET', payPath);
    const pr = shop.decodeB64Json(c1.headers.get('payment-required'));
    const acc = c1.json?.accepts?.[0];
    scorer.rec(PHASE, '28.2 GET /pay without payment', '402 + PAYMENT-REQUIRED header', `${c1.status} header=${!!pr}`, c1.status === 402 && !!pr);
    scorer.rec(PHASE, '28.2 x402 amount', `${PRICE_MICRO} micro-USDC on eip155:8453`,
      `${acc?.amount} ${acc?.network}`, acc?.amount === PRICE_MICRO && acc?.network === 'eip155:8453');
    scorer.rec(PHASE, '28.2 x402 payTo is the quote payee, not a platform wallet', `== quote.pay.x402.payTo, != ${shop.PLATFORM_BASE}`,
      String(acc?.payTo),
      !!acc?.payTo && acc.payTo === quote.pay.x402.payTo && acc.payTo.toLowerCase() !== shop.PLATFORM_BASE.toLowerCase());
    scorer.rec(PHASE, '28.2 header and body carry the same accepts', 'payTo/amount equal',
      `${pr?.accepts?.[0]?.payTo} ${pr?.accepts?.[0]?.amount}`, pr?.accepts?.[0]?.payTo === acc?.payTo && pr?.accepts?.[0]?.amount === acc?.amount);

    const mpp1 = shop.parseMppChallenge(c1.headers.get('www-authenticate'));
    scorer.rec(PHASE, '28.2 MPP challenge (Tempo)', 'WWW-Authenticate: Payment method=tempo, amount 5000000',
      `${mpp1?.method} ${mpp1?.request?.amount}`, mpp1?.method === 'tempo' && mpp1?.request?.amount === PRICE_MICRO);
    const recipient = String(mpp1?.request?.recipient || '');
    const wellFormed = /^0x[0-9a-fA-F]{40}$/.test(recipient);
    if (shop.SLUG === 'apibase-demo') {
      scorer.rec(PHASE, '28.2 MPP recipient is a well-formed address', '0x + 40 hex', recipient || '(none)', wellFormed);
      scorer.blocked(PHASE, '28.2 MPP recipient is not the platform Tempo wallet', 'SKIPPED',
        'apibase-demo Tempo payout is the operator wallet by design, stream pilot requires it (docs/integrator.md:94, src/shop/stream-session.ts:187-219)');
    } else {
      scorer.rec(PHASE, '28.2 MPP recipient is the merchant payout, not the platform Tempo wallet', `!= ${shop.PLATFORM_TEMPO}`,
        recipient || '(none)', wellFormed && recipient.toLowerCase() !== shop.PLATFORM_TEMPO.toLowerCase());
    }

    // 28.3 — replay of the same quote -> same binding.
    const again = await shop.createQuote(config, SKU, undefined, idem);
    scorer.rec(PHASE, '28.3 replay POST /quotes, same Idempotency-Key', 'same quote_id and order_id',
      `${again.status} ${again.json?.quote_id}`, again.json?.quote_id === qid && again.json?.order_id === quote.order_id);
    const got = await shop.call(config, 'GET', `/quotes/${qid}`);
    scorer.rec(PHASE, '28.3 GET /quotes/:id', 'same payTo and amount as at creation',
      `${got.status} ${got.json?.pay?.x402?.payTo} ${got.json?.pay?.x402?.amount}`,
      got.status === 200 && got.json?.pay?.x402?.payTo === quote.pay.x402.payTo && got.json?.pay?.x402?.amount === quote.pay.x402.amount);
    const c2 = await shop.call(config, 'GET', payPath);
    const mpp2 = shop.parseMppChallenge(c2.headers.get('www-authenticate'));
    scorer.rec(PHASE, '28.3 second challenge is the stored one', 'same MPP challenge id, same payTo',
      `${mpp2?.id === mpp1?.id ? 'same id' : 'new id'} ${c2.json?.accepts?.[0]?.payTo}`,
      !!mpp1?.id && mpp2?.id === mpp1.id && c2.json?.accepts?.[0]?.payTo === acc?.payTo);

    // 28.4 — amount mismatch -> 402, order stays QUOTED.
    const bad = await sf(`${config.apiBaseUrl}/api/v1/shop${payPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': shop.wrongAmountPayment(qid, acc?.payTo || quote.pay.x402.payTo, 1) },
      body: '{}',
    });
    let badBody = null;
    try { badBody = await bad.json(); } catch { await drain(bad); }
    scorer.rec(PHASE, '28.4 payment for 1 micro-USDC instead of 5000000', '402 payment_amount_mismatch',
      `${bad.status} ${badBody?.error}`, bad.status === 402 && badBody?.error === 'payment_amount_mismatch');
    const ord = await shop.call(config, 'GET', `/orders/${quote.order_id}`);
    scorer.rec(PHASE, '28.4 order untouched by the refused payment', 'state QUOTED, tx_hash null',
      `${ord.json?.state} ${ord.json?.tx_hash}`, ord.status === 200 && ord.json?.state === 'QUOTED' && ord.json?.tx_hash === null);
  } catch (e) {
    scorer.recCatch(PHASE, '28.2-28.4 challenge / replay / mismatch', '402', e);
  }

  // 28.5 — the paid half cannot run at $0.
  const why = 'no demo-mode settlement exists on the server; paying needs a signed on-chain USDC authorization, so cost would not be $0';
  scorer.blocked(PHASE, '28.5 pay -> order DELIVERED (fulfillment_mode instant)', 'SKIPPED', why);
  scorer.blocked(PHASE, '28.5 receipt idempotent on replay', 'SKIPPED', `${why}; needs a paid order`);

  // Cleanup: void the unpaid quote.
  try {
    const c = await shop.cancelOrder(config, quote.order_id);
    scorer.rec(PHASE, '28.6 cancel the unpaid order (free)', '200 CANCELLED', `${c.status} ${c.json?.state}`, c.status === 200 && c.json?.state === 'CANCELLED');
  } catch (e) {
    scorer.recCatch(PHASE, '28.6 cancel unpaid order', '200', e);
  }
};
