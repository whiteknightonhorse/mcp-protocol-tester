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

// g. T-0887: the ten false yellows of 2026-11-16 -> no finding (schema cases quote the live tools/list)
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const gCases = [
  { name: 'email.validation.check', annotations: RO },
  { name: 'email.verification.check', annotations: RO },
  { name: 'security.ipqs.email_check', annotations: RO },
  { name: 'email.transactional.status', annotations: RO },
  { name: 'geonames.place.search', annotations: RO },
  { name: 'geonames.place.timezone', annotations: RO },
  { name: 'norway-kartverket-stedsnavn.places.get_place', annotations: RO },
  {
    name: 'phone.telnyx.estimate',
    description: 'Classify a destination phone number into the right pricing tier (na / world / premium) and return the recommended send tool and price. Use this BEFORE telnyx.send_sms_* to avoid 400 errors. $0.001/lookup (Telnyx)',
    inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
    annotations: RO,
  },
  {
    name: 'irail.transit.connections',
    description: 'Find train connections between two Belgian railway stations — returns up to 10 journeys with departure/arrival times, total duration, delays, transfer stations (vias), train numbers, platform numbers, and cancellation flags. Supports departure or arrival time selection. No auth required. Data: iRail real-time SNCB/NMBS Belgium train data.',
    inputSchema: { type: 'object', properties: { from: {}, to: {}, timesel: {}, results: {}, date: {}, time: {}, lang: {} } },
    annotations: RO,
  },
  {
    name: 'shop.merchant.accept_terms',
    description: 'Accept the four merchant documents (merchant-agreement, aup, dpa, refund-framework) by signing the APIbase acceptance message with the merchant wallet. Activates the merchant and returns the mk_live_ API key once.',
    inputSchema: { type: 'object', properties: { wallet: {}, doc_hashes: {}, message: {}, signature: {}, method: {} } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];
for (const t of gCases) check(`g ${t.name} -> no finding`, keys(t).length === 0, keys(t));

// h. coverage that must not be lost
const hCases = [
  ['phone.telnyx.sms_na', { readOnlyHint: false, destructiveHint: false }, 'yellow:send-as-additive'],
  ['phone.twilio.sms', { readOnlyHint: true }, 'yellow:send-as-additive'],
  ['user.email', { readOnlyHint: true }, 'yellow:send-as-additive'],
  ['orders.place_order', { readOnlyHint: true }, 'yellow:send-as-additive'],
  ['shop.order.pay', { readOnlyHint: false, destructiveHint: false }, 'red:irreversible-as-additive'],
];
for (const [name, annotations, want] of hCases) check(`h ${name} -> ${want}`, keys({ name, annotations }).join() === want, keys({ name, annotations }));

// i, j. schema inference needs a class verb at the start of a sentence
const ledger = (description) => ({
  name: 'ledger.entry.record', description,
  inputSchema: { type: 'object', properties: { amount: {}, to: {} } }, annotations: { readOnlyHint: true },
});
check('i second sentence starts with a class verb -> yellow inferred', keys(ledger('Records an entry. Transfer the amount to the recipient.')).join() === 'yellow:inferred', keys(ledger('Records an entry. Transfer the amount to the recipient.')));
check('j class words inside a sentence -> none', keys(ledger('Lists entries, including each transfer and refund.')).length === 0, keys(ledger('Lists entries, including each transfer and refund.')));

if (bad) { console.error(`FAIL annotation-rules: ${bad} case(s)`); process.exit(1); }
console.log('PASS annotation-rules');
