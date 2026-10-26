#!/usr/bin/env node
'use strict';
// Self-test for scripts/audit-gate.js: four in-process fixtures (T-0573 q-1).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, main } = require('./audit-gate');

const ID = 'GHSA-mrhx-c7xc-m3w5';
const allow = { [ID]: { package: 'zod', expires: '2027-01-26', reason: 'fixture' } };
const adv = (id, name, severity) => ({ name, severity, url: `https://github.com/advisories/${id}` });
const zodVuln = {
  zod: { severity: 'high', via: [adv(ID, 'zod', 'high')], fixAvailable: { name: '@x402/evm', version: '0.0.1', isSemVerMajor: true } },
  '@x402/core': { severity: 'high', via: ['zod'], fixAvailable: false },
};
const report = (v) => ({ vulnerabilities: v });

// 1. only the allowlisted advisory: pass, and it is reported as waived
let r = check(report(zodVuln), allow, '2026-10-26');
assert.strictEqual(r.ok, true, r.errors.join('; '));
assert.strictEqual(r.waived.length, 1);

// 2. an extra high advisory fails
r = check(report({ ...zodVuln, foo: { severity: 'high', via: [adv('GHSA-aaaa-bbbb-cccc', 'foo', 'high')], fixAvailable: false } }), allow, '2026-10-26');
assert.strictEqual(r.ok, false);

// 3. expired entry fails
r = check(report(zodVuln), allow, '2027-02-01');
assert.strictEqual(r.ok, false);

// 4. missing / empty / unparseable input fails closed
assert.strictEqual(check(undefined, allow, '2026-10-26').ok, false);
assert.strictEqual(check({}, allow, '2026-10-26').ok, false);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'));
const empty = path.join(tmp, 'empty.json');
fs.writeFileSync(empty, '');
assert.strictEqual(main([path.join(tmp, 'missing.json'), '.github/audit-allowlist.json']), 1);
assert.strictEqual(main([empty, '.github/audit-allowlist.json']), 1);
fs.writeFileSync(empty, '{not json');
assert.strictEqual(main([empty, '.github/audit-allowlist.json']), 1);

// bonus: a real fix makes the entry stale
r = check(report({ zod: { ...zodVuln.zod, fixAvailable: true } }), allow, '2026-10-26');
assert.strictEqual(r.ok, false);

console.log('audit-gate self-test: all fixtures behave');
