#!/usr/bin/env node
// T-0670 self-test: fixture nginx conf with the six T-0591 locations ->
// 26.1 logic reports 0 unprobed; with the prefixes removed (mutation) -> 6.
const p26 = require('../src/phases/26-coverage-parity');
const p24 = require('../src/phases/24-docs-truth');
const conf = ['/x402-vs-mpp', '/x402-vs-mpp.md', '/what-is-an-mcp-gateway', '/what-is-an-mcp-gateway.md', '/faq', '/faq.md']
  .map((l) => `location = ${l} { }`).join('\n');
const count = () => p26.parseNginxLocations(conf).filter((r) => !p26.isProbed(r)).length;
let fail = 0;
const check = (name, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got} (want ${want})`); };
check('after change: unprobed', count(), 0);
const saved = p26.PROBED_PREFIXES.slice();
const keep = p26.PROBED_PREFIXES.filter((x) => !/x402-vs-mpp|what-is-an-mcp-gateway|faq/.test(x));
p26.PROBED_PREFIXES.length = 0; p26.PROBED_PREFIXES.push(...keep);
check('mutation (prefixes removed): unprobed', count(), 6);
p26.PROBED_PREFIXES.length = 0; p26.PROBED_PREFIXES.push(...saved);
check('restored: unprobed', count(), 0);
const ld = (t) => `<script type="application/ld+json">${JSON.stringify(t)}</script>`;
check('jsonld FAQPage found', p24.jsonLdTypes(ld({ '@type': 'FAQPage' }) + ld({ '@type': 'BreadcrumbList' })).has('FAQPage'), true);
check('jsonld absent', p24.jsonLdTypes('<p>x</p>').size, 0);
process.exit(fail ? 1 : 0);
