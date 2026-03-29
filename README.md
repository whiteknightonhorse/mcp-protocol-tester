# mcp-protocol-tester

[![Security Audit](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/security-audit.yml/badge.svg)](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/security-audit.yml)
[![CI](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/ci.yml/badge.svg)](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](https://nodejs.org)
[![No Secrets](https://img.shields.io/badge/Secrets-None%20Detected-brightgreen?logo=keybase)](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/security-audit.yml)
[![CodeQL](https://img.shields.io/badge/CodeQL-Protected-blue?logo=github)](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/security-audit.yml)

Universal test suite for MCP servers with dual-rail payment testing.

Tests **x402** (USDC on Base) and **MPP** (USDC on Tempo) protocols simultaneously across all tools on any MCP-compatible server.

## Features

- **19-phase test suite** — 850+ assertions across discovery, payments, security, anti-abuse, and agent UX
- **Dual-rail payment testing** — x402 + MPP in parallel with cross-rail price validation
- **Full MCP protocol validation** — initialize, tools/list, tools/call, resources/list, prompts/list, version negotiation
- **402 challenge validation** — every tool checked for correct payment challenge fields (payTo, network, asset, amount)
- **Payment security** — replay attacks, race conditions, double-spend, amount manipulation, stale challenges
- **Advanced security** — SSRF, timing attacks, CORS, header injection, fuzz testing, response analysis
- **Payment bypass prevention** — replay, double-spend 100x, signed underpayment, cache leak, MCP session abuse, cross-rail nonce
- **Resilience testing** — brute force, SSL/TLS cipher/cert validation, enumeration, error cascade
- **Load testing** — ramp-up stress, latency percentiles (p50/p95/p99), sustained load
- **Tool discovery** — discover_tools prompt validation, stemming, category enumeration, abuse testing
- **Platform features** — usage analytics, tool quality index, batch API, cross-feature validation
- **Agent experience** — zero-knowledge bootstrap, description quality, error actionability, E2E lifecycle
- **Provider health map** — per-provider status and latency tracking
- **Universal** — works with ANY MCP server, not just APIbase
- **Scoring** — 0-100 score with A+/A/B/C/D/F grade
- **CI-ready** — GitHub Actions with TruffleHog, Gitleaks, CodeQL, Snyk
- **Zero build** — plain Node.js, no TypeScript compilation needed

## Quick Start

```bash
git clone https://github.com/whiteknightonhorse/mcp-protocol-tester.git
cd mcp-protocol-tester
npm install
cp .env.example .env
# Edit .env with your server URL and wallet keys
npm test
```

## Usage

```bash
# Full dual-rail test (all 16 phases)
npm test

# Dry run — no real payments, tests challenges and security only
npm run test:dry

# Fast mode — discovery + infrastructure + MCP only
npm run test:fast

# Security audit (basic + payment + advanced + resilience)
npm run test:security

# Payment tests only
npm run test:payments

# Custom server
API_BASE_URL=https://my-server.com npm test

# Specific phases
PHASES=0,1,7,8,9,10 npm test

# Load test with 10 concurrent requests
CONCURRENCY=10 npm test
```

## Scoring

| Grade | Score   | Meaning                                  |
|-------|---------|------------------------------------------|
| A+    | 97-100  | Production-ready, all protocols verified |
| A     | 93-96   | Excellent, minor recommendations         |
| A-    | 90-92   | Very good, few non-critical issues       |
| B+    | 87-89   | Good, some improvements needed           |
| B     | 83-86   | Functional, recommendations available    |
| B-    | 80-82   | Acceptable, notable gaps                 |
| C     | 70-79   | Basic functionality, significant gaps    |
| D     | 60-69   | Critical issues found                    |
| F     | <60     | Major failures, not production-ready     |

> **Note:** Any CRITICAL (500) server error automatically caps the grade at D. Skipped phases score 0%.

## Phases (19)

| Phase | Name               | What it tests                                                         | Cost    |
|-------|--------------------|-----------------------------------------------------------------------|---------|
| P0    | Discovery          | Catalog fetch, schema validation, `.well-known/*`, dual-rail detection | $0      |
| P1    | Infrastructure     | Health, Tempo/Base RPC, USDC + gas balances, facilitator              | $0      |
| P2    | MPP Challenges     | `WWW-Authenticate: Payment` on all tools + field validation (recipient, amount, chainId) | $0 |
| P3    | x402 Challenges    | x402 402 body on all tools + field validation (payTo, network, asset, scheme, multi-accept) | $0 |
| P4    | MCP Protocol       | initialize, tools/list, tools/call, resources/list, prompts/list, version negotiation, JSON-RPC error codes | $0 |
| P5    | MPP Payments       | Real Tempo USDC payments via mppx + response content validation       | ~$0.01  |
| P6    | x402 Payments      | Real Base USDC payments via @x402/core + response content validation   | ~$0.05  |
| P7    | Basic Security     | Auth bypass, forged credentials, HTTP method enforcement, Content-Type manipulation, request ID | $0 |
| P8    | Payment Security   | Replay (same/cross-tool), race condition (10 parallel), double-spend, amount manipulation (0/negative/underpay/tampered payTo), float precision, cross-rail price consistency | ~$0.01 |
| P9    | Advanced Security  | SSRF (AWS/GCP/localhost/file://), timing attacks, CORS, header injection (CRLF/64KB/Host), fuzz (null bytes/unicode/JSON bomb/prototype pollution), response analysis (stack traces/headers) | $0 |
| P10   | Resilience         | Brute force (50 keys), XFF bypass, SSL/TLS version + cipher + cert expiry, enumeration, error cascade | $0 |
| P11   | Load Test          | Concurrent requests, mixed endpoints, sustained load, latency p50/p95/p99, ramp-up (1→5→10→25) | $0 |
| P12   | Provider Health    | 1 tool per provider → HEALTHY/DOWN/RATE_LIMITED + latency             | $0      |
| P13   | Cache & Simulation | Cache isolation, cache leak test, User-Agent/Accept variation, REST+MCP simultaneous, error schema | $0 |
| P14   | Discover Tools     | Category enumeration (21 cats), category+task combos, stemming, keyword relevance, abuse (SQLi/XSS/unicode/10k chars), truncation, performance | $0 |
| P15   | Platform Features  | Usage Analytics (account.usage/tools/timeseries), Tool Quality Index (tool_quality/rankings), Batch API (call_batch + REST), cross-feature catalog/MCP/billing validation | $0 |
| P16   | Agent Experience   | Zero-knowledge bootstrap, tool description quality, error actionability (400/402/429), payment UX, response consistency, E2E lifecycle (golden path), MCP protocol completeness | $0 |
| P17   | Payment Bypass     | MCP session payment enforcement, replay after 30s delay, signed underpayment, pay-cheap-use-expensive, cache leak across keys, price consistency, MCP batch abuse, header case/duplication, Content-Type bypass, prototype pollution, session ID entropy, double-spend 100x parallel, cross-rail nonce | ~$0.01 |
| P18   | Report             | Score, grade, per-phase breakdown, recommendations, txt + JSON export | $0      |

**Total estimated cost:** ~$0.07 per full run.

## Environment Variables

| Variable          | Required | Default                             | Description                          |
|-------------------|----------|-------------------------------------|--------------------------------------|
| `API_BASE_URL`    | Yes      | `https://apibase.pro`               | Target server base URL               |
| `MCP_SERVER_URL`  | No       | `{API_BASE_URL}/mcp`                | MCP endpoint URL                     |
| `API_KEY`         | No       | (none)                              | API key for authenticated requests   |
| `PRIVATE_KEY`     | No*      | (none)                              | Wallet private key for payments      |
| `CONCURRENCY`     | No       | `5`                                 | Parallel requests in load test       |
| `SKIP_PAYMENTS`   | No       | `false`                             | Skip real payment tests              |
| `PHASES`          | No       | `0,1,2,...,15` (all)                | Comma-separated phase numbers        |
| `MAX_TOOLS`       | No       | `0` (all)                           | Max tools to test (0 = unlimited)    |
| `TIMEOUT_MS`      | No       | `30000`                             | Per-request timeout in ms            |
| `MAX_USDC_BUDGET` | No       | `0.25`                              | Spending cap per protocol            |

> \* `PRIVATE_KEY` is required only for payment phases (P5, P6, P8). The same key works on both Base and Tempo chains.

## Testing Your Own MCP Server

1. Your server must support MCP protocol (Streamable HTTP at `/mcp`)
2. For payment tests: server must return HTTP 402 with payment challenge
3. Set `API_BASE_URL` in `.env` to your server
4. Optional: set `PRIVATE_KEY` for real payment tests
5. Run `npm test`

### Minimum server requirements for each phase:

| Phase | Server must support                                                           |
|-------|-------------------------------------------------------------------------------|
| P0    | `GET /api/v1/tools` + `/.well-known/mcp.json`                                |
| P1    | `GET /health/ready`                                                           |
| P2    | HTTP 402 with `WWW-Authenticate: Payment` header                              |
| P3    | HTTP 402 with x402 JSON body (`x402Version: 2`, `accepts` array)              |
| P4    | MCP Streamable HTTP (`POST /mcp`) with initialize, tools/list, tools/call     |
| P5    | MPP payment verification via `mppx`                                           |
| P6    | x402 payment verification via `@x402/core`                                    |
| P7-P10| Standard REST API (any MCP server)                                            |
| P11   | Any HTTP endpoint                                                             |
| P12   | `POST /api/v1/tools/{id}/call`                                                |
| P13   | REST + MCP endpoints                                                          |
| P14   | MCP `prompts/get` with `discover_tools` prompt                                |
| P15   | Platform tools: `account.usage`, `platform.tool_quality`, `platform.call_batch` |
| P16   | `.well-known/*` discovery, MCP session, tool descriptions, error messages      |

## Reports

Reports are saved to `reports/` directory (git-ignored). Each run creates:

- `dual-rail-report-YYYYMMDD_HHMMSS.txt` — human-readable text
- `dual-rail-report-YYYYMMDD_HHMMSS.json` — machine-readable JSON

### JSON report structure:

```json
{
  "timestamp": "2026-03-27T09:00:00.000Z",
  "server": "https://apibase.pro",
  "score": 85,
  "grade": "B",
  "assertions": { "total": 800, "pass": 770, "fail": 30 },
  "financial": { "x402": 0.05, "mpp": 0.01 },
  "errors": [],
  "recommendations": [],
  "failures": []
}
```

## Payment Protocols

### x402 (USDC on Base)

Standard HTTP 402 payment protocol. Client sends request, gets 402 with payment requirements (`accepts` array with `network`, `asset`, `payTo`, `scheme`, `amount`), signs USDC transfer on Base chain, retries with `X-Payment` + `PAYMENT-SIGNATURE` headers.

**Validation:** P3 checks every tool's 402 response for correct `payTo` address, `network` (eip155:8453), `asset` (USDC contract), and reasonable `amount`. Multi-accept entries are all validated.

### MPP (USDC on Tempo)

Machine Payments Protocol by Stripe/Tempo. Client sends request, gets 402 with `WWW-Authenticate: Payment` header containing challenge (id, realm, method, intent, request, expires), signs payment on Tempo chain via `mppx` SDK, retries with `Authorization: Payment <credential>`.

**Validation:** P2 checks every tool for correct `recipient`, `chainId` (4217), and reasonable `amount`. P8 validates cross-rail price consistency (x402 vs MPP amounts must match).

Both protocols can coexist on the same server — this tester verifies both work correctly and consistently.

## Security

### This tool is safe to use

| Check | Status | How |
|-------|--------|-----|
| **No hardcoded secrets** | Verified on every commit | [TruffleHog](https://github.com/trufflesecurity/trufflehog) + [Gitleaks](https://github.com/gitleaks/gitleaks) scan |
| **No code vulnerabilities** | Verified on every commit | [GitHub CodeQL](https://codeql.github.com/) static analysis |
| **No dependency vulnerabilities** | Weekly scan | `npm audit` + [Snyk](https://snyk.io/) |
| **No data exfiltration** | Verified on every commit | Custom scan for eval(), child_process, suspicious fetch calls |
| **No secret logging** | Verified on every commit | Grep for console.log with env vars |
| **Private keys stay local** | `.env` in `.gitignore` | Keys never leave your machine |
| **No telemetry** | By design | Zero analytics, zero tracking, zero external calls except target server |
| **Open source** | MIT license | Full source code available for audit |

### What this tool tests on YOUR server

| Category | Tests | What it looks for |
|----------|-------|-------------------|
| **Payment Replay** | 5 | Reused payment signatures (same tool, cross-tool, modified body) |
| **Double-Spend** | 1 | 10 parallel requests with same payment → max 1 success |
| **Amount Manipulation** | 5 | Zero, negative, underpay, tampered payTo, float precision |
| **SSRF** | 4 | AWS/GCP metadata, localhost, file:// protocol via URL-accepting tools |
| **Timing Attacks** | 2 | Valid vs invalid key timing differential |
| **CORS** | 3 | Evil origin reflection, null origin, preflight with credentials |
| **Header Injection** | 3 | CRLF in auth, 64KB header, Host override |
| **Fuzz** | 5 | Null bytes, unicode, JSON bomb, prototype pollution, MAX_SAFE_INTEGER |
| **Brute Force** | 3 | 50 random keys, XFF bypass, lockout recovery |
| **SSL/TLS** | 3 | Protocol version, cipher strength, certificate expiry |
| **Enumeration** | 3 | Uniform errors, hidden endpoints, tool ID injection |
| **Response Analysis** | 3 | Stack trace leaks, X-Powered-By, Server header |
| **MCP Session Abuse** | 2 | Payment enforcement per MCP tools/call, batch abuse |
| **Cache Leak** | 2 | Cross-key data leak, cache headers (no-store/Vary) |
| **Signed Underpayment** | 1 | Valid signature with tampered amount |
| **Cross-Tool Price** | 1 | Cheap tool payment used for expensive tool |
| **Double-Spend 100x** | 1 | 100 parallel requests with single payment |
| **Replay After Delay** | 1 | Same payment replayed after 30 seconds |
| **Proto Pollution** | 1 | `__proto__.isPaid=true` bypass attempt |
| **Header Duplication** | 2 | Mixed case, duplicate X-PAYMENT headers |
| **Content-Type Bypass** | 3 | text/plain, text/xml, multipart with payment check |
| **Cross-Rail Nonce** | 1 | x402 nonce presented as MPP credential |
| **Session Entropy** | 1 | Session IDs >= 128-bit, unpredictable |
| **Price Consistency** | 1 | Catalog price matches 402 challenge for all tools |

### Verify yourself

```bash
# Check for secrets in code
grep -rn "0x[0-9a-fA-F]\{64\}" --include="*.js" src/
# Should return: no matches

# Check for eval/exec
grep -rn "eval(\|child_process\|\.exec(" --include="*.js" src/
# Should return: no matches

# Check what HTTP endpoints are called
grep -rn "fetch\|http\." --include="*.js" src/lib/
# Should only reference: config.apiUrl, config.apiBaseUrl, config.mcpServerUrl,
# facilitator.payai.network, rpc.tempo.xyz
```

> **Warning:** Never commit your `.env` file. Never share your `PRIVATE_KEY`.

See [docs/SECURITY.md](docs/SECURITY.md) for details on what the security test phases cover.

## Project Structure

```
mcp-protocol-tester/
├── src/
│   ├── index.js                   # Main entry point / CLI
│   ├── phases/
│   │   ├── 00-discovery.js        # P0: Catalog, schema validation, .well-known, dual-rail
│   │   ├── 01-infrastructure.js   # P1: Health, RPC, USDC + gas balances
│   │   ├── 02-mpp-challenges.js   # P2: MPP 402 + field validation (recipient, chainId)
│   │   ├── 03-x402-challenges.js  # P3: x402 402 + field validation (payTo, network, asset)
│   │   ├── 04-mcp-protocol.js     # P4: MCP init/list/call + resources + prompts + version
│   │   ├── 05-mpp-payments.js     # P5: Real MPP payments + response validation
│   │   ├── 06-x402-payments.js    # P6: Real x402 payments + response validation
│   │   ├── 07-security.js         # P7: Auth, credentials, HTTP methods, Content-Type
│   │   ├── 08-payment-security.js # P8: Replay, race, double-spend, amounts, cross-rail
│   │   ├── 09-advanced-security.js# P9: SSRF, timing, CORS, headers, fuzz, response
│   │   ├── 10-resilience.js       # P10: Brute force, TLS cipher/cert, enumeration
│   │   ├── 11-load.js             # P11: Concurrent, sustained, percentiles, ramp-up
│   │   ├── 12-provider-health.js  # P12: Per-provider health map
│   │   ├── 13-cache-simulation.js # P13: Cache leak, User-Agent, REST+MCP, errors
│   │   ├── 14-discover-tools.js   # P14: Categories, stemming, relevance, abuse
│   │   ├── 16-platform-features.js# P15: Usage Analytics, Tool Quality, Batch API
│   │   ├── 17-agent-experience.js # P16: Bootstrap, descriptions, errors, E2E lifecycle
│   │   ├── 18-payment-bypass.js   # P17: Anti-abuse, replay, double-spend, cache leak
│   │   └── 15-report.js           # P18: Grade, breakdown, export
│   ├── lib/
│   │   ├── config.js              # dotenv + env loader
│   │   ├── http.js                # HTTP client with timeout + provider delays
│   │   ├── mpp-client.js          # MPP payment wrapper (mppx)
│   │   ├── x402-client.js         # x402 payment wrapper (@x402/core)
│   │   ├── mcp-client.js          # MCP JSON-RPC session handler
│   │   ├── scoring.js             # Score/grade calculator
│   │   └── reporter.js            # Report formatter (txt + json) + weights
│   └── utils/
│       └── assert.js              # Body builders (30+ heuristics), 70+ known params
├── reports/                       # Generated reports (git-ignored)
├── docs/
│   ├── SCORING.md                 # Scoring methodology
│   ├── ADDING-PHASES.md           # How to add test phases
│   └── SECURITY.md                # Security test details
├── .github/workflows/
│   ├── security-audit.yml         # TruffleHog + Gitleaks + CodeQL + Snyk + custom scans
│   └── ci.yml                     # Syntax check + dry run on Node 18/20/22
├── .env.example                   # Template (no real keys)
├── .gitignore
├── package.json
├── LICENSE                        # MIT
└── README.md
```

## Contributing

PRs welcome! See [docs/ADDING-PHASES.md](docs/ADDING-PHASES.md) for how to add new test phases.

## License

MIT
