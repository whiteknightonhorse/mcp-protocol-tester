/**
 * Phase 34 — Legal registry integrity + terms-gate 428 contract (T-0348).
 *
 * 34.1 /legal/index.json sha256 values must match the bytes actually served.
 * 34.2 (T-0602) A merchant in status `pending` (never activated) is refused on a gated path (quote creation)
 *      with a machine-readable 428 terms_not_accepted whose docs[] equal the live index (src/shop/auth/terms.guard.ts:
 *      a pending merchant is refused regardless of the 30-day window). The fixture merchant TERMS_TEST_SHOP_SLUG
 *      (default tester-terms-pending) is registered once by the tester wallet and never accepted/verified/activated
 *      (src/lib/terms-fixture.js); if registration needs input the tester lacks the check is BLOCKED(fixture-missing).
 *      T-0563: the deactivated opus-test-shop answers 410 merchant_unavailable before the terms gate, kept as its own
 *      line, as is the apibase-demo control. The probe is a quote for a nonexistent SKU: nothing is created and no
 *      order or paid provider call is possible.
 */
const { createHash } = require('crypto');
const { sf } = require('../lib/http');
const { ensureTermsFixture, quoteProbe } = require('../lib/terms-fixture');

const PHASE = 'P34';
const FIXTURE_SLUG = process.env.TERMS_TEST_SHOP_SLUG || 'tester-terms-pending';
const DEACTIVATED_SLUG = 'opus-test-shop';
const ACCEPTED_SLUG = 'apibase-demo';

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
    const demo = await quoteProbe(config, ACCEPTED_SLUG);
    scorer.rec(PHASE, `34.2 control: ${ACCEPTED_SLUG} (accepted) is not gated`, 'not 428/410',
      String(demo.status), demo.status !== 428 && demo.status !== 410);

    // T-0563: opus-test-shop is deactivated; the live answer is 410 merchant_unavailable, and that gate
    // runs before the terms gate, so the 428 contract is not reachable through this shop.
    const t = await quoteProbe(config, DEACTIVATED_SLUG);
    scorer.rec(PHASE, `34.2 ${DEACTIVATED_SLUG} deactivated shop is refused with 410 merchant_unavailable`, '410 merchant_unavailable',
      `${t.status} ${t.body?.error_code || '(no error_code)'}`, t.status === 410 && t.body?.error_code === 'merchant_unavailable',
      'the deactivated-merchant gate answers before the terms gate');

    // T-0602: the 428 contract, every day, against the never-activated (pending) fixture merchant.
    const name = `34.2 ${FIXTURE_SLUG} pending merchant -> 428 machine-readable`;
    const fx = await ensureTermsFixture(config, FIXTURE_SLUG);
    if (fx.state === 'missing') {
      scorer.blocked(PHASE, name, 'fixture-missing', `missing input: ${fx.missing}; ${fx.detail}`);
      return;
    }
    const f = await quoteProbe(config, FIXTURE_SLUG);
    const want = index.filter((d) => d.registry !== false && Date.parse(d.effective_from) <= Date.now());
    const key = (d) => `${d.doc_id}@${d.version}#${d.sha256}`;
    const bad = f.status === 428 ? check428Body(f.body, index) : [`status ${f.status}`];
    if (f.status === 428 && bad.length === 0) {
      const got = (f.body.docs || []).map(key).sort().join(',');
      const exp = want.map(key).sort().join(',');
      if (got !== exp) bad.push(`docs[] ${got} != live index ${exp}`);
    }
    scorer.redRec(PHASE, name, '428 + docs[] equal to the live index',
      bad.length === 0 ? '428 ok' : bad.join('; '), bad.length === 0,
      fx.state === 'registered' ? 'fixture registered by this run (pending, never activated)' : '');
  } catch (e) {
    scorer.recCatch(PHASE, '34.2 terms gate', '428 contract', e);
  }
};
