// Sanitize any string before logging — removes secrets, tokens, keys, long JSON
function sanitize(str) {
  if (!str) return '';
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

class Scorer {
  constructor() {
    this.pass = [];
    this.fail = [];
    this.all = [];
    this.errors = [];
    this.recommendations = [];
    this.skippedPhases = new Set(); // phases skipped (not counted in score)
  }

  // Mark entire phase as SKIP (not counted in score denominator)
  skip(phase, reason = '') {
    this.skippedPhases.add(phase);
    process.stdout.write(`  [SKIP] ${phase} — ${reason}\n`);
  }

  rec(phase, name, exp, got, ok, det = '') {
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
    const entry = { phase, name, exp: String(exp).slice(0, 100), got: sanitize(got), ok, det: sanitize(det) };
    this.all.push(entry);
    ok ? this.pass.push(entry) : this.fail.push(entry);
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
}

module.exports = { Scorer };
