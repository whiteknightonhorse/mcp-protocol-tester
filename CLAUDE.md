# MCP Protocol Tester — Claude Operating Rules

## Project
Automated test suite for **apibase.pro** MCP server. Phase list, files, weights and costs: [docs/PHASES.md](docs/PHASES.md).
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
src/phases/           — one file per phase (docs/PHASES.md)
reports/              — daily-YYYYMMDD.log files (auto-cleaned to 30)
run-daily.sh          — cron wrapper: git pull → npm test → report → gh issue on failure
```

## Phases

See [docs/PHASES.md](docs/PHASES.md) (generated, checked by `npm run phases:check`). File prefix = `PHASES` value = report label.

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
PHASES=0,18 node src/index.js    # P0 (discovery) + P18 (payment bypass)
PHASES=0,7,8,9,10,18 node src/index.js  # security-focused run
```

## Key Config (.env)
```
MCP_SERVER_URL=https://apibase.pro/mcp
REST_BASE_URL=https://apibase.pro/api/v1
API_KEY=            (empty = unauthenticated probing)
SKIP_PAYMENTS=true  (false spends; see the Cost column in docs/PHASES.md)
```
