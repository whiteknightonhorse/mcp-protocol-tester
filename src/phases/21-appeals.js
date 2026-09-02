/**
 * Phase 21 — Appeals path-parameter fuzz + liveness (Э3, Fable's audit
 * 2026-09-02, defect Д2).
 *
 * Д2 was: a malformed UUID in /appeals/:id crashed the whole Node process
 * (an uncaught PrismaClientKnownRequestError from an invalid UUID cast) —
 * every OTHER in-flight request died with it for the ~15-20s restart cycle.
 * No probe had ever hit this route: the existing fuzz phase (9.5) only
 * targets the single tool-call endpoint, and there is no route inventory
 * anywhere in this tester. This phase is that inventory's first entry.
 *
 * No sacrificial identity needed — these are public, unauthenticated GETs.
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'P21';

const BAD_IDS = [
  'not-a-uuid',
  '../../etc/passwd',
  "' OR 1=1 --",
  '00000000-0000-0000-0000-00000000000Z', // right shape, invalid hex char
  '<script>alert(1)</script>',
];

async function crashProbe(scorer, config, path, badId) {
  const url = `${config.apiBaseUrl}${path}${encodeURIComponent(badId)}`;
  const t0 = Date.now();
  let r;
  try {
    r = await sf(url, {}, 5000);
  } catch (e) {
    // A network-level exception here (not sf()'s own timeout sentinel) IS
    // the crash signature Д2 was — treat it as RED, not a transport pass.
    scorer.redRec(PHASE, `21.1 ${path}<bad-uuid> handled`, '4xx <2s', 'exception', false, e.message.slice(0, 100));
    return;
  }
  const elapsed = Date.now() - t0;
  await drain(r);
  const is4xx = r.status >= 400 && r.status < 500;
  const fast = elapsed < 2000;
  // RED: this is exactly the crash-class defect Fable's verdict layer
  // exists to fail the whole run over, independent of score.
  scorer.redRec(PHASE, `21.1 ${path}<bad-uuid> handled`, '4xx <2s', `${r.status} in ${elapsed}ms`,
    is4xx && fast, is4xx ? (fast ? 'handled fast' : 'handled but slow — possible stress on the process') : 'CRITICAL: not a clean 4xx');
}

module.exports = async function phase21(scorer, config, context) {
  console.log('\n--- Phase 21: Appeals fuzz + liveness ---');

  for (const path of ['/appeals/', '/api/v1/appeals/']) {
    for (const badId of BAD_IDS) {
      await crashProbe(scorer, config, path, badId);
    }
  }

  // 21.2 — liveness immediately after every hostile appeal probe above.
  // Д2's real damage was collateral: the crash took down every other
  // in-flight request, not just the appeals one. A malformed-UUID probe
  // that leaves the SERVER dead is a distinct, worse failure than one that
  // just 4xx's on its own request — this is what actually catches that.
  const t0 = Date.now();
  try {
    const rLive = await sf(`${config.apiBaseUrl}/`, {}, 5000);
    const elapsed = Date.now() - t0;
    const alive = rLive.status > 0 && rLive.status < 500 && elapsed < 3000;
    scorer.redRec(PHASE, '21.2 liveness after appeals fuzz', 'alive <3s', `${rLive.status} in ${elapsed}ms`,
      alive, alive ? 'server survived the fuzz batch' : 'CRITICAL: server appears down/degraded after appeals fuzz');
    await drain(rLive);
  } catch (e) {
    scorer.redRec(PHASE, '21.2 liveness after appeals fuzz', 'alive <3s', 'exception', false, e.message.slice(0, 100));
  }

  console.log('  Appeals fuzz complete');
};
