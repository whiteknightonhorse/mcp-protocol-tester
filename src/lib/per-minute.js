/**
 * T-0671: per-audio-minute pricing contract (server rule of T-0425, src/pricing/audio-minute.ts).
 * A per-audio-minute tool answers 422 schema_validation_failed naming duration_seconds when that
 * field is missing (pre-payment validation, no challenge); every other schema failure is 400.
 * Price = max($0.01, ceil(minutes) x $0.005). All probes are challenges only: $0.
 */
const { sf, drain } = require('./http');
const { parseMppChallenge } = require('./mpp-client');
const { KNOWN_PARAMS } = require('../utils/assert');

const PER_MINUTE = new Set(['transcribe.submit']);
const MAX_SECONDS = 14400;
const PRICE_PER_MINUTE = 0.005;
const MIN_PRICE = 0.01;

const formulaUsd = (seconds) => Math.max(MIN_PRICE, Math.ceil(seconds / 60) * PRICE_PER_MINUTE);

function isPerMinute(tool) {
  const id = tool?.id || tool?.name;
  if (PER_MINUTE.has(id)) return true;
  const text = `${tool?.description || ''} ${JSON.stringify(tool?.['x-payment-info'] || tool?.payment_info || '')}`;
  return /per audio minute/i.test(text);
}

// Is `body` the designed pre-payment refusal of a per-audio-minute tool (422 naming duration_seconds)?
function isDurationIssue422(status, body) {
  if (status !== 422 || !body || typeof body !== 'object') return false;
  if (body.error !== 'schema_validation_failed') return false;
  return Array.isArray(body.issues) && body.issues.some((i) => typeof i?.path === 'string'
    ? i.path.split('.').includes('duration_seconds')
    : Array.isArray(i?.path) && i.path.includes('duration_seconds'));
}

const DETAIL_422 = 'schema validation (pre-payment, per-audio-minute tool: duration_seconds required)';

async function post(config, context, id, body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = context.freshAuth || config.apiKey;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const r = await sf(`${config.apiUrl}/tools/${id}/call`, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { await drain(r); }
  return { status: r.status, www: r.headers?.get?.('www-authenticate') || '', json };
}

// The three per-minute checks for one rail ('mpp' | 'x402').
async function perMinuteChecks(scorer, PHASE, rail, config, context, tool) {
  const id = tool.id || tool.name;
  const label = `${PHASE} ${rail}-${id}`;
  try {
    // (a) {} -> 422 with the duration_seconds issue; no challenge of any kind.
    const a = await post(config, context, id, {});
    const noChallenge = !/payment/i.test(a.www) && !a.json?.accepts;
    scorer.rec(PHASE, `${label} {} -> 422 duration_seconds, no challenge`, '422 + duration_seconds issue, no 402/accepts[]/WWW-Authenticate: Payment',
      `${a.status}${noChallenge ? '' : ' with challenge'}`, isDurationIssue422(a.status, a.json) && noChallenge);

    // (b) KNOWN_PARAMS body -> 402 whose amount is the minute formula.
    const body = KNOWN_PARAMS[id];
    const secs = body?.duration_seconds ?? 600;
    const wantUsd = formulaUsd(secs);
    const b = await post(config, context, id, body);
    let got = `${b.status}`; let ok = false;
    if (rail === 'x402') {
      const accs = b.json?.accepts || [];
      const usdc = accs.find((x) => /^0x833589/i.test(x.asset || '')) || accs[0];
      const amt = Number(usdc?.maxAmountRequired ?? usdc?.amount);
      got = `${b.status} amount=${usdc ? (usdc.maxAmountRequired ?? usdc.amount) : 'n/a'}`;
      ok = b.status === 402 && amt === Math.round(wantUsd * 1e6);
    } else {
      const p = parseMppChallenge(b.www);
      const raw = p?.decoded?.amount;
      got = `${b.status} amount=${raw ?? 'n/a'}`;
      // MPP request amount is either base units (micro-USDC) or decimal USD; accept the exact value in either unit.
      const n = Number(raw);
      ok = b.status === 402 && (n === Math.round(wantUsd * 1e6) || Math.abs(n - wantUsd) < 1e-9);
    }
    scorer.redRec(PHASE, `${label} ${secs}s -> 402 amount = max($0.01, ceil(min) x $0.005)`,
      `$${wantUsd.toFixed(2)} (${secs}s = ${Math.ceil(secs / 60)} min)`, got, ok,
      ok ? 'minute formula' : 'CRITICAL: challenge amount does not follow the per-audio-minute formula');

    // (c) above the cap -> 422.
    const c = await post(config, context, id, { ...body, duration_seconds: 20000 });
    const cOk = c.status === 422 && !!c.json && c.json.error === 'schema_validation_failed' && !/payment/i.test(c.www);
    scorer.rec(PHASE, `${label} duration_seconds 20000 -> 422 (max ${MAX_SECONDS})`, '422', `${c.status}`, cOk);
    return { amountUsd: ok ? wantUsd : null };
  } catch (e) {
    scorer.recCatch(PHASE, `${label} per-minute checks`, 'a/b/c', e);
    return { amountUsd: null };
  }
}

module.exports = { PER_MINUTE, isPerMinute, isDurationIssue422, perMinuteChecks, formulaUsd, DETAIL_422 };
