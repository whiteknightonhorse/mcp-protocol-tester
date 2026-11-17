// T-0879: tally()/tallyText() fixtures. Plain node, no network.
const assert = require('assert');
const { tally, tallyText } = require('../src/lib/http');

const mk = (status, extra = {}) => ({ status, ...extra });

const a = [...Array(15).fill(0).map(() => mk(200)), ...Array(10).fill(0).map(() => mk(429))];
assert.strictEqual(tallyText(tally(a)), '200=15 429=10 5xx=0 tmo=0 other=0');

const b = [mk(200), mk(503), mk(-1, { _timeout: true }), mk(404)];
const tb = tally(b);
assert.ok(tallyText(tb).includes('5xx=1 tmo=1'), tallyText(tb));
assert.strictEqual(tallyText(tb), '200=1 429=0 5xx=1 tmo=1 other=1');

console.log('test-p11-tally: OK');
