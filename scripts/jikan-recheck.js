#!/usr/bin/env node
/**
 * T-0127 — free, direct re-check of jikan's live search-fetch path.
 *
 * `anime.search`'s paid probes (P5|mpp-pay-anime.search, P6|x402-pay-anime.search
 * in reports/standing-reds.json) have been standing-red since 2026-09-07 for a
 * proven EXTERNAL reason (T-0111, 4 attempts): jikan-me/jikan-rest#612, a
 * continuous MyAnimeList-connectivity outage on jikan's own side, open since
 * 2026-08-28, independently reproduced by unrelated third parties. There is no
 * client-side fix — see the class-level doc comment on `src/adapters/jikan/index.ts`
 * in the apibase-fleet repo for the full mechanism and evidence trail.
 *
 * This script exists so that external-blocker fact doesn't just sit there
 * staling silently forever with an UNASSIGNED owner. Once a day it makes ONE
 * FREE, direct call straight to api.jikan.moe — `q=naruto&limit=2` (>1, so it
 * still exercises the live-MAL-fetch path real search traffic needs, not the
 * `limit=1` cache-luck path T-0111 already ruled out as any kind of fix; small
 * enough to be cheap on jikan's own rate budget). It NEVER goes through our own
 * paid gateway (x402/mpp cost real USDC per call) — this check must cost $0.
 *
 * - 200  -> jikan's search path may be back. Does NOT touch the ledger's
 *   first_seen/last_seen or delete the entry (only run-daily.sh's real paid
 *   probe is the source of truth for that) — it flags the owner annotation
 *   for human re-verification instead of waiting silently for tomorrow's
 *   report to notice on its own. This is the "тревога оживает" step.
 * - anything else -> still broken. Refreshes the annotation's "last confirmed
 *   still-red" date in reports/jikan-recheck.json — the place this fact goes
 *   to go stale: if this script (or its cron) ever stops running, that
 *   timestamp stops advancing and that absence is the tell.
 *
 * Deliberately does NOT change `anime.search`'s own default `limit` (would
 * silently truncate a real caller's request — T-0111 attempt 1's boundary)
 * and does NOT remove/mute the paid probes themselves.
 *
 * Usage: node scripts/jikan-recheck.js
 * Exit code is always 0 — this is informational annotation, not a test
 * assertion; run-daily.sh's own paid-probe ledger remains the real verdict.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const RECHECK_PATH = path.join(REPO_ROOT, 'reports', 'jikan-recheck.json');
const VERDICT_RUNNER = path.join(__dirname, 'verdict-runner.js');
const LEDGER_PATH = path.join(REPO_ROOT, 'reports', 'standing-reds.json');
const ISSUE_REF = 'https://github.com/jikan-me/jikan-rest/issues/612';
const PROBE_URL = 'https://api.jikan.moe/v4/anime?q=naruto&limit=2';
const SIGS = ['P5|mpp-pay-anime.search', 'P6|x402-pay-anime.search'];

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8')); }
  catch { return {}; }
}

async function probe() {
  try {
    const res = await fetch(PROBE_URL, { signal: AbortSignal.timeout(15000) });
    const ok = res.status === 200;
    return { http_status: res.status, ok, note: ok ? 'live search-fetch path responded 200' : `still failing (HTTP ${res.status})` };
  } catch (err) {
    return { http_status: null, ok: false, note: `network error: ${err.message}` };
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { http_status, ok, note } = await probe();

  const record = { checked_at: new Date().toISOString(), url: PROBE_URL, http_status, ok, note };
  fs.writeFileSync(RECHECK_PATH, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  console.log(`[jikan-recheck] ${record.checked_at} status=${http_status} ok=${ok} — ${note}`);

  const ledger = loadLedger();
  for (const sig of SIGS) {
    if (!ledger[sig]) {
      console.log(`[jikan-recheck] ${sig} not in ledger (already resolved or never red) — nothing to annotate`);
      continue;
    }
    const ownerText = ok
      ? `POSSIBLY RECOVERED ${today} — free direct api.jikan.moe limit=2 returned 200 (reports/jikan-recheck.json). Re-verify against the real paid probe before closing; do not treat this free check alone as proof (ref ${ISSUE_REF}, T-0111/T-0127).`
      : `external blocker: ${ISSUE_REF} (jikan-rest MyAnimeList-connectivity outage since 2026-08-28, root cause proven T-0111, documented in src/adapters/jikan/index.ts on apibase-fleet). Not our bug, no client-side fix exists. Free daily direct recheck last confirmed still-red ${today} (reports/jikan-recheck.json). Owner: T-0127.`;
    execFileSync('node', [VERDICT_RUNNER, '--set-owner', sig, ownerText], { cwd: REPO_ROOT, stdio: 'inherit' });
  }
}

main();
