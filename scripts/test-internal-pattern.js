// Self-test: P0 internal-leak check matches on tool-id token boundaries.
const { isInternalToolId } = require('../src/phases/00-discovery');
const cases = [
  ['global-health-covid.latest_snapshot', false],
  ['test_tool.x', true],
  ['acme.admin.users', true],
  ['acme.debug_dump', true],
  ['internal.metrics', true],
  ['weather.attest.forecast', false],
];
let bad = 0;
for (const [id, want] of cases) {
  const got = isInternalToolId(id);
  console.log(`${got === want ? 'PASS' : 'FAIL'} ${id} -> ${got}`);
  if (got !== want) bad++;
}
process.exit(bad ? 1 : 0);
