/**
 * Phase 15 — Report Generation
 * Computes final grade and displays summary.
 * Weights are defined in lib/reporter.js (single source of truth).
 */
const { generateReport, WEIGHTS } = require('../lib/reporter');

const PHASE = 'P20';

module.exports = async function phase17(scorer, config, context) {
  console.log('\n--- Phase 17: Report ---');

  const meta = {
    serverUrl: config.apiBaseUrl,
    toolCount: context.catalog.length,
    spentX402: context.spentX402,
    spentMPP: context.spentMPP,
    hasMPP: context.hasMPP,
    hasX402: context.hasX402,
    balBase: context.balBase,
    balTempo: context.balTempo,
    skipPayments: config.skipPayments,
    timestamp: new Date().toISOString(),
  };

  // Compute grade using weights
  const grade = scorer.computeGrade(WEIGHTS);

  console.log(`\n  ${'='.repeat(60)}`);
  console.log(`  GRADE: ${grade.grade}  (${grade.total}/100)`);
  console.log(`  ${'='.repeat(60)}`);

  // Per-phase breakdown
  for (const [phaseId, earned, max] of grade.pts) {
    const pct = max > 0 ? Math.round((earned / max) * 100) : 0;
    const bar = '#'.repeat(Math.round(pct / 5)) + '.'.repeat(20 - Math.round(pct / 5));
    console.log(`  ${phaseId.padEnd(18)} ${String(earned).padStart(3)}/${String(max).padStart(3)}  [${bar}]`);
  }

  // Errors summary
  if (scorer.errors.length > 0) {
    console.log(`\n  ERRORS (${scorer.errors.length}):`);
    for (const err of scorer.errors) {
      console.log(`    [${err.sev}] ${err.title}: ${err.detail}`);
      if (err.fix) console.log(`           Fix: ${err.fix}`);
    }
  }

  // Recommendations
  if (scorer.recommendations.length > 0) {
    console.log(`\n  RECOMMENDATIONS (${scorer.recommendations.length}):`);
    for (const rec of scorer.recommendations) {
      console.log(`    [${rec.cat}] ${rec.title}: ${rec.detail}`);
    }
  }

  // Pass/fail summary
  console.log(`\n  Tests: ${scorer.pass.length} passed, ${scorer.fail.length} failed, ${scorer.all.length} total`);
  console.log(`  Costs: x402=$${context.spentX402.toFixed(4)} MPP=$${context.spentMPP.toFixed(4)}`);

  // Generate full report file
  try {
    generateReport(scorer, meta);
  } catch (e) {
    console.log(`  Report generation error: ${e.message}`);
  }
};
