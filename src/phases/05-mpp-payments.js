/**
 * Phase 5 — MPP Payments
 * Executes 5 tool calls via MPP auto-flow: 402 -> sign -> retry -> 200.
 * Tracks total USDC spent on Tempo chain.
 */
const { sf, drain, getDelay, withTesterHeader } = require('../lib/http');
const { getMppClient } = require('../lib/mpp-client');
const { TX_HASH_RE, obtainCredential, sendWithCredential, chargeOnce, runMppxValidate } = require('../lib/mpp-pay');
const { getBody } = require('../utils/assert');
const { walletPreflight } = require('../lib/wallet-balance');

const PHASE = 'P5';

// Proven external tools with simple schemas (confirmed working with MPP)
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

const hasBalanceEvidence = (text) => /insufficientbalance/i.test(text || '');

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

  // T-0602: free balance pre-flight; a known-short Tempo balance is BLOCKED before any charge.
  const pre = await walletPreflight(config, 'tempo');
  if (pre.short) {
    scorer.blocked(PHASE, 'mpp-payment-summary', 'wallet-empty', `${pre.short}; fund the test wallet on Tempo`);
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

  await clientLanes(scorer, config, context);
};

// ---------------------------------------------------------------------------
// T-0433 — client lanes, final-403 replay, credential transport, mppx validate
// ---------------------------------------------------------------------------

const LANE_TOOL = { id: 'earthquake.feed', body: {} };

// T-0602: live InsufficientBalance evidence in a charge result or exception.
const chargeEvidence = (r) => (!r.ok ? r.error : r.status !== 200 ? JSON.stringify(r.json || '') : '') || '';

