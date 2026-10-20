// node --test src/lib/mpp-pay.test.mjs   (no network; the mppx binary is absent or refused before spawn)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { runMppxValidate } = createRequire(import.meta.url)('./mpp-pay.js');

test('refuses a non-https baseUrl', async () => {
  for (const u of ['http://apibase.pro', 'not a url', 'file:///etc/passwd', undefined, { href: 'https://x' }]) {
    const r = await runMppxValidate(u, 'weather.get');
    assert.equal(r.spawnFailed, true);
    assert.match(r.errMsg, /baseUrl/);
  }
});

test('refuses a toolId outside the allowed pattern', async () => {
  for (const t of ['', '-x', 'A', 'a b', 'a;rm -rf', '../x', 'a/b', 'a'.repeat(129), undefined, ['a']]) {
    const r = await runMppxValidate('https://apibase.pro', t);
    assert.equal(r.spawnFailed, true);
    assert.match(r.errMsg, /toolId/);
  }
});

test('an allowed call reaches spawn and returns the result shape without throwing', async () => {
  const r = await runMppxValidate('https://127.0.0.1:9', 'weather.get', 3000);
  assert.equal(typeof r.exitCode, 'number');
  assert.equal(typeof r.spawnFailed, 'boolean');
  assert.ok(!/^refused/.test(r.errMsg || ''));
});
