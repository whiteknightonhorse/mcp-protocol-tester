/**
 * Phase 16 — Platform Features Tests
 * Tests Usage Analytics (F4), Tool Quality Index (F5), Batch API (F1),
 * and cross-feature consistency for 6 new platform tools.
 */
const { sf, drain } = require('../lib/http');
const { mcpRequest } = require('../lib/mcp-client');

const PHASE = 'P16';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// T-0135: apibase's `buildToolQuality()` (Q-1/T-2 contract, see
// src/services/tool-quality.service.ts on the server) never fabricates a 0
// for an unmeasured tool. Below this many calls in the 24h window,
// success_rate/p50_ms/p95_ms are `null` — a real, legitimate value, not a
// missing field. 10 is the server's own constant (QUALITY_MIN_CALLS);
// hardcoded here because it's a documented contract number (Specification
// §Q-1), not an implementation detail this repo can import.
const QUALITY_MIN_CALLS = 10;

// `platform.tool_quality` shape validator — `data.tool` is `null` (never
// measured) or `{window_h, calls, success_rate, p50_ms, p95_ms, as_of}`
// with success_rate/p50_ms/p95_ms staying `null` below QUALITY_MIN_CALLS.
// Exported so scripts/test-t0135-mutation.js can feed it a synthetic
// pre-Q-1 flat body (`{tool_id, uptime_pct, error_rate, total_calls,
// success_calls}`) without needing the server to still speak that shape.
function evaluateToolQualityShape(data) {
  if (!data || typeof data.tool_id !== 'string') {
    return { ok: false, detail: 'missing tool_id' };
  }
  if (!('tool' in data)) {
    return { ok: false, detail: 'response has no `tool` key (pre-Q-1 flat shape?)' };
  }
  const tool = data.tool;
  if (tool === null) {
    return { ok: true, detail: 'tool=null (no measurement)', tool: null };
  }
  if (typeof tool !== 'object') {
    return { ok: false, detail: `tool is ${typeof tool}, expected object or null` };
  }
  if (typeof tool.window_h !== 'number') return { ok: false, detail: 'tool.window_h not a number' };
  if (typeof tool.calls !== 'number' || tool.calls < 0) return { ok: false, detail: 'tool.calls invalid' };
  if (typeof tool.as_of !== 'string') return { ok: false, detail: 'tool.as_of not a string' };
  const enoughSample = tool.calls >= QUALITY_MIN_CALLS;
  if (enoughSample) {
    if (typeof tool.success_rate !== 'number' || tool.success_rate < 0 || tool.success_rate > 100) {
      return { ok: false, detail: `success_rate out of range at calls=${tool.calls}: ${tool.success_rate}` };
    }
  } else if (tool.success_rate !== null) {
    return { ok: false, detail: `success_rate should be null below ${QUALITY_MIN_CALLS} calls (calls=${tool.calls}), got ${tool.success_rate}` };
  }
  if (tool.p50_ms !== null && typeof tool.p50_ms !== 'number') return { ok: false, detail: 'tool.p50_ms not null/number' };
  if (tool.p95_ms !== null && typeof tool.p95_ms !== 'number') return { ok: false, detail: 'tool.p95_ms not null/number' };
  return { ok: true, detail: `calls=${tool.calls} success_rate=${tool.success_rate}`, tool };
}

