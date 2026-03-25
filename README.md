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

- **15-phase test suite** — discovery through security audit to load testing
- **Dual-rail payment testing** — x402 + MPP in parallel
- **Full MCP protocol validation** — initialize, tools/list, tools/call
- **402 challenge validation** — every tool returns correct payment challenge
- **Payment security** — replay attacks, race conditions, double-spend, amount manipulation
- **Advanced security** — SSRF, timing attacks, CORS, header injection, fuzz testing
- **Resilience testing** — brute force, SSL/TLS, enumeration, error cascade
- **Load testing** — configurable concurrency, parallel protocol stress
- **Provider health map** — per-provider status and latency tracking
- **Universal** — works with ANY MCP server, not just APIbase
- **Scoring** — 0-100 score with A+/A/B/C/D/F grade
- **CI-ready** — GitHub Actions with automated security scanning
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
# Full dual-rail test (x402 + MPP)
npm test

# Dry run — no real payments, tests challenges and security only
npm run test:dry

# Fast mode — discovery + infrastructure + MCP only
npm run test:fast

# Security audit only
npm run test:security

# Payment tests only
npm run test:payments

# Custom server
API_BASE_URL=https://my-server.com npm test

# Specific phases
PHASES=0,1,7 npm test

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

> **Note:** Any CRITICAL (500) server error automatically caps the grade at D.

## Phases (15)

| Phase | Name               | What it tests                                          | Cost    |
|-------|--------------------|--------------------------------------------------------|---------|
| P0    | Discovery          | Catalog, MCP config, server card, dual-rail detection  | $0      |
| P1    | Infrastructure     | Health, Tempo/Base RPC, wallet balances, facilitator   | $0      |
| P2    | MPP Challenges     | WWW-Authenticate: Payment on all tools                 | $0      |
| P3    | x402 Challenges    | x402 402 response on all tools                         | $0      |
| P4    | MCP Protocol       | initialize, tools/list, tools/call                     | $0      |
| P5    | MPP Payments       | Real Tempo USDC payments via mppx                      | ~$0.01  |
| P6    | x402 Payments      | Real Base USDC payments via @x402/core                 | ~$0.05  |
| P7    | Basic Security     | Auth bypass, forged credentials, injection             | $0      |
| P8    | Payment Security   | Replay, race condition, double-spend, amount tampering | ~$0.01  |
| P9    | Advanced Security  | SSRF, timing attacks, CORS, header injection, fuzz     | $0      |
| P10   | Resilience         | Brute force, SSL/TLS, enumeration, error cascade       | $0      |
| P11   | Load Test          | Concurrent requests, mixed endpoints, sustained load   | $0      |
| P12   | Provider Health    | Per-provider health map with latency                   | $0      |
| P13   | Cache & Simulation | Cache isolation, User-Agent, protocol switching        | $0      |
| P14   | Report             | Score, grade, per-phase breakdown, recommendations     | $0      |

**Total estimated cost:** ~$0.07 per full run.

## Environment Variables

| Variable          | Required | Default                    | Description                          |
|-------------------|----------|----------------------------|--------------------------------------|
| `API_BASE_URL`    | Yes      | `https://apibase.pro`      | Target server base URL               |
| `MCP_SERVER_URL`  | No       | `{API_BASE_URL}/mcp`       | MCP endpoint URL                     |
| `API_KEY`         | No       | (none)                     | API key for authenticated requests   |
| `PRIVATE_KEY`     | No*      | (none)                     | Wallet private key for payments      |
| `CONCURRENCY`     | No       | `5`                        | Parallel requests in load test       |
| `SKIP_PAYMENTS`   | No       | `false`                    | Skip real payment tests              |
| `PHASES`          | No       | `0,1,2,3,4,5,6,7,8,9`     | Comma-separated phase numbers        |
| `MAX_TOOLS`       | No       | `0` (all)                  | Max tools to test (0 = unlimited)    |
| `TIMEOUT_MS`      | No       | `30000`                    | Per-request timeout in ms            |
| `MAX_USDC_BUDGET` | No       | `0.25`                     | Spending cap per protocol            |

> \* `PRIVATE_KEY` is required only for payment phases (P5, P6). The same key works on both Base and Tempo chains.

## Testing Your Own MCP Server

1. Your server must support MCP protocol (Streamable HTTP at `/mcp`)
2. For payment tests: server must return HTTP 402 with payment challenge
3. Set `API_BASE_URL` in `.env` to your server
4. Optional: set `PRIVATE_KEY` for real payment tests
5. Run `npm test`

### Minimum server requirements for each phase:

