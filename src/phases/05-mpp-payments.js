/**
 * Phase 5 — MPP Payments
 * Executes 5 tool calls via MPP auto-flow: 402 -> sign -> retry -> 200.
 * Tracks total USDC spent on Tempo chain.
 */
const { sf, drain, getDelay } = require('../lib/http');
const { getMppClient } = require('../lib/mpp-client');
const { getBody } = require('../utils/assert');

const PHASE = 'P5';
const SKIP_IDS = new Set(['health', 'agents.register', 'agents.list']);
const MAX_TOOLS = 5;

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

  const tools = context.catalog
    .filter(t => !SKIP_IDS.has(t.id || t.name))
    .slice(0, MAX_TOOLS);

  const stats = { paid: 0, failed: 0, errors: 0 };

  for (const tool of tools) {
    const id = tool.id || tool.name;
    const url = `${config.apiUrl}/tools/${id}/call`;

    // Budget guard
    if (context.spentMPP >= config.maxBudget) {
      scorer.rec(PHASE, `mpp-pay-${id}`, 'paid', 'budget-exceeded', false,
        `spent $${context.spentMPP.toFixed(4)} >= max $${config.maxBudget}`);
      break;
    }

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (context.freshAuth) headers['X-API-Key'] = context.freshAuth;
      else if (config.apiKey) headers['X-API-Key'] = config.apiKey;

      // Use MPP client fetch which handles the 402 -> sign -> retry flow
      const r = await mpp.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(getBody(tool)),
      });

      const status = r.status;
      if (status === 200) {
        stats.paid++;
        let body = null;
        try { body = await r.json(); } catch { await drain(r); }
        const costHeader = r.headers?.get?.('x-payment-cost') || '';
        const cost = parseFloat(costHeader) || 0;
        context.spentMPP += cost;
        scorer.rec(PHASE, `mpp-pay-${id}`, 200, 200, true,
          `cost=$${cost.toFixed(6)} total=$${context.spentMPP.toFixed(4)}`);
      } else {
        stats.failed++;
        await drain(r);
        scorer.rec(PHASE, `mpp-pay-${id}`, 200, status, false, 'payment flow failed');
      }
    } catch (e) {
      stats.errors++;
      scorer.rec(PHASE, `mpp-pay-${id}`, 200, 'error', false, e.message.slice(0, 100));
    }

    await sleep(getDelay(id));
  }

  scorer.rec(PHASE, 'mpp-payment-summary',
    `${tools.length} paid`, `${stats.paid}/${tools.length}`,
    stats.paid > 0,
    `paid=${stats.paid} failed=${stats.failed} errors=${stats.errors} spent=$${context.spentMPP.toFixed(4)}`);

  console.log(`  MPP payments: ${stats.paid}/${tools.length} | spent: $${context.spentMPP.toFixed(4)}`);
};
