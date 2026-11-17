#!/usr/bin/env node
// T-0898 self-test: fixture nginx conf with the T-0882 location -> 26.1 logic
// reports 0 unprobed; with the exact entry removed (mutation) -> 1.
const p26 = require('../src/phases/26-coverage-parity');
const conf = 'location = /policy/test-wallets.json { }\n';
const count = () => p26.parseNginxLocations(conf).filter((r) => !p26.isProbed(r)).length;
let fail = 0;
const check = (name, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got} (want ${want})`); };
check('after change: unprobed', count(), 0);
const saved = p26.PROBED_PREFIXES.slice();
const keep = p26.PROBED_PREFIXES.filter((x) => x !== '/policy/test-wallets.json');
p26.PROBED_PREFIXES.length = 0; p26.PROBED_PREFIXES.push(...keep);
check('mutation (entry removed): unprobed', count(), 1);
p26.PROBED_PREFIXES.length = 0; p26.PROBED_PREFIXES.push(...saved);
check('restored: unprobed', count(), 0);
process.exit(fail ? 1 : 0);
