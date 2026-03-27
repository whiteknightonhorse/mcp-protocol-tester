/**
 * Phase 4 — MCP Protocol
 * Tests MCP JSON-RPC: initialize handshake, tools/list, tools/call on a
 * known tool (crypto.market.trending).
 */
const { mcpRequest } = require('../lib/mcp-client');

const PHASE = 'P4';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  console.log(`  MCP session: ${sid ? sid.slice(0, 24) + '...' : 'none'}`);
};
