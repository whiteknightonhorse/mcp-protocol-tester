const { sf, drain } = require('./http');

async function mcpRequest(url, method, params, sid, apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sid) headers['Mcp-Session-Id'] = sid;
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const r = await sf(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 10000),
      method,
      params: params || {},
    }),
  });

  // Parse SSE or JSON response
  let body = {};
  const ct = r.headers?.get?.('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const text = await r.text();
    for (const line of text.split('\n').filter(l => l.startsWith('data:'))) {
      try { body = JSON.parse(line.slice(5).trim()); } catch {}
    }
  } else {
    try { body = await r.json(); } catch { await drain(r); }
  }

  const sessionId = r.headers?.get?.('mcp-session-id') || sid;
  return { status: r.status, body, sessionId, elapsed: r._elapsed };
}

module.exports = { mcpRequest };
