#!/usr/bin/env node
// T-0858: fixtures for src/lib/annotation-rules.js. Pure, no network.
const { judge, tokens } = require('../src/lib/annotation-rules');

let bad = 0;
function check(label, ok, got) {
  if (!ok) { bad++; console.error(`FAIL ${label}: ${JSON.stringify(got)}`); }
  else console.log(`PASS ${label}`);
}
const key = (f) => `${f.level}:${f.code}`;
const keys = (tool) => judge(tool).map(key).sort();
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// a. the three live definitions of 2026-11-15 (q-1 section A)
const live = [
  { name: 'shop.merchant.refund', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'shop.order.pay', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'email.transactional.send', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
];
check('a refund red irreversible-as-additive', keys(live[0]).join() === 'red:irreversible-as-additive', keys(live[0]));
check('a pay red irreversible-as-additive', keys(live[1]).join() === 'red:irreversible-as-additive', keys(live[1]));
check('a email yellow send-as-additive', keys(live[2]).join() === 'yellow:send-as-additive', keys(live[2]));

// b. same three with destructiveHint true
for (const t of live) {
  const fixed = { ...t, annotations: { ...t.annotations, destructiveHint: true } };
  check(`b ${t.name} destructive true -> no finding`, keys(fixed).length === 0, keys(fixed));
}

// c. delete tool declared read-only
const c = { name: 'db.rows.delete', annotations: { readOnlyHint: true } };
check('c db.rows.delete readOnly -> red write-as-readonly', keys(c).join() === 'red:write-as-readonly', keys(c));

// d. no-finding cases
const d1 = { name: 'polymarket.trading.cancel_order', annotations: { readOnlyHint: false, destructiveHint: true } };
check('d cancel_order destructive true -> none', keys(d1).length === 0, keys(d1));
const d2 = { name: 'books.catalog.search', annotations: READ_ONLY };
check('d books.catalog.search READ_ONLY -> none', keys(d2).length === 0, keys(d2));
const d3 = { name: 'polymarket.trading.open_orders', annotations: READ_ONLY };
check('d open_orders READ_ONLY -> none', keys(d3).length === 0, keys(d3));
check('d tokens split . _ - camelCase', tokens('shop.order-payNow_x').join() === 'shop,order,pay,now,x', tokens('shop.order-payNow_x'));

// e. no annotations
const e = { name: 'weather.current.get' };
check('e no annotations -> yellow missing-hints only', keys(e).join() === 'yellow:missing-hints', keys(e));

// f. inferred from schema + description, not red
const f = {
  name: 'ledger.entry.record',
  description: 'Transfer funds between two accounts.',
  inputSchema: { type: 'object', properties: { amount: { type: 'number' }, to: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
check('f ledger.entry.record -> yellow inferred, not red', keys(f).join() === 'yellow:inferred', keys(f));

// extra: bad-type, last token wins
check('bad-type yellow', keys({ name: 'x.y.get', annotations: { readOnlyHint: 'yes' } }).includes('yellow:bad-type'), keys({ name: 'x.y.get', annotations: { readOnlyHint: 'yes' } }));
check('SEND readOnly true -> yellow send-as-additive, never red', keys({ name: 'chat.message.send', annotations: { readOnlyHint: true } }).join() === 'yellow:send-as-additive', keys({ name: 'chat.message.send', annotations: { readOnlyHint: true } }));

if (bad) { console.error(`FAIL annotation-rules: ${bad} case(s)`); process.exit(1); }
console.log('PASS annotation-rules');
