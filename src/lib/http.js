// Э6: every outbound request carries X-APIbase-Tester so prod observability
// (rate limiters, moderation, bans, dashboards) can segment tester traffic —
// deliberately NOT a bypass allow-list. Set once per run via setTesterId();
// sf() is the single chokepoint nearly every phase/lib routes through, so
// this one addition covers the whole run instead of touching every call site.
let TESTER_ID = null;
function setTesterId(id) { TESTER_ID = id; }

function withTesterHeader(headers) {
  const h = { ...(headers || {}) };
  if (!TESTER_ID) return h;
  const already = Object.keys(h).some((k) => k.toLowerCase() === 'x-apibase-tester');
  if (!already) h['X-APIbase-Tester'] = TESTER_ID;
  return h;
}

async function sf(url, opts = {}, tmo = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), tmo);
  const start = Date.now();
  try {
    const r = await fetch(url, { ...opts, headers: withTesterHeader(opts.headers), signal: c.signal });
    clearTimeout(t);
    r._elapsed = Date.now() - start;
    return r;
  } catch (e) {
    clearTimeout(t);
    return {
      status: -1, statusText: 'TMO', _elapsed: Date.now() - start, ok: false,
      _timeout: true,
      text: async () => e.message, json: async () => ({}),
      headers: new Headers(),
    };
  }
}

async function drain(r) { try { await r.text(); } catch {} }

// Fable's audit (2026-09-02, follow-up): 4 hostile-framing probes (CRLF in
// a header value, Transfer-Encoding: chunked, Upgrade: websocket,
// ambiguous Content-Length+chunked) TIMEOUT under undici (fetch) even
// though the real server answers in ~1s — proven by a differencing
// control: the identical request via curl gets a fast, correct status.
// This is a known undici behavior on manually-set hop-by-hop framing
// headers, not a server hang — the client artifact is ours to own, not
// apibase's. curlRequest() is the transport for exactly these probes; sf()
// (undici) stays the transport for everything else.
const { execFile } = require('child_process');

function curlRequest(url, opts = {}, tmo = 25000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = ['-sS', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', String(Math.max(1, Math.ceil(tmo / 1000))),
      '-X', opts.method || 'GET'];
    for (const [k, v] of Object.entries(opts.headers || {})) args.push('-H', `${k}: ${v}`);
    if (opts.body !== undefined) args.push('--data-raw', opts.body);
    args.push(url);

    execFile('curl', args, { timeout: tmo + 3000 }, (err, stdout) => {
      const elapsed = Date.now() - start;
      const status = parseInt(stdout, 10);
      if (err || !status) {
        resolve({
          status: -1, statusText: 'TMO', _elapsed: elapsed, ok: false, _timeout: true,
          text: async () => (err && err.message) || 'curl produced no status code',
          json: async () => ({}), headers: new Headers(),
        });
        return;
      }
      resolve({
        status, statusText: '', _elapsed: elapsed, ok: status >= 200 && status < 300,
        text: async () => '', json: async () => ({}), headers: new Headers(),
      });
    });
  });
}

// Runs the SAME request via both transports and records the comparison as
// an assertion — the differencing control lives in the test, not just in a
// comment. Returns curl's result (the reliable one) for the caller's own
// real assertion. `undiciTmo` is deliberately short (undici's own timeout
// on these framings is never actually reached in <5s of real work — it is
// the client hanging, not a slow server, so a short probe timeout is
// enough to observe the artifact without paying sf()'s full 25s default).
async function diffTransportProbe(scorer, phase, name, url, opts, undiciTmo = 5000) {
  const [curlResult, undiciResult] = await Promise.all([
    curlRequest(url, opts),
    sf(url, opts, undiciTmo),
  ]);
  await drain(undiciResult);

  const curlOk = curlResult.status > 0;
  const undiciTimedOut = undiciResult._timeout === true;
  if (curlOk && undiciTimedOut) {
    scorer.rec(phase, `${name} transport check (undici vs curl)`, 'client artifact confirmed',
      `curl=${curlResult.status} in ${curlResult._elapsed}ms, undici=TIMEOUT`, true,
      'undici hangs on this framing, curl does not — server is fine, this is a known tester-client artifact');
  } else if (curlOk && !undiciTimedOut) {
    scorer.rec(phase, `${name} transport check (undici vs curl)`, 'agree', `curl=${curlResult.status} undici=${undiciResult.status}`,
      curlResult.status === undiciResult.status, 'both transports agree — no client artifact today');
  } else {
    // curl itself failed/timed out too — this is no longer a client-only
    // artifact question; a real prod problem may be present.
    scorer.redRec(phase, `${name} transport check (undici vs curl)`, 'curl reachable',
      curlResult.status === -1 ? 'curl also TIMEOUT' : `curl=${curlResult.status}`, false,
      'curl (the reliable transport) also failed — this may be a real server issue, not just an undici artifact');
  }

  return curlResult;
}

function getDelay(toolId) {
  const p = toolId.split('.')[0];
  const delays = {
    music: 1500, anime: 1000, manga: 1000, upc: 10000, diffbot: 500,
    spoonacular: 800, ticketmaster: 600, igdb: 600,
    hyperliquid: 500, aster: 500, sabre: 600, amadeus: 500, health: 400, education: 400,
  };
  return delays[p] || 350;
}

module.exports = { sf, drain, getDelay, setTesterId, withTesterHeader, curlRequest, diffTransportProbe };
