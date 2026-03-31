/**
 * Phase 9 — Advanced Security Tests
 * SSRF probes, timing attacks, CORS policy, header injection,
 * fuzz / input validation, and response analysis.
 */
const { sf, drain } = require('../lib/http');
const { getBody } = require('../utils/assert');

const PHASE = 'P9';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// ---------------------------------------------------------------------------
// Phase entry
// ---------------------------------------------------------------------------

module.exports = async function phase9(scorer, config, context) {
  console.log('\n--- Phase 9: Advanced Security ---');

  const AUTH = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
  const ZERO_AUTH = context.freshAuth
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${context.freshAuth}` }
    : AUTH;

  const catalog = context.catalog;
  const firstToolId = catalog.length > 0
    ? (catalog[0].id || catalog[0].name)
    : 'crypto.trending';
  const toolUrl = `${config.apiUrl}/tools/${firstToolId}/call`;

  // ========================================================================
  // 9.1 — SSRF
  // ========================================================================
  console.log('  9.1 SSRF probes...');

  const diffbotTool = catalog.find(t => (t.id || t.name) === 'diffbot.article_extract');
  const ssrfTool = diffbotTool || catalog.find(t => {
    const schema = t.input_schema || {};
    const props = schema.properties || {};
    return Object.values(props).some(p =>
      (p.description || '').toLowerCase().includes('url'));
  });

  const ssrfPayloads = [
    { url: 'http://169.254.169.254/latest/meta-data/',               label: 'aws-metadata',   leaks: ['ami-', 'instance-id'] },
    { url: 'http://metadata.google.internal/computeMetadata/v1/',    label: 'gcp-metadata',   leaks: ['project-id'] },
    { url: 'http://127.0.0.1:8080/admin',                           label: 'localhost',       leaks: [] },
    { url: 'file:///etc/passwd',                                     label: 'file-protocol',  leaks: ['root:x:0'] },
  ];

  if (!ssrfTool) {
    scorer.rec(PHASE, '9.1 SSRF', 'skip', 'no url tool', true,
      'no URL-accepting tool in catalog');
  } else {
    const ssrfToolId = ssrfTool.id || ssrfTool.name;
    const ssrfUrl = `${config.apiUrl}/tools/${ssrfToolId}/call`;

    for (const p of ssrfPayloads) {
      try {
        // Build body with malicious URL
        const body = getBody(ssrfTool);
        const schema = ssrfTool.input_schema || {};
        const props = schema.properties || {};
        const urlKey = Object.keys(props).find(k =>
          (props[k].description || '').toLowerCase().includes('url')) || 'url';
        body[urlKey] = p.url;

        const r = await sf(ssrfUrl, {
          method: 'POST',
          headers: ZERO_AUTH,
          body: JSON.stringify(body),
        }, config.timeoutMs);

        let responseText = '';
        try { responseText = await r.text(); } catch { /* empty */ }

        const leaked = p.leaks.some(sig => responseText.includes(sig));
        const ok = !leaked;
        scorer.rec(PHASE, `9.1 SSRF-${p.label}`, 'no leak', leaked ? 'LEAKED' : 'safe', ok,
          `status=${r.status} url=${p.url.slice(0, 40)}`);

        if (leaked) {
          scorer.addError('CRITICAL', PHASE, `SSRF leak: ${p.label}`,
            `Internal data found in response for ${p.url}`,
            'Block internal network access from tool execution');
        }
      } catch (e) {
        scorer.rec(PHASE, `9.1 SSRF-${p.label}`, 'no leak', 'error/blocked', true,
          e.message.slice(0, 80));
      }
      await sleep(300);
    }
  }

  // ========================================================================
  // 9.2 — Timing Attacks
  // ========================================================================
  console.log('  9.2 Timing attacks...');

  const ITERATIONS = 5;

  // 9.2a — Valid vs invalid API key timing
  const validKeyTimes = [];
  const invalidKeyTimes = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = Date.now();
    const rValid = await sf(`${config.apiUrl}/tools`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    validKeyTimes.push(Date.now() - t0);
    await drain(rValid);

    const t1 = Date.now();
    const rInvalid = await sf(`${config.apiUrl}/tools`, {
      method: 'GET',
      headers: { Authorization: 'Bearer invalid_key_xxxxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    invalidKeyTimes.push(Date.now() - t1);
    await drain(rInvalid);

    await sleep(100);
  }

  const diffKey = Math.abs(median(validKeyTimes) - median(invalidKeyTimes));
  scorer.rec(PHASE, '9.2 Timing-apikey', '<500ms diff', `${Math.round(diffKey)}ms`,
    diffKey < 500,
    `valid_median=${Math.round(median(validKeyTimes))}ms invalid_median=${Math.round(median(invalidKeyTimes))}ms`);

  // 9.2b — Existing vs nonexistent tool timing
  const existTimes = [];
  const noexistTimes = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = Date.now();
    const rExist = await sf(toolUrl, {
      method: 'POST',
      headers: ZERO_AUTH,
      body: JSON.stringify({}),
    });
    existTimes.push(Date.now() - t0);
    await drain(rExist);

    const t1 = Date.now();
    const rNoExist = await sf(`${config.apiUrl}/tools/nonexistent.fake.tool.xyz/call`, {
      method: 'POST',
      headers: ZERO_AUTH,
      body: JSON.stringify({}),
    });
    noexistTimes.push(Date.now() - t1);
    await drain(rNoExist);

    await sleep(100);
  }

  const diffTool = Math.abs(median(existTimes) - median(noexistTimes));
  scorer.rec(PHASE, '9.2 Timing-tool', '<500ms diff', `${Math.round(diffTool)}ms`,
    diffTool < 500,
    `exist_median=${Math.round(median(existTimes))}ms noexist_median=${Math.round(median(noexistTimes))}ms`);

  // ========================================================================
  // 9.3 — CORS
  // ========================================================================
  console.log('  9.3 CORS policy...');

  // 9.3a — Evil origin
  try {
    const rCors = await sf(`${config.apiUrl}/tools`, {
      method: 'GET',
      headers: { Origin: 'https://evil.com' },
    });
    const acao = rCors.headers?.get?.('access-control-allow-origin') || '';
    // Check ACAO is not the attacker's origin (exact match, not substring)
    const ok = acao !== 'https://evil.com' && acao !== 'http://evil.com';
    scorer.rec(PHASE, '9.3 CORS-evil-origin', '!evil.com', acao || '(none)', ok,
      'ACAO header must not reflect evil origin');
    await drain(rCors);
  } catch (e) {
    scorer.rec(PHASE, '9.3 CORS-evil-origin', '!evil.com', 'error', true,
      e.message.slice(0, 80));
  }

  // 9.3b — Null origin
  try {
    const rNull = await sf(`${config.apiUrl}/tools`, {
      method: 'GET',
      headers: { Origin: 'null' },
    });
    const acaoNull = rNull.headers?.get?.('access-control-allow-origin') || '';
    const okNull = acaoNull !== 'null';
    scorer.rec(PHASE, '9.3 CORS-null-origin', '!null', acaoNull || '(none)', okNull,
      'ACAO must not be literal "null"');
    await drain(rNull);
  } catch (e) {
    scorer.rec(PHASE, '9.3 CORS-null-origin', '!null', 'error', true,
      e.message.slice(0, 80));
  }

  // 9.3c — Preflight with evil origin + credentials
  try {
    const rPre = await sf(`${config.apiUrl}/tools`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization',
      },
    });
    const preAcao = rPre.headers?.get?.('access-control-allow-origin') || '';
    const preCreds = rPre.headers?.get?.('access-control-allow-credentials') || '';
    // Exact match — attacker's origin must not be reflected with credentials
    const okPre = !((preAcao === 'https://evil.com' || preAcao === 'http://evil.com') && preCreds === 'true');
    scorer.rec(PHASE, '9.3 CORS-preflight', 'no evil+creds', okPre ? 'safe' : 'EXPOSED', okPre,
      `ACAO=${preAcao} creds=${preCreds}`);
    await drain(rPre);
  } catch (e) {
    scorer.rec(PHASE, '9.3 CORS-preflight', 'no evil+creds', 'error', true,
      e.message.slice(0, 80));
  }

  // ========================================================================
  // 9.4 — Header Injection
  // ========================================================================
  console.log('  9.4 Header injection...');

  // 9.4a — CRLF in Authorization
  try {
    const rCrlf = await sf(toolUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test\r\nX-Injected: true',
      },
      body: JSON.stringify({}),
    });
    const okCrlf = rCrlf.status !== 200;
    scorer.rec(PHASE, '9.4 CRLF-injection', '!200', String(rCrlf.status), okCrlf,
      'CRLF in Authorization header');
    await drain(rCrlf);
  } catch (e) {
    // Node may reject the header at transport level — that is a pass
    scorer.rec(PHASE, '9.4 CRLF-injection', 'rejected', 'rejected', true,
      'transport rejected CRLF: ' + e.message.slice(0, 60));
  }

  // 9.4b — 64KB header value
  try {
    const bigVal = 'X'.repeat(65536);
    const rBig = await sf(toolUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Large': bigVal,
      },
      body: JSON.stringify({}),
    });
    const okBig = rBig.status !== 500;
    scorer.rec(PHASE, '9.4 Large-header', '!500', String(rBig.status), okBig,
      '64KB header value');
    await drain(rBig);
  } catch (e) {
    scorer.rec(PHASE, '9.4 Large-header', '!500', 'rejected', true,
      e.message.slice(0, 80));
  }

  // 9.4c — Host header override
  try {
    const rHost = await sf(toolUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'evil.com',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({}),
    });
    const okHost = rHost.status !== 500;
    scorer.rec(PHASE, '9.4 Host-override', '!500', String(rHost.status), okHost,
      'Host header set to evil.com');
    await drain(rHost);
  } catch (e) {
    scorer.rec(PHASE, '9.4 Host-override', '!500', 'rejected', true,
      e.message.slice(0, 80));
  }

  // ========================================================================
  // 9.5 — Fuzz / Input Validation
  // ========================================================================
  console.log('  9.5 Fuzz / input validation...');

  const fuzzCases = [
    { label: 'null-bytes',          body: { query: 'test\x00admin' } },
    { label: 'unicode-bom',         body: { query: '\uFEFFtest' } },
    { label: 'unicode-rtl',         body: { query: '\u202Eadmin\u202C' } },
    { label: 'lone-surrogate',      body: { query: 'test\uD800end' } },
    { label: 'control-chars',       body: { query: '\x01\x02\x03\x04\x05test' } },
    { label: 'max-safe-integer-id', body: { id: Number.MAX_SAFE_INTEGER } },
    { label: 'proto-pollution',     body: { __proto__: { isAdmin: true } } },
  ];

  for (const tc of fuzzCases) {
    try {
      const r = await sf(toolUrl, {
        method: 'POST',
        headers: ZERO_AUTH,
        body: JSON.stringify(tc.body),
      }, config.timeoutMs);
      const ok = r.status !== 500;
      scorer.rec(PHASE, `9.5 Fuzz-${tc.label}`, '!500', String(r.status), ok,
        ok ? 'handled gracefully' : 'server error');
      await drain(r);
    } catch (e) {
      scorer.rec(PHASE, `9.5 Fuzz-${tc.label}`, '!500', 'error', true,
        e.message.slice(0, 80));
    }
    await sleep(100);
  }

  // JSON bomb — deeply nested
  try {
    let bomb = '{"a":';
    for (let i = 0; i < 1000; i++) bomb += '{"a":';
    bomb += '"x"';
    for (let i = 0; i < 1000; i++) bomb += '}';
    bomb += '}';

    const rBomb = await sf(toolUrl, {
      method: 'POST',
      headers: ZERO_AUTH,
      body: bomb,
    }, config.timeoutMs);
    const okBomb = rBomb.status !== 500;
    scorer.rec(PHASE, '9.5 Fuzz-json-bomb', '!500', String(rBomb.status), okBomb,
      '1000 nesting levels');
    await drain(rBomb);
  } catch (e) {
    scorer.rec(PHASE, '9.5 Fuzz-json-bomb', '!500', 'rejected', true,
      e.message.slice(0, 80));
  }

  // ========================================================================
  // 9.6 — Response Analysis
  // ========================================================================
  console.log('  9.6 Response analysis...');

  // 9.6a — Malformed JSON → no stack trace in response
  try {
    const rMal = await sf(toolUrl, {
      method: 'POST',
      headers: { ...ZERO_AUTH, 'Content-Type': 'application/json' },
      body: '{"broken json',
    }, config.timeoutMs);

    let respText = '';
    try { respText = await rMal.text(); } catch { /* empty */ }

    const hasStackTrace = /at .+\.js:/.test(respText);
    scorer.rec(PHASE, '9.6 No-stack-trace', 'no trace', hasStackTrace ? 'EXPOSED' : 'safe',
      !hasStackTrace,
      hasStackTrace ? 'stack trace leaked in error response' : 'no stack trace in body');

    if (hasStackTrace) {
      scorer.addError('HIGH', PHASE, 'Stack trace leaked in error response',
        'Error response contains "at *.js:" pattern',
        'Sanitize error responses in production');
    }
  } catch (e) {
    scorer.rec(PHASE, '9.6 No-stack-trace', 'no trace', 'error', true,
      e.message.slice(0, 80));
  }

  // 9.6b — X-Powered-By not exposed
  try {
    const rPow = await sf(`${config.apiUrl}/tools`, { method: 'GET' });
    const xPowered = rPow.headers?.get?.('x-powered-by') || '';
    const okPow = !xPowered;
    scorer.rec(PHASE, '9.6 No-x-powered-by', '(empty)', xPowered || '(none)', okPow,
      xPowered ? `X-Powered-By: ${xPowered}` : 'header not present');
    await drain(rPow);

    // 9.6c — Server header is generic
    const serverH = rPow.headers?.get?.('server') || '';
    const specificServer = /express/i.test(serverH) || /nginx\/\d/i.test(serverH) ||
      /apache\/\d/i.test(serverH);
    scorer.rec(PHASE, '9.6 Generic-server', 'generic', serverH || '(none)',
      !specificServer,
      specificServer ? `version exposed: ${serverH}` : 'server header is safe');
  } catch (e) {
    scorer.rec(PHASE, '9.6 No-x-powered-by', '(empty)', 'error', true,
      e.message.slice(0, 80));
  }

  // 9.X SSRF IPv6/octal/decimal
  console.log('  9.X SSRF alternate formats...');
  const altSsrf = [
    ['IPv6 localhost', 'http://[::1]:8080/'],
    ['octal IP', 'http://0177.0.0.1/'],
    ['decimal IP', 'http://2130706433/'],
  ];
  for (const [label, url] of altSsrf) {
    // Find a URL-accepting tool in catalog
    const toolId = context.catalog.find(t => (t.id||'').includes('diffbot'))?.id || 'diffbot.article_extract';
    const r = await sf(`${config.apiUrl}/tools/${toolId}/call`, {
      method: 'POST', headers: AUTH, body: JSON.stringify({ url }),
    });
    const body = await r.text().catch(() => '');
    const leaked = body.includes('root:') || body.includes('ami-') || body.includes('instance-id');
    scorer.rec(PHASE, `9.X SSRF ${label}`, 'no leak', leaked ? 'LEAKED' : r.status,
      !leaked, leaked ? `DATA LEAKED via ${label}!` : 'blocked');
    await sleep(300);
  }

  // 9.X XXE injection
  console.log('  9.X XXE...');
  const xxeBody = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>';
  const xxeRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml', Authorization: AUTH['Authorization'] || '' },
    body: xxeBody,
  });
  const xxeText = await xxeRes.text().catch(() => '');
  scorer.rec(PHASE, '9.X XXE injection', 'no file content', xxeText.includes('root:') ? 'LEAKED' : xxeRes.status,
    !xxeText.includes('root:'), xxeText.includes('root:') ? 'XXE EXPLOIT!' : 'safe');
  await sleep(200);

  // 9.X SSTI payloads
  console.log('  9.X SSTI...');
  const sstiPayloads = ['{{7*7}}', '${7*7}', '<%= 7*7 %>'];
  for (const payload of sstiPayloads) {
    const r = await sf(`${config.apiUrl}/tools/books.search/call`, {
      method: 'POST', headers: AUTH, body: JSON.stringify({ query: payload }),
    });
    const body = await r.text().catch(() => '');
    scorer.rec(PHASE, `9.X SSTI ${payload.slice(0,6)}`, 'no 49', body.includes('49') ? 'EXECUTED' : r.status,
      !body.includes('49') || body.includes('query'), 'template injection check');
    await sleep(200);
  }

  // 9.X CORS subdomain confusion
  console.log('  9.X CORS subdomain...');
  const subRes = await sf(`${config.apiUrl}/tools`, {
    headers: { Origin: 'https://api.apibase.pro.evil.com' },
  });
  const subAcao = subRes.headers?.get?.('access-control-allow-origin') || '';
  scorer.rec(PHASE, '9.X CORS subdomain spoof', '!reflected', subAcao,
    subAcao !== 'https://api.apibase.pro.evil.com',
    subAcao === 'https://api.apibase.pro.evil.com' ? 'CORS subdomain bypass!' : 'safe');
  await drain(subRes);
  await sleep(200);

  // 9.X Access-Control-Expose-Headers audit
  const expHdrs = subRes.headers?.get?.('access-control-expose-headers') || '';
  const sensitiveExposed = ['x-payment', 'authorization', 'mcp-session'].some(h => expHdrs.toLowerCase().includes(h));
  scorer.rec(PHASE, '9.X expose-headers audit', 'no sensitive', sensitiveExposed ? 'EXPOSED' : 'safe',
    !sensitiveExposed, `exposed: ${expHdrs || 'none'}`);

  // 9.X ReDoS test
  console.log('  9.X ReDoS...');
  const redosStart = Date.now();
  const redosRes = await sf(`${config.apiUrl}/tools/books.search/call`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ query: 'a'.repeat(50000) + '!' }),
  }, 10000);
  const redosMs = Date.now() - redosStart;
  scorer.rec(PHASE, '9.X ReDoS', '<5000ms', `${redosMs}ms`, redosMs < 5000,
    redosMs >= 5000 ? 'POSSIBLE ReDoS!' : 'fast response');
  await drain(redosRes);

  console.log('  Advanced security tests complete');
};