async function clientLanes(scorer, config, context) {
  const cur = getMppClient(false);
  const legacy = getMppClient(true);
  const key = context.freshAuth || config.apiKey;
  const url = `${config.apiUrl}/tools/${LANE_TOOL.id}/call`;
  const body = JSON.stringify(LANE_TOOL.body);
  const base = { 'Content-Type': 'application/json' };
  const bearer = key ? { Authorization: `Bearer ${key}`, 'X-API-Key': key } : {};
  const budgetLeft = () => context.spentMPP < config.maxBudget;
  // Only live InsufficientBalance evidence turns a failed charge into BLOCKED(wallet-empty); anything else stays a failure.
  const blockedByBalance = (name, text) => {
    if (!hasBalanceEvidence(text)) return false;
    scorer.blocked(PHASE, name, 'wallet-empty', `InsufficientBalance evidence: ${String(text).slice(0, 100)}`);
    return true;
  };
  const N0 = '5.N mppx 0.13.5 client pays one tool';
  const N1 = '5.N+1 legacy mppx 0.8.19 client pays one tool';
  const N2 = '5.N+2 settled credential replay is refused';
  const N2b = '5.N+2b settled credential replay is a final 403';
  const N3 = '5.N+3 Payment-Authorization credential + Bearer API key';
  let walletEmptyAt5N = false;

  // 5.N current client (mppx 0.13.x): 200 + Payment-Receipt + tx-hash reference.
  let settled = null;
  try {
    if (!cur) throw new Error('current mppx client not initialized');
    if (!budgetLeft()) throw new Error('budget exhausted');
    const r = await chargeOnce(cur, url, { ...base, ...bearer }, body);
    if (blockedByBalance(N0, chargeEvidence(r))) {
      walletEmptyAt5N = true;
    } else if (!r.ok) {
      scorer.redRec(PHASE, N0, '200 + Payment-Receipt (tx hash)', r.error, false);
    } else {
      const refOk = typeof r.receipt?.reference === 'string' && TX_HASH_RE.test(r.receipt.reference);
      const ok = r.status === 200 && !!r.receipt && refOk;
      context.spentMPP += r.costUsd;
      scorer.redRec(PHASE, N0, '200 + Payment-Receipt (tx hash)',
        `${r.status} receipt=${!!r.receipt} txhash=${refOk}`, ok, `cost=$${r.costUsd.toFixed(6)}`);
      if (r.status === 200) settled = r;
    }
  } catch (e) {
    if (blockedByBalance(N0, e.message)) walletEmptyAt5N = true;
    else scorer.recCatch(PHASE, N0, '200', e);
  }
  await sleep(getDelay(LANE_TOOL.id));

  // 5.N+1 legacy client (mppx 0.8.19): documented compatibility.
  try {
    if (!legacy) throw new Error('legacy mppx client not initialized');
    if (!budgetLeft()) throw new Error('budget exhausted');
    const r = await chargeOnce(legacy, url, { ...base, ...bearer }, body);
    if (blockedByBalance(N1, chargeEvidence(r))) {
      // recorded as BLOCKED
    } else if (!r.ok) {
      scorer.rec(PHASE, N1, '200', r.error, false);
    } else {
      context.spentMPP += r.costUsd;
      scorer.rec(PHASE, '5.N+1 legacy mppx 0.8.19 client pays one tool', '200', String(r.status),
        r.status === 200, `cost=$${r.costUsd.toFixed(6)} receipt=${!!r.receipt}`);
    }
  } catch (e) {
    if (!blockedByBalance(N1, e.message)) scorer.recCatch(PHASE, N1, '200', e);
  }
  await sleep(getDelay(LANE_TOOL.id));

  // 5.N+2 re-send the settled credential: final 403 credential_replayed, charged:false.
  if (settled) {
    try {
      const rep = await sendWithCredential(url, { ...base, ...bearer }, body, settled.credential);
      const code = rep.json?.error_code;
      const ok = rep.status === 403 && code === 'credential_replayed' && rep.json?.charged === false;
      // RED is the money invariant: a replayed credential is never served and never
      // yields a receipt (any 2xx or any Payment-Receipt header is a defect).
      // 5.N+2b (final 403 credential_replayed, charged:false) is a rec: server defect,
      // the mppx charge handler returns the 403 as result.challenge while the
      // middleware checks result.status, so prod answers 400. Tighten 5.N+2b to
      // redRec after the server fix ships (ruling 0433 q-1 ruling-2).
      const hasReceipt = !!rep.headers?.get?.('payment-receipt');
      scorer.redRec(PHASE, '5.N+2 settled credential replay is refused', 'not 200, no Payment-Receipt',
        `${rep.status} receipt=${hasReceipt}`, rep.status > 0 && rep.status !== 200 && !hasReceipt);
      scorer.rec(PHASE, '5.N+2b settled credential replay is a final 403', '403 credential_replayed charged:false',
        `${rep.status} ${code || '(no error_code)'} charged=${rep.json?.charged}`, ok);
    } catch (e) {
      scorer.recCatch(PHASE, '5.N+2 settled credential replay is a final 403', '403', e);
    }
  } else if (walletEmptyAt5N) {
    const why = '5.N was BLOCKED(wallet-empty): no credential settled, replay cannot be exercised';
    scorer.blocked(PHASE, N2, 'wallet-empty', why);
    scorer.blocked(PHASE, N2b, 'wallet-empty', why);
  } else {
    scorer.rec(PHASE, '5.N+2 settled credential replay is a final 403', '403 credential_replayed', 'no settled credential', false,
      'the 0.13.5 charge above did not settle, replay cannot be exercised');
  }
  await sleep(300);

  // 5.N+3 transport: credential in Payment-Authorization next to a Bearer API key -> 200.
  try {
    if (!cur || !key) throw new Error('no client or API key');
    if (!budgetLeft()) throw new Error('budget exhausted');
    const r = await chargeOnce(cur, url, { ...base, Authorization: `Bearer ${key}` }, body, 'Payment-Authorization');
    if (blockedByBalance(N3, chargeEvidence(r))) {
      // recorded as BLOCKED
    } else if (!r.ok) {
      scorer.rec(PHASE, N3, '200', r.error, false);
    } else {
      context.spentMPP += r.costUsd;
      scorer.rec(PHASE, '5.N+3 Payment-Authorization credential + Bearer API key', '200', String(r.status), r.status === 200,
        `cost=$${r.costUsd.toFixed(6)}`);
    }
  } catch (e) {
    if (!blockedByBalance(N3, e.message)) scorer.recCatch(PHASE, N3, '200', e);
  }
  await sleep(300);

  // 5.N+4 both headers carry credentials -> 400 (ambiguous). The credential is
  // never settled when the server refuses, so this costs nothing.
  try {
    if (!cur) throw new Error('no client');
    const c = await obtainCredential(cur, url, { ...base, ...bearer }, body);
    if (c.error) {
      scorer.rec(PHASE, '5.N+4 two credential headers are refused', '400', c.error, false);
    } else {
      const r = await sf(url, {
        method: 'POST',
        headers: { ...base, Authorization: c.credential, 'Payment-Authorization': c.credential },
        body,
      }, 60000);
      try { await r.text(); } catch {}
      scorer.rec(PHASE, '5.N+4 two credential headers are refused', '400', String(r.status), r.status === 400);
    }
  } catch (e) {
    scorer.recCatch(PHASE, '5.N+4 two credential headers are refused', '400', e);
  }

  // 5.N+5 mppx validate (child process), scoped to the one endpoint.
  const v = await runMppxValidate(config.apiBaseUrl, LANE_TOOL.id);
  if (v.spawnFailed || !v.json) {
    scorer.recCatch(PHASE, '5.N+5 mppx validate', 'exit 0', new Error(v.errMsg || 'no JSON output'));
  } else {
    const ep = v.json.endpoints?.[0] || {};
    const groups = [ep.challenge, ep.errorHandling, ep.payment].flat().filter(Boolean);
    const failed = groups.filter((c) => c.severity === 'fail');
    const s = v.json.summary || {};
    const summary = `exit=${v.exitCode} passed=${s.passed} failed=${s.failed} warnings=${s.warnings} skipped=${s.skipped}`;
    scorer.rec(PHASE, '5.N+5 mppx validate: endpoint checks pass', '0 failed endpoint checks',
      `${failed.length} failed of ${groups.length}`, failed.length === 0 && groups.length > 0,
      `${summary}${failed.length ? ' | ' + failed.map((c) => c.label).join('; ').slice(0, 120) : ''}`);
    context.mppxValidateSummary = summary;
    // The discovery document is a separate finding from the endpoint
    // challenge: validate exits non-zero when it is invalid. Recorded as a
    // recommendation so a server-side OpenAPI defect never hides.
    const dFail = (v.json.discovery?.checks || []).filter((c) => c.severity === 'fail');
    if (v.exitCode !== 0 && dFail.length > 0) {
      const labels = [...new Set(dFail.map((c) => c.label))].slice(0, 2).join('; ');
      scorer.addRec('PROTOCOL', 'P5 mppx validate exits non-zero on discovery',
        `${dFail.length} discovery check(s) fail: ${labels}`);
    }
  }
}
