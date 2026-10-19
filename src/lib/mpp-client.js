// Two client lanes: the current mppx (default) and the pinned legacy
// 0.8.19 alias ("mppx-legacy" in package.json) that proves documented
// compatibility with old clients. Neither overrides `currencies`: the SERVER
// must pin the currency in the challenge, the client just follows it.
const _clients = { current: null, legacy: null };

function initMPP(privateKey, { legacy = false } = {}) {
  if (!privateKey) return false;
  try {
    const { privateKeyToAccount } = require('viem/accounts');
    const { Mppx, tempo } = require(legacy ? 'mppx-legacy/client' : 'mppx/client');
    const account = privateKeyToAccount(privateKey);
    _clients[legacy ? 'legacy' : 'current'] =
      Mppx.create({ polyfill: false, methods: [tempo({ account })] });
    return true;
  } catch (e) {
    console.log(`  MPP init failed (${legacy ? 'legacy' : 'current'}): ${e.message}`);
    return false;
  }
}

function getMppClient(legacy = false) { return _clients[legacy ? 'legacy' : 'current']; }

function parseMppChallenge(wwwAuth) {
  if (!wwwAuth) return null;
  const result = {};
  const regex = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = regex.exec(wwwAuth)) !== null) result[m[1]] = m[2];
  if (result.request) {
    try {
      let b = result.request;
      while (b.length % 4) b += '=';
      result.decoded = JSON.parse(Buffer.from(b, 'base64').toString());
    } catch {}
  }
  return result;
}

module.exports = { initMPP, getMppClient, parseMppChallenge };
