#!/usr/bin/env node
/**
 * Э1 — the CI "dual stub" control Fable's audit requires: a dead server and a
 * flat "everything is 200 with an empty body" server must BOTH produce
 * VERDICT=FAIL. This is what replaces `... || true` in ci.yml — previously
 * the dry run could never fail CI no matter what it found.
 *
 * Runs the real src/index.js (not a reimplementation) against two local
 * fixture HTTP servers with PHASES=0 (discovery only — matches the existing
 * CI dry-run scope), reads back the JSON report each run produces, and
 * asserts verdict === 'FAIL' for both. Exits non-zero (no `|| true` here) if
 * either fixture is scored anything but FAIL.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');

function listenOnEphemeralPort(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Fixture A — "dead server": ECONNREFUSED. Grab an ephemeral port from the OS
// and immediately close it — nothing is listening there afterwards, so any
// connection attempt fails fast and deterministically. This is what sf()
// actually sees from a box that is down, and is simpler/faster in CI than
// managing a live socket-destroying server (which risks an event loop that
// never settles).
async function findUnusedPort() {
  const probe = http.createServer();
  const port = await listenOnEphemeralPort(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Fixture B — "flat green": every path returns 200 with an empty JSON body.
// This is the shape Fable's audit means by "мёртвый сервер набирает зелень"
// taken to its logical extreme — a server that answers but never actually
// does anything.
function startFlatServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  return server;
}

function newestReportSince(cutoffMs) {
  const files = fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.startsWith('dual-rail-report-') && f.endsWith('.json'))
    .map((f) => ({ f, t: fs.statSync(path.join(REPORTS_DIR, f)).mtimeMs }))
    .filter((x) => x.t >= cutoffMs)
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(REPORTS_DIR, files[0].f) : null;
}

// IMPORTANT: this must be async (execFile, not execFileSync). The flat-200
// fixture server runs IN THIS SAME PROCESS — a *Sync child_process call
// blocks Node's single event loop entirely, so the parent could never accept
// the child's incoming HTTP connections and every request would time out
// regardless of what the fixture actually does. (Caught exactly this way:
// the flat fixture showed TIMEOUT on every check until this was switched
// from execFileSync to execFile.)
function runAgainst(baseUrl) {
  const cutoff = Date.now() - 1000;
  return new Promise((resolve, reject) => {
    execFile('node', ['--max-old-space-size=512', 'src/index.js'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        API_BASE_URL: baseUrl,
        MCP_SERVER_URL: `${baseUrl}/mcp`,
        SKIP_PAYMENTS: 'true',
        PHASES: '0',
        API_KEY: '',
        PRIVATE_KEY: '',
      },
      timeout: 60000,
    }, (err, stdout, stderr) => {
      // index.js exits non-zero on VERDICT=FAIL now (Э1) — that is the
      // EXPECTED outcome here, not a crash; only missing-report counts as one.
      const reportPath = newestReportSince(cutoff);
      if (!reportPath) {
        const out = err ? `\n--- child stdout/stderr ---\n${stdout || ''}${stderr || ''}` : '';
        reject(new Error(`no report produced for ${baseUrl} — the run crashed before reporting${out}`));
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

  const deadPort = await findUnusedPort();
  const deadReport = await runAgainst(`http://127.0.0.1:${deadPort}`);
  console.log(`[dead server]  verdict=${deadReport.verdict} score=${deadReport.score}`);
  if (deadReport.verdict !== 'FAIL') {
    console.error('FAIL: dead-server fixture did not produce VERDICT=FAIL');
    failures++;
  }

  const flat = startFlatServer();
  const flatPort = await listenOnEphemeralPort(flat);
  const flatReport = await runAgainst(`http://127.0.0.1:${flatPort}`);
  flat.close();
  console.log(`[flat 200/{}]  verdict=${flatReport.verdict} score=${flatReport.score}`);
  if (flatReport.verdict !== 'FAIL') {
    console.error('FAIL: flat-200-empty fixture did not produce VERDICT=FAIL');
    failures++;
  }

  if (failures > 0) {
    console.error(`\n${failures} verdict-discrimination control(s) failed.`);
    process.exit(1);
  }
  console.log('\nBoth dual-stub controls correctly produced VERDICT=FAIL.');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
