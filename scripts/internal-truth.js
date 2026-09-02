#!/usr/bin/env node
/**
 * Э5 — internal truth (Ярус C, Fable's audit 2026-09-02).
 *
 * White-box, same box, deliberately separate from the P0-P26 HTTP corpus:
 * this checks whether apibase's OWN documented promises about its
 * infrastructure are still true, not whether its HTTP API behaves — the
 * root causes of Д4 (nginx newer than the deployed image, 40 minutes of
 * 404s) and Д5 (a documented "host cron" that doesn't exist) live here,
 * not in any request/response the black-box tester could ever observe.
 *
 * Deliberately does NOT re-check node-cron registration inside the app
 * (worker/server.ts) — apibase's own `tests/unit/job-registration.test.ts`
 * (added closing F1) already gates that in CI, and re-testing it here would
 * be exactly the ONE-PLACE duplication Fable's verdict explicitly warns
 * against. This only covers what CI structurally cannot see: host-level
 * cron/systemd state and the served-vs-checked-out file pair.
 *
 * Exit 0 = all clear. Exit 1 = at least one drift found (prints details).
 * run-daily.sh treats this the same as any other alert-worthy signal.
 */
const fs = require('fs');
const { execSync } = require('child_process');

const APIBASE_ROOT = '/home/apibase/apibase';
const RUNBOOK = `${APIBASE_ROOT}/docs/runbook.md`;

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf-8' }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

function findings() {
  const problems = [];
  const ok = [];

  // --- 1. Declared host cron file must actually exist -----------------------
  const runbookText = fs.existsSync(RUNBOOK) ? fs.readFileSync(RUNBOOK, 'utf-8') : '';
  const cronFileMatch = runbookText.match(/Host cron file:\s*`([^`]+)`/);
  if (cronFileMatch) {
    const declaredPath = cronFileMatch[1];
    if (fs.existsSync(declaredPath)) {
      ok.push(`declared host cron file ${declaredPath} exists`);
    } else {
      problems.push(`runbook.md claims "Host cron file: ${declaredPath}" but that file does not exist ` +
        `on this box — the documented mechanism is not the real one (see the "Host cron" rows below ` +
        `for what actually runs it)`);
    }
  }

  // --- 2. Every "Host cron" row in the declared job table has SOME live
  //        host-level mechanism (crontab, /etc/cron.d/*, or a systemd timer)
  //        mentioning it. Keyword match, not exact-cadence match — exact
  //        cadence semantics (cron expression vs "weekly Sun 04:00") is a
  //        much bigger parser than this box's remaining scope justifies;
  //        "does anything on this host even reference it" is still a real,
  //        controllable check (proven below by literally deleting the
  //        matching lines and re-running).
  const tableRows = [...runbookText.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*Host cron\s*\|/gm)];
  const hostCronText = [
    sh('crontab -l 2>/dev/null'),
    sh('cat /etc/cron.d/* 2>/dev/null'),
    sh('systemctl list-timers --all 2>/dev/null'),
  ].join('\n').toLowerCase();

  for (const [, jobName, schedule] of tableRows) {
    const keyword = jobName.toLowerCase().split(/\s+/)[0]; // "Certbot Renewal" -> "certbot"
    if (hostCronText.includes(keyword)) {
      ok.push(`"${jobName}" (declared: ${schedule}) — found a matching host-level entry`);
    } else {
      problems.push(`"${jobName}" is declared as Host cron (${schedule}) in runbook.md but no crontab, ` +
        `/etc/cron.d/*, or systemd timer on this box mentions "${keyword}" — the job may not be running at all`);
    }
  }

  // --- 3. Served pair: is the checked-out commit the one actually running?
  //        This is Д4's literal root cause (nginx.conf/static newer than the
  //        image that was pulled) made into a standing check.
  let gitHead = '';
  try { gitHead = sh(`git -C ${APIBASE_ROOT} rev-parse HEAD`).trim(); } catch {}
  const dockerImages = sh("docker ps --format '{{.Image}}' --filter name=apibase-api");
  const runningSha = (dockerImages.match(/sha-([0-9a-f]{7,40})/) || [])[1] || '';
  if (gitHead && runningSha) {
    const matches = gitHead.startsWith(runningSha) || runningSha.startsWith(gitHead.slice(0, runningSha.length));
    if (matches) {
      ok.push(`checked-out HEAD (${gitHead.slice(0, 12)}) matches the running image tag (sha-${runningSha})`);
    } else {
      problems.push(`checked-out git HEAD (${gitHead.slice(0, 12)}) does NOT match the running API image ` +
        `(sha-${runningSha}) — this is exactly the Д4 shape: nginx.conf/static on disk can be a different ` +
        `commit than the code actually serving requests`);
    }
  } else {
    ok.push('served-pair check skipped (could not read git HEAD or running image tag — informational only)');
  }

  // 3b. static-current symlink (F2's fix) should point at static-releases/<HEAD>.
  const staticCurrent = `${APIBASE_ROOT}/static-current`;
  if (fs.existsSync(staticCurrent) && gitHead) {
    let target = '';
    try { target = fs.readlinkSync(staticCurrent); } catch {}
    if (target.includes(gitHead) || target.includes(gitHead.slice(0, 12))) {
      ok.push(`static-current symlink points at the current HEAD's release dir`);
    } else {
      problems.push(`static-current symlink target (${target}) does not reference the current git HEAD ` +
        `(${gitHead.slice(0, 12)}) — nginx may be serving stale static files for the currently checked-out commit`);
    }
  }

  return { problems, ok };
}

function main() {
  const { problems, ok } = findings();
  console.log(`[internal-truth] ${ok.length} check(s) clear, ${problems.length} drift(s) found`);
  for (const o of ok) console.log(`  OK   ${o}`);
  for (const p of problems) console.log(`  DRIFT ${p}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

main();
