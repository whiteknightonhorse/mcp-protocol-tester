#!/usr/bin/env node
'use strict';
// Self-test for scripts/secret-gate.js (T-0920). Keys are random at run time; no 64-hex literal here.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GATE = path.join(__dirname, 'secret-gate.js');
const root = path.join(__dirname, '..');
const hex = () => '0x' + crypto.randomBytes(32).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-gate-'));
let n = 0;

function run(files, entries) {
  const d = path.join(tmp, `c${n++}`);
  fs.mkdirSync(d);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), body);
  const al = path.join(d, 'allow.json');
  fs.writeFileSync(al, JSON.stringify(entries));
  const src = path.join(d, 'src');
  fs.mkdirSync(src);
  for (const name of Object.keys(files)) fs.renameSync(path.join(d, name), path.join(src, name));
  const r = spawnSync('node', [GATE, al, src], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const entry = (value, kind = 'tx-hash', proof = 'fixture') => ({ value, kind, where: 'fixture', proof });

const k = hex();
let r = run({ 'a.js': `const k = '${k}';\n` }, []);
assert.strictEqual(r.code, 1); assert.ok(/a\.js:1/.test(r.out), r.out);
assert.ok(!r.out.includes(k), 'full value must not be printed');

const v = hex();
r = run({ 'a.js': `// ${v}\n` }, [entry(v)]);
assert.strictEqual(r.code, 0, r.out);

const flip = v.slice(0, -1) + (v.endsWith('0') ? '1' : '0');
r = run({ 'a.js': `x = '${flip}'\n` }, [entry(v)]);
assert.strictEqual(r.code, 1, r.out);

r = run({ 'a.js': `x = '${v}ab'\n` }, [entry(v)]);
assert.strictEqual(r.code, 1, r.out);

r = run({ 'a.js': `x = '${v}'\n` }, [entry(v, 'private-key')]);
assert.strictEqual(r.code, 1, r.out);

r = run({ 'a.js': `x = '${v}'\n` }, [entry(v, 'tx-hash', '')]);
assert.strictEqual(r.code, 1, r.out);

r = run({ 'a.js': 'x = 1\n' }, [entry(v)]);
assert.strictEqual(r.code, 1, r.out);

const real = spawnSync('node', [GATE, '.github/secret-allowlist.json', 'src', 'scripts'], { cwd: root, encoding: 'utf8' });
assert.strictEqual(real.status, 0, real.stdout + real.stderr);

console.log('secret gate self-test: 8 cases passed');
