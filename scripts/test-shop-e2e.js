// Self-test: phase 35 spend-cap, opt-in gate, internal-wallet guard and idempotency logic with a mocked rail. No network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const e2e = require('../src/lib/shop-e2e');

let failed = 0;
function check(name, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${detail}`}`);
}

const W = '0xE03D9423D06dd5E3300Fb1c09a03ddBB5E8B274b';
const file = [{ address: W.toLowerCase(), label: 'x' }, { address: '0x46f110b1ad8195ac1e59366149dfc39e3a88638b' }];

(async () => {
  // Opt-in gate
  check('gate: SKIP_PAYMENTS=true', e2e.paidGate({ skipPayments: true, privateKey: 'k' }, { E2E_SHOP_PAID: 'true' }) === 'SKIP_PAYMENTS=true');
  check('gate: no wallet', /no wallet/.test(e2e.paidGate({ skipPayments: false, privateKey: '' }, { E2E_SHOP_PAID: 'true' })));
  check('gate: E2E_SHOP_PAID unset', e2e.paidGate({ skipPayments: false, privateKey: 'k' }, {}) === 'E2E_SHOP_PAID not set');
  check('gate: E2E_SHOP_PAID=1 is not true', e2e.paidGate({ skipPayments: false, privateKey: 'k' }, { E2E_SHOP_PAID: '1' }) === 'E2E_SHOP_PAID not set');
  check('gate: all set -> may spend', e2e.paidGate({ skipPayments: false, privateKey: 'k' }, { E2E_SHOP_PAID: 'true' }) === null);

  // Internal-wallet guard, fail-closed
  check('internal: listed (mixed case)', (await e2e.isInternalWallet(W, async () => file)).ok === true);
  const notListed = await e2e.isInternalWallet('0x1111111111111111111111111111111111111111', async () => file);
  check('internal: not listed -> refused', !notListed.ok && notListed.why === 'wallet not in internal-wallets.json');
  const down = await e2e.isInternalWallet(W, async () => { throw new Error('HTTP 503'); });
  check('internal: fetch error -> refused', !down.ok && /unreadable/.test(down.why));
  check('internal: empty file -> refused', !(await e2e.isInternalWallet(W, async () => [])).ok);
  check('internal: garbage JSON shape -> refused', !(await e2e.isInternalWallet(W, async () => 'nope')).ok);
  check('internal: no signer address -> refused', !(await e2e.isInternalWallet(undefined, async () => file)).ok);

  // Cap pre-flight and post-run
  check('cap: 0.01 + 0.01 fits', e2e.capPreflight([0.01, 0.01]).ok);
  check('cap: exactly 0.05 fits', e2e.capPreflight([0.03, 0.02]).ok);
  const over = e2e.capPreflight([0.03, 0.03]);
  check('cap: 0.06 refused with reason', !over.ok && /exceeds cap/.test(over.why));
  check('cap: a $5 quote (wrong item) refused', !e2e.capPreflight([0.01, 5]).ok);
  check('cap: NaN total refused', !e2e.capPreflight([0.01, 'x']).ok);
  check('cap: no quotes refused', !e2e.capPreflight([]).ok);
  check('post-run: 0.02 ok', e2e.capVerdict(0.01, 0.01).ok);
  check('post-run: 0.06 over cap', !e2e.capVerdict(0.03, 0.03).ok);

  // Idempotency with a mocked rail: balances in micro-USDC
  const first = { order_id: 'o1' };
  const ap = (o, b) => e2e.assertAlreadyPlaced(first, { status: 200, body_status: 'already_placed', order_id: 'o1', ...o }, b || { afterPay: 990000n, afterReplay: 990000n });
  check('placed: 200 already_placed, same order, balance unchanged', ap({}).ok);
  check('placed: second transfer detected', /second transfer/.test(ap({}, { afterPay: 990000n, afterReplay: 980000n }).problems.join()));
  check('placed: different order detected', !ap({ order_id: 'o2' }).ok);
  check('placed: status field not already_placed detected', !ap({ body_status: 'paid' }).ok);
  check('placed: 500 detected', !ap({ status: 500 }).ok);
  check('placed: missing repeat detected', !e2e.assertAlreadyPlaced(first, null, null).ok);
  const rs = (r, b) => e2e.assertReplaySafe(first, r, b || { afterPay: 1n, afterReplay: 1n });
  check('replay: 200 same order ok', rs({ status: 200, order_id: 'o1' }).ok);
  check('replay: 402 refusal ok', rs({ status: 402 }).ok);
  check('replay: 403 refusal ok', rs({ status: 403 }).ok);
  check('replay: 409 refusal ok', rs({ status: 409 }).ok);
  check('replay: 200 different order is a failure', !rs({ status: 200, order_id: 'o2' }).ok);
  check('replay: 500 is a failure', !rs({ status: 500 }).ok);
  check('replay: refusal but balance moved is a failure', !rs({ status: 402 }, { afterPay: 5n, afterReplay: 4n }).ok);

  // Order events
  const ev = (...t) => t.map((to_state, i) => ({ seq: i, to_state }));
  check('events: PAID then FULFILLED', e2e.eventsProof(ev('QUOTED', 'PAID', 'FULFILLED')).ok);
  check('events: PAID then CLOSED', e2e.eventsProof(ev('PAID', 'CLOSED')).ok);
  check('events: no PAID', !e2e.eventsProof(ev('QUOTED', 'FULFILLED')).ok);
  check('events: delivered before PAID only', !e2e.eventsProof(ev('FULFILLED', 'PAID')).ok);
  check('events: not an array', !e2e.eventsProof(undefined).ok);

  // Transfer-log payer check with a mocked reader result
  const pad = (a) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
  const log = (from, addr = e2e.USDC_BASE) => ({ address: addr, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(from), pad('0x46f110b1ad8195ac1e59366149dfc39e3a88638b')] });
  check('transfer: from == signer (mixed case)', e2e.transferFromSigner({ logs: [log(W)] }, W).ok);
  check('transfer: other payer refused', !e2e.transferFromSigner({ logs: [log('0x1111111111111111111111111111111111111111')] }, W).ok);
  check('transfer: right payer on a non-USDC contract refused', !e2e.transferFromSigner({ logs: [log(W, '0x2222222222222222222222222222222222222222')] }, W).ok);
  check('transfer: no logs refused', !e2e.transferFromSigner({ logs: [] }, W).ok);
  check('transfer: null receipt refused', !e2e.transferFromSigner(null, W).ok);

  // Receipt id extraction
  check('receipt: bare id', e2e.receiptId('abc12345XYZ') === 'abc12345XYZ');
  check('receipt: URL', e2e.receiptId('https://apibase.pro/r/abc12345XYZ.json') === 'abc12345XYZ');
  check('receipt: absent', e2e.receiptId(null) === null);

  // Target slug (E2E_SHOP_SLUG)
  const shop = require('../src/lib/shop-api');
  check('slug: unset -> apibase-demo', shop.resolveSlug(undefined) === 'apibase-demo');
  check('slug: custom slug accepted', shop.resolveSlug('my-shop-2') === 'my-shop-2');
  check('slug: path traversal falls back', shop.resolveSlug('../x') === 'apibase-demo');
  check('slug: empty falls back', shop.resolveSlug('') === 'apibase-demo');

  // Spend ledger
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
  const when = new Date('2026-10-26T06:00:00Z');
  const f = e2e.appendSpendLedger([{ runId: 'r1', rail: 'x402', spentUsd: 0.01, orderId: 'o1', receipt: 'rc1', verdict: 'ok' }], dir, when);
  e2e.appendSpendLedger([{ runId: 'r1', rail: 'mpp', spentUsd: 0.01, orderId: 'o2', receipt: 'rc2', verdict: 'ok' }], dir, when);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  check('ledger: file name spend-202610.tsv', path.basename(f) === 'spend-202610.tsv');
  check('ledger: header once, two rows', lines.length === 3 && lines[0].startsWith('ts\t') && lines[1].includes('\t0.0100\t'), lines.join('|'));
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
