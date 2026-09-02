#!/usr/bin/env node
/**
 * Э1 — standing-red ledger + escalation.
 *
 * Fable's audit (2026-09-02): the same 12 failures were byte-identical
 * (only the request_id differed) for at least 4 days, and nothing ever
 * escalated because nothing ever diffed one run's failures against the
 * last. This closes that gap:
 *   - every failure's signature is `${phase}|${name}` (deliberately NOT
 *     including `detail`/`got`, since those are exactly the fields that
 *     differ run to run for the same underlying defect — request_id, a
 *     timestamp, a byte count);
 *   - a signature seen for the first time is a NEW failure -> always alert;
 *   - a signature still failing after >= 3 days is ESCALATED -> a standing
 *     red is not allowed to just sit there; either prod gets fixed or the
 *     probe gets rewritten/retired, but silence is not an option;
 *   - a signature that stops failing is dropped from the ledger (resolved).
 *
 * Usage: node scripts/verdict-runner.js <path-to-dual-rail-report.json>
 *        node scripts/verdict-runner.js --set-owner "<phase>|<name>" "<owner text>"
 *          (manual annotation — a ledger entry with no owner just says so,
 *          nothing enforces setting one; this is for a human to record who's
 *          on a standing red once someone actually is)
 * Exit code 0  = no alert needed (prints a short summary to stdout).
 * Exit code 1  = alert needed (prints the ready-to-send message to stdout;
 *                run-daily.sh pipes this straight into notify-telegram.sh
 *                and the GitHub issue body).
 */
const fs = require('fs');
const path = require('path');

const ESCALATE_AFTER_DAYS = 3;
const REPO_ROOT = path.join(__dirname, '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'reports', 'standing-reds.json');

function todayStr() { return new Date().toISOString().slice(0, 10); }

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf-8');
}

function main() {
  if (process.argv[2] === '--set-owner') {
    const [, , , sig, ...ownerParts] = process.argv;
    const owner = ownerParts.join(' ');
    if (!sig || !owner) {
      console.error('usage: verdict-runner.js --set-owner "<phase>|<name>" "<owner text>"');
      process.exit(2);
    }
    const ledger = loadLedger();
    if (!ledger[sig]) {
      console.error(`no ledger entry for "${sig}" — nothing to annotate (list current entries with no args pending, or check reports/standing-reds.json)`);
      process.exit(1);
    }
    ledger[sig].owner = owner;
    saveLedger(ledger);
    console.log(`owner set: ${sig} -> ${owner}`);
    process.exit(0);
  }

  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('usage: verdict-runner.js <report.json>');
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const today = todayStr();
  const ledger = loadLedger();

  const currentSigs = new Map(); // sig -> failure detail
  for (const f of report.failures || []) {
    currentSigs.set(`${f.phase}|${f.name}`, f);
  }

  const fresh = [];
  const escalated = [];

  for (const [sig, f] of currentSigs) {
    if (!ledger[sig]) {
      ledger[sig] = { first_seen: today, last_seen: today, phase: f.phase, name: f.name };
      fresh.push({ sig, f });
    } else {
      ledger[sig].last_seen = today;
      const age = daysBetween(ledger[sig].first_seen, today);
      if (age >= ESCALATE_AFTER_DAYS) {
        escalated.push({ sig, f, age, firstSeen: ledger[sig].first_seen });
      }
    }
  }

  // Resolved: was in the ledger, isn't failing anymore.
  const resolved = [];
  for (const sig of Object.keys(ledger)) {
    if (!currentSigs.has(sig)) {
      resolved.push(sig);
      delete ledger[sig];
    }
  }

  saveLedger(ledger);

  const standingCount = Object.keys(ledger).length;
  const verdictFail = report.verdict === 'FAIL';
  const alertNeeded = verdictFail || fresh.length > 0 || escalated.length > 0;

  const lines = [];
  lines.push(`[apibase tester] ${verdictFail ? '\u{1f534} VERDICT FAIL' : '⚠️ standing-red alert'} — score ${report.score}/100 (${report.grade}) — ${report.server || ''}`);
  if (verdictFail) {
    lines.push('Verdict reasons:');
    for (const r of report.verdictReasons || []) lines.push(`  - ${r}`);
  }
  if (fresh.length > 0) {
    lines.push(`New failure(s) today (${fresh.length}):`);
    for (const { sig, f } of fresh) lines.push(`  - ${sig}: exp ${f.expected}, got ${f.got}`);
  }
  if (escalated.length > 0) {
    lines.push(`Standing red >= ${ESCALATE_AFTER_DAYS} days (${escalated.length}) — fix prod, retire the probe, or name an owner:`);
    for (const { sig, age, firstSeen } of escalated) {
      const entry = ledger[sig] || {};
      lines.push(`  - ${sig}: red since ${firstSeen} (${age}d) — owner: ${entry.owner || 'UNASSIGNED'}`);
    }
  }
  if (resolved.length > 0) {
    lines.push(`Resolved since last run (${resolved.length}): ${resolved.join(', ')}`);
  }
  lines.push(`Standing ledger: ${standingCount} tracked failure(s).`);

  console.log(lines.join('\n'));
  process.exit(alertNeeded ? 1 : 0);
}

main();
