# Adding New Test Phases

## Phase Structure

Each phase is a module in `src/phases/` that exports a single async function:

```javascript
module.exports = async function phaseN(scorer, config, context) {
  console.log('\n== PHASE N: YOUR PHASE NAME ==\n');

  // Your test logic here
  scorer.rec('PN', 'N.1 Test name', 'expected', 'actual', isPass, 'details');
};
```

## Parameters

- `scorer` — `Scorer` instance from `lib/scoring.js`
  - `scorer.rec(phase, name, exp, got, ok, detail)` — record with console output
  - `scorer.recQ(phase, name, exp, got, ok, detail)` — record silently (bulk tests)
  - `scorer.addError(severity, phase, title, detail, fix)` — add error for report
  - `scorer.addRec(category, title, detail)` — add recommendation
- `config` — configuration from `lib/config.js`
  - `config.apiBaseUrl`, `config.apiUrl`, `config.apiKey`, etc.
- `context` — shared state between phases
  - `context.catalog` — tool list from P0
  - `context.hasMPP`, `context.hasX402` — detection flags
  - `context.balBase`, `context.balTempo` — wallet balances
  - `context.spentX402`, `context.spentMPP` — cumulative spend
  - `context.freshAuth` — headers with fresh API key

## Steps to Add a Phase

1. Create `src/phases/NN-your-phase.js`
2. Import in `src/index.js`:
   ```javascript
   const phaseN = require('./phases/NN-your-phase');
   ```
3. Add to the phase runner:
   ```javascript
   if (config.phaseEnabled(N)) await phaseN(scorer, config, context);
   ```
4. Update weight in `lib/reporter.js` weights array
5. Update README.md phase table

## Available Libraries

```javascript
const { sf, drain, getDelay } = require('../lib/http');
const { getMppClient, parseMppChallenge } = require('../lib/mpp-client');
const { makeX402Payment, getWalletAddress } = require('../lib/x402-client');
const { mcpRequest } = require('../lib/mcp-client');
const { getBody, shouldSkip } = require('../utils/assert');
```

## Conventions

- Phase ID format: `PN` (e.g., `P7` for security)
- Test ID format: `N.X description` (e.g., `7.1 No auth → 401`)
- Use `rec()` for important tests, `recQ()` for bulk scans
- Always `await drain(r)` after reading response body
- Always `await sleep(getDelay(toolId))` between tool calls
