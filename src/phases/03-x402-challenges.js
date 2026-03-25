/**
 * Phase 3 — x402 Challenge Scan
 * For each tool in the catalog, sends POST and checks x402 body format:
 * x402Version===2, accepts[0] with network, asset, payTo, scheme, amount.
 */
const { sf, drain, getDelay } = require('../lib/http');
const { getBody } = require('../utils/assert');

const PHASE = 'P3';
const SKIP_IDS = new Set(['health', 'agents.register', 'agents.list']);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function validateAccept(acc) {
  if (!acc) return false;
  const required = ['network', 'asset', 'payTo', 'scheme'];
  return required.every(k => acc[k] !== undefined && acc[k] !== null)
    && (acc.amount !== undefined || acc.maxAmountRequired !== undefined);
}

module.exports = async function phase3(scorer, config, context) {
  console.log('\n--- Phase 3: x402 Challenge Scan ---');

  const tools = context.catalog.filter(t => !SKIP_IDS.has(t.id || t.name));
  const stats = { correct402: 0, schema400: 0, noBody: 0, badSchema: 0, errors500: 0, unavailable503: 0 };

  for (const tool of tools) {
    const id = tool.id || tool.name;
    const url = `${config.apiUrl}/tools/${id}/call`;
    const headers = { 'Content-Type': 'application/json' };

    let r = await sf(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(getBody(tool)),
    });

    if (r.status === 429) {
      await sleep(10000);
      r = await sf(url, { method: 'POST', headers, body: JSON.stringify(getBody(tool)) });
    }

    const status = r.status;

    if (status === 503) {
      stats.unavailable503++;
      await drain(r);
      scorer.recQ(PHASE, `x402-${id}`, '402', status, false, 'service unavailable');
      await sleep(getDelay(id));
      continue;
    }

    if (status >= 500) {
      stats.errors500++;
      await drain(r);
      scorer.recQ(PHASE, `x402-${id}`, '402', status, false, 'server error');
      await sleep(getDelay(id));
      continue;
    }

    if (status === 400) {
      stats.schema400++;
      await drain(r);
      scorer.recQ(PHASE, `x402-${id}`, '402', status, false, 'bad request');
      await sleep(getDelay(id));
      continue;
    }

    let body = null;
    try { body = await r.json(); } catch { await drain(r); }

    if (status === 402 && body && body.x402Version >= 1) {
      const accepts = body.accepts || [];
      const first = accepts[0];
      if (body.x402Version === 2 && first && validateAccept(first)) {
        stats.correct402++;
        scorer.recQ(PHASE, `x402-${id}`, 'valid-x402', 'valid', true,
          `scheme=${first.scheme} net=${first.network} amount=${first.amount || first.maxAmountRequired}`);
      } else {
        stats.badSchema++;
        scorer.recQ(PHASE, `x402-${id}`, 'valid-x402', 'bad-schema', false,
          `v=${body.x402Version} accepts=${accepts.length}`);
      }
    } else if (status === 402) {
      stats.noBody++;
      scorer.recQ(PHASE, `x402-${id}`, 'x402-body', 'missing', false, 'no x402 body');
    } else {
      stats.noBody++;
      scorer.recQ(PHASE, `x402-${id}`, '402', status, status === 200, 'unexpected status');
    }

    await sleep(getDelay(id));
  }

  scorer.rec(PHASE, 'x402-challenge-summary',
    `>${tools.length * 0.5} valid`, `${stats.correct402}/${tools.length}`,
    stats.correct402 > 0,
    `valid=${stats.correct402} bad=${stats.badSchema} noBody=${stats.noBody} 400=${stats.schema400} 503=${stats.unavailable503} 5xx=${stats.errors500}`);

  if (stats.errors500 > 0) {
    scorer.addError('CRITICAL', PHASE, 'Server 500 errors during x402 scan',
      `${stats.errors500} tools returned 500`, 'Investigate server-side errors');
  }

  console.log(`  Scanned ${tools.length} tools: valid402=${stats.correct402} bad=${stats.badSchema} ` +
    `noBody=${stats.noBody} 400=${stats.schema400} 503=${stats.unavailable503} 5xx=${stats.errors500}`);
};
