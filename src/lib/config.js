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
};

config.phaseEnabled = (n) => !config.phases || config.phases.has(n);

// Derived URLs
config.apiUrl = `${config.apiBaseUrl}/api/v1`;

module.exports = config;
