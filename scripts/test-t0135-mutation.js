#!/usr/bin/env node
/**
 * Mutation control for T-0135 (§T-2/§Q-1 contract): the tool-quality
 * validators in src/phases/16-platform-features.js must actually reject the
 * pre-Q-1 flat shape (`{tool_id, uptime_pct, error_rate, total_calls,
 * success_calls}`, fabricated 0 for "never measured") and only accept the
 * current contract (`{tool_id, tool: null | {window_h, calls, success_rate,
 * p50_ms, p95_ms, as_of}}`).
 *
 * No live server involved — these are pure functions, and the server no
 * longer speaks the old shape at all (that's the point of the fix), so the
 * only way to prove the checks are still discriminating is to feed them a
 * synthetic old-shape fixture directly.
 */
const {
  evaluateToolQualityShape,
  evaluateRankings,
  QUALITY_MIN_CALLS,
} = require('../src/phases/16-platform-features.js');

let failures = 0;

function expect(label, cond, detail) {
  const status = cond ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

console.log('--- Mutation run: pre-Q-1 flat shape (fabricated zeros) ---\n');

// Old shape for a tool that was "never called" — old buggy code reported
// uptime_pct:0/error_rate:0, indistinguishable from "100% failures".
const oldNeverCalled = { tool_id: 'crypto.get_price', uptime_pct: 0, p50_ms: null, p95_ms: null, error_rate: 0, total_calls: 0, success_calls: 0 };
const r1 = evaluateToolQualityShape(oldNeverCalled);
expect('16.7 rejects old flat "never called" shape', r1.ok === false, r1.detail);

// Old shape for a genuinely measured tool — still flat, still missing the
// `tool` key the new contract requires.
const oldMeasured = { tool_id: 'crypto.get_price', uptime_pct: 97.3, p50_ms: 120, p95_ms: 480, error_rate: 2.7, total_calls: 150, success_calls: 146 };
const r2 = evaluateToolQualityShape(oldMeasured);
expect('16.7 rejects old flat "measured" shape', r2.ok === false, r2.detail);

// Old shape for an unknown tool_id (T-2's headline bug: fabricated zeros,
// not null).
const oldUnknown = { tool_id: 'nonexistent.tool_xyz', uptime_pct: 0, p50_ms: null, p95_ms: null, error_rate: 0, total_calls: 0, success_calls: 0 };
// Mirrors 16.8's real assertion: `'tool' in data && data.tool === null`.
const unknownPassesLiveCheck = 'tool' in oldUnknown && oldUnknown.tool === null;
expect('16.8 rejects old flat unknown-tool shape (fabricated zeros, no tool:null)', unknownPassesLiveCheck === false, JSON.stringify(oldUnknown));

// Old ToolRankingEntry padded with fabricated-zero entries (pre-T-2
// getToolRankings included every candidate, not just sampled ones).
const oldRankings = [
  { tool_id: 'crypto.get_price', uptime_pct: 97.3, p50_ms: 120, p95_ms: 480, error_rate: 2.7, total_calls: 150 },
  { tool_id: 'weather.forecast', uptime_pct: 0, p50_ms: null, p95_ms: null, error_rate: 0, total_calls: 0 },
];
const r3 = evaluateRankings(oldRankings, 10);
expect('16.10 rejects a fabricated-zero ranking entry', r3.ok === false, r3.detail);

console.log('\n--- Control run: current Q-1 shapes (must pass) ---\n');

const newNull = { tool_id: 'crypto.get_price', tool: null };
const r4 = evaluateToolQualityShape(newNull);
expect('16.7 accepts tool=null (never measured)', r4.ok === true && r4.tool === null, r4.detail);

const newBelowThreshold = { tool_id: 'crypto.get_price', tool: { window_h: 24, calls: 3, success_rate: null, p50_ms: null, p95_ms: null, as_of: new Date().toISOString() } };
const r5 = evaluateToolQualityShape(newBelowThreshold);
expect('16.7 accepts sampled-but-below-threshold shape', r5.ok === true, r5.detail);

const newSampled = { tool_id: 'crypto.get_price', tool: { window_h: 24, calls: 42, success_rate: 97.6, p50_ms: 118, p95_ms: 402, as_of: new Date().toISOString() } };
const r6 = evaluateToolQualityShape(newSampled);
expect('16.7 accepts fully-sampled shape', r6.ok === true, r6.detail);

const newRankings = [
  { tool_id: 'crypto.get_price', uptime_pct: 97.6, p50_ms: 118, p95_ms: 402, error_rate: 2.4, total_calls: 42 },
];
const r7 = evaluateRankings(newRankings, 10);
expect('16.10 accepts sampled-only ranking entries', r7.ok === true, r7.detail);

const r8 = evaluateRankings([], 10);
expect('16.10 accepts an empty ranking array', r8.ok === true, r8.detail);

console.log(`\nQUALITY_MIN_CALLS = ${QUALITY_MIN_CALLS}`);

if (failures > 0) {
  console.error(`\n${failures} mutation-control check(s) failed.`);
  process.exit(1);
}
console.log('\nMutation control passed: old-shape fixtures are rejected, current-shape fixtures are accepted.');
