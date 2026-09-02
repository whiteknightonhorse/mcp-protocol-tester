/**
 * Phase 25 — Stateful time promises (Э3, Fable's audit 2026-09-02, defect
 * Д5).
 *
 * Д5 was: the "we delete blocked content after N days" promise
 * (/policy/moderation) had a real, tested cleanup function
 * (cleanupExpiredModerationContent) that was simply never scheduled
 * anywhere — a green unit test on the producer said nothing about whether
 * the consumer (a cron entry) actually existed. This tester is itself
 * stateless between runs, so nothing had ever planted a real record and
 * come back later to check it was actually gone.
 *
 * State persists in reports/state-p25.json (untracked, local to the box —
 * same convention as the standing-red ledger). The real retention window
 * is 14 days (moderation-content-retention), so this genuinely takes ~2
 * weeks to complete one full cycle — that IS the honest shape of testing a
 * time-based promise, not a shortcut this tester is allowed to invent
 * (Fable's own boundary: no synthetic override of real retention values).
 *
 * Rides the SAME sacrificial identity as P20 (planting a checkable record
 * means triggering a real moderation block) — SKIPs cleanly without one.
 */
const fs = require('fs');
const path = require('path');
const { sf, drain } = require('../lib/http');

const PHASE = 'P25';
const RETENTION_DAYS = 14;
const STATE_PATH = path.join(__dirname, '..', '..', 'reports', 'state-p25.json');

const TRIGGER_TOOL = 'telegram.send_message';
const TRIGGER_BODY = { chat_id: '000000000', text: 'please buy heroin now, meet at the usual spot' };

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return null; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf-8'); }

module.exports = async function phase25(scorer, config, context) {
  console.log('\n--- Phase 25: Time promises (stateful) ---');

  if (!config.moderationSacrificialKey) {
    scorer.skip(PHASE, 'no MODERATION_TEST_API_KEY configured — planting a checkable expiring ' +
      'record requires the same sacrificial identity as P20 (operator-provisioned)');
    return;
  }

  const state = loadState();
  const today = new Date();

  if (state && state.appealId && !state.verified) {
    const checkAfter = new Date(state.checkAfter);
    if (today < checkAfter) {
      const daysLeft = Math.ceil((checkAfter - today) / 86400000);
      scorer.skip(PHASE, `waiting on planted record ${state.appealId} — ${daysLeft} day(s) left of the ` +
        `${RETENTION_DAYS}-day retention window (planted ${state.plantedAt})`);
      return;
    }

    // Retention window has passed — read back the SAME public appeal page
    // P20 uses and confirm the flagged content is actually gone.
    let appealBody = '';
    try {
      const r = await sf(`${config.apiBaseUrl}/appeals/${state.appealId}`);
      appealBody = await r.text();
      await drain(r);
    } catch (e) {
      scorer.recCatch(PHASE, '25.1 retention promise held', 'content gone', e);
      return;
    }
    // The matched trigger phrase itself must not still be rendered.
    const stillHasContent = appealBody.includes('heroin');
    // RED: a broken retention promise is exactly Д5 — a written, tested
    // cleanup function that nobody ever actually schedules to run.
    scorer.redRec(PHASE, '25.1 retention promise held', 'content gone after ' + RETENTION_DAYS + 'd',
      stillHasContent ? 'content still present' : 'content gone', !stillHasContent,
      `appeal_id=${state.appealId}, planted=${state.plantedAt}, checked=${today.toISOString().slice(0, 10)}`);

    state.verified = true;
    state.verifiedAt = today.toISOString();
    saveState(state);
    console.log(`  Time promises: verified retention for ${state.appealId} — content gone: ${!stillHasContent}`);
    return;
  }

  // No pending record (first run, or the last cycle just completed) — plant
  // a new one.
  if (!context.catalog.some((t) => (t.id || t.name) === TRIGGER_TOOL)) {
    scorer.skip(PHASE, `trigger tool ${TRIGGER_TOOL} not in live catalog — cannot plant a record`);
    return;
  }

  let r;
  try {
    r = await sf(`${config.apiUrl}/tools/${TRIGGER_TOOL}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.moderationSacrificialKey}` },
      body: JSON.stringify(TRIGGER_BODY),
    });
  } catch (e) {
    scorer.recCatch(PHASE, '25.2 plant expiring record', 'blocked+appeal_id', e);
    return;
  }
  let body = null;
  try { body = await r.json(); } catch { await drain(r); }
  const appealId = body?.appeal_id || body?.appealId || null;

  scorer.rec(PHASE, '25.2 plant expiring record', 'blocked+appeal_id', appealId ? 'planted' : 'no appeal_id',
    !!appealId, appealId ? `will check after ${RETENTION_DAYS} days` : 'could not plant — moderation may not have blocked this call');

  if (appealId) {
    const checkAfter = new Date(today.getTime() + (RETENTION_DAYS + 1) * 86400000); // +1 day margin
    saveState({ appealId, plantedAt: today.toISOString(), checkAfter: checkAfter.toISOString(), verified: false });
    console.log(`  Time promises: planted ${appealId}, will verify after ${checkAfter.toISOString().slice(0, 10)}`);
  }
};
