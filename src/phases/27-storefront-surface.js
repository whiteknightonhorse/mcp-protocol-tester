/**
 * Phase 27 — Storefront / Integrator public surface (T-0348).
 *
 * Until this phase the tester had zero Integrator coverage: /m/, /shops,
 * /legal, /integrator had no probed prefix, so P26.1 was red. Demo mode only:
 * every request is a GET, or an MCP initialize/tools/list against the demo
 * shop. No paid provider call, no quote, no order (the paid path is P28).
 */
const { sf, drain } = require('../lib/http');
const { mcpRequest } = require('../lib/mcp-client');

const PHASE = 'P27';
const SLUG = 'apibase-demo';
const CORE_TOOLS = ['shop.catalog.search', 'shop.catalog.get', 'shop.order.quote', 'shop.order.pay',
  'shop.order.cancel', 'shop.order.get'];

async function get(url, headers) {
  const r = await sf(url, headers ? { headers } : {});
  const ct = r.headers?.get?.('content-type') || '';
  let body = '';
  try { body = await r.text(); } catch { /* keep empty */ }
  return { status: r.status, ct, body };
}

// Pulls absolute URLs of this site out of a text/markdown document, dropping
// trailing punctuation that Markdown wraps around them.
function listedUrls(text, origin) {
  const out = new Set();
  const re = new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s)>\\]"']*`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[0].replace(/[.,;:]+$/, ''));
  return [...out];
}

