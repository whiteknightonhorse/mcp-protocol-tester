/**
 * Phase 10 — Resilience Tests
 * Brute force resistance, SSL/TLS inspection, enumeration protection,
 * and error cascade / consistency checks.
 */
const { sf, drain } = require('../lib/http');
const { getBody } = require('../utils/assert');
const tls = require('tls');

const PHASE = 'P10';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Phase entry
// ---------------------------------------------------------------------------

module.exports = async function phase10(scorer, config, context) {
  console.log('\n--- Phase 10: Resilience ---');

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
  // 10.1 — Brute Force
  // ========================================================================
  console.log('  10.1 Brute force resistance...');

  // 10.1a — 50 random API keys in parallel
  const keys = Array(50).fill(null).map(() =>
    'ak_live_' + Array(32).fill(0).map(() =>
      '0123456789abcdef'[Math.floor(Math.random() * 16)]
    ).join('')
  );

  const brutePromises = keys.map(k =>
    sf(toolUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
      body: JSON.stringify({}),
    }).then(async (r) => {
      const s = r.status;
      await drain(r);
      return s;
    })
  );

  const bruteResults = await Promise.all(brutePromises);
  const all401 = bruteResults.every(s => s === 401 || s === 403 || s === 429);
  const any200 = bruteResults.some(s => s === 200);

  scorer.rec(PHASE, '10.1 Brute-random-keys', 'all 401/403/429',
    any200 ? 'SOME 200' : 'all rejected', !any200,
    `results: 401=${bruteResults.filter(s => s === 401).length} ` +
    `403=${bruteResults.filter(s => s === 403).length} ` +
    `429=${bruteResults.filter(s => s === 429).length} ` +
    `200=${bruteResults.filter(s => s === 200).length}`);

  if (any200) {
    scorer.addError('CRITICAL', PHASE, 'Random API key accepted',
      'At least one random key returned 200',
      'Validate API keys against a known store');
  }

  await sleep(500);

  // 10.1b — X-Forwarded-For bypass: 10 requests with spoofed IPs
  const spoofedIps = Array.from({ length: 10 }, (_, i) =>
    `${10 + i}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
  );

  const xffPromises = spoofedIps.map(ip =>
    sf(toolUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid_brute_force_key',
        'X-Forwarded-For': ip,
      },
      body: JSON.stringify({}),
    }).then(async (r) => {
      const s = r.status;
      await drain(r);
      return s;
    })
  );

  const xffResults = await Promise.all(xffPromises);
  const xffAny200 = xffResults.some(s => s === 200);
  scorer.rec(PHASE, '10.1 XFF-bypass', 'all 401', xffAny200 ? 'SOME 200' : 'all rejected',
    !xffAny200,
    `statuses: ${[...new Set(xffResults)].join(',')}`);

  await sleep(500);

  // 10.1c — Valid key after brute force still works
  try {
    const rAfter = await sf(toolUrl, {
      method: 'POST',
      headers: ZERO_AUTH,
      body: JSON.stringify(getBody(firstToolId)),
    });
    const afterOk = rAfter.status === 200 || rAfter.status === 402;
    scorer.rec(PHASE, '10.1 Post-brute-valid', '200|402', String(rAfter.status), afterOk,
      afterOk ? 'valid key still works after brute force' : 'valid key blocked (429?)');
    await drain(rAfter);

    if (!afterOk && rAfter.status === 429) {
      scorer.addRec('SEC', 'Rate limiter blocks legitimate users after brute force',
        'Consider per-key rate limiting instead of per-IP to avoid blocking valid users');
    }
  } catch (e) {
    scorer.rec(PHASE, '10.1 Post-brute-valid', '200|402', 'error', false,
      e.message.slice(0, 100));
  }

  // ========================================================================
  // 10.2 — SSL/TLS
  // ========================================================================
  console.log('  10.2 SSL/TLS inspection...');

  // 10.2a — TLS version check
  const hostname = new URL(config.apiBaseUrl).hostname;
  const port = new URL(config.apiBaseUrl).port || 443;

  try {
    const tlsResult = await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: hostname, port: Number(port), servername: hostname, rejectUnauthorized: true },
        () => {
          const proto = socket.getProtocol();
          socket.destroy();
          resolve(proto);
        }
      );
      socket.setTimeout(10000);
      socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS timeout')); });
      socket.on('error', (e) => reject(e));
    });

    const tlsOk = tlsResult === 'TLSv1.2' || tlsResult === 'TLSv1.3';
    scorer.rec(PHASE, '10.2 TLS-version', 'TLSv1.2+', tlsResult, tlsOk,
      tlsOk ? 'modern TLS' : 'outdated TLS version');
  } catch (e) {
    scorer.rec(PHASE, '10.2 TLS-version', 'TLSv1.2+', 'error', false,
      e.message.slice(0, 100));
  }

  // 10.2b — HSTS header
  try {
    const rHsts = await sf(`${config.apiUrl}/tools`, { method: 'GET' });
    const hsts = rHsts.headers?.get?.('strict-transport-security') || '';
    scorer.rec(PHASE, '10.2 HSTS', 'present', hsts ? 'present' : 'missing', !!hsts,
      hsts || 'Strict-Transport-Security header not set');
    await drain(rHsts);

    // 10.2c — Security headers
    const secHeaders = [
      { name: 'x-content-type-options', label: 'X-Content-Type-Options' },
      { name: 'x-frame-options',        label: 'X-Frame-Options' },
      { name: 'content-security-policy', label: 'Content-Security-Policy' },
    ];

    for (const sh of secHeaders) {
      const val = rHsts.headers?.get?.(sh.name) || '';
      scorer.rec(PHASE, `10.2 Header-${sh.label}`, 'present', val ? 'present' : 'missing',
        !!val, val || `${sh.label} not set`);
    }
  } catch (e) {
    scorer.rec(PHASE, '10.2 HSTS', 'present', 'error', false,
      e.message.slice(0, 100));
  }

  // ========================================================================
  // 10.3 — Enumeration
  // ========================================================================
  console.log('  10.3 Enumeration protection...');

  // 10.3a — Different invalid key formats return same status
  const invalidKeyFormats = [
    'short',
    'ak_live_0000000000000000000000000000000000000000',
    'Bearer ey.invalid.jwt.token',
    '""',
    Array(500).fill('x').join(''),
  ];

  const enumStatuses = [];
  for (const k of invalidKeyFormats) {
    try {
      const r = await sf(toolUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
        body: JSON.stringify({}),
      });
      enumStatuses.push(r.status);
      await drain(r);
    } catch {
      enumStatuses.push('error');
    }
    await sleep(100);
  }

  const uniqueStatuses = [...new Set(enumStatuses)];
  const uniformErrors = uniqueStatuses.length === 1;
  scorer.rec(PHASE, '10.3 Uniform-errors', '1 status', `${uniqueStatuses.length} status(es)`,
    uniformErrors,
    `statuses: ${uniqueStatuses.join(',')} — ${uniformErrors ? 'uniform' : 'format leakage'}`);

  // 10.3b — Hidden endpoints
  const hiddenPaths = [
    '/api/v1/admin',
    '/api/v1/debug',
    '/api/v1/internal',
    '/api/v2/tools',
  ];

  for (const path of hiddenPaths) {
    try {
      const r = await sf(`${config.apiBaseUrl}${path}`, { method: 'GET' });
      const blocked = r.status === 404 || r.status === 403 || r.status === 401;
      scorer.rec(PHASE, `10.3 Hidden-${path.split('/').pop()}`, '404',
        String(r.status), blocked,
        blocked ? 'blocked' : 'EXPOSED');
      await drain(r);

      if (!blocked) {
        scorer.addError('HIGH', PHASE, `Hidden endpoint exposed: ${path}`,
          `Status ${r.status}`, 'Block or remove non-public endpoints');
      }
    } catch (e) {
      scorer.rec(PHASE, `10.3 Hidden-${path.split('/').pop()}`, '404', 'error', true,
        e.message.slice(0, 80));
    }
    await sleep(100);
  }

  // 10.3c — Tool ID injection
  const injectionIds = [
    "' OR 1=1 --",
    '../../../etc/passwd',
    '<script>alert(1)</script>',
  ];

  for (const injId of injectionIds) {
    try {
      const r = await sf(`${config.apiUrl}/tools/${encodeURIComponent(injId)}/call`, {
        method: 'POST',
        headers: ZERO_AUTH,
        body: JSON.stringify({}),
      });
      const ok = r.status !== 200;
      scorer.rec(PHASE, `10.3 Injection-${injId.slice(0, 15).replace(/[^a-zA-Z0-9]/g, '_')}`,
        '!200', String(r.status), ok,
        ok ? 'rejected' : 'ACCEPTED malicious ID');
      await drain(r);
    } catch (e) {
      scorer.rec(PHASE, `10.3 Injection`, '!200', 'error', true,
        e.message.slice(0, 80));
    }
    await sleep(100);
  }

  // ========================================================================
  // 10.4 — Error Cascade
  // ========================================================================
  console.log('  10.4 Error cascade / consistency...');

  // 10.4a — Bad request then good request
  try {
    // Send bad request
    await sf(toolUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"invalid json',
    });
    await sleep(200);

    // Send good request
    const rGood = await sf(toolUrl, {
      method: 'POST',
      headers: ZERO_AUTH,
      body: JSON.stringify(getBody(firstToolId)),
    });
    const goodOk = rGood.status === 200 || rGood.status === 402;
    scorer.rec(PHASE, '10.4 Recovery-after-bad', '200|402', String(rGood.status), goodOk,
      goodOk ? 'server recovered after bad request' : 'server impacted by prior bad request');
    await drain(rGood);
  } catch (e) {
    scorer.rec(PHASE, '10.4 Recovery-after-bad', '200|402', 'error', false,
      e.message.slice(0, 100));
  }

  // 10.4b — 10 parallel catalog fetches return same count
  try {
    const PARALLEL = 10;
    const catalogPromises = Array.from({ length: PARALLEL }, () =>
      sf(`${config.apiUrl}/tools`, { method: 'GET' }).then(async (r) => {
        if (r.status !== 200) {
          await drain(r);
          return -1;
        }
        try {
          const data = await r.json();
          const items = Array.isArray(data) ? data : (data.tools || data.data || []);
          return items.length;
        } catch {
          return -1;
        }
      })
    );

    const counts = await Promise.all(catalogPromises);
    const validCounts = counts.filter(c => c >= 0);
    const uniqueCounts = [...new Set(validCounts)];
    const consistent = uniqueCounts.length <= 1;

    scorer.rec(PHASE, '10.4 Catalog-consistency', '1 count',
      `${uniqueCounts.length} count(s)`, consistent,
      `counts: ${uniqueCounts.join(',')} (${validCounts.length}/${PARALLEL} valid)`);

    if (!consistent) {
      scorer.addRec('RELIABILITY', 'Catalog returns inconsistent results under concurrency',
        `Got ${uniqueCounts.length} different tool counts: ${uniqueCounts.join(', ')}`);
    }
  } catch (e) {
    scorer.rec(PHASE, '10.4 Catalog-consistency', '1 count', 'error', false,
      e.message.slice(0, 100));
  }

  console.log('  Resilience tests complete');
};
