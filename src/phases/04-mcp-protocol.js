/**
 * Phase 4 — MCP Protocol
 * Tests MCP JSON-RPC: initialize handshake, tools/list, tools/call on a
 * known tool (crypto.market.trending).
 */
const { mcpRequest } = require('../lib/mcp-client');

const PHASE = 'mcp-protocol';

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
  if (sid) {
    try {
      const bad = await mcpRequest(url, 'nonexistent/method', {}, sid, apiKey);
      const isError = bad.body?.error || bad.status >= 400;
      scorer.rec(PHASE, 'mcp-invalid-method', 'error response', isError ? 'error' : 'no error',
        isError, `status=${bad.status}`);
    } catch (e) {
      scorer.rec(PHASE, 'mcp-invalid-method', 'error', 'exception', true, e.message);
    }
  }

  console.log(`  MCP session: ${sid ? sid.slice(0, 24) + '...' : 'none'}`);
};
