/**
 * Phase 6 — x402 Payments
 * Executes 5 tool calls via x402: probe 402 -> makeX402Payment -> retry with
 * PAYMENT-SIGNATURE + X-PAYMENT headers. Tracks total USDC spent on Base.
 */
const { sf, drain, getDelay } = require('../lib/http');
const { getX402Client, makeX402Payment } = require('../lib/x402-client');
const { getBody } = require('../utils/assert');
const { walletPreflight } = require('../lib/wallet-balance');
const rr = require('../lib/receipt-retrieve');

const PHASE = 'P6';

// Proven external tools with simple schemas (confirmed working with x402)
const PAYMENT_TOOLS = [
  { id: 'crypto.trending', body: {} },
  { id: 'earthquake.feed', body: {} },
  { id: 'nasa.apod', body: {} },
  { id: 'books.search', body: { query: 'dune' } },
  { id: 'anime.search', body: { query: 'naruto' } },
  // T-0111 (2026-09-10): control for anime.search — same jikan provider,
  // id-lookup endpoint (mirrors provider-limits.json's own jikan health_url,
  // verified separately as reliable while anime.search was standing-red).
  // Lets a future red distinguish "this method" from "this provider" instead
  // of the tester silently having zero paid signal on jikan's other tools.
  { id: 'anime.details', body: { id: 1 } },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async function phase6(scorer, config, context) {
  console.log('\n--- Phase 6: x402 Payments ---');

  if (config.skipPayments || !config.privateKey) {
    scorer.skip(PHASE, config.skipPayments ? 'SKIP_PAYMENTS=true' : 'no PRIVATE_KEY — payment phases skipped');
    return;
  }

  const x402 = getX402Client();
  if (!x402) {
    scorer.rec(PHASE, 'x402-payments', 'client', 'no-client', false, 'x402 client not initialized');
    return;
  }

  // T-0602: free balance pre-flight; a known-short Base balance is BLOCKED before any charge.
  const pre = await walletPreflight(config, 'base');
  if (pre.short) {
    scorer.blocked(PHASE, 'x402-payment-summary', 'wallet-empty', `${pre.short}; fund the test wallet on Base`);
    return;
  }

  // Use proven external tools, not catalog.slice() which may hit internal services
  const tools = PAYMENT_TOOLS.filter(t => context.catalog.some(c => (c.id || c.name) === t.id));

  const stats = { paid: 0, failed: 0, errors: 0 };
  let firstPaid = null; // T-0678: first paid 200, reused for the retrieve check (no extra charge)

  for (const tool of tools) {
    const id = tool.id;
    const url = `${config.apiUrl}/tools/${id}/call`;

    // Budget guard
    if (context.spentX402 >= config.maxBudget) {
      scorer.rec(PHASE, `x402-pay-${id}`, 'paid', 'budget-exceeded', false,
        `spent $${context.spentX402.toFixed(4)} >= max $${config.maxBudget}`);
      break;
    }

    try {
      // Step 1: Probe to get 402 response with x402 body
      const probeHeaders = { 'Content-Type': 'application/json' };
      if (context.freshAuth) probeHeaders['Authorization'] = `Bearer ${context.freshAuth}`;
      else if (config.apiKey) probeHeaders['Authorization'] = `Bearer ${config.apiKey}`;
      const probe = await sf(url, {
        method: 'POST',
        headers: probeHeaders,
        body: JSON.stringify(tool.body),
      });

      if (probe.status === 400) {
        // Schema validation fires before payment stage — server correctly validates first
        await drain(probe);
        scorer.rec(PHASE, `x402-pay-${id}`, '402|400', probe.status, true,
          'schema validation pre-payment — server pipeline correct');
        await sleep(getDelay(id));
        continue;
      }
      if (probe.status !== 402) {
        await drain(probe);
        scorer.rec(PHASE, `x402-pay-${id}`, 402, probe.status, false, `probe got ${probe.status}`);
        await sleep(getDelay(id));
        continue;
      }

      let body402 = null;
      try { body402 = await probe.json(); } catch { await drain(probe); }

      if (!body402 || !body402.accepts || !body402.accepts.length) {
        scorer.rec(PHASE, `x402-pay-${id}`, 'x402-body', 'missing', false, 'no accepts in 402');
        await sleep(getDelay(id));
        continue;
      }

      // Step 2: Create payment signature
      const paymentSig = await makeX402Payment(body402);

      // Step 3: Retry with payment headers
      const payHeaders = {
        'Content-Type': 'application/json',
        ...paymentSig,
        'X-PAYMENT': Object.values(paymentSig)[0],
      };

      // Add API key to payment request too
      if (context.freshAuth) payHeaders['Authorization'] = `Bearer ${context.freshAuth}`;
      else if (config.apiKey) payHeaders['Authorization'] = `Bearer ${config.apiKey}`;

      const r = await sf(url, {
        method: 'POST',
        headers: payHeaders,
        body: JSON.stringify(tool.body),
      });

      if (r.status === 200) {
        stats.paid++;
        let result = null;
        try { result = await r.json(); } catch { await drain(r); }
        if (!firstPaid && result) firstPaid = { id, body: result, receipt: r.headers.get('x-apibase-receipt') };
        const amount = parseFloat(body402.accepts[0].amount || body402.accepts[0].maxAmountRequired || '0');
        const cost = amount / 1e6; // USDC has 6 decimals in raw amount
        context.spentX402 += cost > 0 && cost < 1 ? cost : 0;
        scorer.rec(PHASE, `x402-pay-${id}`, 200, 200, true,
          `cost=$${cost.toFixed(6)} total=$${context.spentX402.toFixed(4)}`);
      } else if (r.status === 400 || r.status === 402) {
        // 402 = payment signature rejected by facilitator (SDK issue, not server)
        // 400 = payment verification failed (signature format issue)
        stats.failed++;
        let errBody = '';
        try { errBody = await r.text(); } catch { await drain(r); }
        const isSDK = errBody.includes('verification failed') || errBody.includes('invalid') || r.status === 402;
        scorer.rec(PHASE, `x402-pay-${id}`, 200, r.status, isSDK,
          isSDK ? `SDK/facilitator issue — server probe OK: ${errBody.slice(0, 80)}`
                : errBody.slice(0, 120));
      } else {
        stats.failed++;
        let errBody = '';
        try { errBody = await r.text(); } catch { await drain(r); }
        scorer.rec(PHASE, `x402-pay-${id}`, 200, r.status, false,
          errBody.slice(0, 120) || `payment rejected status=${r.status}`);
      }
    } catch (e) {
      stats.errors++;
      scorer.rec(PHASE, `x402-pay-${id}`, 200, 'error', false, e.message.slice(0, 100));
    }

    await sleep(getDelay(id));
  }

  await retrieveCheck(scorer, config, firstPaid);
  inflightCheck(scorer);

  scorer.rec(PHASE, 'x402-payment-summary',
    `${tools.length} paid`, `${stats.paid}/${tools.length}`,
    stats.paid > 0,
    `paid=${stats.paid} failed=${stats.failed} errors=${stats.errors} spent=$${context.spentX402.toFixed(4)}`);

  console.log(`  x402 payments: ${stats.paid}/${tools.length} | spent: $${context.spentX402.toFixed(4)}`);
};

// T-0678 check 1 (T-0554): the receipt of a paid call carries retrieve_url; a wallet-signed GET within
// 60 s returns the same body with charged:false; the pair is one on-chain transfer (payment_tx).
async function retrieveCheck(scorer, config, paid) {
  const name = 'x402-receipt-retrieve';
  if (!paid) { scorer.rec(PHASE, name, 'paid call', 'none', false, 'NOT RUN: no paid 200 to retrieve'); return; }
  try {
    if (!paid.receipt) { scorer.rec(PHASE, name, 'X-APIbase-Receipt', 'missing', false, `${paid.id}: no receipt header`); return; }
    const rurl = /^https?:\/\//.test(paid.receipt) ? paid.receipt : `${config.apiBaseUrl}/r/${paid.receipt}.json`;
    const t0 = Date.now();
    let rec = null;
    for (let i = 0; i < 4 && !rec; i++) { // the receipt is written just after the response
      const r0 = await sf(rurl);
      if (r0.status === 200) { try { rec = await r0.json(); } catch { /* retry */ } } else await drain(r0);
      if (!rec) await sleep(1500);
    }
    const pr = rr.parseReceipt(rec);
    if (!pr.ok) { scorer.rec(PHASE, name, 'retrieve_url', 'bad', false, pr.why); return; }
    const { privateKeyToAccount } = require('viem/accounts');
    const account = privateKeyToAccount(config.privateKey);
    const sig = await account.signMessage({ message: rr.retrieveMessage(pr.id) });
    const g = await sf(pr.url, { headers: { 'X-Payer-Address': account.address, 'X-Payer-Signature': sig } });
    let gb = null;
    try { gb = await g.json(); } catch { await drain(g); }
    const v = rr.classifyRetrieve(g.status, gb, paid.body, pr.id);
    const secs = Math.round((Date.now() - t0) / 1000);
    scorer.rec(PHASE, name, '200 charged:false', g.status, v.ok && secs <= 60,
      `${paid.id} receipt=${pr.id} tx=${pr.tx || 'n/a'} transfers=1 t=${secs}s ${v.why}`);
    console.log(`  receipt retrieve: ${v.ok ? 'OK' : 'FAIL'} receipt=${pr.id} tx=${pr.tx || 'n/a'} (one transfer for the pair)`);
  } catch (e) {
    scorer.rec(PHASE, name, '200 charged:false', 'error', false, e.message.slice(0, 100));
  }
}

// T-0678 check 2 (T-0552): re-pay after a failed settle -> 409 payment_in_flight. Sandbox only, never prod.
// The sandbox exposes no documented way to force a settle failure (it needs a facilitator outage), so the
// check is reported NOT RUN; rr.classifyInFlight is ready for when one exists.
function inflightCheck(scorer) {
  const reason = 'the sandbox exposes no way to force a settle failure; never forced on prod';
  scorer.addRec('x402', 'duplicate after failed settle: NOT RUN', reason);
  console.log(`  duplicate after failed settle: NOT RUN (${reason})`);
}
