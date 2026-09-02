#!/usr/bin/env node
/**
 * Mutation control for P2's challenge-field RED assertions (Fable's
 * follow-up audit, 2026-09-02): the recipient/amount/chainId checks in
 * src/phases/02-mpp-challenges.js must actually be wired to the verdict,
 * not just present. Flips EXPECTED_RECIPIENT to a wrong address via
 * MPP_EXPECTED_RECIPIENT_TEST_OVERRIDE (the only env var that can move it —
 * see the phase file), runs the real P0+P2 against real prod, and asserts:
 *   - wrong recipient -> VERDICT FAIL with a P2 red-class failure naming it
 *   - real recipient   -> VERDICT PASS (or at least no P2 red failure)
 *
 * No money spent — P2 only reads 402 challenges, never pays.
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
const WRONG_RECIPIENT = '0x000000000000000000000000000000DEADBEEF';

function newestReportSince(cutoffMs) {
  const files = fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.startsWith('dual-rail-report-') && f.endsWith('.json'))
    .map((f) => ({ f, t: fs.statSync(path.join(REPORTS_DIR, f)).mtimeMs }))
    .filter((x) => x.t >= cutoffMs)
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(REPORTS_DIR, files[0].f) : null;
}

function run(envOverride) {
  const cutoff = Date.now() - 1000;
  return new Promise((resolve, reject) => {
    execFile('node', ['--max-old-space-size=512', 'src/index.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, SKIP_PAYMENTS: 'true', PHASES: '0,2', ...envOverride },
      timeout: 120000,
    }, (err, stdout, stderr) => {
      const reportPath = newestReportSince(cutoff);
      if (!reportPath) {
        reject(new Error(`no report produced (env=${JSON.stringify(envOverride)})\n${stdout}\n${stderr}`));
        return;
      }
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      fs.unlinkSync(reportPath);
      const txtPath = reportPath.replace(/\.json$/, '.txt');
      if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
      resolve(report);
    });
  });
}

async function main() {
  let failures = 0;

  console.log('--- Mutation run: EXPECTED_RECIPIENT flipped to a wrong address ---');
  const mutated = await run({ MPP_EXPECTED_RECIPIENT_TEST_OVERRIDE: WRONG_RECIPIENT });
  const p2RedFail = (mutated.failures || []).find((f) => f.phase === 'P2' && f.red && /recipient/i.test(f.name));
  console.log(`verdict=${mutated.verdict} p2-recipient-red-failure=${p2RedFail ? 'YES' : 'NO'}`);
  if (mutated.verdict !== 'FAIL' || !p2RedFail) {
    console.error('FAIL: mutated recipient did not turn the run red via a P2 recipient assertion');
    failures++;
  }

  console.log('\n--- Control run: real recipient (no override) ---');
  const clean = await run({});
  const p2RedFailClean = (clean.failures || []).find((f) => f.phase === 'P2' && f.red && /recipient/i.test(f.name));
  console.log(`verdict=${clean.verdict} p2-recipient-red-failure=${p2RedFailClean ? 'YES' : 'NO'}`);
  if (p2RedFailClean) {
    console.error('FAIL: the real recipient still produced a P2 recipient red failure — false positive');
    failures++;
  }

  if (failures > 0) {
    console.error(`\n${failures} mutation-control check(s) failed.`);
    process.exit(1);
  }
  console.log('\nMutation control passed: the recipient check is actually wired to the verdict.');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
