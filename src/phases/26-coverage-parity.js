/**
 * Phase 26 — Coverage parity (Э3, Fable's audit 2026-09-02).
 *
 * The audit's own diagnosis of the missing meta-class: "prod grew
 * (moderation, devices, balance rail, public pages) and nothing in the
 * tester goes red when a new, unprobed surface appears." This phase is
 * that meta-class, made concrete: read the REAL nginx location list off
 * the same box apibase runs on (this tester already lives on
 * apibase@5.78.135.159 alongside it — this is not reaching into a third
 * party's infrastructure) and diff it against PROBED_PREFIXES, a
 * hand-maintained list of what this whole test suite actually exercises.
 * A new nginx location with no matching prefix here is a real, currently
 * unprobed public surface — exactly the shape of how P0-P19 missed
 * /connect/device/vendors and /appeals/:id before Э3 added them.
 *
 * Control (proven below, not just asserted): a synthetic fake route
 * spliced into the parsed location list must fail this check; the real
 * list (today) must pass it once every real location has a probed prefix.
 */
const fs = require('fs');
const { sf, drain } = require('../lib/http');

const PHASE = 'P26';
const NGINX_CONF = '/home/apibase/apibase/nginx/nginx.conf';

// Every route prefix some phase in this suite actually sends a request to.
// Keep this in sync when a new phase is added — that IS the parity contract.
const PROBED_PREFIXES = [
  '/api/v1/tools', '/api/v1/agents', '/mcp', '/sse', '/messages',
  '/.well-known/', '/health', '/oauth/', '/connect', '/appeals', '/api/v1/appeals',
  '/pricing', '/catalog', '/dashboard', '/contact', '/privacy', '/terms',
  '/policy/moderation', '/frameworks', '/x402/',
  // Fable's classification of the 13 gaps found in the first live run
  // (2026-09-02 follow-up), decision rule: "can a wrong answer here cost
  // money, leak data, or mislead a machine consumer? Yes -> real probe."
  // These 4 carry real logic/money/machine-contract meaning — real
  // assertions below (26.2), not just an allow-list entry.
  '/api', '/api/v1', '/onboard', '/openapi.json',
];
// The bare root '/' can only ever be an EXACT match — treating it as a
// startsWith() prefix would trivially match every route on earth (every
// path starts with '/'), which is exactly the false-green shape this whole
// phase exists to catch elsewhere. Caught live: a synthetic unprobed route
// silently passed until this was split out.
const PROBED_EXACT = new Set(['/']);

// Two DIFFERENT kinds of "not a real gap", kept separate and each with its
// own evidence, rather than one catch-all allow-list (LAW: allow-list what
// you inspect — an exemption needs a reason on file, not just a shorter
// failure list):
//  - NOT_PUBLIC: confirmed by reading nginx.conf directly, not assumed —
//    /stub_status lives on a SEPARATE listener (port 8080) with an
//    allow/deny IP restriction; this parser reads the whole file and can't
//    yet tell server{} blocks apart, so it would otherwise misreport an
//    internal, firewalled metrics endpoint as unprobed public surface.
//  - STATIC_ASSET: pure branding files with zero request-handling logic —
//    a probe here would test nginx's static-file serving, not this
//    project's own code, which is what every other probed prefix is for.
const NOT_PUBLIC = new Set(['/stub_status']);

// Public files a HUMAN reads, not our logic/money/machine-contract — a
// wrong answer here is cheap (Fable's rule, tier 2: not a real probe, but
// not a blind exemption either — one liveness assertion each, 26.3 below).
// Was .png/.svg/.ico/favicon only; the first live run miscounted
// robots.txt/ai.txt/llms.txt/sitemap.xml/video/ as "unprobed" purely
// because this regex never covered their extensions.
const STATIC_ASSET_RE = /\.(png|svg|ico|txt|xml)$|^\/favicon|^\/video\//;

// Genuinely unreachable as public surface, confirmed 404 on direct GET
// (nginx's own default error page, not even a custom one) — these are
// referenced only by nginx's internal error_page directive, never served
// directly. Kept separate from NOT_PUBLIC (a live, IP-restricted listener)
// on purpose: same shape ("not a real gap"), different evidence, so each
// exemption's reason stays legible instead of merging into one vague list.
const ERROR_DOC = new Set(['/502.json', '/503.json', '/504.json', '/50x.json']);

function isProbed(route) {
  if (PROBED_EXACT.has(route)) return true;
  if (NOT_PUBLIC.has(route)) return true;
  if (ERROR_DOC.has(route)) return true;
  if (STATIC_ASSET_RE.test(route)) return true;
  return PROBED_PREFIXES.some((p) => route === p || route.startsWith(p));
}

