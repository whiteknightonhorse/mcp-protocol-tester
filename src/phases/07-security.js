/**
 * Phase 7 — Security Tests
 * Tests authentication, authorization, input validation, cross-protocol
 * confusion, and common attack vectors.
 */
const { sf, drain } = require('../lib/http');
const { mcpRequest } = require('../lib/mcp-client');

const PHASE = 'P7';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function expectStatus(scorer, name, expected, actual, det = '') {
  const ok = Array.isArray(expected)
    ? expected.includes(actual)
    : actual === expected;
  scorer.rec(PHASE, name, String(expected), String(actual), ok, det);
  return ok;
}

module.exports = async function phase7(scorer, config, context) {
  console.log('\n--- Phase 7: Security ---');

  const toolUrl = context.catalog.length > 0
    ? `${config.apiUrl}/tools/${context.catalog[0].id || context.catalog[0].name}/call`
    : `${config.apiUrl}/tools/crypto.market.trending/call`;
  const postOpts = (headers = {}) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({}),
  });

  // 1. No auth -> should get 401 or 402
  const r1 = await sf(toolUrl, postOpts());
  expectStatus(scorer, 'no-auth-rejected', [401, 402, 403], r1.status, 'no credentials');
  await drain(r1);

  // 2. Invalid API key -> 401
  const r2 = await sf(toolUrl, postOpts({ 'X-API-Key': 'test_' + 'x'.repeat(20) }));
  expectStatus(scorer, 'invalid-key-rejected', [401, 402, 403], r2.status, 'garbage API key');
  await drain(r2);

  // 3. Empty X-Payment header -> 400 or 401
  const r3 = await sf(toolUrl, postOpts({ 'X-PAYMENT': '' }));
  expectStatus(scorer, 'empty-x-payment', [400, 401, 402], r3.status, 'empty X-PAYMENT');
  await drain(r3);

  // 4. Garbage X-Payment header -> 400 or 401
  const r4 = await sf(toolUrl, postOpts({ 'X-PAYMENT': 'not-a-real-payment-signature' }));
  expectStatus(scorer, 'garbage-x-payment', [400, 401, 402], r4.status, 'garbage X-PAYMENT');
  await drain(r4);

  // 5. Forged MPP credentials — empty Authorization
  const r5 = await sf(toolUrl, postOpts({ 'Authorization': '' }));
  expectStatus(scorer, 'empty-auth-header', [401, 402, 403], r5.status, 'empty Authorization');
  await drain(r5);

  // 6. Forged MPP credentials — garbage bearer token
  const r6 = await sf(toolUrl, postOpts({ 'Authorization': 'Bearer garbage-token-xyz' }));
  expectStatus(scorer, 'garbage-bearer', [401, 402, 403], r6.status, 'garbage Bearer token');
  await drain(r6);

  // 7. Forged MPP credentials — wrong method
  const r7 = await sf(toolUrl, postOpts({ 'Authorization': 'Basic dXNlcjpwYXNz' }));
  expectStatus(scorer, 'wrong-auth-method', [401, 402, 403], r7.status, 'Basic instead of Bearer');
  await drain(r7);

  // 8. Cross-protocol confusion: MPP header + x402 header simultaneously
  const r8 = await sf(toolUrl, postOpts({
    'X-PAYMENT': 'fake-x402-sig',
    'Authorization': 'Bearer fake-mpp-token',
  }));
  expectStatus(scorer, 'cross-protocol-confusion', [400, 401, 402, 403], r8.status,
    'both x402 and MPP headers');
  await drain(r8);

  // 9. Forged amount=0 in payment
  const r9 = await sf(toolUrl, postOpts({
    'X-PAYMENT': Buffer.from(JSON.stringify({ amount: '0', scheme: 'exact' })).toString('base64'),
  }));
  expectStatus(scorer, 'forged-zero-amount', [400, 401, 402, 403], r9.status, 'amount=0 payment');
  await drain(r9);

  // 10. MCP fake session
  try {
    const fakeSession = await mcpRequest(config.mcpServerUrl, 'tools/list', {},
      'fake-session-id-12345', null);
    expectStatus(scorer, 'mcp-fake-session', [400, 401, 403, 404], fakeSession.status,
      'fake MCP session ID');
  } catch (e) {
    scorer.rec(PHASE, 'mcp-fake-session', 'rejected', 'error', true, e.message);
  }

  // 11. Hidden endpoints
  const hiddenPaths = ['/admin', '/debug', '/internal', '/admin/config', '/debug/vars'];
  for (const path of hiddenPaths) {
    const rh = await sf(`${config.apiBaseUrl}${path}`);
    const blocked = rh.status === 404 || rh.status === 403 || rh.status === 401;
    scorer.rec(PHASE, `hidden-${path.replace(/\//g, '-').slice(1)}`,
      '404|403', rh.status, blocked, blocked ? 'blocked' : 'EXPOSED');
    await drain(rh);
    if (!blocked) {
      scorer.addError('CRITICAL', PHASE, `Hidden endpoint exposed: ${path}`,
        `Status ${rh.status}`, 'Block or remove debug endpoints in production');
    }
  }

  // 12. SQL injection in tool ID
  const sqli = "'; DROP TABLE tools; --";
  const r12 = await sf(`${config.apiUrl}/tools/${encodeURIComponent(sqli)}/call`, postOpts());
  const sqliSafe = r12.status === 400 || r12.status === 404 || r12.status === 422;
  expectStatus(scorer, 'sql-injection-tool-id', [400, 404, 422], r12.status,
    sqliSafe ? 'properly rejected' : 'SUSPICIOUS response');
  await drain(r12);

  // 13. HTTP method enforcement
  const AUTH = { 'Content-Type': 'application/json' };
  if (config.apiKey) AUTH['Authorization'] = `Bearer ${config.apiKey}`;

  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const r = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method, headers: AUTH,
    });
    scorer.rec(PHASE, `7.X ${method} method`, '405|400', r.status,
      r.status === 405 || r.status === 400 || r.status === 404,
      r.status === 200 ? 'BUG: should reject non-POST' : 'rejected');
    await drain(r); await sleep(200);
  }

  // 14. Content-Type manipulation
  for (const [label, ct] of [
    ['text/xml', 'text/xml'],
    ['form-urlencoded', 'application/x-www-form-urlencoded'],
    ['no content-type', ''],
  ]) {
    const hdrs = {};
    if (config.apiKey) hdrs['Authorization'] = `Bearer ${config.apiKey}`;
    if (ct) hdrs['Content-Type'] = ct;
    const r = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: hdrs, body: '{}',
    });
    scorer.rec(PHASE, `7.X CT:${label}`, '!500', r.status,
      r.status !== 500, `status=${r.status}`);
    await drain(r); await sleep(200);
  }

  // 15. Request ID header
  const ridRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  const requestId = ridRes.headers?.get?.('x-request-id') || '';
  scorer.rec(PHASE, '7.X Request-ID header', 'present', requestId ? 'yes' : 'no',
    requestId.length > 0, requestId.slice(0, 40));
  await drain(ridRes);

  // 7.X HTTP method override bypass
  for (const hdr of ['X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override']) {
    const r = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: { ...AUTH, [hdr]: 'GET' }, body: '{}',
    });
    scorer.rec(PHASE, `7.X ${hdr} override`, '!bypass', r.status,
      r.status === 402 || r.status === 400 || r.status === 200,
      r.status === 200 ? 'check if payment was bypassed' : 'method override ignored');
    await drain(r); await sleep(200);
  }

  // 7.X Path traversal in tool ID
  const traversals = ['tools/..%2F..%2Fadmin/call', 'tools/../../admin/call', 'tools/..\\..\\admin/call'];
  for (const path of traversals) {
    const r = await sf(`${config.apiBaseUrl}/api/v1/${path}`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    scorer.rec(PHASE, '7.X path traversal', '!200', r.status,
      r.status !== 200, r.status === 200 ? 'PATH TRAVERSAL!' : 'blocked');
    await drain(r); await sleep(150);
  }

  // 7.X Expanded hidden endpoints
  const moreHidden = ['/graphql', '/swagger', '/api-docs', '/metrics', '/prometheus',
    '/.env', '/.git/HEAD', '/config', '/actuator', '/debug/vars'];
  let moreFound = 0;
  for (const p of moreHidden) {
    const r = await sf(`${config.apiBaseUrl}${p}`, { headers: AUTH });
    if (r.status === 200) moreFound++;
    await drain(r); await sleep(100);
  }
  scorer.rec(PHASE, '7.X expanded hidden endpoints', '0 found', moreFound,
    moreFound === 0, moreFound > 0 ? `${moreFound} exposed!` : 'all blocked');

  // 7.X Request smuggling probe
  const smuggleRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Length': '2', 'Transfer-Encoding': 'chunked' },
    body: '{}',
  });
  scorer.rec(PHASE, '7.X request smuggling', '!500', smuggleRes.status,
    smuggleRes.status !== 500, 'ambiguous framing handled');
  await drain(smuggleRes);

  console.log('  Security tests complete');
};
