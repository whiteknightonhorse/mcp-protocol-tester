class Scorer {
  constructor() {
    this.pass = [];
    this.fail = [];
    this.all = [];
    this.errors = [];
    this.recommendations = [];
  }

  rec(phase, name, exp, got, ok, det = '') {
    const entry = { phase, name, exp: String(exp), got: String(got), ok, det };
    this.all.push(entry);
    ok ? this.pass.push(entry) : this.fail.push(entry);
    console.log(`  [${ok ? 'OK' : '!!'} ] ${name} — ${got}${det ? ' | ' + det.slice(0, 120) : ''}`);
    return entry;
  }

  recQ(phase, name, exp, got, ok, det = '') {
    const entry = { phase, name, exp: String(exp), got: String(got), ok, det };
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
      const p = bp[id] || { pass: 0, total: 1 };
      return Math.min(1, p.pass / Math.max(p.total, 1));
    };
    const pts = weights.map(([id, wt]) => [id, Math.round(pr(id) * wt), wt]);
    const total = pts.reduce((s, [, v]) => s + v, 0);

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

    return { pts, total, grade, bp };
  }
}

module.exports = { Scorer };
