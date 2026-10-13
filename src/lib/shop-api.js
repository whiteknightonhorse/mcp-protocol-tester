/**
 * Shared helpers for the demo-shop money phases (P28, P29). REST only, demo
 * shop only, no payment is ever signed: every helper here either reads, creates
 * an unpaid quote, or cancels one.
 */
const { sf } = require('./http');

const SLUG = 'apibase-demo';
// Platform-owned wallets (see P03 / P19 / P02): a merchant must never be paid to one of them.
const PLATFORM_BASE = '0x50EbDa9dA5dC19c302Ca059d7B9E06e264936480';
const PLATFORM_TEMPO = '0x9E29FF84B0f3EDa9756262d2F950C435495BA8cC';

function shopBase(config) { return `${config.apiBaseUrl}/api/v1/shop`; }

async function call(config, method, path, body, headers) {
  const h = { ...(headers || {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await sf(`${shopBase(config)}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let text = '';
  try { text = await r.text(); } catch { /* keep empty */ }
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, headers: r.headers, text, json };
}

function createQuote(config, sku, extra, idemKey) {
  const headers = idemKey ? { 'X-Idempotency-Key': idemKey } : undefined;
  return call(config, 'POST', '/quotes', { merchant: SLUG, items: [{ sku, qty: 1 }], ...(extra || {}) }, headers);
}

// A QUOTED order is voided for free; used so the run leaves no open quote behind.
function cancelOrder(config, orderId) {
  return call(config, 'POST', `/orders/${orderId}/cancel`, { reason: 'mcp-protocol-tester' });
}

function decodeB64Json(s) {
  try { return JSON.parse(Buffer.from(String(s), 'base64').toString('utf8')); } catch { return null; }
}

// `WWW-Authenticate: Payment id="...", method="tempo", request="<b64 json>", ...`
function parseMppChallenge(header) {
  if (!header) return null;
  const id = /\bid="([^"]+)"/.exec(header)?.[1] || null;
  const method = /\bmethod="([^"]+)"/.exec(header)?.[1] || null;
  const req = /\brequest="([^"]+)"/.exec(header)?.[1];
  return { id, method, request: req ? decodeB64Json(req) : null };
}

// A structurally valid x402 v2 payment for the wrong amount. The server compares
// the authorization value with the quote before any facilitator call, so this is
// refused locally: nothing is verified, nothing is settled, cost stays $0.
function wrongAmountPayment(quoteId, payTo, micro) {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: {
      scheme: 'exact', network: 'eip155:8453', amount: String(micro),
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo, maxTimeoutSeconds: 30, extra: {},
    },
    payload: {
      signature: '0x00',
      authorization: {
        from: '0x0000000000000000000000000000000000000001', to: payTo, value: String(micro),
        validAfter: '0', validBefore: '9999999999',
        nonce: '0x0000000000000000000000000000000000000000000000000000000000000001',
      },
    },
  })).toString('base64');
}

module.exports = {
  SLUG, PLATFORM_BASE, PLATFORM_TEMPO, call, createQuote, cancelOrder, decodeB64Json, parseMppChallenge, wrongAmountPayment,
};