| Phase | Server must support                                      |
|-------|----------------------------------------------------------|
| P0    | `GET /api/v1/tools` + `/.well-known/mcp.json`           |
| P1    | `GET /health/ready`                                      |
| P2    | HTTP 402 with `WWW-Authenticate: Payment` header         |
| P3    | HTTP 402 with x402 JSON body                             |
| P4    | MCP Streamable HTTP (POST /mcp)                          |
| P5    | MPP payment verification via `mppx`                      |
| P6    | x402 payment verification via `@x402/core`               |
| P7    | Standard REST API (any MCP server)                       |
| P8    | Any HTTP endpoint                                        |

## Reports

Reports are saved to `reports/` directory (git-ignored). Each run creates:

- `dual-rail-report-YYYYMMDD_HHMMSS.txt` — human-readable text
- `dual-rail-report-YYYYMMDD_HHMMSS.json` — machine-readable JSON

### JSON report structure:

```json
{
  "timestamp": "2026-03-25T09:00:00.000Z",
  "server": "https://apibase.pro",
  "score": 85,
  "grade": "B",
  "assertions": { "total": 332, "pass": 323, "fail": 9 },
  "financial": { "x402": 0.001, "mpp": 0.002 },
  "errors": [],
  "recommendations": [],
  "failures": []
}
```

## Payment Protocols

### x402 (USDC on Base)

Standard HTTP 402 payment protocol. Client sends request, gets 402 with payment requirements, signs USDC transfer on Base chain, retries with `X-Payment` + `PAYMENT-SIGNATURE` headers.

### MPP (USDC on Tempo)

Machine Payments Protocol by Stripe/Tempo. Client sends request, gets 402 with `WWW-Authenticate: Payment` header, signs payment on Tempo chain via `mppx` SDK, retries with `Authorization: Payment <credential>`.

Both protocols can coexist on the same server — this tester verifies both work correctly.

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

### Automated security pipeline

Every push and PR runs these checks automatically via GitHub Actions:

1. **Secret Detection** — TruffleHog + Gitleaks scan entire git history for leaked keys
2. **CodeQL Analysis** — GitHub's static analysis engine checks for JavaScript vulnerabilities
3. **Dependency Audit** — npm audit + Snyk scan for known CVEs in dependencies
4. **No Hardcoded Secrets** — Custom grep for private keys (0x...), API keys (ak_live_...), GitHub tokens (ghp_...)
5. **No Data Exfiltration** — Scan for eval(), child_process, suspicious HTTP calls, base64-encoded env vars
6. **Code Quality** — Syntax check all source files, check for secret logging

### What this tool does NOT do

- Does NOT send your private keys anywhere (keys are used locally by viem/mppx for signing)
- Does NOT store or cache payment credentials
- Does NOT make HTTP calls to any server except the one you configure in `API_BASE_URL`
- Does NOT collect analytics, telemetry, or usage data
- Does NOT require internet access except to reach your target MCP server

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
│   ├── index.js              # Main entry point / CLI
│   ├── phases/
│   │   ├── 00-discovery.js   # P0: Catalog, MCP config, server card
│   │   ├── 01-infrastructure.js  # P1: Health, RPC, wallets
│   │   ├── 02-mpp-challenges.js  # P2: MPP 402 on all tools
│   │   ├── 03-x402-challenges.js # P3: x402 402 on all tools
│   │   ├── 04-mcp-protocol.js    # P4: MCP initialize/list/call
│   │   ├── 05-mpp-payments.js    # P5: Real MPP payments
│   │   ├── 06-x402-payments.js   # P6: Real x402 payments
│   │   ├── 07-security.js        # P7: Security audit
│   │   ├── 08-load.js            # P8: Load/stress test
│   │   └── 09-report.js          # P9: Report generation
│   ├── lib/
│   │   ├── config.js         # Environment config loader
│   │   ├── http.js           # HTTP client with timeout
│   │   ├── mpp-client.js     # MPP payment wrapper
│   │   ├── x402-client.js    # x402 payment wrapper
│   │   ├── mcp-client.js     # MCP session handler
│   │   ├── scoring.js        # Score calculation
│   │   └── reporter.js       # Report formatter
│   └── utils/
│       └── assert.js         # Test helpers, body builders
├── reports/                  # Generated reports (git-ignored)
├── docs/
│   ├── SCORING.md            # Scoring methodology
│   ├── ADDING-PHASES.md      # How to add test phases
│   └── SECURITY.md           # Security test details
├── .env.example              # Template (no real keys)
├── .gitignore
├── package.json
├── LICENSE                   # MIT
└── README.md
```

## Contributing

PRs welcome! See [docs/ADDING-PHASES.md](docs/ADDING-PHASES.md) for how to add new test phases.

## License

MIT
