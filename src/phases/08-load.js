/**
 * Phase 8 — Load Testing
 * Parallel stress: 20 concurrent GET requests to /api/v1/tools,
 * then 10 concurrent POST tool calls with auth. Count 429s and 500s.
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'load';

module.exports = async function phase8(scorer, config, context) {
  console.log('\n--- Phase 8: Load Testing ---');

  // 1. 20 concurrent GET requests to catalog
  const catalogUrl = `${config.apiUrl}/tools`;
  const concurrentReads = 20;

  console.log(`  Sending ${concurrentReads} concurrent GET /tools...`);
  const readPromises = Array.from({ length: concurrentReads }, () =>
    sf(catalogUrl, { method: 'GET' }).then(async (r) => {
      const status = r.status;
      await drain(r);
      return status;
    })
  );

  const readResults = await Promise.all(readPromises);
  const read200 = readResults.filter(s => s === 200).length;
  const read429 = readResults.filter(s => s === 429).length;
  const read5xx = readResults.filter(s => typeof s === 'number' && s >= 500).length;
  const readTmo = readResults.filter(s => s === 'TMO').length;

  scorer.rec(PHASE, 'concurrent-reads', `${concurrentReads} x 200`, `${read200} x 200`,
    read200 === concurrentReads,
    `200=${read200} 429=${read429} 5xx=${read5xx} tmo=${readTmo}`);

  if (read5xx > 0) {
    scorer.addError('HIGH', PHASE, 'Server 500 under load',
      `${read5xx}/${concurrentReads} requests returned 5xx`, 'Improve concurrency handling');
  }

  // 2. 10 concurrent tool calls with auth
  const concurrentCalls = 10;
  const toolId = context.catalog.length > 0
    ? (context.catalog[0].id || context.catalog[0].name)
    : 'crypto.market.trending';
  const toolUrl = `${config.apiUrl}/tools/${toolId}/run`;

  console.log(`  Sending ${concurrentCalls} concurrent POST to ${toolId}...`);
  const callPromises = Array.from({ length: concurrentCalls }, () => {
    const headers = { 'Content-Type': 'application/json' };
    if (context.freshAuth) headers['X-API-Key'] = context.freshAuth;
    else if (config.apiKey) headers['X-API-Key'] = config.apiKey;

    return sf(toolUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    }).then(async (r) => {
      const status = r.status;
      await drain(r);
      return status;
    });
  });

  const callResults = await Promise.all(callPromises);
  const call200 = callResults.filter(s => s === 200).length;
  const call402 = callResults.filter(s => s === 402).length;
  const call429 = callResults.filter(s => s === 429).length;
  const call5xx = callResults.filter(s => typeof s === 'number' && s >= 500).length;
  const callTmo = callResults.filter(s => s === 'TMO').length;

  // 402 is acceptable (payment required) — means the server handled it correctly
  const callOk = call200 + call402;
  scorer.rec(PHASE, 'concurrent-calls', `${concurrentCalls} handled`,
    `${callOk} handled`,
    callOk >= concurrentCalls * 0.8,
    `200=${call200} 402=${call402} 429=${call429} 5xx=${call5xx} tmo=${callTmo}`);

  if (call429 > concurrentCalls * 0.5) {
    scorer.addRec('PERF', 'Rate limiting too aggressive',
      `${call429}/${concurrentCalls} requests were rate-limited at low concurrency`);
  }

  if (call5xx > 0) {
    scorer.addError('HIGH', PHASE, 'Server 500 on concurrent tool calls',
      `${call5xx}/${concurrentCalls} returned 5xx`, 'Improve concurrency handling');
  }

  // 3. Latency summary
  const allStatuses = [...readResults, ...callResults];
  const totalReqs = allStatuses.length;
  const totalOk = allStatuses.filter(s => s === 200 || s === 402).length;
  const total429 = allStatuses.filter(s => s === 429).length;
  const total5xx = allStatuses.filter(s => typeof s === 'number' && s >= 500).length;

  scorer.rec(PHASE, 'load-summary', 'no crashes', total5xx === 0 ? 'no crashes' : `${total5xx} crashes`,
    total5xx === 0,
    `total=${totalReqs} ok=${totalOk} 429=${total429} 5xx=${total5xx}`);

  console.log(`  Load test: ${totalReqs} requests | ok=${totalOk} 429=${total429} 5xx=${total5xx}`);
};
