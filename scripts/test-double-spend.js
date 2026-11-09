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
// T-0714: 8.2 shape (10 responses, one payment): same classifier.
const nine = Array.from({ length: 9 }, () => dd(R1));
v = classifyDoubleSpend([ch(R1), ...nine]);
assert.deepStrictEqual([v.charged, v.replays, v.red], [1, 9, false]);
assert.strictEqual(classifyDoubleSpend([ch(R1), ch(R1), ...nine.slice(0, 8)]).red, true);
assert.strictEqual(classifyDoubleSpend([{ charged: null, receipt: R1 }, { charged: undefined, receipt: R1 }]).red, true);
console.log('PASS 8.2 fixtures (1 charged + 9 replays PASS; 2 charged FAIL; missing header = charged)');
// T-0717: all-replay run (earlier identical payment inside the dedup window) is INCONCLUSIVE, not red.
const tenDd = Array.from({ length: 10 }, () => dd(R1));
v = classifyDoubleSpend(tenDd);
assert.deepStrictEqual([v.charged, v.replays, v.red, v.inconclusive], [0, 10, false, true]);
assert.ok(/payment unused/.test(v.note));
assert.strictEqual(classifyDoubleSpend([dd(R1), dd(R2)]).red, true); // distinct receipts, none charged: still red
assert.strictEqual(classifyDoubleSpend([ch(R1), ...nine]).inconclusive, false);
console.log('PASS T-0717 fixtures (10 x charged:false same receipt = INCONCLUSIVE, not red; T-0714 rules unchanged)');
