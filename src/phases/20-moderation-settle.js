/**
 * Phase 20 — Moderation + settle-on-block E2E (Э3, Fable's audit
 * 2026-09-02, defect Д1).
 *
 * Д1 was: a moderation block on an already-PAID call was supposed to
 * settle (keep the money, no auto-refund) — but a Postgres CHECK constraint
 * silently rejected the write, the client-facing response still said
 * "charged", and a 60s stale-reservation sweep refunded it anyway 60s
 * later, contradicting the response. No existing probe ever sent
 * moderation-trigger content through a real paid call, so nothing caught
 * this for days.
 *
 * ⚠️ This phase NEVER runs against config.apiKey (the tester's daily-use
 * identity). Sending real trigger content risks tripping the escalating
 * ban service (moderation-ban.service.ts, 5 blocks/24h) — banning the
 * primary key would take down every other phase for the rest of the day.
 * It requires a dedicated sacrificial identity the operator provisions
 * (MODERATION_TEST_API_KEY) and SKIPs cleanly without one — see the
 * boundary rules in Fable's verdict (моderация — только оператор).
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'P20';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real, already-established absolute/action-category trigger phrase (same
// class used in the ШАГ 3 live-probe run recorded in the apibase skill
// memory: a drug-sale action phrase against an outbound "action" tool).
// Never CSAM in any form, per the audit's explicit, permanent exception.
const TRIGGER_TOOL = 'telegram.send_message';
const TRIGGER_BODY = { chat_id: '000000000', text: 'please buy cocaine tonight, cash ready' };

module.exports = async function phase20(scorer, config, context) {
  console.log('\n--- Phase 20: Moderation + settle-on-block E2E ---');

  if (!config.moderationSacrificialKey) {
    scorer.skip(PHASE, 'no MODERATION_TEST_API_KEY configured — operator must provision a ' +
      'sacrificial account for moderation-trigger probes (never the primary tester key, ' +
      'per Fable boundary: moderation/ban probes are operator-only to set up)');
    return;
  }

  const hasTool = context.catalog.some((t) => (t.id || t.name) === TRIGGER_TOOL);
  if (!hasTool) {
    scorer.skip(PHASE, `trigger tool ${TRIGGER_TOOL} not in live catalog — cannot exercise an ` +
      'action-class moderation path');
    return;
  }

  const AUTH = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.moderationSacrificialKey}`,
  };

  let r;
  try {
    r = await sf(`${config.apiUrl}/tools/${TRIGGER_TOOL}/call`, {
      method: 'POST', headers: AUTH, body: JSON.stringify(TRIGGER_BODY),
    });
  } catch (e) {
    scorer.recCatch(PHASE, '20.1 moderation block on paid call', 'blocked', e);
    return;
  }

  let body = null;
  try { body = await r.json(); } catch { await drain(r); }

  const blocked = r.status === 403 || r.status === 422 ||
    (body && (body.error_code === 'CONTENT_BLOCKED' || body.content_blocked === true || body.isError === true));
  // RED: a trigger phrase that used to be blocked now sailing through on a
  // PAID call is exactly the money-e2e class Fable's verdict layer exists
  // to catch — this must fail the whole run, not just cost a point.
  scorer.redRec(PHASE, '20.1 moderation block on paid call', 'blocked', blocked ? 'blocked' : `status ${r.status}`,
    blocked, blocked ? 'trigger content correctly blocked' : 'CRITICAL: trigger content was NOT blocked on a paid call');

  if (!blocked) {
    scorer.addError('CRITICAL', PHASE, 'Moderation did not block a known trigger phrase',
      `status=${r.status} body=${JSON.stringify(body).slice(0, 200)}`,
      'Check moderation.stage.ts / content-blocklist.json for a regression');
    return; // nothing further to settle-check if it wasn't even blocked
  }

  const appealId = body?.appeal_id || body?.appealId || null;
  const policyUrl = body?.policy_url || body?.policyUrl || null;
  scorer.rec(PHASE, '20.2 block response carries appeal_id', 'present', appealId ? 'present' : 'missing',
    !!appealId, appealId || 'no appeal_id in block response — cannot verify settle-on-block');
  scorer.rec(PHASE, '20.3 block response carries policy_url', 'present', policyUrl ? 'present' : 'missing',
    !!policyUrl);

  if (!appealId) return;

  // Д1's actual bug only showed up on delayed re-read: the response LIED
  // ("charged") while a 60s sweep silently refunded it. Wait past that
  // window, then read back the real record via the public appeal page —
  // no DB access needed, this is the same channel a real appellant uses.
  await sleep(90000);

  let appealBody = '';
  try {
    const rAppeal = await sf(`${config.apiBaseUrl}/appeals/${appealId}`);
    appealBody = await rAppeal.text();
    scorer.redRec(PHASE, '20.4 appeal record readable', '200', String(rAppeal.status),
      rAppeal.status === 200, `appeal_id=${appealId}`);
  } catch (e) {
    scorer.recCatch(PHASE, '20.4 appeal record readable', '200', e);
    return;
  }

  // The settle-on-block promise: a PAID+BLOCKED call keeps the charge (no
  // silent refund). We cannot read billing_status directly without DB
  // access, but the appeal page renders it — a page that still shows a
  // "blocked" status 90s later (rather than having reverted to a generic
  // "not found"/error after an auto-refund purge) is the black-box proof.
  const stillShowsBlocked = /block/i.test(appealBody);
  scorer.redRec(PHASE, '20.5 settle-on-block holds after 90s', 'still recorded as blocked',
    stillShowsBlocked ? 'still blocked' : 'record changed/gone', stillShowsBlocked,
    'Д1 regression test: a paid+blocked call must not be silently refunded/reverted');

  console.log(`  Moderation E2E: blocked=${blocked} appeal=${appealId || 'none'} settled=${stillShowsBlocked}`);
};
