# Scoring Methodology

## Verdict layer (Э1, added 2026-09-02 — read this first)

**Score is a trend metric. VERDICT is what actually gates alerting and CI.**
A run's VERDICT is FAIL, independent of how high the score is, if any of:
- a RED-class assertion failed — a real money e2e path, a crash/liveness
  check, a public 404, or a catalog-sanity precondition (see `redRec()` call
  sites across the phases, especially the phases listed in PHASES.md);
- a CRITICAL error was recorded (500s, etc.);
- one of the RED assertions added by T-0433 failed: P2 currency pin (exactly
  one currency, USDC.e on mainnet / pathUSD on testnet, never OUSD), P5 current
  mppx client pays and returns a `Payment-Receipt` with a tx-hash reference, P5
  settled-credential replay is refused (never 200; the exact final 403
  `credential_replayed` answer is a non-RED rec), P17 nine path-encoding bypass vectors never serve unpaid;
- more than 6 phases were SKIPped (a skip must always state a reason —
  `scorer.skip(phase, reason)` — but too many of them isn't a trustworthy
  PASS either).

A timeout/dead-server response is a real, distinct, NEVER-passing state —
see `src/lib/scoring.js` and `src/lib/http.js`'s `-1` sentinel. `run-daily.sh`
diffs today's failures against a standing-red ledger
(`scripts/verdict-runner.js`) and escalates anything red for 3+ days.

Phase ids, files and weights: [PHASES.md](PHASES.md) (generated from `src/lib/reporter.js` WEIGHTS; the single source of truth).

# Scoring Methodology

## Overview

The tester evaluates MCP servers across weighted phases. The final grade is computed from the weighted sum.

## Grade Calculation

Each phase's score = `(pass / total) * weight`.

Final score = sum of all phase scores.

| Grade | Score Range | Description                           |
|-------|-------------|---------------------------------------|
| A+    | 97-100      | Production-ready, all protocols work  |
| A     | 93-96       | Excellent, minor recommendations      |
| A-    | 90-92       | Very good, few non-critical issues    |
| B+    | 87-89       | Good, some improvements needed        |
| B     | 83-86       | Functional, recommendations available |
| B-    | 80-82       | Acceptable, notable gaps              |
| C     | 70-79       | Basic functionality, significant gaps |
| D     | 60-69       | Critical issues found                 |
| F     | <60         | Major failures                        |

## Grade Modifiers

- **Any CRITICAL error (500 server error)** → grade capped at D regardless of score
- **Payment phases skipped** → those phases score 0 (affects total)

## What Counts as Pass/Fail

- **402 challenge**: PASS if response contains valid payment requirements
- **Payment**: PASS if full flow (probe→sign→pay→200) succeeds
- **Security**: PASS if server rejects forged/invalid credentials
- **Load**: PASS if server handles concurrent requests without 500s
