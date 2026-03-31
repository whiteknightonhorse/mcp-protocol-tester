const fs = require('fs');
const path = require('path');

// Single source of truth for phase weights
const WEIGHTS = [
  ['P0', 4], ['P1', 4], ['P2', 4], ['P3', 4], ['P4', 4],
  ['P5', 4], ['P6', 4], ['P7', 4], ['P8', 6], ['P9', 5],
  ['P10', 4], ['P11', 4], ['P12', 3], ['P13', 3], ['P14', 4],
  ['P15', 3], ['P16', 5], ['P17', 6], ['P18', 9], ['P19', 6],
  ['P20', 4],
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

  const { pts, total, grade, bp } = scorer.computeGrade(WEIGHTS);

  w(`\nServer: ${meta.serverUrl} | Tools: ${meta.toolCount || '?'}`);
  w(`Assertions: ${scorer.all.length} | Pass: ${scorer.pass.length} | Fail: ${scorer.fail.length}`);

  w(''); hr(); w('SCORING'); hr();
  const labels = [
    'Discovery', 'Infrastructure', 'MPP Challenges', 'x402 Challenges',
    'MCP Protocol', 'MPP Payments', 'x402 Payments', 'Basic Security',
    'Payment Security', 'Advanced Security', 'Resilience',
    'Load Test', 'Provider Health', 'Cache & Simulation', 'Discover Tools',
    'Platform Features', 'Platform Features', 'Agent Experience', 'Payment Bypass',
    'CDP Facilitator', 'Report',
  ];
  pts.forEach(([, v, mx], i) => w(`  ${(labels[i] || '?').padEnd(24)} ${v}/${mx}`));
  w(`  ${'Total'.padEnd(24)} ${total}/100`);
  w(`  ${'Grade'.padEnd(24)} ${grade}`);

  // Financial
  w(''); hr(); w('FINANCIAL SUMMARY'); hr();
  w(`  x402 spent (Base):   $${(meta.spentX402 || 0).toFixed(4)}`);
  w(`  MPP spent (Tempo):   $${(meta.spentMPP || 0).toFixed(4)}`);
  w(`  Total:               $${((meta.spentX402 || 0) + (meta.spentMPP || 0)).toFixed(4)}`);

  // 500 errors
  const all500 = scorer.all.filter(t => t.got === '500');
  w(''); hr(); w(`500 SERVER ERRORS (${all500.length})`); hr();
  if (all500.length === 0) w('  None');
  else for (const f of all500) w(`  [${f.phase}] ${f.name}: ${f.det}`);

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
  for (let i = 0; i <= 20; i++) {
    const id = `P${i}`;
    const items = scorer.all.filter(t => t.phase === id);
    if (items.length === 0) continue;
    const p = bp[id] || { pass: 0, total: 0 };
    w(''); hr(); w(`PHASE ${i}: ${labels[i] || '?'} (${p.pass}/${p.total})`); hr();
    if (items.length > 30) {
      const fails = items.filter(t => !t.ok);
      for (const t of fails) w(`  [FAIL] ${t.name} — ${t.got}${t.det ? ' | ' + t.det : ''}`);
      w(`  ... and ${items.length - fails.length} PASS`);
    } else {
      for (const t of items) w(`  [${t.ok ? 'PASS' : 'FAIL'}] ${t.name} — ${t.got}${t.det ? ' | ' + t.det : ''}`);
    }
  }

  // All failures
  const allFails = scorer.all.filter(t => !t.ok);
  w(''); hr(); w(`ALL FAILURES (${allFails.length})`); hr();
  if (allFails.length === 0) w('  None!');
  else for (const f of allFails) w(`  [${f.phase}] ${f.name}: exp ${f.exp}, got ${f.got}${f.det ? ' | ' + f.det : ''}`);

  w('\n' + '='.repeat(76));
  w(`CONCLUSION: Score ${total}/100 — Grade ${grade} | Time: ${meta.totalTime || '?'}s`);
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
    assertions: { total: scorer.all.length, pass: scorer.pass.length, fail: scorer.fail.length },
    financial: { x402: meta.spentX402 || 0, mpp: meta.spentMPP || 0 },
    errors: scorer.errors, recommendations: scorer.recommendations,
    failures: allFails.map(f => ({ phase: f.phase, name: f.name, expected: f.exp, got: f.got, detail: f.det })),
  }, null, 2), 'utf-8');
  console.log(`JSON report saved to ${jsonFile}`);

  return { grade, total, txtFile, jsonFile };
}

module.exports = { generateReport, WEIGHTS };
