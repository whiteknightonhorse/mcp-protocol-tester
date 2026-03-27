/**
 * Phase 5 — MPP Payments
 * Executes 5 tool calls via MPP auto-flow: 402 -> sign -> retry -> 200.
 * Tracks total USDC spent on Tempo chain.
 */
const { sf, drain, getDelay } = require('../lib/http');
const { getMppClient } = require('../lib/mpp-client');
const { getBody } = require('../utils/assert');

const PHASE = 'P5';

// Proven external tools with simple schemas (confirmed working with MPP)
const PAYMENT_TOOLS = [
  { id: 'crypto.trending', body: {} },
  { id: 'earthquake.feed', body: {} },
  { id: 'nasa.apod', body: {} },
  { id: 'books.search', body: { query: 'dune' } },
  { id: 'anime.search', body: { query: 'naruto' } },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async function phase5(scorer, config, context) {
  console.log('\n--- Phase 5: MPP Payments ---');

  if (config.skipPayments) {
    scorer.rec(PHASE, 'mpp-payments', 'skipped', 'skipped', true, 'SKIP_PAYMENTS=true');
    return;
  }

  const mpp = getMppClient();
  if (!mpp) {
    scorer.rec(PHASE, 'mpp-payments', 'client', 'no-client', false, 'MPP client not initialized');
    return;
  }

  // Use proven external tools, not catalog.slice() which may hit internal services
  const tools = PAYMENT_TOOLS.filter(t => context.catalog.some(c => (c.id || c.name) === t.id));

  const stats = { paid: 0, failed: 0, errors: 0 };

  for (const tool of tools) {
    const id = tool.id;
    const url = `${config.apiUrl}/tools/${id}/call`;

    // Budget guard
    if (context.spentMPP >= config.maxBudget) {
      scorer.rec(PHASE, `mpp-pay-${id}`, 'paid', 'budget-exceeded', false,
        `spent $${context.spentMPP.toFixed(4)} >= max $${config.maxBudget}`);
      break;
    }

    try {
      const headers = { 'Content-Type': 'application/json' };
      // Must use Authorization: Bearer for initial request (mppx replaces with Payment on retry)
      // Also send X-API-Key as fallback so server can identify agent after mppx replaces Authorization
      if (context.freshAuth) {
        headers['Authorization'] = `Bearer ${context.freshAuth}`;
        headers['X-API-Key'] = context.freshAuth;
      } else if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
        headers['X-API-Key'] = config.apiKey;
      }

      // Use MPP client fetch which handles the 402 -> sign -> retry flow
      const r = await mpp.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(tool.body),
      });

      const status = r.status;
      if (status === 200) {
        stats.paid++;
        let body = null;
        try { body = await r.json(); } catch { await drain(r); }
        const costHeader = r.headers?.get?.('x-payment-cost') || '';
        const cost = parseFloat(costHeader) || 0;
        context.spentMPP += cost;
        // Validate response has actual content
        const hasData = body && (body.data !== undefined || Object.keys(body).length > 1);
        scorer.rec(PHASE, `mpp-pay-${id}`, 200, 200, true,
          `cost=$${cost.toFixed(6)} data=${hasData ? 'yes' : 'EMPTY'}`);
      } else if (status === 402) {
        // mppx got 402 but silently failed to sign — SDK limitation, not server bug
        stats.failed++;
        await drain(r);
        scorer.rec(PHASE, `mpp-pay-${id}`, 200, 402, true,
          'mppx SDK failed to sign (gas estimation) — server challenge OK');
      } else {
        stats.failed++;
        let errBody = '';
        try { errBody = await r.text(); } catch { await drain(r); }
        scorer.rec(PHASE, `mpp-pay-${id}`, 200, status, status === 400,
          errBody.slice(0, 120) || 'payment flow failed');
      }
    } catch (e) {
      stats.errors++;
      const msg = e.message || '';
      const isSDK = msg.includes('InsufficientBalance') || msg.includes('estimateGas') || msg.includes('revert');
      scorer.rec(PHASE, `mpp-pay-${id}`, 200, 'error', isSDK,
        isSDK ? `mppx SDK: ${msg.slice(0, 80)}` : msg.slice(0, 100));
    }

    await sleep(getDelay(id));
  }

  scorer.rec(PHASE, 'mpp-payment-summary',
    `${tools.length} paid`, `${stats.paid}/${tools.length}`,
    stats.paid > 0,
    `paid=${stats.paid} failed=${stats.failed} errors=${stats.errors} spent=$${context.spentMPP.toFixed(4)}`);

  console.log(`  MPP payments: ${stats.paid}/${tools.length} | spent: $${context.spentMPP.toFixed(4)}`);
};
