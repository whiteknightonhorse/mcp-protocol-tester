# Adding New Test Phases

## Phase Structure

Each phase is a module in `src/phases/` that exports a single async function:

```javascript
module.exports = async function phaseN(scorer, config, context) {
  console.log('\n== PHASE N: YOUR PHASE NAME ==\n');

  // Your test logic here
  scorer.rec('PN', 'N.1 Test name', 'expected', 'actual', isPass, 'details');
};
```

## Parameters

- `scorer` — `Scorer` instance from `lib/scoring.js`
  - `scorer.rec(phase, name, exp, got, ok, detail)` — record with console output
  - `scorer.recQ(phase, name, exp, got, ok, detail)` — record silently (bulk tests)
  - `scorer.addError(severity, phase, title, detail, fix)` — add error for report
  - `scorer.addRec(category, title, detail)` — add recommendation
- `config` — configuration from `lib/config.js`
  - `config.apiBaseUrl`, `config.apiUrl`, `config.apiKey`, etc.
- `context` — shared state between phases
  - `context.catalog` — tool list from P0
  - `context.hasMPP`, `context.hasX402` — detection flags
  - `context.balBase`, `context.balTempo` — wallet balances
  - `context.spentX402`, `context.spentMPP` — cumulative spend
  - `context.freshAuth` — headers with fresh API key

## Steps to Add a Phase

1. Create `src/phases/NN-your-phase.js`
2. Import in `src/index.js`:
   ```javascript
   const phaseN = require('./phases/NN-your-phase');
   ```
3. Add to the phase runner:
   ```javascript
   if (config.phaseEnabled(N)) await phaseN(scorer, config, context);
   ```
4. Update weight in `lib/reporter.js` weights array
5. Update README.md phase table

## Available Libraries

```javascript
const { sf, drain, getDelay } = require('../lib/http');
const { getMppClient, parseMppChallenge } = require('../lib/mpp-client');
const { makeX402Payment, getWalletAddress } = require('../lib/x402-client');
const { mcpRequest } = require('../lib/mcp-client');
const { getBody, shouldSkip } = require('../utils/assert');
const { chargeOnce, obtainCredential, sendWithCredential, runMppxValidate } = require('../lib/mpp-pay');
```

### Legacy-client lane and `mppx validate` (T-0433)

- `getMppClient(false)` is the current mppx (0.13.x); `getMppClient(true)` is the
  pinned old client (`"mppx-legacy": "npm:mppx@0.8.19"` in package.json, loaded as
  `mppx-legacy/client`). Neither client sets `currencies`: the server must pin the
  currency, the client follows the challenge.
- `chargeOnce(client, url, headers, body, headerName)` runs probe -> `createCredential`
  -> send and returns the credential, so a phase can replay it or move it to
  `Payment-Authorization`.
- `runMppxValidate(baseUrl, toolId)` runs `mppx validate` as a child process (argv
  array, no shell, no wallet env, throwaway HOME, scoped by `--endpoint`) and
  returns the parsed JSON. Treat a spawn failure with `scorer.recCatch`.

## Conventions

- Phase ID format: `PN` (e.g., `P7` for security)
- Test ID format: `N.X description` (e.g., `7.1 No auth → 401`)
- Use `rec()` for important tests, `recQ()` for bulk scans
- Always `await drain(r)` after reading response body
- Always `await sleep(getDelay(toolId))` between tool calls
- Tool-definition fingerprint contract (T-0500): `definition_sha256 = sha256hex(stable({id, description, input_schema}))`; `stable()` in `src/phases/04-mcp-protocol.js` is the canonical JSON (keys sorted recursively, no whitespace)

## Э1/Э3 additions (Fable's audit, 2026-09-02)

- `scorer.redRec(phase, name, exp, got, ok, det)` — same as `rec()`, but a
  failure here makes the WHOLE RUN's verdict FAIL regardless of score. Use
  only for: a money e2e path, a crash/liveness check, a public 404 on a
  real surface, or a catalog-sanity precondition everything else depends
  on. Reclassifying an EXISTING probe's severity to/from RED needs Fable's
  sign-off (see the boundary table in her verdict) — this is only for
  probes a phase adds specifically as RED-class from the start.
- `scorer.recCatch(phase, name, exp, e, det)` — use inside a `catch` block
  instead of hand-writing `ok=true`. It only passes if the exception is a
  genuine transport-level rejection (`net-error.js`'s `isDeadServerError()`
  says no) — a dead server / timeout can no longer be scored as a pass just
  because something threw.
