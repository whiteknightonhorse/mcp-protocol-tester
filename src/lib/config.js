// Auto-load .env file if present
try { require('dotenv').config(); } catch {}

// Loads and validates environment variables
const config = {
  apiBaseUrl: process.env.API_BASE_URL || 'https://apibase.pro',
  mcpServerUrl: process.env.MCP_SERVER_URL || 'https://apibase.pro/mcp',
  apiKey: process.env.API_KEY || '',
  privateKey: process.env.PRIVATE_KEY || '',
  concurrency: parseInt(process.env.CONCURRENCY || '5', 10),
  skipPayments: process.env.SKIP_PAYMENTS === 'true' || process.env.SKIP_PAYMENTS === '1',
  phases: process.env.PHASES ? new Set(process.env.PHASES.split(',').map(s => parseInt(s.trim(), 10))) : null,
  maxTools: parseInt(process.env.MAX_TOOLS || '0', 10),
  timeoutMs: parseInt(process.env.TIMEOUT_MS || '30000', 10),
  maxBudget: parseFloat(process.env.MAX_USDC_BUDGET || '0.25'),
  // Н6 — segmentation marker sent on every outbound request (see http.js's
  // setTesterId()/sf()). run-daily.sh exports TESTER_RUN_ID so it is stable and
  // correlatable with cron.log; a standalone `node src/index.js` run generates
  // its own so the header is never blank.
  testerRunId: process.env.TESTER_RUN_ID ||
    `adhoc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,

  // Э3 new phases — each is gated on an operator-provisioned identity so a
  // real moderation-trigger/balance/device probe never runs against the
  // tester's own primary key (which the daily run needs to keep working
  // tomorrow). Absent => the phase SKIPs with a stated reason, never runs
  // against the primary key as a substitute. See docs/ADDING-PHASES.md.
  moderationSacrificialKey: process.env.MODERATION_TEST_API_KEY || '',
  balanceRailTestKey: process.env.BALANCE_RAIL_TEST_KEY || '',
  deviceTestKey: process.env.DEVICE_TEST_API_KEY || '',
  deviceTestVendor: process.env.DEVICE_TEST_VENDOR || 'tuya',
};

config.phaseEnabled = (n) => !config.phases || config.phases.has(n);

// Derived URLs
config.apiUrl = `${config.apiBaseUrl}/api/v1`;

module.exports = config;
