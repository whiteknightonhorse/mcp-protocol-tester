/**
 * Phase 32 — Merchant webhook signature scheme against a tester-local receiver (T-0349).
 *
 * The receiver is an HTTP server on 127.0.0.1 inside this process (no secret,
 * no outbound call, cost $0). It implements what docs/integrator.md tells a
 * merchant to do; the tester signs exactly like APIbase does:
 *   - header  X-APIbase-Signature: t=<unix>,v1=<hex>
 *     src/shop/webhook/webhook.service.ts:37-40  signPayload(): v1 = HMAC-SHA256(secret, `${t}.${body}`)
 *   - headers X-APIbase-Event / X-APIbase-Delivery-Id (the event id, same on every retry)
 *     src/shop/webhook/delivery.service.ts:131-134
 *   - body    {id, event, created_at, data}   src/shop/webhook/delivery.service.ts:49-60
 *   - skew    "reject old t (e.g. older than 5 minutes)"   /integrator/docs#webhooks
 * A live delivery from APIbase needs a paid order, so it is not exercised here.
 */
const http = require('http');
const crypto = require('crypto');

const PHASE = 'P32';
const SKEW_S = 300;

// Same formula as signPayload() in webhook.service.ts:38.
function sign(secret, t, body) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

function startReceiver(secret) {
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const reply = (code, msg) => { res.statusCode = code; res.end(JSON.stringify({ result: msg })); };
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(req.headers['x-apibase-signature'] || ''));
      if (!m) return reply(401, 'malformed signature');
      const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${raw}`).digest();
      const got = Buffer.from(m[2], 'hex');
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return reply(401, 'bad signature');
      if (Math.abs(Math.floor(Date.now() / 1000) - Number(m[1])) > SKEW_S) return reply(401, 'stale timestamp');
      const id = String(req.headers['x-apibase-delivery-id'] || '');
      if (!id) return reply(400, 'no delivery id');
      if (seen.has(id)) return reply(200, 'duplicate ignored');
      seen.add(id);
      return reply(200, 'accepted');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function deliver(port, { secret, t, body, deliveryId }) {
  const r = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'APIbase-Webhooks/1',
      'X-APIbase-Event': 'order.paid',
      'X-APIbase-Delivery-Id': deliveryId,
      'X-APIbase-Signature': sign(secret, t, body),
    },
    body,
  });
  let j = null;
  try { j = await r.json(); } catch { /* keep null */ }
  return { status: r.status, result: j?.result };
}

module.exports = async function phase32(scorer) {
  console.log('\n--- Phase 32: Webhook signature (local receiver, $0) ---');
  const secret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
  const { server, port } = await startReceiver(secret);
  const now = () => Math.floor(Date.now() / 1000);
  const mkBody = (id) => JSON.stringify({
    id, event: 'order.paid', created_at: new Date().toISOString(), data: { order_id: crypto.randomUUID() },
  });
  try {
    const id1 = crypto.randomUUID();
    const body1 = mkBody(id1);

    const ok = await deliver(port, { secret, t: now(), body: body1, deliveryId: id1 });
    scorer.rec(PHASE, '32.1 valid HMAC accepted', '200 accepted', `${ok.status} ${ok.result}`, ok.status === 200 && ok.result === 'accepted');

    const id2 = crypto.randomUUID();
    const wrong = await deliver(port, { secret: `whsec_${crypto.randomBytes(16).toString('hex')}`, t: now(), body: mkBody(id2), deliveryId: id2 });
    scorer.rec(PHASE, '32.2 wrong secret rejected', '401', `${wrong.status} ${wrong.result}`, wrong.status === 401);

    // Body changed after signing: the signature covers the raw body bytes.
    const id3 = crypto.randomUUID();
    const signedBody = mkBody(id3);
    const t3 = now();
    const tamper = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-APIbase-Delivery-Id': id3, 'X-APIbase-Signature': sign(secret, t3, signedBody) },
      body: signedBody.replace('order.paid', 'order.cancelled'),
    });
    await tamper.text();
    scorer.rec(PHASE, '32.2 tampered body rejected', '401', String(tamper.status), tamper.status === 401);

    // Same delivery id, valid signature again (a retry or replay): processed once.
    const replay = await deliver(port, { secret, t: now(), body: body1, deliveryId: id1 });
    scorer.rec(PHASE, '32.3 replayed delivery id ignored', '200 duplicate ignored', `${replay.status} ${replay.result}`,
      replay.status === 200 && replay.result === 'duplicate ignored');

    const id4 = crypto.randomUUID();
    const old = await deliver(port, { secret, t: now() - SKEW_S - 60, body: mkBody(id4), deliveryId: id4 });
    scorer.rec(PHASE, `32.4 timestamp older than ${SKEW_S} s rejected`, '401 stale timestamp', `${old.status} ${old.result}`,
      old.status === 401 && old.result === 'stale timestamp');

    const id5 = crypto.randomUUID();
    const edge = await deliver(port, { secret, t: now() - SKEW_S + 30, body: mkBody(id5), deliveryId: id5 });
    scorer.rec(PHASE, `32.4 timestamp inside the ${SKEW_S} s skew accepted`, '200 accepted', `${edge.status} ${edge.result}`,
      edge.status === 200 && edge.result === 'accepted');
  } catch (e) {
    scorer.recCatch(PHASE, '32.x local receiver', 'responses', e);
  } finally {
    server.close();
  }
};
