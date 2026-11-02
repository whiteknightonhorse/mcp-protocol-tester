// T-0653 self-test: seven mutations -> seven distinct payloads, each differing from the valid one in exactly the intended field.
const assert = require('assert');
const { buildMutations, OTHER_PAYTO, OTHER_ASSET, WALLET_SIGNIN } = require('../src/lib/p18-negative');

const base = {
  x402Version: 2,
  accepted: { scheme: 'exact', network: 'eip155:8453', amount: '1000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x50EbDa9dA5dC19c302Ca059d7B9E06e264936480', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } },
  payload: { signature: '0x', authorization: { from: '0x1111111111111111111111111111111111111111', to: '0x50EbDa9dA5dC19c302Ca059d7B9E06e264936480', value: '1000', validAfter: '0', validBefore: '9999999999', nonce: '0x00' } },
};
let ctr = 0;
const rand = (n) => Buffer.alloc(n, ++ctr);
const resign = async (acc, auth) => '0x' + Buffer.from(JSON.stringify([acc, auth])).toString('hex').padEnd(130, 'a');
const second = '0x2222222222222222222222222222222222222222';

// flatten to leaf paths
const leaves = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? leaves(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
const diff = (a, b) => { const A = Object.fromEntries(leaves(a)); const B = Object.fromEntries(leaves(b)); return Object.keys({ ...A, ...B }).filter((k) => A[k] !== B[k]).sort(); };

(async () => {
  const m = await buildMutations({ base, resign, secondAddress: second, now: 1_800_000_000_000, rand });
  const nonceSig = ['payload.authorization.nonce', 'payload.signature'];
  const want = {
    N1: ['accepted.payTo', 'payload.authorization.to', ...nonceSig],
    N2: ['accepted.asset', ...nonceSig],
    N3: ['accepted.network', ...nonceSig],
    N4: ['payload.authorization.validBefore', ...nonceSig],
    N5: ['payload.authorization.validAfter', ...nonceSig],
    N6: ['payload.authorization.from', ...nonceSig],
    N7: nonceSig,
  };
  const seen = new Set();
  for (const [k, fields] of Object.entries(want)) {
    const d = diff(m.valid, m[k]);
    assert.deepStrictEqual(d, [...fields].sort(), `${k}: differs in ${d}`);
    const s = JSON.stringify(m[k]);
    assert(!seen.has(s), `${k} duplicates another payload`); seen.add(s);
    assert(m[k].payload.authorization.nonce !== m.valid.payload.authorization.nonce, `${k} reuses the nonce`);
  }
  assert.strictEqual(m.N1.accepted.payTo, OTHER_PAYTO);
  assert.strictEqual(m.N2.accepted.asset, OTHER_ASSET);
  assert.strictEqual(m.N3.accepted.network, 'eip155:84532');
  assert.strictEqual(m.N4.payload.authorization.validBefore, '1799999940');
  assert.strictEqual(m.N5.payload.authorization.validAfter, '1800003600');
  assert.strictEqual(m.N7.payload.signature.length, m.valid.payload.signature.length - 4);
  assert.strictEqual(new Set(['N1','N2','N3','N4','N5','N6','N7'].map((k) => m[k].payload.authorization.nonce)).size, 7);
  assert(WALLET_SIGNIN('example.com', '0xA', 'ab', 'T').startsWith('example.com wants you to sign in with your wallet.\n'));
  console.log('PASS p18-negative: 7 mutations, 7 distinct payloads, each differs only in the intended field');
})().catch((e) => { console.error('FAIL p18-negative:', e.message); process.exit(1); });
