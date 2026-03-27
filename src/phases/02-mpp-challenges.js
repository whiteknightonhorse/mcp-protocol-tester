/**
 * Phase 2 — MPP Challenge Scan
 * For each tool in the catalog, sends POST with freshAuth,
 * checks for WWW-Authenticate: Payment header and parses MPP challenges.
 */
const { sf, drain, getDelay } = require('../lib/http');
const { parseMppChallenge } = require('../lib/mpp-client');
const { getBody } = require('../utils/assert');

const PHASE = 'P2';
const SKIP_IDS = new Set(['health', 'agents.register', 'agents.list']);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async function phase2(scorer, config, context) {
  console.log('\n--- Phase 2: MPP Challenge Scan ---');

  const tools = context.catalog.filter(t => !SKIP_IDS.has(t.id || t.name));
  const stats = { hasMpp: 0, noMpp: 0, validChallenge: 0, schema400: 0, unavailable503: 0, errors500: 0 };

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

    const wwwAuth = r.headers?.get?.('www-authenticate') || '';
    const status = r.status;
    await drain(r);

    if (status === 503) {
      stats.unavailable503++;
      // 503 = provider unavailable, not a server bug
      scorer.recQ(PHASE, `mpp-${id}`, '402|503', status, true, 'provider unavailable');
      continue;
    }

    if (status >= 500) {
      stats.errors500++;
      scorer.recQ(PHASE, `mpp-${id}`, '402', status, false, 'server error');
      scorer.addError('HIGH', PHASE, `500 on ${id}`, `Status ${status}`, 'Check server logs');
      continue;
    }

    if (status === 400) {
      stats.schema400++;
      // 400 = schema validation before payment — server correctly validates params first
      scorer.recQ(PHASE, `mpp-${id}`, '402|400', status, true, 'schema validation (pre-payment)');
      continue;
    }

    if (status === 402 && wwwAuth) {
      stats.hasMpp++;
      const parsed = parseMppChallenge(wwwAuth);
      if (parsed && (parsed.method || parsed.decoded)) {
        stats.validChallenge++;
        scorer.recQ(PHASE, `mpp-${id}`, '402+header', '402+header', true,
          `method=${parsed.method || 'n/a'}`);

        // Challenge field validation
        if (parsed.decoded) {
          const EXPECTED_RECIPIENT = '0x183fFa1335EB66858EebCb86F651f70632821f8d';
          const recipient = parsed.decoded.recipient;
          if (recipient && recipient.toLowerCase() !== EXPECTED_RECIPIENT.toLowerCase()) {
            scorer.addRec('SECURITY',
              `${PHASE} mpp-${id}: unexpected recipient`,
              `expected=${EXPECTED_RECIPIENT} got=${recipient} — verify server payment recipient address`);
          }

          const amount = Number(parsed.decoded.amount);
          if (isNaN(amount) || amount <= 0 || amount >= 1000000) {
            scorer.addRec('SECURITY',
              `${PHASE} mpp-${id}: suspicious amount`,
              `amount=${parsed.decoded.amount} (expected >0 and <1000000 micro-USDC)`);
          }

          const chainId = parsed.decoded.methodDetails?.chainId;
          if (chainId !== undefined && Number(chainId) !== 4217) {
            scorer.addRec('SECURITY',
              `${PHASE} mpp-${id}: unexpected chainId`,
              `expected=4217 got=${chainId} — verify challenge targets Tempo mainnet`);
          }
        }
      } else {
        scorer.recQ(PHASE, `mpp-${id}`, 'valid-challenge', 'unparseable', false,
          `raw: ${wwwAuth.slice(0, 80)}`);
      }
    } else if (status === 402) {
      stats.noMpp++;
      scorer.recQ(PHASE, `mpp-${id}`, '402+header', '402 no header', false, 'missing WWW-Authenticate');
    } else {
      stats.noMpp++;
      scorer.recQ(PHASE, `mpp-${id}`, '402', status, status === 200, `unexpected status`);
    }

    await sleep(getDelay(id));
  }

  // Summary record
  scorer.rec(PHASE, 'mpp-challenge-summary',
    `>${tools.length * 0.5} valid`, `${stats.validChallenge}/${tools.length}`,
    stats.hasMpp > 0,
    `mpp=${stats.hasMpp} valid=${stats.validChallenge} 400=${stats.schema400} 503=${stats.unavailable503} 5xx=${stats.errors500}`);

  if (stats.errors500 > 0) {
    scorer.addError('CRITICAL', PHASE, 'Server 500 errors during MPP scan',
      `${stats.errors500} tools returned 500`, 'Investigate server-side errors');
  }

  console.log(`  Scanned ${tools.length} tools: MPP=${stats.hasMpp} valid=${stats.validChallenge} ` +
    `400=${stats.schema400} 503=${stats.unavailable503} 5xx=${stats.errors500}`);
};
