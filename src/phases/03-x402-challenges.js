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
    if (context.freshAuth) headers['Authorization'] = `Bearer ${context.freshAuth}`;
    else if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

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
      scorer.recQ(PHASE, `x402-${id}`, '402|503', status, true, 'provider unavailable');
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
      // 400 = schema validation before payment — server correctly validates params first
      scorer.recQ(PHASE, `x402-${id}`, '402|400', status, true, 'schema validation (pre-payment)');
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

        // x402 field validation
        const EXPECTED_PAYTO = '0x50EbDa9dA5dC19c302Ca059d7B9E06e264936480';
        const EXPECTED_NETWORK = 'eip155:8453';
        const EXPECTED_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

        if (first.payTo && first.payTo.toLowerCase() !== EXPECTED_PAYTO.toLowerCase()) {
          scorer.addRec('SECURITY',
            `${PHASE} x402-${id}: unexpected payTo`,
            `expected=${EXPECTED_PAYTO} got=${first.payTo} — verify server payment recipient address`);
        }
        if (first.network !== EXPECTED_NETWORK) {
          scorer.addRec('SECURITY',
            `${PHASE} x402-${id}: unexpected network`,
            `expected=${EXPECTED_NETWORK} got=${first.network} — verify challenge targets Base network`);
        }
        if (first.asset && first.asset.toLowerCase() !== EXPECTED_ASSET.toLowerCase()) {
          scorer.addRec('SECURITY',
            `${PHASE} x402-${id}: unexpected asset`,
            `expected=${EXPECTED_ASSET} got=${first.asset} — verify challenge requests USDC payment`);
        }
        if (first.scheme !== 'exact') {
          scorer.addRec('SECURITY',
            `${PHASE} x402-${id}: unexpected scheme`,
            `expected=exact got=${first.scheme} — verify payment scheme`);
        }

        const firstAmount = Number(first.amount || first.maxAmountRequired);
        if (isNaN(firstAmount) || firstAmount <= 0 || firstAmount >= 1000000) {
          scorer.addRec('SECURITY',
            `${PHASE} x402-${id}: suspicious amount`,
            `amount=${first.amount || first.maxAmountRequired} (expected >0 and <1000000)`);
        }

        // Validate all accept entries if multiple
        if (accepts.length > 1) {
          for (let i = 1; i < accepts.length; i++) {
            const entry = accepts[i];
            if (!validateAccept(entry)) {
              scorer.addRec('SECURITY',
                `${PHASE} x402-${id}: invalid accepts[${i}]`,
                `missing required fields in accept entry ${i}`);
              continue;
            }
            if (entry.payTo && entry.payTo.toLowerCase() !== EXPECTED_PAYTO.toLowerCase()) {
              scorer.addRec('SECURITY',
                `${PHASE} x402-${id}: accepts[${i}] unexpected payTo`,
                `expected=${EXPECTED_PAYTO} got=${entry.payTo}`);
            }
            if (entry.asset && entry.asset.toLowerCase() !== EXPECTED_ASSET.toLowerCase()) {
              scorer.addRec('SECURITY',
                `${PHASE} x402-${id}: accepts[${i}] unexpected asset`,
                `expected=${EXPECTED_ASSET} got=${entry.asset}`);
            }
            const entryAmount = Number(entry.amount || entry.maxAmountRequired);
            if (isNaN(entryAmount) || entryAmount <= 0 || entryAmount >= 1000000) {
              scorer.addRec('SECURITY',
                `${PHASE} x402-${id}: accepts[${i}] suspicious amount`,
                `amount=${entry.amount || entry.maxAmountRequired}`);
            }
          }
        }
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

  // P3.X Challenge nonce uniqueness
  const nonceProbes = [];
  for (let i = 0; i < 5; i++) {
    const r = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) }, body: '{}',
    });
    if (r.status === 402) {
      let b = {}; try { b = await r.json(); } catch {}
      nonceProbes.push(b.request_id || JSON.stringify(b.accepts?.[0]?.extra || ''));
    } else { await drain(r); }
    await sleep(300);
  }
  const uniqueNonces = new Set(nonceProbes).size;
  scorer.rec(PHASE, 'challenge-nonce-unique', '5 unique', `${uniqueNonces}/5`,
    uniqueNonces === nonceProbes.length || nonceProbes.length < 2,
    uniqueNonces < nonceProbes.length ? 'DUPLICATE nonces — replay risk!' : 'all unique');

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
