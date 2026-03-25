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
const { initX402, getWalletAddress } = require('./lib/x402-client');
const { initMPP } = require('./lib/mpp-client');
const { generateReport } = require('./lib/reporter');

// Phase modules
const phase0 = require('./phases/00-discovery');
const phase1 = require('./phases/01-infrastructure');
const phase2 = require('./phases/02-mpp-challenges');
const phase3 = require('./phases/03-x402-challenges');
const phase4 = require('./phases/04-mcp-protocol');
const phase5 = require('./phases/05-mpp-payments');
const phase6 = require('./phases/06-x402-payments');
const phase7 = require('./phases/07-security');
const phase8 = require('./phases/08-load');
const phase9 = require('./phases/09-report');

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
  console.log(`  PRIVATE_KEY: ${config.privateKey ? 'set' : 'NOT SET'}`);
  console.log(`  Budget: $${config.maxBudget}/protocol | Skip payments: ${config.skipPayments}`);
  if (config.phases) console.log(`  Phases: ${[...config.phases].join(',')}`);
  console.log(`${'='.repeat(76)}\n`);

  // Init payment clients
  const x402ok = config.privateKey ? initX402(config.privateKey) : false;
  const mppok = config.privateKey ? initMPP(config.privateKey) : false;
  console.log(`  x402 wallet: ${x402ok ? getWalletAddress() : 'NONE'}`);
  console.log(`  MPP client:  ${mppok ? 'ready' : 'NONE'}\n`);

  // Run phases
  if (config.phaseEnabled(0)) await phase0(scorer, config, context);
  if (config.phaseEnabled(1)) await phase1(scorer, config, context);
  if (config.phaseEnabled(2)) await phase2(scorer, config, context);
  if (config.phaseEnabled(3)) await phase3(scorer, config, context);
  if (config.phaseEnabled(4)) await phase4(scorer, config, context);
  if (config.phaseEnabled(5)) await phase5(scorer, config, context);
  if (config.phaseEnabled(6)) await phase6(scorer, config, context);
  if (config.phaseEnabled(7)) await phase7(scorer, config, context);
  if (config.phaseEnabled(8)) await phase8(scorer, config, context);

  // Always generate report
  const totalTime = Math.round((Date.now() - t0) / 1000);
  generateReport(scorer, {
    serverUrl: config.apiBaseUrl,
    toolCount: context.catalog.length,
    spentX402: context.spentX402,
    spentMPP: context.spentMPP,
    totalTime,
  });

  console.log(`\nTotal: ${totalTime}s | x402: $${context.spentX402.toFixed(4)} | MPP: $${context.spentMPP.toFixed(4)}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
