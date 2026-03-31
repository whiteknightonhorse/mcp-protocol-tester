/**
 * Phase 19 — CDP Dual-Facilitator Tests
 * Tests the CDP/PayAI dual-facilitator architecture.
 * Validates 402 response integrity, wallet consistency,
 * facilitator health, and architecture correctness.
 * All tests are read-only — no real payments.
 */
const { sf, drain } = require('../lib/http');

const PHASE = 'P19';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EXPECTED_WALLET = '0x50EbDa9dA5dC19c302Ca059d7B9E06e264936480';
const EXPECTED_NETWORK = 'eip155:8453';
const EXPECTED_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

module.exports = async function phase19(scorer, config, context) {
  console.log('\n== PHASE 19: CDP DUAL-FACILITATOR ==\n');

  const AUTH = { 'Content-Type': 'application/json' };
  if (config.apiKey) AUTH['Authorization'] = `Bearer ${config.apiKey}`;

  // ══════════════════════════════════════════════════════════════
  //  Group 1: Facilitator Health (4 tests)
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Facilitator Health ---');

  // T19.1 — PayAI /supported reachable
  const payaiRes = await sf('https://facilitator.payai.network/supported', {}, 10000);
  let payaiBody = null;
  if (payaiRes.status === 200) {
    try { payaiBody = await payaiRes.json(); } catch { await drain(payaiRes); }
  } else { await drain(payaiRes); }
  const hasKinds = Array.isArray(payaiBody?.kinds);
  scorer.rec(PHASE, '19.1 PayAI /supported', '200 + kinds', payaiRes.status,
    payaiRes.status === 200 && hasKinds,
    hasKinds ? `${payaiBody.kinds.length} kinds` : 'missing kinds array');
  await sleep(300);

  // T19.2 — PayAI supports Base mainnet
  let hasBase = false;
  if (hasKinds) {
    hasBase = payaiBody.kinds.some(k =>
      k.network === EXPECTED_NETWORK || k === EXPECTED_NETWORK
    );
  }
  scorer.rec(PHASE, '19.2 PayAI Base mainnet', EXPECTED_NETWORK,
    hasBase ? 'found' : 'missing', hasBase,
    hasBase ? 'eip155:8453 supported' : 'Base mainnet not in kinds');
  await sleep(200);

  // T19.3 — PayAI has Bazaar extension
  let hasBazaar = false;
  if (payaiBody) {
    const extensions = payaiBody.extensions || [];
    hasBazaar = extensions.includes('bazaar');
  }
  scorer.rec(PHASE, '19.3 PayAI Bazaar extension', 'bazaar', hasBazaar ? 'found' : 'missing',
    hasBazaar, hasBazaar ? 'Bazaar auto-registration enabled' : 'no bazaar extension');
  await sleep(200);

  // T19.4 — CDP /supported requires auth (401 without JWT)
  const cdpRes = await sf('https://api.cdp.coinbase.com/platform/v2/x402/supported', {}, 10000);
  scorer.rec(PHASE, '19.4 CDP requires auth', '401', cdpRes.status,
    cdpRes.status === 401,
    cdpRes.status === 401 ? 'CDP alive + auth-gated (expected)' :
    cdpRes.status === 200 ? 'CDP open (unexpected)' : `status=${cdpRes.status}`);
  await drain(cdpRes);
  await sleep(300);

  // ══════════════════════════════════════════════════════════════
  //  Group 2: 402 Response Integrity (6 tests)
  // ══════════════════════════════════════════════════════════════
  console.log('\n  (waiting 5s for rate limit cooldown after earlier phases...)');
  await sleep(5000);
  console.log('  --- 402 Response Integrity ---');

  // Probe 3 paid tools from different providers
  const probeTools = ['crypto.trending', 'earthquake.feed', 'books.search'];
  const wallets = [];
  const networks = [];
  const assets = [];
  let allVersions = [];
  let mppHeaders = [];

  for (const toolId of probeTools) {
    let r = await sf(`${config.apiUrl}/tools/${toolId}/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });

    // Retry on rate limit (server returns 400 or 429 when limit exhausted)
    if (r.status === 400 || r.status === 429) {
      await drain(r);
      console.log(`    rate limited on ${toolId}, waiting 10s...`);
      await sleep(10000);
      r = await sf(`${config.apiUrl}/tools/${toolId}/call`, {
        method: 'POST', headers: AUTH, body: '{}',
      });
    }

    if (r.status === 402) {
      const wwwAuth = r.headers?.get?.('www-authenticate') || '';
      mppHeaders.push(wwwAuth.toLowerCase().includes('payment'));

      let body = null;
      try { body = await r.json(); } catch { await drain(r); }

      if (body) {
        wallets.push(body.payment_address || body.accepts?.[0]?.payTo || '');
        networks.push(body.accepts?.[0]?.network || '');
        assets.push(body.accepts?.[0]?.asset || '');
        allVersions.push(body.x402Version);
      }
    } else {
      await drain(r);
    }
    await sleep(300);
  }

  // T19.5 — Correct wallet on all tools
  const allCorrectWallet = wallets.length >= 2 && wallets.every(w =>
    w.toLowerCase() === EXPECTED_WALLET.toLowerCase()
  );
  scorer.rec(PHASE, '19.5 correct wallet', EXPECTED_WALLET.slice(0, 10) + '...',
    wallets.length > 0 ? wallets[0].slice(0, 10) + '...' : 'none',
    allCorrectWallet,
    `checked ${wallets.length} tools`);

  // T19.6 — Correct network (Base mainnet)
  const allCorrectNet = networks.length >= 2 && networks.every(n => n === EXPECTED_NETWORK);
  scorer.rec(PHASE, '19.6 correct network', EXPECTED_NETWORK,
    networks[0] || 'none', allCorrectNet,
    `${networks.filter(n => n === EXPECTED_NETWORK).length}/${networks.length} correct`);

  // T19.7 — Correct USDC asset
  const allCorrectAsset = assets.length >= 2 && assets.every(a =>
    a.toLowerCase() === EXPECTED_USDC.toLowerCase()
  );
  scorer.rec(PHASE, '19.7 correct USDC asset', EXPECTED_USDC.slice(0, 10) + '...',
    assets.length > 0 ? assets[0].slice(0, 10) + '...' : 'none',
    allCorrectAsset);

  // T19.8 — x402Version 2
  const allV2 = allVersions.length >= 2 && allVersions.every(v => v === 2);
  scorer.rec(PHASE, '19.8 x402Version 2', '2',
    allVersions[0] || 'none', allV2,
    `versions: ${allVersions.join(', ')}`);

  // T19.9 — Wallet consistent across ALL tools (no collision)
  const uniqueWallets = [...new Set(wallets.map(w => w.toLowerCase()))];
  scorer.rec(PHASE, '19.9 wallet consistent', '1 unique',
    `${uniqueWallets.length} unique`, uniqueWallets.length === 1,
    uniqueWallets.length === 1 ? 'no per-tool wallet collision' :
    `INCONSISTENT: ${uniqueWallets.join(', ')}`);

  // T19.10 — MPP dual-rail header present
  const allHaveMpp = mppHeaders.length >= 2 && mppHeaders.every(h => h === true);
  scorer.rec(PHASE, '19.10 MPP dual-rail header', 'all have Payment',
    `${mppHeaders.filter(Boolean).length}/${mppHeaders.length}`,
    allHaveMpp,
    allHaveMpp ? 'WWW-Authenticate: Payment on all 402s' : 'some tools missing MPP header');
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  Group 3: Architecture Integrity (4 tests)
  // ══════════════════════════════════════════════════════════════
  console.log('\n  --- Architecture Integrity ---');

  // T19.11 — Health endpoint OK
  const healthRes = await sf(`${config.apiBaseUrl}/health/ready`);
  let healthBody = null;
  try { healthBody = await healthRes.json(); } catch { await drain(healthRes); }
  const healthOk = healthRes.status === 200
    && healthBody?.status === 'ready'
    && healthBody?.checks?.postgresql === true
    && healthBody?.checks?.redis === true;
  scorer.rec(PHASE, '19.11 health ready', '200 + pg + redis',
    healthRes.status, healthOk,
    healthBody ? `pg=${healthBody.checks?.postgresql} redis=${healthBody.checks?.redis}` : '');
  await sleep(200);

  // T19.12 — Catalog returns 400+ tools
  const catalogRes = await sf(`${config.apiUrl}/tools?limit=1000`);
  let catalogTools = [];
  if (catalogRes.status === 200) {
    const data = await catalogRes.json();
    catalogTools = data.data || data.tools || (Array.isArray(data) ? data : []);
  } else { await drain(catalogRes); }
  scorer.rec(PHASE, '19.12 catalog 400+ tools', '>=400',
    catalogTools.length, catalogTools.length >= 400,
    `${catalogTools.length} tools in catalog`);
  await sleep(200);

  // T19.13 — Free tools don't require payment
  const freeToolId = 'account.usage';
  const freeRes = await sf(`${config.apiUrl}/tools/${freeToolId}/call`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({ period: '1d' }),
  });
  scorer.rec(PHASE, '19.13 free tool bypass escrow', '200',
    freeRes.status, freeRes.status === 200,
    freeRes.status === 200 ? 'free tool returns data without payment' :
    freeRes.status === 402 ? 'BUG: free tool requires payment!' : `status=${freeRes.status}`);
  await drain(freeRes);
  await sleep(200);

  // T19.14 — Paid tools enforce payment
  const paidRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST', headers: AUTH, body: '{}',
  });
  let paidBody = null;
  try { paidBody = await paidRes.json(); } catch { await drain(paidRes); }
  const enforced = paidRes.status === 402 && paidBody?.error === 'payment_required';
  scorer.rec(PHASE, '19.14 paid tool enforces 402', '402 + payment_required',
    paidRes.status, enforced,
    enforced ? 'escrow hard gate active' : `got ${paidRes.status}: ${paidBody?.error || ''}`);

  // 19.X Facilitator DNS/TLS check
  try {
    const tls = require('tls');
    const facHost = 'facilitator.payai.network';
    const facTls = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: facHost, port: 443, servername: facHost }, () => {
        const cert = socket.getPeerCertificate();
        const proto = socket.getProtocol();
        socket.destroy();
        resolve({ proto, valid_to: cert.valid_to, subject: cert.subject?.CN });
      });
      socket.setTimeout(5000);
      socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
      socket.on('error', reject);
    });
    scorer.rec(PHASE, '19.X facilitator TLS', 'valid cert', facTls.proto,
      facTls.proto === 'TLSv1.3' || facTls.proto === 'TLSv1.2',
      `CN=${facTls.subject} expires=${facTls.valid_to}`);
  } catch(e) {
    scorer.rec(PHASE, '19.X facilitator TLS', 'check', 'error', false, e.message.slice(0, 60));
  }

  // 19.X Wallet address matches known constant
  scorer.rec(PHASE, '19.X wallet constant check', EXPECTED_WALLET.slice(0,10),
    wallets[0]?.slice(0,10) || 'none',
    wallets.length > 0 && wallets[0]?.toLowerCase() === EXPECTED_WALLET.toLowerCase(),
    'wallet matches hardcoded expected value');

  // Summary
  const total = scorer.all.filter(t => t.phase === PHASE).length;
  const passed = scorer.all.filter(t => t.phase === PHASE && t.ok).length;
  console.log(`\n  CDP facilitator: ${passed}/${total} passed`);
};
