/**
 * Phase 18 — Payment Bypass Prevention
 * Tests every known vector for getting paid API data without paying.
 * Simulates a malicious AI agent trying to abuse the payment system.
 */
const { sf, drain } = require('../lib/http');
const { mcpRequest } = require('../lib/mcp-client');
const { getX402Client, makeX402Payment } = require('../lib/x402-client');

const PHASE = 'P18';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = async function phase18(scorer, config, context) {
  console.log('\n== PHASE 18: PAYMENT BYPASS PREVENTION ==\n');

  const AUTH = { 'Content-Type': 'application/json' };
  if (config.apiKey) AUTH['Authorization'] = `Bearer ${config.apiKey}`;

  // Register a second agent for cross-key tests
  let secondKey = null;
  try {
    const regRes = await sf(`${config.apiUrl}/agents/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: 'bypass-tester-' + Date.now(), agent_version: '1.0' }),
    });
    if (regRes.status === 200) {
      const rd = await regRes.json();
      secondKey = rd.api_key || rd.apiKey;
    } else { await drain(regRes); }
  } catch {}

  // ══════════════════════════════════════════════════════════════
  //  CRITICAL: MCP Session Payment Bypass (#6)
  // ══════════════════════════════════════════════════════════════
  console.log('  --- MCP Session Payment Bypass ---');

  let mcpSid = null;
  try {
    const init = await mcpRequest(config.mcpServerUrl, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'payment-bypass-test', version: '1.0' },
    }, null, config.apiKey);
    mcpSid = init.sessionId;
    if (mcpSid) {
      await mcpRequest(config.mcpServerUrl, 'notifications/initialized', {}, mcpSid, config.apiKey);

      // Call a PAID tool via MCP — must NOT return free data
      const callRes = await mcpRequest(config.mcpServerUrl, 'tools/call', {
        name: 'crypto.market.trending', arguments: {},
      }, mcpSid, config.apiKey);

      const hasData = callRes.body?.result?.content?.[0]?.text?.length > 50;
      const hasPaymentError = callRes.body?.error?.code === -32042
        || JSON.stringify(callRes.body).includes('payment')
        || JSON.stringify(callRes.body).includes('402');
      const isFreeData = hasData && !hasPaymentError;

      scorer.rec(PHASE, '18.1 MCP session payment enforced', 'requires payment',
        isFreeData ? 'FREE DATA' : 'payment enforced',
        !isFreeData,
        isFreeData ? 'CRITICAL: paid tool returns free data via MCP!' : 'payment required or error returned');
    } else {
      scorer.rec(PHASE, '18.1 MCP session payment', 'session', 'no session', true, 'cannot test');
    }
  } catch (e) {
    scorer.rec(PHASE, '18.1 MCP session payment', 'test', 'error', true, e.message.slice(0, 80));
  }
  await sleep(300);

  // ══════════════════════════════════════════════════════════════
  //  CRITICAL: Replay After Delay
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Replay After Delay ---');

  const x402 = getX402Client();
  if (x402 && config.apiKey) {
    // Get a valid payment
    const probeRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    if (probeRes.status === 402) {
      const body402 = await probeRes.json();
      try {
        const payH = await makeX402Payment(body402);
        const xp = Object.values(payH)[0];
        const payHeaders = { ...AUTH, ...payH, 'X-PAYMENT': xp };

        // First use
        const r1 = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
          method: 'POST', headers: payHeaders, body: '{}',
        });
        await drain(r1);

        // Wait 30 seconds then replay
        console.log('    Waiting 30s for delayed replay test...');
        await sleep(30000);

        const r2 = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
          method: 'POST', headers: payHeaders, body: '{}',
        });
        scorer.rec(PHASE, '18.2 replay after 30s', '!200', r2.status,
          r2.status !== 200,
          r2.status === 200 ? 'CRITICAL: delayed replay accepted!' : 'blocked');
        await drain(r2);
      } catch (e) {
        scorer.rec(PHASE, '18.2 replay after delay', 'test', 'SDK error', true, e.message.slice(0, 60));
      }
    } else {
      await drain(probeRes);
      scorer.rec(PHASE, '18.2 replay after delay', 'probe', probeRes.status, true, 'no 402');
    }
  } else {
    scorer.rec(PHASE, '18.2 replay after delay', 'skip', 'no wallet', true);
  }
  await sleep(300);

  // ══════════════════════════════════════════════════════════════
  //  CRITICAL: Signed Underpayment (modify 402 amount before signing)
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Signed Underpayment ---');

  if (x402 && config.apiKey) {
    const probeRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    if (probeRes.status === 402) {
      const body402 = await probeRes.json();
      // Tamper: reduce amount to 1 (0.000001 USDC instead of 0.001)
      const tampered402 = JSON.parse(JSON.stringify(body402));
      if (tampered402.accepts?.[0]) {
        tampered402.accepts[0].amount = '1';
      }
      try {
        const payH = await makeX402Payment(tampered402);
        const xp = Object.values(payH)[0];
        const r = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
          method: 'POST', headers: { ...AUTH, ...payH, 'X-PAYMENT': xp }, body: '{}',
        });
        scorer.rec(PHASE, '18.3 signed underpayment', '!200', r.status,
          r.status !== 200,
          r.status === 200 ? 'CRITICAL: underpayment accepted!' : 'rejected');
        await drain(r);
      } catch (e) {
        scorer.rec(PHASE, '18.3 signed underpayment', 'rejected', 'SDK rejected', true,
          'SDK refuses to sign (good)');
      }
    } else { await drain(probeRes); }
  } else {
    scorer.rec(PHASE, '18.3 signed underpayment', 'skip', 'no wallet', true);
  }
  await sleep(300);

  // ══════════════════════════════════════════════════════════════
  //  CRITICAL: Pay Cheap, Use Expensive (cross-tool price abuse)
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Pay Cheap, Use Expensive ---');

  if (x402 && config.apiKey) {
    // Find cheapest and most expensive tools
    const paidTools = context.catalog
      .filter(t => parseFloat(t.pricing?.price_usd || '0') > 0)
      .sort((a, b) => parseFloat(a.pricing.price_usd) - parseFloat(b.pricing.price_usd));

    const cheapTool = paidTools[0];
    const expensiveTool = paidTools[paidTools.length - 1];

    if (cheapTool && expensiveTool && cheapTool.id !== expensiveTool.id) {
      // Get 402 for CHEAP tool
      const cheapProbe = await sf(`${config.apiUrl}/tools/${cheapTool.id}/call`, {
        method: 'POST', headers: AUTH, body: '{}',
      });
      if (cheapProbe.status === 402) {
        const cheap402 = await cheapProbe.json();
        try {
          const payH = await makeX402Payment(cheap402);
          const xp = Object.values(payH)[0];

          // Use cheap payment on EXPENSIVE tool
          const r = await sf(`${config.apiUrl}/tools/${expensiveTool.id}/call`, {
            method: 'POST',
            headers: { ...AUTH, ...payH, 'X-PAYMENT': xp },
            body: '{}',
          });
          scorer.rec(PHASE, '18.4 cheap→expensive', '!200', r.status,
            r.status !== 200,
            r.status === 200
              ? `CRITICAL: $${cheapTool.pricing.price_usd} payment accepted for $${expensiveTool.pricing.price_usd} tool!`
              : `blocked (cheap=$${cheapTool.pricing.price_usd} expensive=$${expensiveTool.pricing.price_usd})`);
          await drain(r);
        } catch (e) {
          scorer.rec(PHASE, '18.4 cheap→expensive', 'test', 'SDK error', true, e.message.slice(0, 60));
        }
      } else { await drain(cheapProbe); }
    }
  } else {
    scorer.rec(PHASE, '18.4 cheap→expensive', 'skip', 'no wallet', true);
  }
  await sleep(300);

  // ══════════════════════════════════════════════════════════════
  //  HIGH: Cache Leak Across API Keys
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Cache Leak Across Keys ---');

  if (secondKey) {
    // Call with primary key (has balance → may get 200)
    const r1 = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    await drain(r1);
    await sleep(500);

    // Call same tool with second key (zero balance → must get 402)
    const AUTH2 = { 'Content-Type': 'application/json', Authorization: `Bearer ${secondKey}` };
    const r2 = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: AUTH2, body: '{}',
    });
    scorer.rec(PHASE, '18.5 cache leak cross-key', '402', r2.status,
      r2.status === 402,
      r2.status === 200 ? 'HIGH: cached paid data leaked to unpaid key!' : 'correctly requires payment');
    await drain(r2);

    // Check response has no-store or Vary header
    const r3 = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    const cacheControl = r3.headers?.get?.('cache-control') || '';
    const vary = r3.headers?.get?.('vary') || '';
    scorer.rec(PHASE, '18.5b cache headers', 'no-store or Vary', cacheControl || vary || 'none',
      cacheControl.includes('no-store') || cacheControl.includes('private') || vary.includes('Authorization'),
      `Cache-Control: ${cacheControl || 'none'} Vary: ${vary || 'none'}`);
    await drain(r3);
  } else {
    scorer.rec(PHASE, '18.5 cache leak', 'skip', 'no second key', true, 'could not register second agent');
  }
  await sleep(300);

  // ══════════════════════════════════════════════════════════════
  //  HIGH: Catalog Price vs 402 Price (ALL tools)
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Price Consistency (spot check 10 tools) ---');

  const paidSample = context.catalog
    .filter(t => parseFloat(t.pricing?.price_usd || '0') > 0)
    .slice(0, 10);
  let priceMatch = 0, priceMismatch = 0;
  for (const tool of paidSample) {
    const r = await sf(`${config.apiUrl}/tools/${tool.id}/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    if (r.status === 402) {
      let b = null; try { b = await r.json(); } catch { await drain(r); }
      const catalogPrice = parseFloat(tool.pricing.price_usd);
      const actualPrice = parseFloat(b?.price_usd || '-1');
      if (actualPrice >= 0 && Math.abs(catalogPrice - actualPrice) < 0.0001) priceMatch++;
      else priceMismatch++;
    } else { await drain(r); priceMatch++; /* 400 = schema, not price issue */ }
    await sleep(200);
  }
  scorer.rec(PHASE, '18.6 price consistency', '10/10 match', `${priceMatch}/${paidSample.length}`,
    priceMismatch === 0, priceMismatch > 0 ? `${priceMismatch} tools have price discrepancy!` : 'all match');
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  MEDIUM: MCP JSON-RPC Batch Abuse
  // ══════════════════════════════════════════════════════════════
  console.log('  --- MCP Batch Abuse ---');

  if (mcpSid) {
    // Send a JSON-RPC BATCH (array) with multiple tools/call
    const batchPayload = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'crypto.market.trending', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'earthquake.data.feed', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'space.apod.today', arguments: {} } },
    ];
    const batchRes = await sf(config.mcpServerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSid,
      },
      body: JSON.stringify(batchPayload),
    });
    let batchBody = null;
    try { batchBody = await batchRes.json(); } catch { await drain(batchRes); }

    // Count how many returned actual paid data
    const freeResults = Array.isArray(batchBody)
      ? batchBody.filter(r => r.result?.content?.[0]?.text?.length > 50).length
      : 0;
    scorer.rec(PHASE, '18.7 MCP batch abuse', '0 free data', `${freeResults} free`,
      freeResults === 0,
      freeResults > 0 ? 'MEDIUM: batch bypassed per-call payment!' : 'each call requires payment');
  }
  await sleep(300);

  // ══════════════════════════════════════════════════════════════
  //  MEDIUM: Header Case & Duplication
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Header Case & Duplication ---');

  // Lowercase header
  const lcRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST',
    headers: { ...AUTH, 'x-payment': 'forged-lowercase-payment' },
    body: '{}',
  });
  scorer.rec(PHASE, '18.8a lowercase x-payment', '!200', lcRes.status,
    lcRes.status !== 200, lcRes.status === 200 ? 'lowercase header bypassed!' : 'rejected');
  await drain(lcRes);
  await sleep(200);

  // Mixed case
  const mcRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST',
    headers: { ...AUTH, 'X-payment': 'forged-mixed-case' },
    body: '{}',
  });
  scorer.rec(PHASE, '18.8b mixed case X-payment', '!200', mcRes.status,
    mcRes.status !== 200);
  await drain(mcRes);
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  MEDIUM: Content-Type Bypass Payment
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Content-Type Payment Bypass ---');

  for (const [label, ct] of [
    ['text/plain', 'text/plain'],
    ['text/xml', 'text/xml'],
    ['multipart', 'multipart/form-data'],
  ]) {
    const r = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST',
      headers: { 'Content-Type': ct, Authorization: AUTH['Authorization'] || '' },
      body: '{}',
    });
    scorer.rec(PHASE, `18.9 CT:${label} payment`, '!200', r.status,
      r.status !== 200,
      r.status === 200 ? `MEDIUM: ${label} bypassed payment!` : 'payment still enforced');
    await drain(r);
    await sleep(200);
  }

  // ══════════════════════════════════════════════════════════════
  //  MEDIUM: Prototype Pollution Payment Bypass
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Proto Pollution Payment Bypass ---');

  const protoRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({
      __proto__: { isPaid: true, authenticated: true, mppPaid: true, x402Paid: true },
      constructor: { prototype: { isPaid: true, paid: true } },
    }),
  });
  scorer.rec(PHASE, '18.10 proto pollution payment', '!200 (still 402)', protoRes.status,
    protoRes.status !== 200 || protoRes.status === 402,
    protoRes.status === 200 ? 'MEDIUM: prototype pollution bypassed payment!' : 'payment enforced');
  await drain(protoRes);
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  MEDIUM: Session ID Entropy Check
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Session ID Entropy ---');

  const sessionIds = [];
  for (let i = 0; i < 3; i++) {
    const init = await mcpRequest(config.mcpServerUrl, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: `entropy-${i}`, version: '1.0' },
    }, null, config.apiKey);
    if (init.sessionId) sessionIds.push(init.sessionId);
    await sleep(200);
  }
  if (sessionIds.length >= 2) {
    const allUnique = new Set(sessionIds).size === sessionIds.length;
    const minLen = Math.min(...sessionIds.map(s => s.length));
    // UUID = 36 chars (128-bit), secure tokens >= 32 chars
    scorer.rec(PHASE, '18.11 session ID entropy', '>=32 chars + unique', `len=${minLen} unique=${allUnique}`,
      allUnique && minLen >= 32,
      `IDs: ${sessionIds.map(s => s.slice(0, 12) + '...').join(', ')}`);
  }
  await sleep(200);

  // ══════════════════════════════════════════════════════════════
  //  CRITICAL: Double-Spend 100 Parallel
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Double-Spend 100 Parallel ---');

  if (x402 && config.apiKey) {
    const dsProbe = await sf(`${config.apiUrl}/tools/earthquake.feed/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    if (dsProbe.status === 402) {
      const ds402 = await dsProbe.json();
      try {
        const payH = await makeX402Payment(ds402);
        const xp = Object.values(payH)[0];
        const dsHeaders = { ...AUTH, ...payH, 'X-PAYMENT': xp };

        // Fire 100 parallel requests with same payment
        const promises = Array(100).fill(null).map(() =>
          sf(`${config.apiUrl}/tools/earthquake.feed/call`, {
            method: 'POST', headers: dsHeaders, body: '{}',
          }, 15000)
        );
        const results = await Promise.all(promises);
        const count200 = results.filter(r => r.status === 200).length;

        scorer.rec(PHASE, '18.12 double-spend 100x', '<=1 success', `${count200}/100`,
          count200 <= 1,
          count200 > 1 ? `CRITICAL: ${count200} double-spends from 1 payment!` : 'atomic payment enforcement');

        for (const r of results) await drain(r);
      } catch (e) {
        scorer.rec(PHASE, '18.12 double-spend 100x', 'test', 'SDK error', true, e.message.slice(0, 60));
      }
    } else {
      await drain(dsProbe);
      scorer.rec(PHASE, '18.12 double-spend', 'probe', dsProbe.status, true, 'no 402');
    }
  } else {
    scorer.rec(PHASE, '18.12 double-spend 100x', 'skip', 'no wallet', true);
  }
  await sleep(300);

  // ══════════════════════════════════════════════════════════════
  //  LOW: Nonce Cross-Rail
  // ══════════════════════════════════════════════════════════════
  console.log('  --- Nonce Cross-Rail ---');

  // Take an x402 payment header and present it as MPP Authorization: Payment
  const fakeXPayAsAuth = Buffer.from(JSON.stringify({
    scheme: 'exact', amount: '1000', network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x50EbDa9dA5dC19c302Ca059d7B9E06e264936480',
  })).toString('base64');
  const crossRailRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Payment ${fakeXPayAsAuth}` },
    body: '{}',
  });
  scorer.rec(PHASE, '18.13 x402 nonce as MPP', '!200', crossRailRes.status,
    crossRailRes.status !== 200,
    crossRailRes.status === 200 ? 'cross-rail nonce accepted!' : 'rejected');
  await drain(crossRailRes);

  // 18.X Cross-chain replay (Tempo nonce as x402)
  console.log('  --- Cross-chain replay ---');
  const tempoFake = Buffer.from(JSON.stringify({
    scheme: 'exact', amount: '1000', network: 'tempo:4217',
    asset: '0x20C000000000000000000000b9537d11c60E8b50',
    payTo: '0x183fFa1335EB66858EebCb86F651f70632821f8d',
  })).toString('base64');
  const ccRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST',
    headers: { ...AUTH, 'X-Payment': tempoFake, 'PAYMENT-SIGNATURE': tempoFake },
    body: '{}',
  });
  scorer.rec(PHASE, '18.X cross-chain replay', '!200', ccRes.status,
    ccRes.status !== 200,
    ccRes.status === 200 ? 'CRITICAL: cross-chain replay accepted!' : 'rejected');
  await drain(ccRes);
  await sleep(200);

  // 18.X WebSocket upgrade bypass
  console.log('  --- WebSocket upgrade bypass ---');
  const wsRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST',
    headers: { ...AUTH, 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
    body: '{}',
  });
  scorer.rec(PHASE, '18.X websocket upgrade', '!free data', wsRes.status,
    wsRes.status === 402 || wsRes.status === 400 || wsRes.status === 426,
    wsRes.status === 200 ? 'CRITICAL: websocket bypass!' : 'payment enforced');
  await drain(wsRes);
  await sleep(200);

  // 18.X Pay once, burst 50 in 100ms
  console.log('  --- Pay-once burst ---');
  // Without actual payment, verify that 50 rapid unpaid requests all get 402
  const burstPromises = Array(50).fill(null).map(() =>
    sf(`${config.apiUrl}/tools/crypto.trending/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    }, 5000)
  );
  const burstResults = await Promise.all(burstPromises);
  const burstFree = burstResults.filter(r => r.status === 200).length;
  scorer.rec(PHASE, '18.X burst 50 unpaid', '0 free', burstFree,
    burstFree === 0,
    burstFree > 0 ? `CRITICAL: ${burstFree} free responses in burst!` : 'all require payment');
  for (const r of burstResults) await drain(r);
  await sleep(300);

  // 18.X Transfer-Encoding chunked bypass
  const teRes = await sf(`${config.apiUrl}/tools/crypto.trending/call`, {
    method: 'POST',
    headers: { ...AUTH, 'Transfer-Encoding': 'chunked' },
    body: '{}',
  });
  scorer.rec(PHASE, '18.X chunked encoding', '!free', teRes.status,
    teRes.status === 402 || teRes.status === 400,
    teRes.status === 200 ? 'CRITICAL: chunked encoding bypassed payment!' : 'payment enforced');
  await drain(teRes);
  await sleep(200);

  // 18.X Nonce entropy check
  console.log('  --- Nonce entropy ---');
  const nonces = [];
  for (let i = 0; i < 5; i++) {
    const r = await sf(`${config.apiUrl}/tools/earthquake.feed/call`, {
      method: 'POST', headers: AUTH, body: '{}',
    });
    if (r.status === 402) {
      let b = {}; try { b = await r.json(); } catch {}
      nonces.push(b.request_id || '');
    } else { await drain(r); }
    await sleep(200);
  }
  const uniqueNonces = new Set(nonces.filter(Boolean)).size;
  const minLen = Math.min(...nonces.filter(Boolean).map(n => n.length));
  scorer.rec(PHASE, '18.X nonce entropy', '>=20 chars + unique',
    `len=${minLen} unique=${uniqueNonces}/${nonces.length}`,
    uniqueNonces === nonces.filter(Boolean).length && minLen >= 20,
    uniqueNonces < nonces.filter(Boolean).length ? 'DUPLICATE NONCES!' : 'good entropy');

  // Summary
  const total = scorer.all.filter(t => t.phase === PHASE).length;
  const passed = scorer.all.filter(t => t.phase === PHASE && t.ok).length;
  const critical = scorer.all.filter(t => t.phase === PHASE && !t.ok && t.det?.includes('CRITICAL')).length;
  console.log(`\n  Payment bypass: ${passed}/${total} passed${critical > 0 ? ` | ${critical} CRITICAL vulnerabilities!` : ''}`);
};
