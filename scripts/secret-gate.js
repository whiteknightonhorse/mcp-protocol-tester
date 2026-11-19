#!/usr/bin/env node
'use strict';
// Secret gate (T-0920). Every 0x + 64-or-more hex run under the scanned dirs must be an
// allowlist entry matched by exact value (whole hex run, lowercase). Node builtins only.
// Usage: node scripts/secret-gate.js <allowlist.json> <dir> [<dir>...]
const fs = require('fs');
const path = require('path');

const KINDS = new Set(['event-topic', 'tx-hash', 'eip3009-nonce']);
const RUN = /0x[0-9a-fA-F]{64,}/g;
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (e.isFile()) out.push(p);
  }
}

const mask = (v) => `${v.slice(0, 10)}...${v.slice(-6)}`;

function main(argv) {
  if (argv.length < 2) { console.error('usage: secret-gate.js <allowlist.json> <dir> [<dir>...]'); return 1; }
  let list;
  try { list = JSON.parse(fs.readFileSync(argv[0], 'utf8')); } catch (e) { console.error(`::error::cannot read allowlist: ${e.message}`); return 1; }
  if (!Array.isArray(list)) { console.error('::error::allowlist must be an array'); return 1; }
  let bad = 0;
  const allowed = new Map();
  for (const [i, e] of list.entries()) {
    const ok = e && typeof e.value === 'string' && /^0x[0-9a-f]{64}$/i.test(e.value)
      && KINDS.has(e.kind) && typeof e.proof === 'string' && e.proof.trim() !== '';
    if (!ok) { console.error(`::error::allowlist entry ${i} invalid (value 0x+64hex, kind one of ${[...KINDS].join('/')}, non-empty proof)`); bad++; continue; }
    if (allowed.has(e.value.toLowerCase())) { console.error(`::error::allowlist entry ${i} duplicates an earlier value`); bad++; continue; }
    allowed.set(e.value.toLowerCase(), 0);
  }
  const files = [];
  for (const d of argv.slice(1)) {
    try { walk(d, files); } catch (e) { console.error(`::error::cannot scan ${d}: ${e.message}`); return 1; }
  }
  let admitted = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'latin1').split('\n');
    lines.forEach((line, n) => {
      for (const m of line.matchAll(RUN)) {
        const v = m[0].toLowerCase();
        if (allowed.has(v)) { allowed.set(v, allowed.get(v) + 1); admitted++; }
        else { console.error(`::error::${f}:${n + 1}: 0x+64hex value not in allowlist: ${mask(m[0])}`); bad++; }
      }
    });
  }
  for (const [v, c] of allowed) if (c === 0) { console.error(`::error::stale allowlist entry, value not found in scanned dirs: ${mask(v)}`); bad++; }
  if (bad) return 1;
  console.log(`secret gate: ${admitted} admitted public value(s), no other 0x+64hex`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
