# mcp-protocol-tester

[![SafeSkill 87/100](https://img.shields.io/badge/SafeSkill-87%2F100_Passes%20with%20Notes-yellow)](https://safeskill.dev/scan/whiteknightonhorse-mcp-protocol-tester)

[![Security Audit](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/security-audit.yml/badge.svg)](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/security-audit.yml)
[![CI](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/ci.yml/badge.svg)](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](https://nodejs.org)
[![No Secrets](https://img.shields.io/badge/Secrets-None%20Detected-brightgreen?logo=keybase)](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/security-audit.yml)
[![CodeQL](https://img.shields.io/badge/CodeQL-Protected-blue?logo=github)](https://github.com/whiteknightonhorse/mcp-protocol-tester/actions/workflows/security-audit.yml)

Universal test suite for MCP servers with dual-rail payment testing.

Tests **x402** (USDC on Base) and **MPP** (USDC on Tempo) protocols simultaneously across all tools on any MCP-compatible server.

## Features

- **20-phase test suite** — 920+ assertions across discovery, payments, security, anti-abuse, and agent UX
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

## Phases (20)

| Phase | Name               | What it tests                                                         | Cost    |
|-------|--------------------|-----------------------------------------------------------------------|---------|
| P0    | Discovery          | Catalog fetch, schema validation, `.well-known/*`, dual-rail detection, internal tool leak check, well-known CORS | $0 |
| P1    | Infrastructure     | Health, Tempo/Base RPC, USDC + gas balances, facilitator, health info leakage check | $0 |
| P2    | MPP Challenges     | `WWW-Authenticate: Payment` on all tools + field validation (recipient, amount, chainId) | $0 |
| P3    | x402 Challenges    | x402 402 body on all tools + field validation (payTo, network, asset, scheme, multi-accept), challenge nonce uniqueness | $0 |
| P4    | MCP Protocol       | initialize, tools/list, tools/call, resources/list, prompts/list, version negotiation, JSON-RPC error codes, session fixation, oversized payload, ID type handling | $0 |
| P5    | MPP Payments       | Real Tempo USDC payments via mppx + response content validation       | ~$0.01  |
| P6    | x402 Payments      | Real Base USDC payments via @x402/core + response content validation   | ~$0.05  |
| P7    | Basic Security     | Auth bypass, forged credentials, HTTP method enforcement + override bypass, Content-Type manipulation, request ID, path traversal, expanded hidden endpoints (+10), request smuggling | $0 |
| P8    | Payment Security   | Replay (same/cross-tool), race condition (10 parallel), double-spend, amount manipulation (0/negative/underpay/tampered payTo/integer overflow 2^64), float precision, off-by-one (999 vs 1000), expired challenge, wrong network (testnet→mainnet), cross-rail price consistency | ~$0.01 |
| P9    | Advanced Security  | SSRF (AWS/GCP/localhost/file:// + IPv6/octal/decimal), timing attacks, CORS + subdomain confusion + expose-headers audit, header injection (CRLF/64KB/Host), fuzz (null bytes/unicode/JSON bomb/prototype pollution), XXE injection, SSTI payloads, ReDoS, response analysis | $0 |
| P10   | Resilience         | Brute force (50 keys), XFF + 5 IP spoofing headers bypass, SSL/TLS version + cipher + cert expiry + TLSv1.1 rejection, enumeration, error cascade, referrer-policy, rate limit granularity (per-key) | $0 |
| P11   | Load Test          | Concurrent requests, mixed endpoints, sustained load, latency p50/p95/p99, ramp-up (1→5→10→25), large body DoS (1MB) | $0 |
| P12   | Provider Health    | 1 tool per provider → HEALTHY/DOWN/RATE_LIMITED + latency, provider error sanitization | $0 |
| P13   | Cache & Simulation | Cache isolation, cache leak test, cache poisoning (X-Forwarded-Host), cache key collision, User-Agent/Accept variation, REST+MCP simultaneous, error schema | $0 |
| P14   | Discover Tools     | Category enumeration (21 cats), category+task combos, stemming, keyword relevance, abuse (SQLi/XSS/unicode/10k chars), truncation, performance | $0 |
| P15   | Platform Features  | Usage Analytics (account.usage/tools/timeseries), Tool Quality Index (tool_quality/rankings), Batch API (call_batch + REST), recursive batch, batch tool_id injection, cross-feature validation | $0 |
| P16   | Agent Experience   | Zero-knowledge bootstrap, tool description quality, error actionability (400/402/429), payment UX, response consistency, E2E lifecycle (golden path), MCP protocol completeness, error path leakage | $0 |
| P17   | Payment Bypass     | MCP session payment enforcement, replay after 30s delay, signed underpayment, pay-cheap-use-expensive, cache leak across keys, price consistency, MCP batch abuse, header case/duplication, Content-Type bypass, prototype pollution, session ID entropy, double-spend 100x, cross-rail nonce, cross-chain replay, WebSocket upgrade bypass, burst 50 unpaid, chunked encoding bypass, nonce entropy | ~$0.01 |
| P18   | CDP Facilitator    | PayAI health + Base mainnet + Bazaar extension, CDP auth-gated, 402 wallet/network/asset/version consistency across tools, MPP dual-rail header, health/catalog/free/paid architecture checks, facilitator TLS, wallet constant | $0 |
| P19   | Report             | Score, grade, per-phase breakdown, recommendations, txt + JSON export | $0      |

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
  "assertions": { "total": 920, "pass": 890, "fail": 30 },
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
| **Double-Spend** | 2 | 10 + 100 parallel requests with same payment |
| **Amount Manipulation** | 8 | Zero, negative, underpay, tampered payTo, float precision, integer overflow (2^64), off-by-one (999 vs 1000), wrong network (testnet→mainnet) |
| **SSRF** | 7 | AWS/GCP metadata, localhost, file://, IPv6 `[::1]`, octal `0177.0.0.1`, decimal `2130706433` |
| **Timing Attacks** | 2 | Valid vs invalid key timing differential |
| **CORS** | 5 | Evil origin, null origin, preflight with credentials, subdomain confusion, expose-headers audit |
| **Header Injection** | 4 | CRLF in auth, 64KB header, Host override, request smuggling (CL+TE) |
| **Fuzz** | 5 | Null bytes, unicode, JSON bomb, prototype pollution, MAX_SAFE_INTEGER |
| **XXE/SSTI** | 4 | XML entity injection, template injection `{{7*7}}`, `${7*7}`, `<%= %>` |
| **Brute Force** | 3 | 50 random keys, XFF bypass, lockout recovery |
| **IP Spoofing** | 5 | X-Real-IP, X-Client-IP, CF-Connecting-IP, True-Client-IP, Forwarded |
| **SSL/TLS** | 4 | Protocol version, cipher strength, certificate expiry, TLSv1.1 rejection |
| **Enumeration** | 4 | Uniform errors, hidden endpoints (+10 paths), tool ID injection, path traversal |
| **Response Analysis** | 4 | Stack trace leaks, X-Powered-By, Server header, internal path leakage |
| **MCP Session** | 4 | Payment enforcement, batch abuse, session fixation, oversized payload |
| **Cache** | 4 | Cross-key leak, cache headers, cache poisoning (X-Forwarded-Host), cache key collision |
| **Signed Underpayment** | 1 | Valid signature with tampered amount |
| **Cross-Tool Price** | 1 | Cheap tool payment used for expensive tool |
| **Cross-Chain Replay** | 2 | Tempo nonce as x402, cross-chain payment proof |
| **Double-Spend 100x** | 1 | 100 parallel requests with single payment |
| **Replay After Delay** | 1 | Same payment replayed after 30 seconds |
| **Expired Challenge** | 1 | Payment with maxTimeoutSeconds=0 |
| **Proto Pollution** | 1 | `__proto__.isPaid=true` bypass attempt |
| **HTTP Method Override** | 3 | X-HTTP-Method-Override, X-HTTP-Method, X-Method-Override |
| **Content-Type Bypass** | 3 | text/plain, text/xml, multipart with payment check |
| **WebSocket Bypass** | 1 | Upgrade: websocket to bypass HTTP payment middleware |
| **Chunked Encoding** | 1 | Transfer-Encoding: chunked to bypass payment check |
| **Burst Attack** | 1 | 50 unpaid requests in 100ms — none should return 200 |
| **Nonce Entropy** | 2 | Challenge nonce uniqueness + minimum length (≥20 chars) |
| **Session Entropy** | 1 | Session IDs >= 128-bit, unpredictable |
| **Rate Limit** | 1 | Per-key not per-IP (one abuser doesn't block others) |
| **Batch Injection** | 2 | Recursive batch, path traversal in tool_id |
| **ReDoS** | 1 | 50K-char input within 5s timeout |
| **CDP Facilitator** | 16 | PayAI/CDP health, wallet consistency, network/USDC/version, Bazaar, facilitator TLS |
| **Price Consistency** | 10 | Catalog price matches 402 challenge for 10 tools |

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
│   │   ├── 19-cdp-facilitator.js  # P18: CDP/PayAI dual-facilitator, wallet consistency
│   │   └── 15-report.js           # P19: Grade, breakdown, export
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
