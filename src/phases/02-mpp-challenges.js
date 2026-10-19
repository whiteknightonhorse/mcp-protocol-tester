/**
 * Phase 2 — MPP Challenge Scan
 * For each tool in the catalog, sends POST with freshAuth,
 * checks for WWW-Authenticate: Payment header and parses MPP challenges.
 */
const { sf, drain, getDelay } = require('../lib/http');
const { parseMppChallenge } = require('../lib/mpp-client');
const { getBody } = require('../utils/assert');

const PHASE = 'P2';
const SKIP_IDS = new Set(['health', 'agents.register', 'agents.list']);

// Source of truth for the challenge-field RED assertions below.
// EXPECTED_RECIPIENT is overridable via env — the mutation control
// (scripts/test-p2-mutation.js) flips it to a wrong address to prove the
// RED assertion is actually wired to the verdict, then restores it and
// checks green. Real environments never set this var, so it is a no-op
// everywhere except that one script.
const EXPECTED_RECIPIENT = process.env.MPP_EXPECTED_RECIPIENT_TEST_OVERRIDE
  || '0x9E29FF84B0f3EDa9756262d2F950C435495BA8cC';
const EXPECTED_CHAIN_ID = 4217;

// T-0433: the SERVER pins the payment currency in the challenge. A wrong
// token here is a money defect, so the pin is RED-class. Mainnet pays in
// USDC.e, testnet in pathUSD; equality with that one address also rules out
// OUSD or any other Tempo token.
const USDC_E_MAINNET = '0x20C000000000000000000000b9537d11c60E8b50';
const PATH_USD_TESTNET = '0x20c0000000000000000000000000000000000000';
function expectedCurrency(chainId) {
  return Number(chainId) === EXPECTED_CHAIN_ID ? USDC_E_MAINNET : PATH_USD_TESTNET;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async function phase2(scorer, config, context) {
  console.log('\n--- Phase 2: MPP Challenge Scan ---');

  const tools = context.catalog.filter(t => !SKIP_IDS.has(t.id || t.name));
  const stats = { hasMpp: 0, noMpp: 0, validChallenge: 0, schema400: 0, unavailable503: 0, errors500: 0 };
  // T-0433 aggregates: one assertion per property, offenders listed.
  const pin = { checked: 0, multi: [], wrong: [], badId: [] };

  for (const tool of tools) {
    const id = tool.id || tool.name;
    const url = `${config.apiUrl}/tools/${id}/call`;
    const headers = { 'Content-Type': 'application/json' };
    if (context.freshAuth) headers['Authorization'] = `Bearer ${context.freshAuth}`;
    else if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    let r = await sf(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(getBody(tool)),
    });

    if (r.status === 429) {
      await sleep(10000);
      r = await sf(url, { method: 'POST', headers, body: JSON.stringify(getBody(tool)) });
    }

    const wwwAuth = r.headers?.get?.('www-authenticate') || '';
    const status = r.status;
    await drain(r);

    if (status === 502 || status === 503) {
      stats.unavailable503++;
      // 502/503 = upstream/provider error, not a server bug
      scorer.recQ(PHASE, `mpp-${id}`, '402|502|503', status, true, 'upstream/provider error');
      continue;
    }

    if (status >= 500) {
      stats.errors500++;
      scorer.recQ(PHASE, `mpp-${id}`, '402', status, false, 'server error');
      scorer.addError('HIGH', PHASE, `500 on ${id}`, `Status ${status}`, 'Check server logs');
      continue;
    }

    if (status === 400) {
      stats.schema400++;
      // 400 = schema validation before payment — server correctly validates params first
      scorer.recQ(PHASE, `mpp-${id}`, '402|400', status, true, 'schema validation (pre-payment)');
      continue;
    }

    if (status === 402 && wwwAuth) {
      stats.hasMpp++;
      const parsed = parseMppChallenge(wwwAuth);
      if (parsed && (parsed.method || parsed.decoded)) {
        stats.validChallenge++;
        scorer.recQ(PHASE, `mpp-${id}`, '402+header', '402+header', true,
          `method=${parsed.method || 'n/a'}`);

        // Challenge field validation — RED-class (Fable's follow-up audit,
        // 2026-09-02): the server dictates recipient/amount/chainId in the
        // 402 challenge BEFORE any payment happens (decoded here from
        // WWW-Authenticate: Payment's base64 `request` field). "server
        // advertises someone else's address" is a real theft vector and is
        // catchable for $0 — it was previously wired to addRec() (a soft
        // recommendation), so a garbage recipient never failed the run at
        // all. This is exactly LAW#DECLARED-IS-NOT-WIRED: the check
        // existed, its verdict went nowhere.
        if (parsed.decoded) {
          const recipient = parsed.decoded.recipient;
          const recipientOk = !recipient || recipient.toLowerCase() === EXPECTED_RECIPIENT.toLowerCase();
          scorer.redRec(PHASE, `${id}: challenge recipient`, EXPECTED_RECIPIENT,
            recipient || '(none)', recipientOk,
            recipientOk ? 'matches operator wallet' : 'CRITICAL: server advertised a DIFFERENT recipient before any payment');

          // Cross-check against the tool's OWN catalog-declared price,
          // not an arbitrary absolute ceiling. Found live on the first
          // full run after making this RED: a flat "<1000000 micro-USDC
          // (<$1)" cap false-positived on aipush.setup_website ($1.00
          // exactly) and aipush.market_report ($29.99) — both real,
          // legitimately priced tools, not a malformed challenge. The
          // actual security-relevant invariant is "does the challenge
          // amount match what the catalog advertises", which is a
          // stronger check anyway (catches a tool silently overcharging
          // relative to its own listed price, not just an absolute
          // outlier). $0.0001 tolerance for rounding.
          const amount = Number(parsed.decoded.amount);
          const priceUsd = parseFloat(tool.pricing?.price_usd ?? tool.price_usd ?? 'NaN');
          let amountOk, expDesc;
          if (!isNaN(priceUsd)) {
            const expectedMicroUsd = Math.round(priceUsd * 1e6);
            amountOk = !isNaN(amount) && Math.abs(amount - expectedMicroUsd) <= 100;
            expDesc = `${expectedMicroUsd} micro-USDC (catalog price $${priceUsd})`;
          } else {
            // No catalog price to compare against — fall back to a sane
            // absolute bound (0 < amount < $1000) rather than no check.
            amountOk = !isNaN(amount) && amount > 0 && amount < 1000000000;
            expDesc = '0 < amount < 1000000000 micro-USDC (no catalog price to cross-check)';
          }
          scorer.redRec(PHASE, `${id}: challenge amount`, expDesc,
            parsed.decoded.amount, amountOk,
            amountOk ? 'matches catalog price' : 'CRITICAL: challenge amount does not match the catalog-advertised price');

          const chainId = parsed.decoded.methodDetails?.chainId;
          const chainIdOk = chainId === undefined || Number(chainId) === EXPECTED_CHAIN_ID;
          scorer.redRec(PHASE, `${id}: challenge chainId`, chainId === undefined ? 'n/a' : EXPECTED_CHAIN_ID,
            chainId === undefined ? 'n/a' : chainId, chainIdOk,
            chainIdOk ? 'targets Tempo mainnet' : 'CRITICAL: challenge targets the wrong chain');

          // T-0433 currency pin / id / expires. The decoded request carries
          // exactly one `currency` string; a list, an array or a second
          // currency field would let the client choose the token.
          pin.checked++;
          const cur = parsed.decoded.currency;
          const curKeys = Object.keys(parsed.decoded).filter((k) => /^currenc(y|ies)$/i.test(k));
          if (curKeys.length !== 1 || typeof cur !== 'string') pin.multi.push(id);
          else if (cur.toLowerCase() !== expectedCurrency(chainId ?? EXPECTED_CHAIN_ID).toLowerCase()) pin.wrong.push(`${id}:${cur}`);
          if (!parsed.id || !parsed.expires || isNaN(Date.parse(parsed.expires))) pin.badId.push(id);
        }
      } else {
        scorer.recQ(PHASE, `mpp-${id}`, 'valid-challenge', 'unparseable', false,
          `raw: ${wwwAuth.slice(0, 80)}`);
      }
    } else if (status === 402) {
      stats.noMpp++;
      scorer.recQ(PHASE, `mpp-${id}`, '402+header', '402 no header', false, 'missing WWW-Authenticate');
    } else {
      stats.noMpp++;
      scorer.recQ(PHASE, `mpp-${id}`, '402', status, status === 200, `unexpected status`);
    }

    await sleep(getDelay(id));
  }

  // T-0433 — currency pin, challenge id and expiry (RED for the pin).
  if (pin.checked > 0) {
    scorer.redRec(PHASE, '2.N challenge lists exactly one currency', '1 string currency per challenge',
      pin.multi.length ? `${pin.multi.length} offenders` : `${pin.checked}/${pin.checked} ok`, pin.multi.length === 0,
      pin.multi.slice(0, 5).join(', ') || 'single pinned currency');
    scorer.redRec(PHASE, '2.N+1 currency is USDC.e (mainnet) / pathUSD (testnet), never OUSD',
      `${USDC_E_MAINNET} (mainnet) | ${PATH_USD_TESTNET} (testnet)`,
      pin.wrong.length ? `${pin.wrong.length} offenders` : `${pin.checked}/${pin.checked} ok`, pin.wrong.length === 0,
      pin.wrong.slice(0, 3).join(', ') || 'server pins the documented token');
    scorer.rec(PHASE, '2.N+2 challenge id non-empty, expires present', 'id + ISO expires',
      pin.badId.length ? `${pin.badId.length} offenders` : `${pin.checked}/${pin.checked} ok`, pin.badId.length === 0,
      pin.badId.slice(0, 5).join(', '));
  } else {
    scorer.rec(PHASE, '2.N challenge currency pin', 'decoded challenges', 'none decoded', false,
      'no MPP challenge could be decoded, currency pin not verifiable');
  }

  // Summary record
  scorer.rec(PHASE, 'mpp-challenge-summary',
    `>${tools.length * 0.5} valid`, `${stats.validChallenge}/${tools.length}`,
    stats.hasMpp > 0,
    `mpp=${stats.hasMpp} valid=${stats.validChallenge} 400=${stats.schema400} 503=${stats.unavailable503} 5xx=${stats.errors500}`);

  if (stats.errors500 > 0) {
    scorer.addError('CRITICAL', PHASE, 'Server 500 errors during MPP scan',
      `${stats.errors500} tools returned 500`, 'Investigate server-side errors');
  }

  console.log(`  Scanned ${tools.length} tools: MPP=${stats.hasMpp} valid=${stats.validChallenge} ` +
    `400=${stats.schema400} 503=${stats.unavailable503} 5xx=${stats.errors500}`);
};
