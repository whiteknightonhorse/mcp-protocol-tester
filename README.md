# mcp-protocol-tester

Universal test suite for MCP servers with dual-rail payment testing.

Tests **x402** (USDC on Base) and **MPP** (USDC on Tempo) protocols simultaneously across all tools on any MCP-compatible server.

## Features

- **Dual-rail payment testing** — x402 + MPP in parallel
- **Full MCP protocol validation** — initialize, tools/list, tools/call
- **402 challenge validation** — every tool returns correct payment challenge
- **Security audit** — forged credentials, replay attacks, injection, SSRF
- **Load testing** — configurable concurrency, parallel protocol stress
- **Universal** — works with ANY MCP server, not just APIbase
- **Scoring** — 0-100 score with A+/A/B/C/D/F grade
- **CI-ready** — exit code 0 on pass, non-zero on critical failures
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

## Phases

| Phase | Name             | What it tests                           | Cost    |
|-------|------------------|-----------------------------------------|---------|
| P0    | Discovery        | Catalog, MCP config, server card        | $0      |
| P1    | Infrastructure   | Health, RPC, wallets, facilitator       | $0      |
| P2    | MPP Challenges   | WWW-Authenticate on all tools           | $0      |
| P3    | x402 Challenges  | x402 402 response on all tools          | $0      |
| P4    | MCP Protocol     | initialize, tools/list, tools/call      | $0      |
| P5    | MPP Payments     | Real Tempo USDC payments                | ~$0.01  |
| P6    | x402 Payments    | Real Base USDC payments                 | ~$0.05  |
| P7    | Security         | Forged creds, replay, injection         | $0      |
| P8    | Load             | Parallel stress test                    | $0      |
| P9    | Report           | Score, grade, recommendations           | $0      |

**Total estimated cost:** ~$0.06 per full run.

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

- Private keys **NEVER** leave your machine (`.env` is git-ignored)
- No telemetry, no analytics, no external calls except to the target server
- All wallet operations happen locally via SDK
- See [docs/SECURITY.md](docs/SECURITY.md) for security test details

> **Warning:** Never commit your `.env` file. Never share your `PRIVATE_KEY`.

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
