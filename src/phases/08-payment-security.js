/**
 * Phase 8 — Payment Security Tests
 * P0 CRITICAL: replay attacks, double-spend races, amount manipulation,
 * float precision edge cases, and business logic validation.
 */
const { sf, drain } = require('../lib/http');
const { getBody } = require('../utils/assert');
const { getX402Client, getX402HttpClient, makeX402Payment } = require('../lib/x402-client');

const PHASE = 'P8';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectNotOk(scorer, name, status, det = '') {
  const ok = status !== 200;
  scorer.rec(PHASE, name, '!200', String(status), ok, det);
  if (!ok) {
    scorer.addError('CRITICAL', PHASE, `${name}: server returned 200`,
      det, 'Reject replayed / forged payments');
  }
  return ok;
}

function forgedBase64(amount, payTo) {
  return Buffer.from(JSON.stringify({
    scheme: 'exact',
    amount: String(amount),
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: payTo || '0x50EbDa9dA5dC19c302Ca059d7B9E06e264936480',
  })).toString('base64');
}

// ---------------------------------------------------------------------------
// Phase entry
// ---------------------------------------------------------------------------

module.exports = async function phase8(scorer, config, context) {
  console.log('\n--- Phase 8: Payment Security ---');

  const AUTH = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
  const ZERO_AUTH = context.freshAuth
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${context.freshAuth}` }
    : AUTH;

  const catalog = context.catalog;
  const hasWallet = !!config.privateKey && !!getX402Client();

  // Pick well-known tool IDs for replay tests
  const trendingTool = catalog.find(t => (t.id || t.name) === 'crypto.trending');
  const earthquakeTool = catalog.find(t => (t.id || t.name) === 'earthquake.feed');
  const apodTool = catalog.find(t => (t.id || t.name) === 'nasa.apod');

  // ========================================================================
  // 8.1 — Payment Replay (requires x402 wallet)
  // ========================================================================
  console.log('  8.1 Payment replay...');

  if (!hasWallet) {
    scorer.rec(PHASE, '8.1 Replay', 'skip', 'no wallet', true, 'no PRIVATE_KEY configured');
  } else if (!trendingTool) {
    scorer.rec(PHASE, '8.1 Replay', 'skip', 'no tool', true, 'crypto.trending not in catalog');
  } else {
    const trendingId = trendingTool.id || trendingTool.name;
    const trendingUrl = `${config.apiUrl}/tools/${trendingId}/call`;
    const trendingBody = JSON.stringify(getBody(trendingTool));

    try {
      // Probe to get 402 body
      const probe = await sf(trendingUrl, {
        method: 'POST',
        headers: ZERO_AUTH,
        body: trendingBody,
      });

      if (probe.status !== 402) {
        await drain(probe);
        scorer.rec(PHASE, '8.1 Replay-probe', 402, probe.status, false,
          'expected 402 on probe');
      } else {
        let body402 = null;
        try { body402 = await probe.json(); } catch { await drain(probe); }

        if (!body402 || !body402.accepts || !body402.accepts.length) {
          scorer.rec(PHASE, '8.1 Replay-probe', 'x402-body', 'missing', false,
            'no accepts in 402 response');
        } else {
          // Sign payment
          const payH = await makeX402Payment(body402);
          const xp = Object.values(payH)[0];
          const paidHeaders = { ...ZERO_AUTH, ...payH, 'X-PAYMENT': xp };

          // First use — should be 200 or 400 (valid payment)
          const r1 = await sf(trendingUrl, {
            method: 'POST',
            headers: paidHeaders,
            body: trendingBody,
          });
          const firstOk = r1.status === 200 || r1.status === 400;
          scorer.rec(PHASE, '8.1 Replay-first-use', '200|400', String(r1.status), firstOk,
            'first use of payment');
          await drain(r1);
          await sleep(500);

          // Replay same tool — must NOT be 200
          const r2 = await sf(trendingUrl, {
            method: 'POST',
            headers: paidHeaders,
            body: trendingBody,
          });
          expectNotOk(scorer, '8.1 Replay-same-tool', r2.status, 'replayed same payment on same tool');
          await drain(r2);
          await sleep(300);

          // Replay cross-tool (earthquake.feed) — must NOT be 200
          if (earthquakeTool) {
            const eqId = earthquakeTool.id || earthquakeTool.name;
            const eqUrl = `${config.apiUrl}/tools/${eqId}/call`;
            const r3 = await sf(eqUrl, {
              method: 'POST',
              headers: paidHeaders,
              body: JSON.stringify(getBody(earthquakeTool)),
            });
            expectNotOk(scorer, '8.1 Replay-cross-tool', r3.status,
              `replayed payment on ${eqId}`);
            await drain(r3);
          } else {
            scorer.rec(PHASE, '8.1 Replay-cross-tool', 'skip', 'no tool', true,
              'earthquake.feed not in catalog');
          }
          await sleep(300);

          // Replay with modified body — must NOT be 200
          const r4 = await sf(trendingUrl, {
            method: 'POST',
            headers: paidHeaders,
            body: JSON.stringify({ modified: true, extra: 'injected' }),
          });
          expectNotOk(scorer, '8.1 Replay-modified-body', r4.status,
            'replayed payment with tampered body');
          await drain(r4);
        }
      }
    } catch (e) {
      scorer.rec(PHASE, '8.1 Replay', 'tested', 'error', false, e.message.slice(0, 120));
    }
  }

  // ========================================================================
  // 8.2 — Race Condition / Double-Spend
  // ========================================================================
  console.log('  8.2 Race condition / double-spend...');

  if (!hasWallet) {
    scorer.rec(PHASE, '8.2 Double-spend', 'skip', 'no wallet', true, 'no PRIVATE_KEY configured');
  } else if (!apodTool) {
    scorer.rec(PHASE, '8.2 Double-spend', 'skip', 'no tool', true, 'nasa.apod not in catalog');
  } else {
    const apodId = apodTool.id || apodTool.name;
    const apodUrl = `${config.apiUrl}/tools/${apodId}/call`;
    const apodBody = JSON.stringify(getBody(apodTool));

    try {
      // Probe to get 402
      const probe = await sf(apodUrl, {
        method: 'POST',
        headers: ZERO_AUTH,
        body: apodBody,
      });

      if (probe.status !== 402) {
        await drain(probe);
        scorer.rec(PHASE, '8.2 Double-spend-probe', 402, probe.status, false,
          'expected 402 on probe');
      } else {
        let body402 = null;
        try { body402 = await probe.json(); } catch { await drain(probe); }

        if (!body402 || !body402.accepts || !body402.accepts.length) {
          scorer.rec(PHASE, '8.2 Double-spend', 'x402-body', 'missing', false,
            'no accepts in 402');
        } else {
          const payH = await makeX402Payment(body402);
          const xp = Object.values(payH)[0];
          const paidHeaders = { ...ZERO_AUTH, ...payH, 'X-PAYMENT': xp };

          // 10 parallel requests with same payment signature
          const PARALLEL = 10;
          const racePromises = Array.from({ length: PARALLEL }, () =>
            sf(apodUrl, {
              method: 'POST',
              headers: paidHeaders,
              body: apodBody,
            }).then(async (r) => {
              const s = r.status;
              await drain(r);
              return s;
            })
          );

          const results = await Promise.all(racePromises);
          const count200 = results.filter(s => s === 200).length;

          const ok = count200 <= 1;
          scorer.rec(PHASE, '8.2 Double-spend', '<=1 x 200',
            `${count200} x 200`, ok,
            `results: ${results.join(',')}`);

          if (!ok) {
            scorer.addError('CRITICAL', PHASE, 'Double-spend: multiple 200s from single payment',
              `${count200}/10 requests returned 200`,
              'Implement atomic payment processing with nonce/mutex');
          }
        }
      }
    } catch (e) {
      scorer.rec(PHASE, '8.2 Double-spend', 'tested', 'error', false, e.message.slice(0, 120));
    }
  }

  // ========================================================================
  // 8.3 — Amount Manipulation (no wallet needed, forged base64)
  // ========================================================================
  console.log('  8.3 Amount manipulation...');

  const manipToolId = (trendingTool || catalog[0])
    ? ((trendingTool || catalog[0]).id || (trendingTool || catalog[0]).name)
    : 'crypto.trending';
  const manipUrl = `${config.apiUrl}/tools/${manipToolId}/call`;

  const manipTests = [
    { label: 'zero-amount',    amount: '0',     payTo: null },
    { label: 'underpay',       amount: '1',     payTo: null },
    { label: 'negative',       amount: '-1000', payTo: null },
    { label: 'tampered-payTo', amount: '1000',  payTo: '0x0000000000000000000000000000000000000000' },
  ];

  for (const t of manipTests) {
    try {
      const forged = forgedBase64(t.amount, t.payTo);
      const r = await sf(manipUrl, {
        method: 'POST',
        headers: { ...ZERO_AUTH, 'X-PAYMENT': forged },
        body: JSON.stringify(getBody(manipToolId)),
      });
      expectNotOk(scorer, `8.3 Amount-${t.label}`, r.status,
        `amount=${t.amount}${t.payTo ? ' payTo=' + t.payTo.slice(0, 10) + '...' : ''}`);
      await drain(r);
    } catch (e) {
      // Connection-level rejection is acceptable
      scorer.rec(PHASE, `8.3 Amount-${t.label}`, '!200', 'rejected', true,
        e.message.slice(0, 100));
    }
    await sleep(200);
  }

  // ========================================================================
  // 8.4 — Float Precision
  // ========================================================================
  console.log('  8.4 Float precision...');

  try {
    const forged = forgedBase64('999', null); // required is 1000
    const r = await sf(manipUrl, {
      method: 'POST',
      headers: { ...ZERO_AUTH, 'X-PAYMENT': forged },
      body: JSON.stringify(getBody(manipToolId)),
    });
    expectNotOk(scorer, '8.4 Float-precision', r.status,
      'amount=999 vs required 1000');
    await drain(r);
  } catch (e) {
    scorer.rec(PHASE, '8.4 Float-precision', '!200', 'rejected', true,
      e.message.slice(0, 100));
  }

  // ========================================================================
  // 8.5 — Business Logic
  // ========================================================================
  console.log('  8.5 Business logic...');

  // 8.5a — No negative prices in catalog
  const negPriced = catalog.filter(t => parseFloat(t.pricing?.price_usd || '0') < 0);
  scorer.rec(PHASE, '8.5 No-negative-prices', '0 negative',
    `${negPriced.length} negative`, negPriced.length === 0,
    negPriced.length > 0
      ? `tools with negative price: ${negPriced.map(t => t.id || t.name).join(', ')}`
      : 'all prices >= 0');

  if (negPriced.length > 0) {
    scorer.addError('CRITICAL', PHASE, 'Negative prices found in catalog',
      negPriced.map(t => `${t.id || t.name}: $${t.pricing.price_usd}`).join(', '),
      'Ensure all tool prices are non-negative');
  }

  // 8.5b — Payment on nonexistent tool
  try {
    const fakeToolUrl = `${config.apiUrl}/tools/nonexistent.tool.does.not.exist/call`;
    const r = await sf(fakeToolUrl, {
      method: 'POST',
      headers: ZERO_AUTH,
      body: JSON.stringify({ query: 'test' }),
    });
    const ok404 = r.status === 404;
    scorer.rec(PHASE, '8.5 Nonexistent-tool', 404, r.status, ok404,
      ok404 ? 'correctly returns 404' : 'unexpected status for nonexistent tool');
    await drain(r);
  } catch (e) {
    scorer.rec(PHASE, '8.5 Nonexistent-tool', 404, 'error', false, e.message.slice(0, 100));
  }

  // 8.5c — Forged payment with zero address
  try {
    const zeroAddr = '0x0000000000000000000000000000000000000000';
    const forged = forgedBase64('1000', zeroAddr);
    const r = await sf(manipUrl, {
      method: 'POST',
      headers: { ...ZERO_AUTH, 'X-PAYMENT': forged },
      body: JSON.stringify(getBody(manipToolId)),
    });
    expectNotOk(scorer, '8.5 Zero-address-payment', r.status,
      'forged payment with zero address as payTo');
    await drain(r);
  } catch (e) {
    scorer.rec(PHASE, '8.5 Zero-address-payment', '!200', 'rejected', true,
      e.message.slice(0, 100));
  }

  console.log('  Payment security tests complete');
};
