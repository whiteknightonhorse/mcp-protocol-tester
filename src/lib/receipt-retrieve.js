// T-0678: pure helpers for the T-0554 receipt retrieve check and the T-0552 in-flight duplicate check.
// Contract: APIbase docs/payments.md "Result for 24 h (T-0554)" and "Re-pay after a failed settle".

// The exact string the payer signs (EIP-191 personal_sign); the server accepts this and the previous minute.
function retrieveMessage(receiptId, nowMs = Date.now()) {
  return `apibase-retrieve:${receiptId}:${Math.floor(nowMs / 60000)}`;
}

// Receipt JSON must carry retrieve_url pointing at /x402/retrieve/<receipt_id>.
function parseReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, why: 'receipt is not a JSON object' };
  const url = receipt.retrieve_url;
  if (typeof url !== 'string' || !url) return { ok: false, why: 'receipt has no retrieve_url' };
  const m = /\/x402\/retrieve\/([A-Za-z0-9_-]+)$/.exec(url);
  if (!m) return { ok: false, why: `retrieve_url is not /x402/retrieve/<id>: ${url.slice(0, 80)}` };
  if (typeof receipt.receipt_id === 'string' && receipt.receipt_id !== m[1]) return { ok: false, why: 'retrieve_url id differs from receipt_id' };
  const tx = typeof receipt.payment_tx === 'string' ? receipt.payment_tx.toLowerCase() : null;
  return { ok: true, url, id: m[1], payer: receipt.payer, tx, retained: receipt.result_retained_until ?? null };
}

// Judge the signed GET: 200, status delivered, charged:false, same receipt, body equals the first paid body.
function classifyRetrieve(status, body, firstBody, receiptId) {
  if (status !== 200) return { ok: false, why: `retrieve answered ${status}, want 200` };
  if (!body || typeof body !== 'object') return { ok: false, why: 'retrieve body is not JSON' };
  if (body.charged !== false) return { ok: false, why: `charged=${JSON.stringify(body.charged)}, want false` };
  if (body.status !== 'delivered') return { ok: false, why: `status=${JSON.stringify(body.status)}, want delivered` };
  if (body.receipt_id !== receiptId) return { ok: false, why: 'receipt_id differs' };
  if (JSON.stringify(body.result) !== JSON.stringify(firstBody)) return { ok: false, why: 'result differs from the paid response body' };
  return { ok: true, why: 'same body, charged:false' };
}

// T-0552: a re-pay while a failed settle can still land is 409 payment_in_flight with retry_after
// (seconds until validBefore + 60 s, minimum 5).
function classifyInFlight(status, body) {
  if (status !== 409) return { ok: false, why: `status ${status}, want 409` };
  if (!body || typeof body !== 'object' || body.error !== 'payment_in_flight') return { ok: false, why: 'error is not payment_in_flight' };
  const ra = body.retry_after;
  if (typeof ra !== 'number' || !Number.isFinite(ra) || ra < 5) return { ok: false, why: `retry_after=${JSON.stringify(ra)}, want a number >= 5` };
  return { ok: true, retryAfter: ra, why: `409 payment_in_flight retry_after=${ra}` };
}

module.exports = { retrieveMessage, parseReceipt, classifyRetrieve, classifyInFlight };
