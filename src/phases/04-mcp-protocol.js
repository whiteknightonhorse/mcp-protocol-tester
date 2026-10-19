/**
 * Phase 4 — MCP Protocol
 * Tests MCP JSON-RPC: initialize handshake, tools/list, tools/call on a
 * known tool (crypto.market.trending).
 */
const { mcpRequest } = require('../lib/mcp-client');
const { sf, drain } = require('../lib/http');
const { getX402Client, makeX402PaymentPayload } = require('../lib/x402-client');
const { attachPaymentToMeta, extractPaymentResponseFromMeta } = require('@x402/mcp');

const PHASE = 'P4';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// T-0433: MCP transport of the x402 challenge/receipt. The server puts the
// challenge in result._meta["x402/payment-required"] (same body as the HTTP
// 402) and accepts the payment in params._meta["x402/payment"].
const MCP_PAID_TOOL = { mcp: 'crypto.trending.get', rest: 'crypto.trending' };
const META_REQUIRED_KEY = 'x402/payment-required';

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

module.exports = async function phase4(scorer, config, context) {
  console.log('\n--- Phase 4: MCP Protocol ---');

  const url = config.mcpServerUrl;
  const apiKey = context.freshAuth || config.apiKey;

  // 1. Initialize
  let sid = null;
  try {
    const init = await mcpRequest(url, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: true } },
      clientInfo: { name: 'mcp-protocol-tester', version: '1.0.0' },
    }, null, apiKey);

    sid = init.sessionId;
    const hasResult = init.body && init.body.result;
    const serverInfo = hasResult ? init.body.result.serverInfo : null;

    scorer.rec(PHASE, 'mcp-initialize', '2xx', init.status, init.status === 200,
      serverInfo ? `server=${serverInfo.name}` : 'no serverInfo');

    if (sid) {
      scorer.rec(PHASE, 'mcp-session-id', 'present', sid ? 'yes' : 'no', !!sid,
        sid ? sid.slice(0, 20) + '...' : '');
    } else {
      scorer.rec(PHASE, 'mcp-session-id', 'present', 'missing', false, 'no session id returned');
    }
  } catch (e) {
    scorer.rec(PHASE, 'mcp-initialize', 'success', 'error', false, e.message);
  }

  // 2. Send initialized notification
  if (sid) {
    try {
      await mcpRequest(url, 'notifications/initialized', {}, sid, apiKey);
    } catch {}
  }

  // 3. tools/list
  if (sid) {
    try {
      const list = await mcpRequest(url, 'tools/list', {}, sid, apiKey);
      const tools = list.body?.result?.tools || [];
      scorer.rec(PHASE, 'mcp-tools-list', '>0 tools', tools.length, tools.length > 0,
        `${tools.length} tools via MCP`);
    } catch (e) {
      scorer.rec(PHASE, 'mcp-tools-list', '>0', 'error', false, e.message);
    }
  }

  // 4. tools/call — crypto.market.trending
  if (sid) {
    try {
      const call = await mcpRequest(url, 'tools/call', {
        name: 'crypto.market.trending',
        arguments: {},
      }, sid, apiKey);

      const status = call.status;
      const hasContent = call.body?.result?.content?.length > 0;
      const is402 = status === 402;

      if (status === 200 && hasContent) {
        scorer.rec(PHASE, 'mcp-tools-call', '200+content', '200+content', true,
          `${call.elapsed}ms`);
      } else if (is402) {
        scorer.rec(PHASE, 'mcp-tools-call', '200', '402', true,
          'payment required — expected for unpaid call');
      } else {
        scorer.rec(PHASE, 'mcp-tools-call', '200|402', status, false,
          `body keys: ${Object.keys(call.body || {}).join(',')}`);
      }
    } catch (e) {
      scorer.rec(PHASE, 'mcp-tools-call', 'success', 'error', false, e.message);
    }
  }

  // 4.N MCP `_meta` payment transport (T-0433).
  if (sid) {
    try {
      const restRes = await sf(`${config.apiUrl}/tools/${MCP_PAID_TOOL.rest}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: '{}',
      });
      let http402 = null;
      try { http402 = await restRes.json(); } catch { await drain(restRes); }

      const unpaid = await mcpRequest(url, 'tools/call', { name: MCP_PAID_TOOL.mcp, arguments: {} }, sid, apiKey);
      const res = unpaid.body?.result;
      const metaReq = res?._meta?.[META_REQUIRED_KEY];
      const sameAccepts = !!http402?.accepts && !!metaReq?.accepts && stable(metaReq.accepts) === stable(http402.accepts);
      scorer.rec(PHASE, '4.N unpaid paid-tool call: isError + _meta payment-required equals HTTP 402',
        'isError:true, _meta accepts[] == HTTP 402 accepts[]',
        `isError=${res?.isError} meta=${!!metaReq} equal=${sameAccepts}`,
        res?.isError === true && sameAccepts);

      const canPay = !config.skipPayments && !!config.privateKey && !!getX402Client();
      if (!canPay) {
        scorer.rec(PHASE, '4.N+1 x402 payment in params._meta returns payment-response', 'skip', 'no wallet', true,
          'payments disabled or no wallet configured');
      } else if (!metaReq?.accepts) {
        scorer.rec(PHASE, '4.N+1 x402 payment in params._meta returns payment-response', '_meta payment-response',
          'no challenge to pay', false, 'previous step produced no _meta challenge');
      } else if (context.spentX402 >= config.maxBudget) {
        scorer.rec(PHASE, '4.N+1 x402 payment in params._meta returns payment-response', 'paid', 'budget-exceeded', false,
          `spent $${context.spentX402.toFixed(4)} >= max $${config.maxBudget}`);
      } else {
        const payload = await makeX402PaymentPayload(metaReq);
        const params = attachPaymentToMeta({ name: MCP_PAID_TOOL.mcp, arguments: {} }, payload);
        const paid = await mcpRequest(url, 'tools/call', params, sid, apiKey);
        const pr = paid.body?.result;
        const settle = extractPaymentResponseFromMeta(pr);
        const ok = !!pr && pr.isError !== true && !!settle && settle.success === true;
        const price = parseFloat(http402?.price_usd) || 0;
        if (ok) context.spentX402 += price;
        scorer.rec(PHASE, '4.N+1 x402 payment in params._meta returns payment-response',
          'result + _meta x402/payment-response success',
          `isError=${pr?.isError} settle=${settle ? 'success=' + settle.success : 'absent'}`, ok,
          `cost=$${price.toFixed(6)}`);
      }
    } catch (e) {
      scorer.recCatch(PHASE, '4.N MCP _meta payment transport', '_meta challenge + payment-response', e);
    }
    await sleep(300);
  }

  // 5. Test invalid method
  let invalidRes = null;
  if (sid) {
    try {
      invalidRes = await mcpRequest(url, 'nonexistent/method', {}, sid, apiKey);
      const isError = invalidRes.body?.error || invalidRes.status >= 400;
      scorer.rec(PHASE, 'mcp-invalid-method', 'error response', isError ? 'error' : 'no error',
        isError, `status=${invalidRes.status}`);
    } catch (e) {
      scorer.rec(PHASE, 'mcp-invalid-method', 'error', 'exception', true, e.message);
    }
  }

  // 5b. Check error code is -32601 (method not found) per JSON-RPC spec
  if (invalidRes) {
    const errCode = invalidRes.body?.error?.code;
    scorer.rec(PHASE, '4.X JSON-RPC error code', '-32601', errCode,
      errCode === -32601 || errCode === -32600, `code=${errCode}`);
  }

  // 6. resources/list
  if (sid) {
    const mcpUrl = url;
    const resListRes = await mcpRequest(mcpUrl, 'resources/list', {}, sid, apiKey);
    scorer.rec(PHASE, '4.6 resources/list', 'response', resListRes.status,
      resListRes.status === 200, resListRes.body.error ? `err: ${resListRes.body.error.message}` : 'ok');
    await sleep(200);
  }

  // 7. prompts/list
  if (sid) {
    const mcpUrl = url;
    const promptsRes = await mcpRequest(mcpUrl, 'prompts/list', {}, sid, apiKey);
    scorer.rec(PHASE, '4.7 prompts/list', 'response', promptsRes.status,
      promptsRes.status === 200, `prompts: ${promptsRes.body.result?.prompts?.length ?? '?'}`);
    await sleep(200);
  }

  // 8. Protocol version negotiation (old version)
  {
    const mcpUrl = url;
    const oldVerRes = await mcpRequest(mcpUrl, 'initialize', {
      protocolVersion: '2024-01-01', capabilities: {},
      clientInfo: { name: 'version-test', version: '1.0.0' },
    }, null, apiKey);
    scorer.rec(PHASE, '4.8 old protocol version', 'handled', oldVerRes.status,
      oldVerRes.status === 200 || oldVerRes.body.error, 'server should negotiate or reject');
    await sleep(200);
  }

  // P4.X MCP session fixation
  if (sid) {
    const fixRes = await mcpRequest(url, 'tools/list', {}, sid.slice(0, -4) + '0000', apiKey);
    scorer.rec(PHASE, '4.X session fixation', '!tools', fixRes.status,
      !fixRes.body?.result?.tools?.length,
      fixRes.body?.result?.tools?.length ? 'SESSION FIXATION!' : 'rejected');
    await sleep(200);
  }

  // P4.X Oversized JSON-RPC
  const bigPayload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { padding: 'x'.repeat(1000000) } });
  const bigRes = await sf(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sid || '', Authorization: `Bearer ${apiKey}` },
    body: bigPayload,
  }, 10000);
  scorer.rec(PHASE, '4.X oversized payload', '!500', bigRes.status,
    bigRes.status !== 500, `${bigRes.status} — 1MB JSON-RPC`);
  await drain(bigRes);
  await sleep(200);

  // P4.X JSON-RPC ID types
  for (const id of ['string-id', null, -1, 3.14]) {
    const idRes = await mcpRequest(url, 'tools/list', {}, sid, apiKey);
    scorer.rec(PHASE, `4.X rpc-id=${JSON.stringify(id)}`, 'handled', idRes.status,
      idRes.status === 200 || idRes.body?.error, 'non-standard ID');
    await sleep(150);
  }

  console.log(`  MCP session: ${sid ? sid.slice(0, 24) + '...' : 'none'}`);
};
