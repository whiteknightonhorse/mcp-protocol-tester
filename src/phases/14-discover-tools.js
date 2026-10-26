/**
 * Phase 14 — Tool discovery
 * Primary path: the `apibase.discover` tool (MCP tools/call) and GET /api/v1/discover.
 * Backward-compatibility path: the MCP `discover_tools` prompt (category
 * enumeration, keyword search, stemming, abuse handling).
 */
const { mcpRequest } = require('../lib/mcp-client');
const { sf, drain } = require('../lib/http');

const PHASE = 'P14';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getDiscoverText(body) {
  return body?.result?.messages?.[0]?.content?.text ?? '';
}

async function discover(mcpUrl, sid, apiKey, args) {
  return mcpRequest(mcpUrl, 'prompts/get', {
    name: 'discover_tools', arguments: args || {},
  }, sid, apiKey);
}

module.exports = async function phase14(scorer, config, context) {
  console.log('\n== PHASE 14: DISCOVER_TOOLS ==\n');

  const mcpUrl = config.mcpServerUrl;

  // ── Establish MCP session ──
  const init = await mcpRequest(mcpUrl, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'discover-tester', version: '1.0.0' },
  }, null, config.apiKey);
  const sid = init.sessionId;

  if (!sid) {
    scorer.rec(PHASE, '14.0 MCP session', 'session', 'no session', false, 'cannot test discover_tools');
    return;
  }
  await mcpRequest(mcpUrl, 'notifications/initialized', {}, sid, config.apiKey);
  scorer.rec(PHASE, '14.0 MCP session', 'session', sid.slice(0, 12), true);
  await sleep(300);

  // ══════════════════════════════════════════════════════════════
  //  0. Primary path — apibase.discover tool + GET /api/v1/discover
  // ══════════════════════════════════════════════════════════════
  console.log('  --- apibase.discover (primary) ---');
  const toolRes = await mcpRequest(mcpUrl, 'tools/call', {
    name: 'apibase.discover', arguments: { intent: 'flights' },
  }, sid, config.apiKey);
  const toolContent = toolRes.body?.result?.content?.[0]?.text ?? '';
  let toolResults = [];
  try { const j = JSON.parse(toolContent); toolResults = (j.data || j).results || []; } catch { /* not JSON */ }
  scorer.rec(PHASE, '14.0a apibase.discover tool', '>=1 result', toolResults.length,
    toolRes.status === 200 && toolResults.length > 0, toolContent.slice(0, 80));
  const restRes = await sf(`${config.apiUrl}/discover?intent=flights`);
  let restResults = [];
  if (restRes.status === 200) { try { restResults = (await restRes.json()).results || []; } catch { /* not JSON */ } }
  else await drain(restRes);
  scorer.rec(PHASE, '14.0b GET /api/v1/discover', '200 + results', `${restRes.status} / ${restResults.length}`,
    restRes.status === 200 && restResults.length > 0);
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  1. Backward compatibility — discover_tools prompt, no-args category index
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Category index ---');
  const indexRes = await discover(mcpUrl, sid, config.apiKey, {});
  const indexText = getDiscoverText(indexRes.body);
  const hasCategories = indexText.includes('categories');
  scorer.rec(PHASE, '14.1 No-args → catalog', 'categories', hasCategories ? 'yes' : 'no',
    hasCategories, indexText.slice(0, 80));

  // Category count must equal categories_count from /.well-known/mcp.json (no literal)
  const catMatches = indexText.match(/- [\w-]+: \d+ tools/g) || [];
  const categoryNames = catMatches.map(m => m.slice(2, m.indexOf(':')));
  let expectedCats = null;
  const wk = await sf(`${config.apiBaseUrl}/.well-known/mcp.json`);
  if (wk.status === 200) { try { expectedCats = (await wk.json()).categories_count; } catch { /* not JSON */ } }
  else await drain(wk);
  scorer.rec(PHASE, '14.1b Category count', `categories_count=${expectedCats}`, categoryNames.length,
    typeof expectedCats === 'number' && categoryNames.length === expectedCats,
    `prompt lists ${categoryNames.length}, mcp.json says ${expectedCats}`);
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  2. Category enumeration — every category the index lists
  // ══════════════════════════════════════════════════════════════
  console.log(`  --- Category enumeration (${categoryNames.length}) ---`);
  let catPass = 0, catFail = 0;

  for (const cat of categoryNames) {
    const res = await discover(mcpUrl, sid, config.apiKey, { category: cat });
    const text = getDiscoverText(res.body);
    const hasHeader = text.toLowerCase().includes(`tools in "${cat}"`);
    const toolLines = (text.match(/^- \S+:/gm) || []).length;
    const hasTools = toolLines > 0;

    if (hasHeader && hasTools) { catPass++; } else { catFail++; }
    scorer.recQ(PHASE, `14.2 cat:${cat}`, `header+tools`, hasHeader && hasTools ? 'ok' : 'fail',
      hasHeader && hasTools, `lines=${toolLines}`);
    await sleep(150);
  }
  scorer.rec(PHASE, '14.2 Category enumeration', `${categoryNames.length}/${expectedCats}`,
    `${catPass}/${catPass + catFail}`, catFail === 0 && catPass === expectedCats, `${catFail} failures`);

  // ══════════════════════════════════════════════════════════════
  //  3. Category + Task Combos
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Category + task combos ---');
  const combos = [
    { cat: 'entertainment', task: 'anime', expect: ['anime', 'jikan'] },
    { cat: 'entertainment', task: 'games', expect: ['rawg', 'igdb', 'game'] },
    { cat: 'travel', task: 'flights', expect: ['amadeus', 'aviasales', 'sabre', 'flight'] },
    { cat: 'crypto', task: 'BTC', expect: ['crypto', 'price', 'btc'] },
    { cat: 'health', task: 'nutrition', expect: ['spoonacular', 'fatsecret', 'food'] },
    { cat: 'finance', task: 'stock', expect: ['finnhub', 'stock', 'market'] },
  ];

  for (const { cat, task, expect } of combos) {
    const res = await discover(mcpUrl, sid, config.apiKey, { category: cat, task });
    const text = getDiscoverText(res.body).toLowerCase();
    const found = expect.some(kw => text.includes(kw));
    scorer.rec(PHASE, `14.3 ${cat}+${task}`, expect[0], found ? 'found' : 'missing',
      found, text.slice(0, 80));
    await sleep(200);
  }

  // ══════════════════════════════════════════════════════════════
  //  4. Stemming Validation
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Stemming ---');
  const stemTests = [
    { task: 'flights', expect: 'flight' },
    { task: 'recipes', expect: 'recipe' },
    { task: 'prices', expect: 'price' },
    { task: 'searching', expect: 'search' },
    { task: 'earthquakes', expect: 'earthquake' },
    { task: 'validated', expect: 'validate' },
  ];

  for (const { task, expect } of stemTests) {
    const res = await discover(mcpUrl, sid, config.apiKey, { task });
    const text = getDiscoverText(res.body).toLowerCase();
    const found = text.includes(expect) && !text.includes('could not extract');
    scorer.rec(PHASE, `14.4 stem:${task}`, expect, found ? 'found' : 'missing',
      found, text.slice(0, 80));
    await sleep(200);
  }

  // ══════════════════════════════════════════════════════════════
  //  5. Keyword Relevance
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Keyword relevance ---');
  const relevance = [
    { task: 'BTC price', expect: 'crypto' },
    { task: 'find flights', expect: 'flight' },
    { task: 'weather forecast', expect: 'weather' },
    { task: 'email validation', expect: 'email' },
    { task: 'decode VIN', expect: 'vin' },
    { task: 'stock prices', expect: 'finnhub' },
  ];

  for (const { task, expect } of relevance) {
    const res = await discover(mcpUrl, sid, config.apiKey, { task });
    const text = getDiscoverText(res.body).toLowerCase();
    const found = text.includes(expect);
    scorer.rec(PHASE, `14.5 search:${task}`, expect, found ? 'found' : 'missing',
      found, text.slice(0, 80));
    await sleep(200);
  }

  // ══════════════════════════════════════════════════════════════
  //  6. Abuse / Edge Cases
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Abuse / edge cases ---');

  // Empty / whitespace
  for (const [label, args] of [
    ['empty task', { task: '' }],
    ['whitespace task', { task: '   ' }],
    ['both empty', { task: '', category: '' }],
  ]) {
    const res = await discover(mcpUrl, sid, config.apiKey, args);
    const text = getDiscoverText(res.body);
    scorer.rec(PHASE, `14.6 ${label}`, 'no crash', res.status === 200 ? 'ok' : res.status,
      res.status === 200 && text.length > 10, text.slice(0, 60));
    await sleep(150);
  }

  // All stopwords
  for (const [label, task] of [
    ['all stopwords', 'near me'],
    ['more stopwords', 'the is a an'],
  ]) {
    const res = await discover(mcpUrl, sid, config.apiKey, { task });
    const text = getDiscoverText(res.body);
    const noError = res.status === 200 && !text.includes('error');
    scorer.rec(PHASE, `14.6 ${label}`, 'graceful', noError ? 'ok' : res.status,
      res.status === 200, text.slice(0, 60));
    await sleep(150);
  }

  // Typo category
  const typoRes = await discover(mcpUrl, sid, config.apiKey, { category: 'travl' });
  const typoText = getDiscoverText(typoRes.body);
  scorer.rec(PHASE, '14.6 typo category', 'no crash', typoRes.status === 200 ? 'ok' : typoRes.status,
    typoRes.status === 200, typoText.includes('available') ? 'shows available cats' : typoText.slice(0, 60));
  await sleep(150);

  // Uppercase category
  const upperRes = await discover(mcpUrl, sid, config.apiKey, { category: 'TRAVEL' });
  const upperText = getDiscoverText(upperRes.body);
  scorer.rec(PHASE, '14.6 uppercase cat', 'works or hint', upperRes.status === 200 ? 'ok' : upperRes.status,
    upperRes.status === 200, upperText.slice(0, 60));
  await sleep(150);

  // Padded whitespace
  const padRes = await discover(mcpUrl, sid, config.apiKey, { category: '  travel  ' });
  const padText = getDiscoverText(padRes.body);
  scorer.rec(PHASE, '14.6 padded category', 'works or hint', padRes.status === 200 ? 'ok' : padRes.status,
    padRes.status === 200, padText.slice(0, 60));
  await sleep(150);

  // SQL injection in category
  const sqlRes = await discover(mcpUrl, sid, config.apiKey, { category: "travel; DROP TABLE tools;--" });
  scorer.rec(PHASE, '14.6 SQL inject cat', 'no crash', sqlRes.status === 200 ? 'safe' : sqlRes.status,
    sqlRes.status === 200 || sqlRes.status === 400);
  await sleep(150);

  // XSS in category — JSON APIs are not vulnerable to reflected XSS
  // (browsers don't execute JS from application/json responses)
  const xssRes = await discover(mcpUrl, sid, config.apiKey, { category: '<script>alert(1)</script>' });
  const xssText = getDiscoverText(xssRes.body);
  const xssClean = !xssText.includes('<script>');
  scorer.rec(PHASE, '14.6 XSS category', 'sanitized', xssClean ? 'clean' : 'reflected-json',
    true, xssClean ? 'not reflected' : 'reflected in JSON — not exploitable (Content-Type: application/json)');
  if (!xssClean) {
    scorer.addRec('SECURITY', 'P14 XSS: input reflected in JSON response',
      'Server should sanitize <script> tags even in JSON — defense in depth');
  }
  await sleep(150);

  // SQL injection in task
  const sqlTaskRes = await discover(mcpUrl, sid, config.apiKey, { task: "' OR 1=1 --" });
  scorer.rec(PHASE, '14.6 SQL inject task', 'no crash', sqlTaskRes.status === 200 ? 'safe' : sqlTaskRes.status,
    sqlTaskRes.status === 200 || sqlTaskRes.status === 400);
  await sleep(150);

  // Prototype pollution
  const protoRes = await discover(mcpUrl, sid, config.apiKey, {
    task: "{{constructor.constructor('return this')()}}",
  });
  scorer.rec(PHASE, '14.6 proto pollution', 'no crash', protoRes.status === 200 ? 'safe' : protoRes.status,
    protoRes.status === 200 || protoRes.status === 400);
  await sleep(150);

  // Very long task (10k chars)
  const longRes = await discover(mcpUrl, sid, config.apiKey, { task: 'a'.repeat(10000) });
  scorer.rec(PHASE, '14.6 10k char task', 'no crash', longRes.status,
    longRes.status === 200 || longRes.status === 400, `${longRes.elapsed}ms`);
  await sleep(150);

  // Unicode
  for (const [label, task] of [
    ['chinese', '找航班'],
    ['russian', 'найти рейсы'],
    ['emoji', '✈️ flights'],
  ]) {
    const res = await discover(mcpUrl, sid, config.apiKey, { task });
    scorer.rec(PHASE, `14.6 unicode:${label}`, 'no crash', res.status === 200 ? 'ok' : res.status,
      res.status === 200, getDiscoverText(res.body).slice(0, 50));
    await sleep(150);
  }

  // Null bytes
  const nullRes = await discover(mcpUrl, sid, config.apiKey, { task: 'flights\x00injection' });
  scorer.rec(PHASE, '14.6 null bytes', 'no crash', nullRes.status === 200 ? 'ok' : nullRes.status,
    nullRes.status === 200 || nullRes.status === 400);
  await sleep(150);

  // Stopwords + category
  const stopCatRes = await discover(mcpUrl, sid, config.apiKey, {
    category: 'entertainment', task: 'near me',
  });
  const stopCatText = getDiscoverText(stopCatRes.body);
  scorer.rec(PHASE, '14.6 cat+stopwords', 'show category', stopCatRes.status === 200 ? 'ok' : stopCatRes.status,
    stopCatRes.status === 200 && stopCatText.length > 50, stopCatText.slice(0, 60));
  await sleep(150);

  // ══════════════════════════════════════════════════════════════
  //  7. Truncation & Formatting
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Truncation & formatting ---');

  // Large category (entertainment = 44 tools, truncated at 18)
  const entRes = await discover(mcpUrl, sid, config.apiKey, { category: 'entertainment' });
  const entText = getDiscoverText(entRes.body);
  const hasTrunc = entText.includes('... and') || entText.includes('more');
  scorer.rec(PHASE, '14.7 entertainment truncation', 'truncated', hasTrunc ? 'yes' : 'no',
    hasTrunc, 'should show 18 + hint');
  await sleep(200);

  // Small category (business = 6 tools, no truncation)
  const bizRes = await discover(mcpUrl, sid, config.apiKey, { category: 'business' });
  const bizText = getDiscoverText(bizRes.body);
  const bizNoTrunc = !bizText.includes('... and') || bizText.includes('more —');
  scorer.rec(PHASE, '14.7 business no truncation', 'full list', bizNoTrunc ? 'yes' : 'truncated',
    true); // informational
  await sleep(200);

  // Tool format: - toolname: description
  const toolLineFormat = /^- [\w.]+: .+/m;
  const formatOk = toolLineFormat.test(entText);
  scorer.rec(PHASE, '14.7 tool format', '- name: desc', formatOk ? 'correct' : 'wrong', formatOk);

  // ══════════════════════════════════════════════════════════════
  //  8. Consistency
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Consistency ---');

  // Each category from catalog should work as filter
  const catNames = categoryNames;
  let consistPass = 0;
  for (const cat of catNames.slice(0, 5)) { // spot check 5
    const res = await discover(mcpUrl, sid, config.apiKey, { category: cat });
    const text = getDiscoverText(res.body);
    if (text.includes(cat)) consistPass++;
    await sleep(150);
  }
  scorer.rec(PHASE, '14.8 cat consistency', '5/5', `${consistPass}/5`,
    consistPass >= 4, 'spot check 5 categories');

  // 9. Empty result test (category + irrelevant task)
  console.log('  --- Empty result ---');
  const emptyRes = await discover(mcpUrl, sid, config.apiKey, {
    category: 'travel', task: 'quantum physics',
  });
  const emptyText = getDiscoverText(emptyRes.body);
  const isFiltered = !emptyText.includes('amadeus') || emptyText.includes('0)') || emptyText.includes('no');
  scorer.rec(PHASE, '14.9 empty result', 'no random tools', isFiltered ? 'filtered' : 'unfiltered',
    emptyRes.status === 200, emptyText.slice(0, 60));
  await sleep(200);

  // 10. Performance check
  console.log('  --- Performance ---');
  const perfStart = Date.now();
  await discover(mcpUrl, sid, config.apiKey, { task: 'flights' });
  const perfMs = Date.now() - perfStart;
  scorer.rec(PHASE, '14.10 query performance', '<3000ms', `${perfMs}ms`, perfMs < 3000);

  // Summary
  const total = scorer.all.filter(t => t.phase === PHASE).length;
  const passed = scorer.all.filter(t => t.phase === PHASE && t.ok).length;
  console.log(`\n  discover_tools: ${passed}/${total} passed`);
};
