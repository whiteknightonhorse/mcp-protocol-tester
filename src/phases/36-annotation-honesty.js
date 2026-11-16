/**
 * Phase 36 — Annotation Honesty (T-0858, TOOL-ANNOTATIONS-1116 ruling-1).
 * Static check: reads tools/list and compares every tool's declared safety
 * hints with what its name, description and input schema say it does. It never
 * calls a tool. RED for this phase was signed off in ruling-1: a tool whose name
 * carries a money or delete verb must not declare readOnlyHint true or an
 * explicit destructiveHint false.
 */
const { mcpRequest } = require('../lib/mcp-client');
const { judge } = require('../lib/annotation-rules');
const { SLUG } = require('./27-storefront-surface');

const PHASE = 'P36';
const MAX_PAGES = 200;

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

function labelOf(u) {
  try { const p = new URL(u); return `${p.hostname}${p.pathname}`; } catch { return 'invalid-url'; }
}

function lists(config) {
  const out = [config.mcpServerUrl];
  // null = env unset: default to the storefront list P27 uses, only on the apibase.pro host.
  let extra = config.annotationExtraUrls;
  if (!Array.isArray(extra)) extra = hostOf(config.mcpServerUrl) === 'apibase.pro' ? [`${config.apiBaseUrl}/mcp/m/${SLUG}`] : [];
  for (const u of extra) if (!out.includes(u)) out.push(u);
  return out;
}

// initialize + tools/list, following nextCursor until absent. URL used exactly as given.
async function readList(url, apiKey) {
  const init = await mcpRequest(url, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-protocol-tester', version: '1.0.0' },
  }, null, apiKey);
  if (init.status !== 200) throw new Error(`initialize status ${init.status}`);
  const sid = init.sessionId;
  if (sid) { try { await mcpRequest(url, 'notifications/initialized', {}, sid, apiKey); } catch { /* optional */ } }
  const tools = [];
  let cursor;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await mcpRequest(url, 'tools/list', cursor ? { cursor } : {}, sid, apiKey);
    const res = r.body && r.body.result;
    if (r.status !== 200 || !res || !Array.isArray(res.tools)) throw new Error(`tools/list status ${r.status}`);
    tools.push(...res.tools);
    if (typeof res.nextCursor === 'string' && res.nextCursor) cursor = res.nextCursor;
    else return tools;
  }
  throw new Error('tools/list did not end (page limit)');
}

module.exports = async function phase36(scorer, config, context) {
  console.log('\n--- Phase 36: Annotation Honesty ---');
  const apiKey = (context && context.freshAuth) || config.apiKey;

  for (const url of lists(config)) {
    const label = labelOf(url);
    let tools;
    try {
      tools = await readList(url, apiKey);
    } catch (e) {
      scorer.recCatch(PHASE, `36.1 tools/list ${label}`, '>0 tools', e);
      continue;
    }
    scorer.rec(PHASE, `36.1 tools/list ${label}`, '>0 tools', tools.length, tools.length > 0, `${tools.length} tools`);

    const red = [];
    const yellow = [];
    let readOnly = 0; let write = 0; let noHints = 0;
    for (const t of tools) {
      const name = t && typeof t.name === 'string' ? t.name : '(unnamed)';
      const a = t && t.annotations && typeof t.annotations === 'object' ? t.annotations : null;
      if (!a || a.readOnlyHint === undefined) noHints++;
      else if (a.readOnlyHint === true) readOnly++;
      else write++;
      for (const f of judge(t)) (f.level === 'red' ? red : yellow).push({ name, ...f });
    }

    scorer.redRec(PHASE, `36.2 red findings ${label}`, '0 red', red.length, red.length === 0,
      red.slice(0, 10).map((f) => `${f.name}: ${f.code}`).join('; '));

    for (const f of yellow) {
      scorer.recQ(PHASE, `36.3 yellow ${label} ${f.name}`, 'no finding', f.code, false, f.detail);
    }
    const byCode = new Map();
    for (const f of yellow) byCode.set(f.code, (byCode.get(f.code) || 0) + 1);
    const grouped = [...byCode.entries()].sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c} ${n}`).join(', ');
    scorer.rec(PHASE, `36.3 yellow findings ${label}`, '0 yellow', yellow.length, yellow.length === 0, grouped);

    scorer.rec(PHASE, `36.4 coverage ${label}`, 'recorded', `${tools.length} tools`, true,
      `${tools.length} tools, ${readOnly} read-only, ${write} write, ${noHints} without hints`);
  }
};
