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
