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

const PHASE = 'P26';
const NGINX_CONF = '/home/apibase/apibase/nginx/nginx.conf';

// Every route prefix some phase in this suite actually sends a request to.
// Keep this in sync when a new phase is added — that IS the parity contract.
const PROBED_PREFIXES = [
  '/api/v1/tools', '/api/v1/agents', '/mcp', '/sse', '/messages',
  '/.well-known/', '/health', '/oauth/', '/connect', '/appeals', '/api/v1/appeals',
  '/pricing', '/catalog', '/dashboard', '/contact', '/privacy', '/terms',
  '/policy/moderation', '/frameworks', '/x402/',
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
const STATIC_ASSET_RE = /\.(png|svg|ico)$|^\/favicon/;

function isProbed(route) {
  if (PROBED_EXACT.has(route)) return true;
  if (NOT_PUBLIC.has(route)) return true;
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

  console.log(`  Coverage parity: ${liveRoutes.length} nginx locations, ${unprobed.length} unprobed`);
};
