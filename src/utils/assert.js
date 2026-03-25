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
      if (d.includes('url') || d.includes('uri')) body[key] = 'https://example.com';
      else if (d.includes('email')) body[key] = 'test@example.com';
      else if (d.includes('domain')) body[key] = 'example.com';
      else if (d.includes('isbn')) body[key] = '9780140328721';
      else if (d.includes('upc') || d.includes('barcode')) body[key] = '4006381333931';
      else if (d.includes('iban')) body[key] = 'DE89370400440532013000';
      else if (d.includes('ip') && !d.includes('desc')) body[key] = '8.8.8.8';
      else if (d.includes('phone') || k.includes('phone')) body[key] = '+12025551234';
      else if (d.includes('zip') || k.includes('zip') || k.includes('postal')) body[key] = '10001';
      else if (d.includes('0x') || (d.includes('address') && d.includes('wallet'))) body[key] = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
      else if (k === 'token_address' || k === 'contract_address') body[key] = '0xdac17f958d2ee523a2206206994597c13d831ec7';
      else if (d.includes('coin') && !d.includes('currency')) body[key] = 'bitcoin';
      else if (d.includes('date')) body[key] = '2026-03-01';
      else if (d.includes('doi')) body[key] = '10.1038/nature12373';
      else if (d.includes('mbid')) body[key] = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
      else if (d.includes('lat')) body[key] = '40.7128';
      else if (d.includes('lon')) body[key] = '-74.0060';
      else if (k === 'ticker' || k === 'symbol' || k === 'stock') body[key] = 'AAPL';
      else if (k === 'country' || k === 'country_code') body[key] = 'US';
      else if (k === 'language' || k === 'lang') body[key] = 'en';
      else if (k === 'currency') body[key] = 'USD';
      else if (k === 'sort' || k === 'order') body[key] = 'desc';
      else if (k === 'format') body[key] = 'json';
      else if (k === 'chain' || k === 'network') body[key] = 'ethereum';
      else if (k === 'interval') body[key] = '1d';
      else if (['query', 'q', 'keyword', 'term', 'search', 'text', 'name'].includes(k)) body[key] = 'test';
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

// Known params for common tools (70+ overrides)
const HL = '0x50EbDa9dA5dC19c302Ca059d7B9E06e264936480';
const KNOWN_PARAMS = {
  // Crypto
  'crypto.trending': {}, 'crypto.global': {}, 'crypto.get_price': { coins: ['bitcoin'] },
  'crypto.coin_detail': { coin_id: 'ethereum' }, 'crypto.search': { query: 'solana' },
  'crypto.price_history': { coin_id: 'bitcoin', days: 7 },
  'crypto.token_by_address': { contract_address: '0xdac17f958d2ee523a2206206994597c13d831ec7', network: 'ethereum' },
  'polymarket.search': { query: 'election' },
  'hyperliquid.order_book': { coin: 'BTC' }, 'aster.order_book': { symbol: 'BTCUSDT' },
  // Travel
  'aviasales.search_flights': { origin: 'MOW', destination: 'LED' },
  'aviasales.airport_lookup': { query: 'Sheremetyevo' },
  'amadeus.airport_search': { keyword: 'Tokyo' }, 'amadeus.airline_lookup': { airline_code: 'BA' },
  'amadeus.flight_search': { origin: 'JFK', destination: 'LAX', departure_date: '2026-06-15' },
  'sabre.search_flights': { origin: 'JFK', destination: 'LAX', departure_date: '2026-06-15' },
  // Events
  'ticketmaster.events_search': { keyword: 'concert' },
  // Health / Food
  'health.food_details': { fdc_id: 171688 }, 'health.drug_events': { search: 'aspirin', limit: 3 },
  'spoonacular.recipe_details': { id: 716429 },
  // Finance
  'finance.exchange_rates': { base: 'USD', target: 'EUR' }, 'finance.ecb_rates': { base: 'EUR' },
  'finance.economic_indicator': { series_id: 'GDP' },
  'finance.validate_iban': { iban: 'DE89370400440532013000' },
  // Music / Education
  'music.artist_search': { query: 'Beatles' },
  'music.artist_details': { mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711' },
  'education.paper_search': { query: 'machine learning' },
  'education.doi_lookup': { doi: '10.1038/s41586-020-2649-2' },
  // Geo
  'geo.geocode': { text: 'Paris' }, 'geo.reverse_geocode': { lat: 48.8584, lon: 2.2945 },
  'geo.ip_geolocation': { ip: '8.8.8.8' },
  // Media
  'diffbot.article_extract': { url: 'https://techcrunch.com' },
  'qrserver.generate': { data: 'https://example.com' },
  'ip.lookup': { ip: '8.8.8.8' }, 'ip.bulk_lookup': { ips: ['8.8.8.8', '1.1.1.1'] },
  // Science
  'earthquake.feed': {}, 'earthquake.search': { starttime: '2026-03-17', endtime: '2026-03-18', minmagnitude: 5 },
  'nasa.apod': {}, 'nasa.neo_feed': { start_date: '2026-03-17', end_date: '2026-03-18' },
  'jpl.close_approaches': {}, 'jpl.fireballs': { date_min: '2026-01-01', limit: 5 },
  // Entertainment
  'anime.search': { query: 'naruto' }, 'anime.details': { id: 20 }, 'manga.details': { id: 2 },
  'books.search': { query: 'dune' }, 'books.isbn_lookup': { isbn: '9780140449136' },
  'rawg.game_search': { query: 'zelda' }, 'rawg.game_details': { id: 22511 },
  'igdb.game_details': { id: 1942 },
  'tmdb.movie_search': { query: 'inception' }, 'tmdb.movie_details': { id: 27205 },
  // Jobs
  'jobs.job_search': { keywords: 'python developer', location: 'Berlin' },
};

function getBody(toolOrId) {
  const id = typeof toolOrId === 'string' ? toolOrId : toolOrId?.id;
  if (KNOWN_PARAMS[id]) return KNOWN_PARAMS[id];
  if (typeof toolOrId === 'object') return buildBody(toolOrId);
  return {};
}

module.exports = { shouldSkip, buildBody, getBody, KNOWN_PARAMS, SKIP_IDS };
