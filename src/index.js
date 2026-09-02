#!/usr/bin/env node
/**
 * MCP Protocol Tester — Universal dual-rail test suite
 *
 * Tests x402 (USDC on Base) and MPP (USDC on Tempo) protocols
 * simultaneously across all tools on any MCP-compatible server.
 *
 * Usage:
 *   npm test                          # Full test
 *   SKIP_PAYMENTS=true npm test       # Dry run
 *   PHASES=0,1,7 npm test             # Specific phases
 *   MCP_SERVER_URL=https://... npm test  # Custom server
 */

const config = require('./lib/config');
const { Scorer } = require('./lib/scoring');
const { setTesterId } = require('./lib/http');
const { initX402, getWalletAddress } = require('./lib/x402-client');
const { initMPP } = require('./lib/mpp-client');
const { generateReport } = require('./lib/reporter');

// Phase modules (18 phases: P0-P17 + report)
const phase0  = require('./phases/00-discovery');
const phase1  = require('./phases/01-infrastructure');
const phase2  = require('./phases/02-mpp-challenges');
const phase3  = require('./phases/03-x402-challenges');
const phase4  = require('./phases/04-mcp-protocol');
const phase5  = require('./phases/05-mpp-payments');
const phase6  = require('./phases/06-x402-payments');
const phase7  = require('./phases/07-security');
const phase8  = require('./phases/08-payment-security');
const phase9  = require('./phases/09-advanced-security');
const phase10 = require('./phases/10-resilience');
const phase11 = require('./phases/11-load');
const phase12 = require('./phases/12-provider-health');
const phase13 = require('./phases/13-cache-simulation');
const phase14 = require('./phases/14-discover-tools');
const phase15 = require('./phases/16-platform-features');
const phase16 = require('./phases/17-agent-experience');
const phase17 = require('./phases/18-payment-bypass');
const phase18 = require('./phases/19-cdp-facilitator');
// Э3 (Fable's audit 2026-09-02) — coverage-parity phases.
const phase20 = require('./phases/20-moderation-settle');
const phase21 = require('./phases/21-appeals');
const phase22 = require('./phases/22-balance-rail');
const phase23 = require('./phases/23-devices');
const phase24 = require('./phases/24-docs-truth');
const phase25 = require('./phases/25-time-promises');
const phase26 = require('./phases/26-coverage-parity');
const phaseReport = require('./phases/15-report');

async function main() {
  const t0 = Date.now();
  const scorer = new Scorer();
  const context = {
    catalog: [],
    hasMPP: false,
    hasX402: false,
    balBase: 0,
    balTempo: 0,
    spentX402: 0,
    spentMPP: 0,
    freshAuth: null,
  };

  console.log(`\n${'='.repeat(76)}`);
  console.log('  MCP PROTOCOL TESTER — Dual-Rail Test Suite');
  console.log(`  Server: ${config.apiBaseUrl}`);
  console.log(`  ${new Date().toISOString()}`);
  const walletReady = !!config.privateKey;
  console.log(`  Wallet: ${walletReady ? 'configured' : 'NOT SET'}`);
  console.log(`  Budget: $${config.maxBudget}/protocol | Skip payments: ${config.skipPayments}`);
  console.log(`  Tester ID (X-APIbase-Tester): ${config.testerRunId}`);
  if (config.phases) console.log(`  Phases: ${[...config.phases].join(',')}`);
  console.log(`${'='.repeat(76)}\n`);

  // Э6 — every outbound request carries this so prod observability can
  // segment tester traffic; deliberately NOT a bypass allow-list (bans,
  // moderation, rate limits must all still apply to the tester).
  setTesterId(config.testerRunId);

  // Init payment clients
  const x402ok = config.privateKey ? initX402(config.privateKey) : false;
  const mppok = config.privateKey ? initMPP(config.privateKey) : false;
  console.log(`  x402 wallet: ${x402ok ? getWalletAddress() : 'NONE'}`);
  console.log(`  MPP client:  ${mppok ? 'ready' : 'NONE'}\n`);

  // Phase 0 always runs (other phases depend on context.catalog)
  await phase0(scorer, config, context);
  if (context.catalog.length === 0) {
    console.log('\n  WARNING: catalog is empty — subsequent phases may produce misleading results\n');
  }
  if (config.phaseEnabled(1))  await phase1(scorer, config, context);
  if (config.phaseEnabled(2))  await phase2(scorer, config, context);
  if (config.phaseEnabled(3))  await phase3(scorer, config, context);
  if (config.phaseEnabled(4))  await phase4(scorer, config, context);
  if (config.phaseEnabled(5))  await phase5(scorer, config, context);
  if (config.phaseEnabled(6))  await phase6(scorer, config, context);
  if (config.phaseEnabled(7))  await phase7(scorer, config, context);
  if (config.phaseEnabled(8))  await phase8(scorer, config, context);
  if (config.phaseEnabled(9))  await phase9(scorer, config, context);
  if (config.phaseEnabled(10)) await phase10(scorer, config, context);
  if (config.phaseEnabled(11)) await phase11(scorer, config, context);
  if (config.phaseEnabled(12)) await phase12(scorer, config, context);
  if (config.phaseEnabled(13)) await phase13(scorer, config, context);
  if (config.phaseEnabled(14)) await phase14(scorer, config, context);
  if (config.phaseEnabled(15)) await phase15(scorer, config, context);
  if (config.phaseEnabled(16)) await phase16(scorer, config, context);
  if (config.phaseEnabled(17)) await phase17(scorer, config, context);
  if (config.phaseEnabled(18)) {
    // Cooldown before CDP tests — rate limit (300 req/15min) exhausted after P0-P17 scans
    console.log('\n  (15s cooldown before CDP facilitator tests...)');
    await new Promise(r => setTimeout(r, 15000));
    await phase18(scorer, config, context);
  }
  if (config.phaseEnabled(20)) await phase20(scorer, config, context);
  if (config.phaseEnabled(21)) await phase21(scorer, config, context);
  if (config.phaseEnabled(22)) await phase22(scorer, config, context);
  if (config.phaseEnabled(23)) await phase23(scorer, config, context);
  if (config.phaseEnabled(24)) await phase24(scorer, config, context);
  if (config.phaseEnabled(25)) await phase25(scorer, config, context);
  if (config.phaseEnabled(26)) await phase26(scorer, config, context);

  // Report: Always generate
  const totalTime = Math.round((Date.now() - t0) / 1000);
  const meta = {
    serverUrl: config.apiBaseUrl,
    toolCount: context.catalog.length,
    spentX402: context.spentX402,
    spentMPP: context.spentMPP,
    totalTime,
  };
  await phaseReport(scorer, config, { ...context, ...meta });
  const { verdict } = generateReport(scorer, meta);

  console.log(`\nTotal: ${totalTime}s | x402: $${context.spentX402.toFixed(4)} | MPP: $${context.spentMPP.toFixed(4)}`);

  // Э1 — the process exit code reflects the VERDICT, not just "didn't crash".
  // run-daily.sh no longer has to re-derive this from grepping the log.
  process.exitCode = verdict === 'FAIL' ? 1 : 0;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