- A real HTTP status is never `-1` — that is `sf()`'s own dead-server/
  timeout sentinel (`src/lib/http.js`). Passing `r.status` straight through
  as `got` already gets this handled centrally in `scoring.js`'s `rec()`;
  you don't need to check `r._timeout` yourself at the call site.
- `pickSafeProbeTool(catalog)` (`utils/assert.js`) — use this instead of
  `catalog[0]` whenever a phase needs "any safe tool to call". `catalog[0]`
  can require a param `getBody()` doesn't know how to fill, which fails
  schema validation before your probe ever reaches the behavior you meant
  to test.
- P20-P26 (Э3) each gate on an operator-provisioned identity
  (`config.moderationSacrificialKey` / `balanceRailTestKey` / `deviceTestKey`)
  and `scorer.skip(...)` cleanly without one — NEVER fall back to
  `config.apiKey` for a moderation-trigger, balance-funding, or device
  probe. See Fable's boundary table: those are operator-only to provision.
- A phase whose real-world defect doesn't reproduce on live prod anymore
  (fixed independently before your pass landed) should still ship a
  synthetic-fixture self-test proving the DETECTOR works (same discipline
  as the CI dual-stub in `scripts/test-verdict-fixtures.js`), rather than
  either skipping the phase or fabricating a fake live failure.

## MCP era probe in P4 (T-0529)

An extension of phase 04, not a new phase. A server's MCP era is recorded, not assumed.
Vocabulary: `modern` (revision 2026-07-28: no `initialize`, no session, `_meta`
`io.modelcontextprotocol/protocolVersion` per request), `modern-other-version` (400 with
JSON-RPC `-32022`, `data.supported` read), `legacy` (initialize + session id).
Checks: `4.E1` era probe, `4.E2` `server/discover`, `4.E3` `ttlMs`/`cacheScope` on tools/list,
`4.E4` header/`_meta` version mismatch (`-32020`), `4.E5` headless safety (no `input_required`,
no server-initiated `elicitation/create`).
RED-capable only when the server's `/.well-known/mcp.json` lists 2026-07-28 (E1 must be `modern`,
E3 required); otherwise E1/E3 are informational (recorded, pass). A check that cannot apply in the
detected era (E2, E4 in legacy) is marked n/a with `scorer.blocked(phase, name, 'era-<era>', ...)`,
not scored 0. No payment is made: E5 uses an unpaid call. Pure helpers: `src/lib/mcp-era.js`;
self-test with three fake responses: `npm run test:era` (`scripts/test-mcp-era.js`).

## Annotation honesty (P36, T-0858)

P36 is a static check: it reads `tools/list` (the configured `MCP_SERVER_URL` as is, `nextCursor` followed, plus every URL in `ANNOTATION_EXTRA_MCP_URLS`; on apibase.pro with the variable unset, the storefront list P27 uses) and compares each tool's declared `readOnlyHint` / `destructiveHint` with what its name, description and input schema say. It never calls a tool. Rules live in `src/lib/annotation-rules.js` (pure, target-agnostic); fixtures in `scripts/test-annotation-rules.js`.

- Verb classes (name tokens split on `.` `_` `-` and camelCase; the last matching token wins): MONEY (pay, refund, transfer, withdraw, payout, charge, purchase, buy), DELETE (delete, remove, purge, revoke, cancel, deactivate, destroy, drop), SEND (send, sms, email, notify, publish, post, command), WRITE (create, update, set, upsert, register, submit, write, upload, add, place). `email` and `sms` are skipped (nouns, not verbs) when the last name token is in READ_LAST (get, list, search, check, status, estimate, validate, verify, lookup, find, read, query, info, count); `place` counts only when another token follows it in the same dot-segment (`place_order` yes, `geonames.place.search` and `get_place` no). When no name token matches, a schema property (amount, to, recipient, tx_hash, body, message) together with a class verb as the first word of a sentence of the description (sentences split on a newline or on `.` `!` `?` followed by whitespace), or a class verb opening the description, gives an inferred class.
- RED (`redRec`, 36.2, one per list): the class comes from the NAME, is MONEY or DELETE, and the tool declares `readOnlyHint: true` (write-as-readonly) or an explicit `destructiveHint: false` (irreversible-as-additive). RED for P36 was signed off in TOOL-ANNOTATIONS-1116 ruling-1; do not widen it or add a per-target allowlist.
- Yellow (36.3): SEND tool declared additive or any SEND/WRITE tool declared read-only (a send cannot be recalled, so it is never RED), the RED conditions inferred only from schema or description, missing hints, a hint that is not a boolean.
- 36.4 is a coverage line and always passes.
- `ANNOTATION_EXTRA_MCP_URLS`: comma list; unset = default by host, empty = no extra list.
