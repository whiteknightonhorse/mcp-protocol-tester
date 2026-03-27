/**
 * Phase 0 — Discovery
 * Fetches tool catalog, probes well-known endpoints, detects dual-rail support,
 * registers a fresh agent for scanning.
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'P0';

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

  // 1. Fetch tool catalog (single request — API returns all tools at once)
  let tools = [];
  const r0 = await sf(`${config.apiUrl}/tools?limit=1000`);
  if (r0.status === 200) {
    const data = await r0.json();
    tools = Array.isArray(data) ? data : (data.tools || data.data || []);
  } else {
    scorer.rec(PHASE, 'catalog-fetch', 200, r0.status, false, 'catalog fetch failed');
    await drain(r0);
  }

  context.catalog = tools;
  const maxNote = config.maxTools > 0 ? ` (max ${config.maxTools})` : '';
  scorer.rec(PHASE, 'catalog-count', '>0', tools.length, tools.length > 0,
    `${tools.length} tools loaded${maxNote}`);

  // Catalog schema validation (spot check first 50 tools)
  let validSchemas = 0;
  for (const tool of tools.slice(0, 50)) {
    const id = tool.id || tool.name;
    const hasDesc = typeof (tool.description || '') === 'string' && (tool.description || '').length > 0;
    const hasSchema = tool.input_schema && tool.input_schema.type === 'object';
    if (id && hasDesc) validSchemas++;
  }
  scorer.rec(PHASE, 'catalog-schema', '>=45/50', `${validSchemas}/50`,
    validSchemas >= 40, 'spot check tool schema quality');

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
    const probeUrl = `${config.apiUrl}/tools/${probe.id || probe.name}/call`;
    const probeHeaders = { 'Content-Type': 'application/json' };
    if (config.apiKey) probeHeaders['Authorization'] = `Bearer ${config.apiKey}`;
    const r = await sf(probeUrl, {
      method: 'POST',
      headers: probeHeaders,
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

  // 4. Set auth for scanning (uses configured API_KEY — server auto-registers agents)
  if (config.apiKey) {
    context.freshAuth = config.apiKey;
    scorer.rec(PHASE, 'auth-configured', 'API_KEY set', 'set', true, 'using configured API key');
  } else {
    scorer.rec(PHASE, 'auth-configured', 'API_KEY set', 'missing', false,
      'no API_KEY — set API_KEY in .env (server auto-registers on first request)');
  }

  console.log(`  Catalog: ${context.catalog.length} tools | MPP: ${context.hasMPP} | x402: ${context.hasX402}`);
};