module.exports = async function phase27(scorer, config) {
  console.log('\n--- Phase 27: Storefront / Integrator surface ---');
  const base = config.apiBaseUrl;
  const mcpUrl = `${base}/mcp/m/${SLUG}`;

  // 27.1 — merchant MCP: initialize + tools/list.
  try {
    const init = await mcpRequest(mcpUrl, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-protocol-tester', version: '1.0' },
    });
    scorer.rec(PHASE, '27.1 /mcp/m/<slug> initialize', '200 + serverInfo',
      `${init.status} ${init.body?.result?.serverInfo?.name || '(none)'}`,
      init.status === 200 && !!init.body?.result?.serverInfo && !!init.sessionId);
    const list = await mcpRequest(mcpUrl, 'tools/list', {}, init.sessionId);
    const names = (list.body?.result?.tools || []).map((t) => t.name);
    const missing = CORE_TOOLS.filter((n) => !names.includes(n));
    scorer.rec(PHASE, '27.1 /mcp/m/<slug> tools/list has the storefront tools', `all of ${CORE_TOOLS.length} core`,
      `${names.length} tools, missing: ${missing.join(', ') || 'none'}`, list.status === 200 && missing.length === 0,
      `extras allowed (brief named 6 core tools; subscription tools are extra): ${names.filter((n) => !CORE_TOOLS.includes(n)).join(', ') || 'none'}`);
  } catch (e) {
    scorer.recCatch(PHASE, '27.1 /mcp/m/<slug> MCP', '200', e);
  }

  // 27.2 — storefront HTML, agent.json, llms.txt.
  let agent = null;
  try {
    const page = await get(`${base}/m/${SLUG}`);
    scorer.rec(PHASE, '27.2 GET /m/<slug>', '200 text/html', `${page.status} ${page.ct.split(';')[0]}`,
      page.status === 200 && page.ct.includes('text/html'));
    const aj = await get(`${base}/m/${SLUG}/agent.json`);
    try { agent = JSON.parse(aj.body); } catch { agent = null; }
    scorer.rec(PHASE, '27.2 agent.json is JSON', '200 application/json', `${aj.status} ${aj.ct.split(';')[0]}`,
      aj.status === 200 && aj.ct.includes('json') && !!agent);
    if (agent) {
      scorer.rec(PHASE, '27.2 agent.json provek block', 'object with declared:boolean',
        JSON.stringify(agent.provek || null).slice(0, 80),
        !!agent.provek && typeof agent.provek === 'object' && typeof agent.provek.declared === 'boolean');
      scorer.rec(PHASE, '27.2 agent.json rest_base', `${base}/api/v1/shop`, String(agent.rest_base),
        agent.rest_base === `${base}/api/v1/shop`);
      scorer.rec(PHASE, '27.2 agent.json mcp_url', mcpUrl, String(agent.mcp_url), agent.mcp_url === mcpUrl);
    }
  } catch (e) {
    scorer.recCatch(PHASE, '27.2 storefront page / agent.json', '200', e);
  }

  // 27.3 — every URL a llms.txt lists answers. The MCP endpoint is POST-only
  // (documented as "connect ... (MCP)"): assert POST initialize works (27.1)
  // and that GET is a 4xx refusal, never a 5xx.
  const llmsDocs = [
    { name: `/m/${SLUG}/llms.txt`, url: `${base}/m/${SLUG}/llms.txt` },
    { name: '/integrator/llms.txt', url: `${base}/integrator/llms.txt` },
  ];
  for (const doc of llmsDocs) {
    try {
      const d = await get(doc.url);
      scorer.rec(PHASE, `27.3 ${doc.name}`, '200 text/plain', `${d.status} ${d.ct.split(';')[0]}`,
        d.status === 200 && d.ct.includes('text/plain') && d.body.length > 0);
      if (d.status !== 200) continue;
      const urls = listedUrls(d.body, base).filter((u) => u !== doc.url);
      scorer.rec(PHASE, `27.3 ${doc.name} lists URLs`, '>=1', String(urls.length), urls.length >= 1);
      const bad = [];
      for (const u of urls) {
        const isMcp = u.startsWith(`${base}/mcp/`);
        const r = await sf(u);
        await drain(r);
        const ok = isMcp ? (r.status >= 400 && r.status < 500) : r.status === 200;
        if (!ok) bad.push(`${u.slice(base.length)} -> ${r.status}${isMcp ? ' (POST-only, expected 4xx on GET)' : ''}`);
      }
      scorer.rec(PHASE, `27.3 ${doc.name} every listed URL answers`, `${urls.length} ok`,
        bad.length ? bad.join('; ') : `${urls.length} ok`, bad.length === 0);
    } catch (e) {
      scorer.recCatch(PHASE, `27.3 ${doc.name}`, '200', e);
    }
  }

  // 27.4 — /shops and /integrator (HTML + Markdown negotiation).
  let shopSlugs = [];
  try {
    const shops = await get(`${base}/shops`);
    shopSlugs = [...new Set([...shops.body.matchAll(/href="\/m\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
    scorer.rec(PHASE, '27.4 GET /shops', '200 text/html + >=1 shop', `${shops.status}, ${shopSlugs.length} shops`,
      shops.status === 200 && shops.ct.includes('text/html') && shopSlugs.length >= 1);
    const integ = await get(`${base}/integrator`);
    scorer.rec(PHASE, '27.4 GET /integrator', '200 text/html', `${integ.status} ${integ.ct.split(';')[0]}`,
      integ.status === 200 && integ.ct.includes('text/html'));
    const md = await get(`${base}/integrator`, { Accept: 'text/markdown' });
    scorer.rec(PHASE, '27.4 /integrator Accept: text/markdown', '200 text/markdown', `${md.status} ${md.ct.split(';')[0]}`,
      md.status === 200 && md.ct.includes('text/markdown') && md.body.length > 0);
  } catch (e) {
    scorer.recCatch(PHASE, '27.4 /shops, /integrator', '200', e);
  }

  // 27.5 — rest_base parity: REST discover kind=merchant vs /shops. Discover is
  // intent-ranked, so it cannot enumerate; the union over a few broad intents
  // must be a non-empty subset of the /shops slugs (a discovered shop missing
  // from /shops is a listing divergence). The demo shop must appear in both.
  try {
    const found = new Set();
    for (const intent of ['shop', 'guide']) {
      const d = await get(`${base}/api/v1/discover?kind=merchant&intent=${intent}&limit=50`);
      let j = null;
      try { j = JSON.parse(d.body); } catch { /* handled below */ }
      for (const x of j?.results || []) if (x.kind === 'merchant') found.add(x.slug);
    }
    const extra = [...found].filter((s) => !shopSlugs.includes(s));
    scorer.rec(PHASE, '27.5 discover kind=merchant slugs are listed on /shops', 'non-empty subset',
      `discover=[${[...found].join(',')}] shops=[${shopSlugs.join(',')}] not-on-shops=[${extra.join(',')}]`,
      found.size >= 1 && extra.length === 0 && found.has(SLUG) && shopSlugs.includes(SLUG));
  } catch (e) {
    scorer.recCatch(PHASE, '27.5 discover/shops parity', 'subset', e);
  }
};
