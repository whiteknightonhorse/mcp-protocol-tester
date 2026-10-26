#!/usr/bin/env node
// T-0529 self-test: era classification with three fake responses, plus the P4 helper predicates.
const assert = require('assert');
const e = require('../src/lib/mcp-era');

const modern = { status: 200, body: { result: { resultType: 'complete', tools: [] } } };
const other = { status: 400, body: { error: { code: -32022, message: 'unsupported', data: { supported: ['2027-01-01'] } } } };
const legacy = { status: 400, body: { error: { code: -32600, message: 'Bad Request: Server not initialized' } } };

assert.deepStrictEqual(e.classifyEra(modern), { era: 'modern', supported: [] });
assert.deepStrictEqual(e.classifyEra(other), { era: 'modern-other-version', supported: ['2027-01-01'] });
assert.strictEqual(e.classifyEra(legacy).era, 'legacy');
assert.strictEqual(e.classifyEra({ status: 200, body: { result: { tools: [] } } }).era, 'legacy'); // 200 without resultType
assert.strictEqual(e.classifyEra({ status: -1, body: {} }).era, 'legacy');

assert.strictEqual(e.advertisesModern({ protocolVersions: ['2025-11-25', '2026-07-28'] }), true);
assert.strictEqual(e.advertisesModern({ protocolVersion: '2025-11-25' }), false);
assert.strictEqual(e.advertisesModern(null), false);

assert.strictEqual(e.cachingOk({ ttlMs: 300000, cacheScope: 'public' }), true);
assert.strictEqual(e.cachingOk({ ttlMs: '300000', cacheScope: 'public' }), false);
assert.strictEqual(e.cachingOk({ ttlMs: 0, cacheScope: 'private' }), false);
assert.strictEqual(e.cachingOk({ ttlMs: 5, cacheScope: 'world' }), false);

const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"elicitation/create","id":1}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n';
assert.deepStrictEqual(e.headlessViolations(e.parseMessages(sse, 'text/event-stream')), ['elicitation/create']);
assert.deepStrictEqual(e.headlessViolations([{ result: { resultType: 'input_required' } }]), ['input_required']);
assert.deepStrictEqual(e.headlessViolations([{ result: { content: [] } }]), []);

console.log('mcp-era self-test: OK');
