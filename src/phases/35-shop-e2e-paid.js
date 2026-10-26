/**
 * Phase 35 — first-party daily purchase on apibase-demo, both rails (T-0564).
 *
 * Buys the $0.01 `__apibase_test` SKU once on x402 (Base) and once on MPP (Tempo) with the
 * tester's own wallet (listed in APIbase config/autopilot/internal-wallets.json, so the ledger
 * marks the rows internal; the receipts are public). The merchant payout wallet is the operator's.
 * Flow follows /integrator/agent-guide step 7.
 *
 * Spends only when ALL of: SKIP_PAYMENTS=false, a wallet key, E2E_SHOP_PAID=true, the signer
 * is listed in internal-wallets.json on APIbase main (fail-closed), and the quoted prices of
 * both payments sum to <= $0.05 (pre-flight). Otherwise the zero-spend steps (quote, cancel) run
 * and the phase is SKIP with the reason. Every order this phase creates and does not pay is
 * cancelled in `finally`.
 */
const crypto = require('crypto');
const path = require('path');
const shop = require('../lib/shop-api');
const { sf } = require('../lib/http');
const { getWalletAddress, getX402Client, getX402HttpClient, makeX402PaymentPayload } = require('../lib/x402-client');
const { getMppClient } = require('../lib/mpp-client');
const { chargeOnce, sendWithCredential } = require('../lib/mpp-pay');
const e2e = require('../lib/shop-e2e');

const PHASE = 'P35';
const DELIVER_TIMEOUT_MS = 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const r = await sf(url, {}, 15000);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(await r.text());
}

async function usdcBalanceMicro(address) {
  const { createPublicClient, http, erc20Abi } = require('viem');
  const { base } = require('viem/chains');
  const c = createPublicClient({ chain: base, transport: http() });
  return c.readContract({ address: e2e.USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
}

// x402 payment header carrying a payment identifier, so a retry returns the stored answer.
async function x402Header(body402, paymentId) {
  const payload = await makeX402PaymentPayload(body402);
  const ext = body402.extensions?.['payment-identifier'] || {};
  payload.extensions = { ...(payload.extensions || {}), 'payment-identifier': { ...ext, info: { ...(ext.info || {}), required: false, id: paymentId } } };
  return Object.values(getX402HttpClient().encodePaymentSignatureHeader(payload))[0];
}

async function postJson(url, headers, body) {
  const r = await sf(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body ?? '{}' }, 60000);
  let text = '';
  try { text = await r.text(); } catch { /* keep empty */ }
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, headers: r.headers, json };
}

async function waitDelivered(config, orderId, buyer) {
  const end = Date.now() + DELIVER_TIMEOUT_MS;
  let last = null;
  while (Date.now() < end) {
    const o = await shop.call(config, 'GET', `/orders/${orderId}`, undefined, { Authorization: `Bearer ${buyer}` });
    last = o.json?.state;
    if (e2e.DELIVERED_STATES.has(last)) return { ok: true, state: last };
    await sleep(3000);
  }
  return { ok: false, state: last };
}

async function checkReceipt(scorer, config, rail, header, wallet) {
  const id = e2e.receiptId(header);
  scorer.rec(PHASE, `35.${rail} X-APIbase-Receipt present`, 'receipt id or URL', id ? 'present' : String(header), !!id);
  if (!id) return null;
  const r = await sf(`${config.apiBaseUrl}/r/${id}.json`, {}, 20000);
  let j = null;
  try { j = JSON.parse(await r.text()); } catch { j = null; }
  const payer = String(j?.payer ?? j?.payer_wallet ?? j?.wallet ?? '').toLowerCase();
  const mine = payer ? payer === wallet.toLowerCase() : JSON.stringify(j || {}).toLowerCase().includes(wallet.toLowerCase());
  scorer.redRec(PHASE, `35.${rail} /r/<id>.json public, payer is the tester wallet`, '200 + payer == our wallet', `${r.status} payer_match=${mine}`, r.status === 200 && mine);
  return id;
}

