/**
 * Phase 34 — Legal registry integrity + terms-gate 428 contract (T-0348).
 *
 * 34.1 /legal/index.json sha256 values must match the bytes actually served.
 * 34.2 A merchant that has not accepted the current documents is refused on a
 *      gated path (quote creation) with a machine-readable 428.
 *
 * Correction to the card text, found by reading src/shop/auth/terms.guard.ts:
 * a missing acceptance only becomes a 428 once the document is OVERDUE, i.e.
 * more than 30 days past its effective_from (REACCEPT_WINDOW_MS). Inside the
 * window the gate lets the call through and only attaches a
 * terms_update_pending banner. The registry bumped to 1.2 on 2026-10-12, so
 * the test shop (still on 1.1) cannot return 428 before 2026-11-11. The probe
 * therefore derives the expected outcome from the live index: before the
 * window closes it asserts the gate is NOT refusing (and says when the 428
 * becomes reachable); afterwards it requires the 428 contract. The probe is a
 * quote for a nonexistent SKU: the gate runs first, nothing is created, and
 * no order or paid provider call is possible.
 */
const { createHash } = require('crypto');
const { sf } = require('../lib/http');

const PHASE = 'P34';
const WINDOW_MS = 30 * 24 * 3600 * 1000;
const UNACCEPTED_SLUG = process.env.TERMS_TEST_SHOP_SLUG || 'opus-test-shop';
const ACCEPTED_SLUG = 'apibase-demo';
const BOGUS_SKU = 'tester-p34-nonexistent-sku';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Returns the list of contract violations of a 428 body ([] = conforming).
function check428Body(body, index) {
  const bad = [];
  if (!body || typeof body !== 'object') return ['body is not a JSON object'];
  if (body.error_code !== 'terms_not_accepted') bad.push(`error_code=${body.error_code}`);
  if (typeof body.suggested_action !== 'string') bad.push('no suggested_action');
  if (typeof body.documentation_url !== 'string') bad.push('no documentation_url');
  if (!Array.isArray(body.docs) || body.docs.length === 0) return [...bad, 'docs[] missing or empty'];
  for (const d of body.docs) {
    for (const f of ['doc_id', 'version', 'sha256', 'url']) {
      if (typeof d?.[f] !== 'string') bad.push(`docs[].${f} missing`);
    }
    const ref = index.find((x) => x.doc_id === d?.doc_id);
    if (!ref) bad.push(`docs[] names ${d?.doc_id} which is not in /legal/index.json`);
    else if (ref.sha256 !== d.sha256 || ref.version !== d.version) bad.push(`docs[] ${d.doc_id} disagrees with the index`);
  }
  return bad;
}

async function quoteProbe(config, slug) {
  const r = await sf(`${config.apiUrl}/shop/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchant: slug, items: [{ sku: BOGUS_SKU, qty: 1 }] }),
  });
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body };
}

module.exports = async function phase34(scorer, config) {
  console.log('\n--- Phase 34: Legal registry + 428 gate ---');
  const base = config.apiBaseUrl;

  // 34.0 — control: the 428 validator must reject a body without machine fields.
  const ctl = check428Body({ error_code: 'terms_not_accepted', message: 'accept the terms' }, []);
  scorer.rec(PHASE, '34.0 self-test: non-machine-readable 428 body is caught', '>=1 violation', `${ctl.length}`, ctl.length >= 1);

  // 34.1 — index vs served bytes.
  let index = [];
  try {
    const r = await sf(`${base}/legal/index.json`);
    const ct = r.headers?.get?.('content-type') || '';
    index = r.status === 200 ? await r.json() : [];
    scorer.rec(PHASE, '34.1 /legal/index.json', '200 JSON array', `${r.status} ${Array.isArray(index) ? index.length : 'not array'} docs`,
      r.status === 200 && ct.includes('json') && Array.isArray(index) && index.length >= 4);
  } catch (e) {
    scorer.recCatch(PHASE, '34.1 /legal/index.json', '200', e);
    return;
  }
  if (!Array.isArray(index)) return;
  for (const d of index) {
    try {
      // Registry docs are hashed over the markdown source (/legal/<id>.md);
      // terms/privacy are hashed over the served static HTML.
      const path = d.registry === false ? d.url : `${d.url}.md`;
      const r = await sf(`${base}${path}`);
      const got = r.status === 200 ? sha(Buffer.from(await r.arrayBuffer())) : `HTTP ${r.status}`;
      scorer.rec(PHASE, `34.1 sha256 of ${path}`, d.sha256, got, got === d.sha256);
    } catch (e) {
      scorer.recCatch(PHASE, `34.1 sha256 of ${d.url}`, d.sha256, e);
    }
  }

  // 34.2 — the gate.
  try {
    const registry = index.filter((d) => d.registry !== false && d.effective_from);
    const now = Date.now();
    const overdue = registry.filter((d) => now - Date.parse(d.effective_from) > WINDOW_MS);
    const firstOverdue = registry.map((d) => Date.parse(d.effective_from) + WINDOW_MS).sort((a, b) => a - b)
      .find((t) => t > now);

    const demo = await quoteProbe(config, ACCEPTED_SLUG);
    scorer.rec(PHASE, `34.2 control: ${ACCEPTED_SLUG} (accepted) is not gated`, 'not 428/410',
      String(demo.status), demo.status !== 428 && demo.status !== 410);

    const t = await quoteProbe(config, UNACCEPTED_SLUG);
    if (overdue.length > 0) {
      const bad = t.status === 428 ? check428Body(t.body, index) : [`status ${t.status}`];
      scorer.redRec(PHASE, `34.2 ${UNACCEPTED_SLUG} without current acceptance -> 428 machine-readable`, '428 + docs[] matching index',
        t.status === 428 && bad.length === 0 ? '428 ok' : bad.join('; '), t.status === 428 && bad.length === 0,
        `overdue docs: ${overdue.map((d) => d.doc_id).join(', ')}`);
    } else {
      scorer.rec(PHASE, `34.2 ${UNACCEPTED_SLUG} inside the 30-day re-accept window is not refused`, 'not 428/410',
        String(t.status), t.status !== 428 && t.status !== 410 && t.status < 500,
        `428 contract not reachable yet: first document goes overdue ${firstOverdue ? new Date(firstOverdue).toISOString() : 'n/a'}; ` +
        'from then this probe requires the 428 body');
    }
  } catch (e) {
    scorer.recCatch(PHASE, '34.2 terms gate', '428 or window pass-through', e);
  }
};
