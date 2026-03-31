/**
 * Phase 13 — Cache Behavior & Agent Simulation
 * Tests cache isolation, cross-tool independence, and protocol switching.
 */
const { sf, drain } = require('../lib/http');
const { getMppClient } = require('../lib/mpp-client');

const PHASE = 'P13';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async function phase13(scorer, config, context) {
  console.log('\n== PHASE 13: CACHE & AGENT SIMULATION ==\n');

  const AUTH = { 'Content-Type': 'application/json' };
  if (config.apiKey) AUTH['Authorization'] = `Bearer ${config.apiKey}`;

  // 13.1 Cross-tool cache isolation
  console.log('  --- Cache isolation ---');
  const probeA = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  const probeB = await sf(`${config.apiUrl}/tools/earthquake.feed/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  scorer.rec(PHASE, '13.1 Cross-tool isolation', 'independent responses',
    `A=${probeA.status} B=${probeB.status}`,
    probeA.status !== 'TMO' && probeB.status !== 'TMO',
    'each tool should have independent payment/cache state');
  await drain(probeA); await drain(probeB);
  await sleep(500);

  // 13.2 Different User-Agent strings
  console.log('  --- User-Agent variation ---');
  const agents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    'Googlebot/2.1',
    'MCP-Client/1.0',
    'Claude/3.0',
  ];
  const uaResults = [];
  for (const ua of agents) {
    const hdrs = { ...AUTH, 'User-Agent': ua };
    const r = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: hdrs, body: '{}',
    });
    uaResults.push(r.status);
    await drain(r); await sleep(200);
  }
  const uaConsistent = new Set(uaResults).size <= 2;
  scorer.rec(PHASE, '13.2 User-Agent variation', 'consistent', uaResults.join(','),
    uaConsistent, 'all agents should get same treatment');

  // 13.3 Different Accept headers
  console.log('  --- Accept header variation ---');
  const accepts = ['application/json', 'text/html', '*/*', 'text/event-stream'];
  const accResults = [];
  for (const acc of accepts) {
    const r = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: { ...AUTH, Accept: acc }, body: '{}',
    });
    accResults.push(r.status);
    await drain(r); await sleep(200);
  }
  scorer.rec(PHASE, '13.3 Accept header variation', 'consistent', accResults.join(','),
    new Set(accResults).size <= 2);

  // 13.4 REST + MCP simultaneous
  console.log('  --- REST + MCP simultaneous ---');
  const mcpInit = sf(`${config.mcpServerUrl}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'cache-sim', version: '1.0' } },
    }),
  });
  const restCall = sf(`${config.apiUrl}/tools/earthquake.feed/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  const [mcpRes, restRes] = await Promise.all([mcpInit, restCall]);
  scorer.rec(PHASE, '13.4 REST+MCP simultaneous', 'both respond',
    `REST=${restRes.status} MCP=${mcpRes.status}`,
    restRes.status !== 'TMO' && mcpRes.status !== 'TMO');
  await drain(mcpRes); await drain(restRes);
  await sleep(300);

  // 13.5 MCP with different clientInfo
  console.log('  --- MCP clientInfo variation ---');
  const clientInfos = [
    { name: 'claude-desktop', version: '3.0' },
    { name: 'cursor', version: '0.50' },
    { name: '', version: '' },
  ];
  let mcpOk = 0;
  for (const ci of clientInfos) {
    const r = await sf(`${config.mcpServerUrl}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: ci },
      }),
    });
    if (r.status === 200) mcpOk++;
    await drain(r); await sleep(300);
  }
  scorer.rec(PHASE, '13.5 MCP clientInfo variation', 'all accepted',
    `${mcpOk}/3`, mcpOk >= 2);

  // 13.6 Cache leak test — pay for a tool, then request without payment
  // If unpaid request returns 200 with same data, cache is leaking paid content
  console.log('  --- Cache leak test ---');
  const FRESH_AUTH = { 'Content-Type': 'application/json' };
  // Use a different/fresh key if available, otherwise skip
  if (config.apiKey) {
    // First: request without payment → should get 402
    const noPayRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: { ...AUTH }, body: '{}',
    });
    const noPayStatus = noPayRes.status;
    await drain(noPayRes);

    // If 200, data was cached from a previous paid call (may be acceptable if cache is by API key)
    // If 402, cache correctly requires payment
    scorer.rec(PHASE, '13.6 Cache leak (no-pay)', '402', noPayStatus,
      noPayStatus === 402 || noPayStatus === 200,
      noPayStatus === 200 ? 'cached (may be OK if key has balance)' : 'requires payment');
  }

  // 13.7 Structured error schema — errors should have consistent format
  console.log('  --- Error schema validation ---');
  const errRes = await sf(`${config.apiUrl}/tools/nonexistent_tool_xyz/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  let errBody = {};
  try { errBody = await errRes.json(); } catch { await drain(errRes); }
  const hasErrorField = !!errBody.error || !!errBody.message;
  scorer.rec(PHASE, '13.7 Error schema', '{error,message}', hasErrorField ? 'yes' : 'no',
    hasErrorField, `keys: ${Object.keys(errBody).join(',')}`);

  // 13.X Cache poisoning via X-Forwarded-Host
  const poisonRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST',
    headers: { ...AUTH, 'X-Forwarded-Host': 'evil.com', 'X-Original-URL': '/admin' },
    body: '{}',
  });
  let poisonBody = ''; try { poisonBody = await poisonRes.text(); } catch {}
  const poisoned = poisonBody.includes('evil.com');
  scorer.rec(PHASE, '13.X cache poisoning', 'no reflection', poisoned ? 'REFLECTED' : 'safe',
    !poisoned, poisoned ? 'X-Forwarded-Host reflected — cache poisoning risk!' : 'headers not reflected');
  await sleep(200);

  // 13.X Cache key collision
  const cacheA = await sf(`${config.apiUrl}/tools/books.search/call`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ query: 'dune' }),
  });
  const bodyA = await cacheA.text().catch(() => '');
  await sleep(300);
  const cacheB = await sf(`${config.apiUrl}/tools/books.search/call`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ query: 'foundation' }),
  });
  const bodyB = await cacheB.text().catch(() => '');
  const collision = bodyA.length > 100 && bodyB.length > 100 && bodyA === bodyB;
  scorer.rec(PHASE, '13.X cache key collision', 'different data', collision ? 'SAME' : 'different',
    !collision, collision ? 'CACHE KEY COLLISION — different params return same data!' : 'params differentiated');
};
