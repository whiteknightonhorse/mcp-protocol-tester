#!/usr/bin/env node
// T-0678 self-test: receipt retrieve / in-flight parsers.
const rr = require('../src/lib/receipt-retrieve');
let fail = 0;
const check = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}: ${JSON.stringify(got)}`); };
const ID = '0123456789abcdef0123456789abcdef';
const rec = { receipt_id: ID, retrieve_url: `https://apibase.pro/x402/retrieve/${ID}`, payer: '0xAb', payment_tx: '0xABC' };
check('message format', rr.retrieveMessage(ID, 120000), `apibase-retrieve:${ID}:2`);
check('receipt ok', rr.parseReceipt(rec).ok, true);
check('tx lowercased', rr.parseReceipt(rec).tx, '0xabc');
check('no retrieve_url', rr.parseReceipt({ receipt_id: ID }).ok, false);
check('wrong path', rr.parseReceipt({ ...rec, retrieve_url: `https://apibase.pro/r/${ID}.json` }).ok, false);
check('id mismatch', rr.parseReceipt({ ...rec, receipt_id: 'ffff' }).ok, false);
check('null receipt', rr.parseReceipt(null).ok, false);
const body = { a: 1 };
const good = { receipt_id: ID, status: 'delivered', charged: false, result: { a: 1 } };
check('retrieve ok', rr.classifyRetrieve(200, good, body, ID).ok, true);
check('retrieve charged:true', rr.classifyRetrieve(200, { ...good, charged: true }, body, ID).ok, false);
check('retrieve 401', rr.classifyRetrieve(401, { error: 'retrieve_signature_invalid' }, body, ID).ok, false);
check('retrieve 410', rr.classifyRetrieve(410, good, body, ID).ok, false);
check('retrieve other body', rr.classifyRetrieve(200, { ...good, result: { a: 2 } }, body, ID).ok, false);
check('inflight ok', rr.classifyInFlight(409, { error: 'payment_in_flight', retry_after: 70 }).ok, true);
check('inflight retry_after<5', rr.classifyInFlight(409, { error: 'payment_in_flight', retry_after: 2 }).ok, false);
check('inflight missing retry_after', rr.classifyInFlight(409, { error: 'payment_in_flight' }).ok, false);
check('inflight wrong error', rr.classifyInFlight(409, { error: 'payment_identifier_conflict', retry_after: 9 }).ok, false);
check('inflight 200', rr.classifyInFlight(200, {}).ok, false);
process.exit(fail ? 1 : 0);
