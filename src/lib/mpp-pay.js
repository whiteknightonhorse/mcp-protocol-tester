// Manual MPP charge helpers: 402 probe -> createCredential -> send, so the
// settled credential stays available for replay and transport tests. The
// mppx `fetch()` wrapper hides the credential, which is why P5 does not use
// it for those assertions.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sf } = require('./http');
const { parseMppChallenge } = require('./mpp-client');

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function decodeReceipt(headerValue) {
  if (!headerValue) return null;
  try {
    const b64 = String(headerValue).replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
}

async function readJson(r) {
  try { return JSON.parse(await r.text()); } catch { return null; }
}

// Probe the URL for a challenge and build a credential for it. Nothing is
// broadcast yet: the credential only costs money once the server settles it.
async function obtainCredential(client, url, headers, body) {
  const probe = await sf(url, { method: 'POST', headers, body });
  const wwwAuth = probe.headers?.get?.('www-authenticate') || '';
  if (probe.status !== 402 || !wwwAuth) {
    try { await probe.text(); } catch {}
    return { error: `challenge probe returned ${probe.status}`, status: probe.status };
  }
  const parsed = parseMppChallenge(wwwAuth);
  const credential = await client.createCredential(probe);
  const micro = Number(parsed?.decoded?.amount);
  return { credential, costUsd: isNaN(micro) ? 0 : micro / 1e6 };
}

async function sendWithCredential(url, headers, body, credential, headerName = 'Authorization') {
  const r = await sf(url, { method: 'POST', headers: { ...headers, [headerName]: credential }, body }, 60000);
  const json = await readJson(r);
  return { status: r.status, headers: r.headers, json };
}

// Full charge: credential -> send -> decoded receipt.
async function chargeOnce(client, url, headers, body, headerName = 'Authorization') {
  const c = await obtainCredential(client, url, headers, body);
  if (c.error) return { ok: false, error: c.error, status: c.status };
  const res = await sendWithCredential(url, headers, body, c.credential, headerName);
  const receipt = decodeReceipt(res.headers?.get?.('payment-receipt'));
  return { ok: true, ...res, credential: c.credential, costUsd: c.costUsd, receipt };
}

// `mppx validate` as a child process (R-8: argv array, no shell, no wallet
// env, throwaway HOME so a local mppx keystore can never be picked up).
// Scoped with --endpoint so the run is one unpaid challenge check. The output
// goes to a temp FILE, not a pipe: the CLI calls process.exit after a failed
// validation and a pipe is cut at ~256 KB (the discovery report is ~3 MB).
const TOOL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function refuseValidate(errMsg) {
  return { exitCode: -1, spawnFailed: true, json: null, errMsg };
}

function runMppxValidate(baseUrl, toolId, timeoutMs = 90000) {
  let parsedUrl = null;
  try { parsedUrl = new URL(String(baseUrl)); } catch {}
  if (!parsedUrl || parsedUrl.protocol !== 'https:') return Promise.resolve(refuseValidate('refused: baseUrl must be an https: URL'));
  if (typeof toolId !== 'string' || !TOOL_ID_RE.test(toolId)) return Promise.resolve(refuseValidate('refused: toolId does not match the allowed pattern'));
  return new Promise((resolve) => {
    const bin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'mppx');
    const args = ['validate', baseUrl, '--endpoint', `POST:/api/v1/tools/${toolId}/call`, '--body', '{}', '-j'];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-validate-'));
    const outFile = path.join(home, 'out.json');
    const fd = fs.openSync(outFile, 'w');
    const done = (r) => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} resolve(r); };
    let child;
    try {
      child = spawn(bin, args, { env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', fd, 'ignore'], timeout: timeoutMs });
    } catch (e) {
      fs.closeSync(fd);
      done({ exitCode: -1, spawnFailed: true, json: null, errMsg: e.message });
      return;
    }
    child.on('error', (e) => {
      try { fs.closeSync(fd); } catch {}
      done({ exitCode: -1, spawnFailed: true, json: null, errMsg: e.message });
    });
    child.on('close', (code, signal) => {
      try { fs.closeSync(fd); } catch {}
      let json = null;
      try { json = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
      done({ exitCode: code === null ? -1 : code, spawnFailed: false, json, errMsg: signal ? `killed by ${signal}` : '' });
    });
  });
}

module.exports = { TX_HASH_RE, decodeReceipt, obtainCredential, sendWithCredential, chargeOnce, runMppxValidate };
