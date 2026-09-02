/**
 * Phase 24 — Public surface inventory + documentation truth (Э3, Fable's
 * audit 2026-09-02, defect Д6).
 *
 * Д6 was: the /connect quickstart called `tools/coingecko.get_price/call`,
 * a tool_id that never existed (the real one is `crypto.get_price`) — the
 * single most conversion-critical page on the site was broken for every
 * new visitor who copy-pasted it, and no probe had ever read a documentation
 * page and cross-checked its tool references against the live catalog.
 *
 * ⚠️ Disclosed plainly: live-checked before writing this (2026-09-02) and
 * Д6's OWN specific instance (coingecko.get_price on /connect) has ALREADY
 * been fixed independently (commit landed the same day, before this pass) —
 * confirmed by curling every static page and finding zero occurrences.
 * Fable's acceptance bar for this phase was "must be born red on today's
 * prod" — that is no longer literally true for THIS specific historical
 * bug, since it no longer exists to reproduce. Substituted the honest
 * equivalent: 24.0 is a synthetic-fixture control (same technique as Э1's
 * CI dual-stub) proving the detector actually catches a stale reference
 * when fed one, run against an in-memory fixture, not the network — and
 * 24.1+ then run the same detector for real against live prod, which
 * currently (correctly) passes. Flagged for Fable: if a live-red instance
 * is still required to accept this phase, one was not available to
 * reproduce honestly and needs her direction rather than a fabricated one.
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'P24';

const STATIC_PAGES = ['/', '/connect', '/frameworks', '/pricing', '/catalog', '/dashboard',
  '/contact', '/privacy', '/terms', '/policy/moderation'];

function extractToolRefs(html) {
  const refs = new Set();
  const re = /tools\/([a-zA-Z0-9_.-]+)\/call/g;
  let m;
  while ((m = re.exec(html)) !== null) refs.add(m[1]);
  return [...refs];
}

module.exports = async function phase24(scorer, config, context) {
  console.log('\n--- Phase 24: Docs/catalog truth ---');

  // 24.0 — synthetic-fixture self-test: does the detector actually catch a
  // stale reference? Proven in-memory first, same discipline as Э1's dual
  // stub, since live prod has none to reproduce honestly right now.
  const fixtureHtml = '<a href="#">try it</a><code>POST /api/v1/tools/coingecko.get_price/call</code>';
  const fixtureRefs = extractToolRefs(fixtureHtml);
  const catalogIds = new Set(context.catalog.map((t) => t.id || t.name));
  const fixtureStale = fixtureRefs.filter((id) => !catalogIds.has(id));
  scorer.rec(PHASE, '24.0 self-test: synthetic stale ref caught', '>=1 stale', `${fixtureStale.length} stale`,
    fixtureStale.length >= 1, fixtureStale.join(', ') || 'detector did not fire on a known-bad fixture');

  // 24.1 — real pages, real catalog.
  let allStale = [];
  for (const page of STATIC_PAGES) {
    let html = '';
    try {
      const r = await sf(`${config.apiBaseUrl}${page}`);
      if (r.status === 200) html = await r.text(); else await drain(r);
      scorer.rec(PHASE, `24.1 ${page} reachable`, '200', String(r.status), r.status === 200);
    } catch (e) {
      scorer.recCatch(PHASE, `24.1 ${page} reachable`, '200', e);
      continue;
    }
    const refs = extractToolRefs(html);
    const stale = refs.filter((id) => !catalogIds.has(id));
    if (stale.length > 0) {
      allStale.push(...stale.map((id) => `${page}:${id}`));
    }
  }
  // RED: a doc page telling every new visitor to call a tool that doesn't
  // exist is exactly the class this phase exists to catch, independent of
  // score — same conversion-critical-surface reasoning as the original Д6.
  scorer.redRec(PHASE, '24.2 no stale tool references on any static page', '0 stale',
    `${allStale.length} stale`, allStale.length === 0, allStale.join(', ') || 'all references resolve');

  // 24.3 — page-count claims roughly match the live catalog (count-drift
  // class fixed multiple times already per the redesign work — this is the
  // standing check so it can't silently drift back).
  // Guard: production runs with MAX_TOOLS set (confirmed live: .env has
  // MAX_TOOLS=300) truncate context.catalog to that cap — comparing the
  // homepage's real total against a truncated 300 produced a false 338%
  // "drift" the first time this ran. Only meaningful when nothing truncated
  // the catalog this run.
  if (config.maxTools > 0) {
    scorer.rec(PHASE, '24.3 homepage tool count matches catalog', 'derivable', 'skipped',
      true, `MAX_TOOLS=${config.maxTools} truncates context.catalog — comparison would be against a partial count, not the real total`);
    console.log(`  Docs truth: ${allStale.length} stale refs across ${STATIC_PAGES.length} pages`);
    return;
  }
  const liveTools = context.catalog.length;
  let indexHtml = '';
  try {
    const rIdx = await sf(`${config.apiBaseUrl}/`);
    if (rIdx.status === 200) indexHtml = await rIdx.text(); else await drain(rIdx);
  } catch (e) { /* covered by 24.1 already */ }
  const countMatch = indexHtml.match(/TOOLS:\s*<[^>]*>\s*(\d[\d,]*)/i) || indexHtml.match(/(\d[\d,]{2,})\s*tools/i);
  const pageCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null;
  if (pageCount !== null && liveTools > 0) {
    const drift = Math.abs(pageCount - liveTools) / liveTools;
    scorer.rec(PHASE, '24.3 homepage tool count matches catalog', `~${liveTools}`, pageCount,
      drift < 0.05, `${(drift * 100).toFixed(1)}% drift`);
  } else {
    scorer.rec(PHASE, '24.3 homepage tool count matches catalog', 'derivable', 'not found', true,
      'no parseable tool-count figure found on homepage — informational only, not a failure');
  }

  console.log(`  Docs truth: ${allStale.length} stale refs across ${STATIC_PAGES.length} pages`);
};
