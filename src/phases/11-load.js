/**
 * Phase 11 — Load Test
 * Parallel stress test with configurable concurrency.
 * Tests catalog fetch, tool calls, and mixed endpoints under load.
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'P11';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async function phase11(scorer, config, context) {
  console.log('\n== PHASE 11: LOAD TEST ==\n');

  const N = config.concurrency || 5;
  const AUTH = { 'Content-Type': 'application/json' };
  if (config.apiKey) AUTH['Authorization'] = `Bearer ${config.apiKey}`;

  // 11.1 Parallel catalog fetch
  console.log(`  11.1 ${N * 4}x concurrent GET /tools ...`);
  const batch1 = Array(N * 4).fill(null).map(() => sf(`${config.apiUrl}/tools`, {}, config.timeoutMs));
  const res1 = await Promise.all(batch1);
  const ok1 = res1.filter(r => r.status === 200).length;
  const rateLimit1 = res1.filter(r => r.status === 429).length;
  scorer.rec(PHASE, `11.1 ${N * 4}x GET /tools`, `>=${N * 3} OK`, `${ok1} OK ${rateLimit1} throttled`,
    ok1 >= N * 3);
  for (const r of res1) await drain(r);
  await sleep(2000);

  // 11.2 Parallel tool calls
  if (config.apiKey) {
    console.log(`  11.2 ${N * 2}x concurrent POST tool calls ...`);
    const batch2 = Array(N * 2).fill(null).map(() =>
      sf(`${config.apiUrl}/tools/crypto.trending/call`, {
        method: 'POST', headers: AUTH, body: '{}',
      }, config.timeoutMs)
    );
    const res2 = await Promise.all(batch2);
    const ok2 = res2.filter(r => r.status === 200 || r.status === 402).length;
    const err500 = res2.filter(r => r.status === 500).length;
    scorer.rec(PHASE, `11.2 ${N * 2}x POST /tools/call`, 'no 500s',
      `OK=${ok2} 500=${err500}`, err500 === 0,
      err500 > 0 ? 'SERVER ERRORS UNDER LOAD' : '');
    if (err500 > 0) {
      scorer.addError('CRITICAL', PHASE, `${err500} errors under load`,
        `${err500}/${N * 2} requests returned 500`, 'Check connection pool and concurrency handling');
    }
    for (const r of res2) await drain(r);
    await sleep(2000);
  }

  // 11.3 Mixed endpoint stress
  console.log(`  11.3 Mixed endpoints (${N} concurrent) ...`);
  const endpoints = [
    { url: `${config.apiUrl}/tools`, method: 'GET', headers: {} },
    { url: `${config.apiBaseUrl}/health/ready`, method: 'GET', headers: {} },
    { url: `${config.apiUrl}/tools/earthquake.feed/call`, method: 'POST', headers: AUTH, body: '{}' },
  ];
  const batch3 = Array(N).fill(null).map((_, i) => {
    const ep = endpoints[i % endpoints.length];
    return sf(ep.url, { method: ep.method, headers: ep.headers, body: ep.body }, config.timeoutMs);
  });
  const res3 = await Promise.all(batch3);
  const ok3 = res3.filter(r => r.status !== 'TMO' && r.status !== 500).length;
  scorer.rec(PHASE, '11.3 Mixed endpoint stress', 'no TMO/500', `${ok3}/${N} OK`, ok3 === N);
  for (const r of res3) await drain(r);

  // 11.4 Sustained requests (30 sequential, fast)
  console.log('  11.4 Sustained 30 sequential requests ...');
  let sustained200 = 0;
  for (let i = 0; i < 30; i++) {
    const r = await sf(`${config.apiUrl}/tools`, {}, 10000);
    if (r.status === 200) sustained200++;
    await drain(r);
  }
  scorer.rec(PHASE, '11.4 Sustained 30 sequential', '>=25 OK', `${sustained200}/30`, sustained200 >= 25);
};
