/**
 * Phase 1 — Infrastructure
 * Checks health endpoint, Tempo RPC, wallet USDC balances on both chains,
 * and facilitator availability.
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'P1';

const USDC_TEMPO = '0x20C000000000000000000000b9537d11c60E8b50';
const USDC_BASE  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TEMPO_RPC  = 'https://rpc.tempo.xyz';
const FACILITATOR = 'https://facilitator.payai.network/supported';

// ERC-20 balanceOf(address) selector: 0x70a08231
function balanceOfData(address) {
  const addr = address.replace('0x', '').toLowerCase().padStart(64, '0');
  return '0x70a08231' + addr;
}

async function ethCall(rpcUrl, contract, data) {
  const r = await sf(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: contract, data }, 'latest'],
    }),
  });
  if (r.status !== 200) { await drain(r); return 0n; }
  const json = await r.json();
  if (!json.result || json.result === '0x') return 0n;
  return BigInt(json.result);
}

async function rpcChainId(rpcUrl) {
  const r = await sf(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  });
  if (r.status !== 200) { await drain(r); return null; }
  const json = await r.json();
  return json.result || null;
}

module.exports = async function phase1(scorer, config, context) {
  console.log('\n--- Phase 1: Infrastructure ---');

  // 1. Health check
  const hr = await sf(`${config.apiBaseUrl}/health/ready`);
  const hOk = hr.status === 200;
  scorer.rec(PHASE, 'health-ready', 200, hr.status, hOk);
  await drain(hr);

  // 2. Tempo RPC chain ID
  const chainId = await rpcChainId(TEMPO_RPC);
  const chainOk = chainId !== null;
  scorer.rec(PHASE, 'tempo-rpc', 'chainId', chainId || 'null', chainOk,
    chainOk ? `chainId=${chainId}` : 'RPC unreachable');

  // 3. Wallet USDC balances (need wallet address from x402 client or private key)
  let walletAddr = null;
  if (config.privateKey) {
    try {
      const { privateKeyToAccount } = require('viem/accounts');
      walletAddr = privateKeyToAccount(config.privateKey).address;
    } catch {}
  }

  if (walletAddr) {
    const data = balanceOfData(walletAddr);

    // Tempo balance
    const tempoRaw = await ethCall(TEMPO_RPC, USDC_TEMPO, data);
    context.balTempo = Number(tempoRaw) / 1e6;
    scorer.rec(PHASE, 'balance-tempo-usdc', '>0', context.balTempo.toFixed(4),
      context.balTempo > 0, `${context.balTempo.toFixed(4)} USDC on Tempo`);

    // Base balance (use public RPC)
    const baseRpc = 'https://mainnet.base.org';
    const baseRaw = await ethCall(baseRpc, USDC_BASE, data);
    context.balBase = Number(baseRaw) / 1e6;
    scorer.rec(PHASE, 'balance-base-usdc', '>0', context.balBase.toFixed(4),
      context.balBase > 0, `${context.balBase.toFixed(4)} USDC on Base`);

    // Gas balance check (Tempo)
    try {
      const gasTempoRes = await sf(TEMPO_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: [walletAddr, 'latest'], id: 3 }),
      }, 10000);
      const gasTempoJson = await gasTempoRes.json();
      const gasTempoRaw = gasTempoJson.result && gasTempoJson.result !== '0x'
        ? BigInt(gasTempoJson.result) : 0n;
      context.gasBalTempo = Number(gasTempoRaw) / 1e18;
      scorer.rec(PHASE, 'gas-balance-tempo', '>0', context.gasBalTempo.toFixed(6),
        context.gasBalTempo > 0,
        `${context.gasBalTempo.toFixed(6)} native on Tempo (used for gas)`);
    } catch (e) {
      context.gasBalTempo = 0;
      scorer.rec(PHASE, 'gas-balance-tempo', '>0', 'error', false, `RPC error: ${e.message}`);
    }

    // Gas balance check (Base — ETH)
    try {
      const baseRpcUrl = 'https://mainnet.base.org';
      const gasBaseRes = await sf(baseRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: [walletAddr, 'latest'], id: 4 }),
      }, 10000);
      const gasBaseJson = await gasBaseRes.json();
      const gasBaseRaw = gasBaseJson.result && gasBaseJson.result !== '0x'
        ? BigInt(gasBaseJson.result) : 0n;
      context.gasBalBase = Number(gasBaseRaw) / 1e18;
      scorer.rec(PHASE, 'gas-balance-base', '>0', context.gasBalBase.toFixed(6),
        context.gasBalBase > 0,
        `${context.gasBalBase.toFixed(6)} ETH on Base (used for gas)`);
    } catch (e) {
      context.gasBalBase = 0;
      scorer.rec(PHASE, 'gas-balance-base', '>0', 'error', false, `RPC error: ${e.message}`);
    }
  } else {
    scorer.rec(PHASE, 'balance-tempo-usdc', '>0', 'no-key', false, 'no private key');
    scorer.rec(PHASE, 'balance-base-usdc', '>0', 'no-key', false, 'no private key');
  }

  // 4. Facilitator check
  const fr = await sf(FACILITATOR);
  const fOk = fr.status === 200;
  let facilitatorInfo = '';
  if (fOk) {
    try {
      const fd = await fr.json();
      facilitatorInfo = JSON.stringify(fd).slice(0, 100);
    } catch { await drain(fr); }
  } else {
    await drain(fr);
  }
  scorer.rec(PHASE, 'facilitator', 200, fr.status, fOk, facilitatorInfo);

  // P1.X Health info leakage check
  const healthCheckRes = await sf(`${config.apiBaseUrl}/health/ready`);
  let healthCheckBody = {};
  try { healthCheckBody = await healthCheckRes.json(); } catch { await drain(healthCheckRes); }
  const healthStr = JSON.stringify(healthCheckBody).toLowerCase();
  const leakyPatterns = ['password', 'connection', 'postgres://', 'redis://', '/app/src', '/usr/local', 'node_modules'];
  const healthLeaks = leakyPatterns.filter(p => healthStr.includes(p));
  scorer.rec(PHASE, 'health-no-leak', '0 leaks', healthLeaks.length,
    healthLeaks.length === 0,
    healthLeaks.length > 0 ? `LEAKED: ${healthLeaks.join(', ')}` : 'clean');

  console.log(`  Wallet: ${walletAddr || 'none'}`);
  console.log(`  Balances — Tempo: ${(context.balTempo || 0).toFixed(4)} USDC | Base: ${(context.balBase || 0).toFixed(4)} USDC`);
  console.log(`  Gas — Tempo: ${(context.gasBalTempo || 0).toFixed(6)} native | Base: ${(context.gasBalBase || 0).toFixed(6)} ETH`);
};