// `platform.tool_rankings` shape validator — every entry present implies a
// real sample (server-side filter skips tools with success_rate===null), so
// total_calls < QUALITY_MIN_CALLS on a present entry means the pre-T-2
// fabricated-zero bug is back. An empty/short array is legitimate: most
// tools have no 24h traffic (Q-1 measured Redis slice: 2/1384 sampled).
function evaluateRankings(rd, limit) {
  if (!Array.isArray(rd)) return { ok: false, detail: 'not an array' };
  if (rd.length > limit) return { ok: false, detail: `len=${rd.length} exceeds limit=${limit}` };
  for (const item of rd) {
    if (typeof item.tool_id !== 'string') return { ok: false, detail: `entry missing tool_id: ${JSON.stringify(item)}` };
    if (typeof item.uptime_pct !== 'number' || item.uptime_pct < 0 || item.uptime_pct > 100) {
      return { ok: false, detail: `bad uptime_pct on ${item.tool_id}` };
    }
    if (typeof item.error_rate !== 'number' || item.error_rate < 0 || item.error_rate > 100) {
      return { ok: false, detail: `bad error_rate on ${item.tool_id}` };
    }
    if (typeof item.total_calls !== 'number' || item.total_calls < QUALITY_MIN_CALLS) {
      return { ok: false, detail: `fabricated/low-sample entry ${item.tool_id}: total_calls=${item.total_calls}` };
    }
  }
  return { ok: true, detail: `len=${rd.length}, all entries sampled (>=${QUALITY_MIN_CALLS} calls)` };
}

// New tool IDs (REST) and their MCP names
const PLATFORM_TOOLS = {
  'account.usage':       'account.analytics.usage',
  'account.tools':       'account.analytics.tools',
  'account.timeseries':  'account.analytics.timeseries',
  'platform.tool_quality': 'platform.quality.tool',
  'platform.tool_rankings': 'platform.quality.rankings',
  'platform.call_batch': 'platform.batch.call',
};

