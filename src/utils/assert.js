const SKIP_IDS = new Set([
  'polymarket.place_order', 'polymarket.cancel_order',
  'aipush.setup_website', 'aipush.generate_page',
  'amadeus.flight_price', 'namesilo.domain_register',
]);

function shouldSkip(toolId) {
  return SKIP_IDS.has(toolId);
}

function buildBody(tool) {
  const schema = tool?.input_schema;
  if (!schema || !schema.properties) return {};
  const body = {};
  const props = schema.properties;
  const req = schema.required || [];
  for (const [key, def] of Object.entries(props)) {
    if (!req.includes(key) && Object.keys(props).length > 4) continue;
    const t = def.type;
    const d = (def.description || '').toLowerCase();
    const k = key.toLowerCase();
    if (def.enum?.length) { body[key] = def.enum[0]; }
    else if (t === 'string') {
      if (d.includes('url')) body[key] = 'https://example.com';
      else if (d.includes('email')) body[key] = 'test@example.com';
      else if (d.includes('ip') && !d.includes('desc')) body[key] = '8.8.8.8';
      else if (d.includes('date')) body[key] = '2026-03-01';
      else if (k === 'ticker' || k === 'symbol') body[key] = 'AAPL';
      else if (k === 'country' || k === 'country_code') body[key] = 'US';
      else if (k === 'language' || k === 'lang') body[key] = 'en';
      else if (k === 'currency') body[key] = 'USD';
      else if (k === 'chain' || k === 'network') body[key] = 'ethereum';
      else if (k === 'interval') body[key] = '1d';
      else body[key] = 'test';
    } else if (t === 'number' || t === 'integer') {
      if (k.includes('limit') || k.includes('count')) body[key] = 5;
      else if (k.includes('page')) body[key] = 1;
      else if (k === 'id' || k.endsWith('_id')) body[key] = 1;
      else if (d.includes('lat')) body[key] = 40.7128;
      else if (d.includes('lon')) body[key] = -74.006;
      else body[key] = 1;
    } else if (t === 'boolean') { body[key] = true; }
    else if (t === 'array') { body[key] = def.items?.type === 'number' ? [1] : ['test']; }
  }
  return body;
}

// Known params for common tools
const KNOWN_PARAMS = {
  'crypto.trending': {}, 'crypto.get_price': { coins: ['bitcoin'] },
  'earthquake.feed': {}, 'nasa.apod': {},
  'books.search': { query: 'dune' }, 'anime.search': { query: 'naruto' },
  'finance.exchange_rates': { base: 'USD', target: 'EUR' },
  'rawg.game_search': { query: 'zelda' }, 'tmdb.movie_search': { query: 'inception' },
  'geo.geocode': { text: 'Paris' }, 'ip.lookup': { ip: '8.8.8.8' },
  'music.artist_search': { query: 'Beatles' },
  'education.paper_search': { query: 'machine learning' },
  'polymarket.search': { query: 'election' },
};

function getBody(toolOrId) {
  const id = typeof toolOrId === 'string' ? toolOrId : toolOrId?.id;
  if (KNOWN_PARAMS[id]) return KNOWN_PARAMS[id];
  if (typeof toolOrId === 'object') return buildBody(toolOrId);
  return {};
}

module.exports = { shouldSkip, buildBody, getBody, KNOWN_PARAMS, SKIP_IDS };
