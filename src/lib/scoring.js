const { isDeadServerError } = require('./net-error');

// Sanitize any string before logging — removes secrets, tokens, keys, long JSON
function sanitize(str) {
  // NOTE: the original check here was `if (!str) return ''` — that treats the
  // *number* 0 as "nothing to sanitize" and silently erases it into an empty
  // string. A real HTTP status is never 0 (see http.js's sf() timeout
  // sentinel), so a timed-out request's status used to disappear from every
  // report as a blank `got` field instead of showing what actually happened
  // (Fable's audit: "P18 websocket/chunked — пустые exp/got"). Only treat
  // genuinely absent values (undefined/null/empty string) as "nothing".
  if (str === undefined || str === null || str === '') return '';
  return String(str)
    .replace(/0x[a-fA-F0-9]{40,}/g, '0x[REDACTED]')       // wallet addresses
    .replace(/ak_live_[a-f0-9]+/gi, 'ak_[REDACTED]')       // API keys
    .replace(/ak_test_[a-f0-9]+/gi, 'ak_[REDACTED]')       // test API keys
    .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_[REDACTED]')        // GitHub tokens
    .replace(/Bearer [^\s"]+/g, 'Bearer [REDACTED]')        // Bearer tokens
    .replace(/Payment [^\s"]+/g, 'Payment [REDACTED]')      // MPP credentials
    .replace(/"(password|secret|token|key)":\s*"[^"]+"/gi, '"$1":"[REDACTED]"')
    .slice(0, 200); // cap length to prevent log flooding
}

// A phase is skipped for a reason ("no PRIVATE_KEY", "no staging configured",
// etc.) — legitimate, but a run where too much of the corpus went unexercised
// is not a trustworthy PASS either ("a control must state its world"). This
// default can be overridden per run via computeVerdict()'s options.
const DEFAULT_MAX_SKIPPED_PHASES = 6;

class Scorer {
  constructor() {
    this.pass = [];
    this.fail = [];
    this.all = [];
    this.errors = [];
    this.recommendations = [];
    this.skippedPhases = new Set(); // phases skipped (not counted in score)
    this.skipReasons = {}; // phase -> reason, so a skip always states its world
  }

  // Mark entire phase as SKIP (not counted in score denominator)
  skip(phase, reason = '') {
    this.skippedPhases.add(phase);
    this.skipReasons[phase] = reason;
    process.stdout.write(`  [SKIP] ${phase} — ${reason}\n`);
  }

  rec(phase, name, exp, got, ok, det = '') {
    // A literal -1 can only come from sf()'s dead-server/timeout sentinel
    // (src/lib/http.js) — no real HTTP status is ever -1, and (checked via
    // grep) no call site ever passes -1 as a count/length either, unlike 0
    // which collides with legitimate "0 internal tools found" style counts.
    // Many call sites across the phases only check "!== 500" (or similar) as
    // their whole pass condition, which a dead/timed-out response trivially
    // satisfies — that is exactly how Fable's audit found "a dead server
    // scores green". Intercepting here, once, in the single chokepoint every
    // phase already calls, fixes every such site without having to hunt down
    // and rewrite each one's own condition.
    if (got === -1 || got === '-1') { got = 'TIMEOUT'; ok = false; }
    const safeGot = sanitize(got);
    const safeDet = sanitize(det);
    const entry = { phase, name, exp: String(exp).slice(0, 100), got: safeGot, ok, det: safeDet };
    this.all.push(entry);
    ok ? this.pass.push(entry) : this.fail.push(entry);
    // Only log test name and pass/fail status — sensitive data is sanitized
    const icon = ok ? 'OK' : '!!';
    const detStr = safeDet ? ' | ' + safeDet.slice(0, 100) : '';
    process.stdout.write(`  [${icon} ] ${name} — ${safeGot.slice(0, 80)}${detStr}\n`);
    return entry;
  }

  recQ(phase, name, exp, got, ok, det = '') {
    if (got === -1 || got === '-1') { got = 'TIMEOUT'; ok = false; }
    const entry = { phase, name, exp: String(exp).slice(0, 100), got: sanitize(got), ok, det: sanitize(det) };
    this.all.push(entry);
    ok ? this.pass.push(entry) : this.fail.push(entry);
    return entry;
  }

  // Same as rec(), but marks the assertion RED-class: if it fails, the whole
  // run's verdict is FAIL regardless of score (Э1 — money e2e / crash /
  // public-404 / catalog-sanity probes use this). Never use this for a probe
  // whose semantics Fable hasn't signed off as RED (see the boundary rules —
  // reclassifying an EXISTING probe's severity needs her sign-off; this is
  // only for probes this pass adds specifically as RED-class checks, plus
  // the two catalog-sanity checks in P0 documented at their call site).
  redRec(phase, name, exp, got, ok, det = '') {
    const entry = this.rec(phase, name, exp, got, ok, det);
    entry.red = true;
    return entry;
  }

  // Use inside a try/catch instead of hand-writing `true` for "the exception
  // means the server correctly rejected this at the transport level" — that
  // assumption is only true if the exception ISN'T a dead-server/timeout
  // symptom. See net-error.js. `exp`/`det` behave like rec()'s.
  recCatch(phase, name, exp, e, det = '') {
    const dead = isDeadServerError(e);
    const detail = det || (e && e.message) || '';
    return this.rec(phase, name, exp, dead ? 'TIMEOUT' : 'error', !dead, detail);
  }

  addError(sev, phase, title, detail, fix) {
    this.errors.push({ sev, phase, title, detail, fix });
  }

  addRec(cat, title, detail) {
    this.recommendations.push({ cat, title, detail });
  }

  computeGrade(weights) {
    const bp = {};
    for (const t of this.all) {
      if (!bp[t.phase]) bp[t.phase] = { pass: 0, total: 0 };
      bp[t.phase].total++;
      if (t.ok) bp[t.phase].pass++;
    }
    const pr = (id) => {
      if (this.skippedPhases.has(id)) return -1; // -1 = skipped
      const p = bp[id];
      if (!p || p.total === 0) return 0;
      return Math.min(1, p.pass / p.total);
    };
    // Skipped phases: earned=0, max=0 (excluded from denominator)
    const pts = weights.map(([id, wt]) => {
      const ratio = pr(id);
      if (ratio === -1) return [id, 0, 0, 'SKIP']; // skipped
      return [id, Math.round(ratio * wt), wt, null];
    });
    const earnedTotal = pts.reduce((s, [, v]) => s + v, 0);
    const maxTotal = pts.reduce((s, [,, mx]) => s + mx, 0);
    // Score as percentage of achievable points (excluding skipped)
    const total = maxTotal > 0 ? Math.round(earnedTotal / maxTotal * 100) : 0;

    const has500 = this.errors.filter(e => e.sev === 'CRITICAL').length;
    let grade;
    if (has500 > 0) grade = 'D';
    else if (total >= 97) grade = 'A+';
    else if (total >= 93) grade = 'A';
    else if (total >= 90) grade = 'A-';
    else if (total >= 87) grade = 'B+';
    else if (total >= 83) grade = 'B';
    else if (total >= 80) grade = 'B-';
    else if (total >= 70) grade = 'C';
    else if (total >= 60) grade = 'D';
    else grade = 'F';

    return { pts, total, grade, bp, earnedTotal, maxTotal, skippedPhases: [...this.skippedPhases] };
  }

  // Э1 — the verdict layer. Score is a trend metric; the VERDICT is what
  // actually gates alerting/CI. Any of these makes the whole run FAIL,
  // independent of how high the score is:
  //   - a RED-class assertion failed (money e2e, crash/liveness, public 404,
  //     catalog-sanity — see redRec() call sites)
  //   - a CRITICAL error was recorded (500s, etc. — pre-existing severity)
  //   - too many phases were SKIPped (a control must state its world; a run
  //     that quietly skipped most of the corpus isn't a trustworthy PASS)
  computeVerdict(opts = {}) {
    const maxSkipped = opts.maxSkippedPhases ?? DEFAULT_MAX_SKIPPED_PHASES;
    const redFails = this.all.filter(t => t.red && !t.ok);
    const critical = this.errors.filter(e => e.sev === 'CRITICAL');
    const skippedCount = this.skippedPhases.size;
    const tooManySkips = skippedCount > maxSkipped;

    const reasons = [];
    if (redFails.length) {
      reasons.push(`${redFails.length} RED-class failure(s): ` +
        redFails.map(f => `${f.phase}/${f.name}`).join(', '));
    }
    if (critical.length) {
      reasons.push(`${critical.length} CRITICAL error(s): ` +
        critical.map(e => `${e.phase}/${e.title}`).join(', '));
    }
    if (tooManySkips) {
      reasons.push(`${skippedCount} phases skipped (> ${maxSkipped}): ` +
        [...this.skippedPhases].map(p => `${p} (${this.skipReasons[p] || 'no reason given'})`).join('; '));
    }

    return {
      verdict: reasons.length ? 'FAIL' : 'PASS',
      reasons,
      redFailCount: redFails.length,
      criticalCount: critical.length,
      skippedCount,
    };
  }
}

module.exports = { Scorer, sanitize };
