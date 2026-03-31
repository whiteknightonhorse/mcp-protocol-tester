/**
 * Phase 12 — Provider Health Map
 * Tests one tool per provider to build a health map.
 * Tracks status (HEALTHY/DOWN/RATE_LIMITED) and latency.
 */
const { sf, drain, getDelay } = require('../lib/http');
const { getBody, shouldSkip } = require('../utils/assert');

const PHASE = 'P12';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async function phase12(scorer, config, context) {
  console.log('\n== PHASE 12: PROVIDER HEALTH MAP ==\n');

  // Group tools by provider, pick first non-skipped tool per provider
  const providerMap = {};
  for (const tool of context.catalog) {
    const prov = (tool.id || tool.name).split('.')[0];
    if (!providerMap[prov] && !shouldSkip(tool.id || tool.name)) {
      providerMap[prov] = tool;
    }
  }

  const providers = Object.entries(providerMap).sort(([a], [b]) => a.localeCompare(b));
  console.log(`  Testing ${providers.length} providers (1 tool each)\n`);

  const healthMap = [];
  const AUTH = { 'Content-Type': 'application/json' };
  if (config.apiKey) AUTH['Authorization'] = `Bearer ${config.apiKey}`;

  for (const [prov, tool] of providers) {
    const id = tool.id || tool.name;
    const body = getBody(tool);
    const start = Date.now();
    let r = await sf(`${config.apiUrl}/tools/${id}/call`, {
      method: 'POST', headers: AUTH, body: JSON.stringify(body),
    });
    let ms = Date.now() - start;

    // Retry on 429
    if (r.status === 429) {
      await drain(r);
      await sleep(10000);
      const s2 = Date.now();
      r = await sf(`${config.apiUrl}/tools/${id}/call`, {
        method: 'POST', headers: AUTH, body: JSON.stringify(body),
      });
      ms = Date.now() - s2;
    }

    const st = r.status;
    let status;
    if (st === 200 || st === 402 || st === 400) status = 'HEALTHY';
    else if (st === 503 || st === 502) status = 'DOWN';
    else if (st === 429) status = 'RATE_LIMITED';
    else status = 'UNKNOWN';

    healthMap.push({ provider: prov, tool: id, status, httpStatus: st, latency: ms });

    const ok = st === 200 || st === 402 || st === 400 || st === 503 || st === 502;
    scorer.recQ(PHASE, `12 ${prov}`, '200|402|4xx|5xx', st, ok, `${ms}ms ${status}`);
    await drain(r);
    await sleep(getDelay(id));
  }

  // Summary
  const healthy = healthMap.filter(h => h.status === 'HEALTHY').length;
  const down = healthMap.filter(h => h.status === 'DOWN').length;
  const limited = healthMap.filter(h => h.status === 'RATE_LIMITED').length;
  const pct = providers.length > 0 ? Math.round(healthy / providers.length * 100) : 0;

  scorer.rec(PHASE, '12 Provider health', '>50%', `${pct}%`,
    pct > 50, `${healthy} healthy, ${down} down, ${limited} rate_limited of ${providers.length}`);

  console.log(`\n  Providers: ${providers.length} | Healthy: ${healthy} (${pct}%) | Down: ${down} | Rate limited: ${limited}`);

  // Store for report
  context.healthMap = healthMap;

  // P12.X Provider error sanitization
  const downProviders = healthMap.filter(h => h.status === 'DOWN');
  if (downProviders.length > 0) {
    const downTool = downProviders[0].tool;
    const errRes = await sf(`${config.apiUrl}/tools/${downTool}/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    let errBody = ''; try { errBody = await errRes.text(); } catch {}
    const leaksInternal = errBody.includes('/app/') || errBody.includes('node_modules') ||
      errBody.includes('PROVIDER_KEY') || errBody.includes('api_key');
    scorer.rec(PHASE, '12.X provider error sanitized', 'no internals', leaksInternal ? 'LEAKED' : 'clean',
      !leaksInternal, leaksInternal ? 'provider error leaks internal details!' : 'errors sanitized');
  }
};
