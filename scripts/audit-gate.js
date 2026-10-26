#!/usr/bin/env node
'use strict';
// Dependency-audit gate (T-0573 q-1). Reads `npm audit --json` output and an
// allowlist of advisories that have no upstream fix. Fails closed: a missing,
// empty or unparseable report is an error. Plain Node, no dependencies, no
// child processes.
const fs = require('fs');

const BLOCKING = new Set(['high', 'critical']);

function ghsaOf(url) {
  const m = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(String(url || ''));
  return m ? m[0] : null;
}

// Advisory objects reachable from a package through `via` (string entries
// point at another vulnerable package).
function advisoriesFor(vulns, name, seen) {
  if (seen.has(name)) return [];
  seen.add(name);
  const v = vulns[name];
  if (!v || !Array.isArray(v.via)) return [];
  const out = [];
  for (const x of v.via) {
    if (typeof x === 'string') out.push(...advisoriesFor(vulns, x, seen));
    else if (x && typeof x === 'object') out.push({ ...x, owner: name });
  }
  return out;
}

// npm reports a downgrade to a nonsense version as a "fix" for transitive
// dependencies (isSemVerMajor: true). Only `true` or a non-major object is a real one.
function realFix(fix) {
  if (fix === true) return true;
  return !!fix && typeof fix === 'object' && fix.isSemVerMajor === false;
}

// Returns { ok, errors[], waived[] }.
function check(report, allowlist, today) {
  const errors = [];
  const waived = [];
  if (!report || typeof report !== 'object' || !report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    return { ok: false, errors: ['audit report has no vulnerabilities object'], waived };
  }
  if (!allowlist || typeof allowlist !== 'object') {
    return { ok: false, errors: ['allowlist is not an object'], waived };
  }
  const allow = {};
  for (const [id, e] of Object.entries(allowlist)) allow[id.toLowerCase()] = e;
  const vulns = report.vulnerabilities;
  const used = new Map();
  for (const [name, v] of Object.entries(vulns)) {
    if (!BLOCKING.has(v.severity)) continue;
    const advs = advisoriesFor(vulns, name, new Set());
    if (advs.length === 0) errors.push(`${name}: ${v.severity} with no resolvable advisory`);
    for (const a of advs) {
      if (!BLOCKING.has(a.severity)) continue;
      const id = ghsaOf(a.url);
      const entry = id && allow[id.toLowerCase()];
      if (!entry) { errors.push(`${a.owner}: ${a.severity} ${id || a.url || a.title} is not allowlisted`); continue; }
      if (entry.package !== a.name) { errors.push(`${id}: allowlist package ${entry.package} != ${a.name}`); continue; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry.expires)) || entry.expires < today) {
        errors.push(`${id}: allowlist entry expired or invalid (${entry.expires})`); continue;
      }
      if (a.owner === a.name && realFix(v.fixAvailable)) {
        errors.push(`${id}: a fix is available (${JSON.stringify(v.fixAvailable)}), entry is stale`); continue;
      }
      used.set(id, entry);
    }
  }
  for (const [id, e] of used) waived.push(`${id} (${e.package}, expires ${e.expires}): ${e.reason}`);
  return { ok: errors.length === 0, errors, waived: [...new Set(waived)] };
}

function readJson(path) {
  const txt = fs.readFileSync(path, 'utf8');
  if (!txt.trim()) throw new Error(`${path} is empty`);
  return JSON.parse(txt);
}

function main(argv) {
  let res;
  try {
    res = check(readJson(argv[0]), readJson(argv[1]), new Date().toISOString().slice(0, 10));
  } catch (e) {
    res = { ok: false, errors: [`cannot read inputs: ${e.message}`], waived: [] };
  }
  for (const w of res.waived) console.log(`audit-gate: IGNORED ${w}`);
  for (const e of res.errors) console.log(`::error::audit-gate: ${e}`);
  console.log(res.ok ? 'audit-gate: PASS' : 'audit-gate: FAIL');
  return res.ok ? 0 : 1;
}

module.exports = { check, main };
if (require.main === module) process.exit(main(process.argv.slice(2)));
