/**
 * Annotation rules (T-0858, TOOL-ANNOTATIONS-1116 ruling-1).
 * Pure, no network, target-agnostic: compares the safety hints a tool declares
 * with what its name, description and input schema say it does.
 */
const MONEY = new Set(['pay', 'refund', 'transfer', 'withdraw', 'payout', 'charge', 'purchase', 'buy']);
const DELETE = new Set(['delete', 'remove', 'purge', 'revoke', 'cancel', 'deactivate', 'destroy', 'drop']);
const SEND = new Set(['send', 'sms', 'email', 'notify', 'publish', 'post', 'command']);
const WRITE = new Set(['create', 'update', 'set', 'upsert', 'register', 'submit', 'write', 'upload', 'add', 'place']);
// A name whose LAST token is a read verb treats `email` and `sms` as nouns (email.validation.check).
const READ_LAST = new Set(['get', 'list', 'search', 'check', 'status', 'estimate', 'validate', 'verify', 'lookup', 'find', 'read', 'query', 'info', 'count']);
const NOUN_WHEN_READ_LAST = new Set(['email', 'sms']);
const CLASSES = [['MONEY', MONEY], ['DELETE', DELETE], ['SEND', SEND], ['WRITE', WRITE]];
const SCHEMA_PROPS = ['amount', 'to', 'recipient', 'tx_hash', 'body', 'message'];
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

function tokens(name) {
  if (typeof name !== 'string') return [];
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[.\-_\s]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

// Name tokens that may act as verbs: `email`/`sms` are skipped when the name ends in a READ_LAST
// token; `place` counts only when another token follows it inside the same dot-segment.
function verbTokens(name) {
  if (typeof name !== 'string') return [];
  const all = tokens(name);
  const readLast = READ_LAST.has(all[all.length - 1]);
  const out = [];
  for (const seg of name.split('.')) {
    const st = tokens(seg);
    st.forEach((tok, i) => {
      if (readLast && NOUN_WHEN_READ_LAST.has(tok)) return;
      if (tok === 'place' && i === st.length - 1) return;
      out.push(tok);
    });
  }
  return out;
}

function classOf(word) {
  for (const [cls, set] of CLASSES) if (set.has(word)) return cls;
  return null;
}

function words(text) {
  return typeof text === 'string' ? text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) : [];
}

function firstSentence(text) {
  if (typeof text !== 'string') return '';
  const m = text.trim().match(/^[^.!?\n]*/);
  return m ? m[0] : '';
}

// Sentences split on a newline, or on . ! ? followed by whitespace.
function sentences(text) {
  return typeof text === 'string' ? text.split(/\n|(?<=[.!?])\s+/) : [];
}

function classify(tool) {
  const t = tool && typeof tool === 'object' ? tool : {};
  // name: the LAST matching token wins ("cancel_order" -> DELETE)
  let cls = null;
  for (const tok of verbTokens(t.name)) {
    const c = classOf(tok);
    if (c) cls = c;
  }
  if (cls) return { cls, source: 'name' };

  // schema: a telling property together with a class verb opening a sentence of the description
  const props = t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.properties && typeof t.inputSchema.properties === 'object'
    ? Object.keys(t.inputSchema.properties) : [];
  if (props.some((p) => SCHEMA_PROPS.includes(p.toLowerCase()))) {
    let found = null;
    for (const sent of sentences(t.description)) {
      const w = words(sent)[0];
      const c = w ? classOf(w) : null;
      if (c) { found = c; break; }
    }
    if (found) return { cls: found, source: 'schema' };
  }

  // description: the first sentence starts with a class verb
  const first = words(firstSentence(t.description))[0];
  const c = first ? classOf(first) : null;
  if (c) return { cls: c, source: 'description' };
  return { cls: null, source: null };
}

function judge(tool) {
  const t = tool && typeof tool === 'object' ? tool : {};
  const findings = [];
  const a = t.annotations;
  const hasAnn = a && typeof a === 'object' && !Array.isArray(a);

  if (!hasAnn || a.readOnlyHint === undefined) {
    findings.push({ level: 'yellow', code: 'missing-hints', detail: hasAnn ? 'readOnlyHint absent' : 'no annotations object' });
  }
  if (!hasAnn) return findings;

  for (const h of HINTS) {
    if (a[h] !== undefined && typeof a[h] !== 'boolean') {
      findings.push({ level: 'yellow', code: 'bad-type', detail: `${h} is not a boolean` });
    }
  }

  const { cls, source } = classify(t);
  if (!cls) return findings;

  const ro = a.readOnlyHint === true;
  const additive = a.readOnlyHint !== true && a.destructiveHint === false;
  const irreversible = cls === 'MONEY' || cls === 'DELETE';

  if (irreversible && (ro || additive)) {
    const code = ro ? 'write-as-readonly' : 'irreversible-as-additive';
    if (source === 'name') findings.push({ level: 'red', code, detail: `${cls} verb in the name, ${ro ? 'readOnlyHint true' : 'destructiveHint false'}` });
    else findings.push({ level: 'yellow', code: 'inferred', detail: `${code} inferred from ${source} (${cls})` });
  }
  if ((cls === 'SEND' && a.destructiveHint === false) || ((cls === 'SEND' || cls === 'WRITE') && ro)) {
    findings.push({ level: 'yellow', code: 'send-as-additive', detail: `${cls} tool declares ${ro ? 'readOnlyHint true' : 'destructiveHint false'}` });
  }
  return findings;
}

module.exports = { tokens, classify, judge, MONEY, DELETE, SEND, WRITE, READ_LAST };
