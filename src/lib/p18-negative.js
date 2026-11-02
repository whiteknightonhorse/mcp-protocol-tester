// P18 negative matrix helpers (T-0653). Pure builders: no network, no signing key here.
// Every mutation below MUST be refused by the facilitator; a 200 or a transfer is RED.
const OTHER_PAYTO = '0x000000000000000000000000000000000000dEaD';
const OTHER_ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // USDC on Base Sepolia, not the challenged asset
const NAMES = {
  N1: '18.N1 payTo mismatch',
  N2: '18.N2 asset mismatch',
  N3: '18.N3 network mismatch',
  N4: '18.N4 validBefore in the past',
  N5: '18.N5 validAfter in the future',
  N6: '18.N6 signer mismatch',
  N7: '18.N7 truncated signature',
  N8: '18.N8 sign-in foreign domain',
  N9: '18.N9 sign-in nonce replay',
  N10: '18.N10 sign-in stale message',
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const flipNetwork = (n) => (n === 'eip155:8453' ? 'eip155:84532' : 'eip155:8453');
const freshNonce = (rand) => '0x' + Buffer.from(rand(32)).toString('hex');

// base: a valid x402 payload from the SDK ({x402Version, accepted, payload:{authorization, signature}}).
// resign(accepted, authorization) -> Promise<signature> signs the EIP-3009 authorization with signer 1.
// Returns {N1..N7: payload}; each payload differs from the (re-signed, fresh-nonce) valid one in the intended field.
async function buildMutations({ base, resign, secondAddress, now = Date.now(), rand = (n) => require('crypto').randomBytes(n) }) {
  // signFirst: the signature covers the UNMUTATED authorization (signer / signature mutations).
  const mk = async (mutate, { signFirst = false } = {}) => {
    const p = clone(base);
    p.payload.authorization.nonce = freshNonce(rand);
    if (signFirst) p.payload.signature = await resign(p.accepted, p.payload.authorization);
    mutate(p);
    if (!signFirst) p.payload.signature = await resign(p.accepted, p.payload.authorization);
    return p;
  };
  const nowS = Math.floor(now / 1000);
  const valid = await mk(() => {});
  const out = { valid };
  out.N1 = await mk((p) => { p.accepted.payTo = OTHER_PAYTO; p.payload.authorization.to = OTHER_PAYTO; });
  out.N2 = await mk((p) => { p.accepted.asset = OTHER_ASSET; });
  out.N3 = await mk((p) => { p.accepted.network = flipNetwork(p.accepted.network); });
  out.N4 = await mk((p) => { p.payload.authorization.validBefore = String(nowS - 60); });
  out.N5 = await mk((p) => { p.payload.authorization.validAfter = String(nowS + 3600); });
  out.N6 = await mk((p) => { p.payload.authorization.from = secondAddress; }, { signFirst: true });
  out.N7 = await mk((p) => { p.payload.signature = p.payload.signature.slice(0, -4); }, { signFirst: true }); // 2 bytes
  return out;
}

const WALLET_SIGNIN = (domain, address, nonce, issuedAt, purpose = 'reissue') =>
  `${domain} wants you to sign in with your wallet.\nAddress: ${address}\nPurpose: ${purpose}\nNonce: ${nonce}\nIssued At: ${issuedAt}`;

module.exports = { OTHER_PAYTO, OTHER_ASSET, NAMES, buildMutations, flipNetwork, WALLET_SIGNIN };