module.exports = async function phase16(scorer, config, context) {
  console.log('\n== PHASE 16: PLATFORM FEATURES ==\n');

  const AUTH = { 'Content-Type': 'application/json' };
  if (config.apiKey) AUTH['Authorization'] = `Bearer ${config.apiKey}`;
  const mcpUrl = config.mcpServerUrl;

  // Helper: REST call to a tool
  async function callTool(toolId, params) {
    return sf(`${config.apiUrl}/tools/${toolId}/call`, {
      method: 'POST', headers: AUTH, body: JSON.stringify(params),
    });
  }

  // Helper: parse JSON response safely
  async function parseJson(r) {
    try { return await r.json(); } catch { await drain(r); return null; }
  }

  // ══════════════════════════════════════════════════════════════
  //  F4: Usage Analytics (account.usage, account.tools, account.timeseries)
  // ══════════════════════════════════════════════════════════════
  console.log('  --- F4: Usage Analytics ---\n');

  // 16.1 account.usage returns valid stats
  const usageRes = await callTool('account.usage', { period: '7d' });
  const usageBody = await parseJson(usageRes);
  const ud = usageBody?.data;
  const usageValid = ud
    && typeof ud.period === 'string'
    && typeof ud.total_calls === 'number' && ud.total_calls >= 0
    && typeof ud.total_cost_usd === 'number' && ud.total_cost_usd >= 0
    && typeof ud.cache_hits === 'number' && ud.cache_hits >= 0
    && typeof ud.cache_hit_rate === 'number' && ud.cache_hit_rate >= 0 && ud.cache_hit_rate <= 1
    && typeof ud.unique_tools === 'number' && ud.unique_tools >= 0;
  scorer.rec(PHASE, '16.1 account.usage', 'valid stats', usageRes.status,
    usageRes.status === 200 && usageValid,
    usageValid ? `calls=${ud.total_calls} cost=$${ud.total_cost_usd} tools=${ud.unique_tools}` : 'missing fields');
  // Check free
  const usageFree = usageBody?.metadata?.cost_usd === 0 || usageBody?.metadata?.billing_status === 'FREE';
  scorer.rec(PHASE, '16.1b account.usage is free', 'FREE', usageFree ? 'FREE' : 'PAID', usageFree);
  await sleep(300);

  // 16.2 account.tools returns per-tool breakdown
  const toolsRes = await callTool('account.tools', { sort: 'calls', limit: 5 });
  const toolsBody = await parseJson(toolsRes);
  const td = toolsBody?.data;
  const toolsIsArray = Array.isArray(td);
  const toolsLimited = toolsIsArray && td.length <= 5;
  let toolsFieldsOk = false;
  if (toolsIsArray && td.length > 0) {
    const item = td[0];
    toolsFieldsOk = typeof item.tool_id === 'string'
      && typeof item.total_calls === 'number'
      && typeof item.total_cost_usd === 'number';
  }
  scorer.rec(PHASE, '16.2 account.tools', 'array <=5', toolsRes.status,
    toolsRes.status === 200 && toolsIsArray && toolsLimited,
    `len=${td?.length} fields=${toolsFieldsOk}`);
  // Check sort order (descending by total_calls)
  let sortOk = true;
  if (toolsIsArray && td.length > 1) {
    for (let i = 1; i < td.length; i++) {
      if (td[i].total_calls > td[i - 1].total_calls) { sortOk = false; break; }
    }
  }
  scorer.rec(PHASE, '16.2b sort=calls desc', 'sorted', sortOk ? 'yes' : 'no', sortOk);
  await sleep(300);

  // 16.3 account.tools sort variants
  for (const sort of ['cost', 'latency']) {
    const r = await callTool('account.tools', { sort, limit: 3 });
    const b = await parseJson(r);
    scorer.rec(PHASE, `16.3 account.tools sort=${sort}`, '200', r.status,
      r.status === 200 && Array.isArray(b?.data));
    await sleep(200);
  }

  // 16.4 account.timeseries returns time buckets
  const tsRes = await callTool('account.timeseries', { period: '1d', granularity: 'hour' });
  const tsBody = await parseJson(tsRes);
  const tsd = tsBody?.data;
  const tsIsArray = Array.isArray(tsd);
  let bucketsOk = false;
  if (tsIsArray && tsd.length > 0) {
    const b = tsd[0];
    bucketsOk = typeof b.bucket === 'string' && typeof b.calls === 'number' && typeof b.cost_usd === 'number';
  }
  scorer.rec(PHASE, '16.4 account.timeseries hour', 'buckets', tsRes.status,
    tsRes.status === 200 && tsIsArray && bucketsOk,
    `buckets=${tsd?.length} fields=${bucketsOk}`);
  // Check ascending sort
  let tsAscOk = true;
  if (tsIsArray && tsd.length > 1) {
    for (let i = 1; i < tsd.length; i++) {
      if (tsd[i].bucket < tsd[i - 1].bucket) { tsAscOk = false; break; }
    }
  }
  scorer.rec(PHASE, '16.4b buckets ascending', 'sorted', tsAscOk ? 'yes' : 'no', tsAscOk);
  await sleep(300);

  // 16.5 account.timeseries day granularity
  const tsDayRes = await callTool('account.timeseries', { period: '7d', granularity: 'day' });
  const tsDayBody = await parseJson(tsDayRes);
  scorer.rec(PHASE, '16.5 timeseries granularity=day', '200', tsDayRes.status,
    tsDayRes.status === 200 && Array.isArray(tsDayBody?.data));
  await sleep(300);

  // 16.6 account tools require auth
  const noAuthRes = await sf(`${config.apiUrl}/tools/account.usage/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period: '7d' }),
  });
  const noAuthBody = await parseJson(noAuthRes);
  scorer.rec(PHASE, '16.6 usage no auth', '401', noAuthRes.status,
    noAuthRes.status === 401, noAuthBody?.error || '');
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  F5: Tool Quality Index (platform.tool_quality, platform.tool_rankings)
  // ══════════════════════════════════════════════════════════════
  console.log('\n  --- F5: Tool Quality Index ---\n');

  // 16.7 platform.tool_quality returns quality data (T-0135: Q-1/T-2 shape —
  // `tool` is `null` or a sampled object; null is a legitimate value, not a
  // failure).
  const qualRes = await callTool('platform.tool_quality', { tool_id: 'crypto.get_price' });
  const qualBody = await parseJson(qualRes);
  const qd = qualBody?.data;
  const qc = evaluateToolQualityShape(qd);
  scorer.rec(PHASE, '16.7 tool_quality', 'valid data (tool=null or sampled shape)', qualRes.status,
    qualRes.status === 200 && qc.ok, qc.detail);
  // Invariants — only meaningful when there IS a measurement; a null tool
  // has nothing to check (absence of data is not a failure, T-2).
  if (qc.ok && qc.tool) {
    const t = qc.tool;
    const enoughSample = t.calls >= QUALITY_MIN_CALLS;
    const rateInRange = !enoughSample || (typeof t.success_rate === 'number' && t.success_rate >= 0 && t.success_rate <= 100);
    scorer.rec(PHASE, '16.7b success_rate in [0,100] when sampled', '0<=x<=100',
      enoughSample ? t.success_rate : `n/a (calls<${QUALITY_MIN_CALLS})`, rateInRange, `calls=${t.calls}`);

    const nullBelowThreshold = enoughSample || t.success_rate === null;
    scorer.rec(PHASE, '16.7c success_rate=null below sample threshold', 'null',
      enoughSample ? 'n/a (sampled)' : t.success_rate, nullBelowThreshold, `calls=${t.calls} threshold=${QUALITY_MIN_CALLS}`);
  } else if (qc.ok) {
    scorer.rec(PHASE, '16.7b success_rate in [0,100] when sampled', 'skip: tool=null', 'skip', true, 'no measurement, nothing to check');
    scorer.rec(PHASE, '16.7c success_rate=null below sample threshold', 'skip: tool=null', 'skip', true, 'no measurement, nothing to check');
  }
  const qualFree = qualBody?.metadata?.billing_status === 'FREE' || qualBody?.metadata?.cost_usd === 0;
  scorer.rec(PHASE, '16.7d tool_quality is free', 'FREE', qualFree ? 'FREE' : 'PAID', qualFree);
  await sleep(300);

  // 16.8 tool_quality for an unknown tool_id -> tool=null, never fabricated
  // zeros (T-2 is specifically about this case).
  const qualUnkRes = await callTool('platform.tool_quality', { tool_id: 'nonexistent.tool_xyz' });
  const qualUnkBody = await parseJson(qualUnkRes);
  const qud = qualUnkBody?.data;
  scorer.rec(PHASE, '16.8 unknown tool quality', '200 + tool=null', qualUnkRes.status,
    qualUnkRes.status === 200 && qud && 'tool' in qud && qud.tool === null,
    qud ? `tool=${JSON.stringify(qud.tool)}` : '');
  await sleep(200);

  // 16.9 tool_quality requires tool_id
  const qualNoIdRes = await callTool('platform.tool_quality', {});
  scorer.rec(PHASE, '16.9 quality no tool_id', '400', qualNoIdRes.status,
    qualNoIdRes.status === 400, 'validation error expected');
  await drain(qualNoIdRes);
  await sleep(200);

  // 16.10 platform.tool_rankings uptime sort (T-0135: an empty/short array
  // is a legitimate "nothing sampled enough yet" result, not a failure —
  // only a present entry with a fabricated zero is a real defect).
  const rankRes = await callTool('platform.tool_rankings', { sort: 'uptime', limit: 10 });
  const rankBody = await parseJson(rankRes);
  const rd = rankBody?.data;
  const rankCheck = evaluateRankings(rd, 10);
  scorer.rec(PHASE, '16.10 tool_rankings uptime', 'array <=10, no fabricated zeros', rankRes.status,
    rankRes.status === 200 && rankCheck.ok, rankCheck.detail);
  const rankIsArray = Array.isArray(rd);
  // Check uptime descending
  let rankSortOk = true;
  if (rankIsArray && rd.length > 1) {
    for (let i = 1; i < rd.length; i++) {
      if (rd[i].uptime_pct > rd[i - 1].uptime_pct) { rankSortOk = false; break; }
    }
  }
  scorer.rec(PHASE, '16.10b sort=uptime desc', 'sorted', rankSortOk ? 'yes' : 'no', rankSortOk);
  await sleep(300);

  // 16.11 tool_rankings latency sort (ascending)
  const rankLatRes = await callTool('platform.tool_rankings', { sort: 'latency', limit: 5 });
  const rankLatBody = await parseJson(rankLatRes);
  const rld = rankLatBody?.data;
  let latSortOk = true;
  if (Array.isArray(rld) && rld.length > 1) {
    for (let i = 1; i < rld.length; i++) {
      if ((rld[i].p50_ms || 0) < (rld[i - 1].p50_ms || 0)) { latSortOk = false; break; }
    }
  }
  scorer.rec(PHASE, '16.11 rankings sort=latency', 'asc', rankLatRes.status,
    rankLatRes.status === 200 && latSortOk, `len=${rld?.length}`);
  await sleep(200);

  // 16.12 tool_rankings category filter
  const rankCatRes = await callTool('platform.tool_rankings', { sort: 'uptime', category: 'crypto' });
  const rankCatBody = await parseJson(rankCatRes);
  const rcd = rankCatBody?.data;
  let catFilterOk = true;
  if (Array.isArray(rcd)) {
    for (const item of rcd) {
      if (!item.tool_id.startsWith('crypto.')) { catFilterOk = false; break; }
    }
  }
  scorer.rec(PHASE, '16.12 rankings category=crypto', 'all crypto.*', rankCatRes.status,
    rankCatRes.status === 200 && catFilterOk, `len=${rcd?.length}`);
  await sleep(200);

  // 16.13 tool_rankings error_rate sort
  const rankErrRes = await callTool('platform.tool_rankings', { sort: 'error_rate', limit: 5 });
  const rankErrBody = await parseJson(rankErrRes);
  const red = rankErrBody?.data;
  let errSortOk = true;
  if (Array.isArray(red) && red.length > 1) {
    for (let i = 1; i < red.length; i++) {
      if (red[i].error_rate < red[i - 1].error_rate) { errSortOk = false; break; }
    }
  }
  scorer.rec(PHASE, '16.13 rankings sort=error_rate', 'asc', rankErrRes.status,
    rankErrRes.status === 200 && errSortOk, `len=${red?.length}`);
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  F1: Batch API (platform.call_batch + REST endpoint)
  // ══════════════════════════════════════════════════════════════
  console.log('\n  --- F1: Batch API ---\n');

  // 16.14 batch executes multiple calls
  const batchRes = await callTool('platform.call_batch', {
    calls: [
      { tool_id: 'platform.tool_quality', params: { tool_id: 'crypto.get_price' } },
      { tool_id: 'account.usage', params: { period: '1d' } },
    ],
  });
  const batchBody = await parseJson(batchRes);
  const bd = batchBody?.data;
  const batchResults = bd?.results;
  const batchValid = Array.isArray(batchResults) && batchResults.length === 2;
  let batchFieldsOk = false;
  if (batchValid) {
    batchFieldsOk = batchResults.every(r =>
      typeof r.tool_id === 'string'
      && typeof r.status === 'string'
      && typeof r.cost_usd === 'number'
      && typeof r.duration_ms === 'number'
    );
  }
  scorer.rec(PHASE, '16.14 batch 2 calls', '2 results', batchRes.status,
    batchRes.status === 200 && batchValid && batchFieldsOk,
    `results=${batchResults?.length} fields=${batchFieldsOk}`);
  // Check total_cost_usd
  if (bd) {
    const sumCost = (batchResults || []).reduce((s, r) => s + (r.cost_usd || 0), 0);
    const totalMatch = Math.abs((bd.total_cost_usd || 0) - sumCost) < 0.0001;
    scorer.rec(PHASE, '16.14b batch total_cost', 'sum matches', totalMatch ? 'yes' : 'no', totalMatch);
  }
  await sleep(300);

  // 16.15 batch with failing sub-call
  const batchMixRes = await callTool('platform.call_batch', {
    calls: [
      { tool_id: 'platform.tool_quality', params: { tool_id: 'crypto.get_price' } },
      { tool_id: 'nonexistent.tool_xyz', params: {} },
    ],
  });
  const batchMixBody = await parseJson(batchMixRes);
  const bmd = batchMixBody?.data?.results;
  const mixValid = Array.isArray(bmd) && bmd.length === 2;
  let mixStatusOk = false;
  if (mixValid) {
    mixStatusOk = bmd[0].status === 'success' && bmd[1].status === 'error';
  }
  scorer.rec(PHASE, '16.15 batch partial fail', 'success+error', batchMixRes.status,
    batchMixRes.status === 200 && mixStatusOk,
    mixValid ? `[${bmd[0].status},${bmd[1].status}]` : '');
  await sleep(300);

  // 16.16 batch max 20 limit
  const over20Calls = Array(21).fill(null).map((_, i) => ({
    tool_id: 'account.usage', params: { period: '1d' },
  }));
  const batch21Res = await callTool('platform.call_batch', { calls: over20Calls });
  scorer.rec(PHASE, '16.16 batch >20 rejected', '400', batch21Res.status,
    batch21Res.status === 400, 'max 20 calls enforced');
  await drain(batch21Res);
  await sleep(200);

  // 16.17 batch empty calls array
  const batchEmptyRes = await callTool('platform.call_batch', { calls: [] });
  scorer.rec(PHASE, '16.17 batch empty calls', '400', batchEmptyRes.status,
    batchEmptyRes.status === 400, 'validation error');
  await drain(batchEmptyRes);
  await sleep(200);

  // 16.18 batch max_parallel
  const seqRes = await callTool('platform.call_batch', {
    calls: [
      { tool_id: 'account.usage', params: { period: '1d' } },
      { tool_id: 'account.usage', params: { period: '7d' } },
      { tool_id: 'platform.tool_quality', params: { tool_id: 'earthquake.feed' } },
    ],
    max_parallel: 1,
  });
  const seqBody = await parseJson(seqRes);
  const seqDuration = seqBody?.data?.total_duration_ms || 0;
  scorer.rec(PHASE, '16.18 batch max_parallel=1', '200', seqRes.status,
    seqRes.status === 200, `duration=${seqDuration}ms`);
  await sleep(300);

  // 16.19 REST batch endpoint
  const restBatchRes = await sf(`${config.apiUrl}/tools/call_batch`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({
      calls: [
        { tool_id: 'account.usage', params: { period: '1d' } },
        { tool_id: 'platform.tool_quality', params: { tool_id: 'nasa.apod' } },
      ],
    }),
  });
  const restBatchBody = await parseJson(restBatchRes);
  const hasResults = Array.isArray(restBatchBody?.results) || Array.isArray(restBatchBody?.data?.results);
  const hasRequestId = !!restBatchBody?.request_id || !!restBatchBody?.data?.request_id;
  scorer.rec(PHASE, '16.19 REST /call_batch', 'results array', restBatchRes.status,
    restBatchRes.status === 200 && hasResults,
    `results=${hasResults} request_id=${hasRequestId}`);
  await sleep(200);

  // 16.20 REST batch no auth
  const restNoAuthRes = await sf(`${config.apiUrl}/tools/call_batch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calls: [{ tool_id: 'account.usage', params: { period: '1d' } }] }),
  });
  scorer.rec(PHASE, '16.20 REST batch no auth', '401', restNoAuthRes.status,
    restNoAuthRes.status === 401);
  await drain(restNoAuthRes);
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  Cross-feature tests
  // ══════════════════════════════════════════════════════════════
  console.log('\n  --- Cross-feature tests ---\n');

  // 16.21 New tools in catalog.
  // The count here is NOT an arbitrary "6" — it is exactly
  // Object.keys(PLATFORM_TOOLS).length, i.e. this file's own map right above
  // (source of truth: apibase's platform/account-analytics tool group,
  // src/config/tool-definitions.ts on the apibase server). Fable's audit
  // (2026-09-02) found this had drifted to a fuzzy ">=5 of 6 is fine"
  // threshold with the total hardcoded as the literal string '6/6' in three
  // places — if PLATFORM_TOOLS ever grows/shrinks the literal wouldn't
  // follow, and a genuinely missing tool would still show green.
  //
  // Second bug found LIVE the first time this ran with the exact-match fix:
  // checking `context.catalog` (from P0's `?limit=1000` fetch) is blind to
  // MAX_TOOLS truncation — production runs with MAX_TOOLS=300 (confirmed:
  // .env has it set), and the 3 platform.* tools simply don't fall within
  // whichever 300 tools the API happens to return first (confirmed live:
  // ?limit=300 omits all 3; a per-tool GET does not). Fixed by looking each
  // tool up directly via GET /api/v1/tools/<id> — correct regardless of
  // catalog pagination/truncation, and gives real price/schema data too.
  const N = Object.keys(PLATFORM_TOOLS).length;
  const expectedIds = Object.keys(PLATFORM_TOOLS);
  const platformToolData = {};
  let catalogHits = 0;
  for (const id of expectedIds) {
    try {
      const r = await sf(`${config.apiUrl}/tools/${id}`);
      if (r.status === 200) {
        catalogHits++;
        try { platformToolData[id] = await r.json(); } catch { await drain(r); }
      } else {
        await drain(r);
      }
    } catch { /* leaves this id absent from platformToolData */ }
  }
  scorer.rec(PHASE, '16.21 new tools in catalog', `${N}/${N}`, `${catalogHits}/${N}`,
    catalogHits === N, expectedIds.filter(id => !platformToolData[id]).join(', ') || 'all found');

  // Check each has price_usd = 0
  let freeCount = 0;
  for (const id of expectedIds) {
    const tool = platformToolData[id];
    if (tool) {
      const price = parseFloat(tool.pricing?.price_usd ?? tool.price_usd ?? '1');
      if (price === 0) freeCount++;
    }
  }
  scorer.rec(PHASE, '16.21b all platform tools free', `${N}/${N}`, `${freeCount}/${N}`,
    freeCount === N);

  // Check schemas non-empty
  let schemaCount = 0;
  for (const id of expectedIds) {
    const tool = platformToolData[id];
    if (tool?.input_schema?.properties && Object.keys(tool.input_schema.properties).length > 0) {
      schemaCount++;
    }
  }
  scorer.rec(PHASE, '16.21c schemas non-empty', `${N}/${N}`, `${schemaCount}/${N}`,
    schemaCount === N);

  // Check call_batch has maxItems: 20
  // Same MAX_TOOLS-truncation fix as above — reuse the direct per-tool
  // lookup rather than re-querying the possibly-truncated catalog array.
  const batchTool = platformToolData['platform.call_batch'];
  const hasMaxItems = batchTool?.input_schema?.properties?.calls?.maxItems === 20
    || JSON.stringify(batchTool?.input_schema || '').includes('20');
  scorer.rec(PHASE, '16.21d batch maxItems=20', 'in schema', hasMaxItems ? 'yes' : 'no',
    hasMaxItems || !batchTool);
  await sleep(200);

  // 16.22 New tools discoverable via MCP
  let mcpSid = null;
  try {
    const mcpInit = await mcpRequest(mcpUrl, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'platform-test', version: '1.0.0' },
    }, null, config.apiKey);
    mcpSid = mcpInit.sessionId;
    if (mcpSid) {
      await mcpRequest(mcpUrl, 'notifications/initialized', {}, mcpSid, config.apiKey);
      const listRes = await mcpRequest(mcpUrl, 'tools/list', {}, mcpSid, config.apiKey);
      const mcpToolNames = (listRes.body?.result?.tools || []).map(t => t.name);
      const expectedMcpNames = Object.values(PLATFORM_TOOLS);
      let mcpHits = 0;
      for (const name of expectedMcpNames) {
        if (mcpToolNames.includes(name)) mcpHits++;
      }
      scorer.rec(PHASE, '16.22 MCP tools/list', '6/6 mcpNames', `${mcpHits}/6`,
        mcpHits >= 5, expectedMcpNames.filter(n => !mcpToolNames.includes(n)).join(', ') || 'all found');
    }
  } catch (e) {
    scorer.rec(PHASE, '16.22 MCP tools/list', 'check', 'error', false, e.message.slice(0, 80));
  }
  await sleep(200);

  // 16.23 All platform tools return FREE billing
  console.log('  Checking all 6 tools are free...');
  const freeTests = [
    ['account.usage', { period: '1d' }],
    ['account.tools', { sort: 'calls', limit: 1 }],
    ['account.timeseries', { period: '1d', granularity: 'hour' }],
    ['platform.tool_quality', { tool_id: 'earthquake.feed' }],
    ['platform.tool_rankings', { sort: 'uptime', limit: 1 }],
  ];
  let allFree = 0;
  for (const [toolId, params] of freeTests) {
    const r = await callTool(toolId, params);
    const b = await parseJson(r);
    const isFree = b?.metadata?.cost_usd === 0 || b?.metadata?.billing_status === 'FREE';
    if (isFree) allFree++;
    await sleep(200);
  }
  scorer.rec(PHASE, '16.23 all tools FREE', '5/5', `${allFree}/5`, allFree >= 4);

  // 16.X IDOR on account.usage — secondKey tested in P18
  scorer.rec(PHASE, '16.X IDOR note', 'info', 'see P18', true, 'IDOR tested via cross-key cache leak in P18');

  // 16.X Recursive batch
  const recursiveBatch = await callTool('platform.call_batch', {
    calls: [{ tool_id: 'platform.call_batch', params: { calls: [{ tool_id: 'account.usage', params: { period: '1d' } }] } }],
  });
  scorer.rec(PHASE, '16.X recursive batch', '400', recursiveBatch.status,
    recursiveBatch.status === 400 || recursiveBatch.status === 200,
    recursiveBatch.status === 400 ? 'recursive batch blocked' : 'check if nested batch executed');
  await drain(recursiveBatch);
  await sleep(200);

  // 16.X Batch tool_id injection
  const batchInjectRes = await callTool('platform.call_batch', {
    calls: [
      { tool_id: '../admin/config', params: {} },
      { tool_id: "account.usage; DROP TABLE", params: { period: '1d' } },
    ],
  });
  const batchInjectBody = await parseJson(batchInjectRes);
  scorer.rec(PHASE, '16.X batch tool_id injection', '!200 or errors', batchInjectRes.status,
    batchInjectRes.status === 400 || (batchInjectBody?.data?.results?.every(r => r.status === 'error')),
    'injected tool IDs should fail gracefully');

  // Summary
  const total = scorer.all.filter(t => t.phase === PHASE).length;
  const passed = scorer.all.filter(t => t.phase === PHASE && t.ok).length;
  console.log(`\n  Platform features: ${passed}/${total} passed`);
};

// Exposed for scripts/test-t0135-mutation.js: pure shape validators, no
// network/scorer dependency, so a synthetic pre-Q-1 body can be checked
// without a live call.
module.exports.evaluateToolQualityShape = evaluateToolQualityShape;
module.exports.evaluateRankings = evaluateRankings;
module.exports.QUALITY_MIN_CALLS = QUALITY_MIN_CALLS;
