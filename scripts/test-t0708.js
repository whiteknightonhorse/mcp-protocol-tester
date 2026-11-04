// T-0708: quote failure formatter and terms_update_pending text.
const assert = require('assert');
const { quoteGot, termsPendingText } = require('../src/lib/shop-api');
assert.strictEqual(quoteGot({ status: 201, json: { quote_id: 'q1' } }, 'q1'), '201 q1');
assert.strictEqual(quoteGot({ status: 410, json: { error_code: 'merchant_unavailable' } }, 'x'), '410 merchant_unavailable');
assert.strictEqual(quoteGot({ status: 500, json: null }, 'x'), '500 (no error_code)');
assert.strictEqual(termsPendingText({}), 'absent');
assert.strictEqual(termsPendingText({ terms_update_pending: { docs: [] } }), 'absent');
assert.strictEqual(termsPendingText({ terms_update_pending: { docs: [{ doc_id: 'ma', version: '1.5' }, { doc_id: 'aup', version: '1.5' }] } }), 'ma@1.5, aup@1.5');
console.log('test-t0708 OK');
