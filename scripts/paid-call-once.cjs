// One real x402 paid REST call (dispatcher, GenLayer live receipt). Key only from env PAYER_KEY; never printed.
const { initX402, makeX402Payment } = require("../src/lib/x402-client.js");
const BASE = "https://apibase.pro", TOOL = process.argv[2] || "polymarket.prices";
const REQ = Number(process.env.MAX_MICRO);
const MAX = Math.min(REQ > 0 ? REQ : 10000, 500000); // MAX_MICRO: default 10000, ceiling 500000
const BODY =JSON.stringify(JSON.parse(process.argv[3] || "{}"));
(async () => {
  if (!process.env.PAYER_KEY || !initX402(process.env.PAYER_KEY)) throw new Error("no payer key");
  const url = `${BASE}/api/v1/tools/${TOOL}/call`;
  const h = { "content-type": "application/json", accept: "application/json" };
  const r1 = await fetch(url, { method: "POST", headers: h, body: BODY });
  const c = await r1.json().catch(() => ({}));
  if (r1.status !== 402 || !Array.isArray(c.accepts)) throw new Error(`expected 402, got ${r1.status}`);
  const base = c.accepts.find(a => a.network === "eip155:8453");
  if (!base || Number(base.amount) > MAX) throw new Error(`refused: amount ${base && base.amount} > ${MAX} micro-USDC`);
  let hdr = await makeX402Payment({ ...c, accepts: [base] });
  if (hdr && typeof hdr === "object") hdr = hdr["PAYMENT-SIGNATURE"] || Object.values(hdr)[0];
  const r2 = await fetch(url, { method: "POST", headers: { ...h, "X-PAYMENT": hdr }, body: BODY });
  const out = {};
  for (const [k, v] of r2.headers) if (/receipt|payment-response|x-request-id/i.test(k)) out[k] = v.slice(0, 200);
  const b = await r2.text();
  console.log(JSON.stringify({ status: r2.status, amount_micro: base.amount, payTo: base.payTo, headers: out, body_head: b.slice(0, 300) }, null, 1));
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
