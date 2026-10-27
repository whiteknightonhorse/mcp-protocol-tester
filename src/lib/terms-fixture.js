// T-0602: never-activated fixture merchant for the P34.2 terms-gate (428) probe.
// A merchant in status `pending` answers 428 terms_not_accepted on POST /shop/quotes, is invisible on /shops
// and 404 on its storefront, so it is a permanent fixture with no date cliff. Setup is idempotent and STOPS at
// registration: it never accepts terms, never verifies a domain, never activates.
const crypto = require('crypto');
const { sf } = require('./http');

const BOGUS_SKU = 'tester-p34-nonexistent-sku';

async function jsonOf(r) {
  let text = '';
  try { text = await r.text(); } catch { /* empty */ }
  try { return { status: r.status, json: JSON.parse(text), text }; } catch { return { status: r.status, json: null, text }; }
}

async function quoteProbe(config, slug) {
  const r = await sf(`${config.apiUrl}/shop/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchant: slug, items: [{ sku: BOGUS_SKU, qty: 1 }] }),
  });
  const { status, json } = await jsonOf(r);
  return { status, body: json };
}

// Same text the server verifies (src/shop/merchant.service.ts encryptionKeyMessage).
const encryptionKeyMessage = (k) => `apibase.pro merchant encryption key\nkid: ${k.kid}\nalg: ${k.alg}\npub: ${k.pub}`;

function missing(input, detail) { return { state: 'missing', missing: input, detail }; }

// Returns { state: 'present' | 'registered' | 'missing', missing?, detail? }.
async function ensureTermsFixture(config, slug) {
  const probe = await quoteProbe(config, slug);
  if (probe.status !== 404) return { state: 'present' };
  if (!config.privateKey) return missing('PRIVATE_KEY (tester wallet identity)', 'no signing wallet configured');
  try {
    const { privateKeyToAccount } = require('viem/accounts');
    const account = privateKeyToAccount(config.privateKey);

    const nr = await jsonOf(await sf(`${config.apiUrl}/shop/auth/nonce?wallet=${account.address}&purpose=register`));
    if (nr.status !== 200 || typeof nr.json?.message !== 'string') {
      return missing('a nonce for the register purpose', `nonce route answered ${nr.status}`);
    }
    const signature = await account.signMessage({ message: nr.json.message });

    // The merchant never decrypts anything, so the key pair is throwaway; only the public half is published.
    const pub = crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    const key = { kid: 'tester-fixture-1', alg: 'sealed-box-x25519', pub };
    key.sig_by_wallet = await account.signMessage({ message: encryptionKeyMessage(key) });

    const rr = await jsonOf(await sf(`${config.apiUrl}/shop/merchants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: nr.json.message,
        signature,
        wallet: account.address,
        slug,
        name: 'Tester terms-gate fixture',
        category: 'software',
        country: 'US',
        contact_email: process.env.TERMS_TEST_CONTACT_EMAIL || 'tester-terms-pending@apibase.pro',
        site_url: 'https://apibase.pro',
        encryption_key: key,
      }),
    }));
    if (rr.status === 201 || rr.status === 200) return { state: 'registered' };
    const code = rr.json?.error_code || '(no error_code)';
    if (rr.status === 409 && code === 'slug_taken') return { state: 'present' };
    if (rr.status === 409 && code === 'wallet_registered') {
      return missing('a second wallet (the tester wallet already owns another merchant)', `registration answered 409 ${code}`);
    }
    return missing(`registration input the tester does not have (${code})`, `registration answered ${rr.status} ${code}: ${String(rr.json?.message || rr.text).slice(0, 100)}`);
  } catch (e) {
    return missing('a working registration call', String(e.message || e).slice(0, 100));
  }
}

module.exports = { ensureTermsFixture, quoteProbe, BOGUS_SKU };
