let _x402c = null;
let _httpClient = null;
let _walletAddr = null;

function initX402(privateKey) {
  if (!privateKey) return false;
  try {
    const { createWalletClient, http, publicActions } = require('viem');
    const { privateKeyToAccount } = require('viem/accounts');
    const { base } = require('viem/chains');
    const { x402Client, x402HTTPClient } = require('@x402/core/client');
    const { registerExactEvmScheme } = require('@x402/evm/exact/client');

    const account = privateKeyToAccount(privateKey);
    const wc = createWalletClient({ account, chain: base, transport: http() }).extend(publicActions);
    const signer = {
      address: account.address,
      signTypedData: (m) => wc.signTypedData(m),
      readContract: (a) => wc.readContract(a),
      getTransactionCount: (a) => wc.getTransactionCount(a),
      estimateFeesPerGas: () => wc.estimateFeesPerGas(),
    };
    _x402c = new x402Client();
    registerExactEvmScheme(_x402c, { signer });
    _httpClient = new x402HTTPClient(_x402c);
    _walletAddr = account.address;
    return true;
  } catch (e) {
    console.log(`  x402 init failed: ${e.message}`);
    return false;
  }
}

function getX402Client() { return _x402c; }
function getX402HttpClient() { return _httpClient; }
function getWalletAddress() { return _walletAddr; }

async function makeX402Payment(body402) {
  const paymentRequired = {
    x402Version: 2,
    resource: body402.resource || { url: '', description: '' },
    accepts: body402.accepts,
  };
  const payload = await _x402c.createPaymentPayload(paymentRequired);
  return _httpClient.encodePaymentSignatureHeader(payload);
}

module.exports = { initX402, getX402Client, getX402HttpClient, getWalletAddress, makeX402Payment };
