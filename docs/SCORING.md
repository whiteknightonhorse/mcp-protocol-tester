# Scoring Methodology

## Verdict layer (Э1, added 2026-09-02 — read this first)

**Score is a trend metric. VERDICT is what actually gates alerting and CI.**
A run's VERDICT is FAIL, independent of how high the score is, if any of:
- a RED-class assertion failed — a real money e2e path, a crash/liveness
  check, a public 404, or a catalog-sanity precondition (see `redRec()` call
  sites across the phases, especially P20-P26);
- a CRITICAL error was recorded (500s, etc.);
- more than 6 phases were SKIPped (a skip must always state a reason —
  `scorer.skip(phase, reason)` — but too many of them isn't a trustworthy
  PASS either).

A timeout/dead-server response is a real, distinct, NEVER-passing state —
see `src/lib/scoring.js` and `src/lib/http.js`'s `-1` sentinel. `run-daily.sh`
diffs today's failures against a standing-red ledger
(`scripts/verdict-runner.js`) and escalates anything red for 3+ days.

⚠️ **The phase table and weights below this line predate the verdict layer
and have drifted from the actual `WEIGHTS` array in `src/lib/reporter.js`
for a while (there is no P5=15/P6=15/P9="Summary" in the real code) — this
was found in passing while adding the verdict layer, not fixed here (a full
rewrite of this doc against the current 27-phase reality is its own task,
not part of Fable's named findings). Treat `src/lib/reporter.js`'s `WEIGHTS`
array as the actual source of truth for current weights/phases.

---

# Scoring Methodology

## Overview

The tester evaluates MCP servers across 10 phases, each with a weighted score. The final grade is computed from the weighted sum.

## Phase Weights

| Phase | Weight | Name              |
|-------|--------|-------------------|
| P0    | 10     | Discovery         |
| P1    | 10     | Infrastructure    |
| P2    | 10     | MPP Challenges    |
| P3    | 10     | x402 Challenges   |
| P4    | 10     | MCP Protocol      |
| P5    | 15     | MPP Payments      |
| P6    | 15     | x402 Payments     |
| P7    | 10     | Security          |
| P8    | 5      | Load Test         |
| P9    | 5      | Summary           |
| **Total** | **100** |              |

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
