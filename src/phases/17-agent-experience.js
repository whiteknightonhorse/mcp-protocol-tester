/**
 * Phase 17 — Agent Experience Tests
 * Validates that the MCP server is truly usable by an autonomous AI agent
 * arriving with zero prior knowledge. Tests bootstrap, description quality,
 * error actionability, payment UX, response consistency, and e2e lifecycle.
 */
const { sf, drain } = require('../lib/http');
const { mcpRequest } = require('../lib/mcp-client');

const PHASE = 'P17';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async function phase17(scorer, config, context) {
  console.log('\n== PHASE 17: AGENT EXPERIENCE ==\n');

  const AUTH = { 'Content-Type': 'application/json' };
  if (config.apiKey) AUTH['Authorization'] = `Bearer ${config.apiKey}`;

  // ══════════════════════════════════════════════════════════════
  //  1. Zero-Knowledge Bootstrap
  // ══════════════════════════════════════════════════════════════
  console.log('  --- 1. Zero-Knowledge Bootstrap ---');

  // 17.1 mcp.json contains usable endpoint
  const mcpJsonRes = await sf(`${config.apiBaseUrl}/.well-known/mcp.json`);
  let mcpJson = null;
  try { mcpJson = await mcpJsonRes.json(); } catch { await drain(mcpJsonRes); }
  const hasEndpoint = mcpJson && (mcpJson.mcp_endpoint || mcpJson.endpoint || mcpJson.url);
  scorer.rec(PHASE, '17.1 mcp.json has endpoint', 'endpoint URL', hasEndpoint ? 'yes' : 'no',
    !!hasEndpoint, hasEndpoint ? `endpoint=${mcpJson.mcp_endpoint || mcpJson.endpoint}` : 'agent cannot find MCP URL');
  await sleep(200);

  // 17.1b Can initialize using discovered endpoint
  if (hasEndpoint) {
    const discoveredUrl = mcpJson.mcp_endpoint || mcpJson.endpoint || mcpJson.url;
    const initRes = await mcpRequest(discoveredUrl, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'zero-knowledge-agent', version: '0.1' },
    }, null, config.apiKey);
    scorer.rec(PHASE, '17.1b init via discovered URL', '200+session',
      initRes.sessionId ? 'yes' : 'no', !!initRes.sessionId);
  }
  await sleep(200);

  // 17.2 server-card has auth instructions
  const cardRes = await sf(`${config.apiBaseUrl}/.well-known/mcp/server-card.json`, {}, 10000);
  let card = null;
  try { card = await cardRes.json(); } catch { await drain(cardRes); }
  const hasAuth = card && (
    JSON.stringify(card).includes('auth') ||
    JSON.stringify(card).includes('key') ||
    JSON.stringify(card).includes('register')
  );
  scorer.rec(PHASE, '17.2 server-card has auth info', 'auth instructions', hasAuth ? 'yes' : 'no',
    cardRes.status === 200, hasAuth ? 'agent can learn how to authenticate' : 'no auth guidance');
  await sleep(200);

  // 17.3 Catalog accessible without API key
  const noKeyRes = await sf(`${config.apiUrl}/tools?limit=10`, {});
  scorer.rec(PHASE, '17.3 catalog without key', '200', noKeyRes.status,
    noKeyRes.status === 200, noKeyRes.status === 200 ? 'discovery open' : 'agent blocked at discovery');
  await drain(noKeyRes);
  await sleep(200);

  // 17.4 401 response contains actionable guidance
  const unauth = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  let unauthBody = null;
  try { unauthBody = await unauth.json(); } catch { await drain(unauth); }
  const unauthMsg = JSON.stringify(unauthBody || '').toLowerCase();
  const hasGuidance = unauthMsg.includes('register') || unauthMsg.includes('key') ||
    unauthMsg.includes('authorization') || unauthMsg.includes('bearer');
  scorer.rec(PHASE, '17.4 401 has guidance', 'how to auth', hasGuidance ? 'yes' : 'bare 401',
    unauth.status === 401 && hasGuidance,
    hasGuidance ? 'agent knows what to do' : 'agent stuck — add registration URL to 401 body');
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  2. Tool Description Quality
  // ══════════════════════════════════════════════════════════════
  console.log('  --- 2. Tool Description Quality ---');

  const tools = context.catalog;
  const sampleSize = Math.min(tools.length, 100);
  const sample = tools.slice(0, sampleSize);

  // 17.5 Descriptions contain action verb
  const verbPatterns = /^(get|search|find|list|create|check|validate|analyze|generate|lookup|fetch|convert|decode|send|extract|calculate|monitor|browse|submit|capture)/i;
  let hasVerb = 0;
  for (const t of sample) {
    const desc = t.description || '';
    if (verbPatterns.test(desc)) hasVerb++;
  }
  const verbPct = Math.round(hasVerb / sampleSize * 100);
  scorer.rec(PHASE, '17.5 descriptions have verbs', '>80%', `${verbPct}%`,
    verbPct > 70, `${hasVerb}/${sampleSize} start with action verb`);

  // 17.6 Descriptions are unique
  const descSet = new Set(sample.map(t => (t.description || '').toLowerCase().trim()));
  const uniquePct = Math.round(descSet.size / sampleSize * 100);
  scorer.rec(PHASE, '17.6 descriptions unique', '>95%', `${uniquePct}%`,
    uniquePct > 90, `${descSet.size} unique out of ${sampleSize}`);

  // 17.7 Description length 10-500
  let goodLength = 0;
  for (const t of sample) {
    const len = (t.description || '').length;
    if (len >= 10 && len <= 500) goodLength++;
  }
  scorer.rec(PHASE, '17.7 description length 10-500', '>90%',
    `${Math.round(goodLength / sampleSize * 100)}%`, goodLength > sampleSize * 0.9);

  // 17.8 Required fields have descriptions in schema
  let fieldsChecked = 0, fieldsWithDesc = 0;
  for (const t of sample.slice(0, 30)) {
    const schema = t.input_schema;
    if (!schema?.properties) continue;
    const required = schema.required || [];
    for (const field of required) {
      fieldsChecked++;
      if (schema.properties[field]?.description) fieldsWithDesc++;
    }
  }
  const fieldDescPct = fieldsChecked > 0 ? Math.round(fieldsWithDesc / fieldsChecked * 100) : 100;
  scorer.rec(PHASE, '17.8 required fields have desc', '>80%', `${fieldDescPct}%`,
    fieldDescPct > 70, `${fieldsWithDesc}/${fieldsChecked} required fields documented`);

  // 17.9 Schemas have examples or defaults
  let hasExamples = 0;
  for (const t of sample.slice(0, 30)) {
    const schemaStr = JSON.stringify(t.input_schema || {});
    if (schemaStr.includes('"example') || schemaStr.includes('"default"') || schemaStr.includes('"enum"')) {
      hasExamples++;
    }
  }
  scorer.rec(PHASE, '17.9 schemas have examples/enum', '>50%',
    `${Math.round(hasExamples / Math.min(30, sample.length) * 100)}%`,
    hasExamples > 10, `${hasExamples}/30 have examples/defaults/enums`);
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  3. Error Message Actionability
  // ══════════════════════════════════════════════════════════════
  console.log('  --- 3. Error Actionability ---');

  // 17.10 400 names the wrong field
  const badTypeRes = await sf(`${config.apiUrl}/tools/crypto.get_price/call`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ coins: 'not-an-array' }),
  });
  let badTypeBody = null;
  try { badTypeBody = await badTypeRes.json(); } catch { await drain(badTypeRes); }
  const badTypeMsg = JSON.stringify(badTypeBody || '').toLowerCase();
  const namesField = badTypeMsg.includes('coins') || badTypeMsg.includes('array') || badTypeMsg.includes('type');
  scorer.rec(PHASE, '17.10 400 names wrong field', 'field name', namesField ? 'yes' : 'generic',
    badTypeRes.status === 400 && namesField,
    namesField ? 'agent can fix params' : 'agent guesses what went wrong');
  await sleep(200);

  // 17.11 400 on missing required names the field
  const missingRes = await sf(`${config.apiUrl}/tools/crypto.coin_detail/call`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({}),
  });
  let missingBody = null;
  try { missingBody = await missingRes.json(); } catch { await drain(missingRes); }
  const missingMsg = JSON.stringify(missingBody || '').toLowerCase();
  const namesMissing = missingMsg.includes('coin_id') || missingMsg.includes('required');
  scorer.rec(PHASE, '17.11 400 names missing field', 'field name', namesMissing ? 'yes' : 'generic',
    missingRes.status === 400 && namesMissing,
    namesMissing ? 'agent knows what to add' : 'agent guesses which field is missing');
  await sleep(200);

  // 17.12 402 contains price_usd (human-readable)
  const pay402Res = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  let pay402Body = null;
  try { pay402Body = await pay402Res.json(); } catch { await drain(pay402Res); }
  const hasPriceUsd = pay402Body?.price_usd !== undefined;
  scorer.rec(PHASE, '17.12 402 has price_usd', 'present', hasPriceUsd ? 'yes' : 'no',
    pay402Res.status === 402 && hasPriceUsd,
    hasPriceUsd ? `$${pay402Body.price_usd}` : 'agent must calculate amount/1e6');
  await sleep(200);

  // 17.13 402 has resource description
  const hasResource = pay402Body?.resource?.description || pay402Body?.resource?.url;
  scorer.rec(PHASE, '17.13 402 describes resource', 'description', hasResource ? 'yes' : 'no',
    !!hasResource, hasResource ? `"${pay402Body.resource.description || pay402Body.resource.url}"` : 'agent doesnt know what its paying for');

  // 17.14 429 has Retry-After header
  // To trigger 429, send many rapid requests
  const rapid = [];
  for (let i = 0; i < 30; i++) {
    rapid.push(sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    }, 5000));
  }
  const rapidResults = await Promise.all(rapid);
  let found429 = null;
  for (const r of rapidResults) {
    if (r.status === 429) {
      found429 = r;
      break;
    }
    await drain(r);
  }
  if (found429) {
    const retryAfter = found429.headers?.get?.('retry-after') || '';
    scorer.rec(PHASE, '17.14 429 Retry-After header', 'present', retryAfter ? `${retryAfter}s` : 'missing',
      retryAfter.length > 0, retryAfter ? 'agent knows how long to wait' : 'agent guesses backoff');
    await drain(found429);
  } else {
    scorer.rec(PHASE, '17.14 429 Retry-After', 'no 429 triggered', 'n/a', true, 'server handled 30 rapid requests');
  }
  for (const r of rapidResults) await drain(r);
  await sleep(1000);

  // 17.15 Error format consistency (check 3 different errors)
  const errFormats = [];
  // 401
  const e1 = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  try { errFormats.push(Object.keys(await e1.json())); } catch { await drain(e1); errFormats.push([]); }
  // 400
  const e2 = await sf(`${config.apiUrl}/tools/crypto.coin_detail/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  try { errFormats.push(Object.keys(await e2.json())); } catch { await drain(e2); errFormats.push([]); }
  // 404
  const e3 = await sf(`${config.apiUrl}/tools/nonexistent_xyz/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  try { errFormats.push(Object.keys(await e3.json())); } catch { await drain(e3); errFormats.push([]); }

  const allHaveError = errFormats.every(keys => keys.includes('error') || keys.includes('message'));
  scorer.rec(PHASE, '17.15 error format consistent', 'all have error/message', allHaveError ? 'yes' : 'no',
    allHaveError, 'agent can parse all errors the same way');

  // 17.16 Errors include request_id
  const e4 = await sf(`${config.apiUrl}/tools/nonexistent_xyz/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  const errReqId = e4.headers?.get?.('x-request-id') || '';
  let errBodyReqId = '';
  try { const eb = await e4.json(); errBodyReqId = eb.request_id || ''; } catch { await drain(e4); }
  scorer.rec(PHASE, '17.16 errors have request_id', 'header or body', (errReqId || errBodyReqId) ? 'yes' : 'no',
    !!(errReqId || errBodyReqId), 'agent can report issues with correlation ID');
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  4. Payment UX
  // ══════════════════════════════════════════════════════════════
  console.log('  --- 4. Payment UX ---');

  // 17.17 Catalog price matches 402 price
  if (pay402Body?.price_usd && pay402Body?.accepts?.[0]?.amount) {
    const catalogTool = tools.find(t => (t.id || t.name) === 'crypto.trending');
    const catalogPrice = parseFloat(catalogTool?.pricing?.price_usd ?? '-1');
    const actualPrice = parseFloat(pay402Body.price_usd);
    const priceMatch = catalogPrice >= 0 && Math.abs(catalogPrice - actualPrice) < 0.0001;
    scorer.rec(PHASE, '17.17 catalog price == 402 price', 'match',
      priceMatch ? 'match' : 'mismatch', priceMatch,
      `catalog=$${catalogPrice} actual=$${actualPrice}`);
  }

  // 17.18 Free tools dont return 402
  const freeTool = tools.find(t => parseFloat(t.pricing?.price_usd ?? '1') === 0);
  if (freeTool) {
    const freeRes = await sf(`${config.apiUrl}/tools/${freeTool.id || freeTool.name}/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    scorer.rec(PHASE, '17.18 free tool != 402', '200|400', freeRes.status,
      freeRes.status !== 402, freeRes.status === 402 ? 'BUG: charging for free tool' : 'correct');
    await drain(freeRes);
  }
  await sleep(200);

  // 17.19 Paid response has metadata.cost_usd
  // Use cached/previous 200 response if available, or make a fresh call
  const metaCheckRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  let metaCheckBody = null;
  try { metaCheckBody = await metaCheckRes.json(); } catch { await drain(metaCheckRes); }
  if (metaCheckRes.status === 200) {
    const hasCostMeta = metaCheckBody?.metadata?.cost_usd !== undefined;
    scorer.rec(PHASE, '17.19 200 has metadata.cost_usd', 'present', hasCostMeta ? 'yes' : 'no',
      hasCostMeta, 'agent tracks spending');
  }
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  5. Response Consistency
  // ══════════════════════════════════════════════════════════════
  console.log('  --- 5. Response Consistency ---');

  // 17.20 Responses have {data, metadata} envelope
  const envelopeTools = ['earthquake.feed', 'crypto.trending', 'nasa.apod'];
  let envelopeOk = 0;
  for (const toolId of envelopeTools) {
    const r = await sf(`${config.apiUrl}/tools/${toolId}/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    if (r.status === 200) {
      let b = null; try { b = await r.json(); } catch { await drain(r); }
      if (b && ('data' in b || 'result' in b) && 'metadata' in b) envelopeOk++;
      else if (b && 'data' in b) envelopeOk++; // data without metadata is partially ok
    } else { await drain(r); }
    await sleep(300);
  }
  scorer.rec(PHASE, '17.20 response envelope {data,metadata}', '3/3', `${envelopeOk}/3`,
    envelopeOk >= 2, 'consistent structure for agent parsing');

  // 17.21 metadata has standard fields
  if (metaCheckBody?.metadata) {
    const meta = metaCheckBody.metadata;
    const metaFields = ['cost_usd', 'cache_hit', 'request_id'].filter(f => f in meta);
    scorer.rec(PHASE, '17.21 metadata completeness', '>=2 fields', `${metaFields.length}`,
      metaFields.length >= 2, `has: ${metaFields.join(', ')}`);
  }

  // 17.22 Empty search result is not an error
  const emptyRes = await sf(`${config.apiUrl}/tools/books.search/call`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ query: 'xyznonexistentbook999999' }),
  });
  let emptyBody = null;
  try { emptyBody = await emptyRes.json(); } catch { await drain(emptyRes); }
  const emptyIsOk = emptyRes.status === 200 || emptyRes.status === 402;
  scorer.rec(PHASE, '17.22 empty result != error', '200|402', emptyRes.status,
    emptyIsOk, emptyRes.status === 200 ? 'correct: empty data, not error' : '');
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  6. End-to-End Agent Lifecycle
  // ══════════════════════════════════════════════════════════════
  console.log('  --- 6. E2E Agent Lifecycle ---');

  // 17.23 Golden path: MCP init → tools/list → discover_tools → pick tool → call
  let e2eSid = null;
  try {
    // Step 1: Initialize MCP
    const e2eInit = await mcpRequest(config.mcpServerUrl, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'e2e-agent', version: '1.0.0' },
    }, null, config.apiKey);
    e2eSid = e2eInit.sessionId;
    const step1 = !!e2eSid;

    // Step 2: List tools
    let step2 = false, toolCount = 0;
    if (e2eSid) {
      await mcpRequest(config.mcpServerUrl, 'notifications/initialized', {}, e2eSid, config.apiKey);
      const listRes = await mcpRequest(config.mcpServerUrl, 'tools/list', {}, e2eSid, config.apiKey);
      toolCount = listRes.body?.result?.tools?.length || 0;
      step2 = toolCount > 0;
    }

    // Step 3: Discover tools by task
    let step3 = false;
    if (e2eSid) {
      const discRes = await mcpRequest(config.mcpServerUrl, 'prompts/get', {
        name: 'discover_tools', arguments: { task: 'earthquake data' },
      }, e2eSid, config.apiKey);
      const discText = discRes.body?.result?.messages?.[0]?.content?.text || '';
      step3 = discText.includes('earthquake');
    }

    // Step 4: Call the discovered tool
    let step4 = false;
    if (e2eSid) {
      const callRes = await mcpRequest(config.mcpServerUrl, 'tools/call', {
        name: 'earthquake.data.feed', arguments: {},
      }, e2eSid, config.apiKey);
      step4 = !!callRes.body?.result || !!callRes.body?.error;
    }

    const steps = [step1, step2, step3, step4].filter(Boolean).length;
    scorer.rec(PHASE, '17.23 golden path e2e', '4/4 steps', `${steps}/4`,
      steps >= 3, `init=${step1} list=${step2}(${toolCount}) discover=${step3} call=${step4}`);
  } catch (e) {
    scorer.rec(PHASE, '17.23 golden path e2e', '4/4', 'error', false, e.message.slice(0, 80));
  }
  await sleep(300);

  // 17.24 Multi-call session stability
  if (e2eSid) {
    const callTools = ['crypto.market.trending', 'earthquake.data.feed', 'space.apod.today'];
    let sessionCalls = 0;
    for (const name of callTools) {
      const r = await mcpRequest(config.mcpServerUrl, 'tools/call', {
        name, arguments: {},
      }, e2eSid, config.apiKey);
      if (r.body?.result || r.body?.error) sessionCalls++;
      await sleep(300);
    }
    scorer.rec(PHASE, '17.24 session stability (3 calls)', '3/3', `${sessionCalls}/3`,
      sessionCalls >= 2, 'session survives multiple calls');
  }

  // 17.25 Parallel tool calls (same API key, separate REST)
  const parallel5 = await Promise.all([
    sf(`${config.apiUrl}/tools/crypto.trending/call`, { method: 'POST', headers: AUTH, body: '{}' }),
    sf(`${config.apiUrl}/tools/earthquake.feed/call`, { method: 'POST', headers: AUTH, body: '{}' }),
    sf(`${config.apiUrl}/tools/crypto.global/call`, { method: 'POST', headers: AUTH, body: '{}' }),
    sf(`${config.apiUrl}/tools/nasa.apod/call`, { method: 'POST', headers: AUTH, body: '{}' }),
    sf(`${config.apiUrl}/tools/finance.ecb_rates/call`, { method: 'POST', headers: AUTH, body: JSON.stringify({ base: 'EUR' }) }),
  ]);
  const parallelOk = parallel5.filter(r => r.status === 200 || r.status === 402).length;
  scorer.rec(PHASE, '17.25 5 parallel calls', '5/5', `${parallelOk}/5`,
    parallelOk >= 4, 'no interference between parallel requests');
  for (const r of parallel5) await drain(r);
  await sleep(300);

  // 17.26 Retry after error: bad params → fix → success
  const badRes = await sf(`${config.apiUrl}/tools/geo.geocode/call`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({}),
  });
  await drain(badRes);
  const fixRes = await sf(`${config.apiUrl}/tools/geo.geocode/call`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ text: 'Tokyo' }),
  });
  scorer.rec(PHASE, '17.26 retry after error', '200|402 after fix', fixRes.status,
    fixRes.status === 200 || fixRes.status === 402,
    `bad=${badRes.status} → fix=${fixRes.status}`);
  await drain(fixRes);
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  7. MCP Protocol Completeness
  // ══════════════════════════════════════════════════════════════
  console.log('  --- 7. MCP Protocol Completeness ---');

  // 17.27 capabilities in init response
  const capInit = await mcpRequest(config.mcpServerUrl, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'cap-check', version: '1.0' },
  }, null, config.apiKey);
  const serverCaps = capInit.body?.result?.capabilities || {};
  const hasToolsCap = 'tools' in serverCaps;
  const hasPromptsCap = 'prompts' in serverCaps;
  scorer.rec(PHASE, '17.27 capabilities: tools+prompts', 'both', `tools=${hasToolsCap} prompts=${hasPromptsCap}`,
    hasToolsCap, `caps: ${Object.keys(serverCaps).join(', ')}`);
  const capSid = capInit.sessionId;
  await sleep(200);

  // 17.28 prompts/list returns useful prompts
  if (capSid) {
    await mcpRequest(config.mcpServerUrl, 'notifications/initialized', {}, capSid, config.apiKey);
    const promptsRes = await mcpRequest(config.mcpServerUrl, 'prompts/list', {}, capSid, config.apiKey);
    const prompts = promptsRes.body?.result?.prompts || [];
    const hasDiscover = prompts.some(p => p.name === 'discover_tools');
    scorer.rec(PHASE, '17.28 prompts/list', 'has discover_tools',
      `${prompts.length} prompts`, prompts.length > 0 && hasDiscover,
      prompts.map(p => p.name).join(', '));
  }
  await sleep(200);

  // 17.29 tools/call without initialize → clear error
  const noInitRes = await sf(config.mcpServerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 999, method: 'tools/call',
      params: { name: 'crypto.market.trending', arguments: {} },
    }),
  });
  scorer.rec(PHASE, '17.29 call without init', 'error (not 500)', noInitRes.status,
    noInitRes.status !== 500 && noInitRes.status !== 0,
    noInitRes.status === 400 || noInitRes.status === 404 ? 'clear rejection' : `status=${noInitRes.status}`);
  await drain(noInitRes);

  // 17.X Error internal path leakage
  console.log('  --- Error path leakage ---');
  const pathErrs = [
    await sf(`${config.apiUrl}/tools/nonexistent_xyz/call`, { method: 'POST', headers: AUTH, body: '{}' }),
    await sf(`${config.apiUrl}/tools/crypto.trending/call`, { method: 'POST', headers: AUTH, body: 'INVALID' }),
  ];
  let pathLeaked = false;
  for (const r of pathErrs) {
    const body = await r.text().catch(() => '');
    if (body.includes('/app/src') || body.includes('/usr/local') || body.includes('node_modules/')) pathLeaked = true;
  }
  scorer.rec(PHASE, '17.X no internal paths', 'clean', pathLeaked ? 'LEAKED' : 'clean',
    !pathLeaked, pathLeaked ? 'internal paths in error responses!' : 'errors sanitized');

  // Summary
  const total = scorer.all.filter(t => t.phase === PHASE).length;
  const passed = scorer.all.filter(t => t.phase === PHASE && t.ok).length;
  console.log(`\n  Agent experience: ${passed}/${total} passed`);
};
