# MCP Protocol Tester — Claude Operating Rules

## Project
Automated test suite for **apibase.pro** MCP server. 20 phases, 1040+ assertions.
Tests: MCP protocol compliance, payment enforcement (x402/MPP), security, resilience.

## Rules (NON-NEGOTIABLE)

1. **Read-only against production** — NEVER modify apibase.pro server, database, or config from this repo
2. **Test-only** — this project sends HTTP requests and asserts responses. No server-side code.
3. **No secrets in code** — API keys in `.env` only, never committed
4. **No destructive tests** — no DDoS, no payload > 5MB, no more than 100 rapid requests
5. **English only** in code, comments, test descriptions

## Architecture

```
src/index.js          — main runner, loads phases, produces report
src/lib/config.js     — env config, PHASES filter, endpoints
src/lib/mcp-client.js — MCP JSON-RPC client (init → tools/call)
src/lib/helpers.js    — assertions, HTTP helpers
src/phases/           — 20 phase files (00-discovery.js through 19-cdp-facilitator.js)
reports/              — daily-YYYYMMDD.log files (auto-cleaned to 30)
run-daily.sh          — cron wrapper: git pull → npm test → report → gh issue on failure
```

## Phase Index

| Phase | File | Weight | What |
|-------|------|--------|------|
| P0 | 01-discovery.js | 4 | MCP init, tools/list, tool count |
| P1 | 02-tool-call.js | 5 | Free tool call round-trip |
| P2 | 03-schema.js | 4 | Input validation, Zod schemas |
| P3 | 04-error.js | 4 | Error codes, malformed input |
| P4 | 05-auth.js | 5 | API key validation, 401 |
| P5 | 06-payment-x402.js | 8 | x402 USDC payment flow |
| P6 | 07-payment-mpp.js | 8 | MPP Tempo payment flow |
| P7 | 08-security-basic.js | 6 | Headers, CORS, injection |
| P8 | 09-security-payment.js | 7 | Payment header manipulation |
| P9 | 10-security-advanced.js | 6 | SSRF, prototype pollution |
| P10 | 11-resilience.js | 5 | Timeout, retry, error recovery |
| P11 | 12-caching.js | 4 | Cache hit/miss, TTL |
| P12 | 13-rate-limit.js | 5 | Rate limiting enforcement |
| P13 | 14-batch.js | 4 | Batch API (up to 20 tools) |
| P14 | 15-prompts.js | 3 | MCP prompts (discover, health) |
| P15 | 16-sse.js | 3 | SSE transport |
| P16 | 17-idempotency.js | 4 | Idempotency key dedup |
| P17 | 18-payment-bypass.js | 10 | **Payment bypass (highest weight)** |
| P18 | 19-dual-rail.js | 5 | x402 + MPP coexistence |

## MCP Tool Naming
- Tool IDs: `crypto.trending`, `account.usage`
- MCP names: `crypto.trending.get`, `account.usage.get` (3-level dot notation)
- Use MCP names in tests, not tool IDs

## Daily Cron
- `0 6 * * *` — runs daily at 06:00 UTC
- `git pull` → `npm install` → `node src/index.js` → report
- Score < 80 or 500 errors → auto-creates GitHub Issue at whiteknightonhorse/APIbase

## Selective Phase Run
```bash
PHASES=0,17 node src/index.js    # P0 (discovery) + P18 (payment bypass)
PHASES=0,7,8,9,10,17 node src/index.js  # security-focused run
```

## Key Config (.env)
```
MCP_SERVER_URL=https://apibase.pro/mcp
REST_BASE_URL=https://apibase.pro/api/v1
API_KEY=ak_live_...
WALLET_PRIVATE_KEY=0x...  (for real x402 payment tests)
```
