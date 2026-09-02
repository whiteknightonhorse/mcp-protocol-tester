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

function getDelay(toolId) {
  const p = toolId.split('.')[0];
  const delays = {
    music: 1500, anime: 1000, manga: 1000, upc: 10000, diffbot: 500,
    spoonacular: 800, ticketmaster: 600, igdb: 600,
    hyperliquid: 500, aster: 500, sabre: 600, amadeus: 500, health: 400, education: 400,
  };
  return delays[p] || 350;
}

module.exports = { sf, drain, getDelay, setTesterId, withTesterHeader };