module.exports = async function phase35(scorer, config, context) {
  console.log('\n--- Phase 35: first-party purchase on apibase-demo (cap $0.05) ---');
  const runId = config.testerRunId;
  const orders = []; // { orderId, buyer, paid }
  const spent = { x402: 0, mpp: 0 };
  const ledger = [];
  let skipReason = e2e.paidGate(config);

  try {
    // 35.1 — zero-spend: quote the test SKU, then cancel the unpaid order.
    const z = { buyer: shop.newBuyerToken() };
    const zq = await shop.createQuote(config, e2e.TEST_SKU, undefined, `tester-p35-${crypto.randomUUID()}`, z.buyer);
    const zok = zq.status === 201 && !!zq.json?.quote_id && zq.json?.total_usd === 0.01;
    scorer.rec(PHASE, '35.1 quote __apibase_test', '201, total_usd 0.01', `${zq.status} ${zq.json?.total_usd}`, zok);
    if (zq.json?.order_id) orders.push({ orderId: zq.json.order_id, buyer: z.buyer, paid: false });
    if (zq.json?.order_id) {
      const c = await shop.cancelOrder(config, zq.json.order_id, z.buyer);
      scorer.rec(PHASE, '35.2 cancel an unpaid quote', '200 CANCELLED', `${c.status} ${c.json?.state}`, c.status === 200 && c.json?.state === 'CANCELLED');
      orders.pop();
    }

    if (skipReason) return;

    // Internal-wallet guard, fail-closed.
    const wallet = getWalletAddress();
    const internal = await e2e.isInternalWallet(wallet, fetchJson);
    if (!internal.ok) { skipReason = internal.why; return; }
    if (!getX402Client() || !getMppClient()) { skipReason = 'payment clients not initialised'; return; }

    // Pre-flight cap: both planned payments quoted before the first pay call.
    const planned = [];
    for (const rail of ['x402', 'mpp']) {
      const buyer = shop.newBuyerToken();
      const idem = `tester-p35-${rail}-${crypto.randomUUID()}`;
      const q = await shop.createQuote(config, e2e.TEST_SKU, undefined, idem, buyer);
      if (q.json?.order_id) orders.push({ orderId: q.json.order_id, buyer, paid: false });
      if (q.status !== 201 || !q.json?.quote_id) {
        if (q.json?.error === 'test_sku_daily_cap' || q.json?.error_code === 'test_sku_daily_cap') {
          scorer.blocked(PHASE, `35.${rail} quote`, 'daily test-SKU cap', 'test_sku_daily_cap: three paid test orders already today');
          skipReason = 'test_sku_daily_cap reached';
        } else {
          scorer.rec(PHASE, `35.${rail} quote for payment`, '201', `${q.status} ${q.json?.error}`, false);
          skipReason = `${rail} quote failed`;
        }
        return;
      }
      planned.push({ rail, buyer, idem, quote: q.json, order: orders[orders.length - 1] });
    }
    const pre = e2e.capPreflight(planned.map((p) => p.quote.total_usd));
    if (!pre.ok) { skipReason = `cap: ${pre.why}`; return; }
    scorer.rec(PHASE, '35.3 pre-flight spend cap', `planned <= $${e2e.SPEND_CAP_USD}`, `$${pre.sum}`, true);

    // 35.4 — x402 (Base): pay, deliver, receipt, replay.
    const px = planned[0];
    try {
      const payUrl = `${shop.base(config)}/quotes/${px.quote.quote_id}/pay`;
      const bearer = { Authorization: `Bearer ${px.buyer}`, 'X-Idempotency-Key': px.idem };
      const probe = await postJson(payUrl, bearer);
      scorer.rec(PHASE, '35.4 x402 challenge', '402 with accepts', `${probe.status}`, probe.status === 402 && !!probe.json?.accepts?.length);
      if (probe.status === 402 && probe.json?.accepts?.length) {
        const header = await x402Header(probe.json, `p35${crypto.randomBytes(12).toString('hex')}`);
        const before = await usdcBalanceMicro(wallet);
        const first = await postJson(payUrl, { ...bearer, 'X-PAYMENT': header });
        px.order.paid = first.status === 200;
        scorer.redRec(PHASE, '35.4 x402 pay', '200 FULFILLED|CLOSED', `${first.status} ${first.json?.state} ${first.json?.error || ''}`,
          first.status === 200 && e2e.DELIVERED_STATES.has(first.json?.state));
        if (first.status === 200) {
          const d = await waitDelivered(config, px.quote.order_id, px.buyer);
          scorer.redRec(PHASE, '35.4 x402 order delivered within 120 s', 'FULFILLED|DELIVERED|CLOSED', String(d.state), d.ok);
          const receipt = await checkReceipt(scorer, config, 'x402', first.headers.get('x-apibase-receipt'), wallet);
          let afterPay = await usdcBalanceMicro(wallet);
          for (let i = 0; i < 6 && afterPay === before; i++) { await sleep(5000); afterPay = await usdcBalanceMicro(wallet); }
          const delta = Number(before - afterPay) / 1e6;
          spent.x402 = delta > 0 ? delta : Number(px.quote.total_usd);
          scorer.redRec(PHASE, '35.4 x402 balance delta is the quote price once', `$${px.quote.total_usd}`, `$${delta}`, Math.abs(delta - Number(px.quote.total_usd)) < 1e-6);
          // Same signed payload, same key: same answer, no second transfer.
          const replay = await postJson(payUrl, { ...bearer, 'X-PAYMENT': header });
          const afterReplay = await usdcBalanceMicro(wallet);
          const idem = e2e.assertIdempotent(
            { order_id: first.json?.order_id, receipt: e2e.receiptId(first.headers.get('x-apibase-receipt')) },
            { status: replay.status, order_id: replay.json?.order_id, receipt: e2e.receiptId(replay.headers.get('x-apibase-receipt')) },
            { afterPay, afterReplay });
          scorer.redRec(PHASE, '35.4 x402 replay with the same key: same receipt, no second transfer', 'same order + receipt, balance unchanged',
            idem.ok ? 'idempotent' : idem.problems.join('; '), idem.ok);
          ledger.push({ rail: 'x402', spentUsd: spent.x402, orderId: px.quote.order_id, receipt: receipt || '' });
        }
      }
    } catch (e) { scorer.recCatch(PHASE, '35.4 x402 purchase', '200', e); }

    // 35.5 — MPP (Tempo, mppx current client).
    const pm = planned[1];
    try {
      const payUrl = `${shop.base(config)}/quotes/${pm.quote.quote_id}/pay`;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${pm.buyer}`, 'X-Idempotency-Key': pm.idem };
      const res = await chargeOnce(getMppClient(), payUrl, { ...headers }, '{}');
      if (!res.ok) {
        scorer.redRec(PHASE, '35.5 mpp pay', '200 FULFILLED|CLOSED', String(res.error), false);
      } else {
        pm.order.paid = res.status === 200;
        scorer.redRec(PHASE, '35.5 mpp pay', '200 FULFILLED|CLOSED', `${res.status} ${res.json?.state} ${res.json?.error || ''}`,
          res.status === 200 && e2e.DELIVERED_STATES.has(res.json?.state));
        if (res.status === 200) {
          spent.mpp = Number(pm.quote.total_usd);
          const d = await waitDelivered(config, pm.quote.order_id, pm.buyer);
          scorer.redRec(PHASE, '35.5 mpp order delivered within 120 s', 'FULFILLED|DELIVERED|CLOSED', String(d.state), d.ok);
          const receipt = await checkReceipt(scorer, config, 'mpp', res.headers.get('x-apibase-receipt'), wallet);
          // Replay of the settled credential: a refusal (403 credential_replayed) or the stored answer; never a second order.
          const again = await sendWithCredential(payUrl, { ...headers }, '{}', res.credential);
          const sameOrder = again.status === 200 && again.json?.order_id === res.json?.order_id;
          const refused = again.status === 403;
          scorer.redRec(PHASE, '35.5 mpp replay with the same key: refused or same order, never a second one', '403 credential_replayed | 200 same order',
            `${again.status} ${again.json?.error || again.json?.order_id || ''}`, sameOrder || refused);
          ledger.push({ rail: 'mpp', spentUsd: spent.mpp, orderId: pm.quote.order_id, receipt: receipt || '' });
        }
      }
    } catch (e) { scorer.recCatch(PHASE, '35.5 mpp purchase', '200', e); }

    // 35.6 — webhook delivery needs a public https receiver and the merchant key; neither is available to a daily run.
    if (!process.env.E2E_MERCHANT_KEY) {
      scorer.blocked(PHASE, '35.6 shop.order.paid webhook delivered, signature valid', 'no merchant key', 'E2E_MERCHANT_KEY not set');
    } else {
      scorer.blocked(PHASE, '35.6 shop.order.paid webhook delivered, signature valid', 'no public receiver',
        'the tester-local P32 receiver listens on 127.0.0.1; the webhook URL must be public https, and setting it would overwrite the merchant webhook');
    }

    // Spend accounting.
    context.spentX402 = (context.spentX402 || 0) + spent.x402;
    context.spentMPP = (context.spentMPP || 0) + spent.mpp;
    const v = e2e.capVerdict(spent.x402, spent.mpp);
    scorer.redRec(PHASE, '35.7 spent_usd within the cap', `<= $${e2e.SPEND_CAP_USD}`, `x402=$${spent.x402} mpp=$${spent.mpp} total=$${v.total}`, v.ok);
    console.log(`  spent_usd x402=${spent.x402} mpp=${spent.mpp}`);
  } catch (e) {
    scorer.recCatch(PHASE, '35.x phase', 'no exception', e);
  } finally {
    for (const o of orders) {
      if (o.paid) continue;
      try {
        const c = await shop.cancelOrder(config, o.orderId, o.buyer);
        scorer.rec(PHASE, '35.8 unpaid order cancelled', '200 CANCELLED', `${c.status} ${c.json?.state}`, c.status === 200 && c.json?.state === 'CANCELLED');
      } catch (e) { scorer.recCatch(PHASE, '35.8 cancel unpaid order', '200', e); }
    }
    if (ledger.length) {
      const verdict = e2e.capVerdict(spent.x402, spent.mpp).ok ? 'ok' : 'OVER_CAP';
      try { e2e.appendSpendLedger(ledger.map((l) => ({ ...l, runId, verdict })), path.join(__dirname, '..', '..', 'reports')); } catch (e) { console.log(`  spend ledger write failed: ${e.message}`); }
    }
    if (skipReason) scorer.skip(PHASE, skipReason);
  }
};

module.exports.ASSERTIONS = 24;
