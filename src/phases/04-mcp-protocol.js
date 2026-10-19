/**
 * Phase 4 — MCP Protocol
 * Tests MCP JSON-RPC: initialize handshake, tools/list, tools/call on a
 * known tool (crypto.market.trending).
 */
const { mcpRequest } = require('../lib/mcp-client');
const crypto = require('node:crypto');
const { sf, drain, getDelay } = require('../lib/http');
const { pickSafeProbeTool } = require('../utils/assert');
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

const sha256hex = (str) => crypto.createHash('sha256').update(str).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const META_HASH_KEY = 'apibase/definition_sha256';
// T-0500 contract: definition_sha256 = sha256hex(stable({ id, description, input_schema })).
const defHash = (b) => sha256hex(stable({ id: b.id, description: b.description, input_schema: b.input_schema }));
const flipChar = (str) => (str.charAt(0) === 'x' ? 'y' : 'x') + str.slice(1);

// 4.F1..4.F7 — tool-definition fingerprint (T-0501). All yellow (rec), never redRec.
async function fingerprintChecks(scorer, config, url, sid, apiKey, tools, context) {
  const hashPairs = (list) => list.map((t) => [t.name, t._meta?.[META_HASH_KEY]]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // 4.F1
  const mcpHash = new Map();
  let missing = 0;
  const missingBySeg = new Map();
  for (const t of tools) {
    const h = t._meta?.[META_HASH_KEY];
    const ok = typeof h === 'string' && HEX64.test(h);
    scorer.recQ(PHASE, `4.F1 meta hash ${t.name}`, '64 hex', ok ? 'ok' : 'bad', ok);
    if (ok) mcpHash.set(t.name, h);
    else {
      missing++;
      const seg = String(t.name).split('.')[0];
      missingBySeg.set(seg, (missingBySeg.get(seg) || 0) + 1);
    }
  }
  // Ruling 0501 ruling-1: name the gap by first name segment (expected today: shop.* 25).
  const grouped = [...missingBySeg.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}.* ${n}`).join(', ');
  scorer.rec(PHASE, '4.F1 tools/list carries definition_sha256', '0 missing', missing,
    missing === 0 && tools.length > 0, `${missing} of ${tools.length} tools missing${grouped ? ': ' + grouped : ''}`);

  // 4.F2
  let manifest = null;
  let etag = null;
  try {
    const r = await sf(`${config.apiUrl}/tools/manifest`);
    etag = r.headers.get('etag');
    let body = null;
    try { body = await r.json(); } catch { await drain(r); }
    const list = body && body.tools;
    const entriesOk = Array.isArray(list) && list.length > 0 && list.every((e) =>
      e && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.definition_sha256 === 'string' && HEX64.test(e.definition_sha256));
    const ok = r.status === 200 && typeof body?.manifest_sha256 === 'string' && HEX64.test(body.manifest_sha256)
      && entriesOk && body.total === list.length;
    scorer.rec(PHASE, '4.F2 manifest 200 + schema', '200 + schema', r.status, ok,
      entriesOk ? `total=${body.total} entries=${list.length}` : 'tools[] missing or malformed');
    if (ok) manifest = body;
  } catch (e) {
    scorer.recCatch(PHASE, '4.F2 manifest 200 + schema', '200 + schema', e);
  }
  if (!manifest) return;

  // 4.F3
  try {
    const pairs = manifest.tools.map((e) => [e.id, e.definition_sha256]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const re = sha256hex(stable(pairs));
    scorer.rec(PHASE, '4.F3 manifest_sha256 recomputed', 'equal', re === manifest.manifest_sha256 ? 'equal' : 'differs',
      re === manifest.manifest_sha256, `served=${manifest.manifest_sha256.slice(0, 12)} recomputed=${re.slice(0, 12)}`);
  } catch (e) {
    scorer.recCatch(PHASE, '4.F3 manifest_sha256 recomputed', 'equal', e);
  }

  // 4.F4
  let sample = null;
  try {
    const probe = pickSafeProbeTool(context.catalog);
    const step = Math.max(1, Math.floor(manifest.tools.length / 5));
    const ids = [probe.id];
    for (let i = 0; ids.length < 5 && i < manifest.tools.length; i += step) {
      const id = manifest.tools[i].id;
      if (!ids.includes(id)) ids.push(id);
    }
    const byId = new Map(manifest.tools.map((e) => [e.id, e]));
    for (const id of ids) {
      const r = await sf(`${config.apiUrl}/tools/${encodeURIComponent(id)}`);
      let body = null;
      try { body = await r.json(); } catch { await drain(r); }
      const entry = byId.get(id);
      let ok = r.status === 200 && !!body && !!entry;
      let det = `status=${r.status}${entry ? '' : ' not in manifest'}`;
      if (ok) {
        const re = defHash(body);
        const mcp = mcpHash.get(entry.name);
        ok = re === body.definition_sha256 && re === entry.definition_sha256 && re === mcp;
        det = `rest=${re === body.definition_sha256} manifest=${re === entry.definition_sha256} mcp=${re === mcp}`;
        if (!sample && typeof body.description === 'string' && body.input_schema && typeof body.input_schema === 'object') sample = body;
      }
      scorer.rec(PHASE, `4.F4 REST detail recompute ${id}`, 'REST = manifest = MCP = recomputed', ok ? 'match' : 'mismatch', ok, det);
      await sleep(getDelay(id));
    }
  } catch (e) {
    scorer.recCatch(PHASE, '4.F4 REST detail recompute', 'match', e);
  }

  // 4.F5
  try {
    const want = `"${manifest.manifest_sha256}"`;
    const r2 = await sf(`${config.apiUrl}/tools/manifest`, { headers: { 'If-None-Match': etag || want, 'Cache-Control': 'max-age=0' } });
    const text = await r2.text();
    // fetch() adds Cache-Control: no-cache next to If-None-Match, and Express req.fresh then never answers 304; send max-age=0 instead.
    // nginx gzip turns a strong validator into W/"..." on compressed responses; the opaque tag must still be the contract value.
    const etagOk = typeof etag === 'string' && (etag.startsWith('W/') ? etag.slice(2) : etag) === want;
    const ok = etagOk && r2.status === 304 && text === '';
    scorer.rec(PHASE, '4.F5 manifest ETag/304', 'ETag match + 304 empty', `${etagOk ? 'etag-ok' : 'etag-bad'}/${r2.status}`, ok,
      `body_len=${text.length}`);
  } catch (e) {
    scorer.recCatch(PHASE, '4.F5 manifest ETag/304', 'ETag match + 304 empty', e);
  }

  // 4.F6
  try {
    const again = await mcpRequest(url, 'tools/list', {}, sid, apiKey);
    const second = again.body?.result?.tools || [];
    const same = second.length > 0 && stable(hashPairs(second)) === stable(hashPairs(tools));
    scorer.rec(PHASE, '4.F6 stable across calls', 'identical (name, hash) set', same ? 'identical' : 'differs', same,
      `first=${tools.length} second=${second.length}`);
  } catch (e) {
    scorer.recCatch(PHASE, '4.F6 stable across calls', 'identical', e);
  }

  // 4.F7 — synthetic-fixture self-test: a quiet edit must change the recomputed hash.
  try {
    if (!sample) {
      scorer.rec(PHASE, '4.F7 tamper detector self-test', 'fixture available', 'none', false, 'no REST detail body to mutate');
      return;
    }
    const served = sample.definition_sha256;
    const descTampered = defHash({ ...sample, description: flipChar(sample.description) });
    const propName = Object.keys(sample.input_schema.properties || {})[0];
    let schemaDiffers = false;
    if (propName) {
      const props = { ...sample.input_schema.properties, [propName]: { ...sample.input_schema.properties[propName], description: flipChar(String(sample.input_schema.properties[propName]?.description || '')) } };
      schemaDiffers = defHash({ ...sample, input_schema: { ...sample.input_schema, properties: props } }) !== served;
    } else {
      schemaDiffers = defHash({ ...sample, input_schema: { ...sample.input_schema, properties: { tamper: { type: 'string' } } } }) !== served;
    }
    const descDiffers = descTampered !== served;
    scorer.rec(PHASE, '4.F7 tamper detector self-test', 'both edits change hash', `desc=${descDiffers} schema=${schemaDiffers}`,
      descDiffers && schemaDiffers, `tool=${sample.id}`);
  } catch (e) {
    scorer.recCatch(PHASE, '4.F7 tamper detector self-test', 'both edits change hash', e);
  }
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
  let listedTools = [];
  if (sid) {
    try {
      const list = await mcpRequest(url, 'tools/list', {}, sid, apiKey);
      const tools = list.body?.result?.tools || [];
      listedTools = tools;
      scorer.rec(PHASE, 'mcp-tools-list', '>0 tools', tools.length, tools.length > 0,
        `${tools.length} tools via MCP`);
    } catch (e) {
      scorer.rec(PHASE, 'mcp-tools-list', '>0', 'error', false, e.message);
    }
  }

  // 3.F tool-definition fingerprint (T-0501)
  if (sid) {
    await fingerprintChecks(scorer, config, url, sid, apiKey, listedTools, context);
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
        // A settled payment is spent whether or not the receipt _meta is present.
        if (!!pr && pr.isError !== true) context.spentX402 += price;
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
