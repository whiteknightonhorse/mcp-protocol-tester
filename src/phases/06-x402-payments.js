/**
 * Phase 6 — x402 Payments
 * Executes 5 tool calls via x402: probe 402 -> makeX402Payment -> retry with
 * PAYMENT-SIGNATURE + X-PAYMENT headers. Tracks total USDC spent on Base.
 */
const { sf, drain, getDelay } = require('../lib/http');
const { getX402Client, makeX402Payment } = require('../lib/x402-client');
const { getBody } = require('../utils/assert');

const PHASE = 'P6';

// Proven external tools with simple schemas (confirmed working with x402)
const PAYMENT_TOOLS = [
  { id: 'crypto.trending', body: {} },
  { id: 'earthquake.feed', body: {} },
  { id: 'nasa.apod', body: {} },
  { id: 'books.search', body: { query: 'dune' } },
  { id: 'anime.search', body: { query: 'naruto' } },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async function phase6(scorer, config, context) {
  console.log('\n--- Phase 6: x402 Payments ---');

  if (config.skipPayments) {
    scorer.rec(PHASE, 'x402-payments', 'skipped', 'skipped', true, 'SKIP_PAYMENTS=true');
    return;
  }

  const x402 = getX402Client();
  if (!x402) {
    scorer.rec(PHASE, 'x402-payments', 'client', 'no-client', false, 'x402 client not initialized');
    return;
  }

  // Use proven external tools, not catalog.slice() which may hit internal services
  const tools = PAYMENT_TOOLS.filter(t => context.catalog.some(c => (c.id || c.name) === t.id));

  const stats = { paid: 0, failed: 0, errors: 0 };

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

      if (probe.status !== 402) {
        await drain(probe);
        scorer.rec(PHASE, `x402-pay-${id}`, 402, probe.status, false, 'expected 402 on probe');
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
        const amount = parseFloat(body402.accepts[0].amount || body402.accepts[0].maxAmountRequired || '0');
        const cost = amount / 1e6; // USDC has 6 decimals in raw amount
        context.spentX402 += cost > 0 && cost < 1 ? cost : 0;
        scorer.rec(PHASE, `x402-pay-${id}`, 200, 200, true,
          `cost=$${cost.toFixed(6)} total=$${context.spentX402.toFixed(4)}`);
      } else {
        stats.failed++;
        await drain(r);
        scorer.rec(PHASE, `x402-pay-${id}`, 200, r.status, false,
          `payment rejected status=${r.status}`);
      }
    } catch (e) {
      stats.errors++;
      scorer.rec(PHASE, `x402-pay-${id}`, 200, 'error', false, e.message.slice(0, 100));
    }

    await sleep(getDelay(id));
  }

  scorer.rec(PHASE, 'x402-payment-summary',
    `${tools.length} paid`, `${stats.paid}/${tools.length}`,
    stats.paid > 0,
    `paid=${stats.paid} failed=${stats.failed} errors=${stats.errors} spent=$${context.spentX402.toFixed(4)}`);

  console.log(`  x402 payments: ${stats.paid}/${tools.length} | spent: $${context.spentX402.toFixed(4)}`);
};
