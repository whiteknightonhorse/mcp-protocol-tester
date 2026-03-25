/**
 * Phase 0 — Discovery
 * Fetches tool catalog, probes well-known endpoints, detects dual-rail support,
 * registers a fresh agent for scanning.
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'discovery';

async function wellKnown(scorer, baseUrl, path, label) {
  const r = await sf(`${baseUrl}${path}`);
  const ok = r.status === 200;
  let body = null;
  if (ok) { try { body = await r.json(); } catch { await drain(r); } }
  else { await drain(r); }
  scorer.rec(PHASE, label, 200, r.status, ok, ok ? 'found' : 'missing');
  return body;
}

module.exports = async function phase0(scorer, config, context) {
  console.log('\n--- Phase 0: Discovery ---');

  // 1. Fetch tool catalog with pagination
  let tools = [];
  let page = 1;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    const url = `${config.apiUrl}/tools?page=${page}&limit=${limit}`;
    const r = await sf(url);
    if (r.status !== 200) {
      scorer.rec(PHASE, 'catalog-fetch', 200, r.status, false, `page ${page} failed`);
      await drain(r);
      break;
    }
    const data = await r.json();
    const items = Array.isArray(data) ? data : (data.tools || data.data || []);
    tools = tools.concat(items);
    hasMore = items.length === limit;
    page++;
  }

  context.catalog = tools;
  const maxNote = config.maxTools > 0 ? ` (max ${config.maxTools})` : '';
  scorer.rec(PHASE, 'catalog-count', '>0', tools.length, tools.length > 0,
    `${tools.length} tools loaded${maxNote}`);

  if (config.maxTools > 0 && tools.length > config.maxTools) {
    context.catalog = tools.slice(0, config.maxTools);
  }

  // 2. Well-known endpoints
  const base = config.apiBaseUrl;
  await wellKnown(scorer, base, '/.well-known/mcp.json', 'well-known/mcp.json');
  const serverCard = await wellKnown(scorer, base, '/.well-known/mcp/server-card.json', 'well-known/server-card');
  await wellKnown(scorer, base, '/.well-known/ai-capabilities.json', 'well-known/ai-capabilities');
  const x402wk = await wellKnown(scorer, base, '/.well-known/x402-payment.json', 'well-known/x402-payment');

  if (x402wk) context.hasX402 = true;

  // 3. Probe one tool to detect dual-rail (x402 body + WWW-Authenticate: Payment header)
  if (tools.length > 0) {
    const probe = tools[0];
    const probeUrl = `${config.apiUrl}/tools/${probe.id || probe.name}/run`;
    const r = await sf(probeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const wwwAuth = r.headers?.get?.('www-authenticate') || '';
    const hasMppHeader = wwwAuth.toLowerCase().includes('payment');

    let body402 = null;
    try { body402 = await r.json(); } catch { await drain(r); }

    const hasX402Body = body402 && body402.x402Version >= 1;

    context.hasMPP = hasMppHeader;
    if (hasX402Body) context.hasX402 = true;

    const dualRail = hasMppHeader && hasX402Body;
    scorer.rec(PHASE, 'dual-rail-detect', 'true', dualRail,
      dualRail || hasMppHeader || hasX402Body,
      `MPP=${hasMppHeader} x402=${hasX402Body}`);
  }

  // 4. Register fresh agent for scanning
  try {
    const r = await sf(`${config.apiUrl}/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'mcp-protocol-tester',
        description: 'Automated test agent',
      }),
    });
    if (r.status === 200 || r.status === 201) {
      const data = await r.json();
      context.freshAuth = data.apiKey || data.api_key || data.token || null;
      scorer.rec(PHASE, 'agent-register', '2xx', r.status, true, 'agent registered');
    } else {
      await drain(r);
      scorer.rec(PHASE, 'agent-register', '2xx', r.status, false, 'registration failed');
    }
  } catch (e) {
    scorer.rec(PHASE, 'agent-register', '2xx', 'error', false, e.message);
  }

  console.log(`  Catalog: ${context.catalog.length} tools | MPP: ${context.hasMPP} | x402: ${context.hasX402}`);
};
