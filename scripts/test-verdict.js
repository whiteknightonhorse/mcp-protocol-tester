// Self-test: the verdict layer (docs/SCORING.md rules a-d) on synthetic scorers. No network.
const { Scorer } = require('../src/lib/scoring');

const TODAY = '2026-10-26';
const daysAgo = (n) => new Date(Date.parse(TODAY) - n * 86400000).toISOString().slice(0, 10);

function scorer(fn) {
  const s = new Scorer();
  s.rec('P0', 'catalog-complete', 5, 5, true, 'loaded=5 total=5');
  s.rec('P7', 'no-auth-rejected', '402', '402', true);
  if (fn) fn(s);
  return s;
}

const cases = [
  ['clean run -> PASS', scorer(), {}, 'PASS', null],
  ['(a) failing assertion in the ledger for 4 days, no owner -> FAIL naming it',
    scorer((s) => s.rec('P7', 'empty-auth-header', '402', '400', false)),
    { ledger: { 'P7|empty-auth-header': { first_seen: daysAgo(4) } } }, 'FAIL', /standing red.*P7\|empty-auth-header \(4d, owner UNASSIGNED\).*unowned: P7\|empty-auth-header/],
  ['(a) owned standing red is still FAIL',
    scorer((s) => s.rec('P7', 'empty-auth-header', '402', '400', false)),
    { ledger: { 'P7|empty-auth-header': { first_seen: daysAgo(4), owner: 'T-0563' } } }, 'FAIL', /owner T-0563/],
  ['(a) 1-day-old red is not yet a standing red',
    scorer((s) => s.rec('P7', 'empty-auth-header', '402', '400', false)),
    { ledger: { 'P7|empty-auth-header': { first_seen: daysAgo(1) } } }, 'PASS', null],
  ['(a) ledger entry that no longer fails is ignored', scorer(), { ledger: { 'P7|gone': { first_seen: daysAgo(9) } } }, 'PASS', null],
  ['(b) BLOCKED in a money phase (P28) -> FAIL', scorer((s) => s.blocked('P28', '28.5 pay', 'SKIPPED', 'no settlement')), {}, 'FAIL', /BLOCKED check\(s\) in money phases: P28\/28.5 pay/],
  ['(b) BLOCKED in P4 (cost not $0) -> FAIL', scorer((s) => s.blocked('P4', '4.E2', 'era-legacy')), {}, 'FAIL', /P4\/4.E2/],
  ['(b) BLOCKED in a $0 non-money phase is not a reason', scorer((s) => s.blocked('P34', '34.2', 'merchant-deactivated')), {}, 'PASS', null],
  ['(c) MAX_TOOLS=300 -> FAIL catalog truncated', scorer(), { maxTools: 300 }, 'FAIL', /catalog truncated/],
  ['(d) catalog-complete red -> FAIL', scorer((s) => s.redRec('P0', 'catalog-complete', 9, 5, false, 'loaded=5 total=9')), {}, 'FAIL', /catalog-complete red: loaded=5 total=9/],
];

let bad = 0;
for (const [label, s, opts, want, re] of cases) {
  const v = s.computeVerdict({ ledger: {}, today: TODAY, maxTools: 0, ...opts });
  const text = v.reasons.join(' | ');
  const ok = v.verdict === want && (!re || re.test(text));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${v.reasons.length ? `\n     ${text}` : ''}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
