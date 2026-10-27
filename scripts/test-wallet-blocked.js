// Fixture: an injected InsufficientBalance error makes the whole 5.N family BLOCKED(wallet-empty) and the
// verdict FAIL by rule (b); any other failure stays a failure. Balance pre-flight rules. No network, no spend.
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');

// Stub the mppx pieces before phase 5 loads them.
const stub = (rel, exports) => { const p = require.resolve(path.join(root, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
let mode = 'balance';
stub('src/lib/mpp-client.js', { getMppClient: () => ({ fake: true }), parseMppChallenge: () => null });
stub('src/lib/mpp-pay.js', {
  TX_HASH_RE: /^0x[0-9a-f]{64}$/,
  chargeOnce: async () => {
    if (mode === 'balance') throw new Error('InsufficientBalance: have 680, need 1000');
    return { ok: false, error: 'challenge probe returned 500', status: 500 };
  },
  obtainCredential: async () => ({ error: 'no credential' }),
  sendWithCredential: async () => { throw new Error('unused'); },
  runMppxValidate: async () => ({ spawnFailed: true, errMsg: 'stubbed' }),
});
stub('src/lib/wallet-balance.js', { walletPreflight: async () => ({ tempo: 5, base: 5, short: null }) });
stub('src/lib/http.js', { sf: async () => ({ status: 0, text: async () => '' }), drain: async () => {}, getDelay: () => 0, withTesterHeader: (h) => h });

const phase5 = require(path.join(root, 'src/phases/05-mpp-payments.js'));
const { Scorer } = require(path.join(root, 'src/lib/scoring.js'));
delete require.cache[require.resolve(path.join(root, 'src/lib/wallet-balance.js'))];
const { walletPreflight } = require(path.join(root, 'src/lib/wallet-balance.js'));

async function run(m) {
  mode = m;
  const s = new Scorer();
  await phase5(s, { skipPayments: false, privateKey: '0x01', apiUrl: 'x', apiBaseUrl: 'https://x', maxBudget: 1, apiKey: 'k' }, { catalog: [], spentMPP: 0, freshAuth: '' });
  return s;
}

(async () => {
  const s = await run('balance');
  const names = s.blockedList.filter((b) => b.world === 'wallet-empty').map((b) => b.name.split(' ')[0]);
  for (const n of ['5.N', '5.N+1', '5.N+2', '5.N+2b', '5.N+3']) assert(names.includes(n), `${n} must be BLOCKED(wallet-empty), got ${names}`);
  assert(!s.all.some((t) => /^5\.N(\+[123]b?)?$/.test(t.name.split(' ')[0])), '5.N..5.N+3 must not be recorded as rec/redRec');
  const v = s.computeVerdict({ ledger: {}, today: '2026-10-27', maxTools: 0 });
  assert.strictEqual(v.verdict, 'FAIL');
  assert(/BLOCKED check\(s\) in money phases: .*P5\/5\.N /.test(v.reasons.join('|')), 'rule (b) names P5/5.N');
  console.log('OK  injected InsufficientBalance: 5.N..5.N+3 BLOCKED(wallet-empty), verdict FAIL by rule (b)');
  console.log('    ' + v.reasons.find((r) => r.includes('BLOCKED')).slice(0, 160));

  const o = await run('other');
  assert(o.all.some((t) => t.name.startsWith('5.N mppx') && !t.ok), 'non-balance error stays a 5.N failure');
  assert(!o.blockedList.some((b) => b.name.startsWith('5.N mppx')), 'non-balance error is never BLOCKED');
  console.log('OK  non-balance error stays a failure');

  // pre-flight: floor warning, per-run need, unknown
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  const mk = (t, b) => async (rail) => (rail === 'tempo' ? t : b);
  let r = await walletPreflight({ privateKey: 'k' }, 'tempo', mk(0.02, 3));
  console.log = orig;
  assert(logs.some((l) => l.includes('wallet-balance: tempo=0.0200 base=3.0000')));
  assert(logs.some((l) => l.includes('[WARN] wallet below floor, ask the operator to refill to $5')));
  assert(r.short && /0\.035/.test(r.short));
  console.log = (...a) => logs.push(a.join(' '));
  r = await walletPreflight({ privateKey: 'k' }, 'base', mk(null, 0.02));
  console.log = orig;
  assert(logs.some((l) => l.includes('wallet-balance: tempo=unknown base=0.0200')));
  assert(r.short && /0\.03/.test(r.short));
  console.log = (...a) => logs.push(a.join(' '));
  r = await walletPreflight({ privateKey: 'k' }, 'tempo', mk(null, 9));
  console.log = orig;
  assert.strictEqual(r.short, null, 'unknown balance keeps the evidence path');
  console.log('OK  balance pre-flight: line, floor warning, per-run need, unknown');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
