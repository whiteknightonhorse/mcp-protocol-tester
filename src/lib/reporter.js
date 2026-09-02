const fs = require('fs');
const path = require('path');

// Single source of truth for phase weights
// P20 (report) excluded — display-only phase with 0 assertions
const WEIGHTS = [
  ['P0', 5], ['P1', 5], ['P2', 5], ['P3', 5], ['P4', 5],
  ['P5', 5], ['P6', 5], ['P7', 5], ['P8', 7], ['P9', 6],
  ['P10', 5], ['P11', 4], ['P12', 3], ['P13', 4], ['P14', 5],
  ['P16', 5], ['P17', 7], ['P18', 9], ['P19', 5],
  // Э3 new phases — see docs/ADDING-PHASES.md for what each proves and its
  // documented broken-state control.
  ['P20', 6], ['P21', 5], ['P22', 6], ['P23', 3], ['P24', 5], ['P25', 3], ['P26', 4],
];

function generateReport(scorer, meta) {
  const L = [];
  const w = (s) => { L.push(s); console.log(s); };
  const hr = () => w('-'.repeat(76));
  const ts = new Date().toISOString();

  w('\n\n' + '='.repeat(76));
  w('  MCP PROTOCOL TESTER — DUAL-RAIL REPORT');
  w('  Server: ' + (meta.serverUrl || 'unknown'));
  w('  ' + ts);
  w('='.repeat(76));

  const { pts, total, grade, bp, skippedPhases } = scorer.computeGrade(WEIGHTS);
  const verdict = scorer.computeVerdict(meta.verdictOpts || {});

  w(`\nServer: ${meta.serverUrl} | Tools: ${meta.toolCount || '?'}`);
  w(`Assertions: ${scorer.all.length} | Pass: ${scorer.pass.length} | Fail: ${scorer.fail.length}`);

  // Э1 — the verdict comes first and loudest. Score is a trend line; this is
  // what gates alerting and CI exit code.
  w(''); hr(); w(`VERDICT: ${verdict.verdict}`); hr();
  if (verdict.verdict === 'FAIL') {
    for (const r of verdict.reasons) w(`  - ${r}`);
  } else {
    w('  No RED-class failures, no CRITICAL errors, skip count within policy.');
  }

  w(''); hr(); w('SCORING'); hr();
  // Keyed by phase id, not by array position — the OLD positional `labels[i]`
  // array (indexed by WEIGHTS row number) had silently drifted out of sync
  // with WEIGHTS itself (WEIGHTS skips P15 entirely, so position 15 is
  // really P16 — the labels array never accounted for that gap, so every
  // label from P17 onward printed the WRONG phase's name in every report
  // ever generated). A phase-id map cannot drift this way by construction.
  const LABELS = {
    P0: 'Discovery', P1: 'Infrastructure', P2: 'MPP Challenges', P3: 'x402 Challenges',
    P4: 'MCP Protocol', P5: 'MPP Payments', P6: 'x402 Payments', P7: 'Basic Security',
    P8: 'Payment Security', P9: 'Advanced Security', P10: 'Resilience',
    P11: 'Load Test', P12: 'Provider Health', P13: 'Cache & Simulation', P14: 'Discover Tools',
    P16: 'Platform Features', P17: 'Agent Experience', P18: 'Payment Bypass',
    P19: 'CDP Facilitator',
    P20: 'Moderation E2E', P21: 'Appeals', P22: 'Balance Rail', P23: 'Devices',
    P24: 'Docs/Catalog Truth', P25: 'Time Promises', P26: 'Coverage Parity',
  };
  pts.forEach(([id, v, mx, skip]) => {
    if (skip === 'SKIP') w(`  ${(LABELS[id] || id).padEnd(24)} [SKIP] — ${scorer.skipReasons[id] || 'no reason given'}`);
    else w(`  ${(LABELS[id] || id).padEnd(24)} ${v}/${mx}`);
  });
  if (skippedPhases && skippedPhases.length > 0) {
    w(`  ${'Skipped'.padEnd(24)} ${skippedPhases.length} phase(s): ${skippedPhases.join(', ')}`);
  }
  w(`  ${'Total'.padEnd(24)} ${total}/100`);
  w(`  ${'Grade'.padEnd(24)} ${grade}`);

  // Financial
  w(''); hr(); w('FINANCIAL SUMMARY'); hr();
  w(`  x402 spent (Base):   $${(meta.spentX402 || 0).toFixed(4)}`);
  w(`  MPP spent (Tempo):   $${(meta.spentMPP || 0).toFixed(4)}`);
  w(`  Total:               $${((meta.spentX402 || 0) + (meta.spentMPP || 0)).toFixed(4)}`);

  // 500 errors — only count failed tests where got is exactly '500' (HTTP status)
  // Exclude passing tests (e.g. catalog-count=500 is a tool count, not HTTP 500)
  const all500 = scorer.all.filter(t => t.got === '500' && !t.ok);
  w(''); hr(); w(`500 SERVER ERRORS (${all500.length})`); hr();
  if (all500.length === 0) w('  None');
  else for (const f of all500) w(`  [${f.phase}] ${f.name}: ${f.det}`);

  // BLOCKED(<world>) — neither pass nor fail, for a proven reason (see
  // scoring.js's blocked()). Visible but doesn't touch score/verdict.
  if (scorer.blockedList && scorer.blockedList.length > 0) {
    w(''); hr(); w(`BLOCKED (${scorer.blockedList.length})`); hr();
    for (const b of scorer.blockedList) w(`  [${b.phase}] ${b.name} — world=${b.world} — ${b.det}`);
  }

  // Errors
  if (scorer.errors.length > 0) {
    w(''); hr(); w(`ERRORS (${scorer.errors.length})`); hr();
    for (const e of scorer.errors) {
      w(`  [${e.sev}] ${e.title}`);
      w(`    ${e.detail}`);
      if (e.fix) w(`    Fix: ${e.fix}`);
    }
  }

  // Recommendations
  if (scorer.recommendations.length > 0) {
    w(''); hr(); w(`RECOMMENDATIONS (${scorer.recommendations.length})`); hr();
    for (const r of scorer.recommendations) w(`  [${r.cat}] ${r.title}: ${r.detail}`);
  }

  // Per-phase details
  for (let i = 0; i <= 26; i++) {
    const id = `P${i}`;
    if (skippedPhases && skippedPhases.includes(id)) {
      w(''); hr(); w(`PHASE ${i}: ${LABELS[id] || '?'} [SKIP]`); hr();
      w(`  Skipped — ${scorer.skipReasons[id] || 'no reason given'}`);
      continue;
    }
    const items = scorer.all.filter(t => t.phase === id);
    if (items.length === 0) continue;
    const p = bp[id] || { pass: 0, total: 0 };
    w(''); hr(); w(`PHASE ${i}: ${LABELS[id] || '?'} (${p.pass}/${p.total})`); hr();
    if (items.length > 30) {
      const fails = items.filter(t => !t.ok);
      for (const t of fails) w(`  [FAIL]${t.red ? '[RED]' : ''} ${t.name} — ${t.got}${t.det ? ' | ' + t.det : ''}`);
      w(`  ... and ${items.length - fails.length} PASS`);
    } else {
      for (const t of items) w(`  [${t.ok ? 'PASS' : 'FAIL'}]${t.red ? '[RED]' : ''} ${t.name} — ${t.got}${t.det ? ' | ' + t.det : ''}`);
    }
  }

  // All failures
  const allFails = scorer.all.filter(t => !t.ok);
  w(''); hr(); w(`ALL FAILURES (${allFails.length})`); hr();
  if (allFails.length === 0) w('  None!');
  else for (const f of allFails) w(`  [${f.phase}]${f.red ? '[RED]' : ''} ${f.name}: exp ${f.exp}, got ${f.got}${f.det ? ' | ' + f.det : ''}`);

  w('\n' + '='.repeat(76));
  w(`CONCLUSION: Score ${total}/100 — Grade ${grade} — VERDICT ${verdict.verdict} | Time: ${meta.totalTime || '?'}s`);
  w('='.repeat(76));

  // Save files
  const dateStr = ts.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const reportsDir = path.join(process.cwd(), 'reports');
  try { fs.mkdirSync(reportsDir, { recursive: true }); } catch {}

  const txtFile = path.join(reportsDir, `dual-rail-report-${dateStr}.txt`);
  fs.writeFileSync(txtFile, L.join('\n'), 'utf-8');
  console.log(`\nReport saved to ${txtFile}`);

  const jsonFile = path.join(reportsDir, `dual-rail-report-${dateStr}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({
    timestamp: ts, server: meta.serverUrl, score: total, grade,
    verdict: verdict.verdict, verdictReasons: verdict.reasons,
    skippedPhases, skipReasons: scorer.skipReasons,
    assertions: { total: scorer.all.length, pass: scorer.pass.length, fail: scorer.fail.length },
    financial: { x402: meta.spentX402 || 0, mpp: meta.spentMPP || 0 },
    errors: scorer.errors, recommendations: scorer.recommendations,
    blocked: scorer.blockedList || [],
    failures: allFails.map(f => ({ phase: f.phase, name: f.name, expected: f.exp, got: f.got, detail: f.det, red: !!f.red })),
  }, null, 2), 'utf-8');
  console.log(`JSON report saved to ${jsonFile}`);

  return { grade, total, verdict: verdict.verdict, txtFile, jsonFile };
}

module.exports = { generateReport, WEIGHTS };
