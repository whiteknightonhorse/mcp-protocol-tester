// T-0676 self-test: 18.12 classifier.
const assert = require('assert');
const { classifyDoubleSpend } = require('../src/lib/double-spend');
const R1 = 'https://apibase.pro/receipt/aaa', R2 = 'https://apibase.pro/receipt/bbb';
const ch = (r) => ({ charged: null, receipt: r });
const dd = (r) => ({ charged: 'false', receipt: r });
let v = classifyDoubleSpend([ch(R1), dd(R1), dd(R1), dd(R1), dd(R1), dd(R1)]);
assert.deepStrictEqual([v.charged, v.replays, v.red], [1, 5, false]);
v = classifyDoubleSpend([dd(R1), ch(R1)]);
assert.deepStrictEqual([v.charged, v.replays, v.red], [1, 1, false]);
assert.strictEqual(classifyDoubleSpend([ch(R1), ch(R1)]).red, true);
assert.strictEqual(classifyDoubleSpend([ch(R1), ch(R2)]).red, true);
assert.strictEqual(classifyDoubleSpend([ch(R1), dd(R2)]).red, true);
assert.strictEqual(classifyDoubleSpend([ch(R1)]).red, false);
assert.strictEqual(classifyDoubleSpend([]).red, false);
console.log('PASS double-spend classifier (7 fixtures)');
