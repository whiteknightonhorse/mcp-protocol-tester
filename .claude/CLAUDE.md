# mcp-protocol-tester — Project Rules

## Language
- All code, comments, commits, README, docs: **English only**
- Chat with user: Russian

## CodeQL Rules (MANDATORY — violations cause CI failure)

1. **Never use `.includes()` for URL validation** → use `===` exact match
2. **Never `console.log()` with HTTP response data** → use `scorer.rec()` which sanitizes
3. **Never hardcode API keys** → generate dynamically: `'ak_test_' + '0'.repeat(32)`
4. **Never reference `privateKey`/`secret`/`password` in console.log** → assign to variable first
5. **All output goes through `sanitize()` in `src/lib/scoring.js`** — masks 0x addresses, tokens, keys

## File Structure
- Phases: `src/phases/NN-name.js` — export `async function(scorer, config, context)`
- Phase ID: `'P0'` through `'P19'` — must match WEIGHTS in `reporter.js`
- WEIGHTS single source of truth: `src/lib/reporter.js`
- Report phase is ALWAYS last (highest P number)

## Testing Conventions
- `scorer.rec()` for important tests (with console output)
- `scorer.recQ()` for bulk scans (silent)
- `scorer.addError()` for server bugs (severity: CRITICAL/HIGH/MEDIUM/LOW)
- `scorer.addRec()` for improvement suggestions
- HTTP responses: always `await drain(r)` after reading body
- Rate limits: `await sleep(getDelay(toolId))` between tool calls
- 429 retry: `await sleep(10000)` then retry once

## Git Rules
- Author: `Claude <noreply@anthropic.com>`
- Push: token → push → remove token (never leave token in remote URL)
- Security check before every commit (no secrets in src/)

## API Conventions
- Tool call endpoint: `/api/v1/tools/{id}/call` (NOT `/run`)
- Catalog: `GET /api/v1/tools?limit=1000` (single request)
- Auth: `Authorization: Bearer {api_key}` or `X-API-Key: {api_key}`
- No agent registration endpoint (auto-registration by API key)

## Common Mistakes (never repeat)
- `status: 'TMO'` → use `status: 0` with `_timeout: true`
- `Math.random()` for RPC ID → use monotonic counter
- Weights in two files → only in `reporter.js`
- `?page=N` pagination → `?limit=1000`
- Phase 0 skipped → empty catalog → misleading results (Phase 0 always runs)
