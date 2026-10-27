// Free, read-only wallet balance pre-flight (T-0602): one eth_call per rail,
// using the chain config the mppx and x402 clients already rely on (viem
// chains, mppx Tempo USDC.e, x402 Base USDC). No dependency added, no signing.
const NEED_USD = { tempo: 0.035, base: 0.030 };
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ERC20_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }],
}];

const floorUsd = () => {
  const v = parseFloat(process.env.WALLET_FLOOR_USD || '1.50');
  return Number.isFinite(v) ? v : 1.5;
};

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

// Returns USD (6-decimal stablecoin) or null when it cannot be read in one call.
async function readRail(rail, signerKey) {
  try {
    const { createPublicClient, http } = require('viem');
    const { privateKeyToAccount } = require('viem/accounts');
    const chains = require('viem/chains');
    const owner = privateKeyToAccount(signerKey).address;
    let chain; let token;
    if (rail === 'tempo') {
      chain = chains.tempo;
      token = require('viem/tokens').usdce(chain.id).address;
    } else {
      chain = chains.base;
      token = BASE_USDC;
    }
    const client = createPublicClient({ chain, transport: http(undefined, { retryCount: 0 }) });
    const raw = await withTimeout(client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }), 10000);
    return Number(raw) / 1e6;
  } catch {
    return null;
  }
}

const fmt = (v) => (v === null ? 'unknown' : v.toFixed(4));

// Prints the wallet-balance line (both rails) and the floor warning. Returns
// { tempo, base, short } where `short` is a text when `rail` is known to be
// below the per-run need (caller records BLOCKED(wallet-empty)), else null.
async function walletPreflight(config, rail, read = readRail) {
  const [tempo, base] = await Promise.all([read('tempo', config.privateKey), read('base', config.privateKey)]);
  console.log(`  wallet-balance: tempo=${tempo === null ? 'unknown' : fmt(tempo)} base=${fmt(base)}`);
  const floor = floorUsd();
  if ((tempo !== null && tempo < floor) || (base !== null && base < floor)) {
    console.log('  [WARN] wallet below floor, ask the operator to refill to $5');
  }
  const bal = rail === 'tempo' ? tempo : base;
  const short = bal !== null && bal < NEED_USD[rail]
    ? `${rail} balance $${bal.toFixed(4)} < per-run need $${NEED_USD[rail]}` : null;
  return { tempo, base, short };
}

module.exports = { walletPreflight, readRail, NEED_USD };