function parseNginxLocations(conf) {
  // Matches `location /path {` and `location = /path {` (ignores regex
  // locations `location ~ ...` — those are provider-specific, not part of
  // the public route surface this parity check is about).
  const re = /location\s+(?:=\s+)?(\/[^\s{]*)\s*\{/g;
  const routes = new Set();
  let m;
  while ((m = re.exec(conf)) !== null) routes.add(m[1]);
  return [...routes];
}

module.exports = async function phase26(scorer, config, context) {
  console.log('\n--- Phase 26: Coverage parity ---');

  // 26.0 — control: a synthetic unprobed route must be caught.
  const fixtureRoutes = ['/api/v1/tools', '/totally-new-surface-nobody-probes'];
  const fixtureUnprobed = fixtureRoutes.filter((r) => !isProbed(r));
  scorer.rec(PHASE, '26.0 self-test: synthetic unprobed route caught', '>=1', `${fixtureUnprobed.length}`,
    fixtureUnprobed.length >= 1, fixtureUnprobed.join(', ') || 'control did not fire');

  let conf = '';
  try {
    conf = fs.readFileSync(NGINX_CONF, 'utf-8');
  } catch (e) {
    scorer.skip(PHASE, `cannot read ${NGINX_CONF} (${e.code || e.message}) — this box's file layout ` +
      'changed, or this tester no longer runs alongside apibase; adjust NGINX_CONF');
    return;
  }

  const liveRoutes = parseNginxLocations(conf);
  const unprobed = liveRoutes.filter((r) => !isProbed(r));

  // RED: this is the audit's named missing meta-class, made into a gate —
  // a new public surface with zero probe coverage is a real risk, not a
  // point deduction.
  scorer.redRec(PHASE, '26.1 every public nginx location has a probed prefix', '0 unprobed',
    `${unprobed.length} unprobed`, unprobed.length === 0,
    unprobed.length > 0 ? `add coverage for: ${unprobed.join(', ')}` : `${liveRoutes.length} locations, all covered`);

  // 26.2 — real probes for the 4 routes Fable's classification named as
  // carrying our own logic, money, or a machine-readable contract (a wrong
  // answer here is not cheap). These are what make the PROBED_PREFIXES
  // entries above honest rather than a bare allow-list.
  const realProbes = [
    { path: '/api', expectStatus: [402], expectJson: true },
    { path: '/api/v1', expectStatus: [402], expectJson: true },
    { path: '/onboard', expectStatus: [200], expectJson: true },
    { path: '/openapi.json', expectStatus: [200], expectJson: true },
  ];
  for (const probe of realProbes) {
    try {
      const r = await sf(`${config.apiBaseUrl}${probe.path}`);
      const statusOk = probe.expectStatus.includes(r.status);
      const ct = r.headers?.get?.('content-type') || '';
      const jsonOk = !probe.expectJson || ct.includes('json');
      await drain(r);
      scorer.rec(PHASE, `26.2 ${probe.path}`, `${probe.expectStatus.join('|')} json`,
        `${r.status} ${ct.split(';')[0]}`, statusOk && jsonOk,
        statusOk && jsonOk ? 'ok' : 'unexpected status or content-type for a real-logic/machine-contract route');
    } catch (e) {
      scorer.recCatch(PHASE, `26.2 ${probe.path}`, `${probe.expectStatus.join('|')} json`, e);
    }
  }

  // 26.3 — liveness only for public files a human reads, not our logic
  // (Fable's tier 2: cheap, free, still measured — not a blind exemption).
  // 200 + a real content-type + non-empty body; content truth-checking
  // (matching ai.txt/llms.txt claims against the live catalog) is
  // deliberately NOT here — if the operator wants that, it moves to P24.
  const livenessRoutes = ['/robots.txt', '/ai.txt', '/llms.txt', '/sitemap.xml', '/video/'];
  for (const path of livenessRoutes) {
    try {
      const r = await sf(`${config.apiBaseUrl}${path}`);
      const ct = r.headers?.get?.('content-type') || '';
      const body = await (async () => { try { return await r.text(); } catch { return ''; } })();
      const ok = r.status === 200 && ct.length > 0 && body.length > 0;
      scorer.rec(PHASE, `26.3 ${path} liveness`, '200 + content-type + non-empty',
        `${r.status} ${ct.split(';')[0]} ${body.length}b`, ok);
    } catch (e) {
      scorer.recCatch(PHASE, `26.3 ${path} liveness`, '200 + non-empty', e);
    }
  }

  console.log(`  Coverage parity: ${liveRoutes.length} nginx locations, ${unprobed.length} unprobed`);
};
