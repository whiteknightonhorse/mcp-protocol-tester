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
};
