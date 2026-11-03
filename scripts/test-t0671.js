#!/usr/bin/env node
// T-0671 self-test: the per-audio-minute 422 classifier and the P34 source_url branch.
const pm = require('../src/lib/per-minute');
const p34 = require('../src/phases/34-legal-428');
const { KNOWN_PARAMS } = require('../src/utils/assert');
let fail = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); };
const dur = { error: 'schema_validation_failed', issues: [{ path: 'duration_seconds', message: 'Required' }, { path: 'audio_url' }] };
check('422 naming duration_seconds is accepted', pm.isDurationIssue422(422, dur), true);
check('422 without the duration_seconds issue is a failure', pm.isDurationIssue422(422, { error: 'schema_validation_failed', issues: [{ path: 'audio_url' }] }), false);
check('422 with another error is a failure', pm.isDurationIssue422(422, { error: 'other', issues: dur.issues }), false);
check('400 is not the 422 rule', pm.isDurationIssue422(400, dur), false);
check('non-object body', pm.isDurationIssue422(422, null), false);
check('formula 600 s = $0.05', pm.formulaUsd(600), 0.05);
check('formula 30 s = $0.01 minimum', pm.formulaUsd(30), 0.01);
check('formula 61 s = 2 min = $0.01', pm.formulaUsd(61), 0.01);
check('per-minute by id', pm.isPerMinute({ id: 'transcribe.submit' }), true);
check('per-minute by description', pm.isPerMinute({ id: 'x.y', description: 'priced per audio minute' }), true);
check('ordinary tool', pm.isPerMinute({ id: 'crypto.trending', description: 'trending' }), false);
check('KNOWN_PARAMS transcribe.submit', KNOWN_PARAMS['transcribe.submit'], { audio_url: 'https://example.com/audio.mp3', duration_seconds: 600 });
check('P34 source_url branch', p34.hashPathFor({ url: '/legal/terms', source_url: '/legal/terms.src.md', hash_of: 'source_bytes' }), { path: '/legal/terms.src.md', hashOf: 'source_bytes' });
check('P34 registry fallback', p34.hashPathFor({ url: '/legal/fees', registry: true }), { path: '/legal/fees.md', hashOf: '' });
check('P34 static fallback', p34.hashPathFor({ url: '/terms', registry: false }), { path: '/terms', hashOf: '' });
process.exit(fail ? 1 : 0);
