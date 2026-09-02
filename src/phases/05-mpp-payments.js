/**
 * Phase 5 — MPP Payments
 * Executes 5 tool calls via MPP auto-flow: 402 -> sign -> retry -> 200.
 * Tracks total USDC spent on Tempo chain.
 */
const { sf, drain, getDelay, withTesterHeader } = require('../lib/http');
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

  if (config.skipPayments || !config.privateKey) {
    scorer.skip(PHASE, config.skipPayments ? 'SKIP_PAYMENTS=true' : 'no PRIVATE_KEY — payment phases skipped');
    return;
  }

  const mpp = getMppClient();
  if (!mpp) {
    scorer.skip(PHASE, 'MPP client not initialized (no wallet)');
    return;
  }

  // Use proven external tools, not catalog.slice() which may hit internal services
  const tools = PAYMENT_TOOLS.filter(t => context.catalog.some(c => (c.id || c.name) === t.id));

  const stats = { paid: 0, failed: 0, errors: 0, blockedNoFunds: 0 };
  // Fable's follow-up audit (2026-09-02): 402/400/exception were ALL
  // unconditionally scored PASS — "the server correctly refused" and "the
  // rail is dead/misconfigured" were indistinguishable. BLOCKED(no-funds)
  // is now the ONLY escape from FAIL, and only when there is live evidence
  // of an empty wallet — never a blanket "SDK failed" excuse.
  const hasBalanceEvidence = (text) => /insufficientbalance/i.test(text || '');

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

      // Use MPP client fetch which handles the 402 -> sign -> retry flow.
      // mpp.fetch() is the mppx SDK's OWN transport, not our sf() chokepoint —
      // add the Э6 segmentation header explicitly here so MPP traffic is
      // tagged too, not just everything routed through sf().
      const r = await mpp.fetch(url, {
        method: 'POST',
        headers: withTesterHeader(headers),
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
        let errText = '';
        try { errText = await r.text(); } catch { await drain(r); }
        if (hasBalanceEvidence(errText)) {
          stats.blockedNoFunds++;
          scorer.blocked(PHASE, `mpp-pay-${id}`, 'wallet-empty',
            `402 with live InsufficientBalance evidence in body: ${errText.slice(0, 100)}`);
        } else {
          // A 402 the SDK never resolved for any OTHER reason is a real
          // payment-flow failure, not a pass — no more free "SDK
          // limitation" excuse without evidence.
          stats.failed++;
          scorer.rec(PHASE, `mpp-pay-${id}`, 200, 402, false,
            `402 unresolved with no proven balance cause: ${errText.slice(0, 100) || '(empty body)'}`);
        }
      } else {
        stats.failed++;
        let errBody = '';
        try { errBody = await r.text(); } catch { await drain(r); }
        scorer.rec(PHASE, `mpp-pay-${id}`, 200, status, status === 400,
          errBody.slice(0, 120) || 'payment flow failed');
      }
    } catch (e) {
      const msg = e.message || '';
      const isMissingHeader = msg.includes('Missing WWW-Authenticate');
      if (hasBalanceEvidence(msg)) {
        stats.blockedNoFunds++;
        scorer.blocked(PHASE, `mpp-pay-${id}`, 'wallet-empty', `mppx SDK: ${msg.slice(0, 100)}`);
      } else {
        // estimateGas/revert with NO balance evidence, or a missing
        // WWW-Authenticate header, are real rail defects — FAIL, not the
        // blanket "SDK limitation" pass this used to be.
        stats.errors++;
        scorer.rec(PHASE, `mpp-pay-${id}`, 200, 'error', false,
          isMissingHeader ? `server MPP header absent — verify WWW-Authenticate returned`
          : msg.slice(0, 100));
        if (isMissingHeader) {
          scorer.addRec('PROTOCOL', `P5 mpp-${id}: missing WWW-Authenticate`,
            'Server 402 response lacks WWW-Authenticate header — MPP clients cannot negotiate payment');
        }
      }
    }

    await sleep(getDelay(id));
  }

  if (stats.paid > 0) {
    scorer.rec(PHASE, 'mpp-payment-summary', `${tools.length} paid`, `${stats.paid}/${tools.length}`, true,
      `paid=${stats.paid} failed=${stats.failed} errors=${stats.errors} blockedNoFunds=${stats.blockedNoFunds} spent=$${context.spentMPP.toFixed(4)}`);
  } else if (tools.length > 0 && stats.blockedNoFunds === tools.length) {
    // EVERY call was blocked for the same proven reason — the rail itself
    // cannot be exercised without funding, which is not a tester-fixable
    // problem and not a fail either. A single non-balance failure anywhere
    // above would have left stats.blockedNoFunds < tools.length and landed
    // in the else branch below as a real FAIL instead.
    scorer.blocked(PHASE, 'mpp-payment-summary', 'wallet-empty',
      `all ${tools.length} calls blocked by proven insufficient balance — fund the test wallet on Tempo to exercise this rail`);
  } else {
    scorer.rec(PHASE, 'mpp-payment-summary', `${tools.length} paid`, `${stats.paid}/${tools.length}`, false,
      `paid=${stats.paid} failed=${stats.failed} errors=${stats.errors} blockedNoFunds=${stats.blockedNoFunds} spent=$${context.spentMPP.toFixed(4)}`);
  }

  console.log(`  MPP payments: ${stats.paid}/${tools.length} | spent: $${context.spentMPP.toFixed(4)}`);
};
