let _mppClient = null;

function initMPP(privateKey) {
  if (!privateKey) return false;
  try {
    const { privateKeyToAccount } = require('viem/accounts');
    const { Mppx, tempo } = require('mppx/client');
    const account = privateKeyToAccount(privateKey);
    _mppClient = Mppx.create({ methods: [tempo({ account })] });
    return true;
  } catch (e) {
    console.log(`  MPP init failed: ${e.message}`);
    return false;
  }
}

function getMppClient() { return _mppClient; }

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
