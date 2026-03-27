async function sf(url, opts = {}, tmo = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), tmo);
  const start = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    clearTimeout(t);
    r._elapsed = Date.now() - start;
    return r;
  } catch (e) {
    clearTimeout(t);
    return {
      status: 0, statusText: 'TMO', _elapsed: Date.now() - start, ok: false,
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

module.exports = { sf, drain, getDelay };
