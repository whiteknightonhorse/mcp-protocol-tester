/**
 * MCP era probe helpers (T-0529). Pure classifiers plus one raw request helper.
 * Era vocabulary: modern (revision 2026-07-28: no initialize, no session, per-request
 * _meta version), modern-other-version (server speaks a modern revision, not ours),
 * legacy (initialize + session id).
 */
const { sf, drain } = require('./http');

const MODERN = '2026-07-28';
const KEY_VERSION = 'io.modelcontextprotocol/protocolVersion';
const KEY_CAPS = 'io.modelcontextprotocol/clientCapabilities';

let _id = 900000;

function modernMeta(version = MODERN) {
  return { [KEY_VERSION]: version, [KEY_CAPS]: {} };
}

// Every JSON-RPC message in a JSON or SSE body, in order.
function parseMessages(text, contentType) {
  const out = [];
  if (String(contentType || '').includes('text/event-stream')) {
    for (const line of String(text).split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { out.push(JSON.parse(line.slice(5).trim())); } catch {}
    }
  } else {
    try { const j = JSON.parse(text); if (Array.isArray(j)) out.push(...j); else out.push(j); } catch {}
  }
  return out;
}

// Raw POST with caller-chosen headers. Returns { status, body, messages }.
async function eraRequest(url, method, params, { apiKey, headers = {}, sid } = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  if (sid) h['Mcp-Session-Id'] = sid;
  const r = await sf(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: _id++, method, params }) });
  let text = '';
  try { text = await r.text(); } catch { await drain(r); }
  const messages = parseMessages(text, r.headers?.get?.('content-type'));
  const id = _id - 1;
  const body = messages.find((m) => m && m.id === id) || messages[messages.length - 1] || {};
  return { status: r.status, body, messages };
}

function modernRequest(url, method, params, apiKey, { headerVersion = MODERN, metaVersion = MODERN } = {}) {
  return eraRequest(url, method, { ...(params || {}), _meta: modernMeta(metaVersion) }, {
    apiKey,
    headers: { 'MCP-Protocol-Version': headerVersion, 'Mcp-Method': method },
  });
}

// { era, supported } from a tools/list response to the modern request.
function classifyEra(res) {
  const body = res && res.body;
  if (res && res.status === 200 && body && body.result && body.result.resultType === 'complete') {
    return { era: 'modern', supported: [] };
  }
  if (res && res.status === 400 && body && body.error && body.error.code === -32022) {
    const s = body.error.data && body.error.data.supported;
    return { era: 'modern-other-version', supported: Array.isArray(s) ? s.filter((x) => typeof x === 'string') : [] };
  }
  return { era: 'legacy', supported: [] };
}

// mcp.json `protocolVersions` (array) or single `protocolVersion`.
function advertisedVersions(mcpJson) {
  if (!mcpJson || typeof mcpJson !== 'object') return [];
  if (Array.isArray(mcpJson.protocolVersions)) return mcpJson.protocolVersions.filter((x) => typeof x === 'string');
  return typeof mcpJson.protocolVersion === 'string' ? [mcpJson.protocolVersion] : [];
}

const advertisesModern = (mcpJson) => advertisedVersions(mcpJson).includes(MODERN);

function cachingOk(result) {
  return !!result && typeof result.ttlMs === 'number' && result.ttlMs > 0
    && (result.cacheScope === 'public' || result.cacheScope === 'private');
}

// Headless safety: no input_required result, no server-initiated elicitation on the stream.
function headlessViolations(messages) {
  const bad = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.result && m.result.resultType === 'input_required') bad.push('input_required');
    if (m.method === 'elicitation/create') bad.push('elicitation/create');
  }
  return bad;
}

module.exports = { MODERN, modernMeta, parseMessages, eraRequest, modernRequest, classifyEra, advertisedVersions, advertisesModern, cachingOk, headlessViolations };
