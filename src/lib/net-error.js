// Central classification of "the request never really reached/answered the
// server" (dead server, timeout, connection reset) vs "the server actively
// rejected malformed input at the transport level" (e.g. Node itself throwing
// on an invalid header value before any socket opens).
//
// Fable's audit (2026-09-02) found that every phase which wraps a fetch in
// try/catch and treats ANY exception as "server correctly rejected this" was
// scoring a dead/timed-out server as a PASS. This is the one place that
// decides the difference — every call site that used to hardcode `true` in
// its catch block should route through here instead (see scoring.js's
// `recCatch`), so a future new catch block gets this for free too.
function isDeadServerError(e) {
  if (!e) return false;
  const name = e.name || '';
  const code = e.code || (e.cause && e.cause.code) || '';
  const msg = String(e.message || '');
  return (
    name === 'AbortError' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    /timeout/i.test(msg) ||
    /fetch failed/i.test(msg) ||
    /network/i.test(msg) ||
    /socket hang up/i.test(msg)
  );
}

module.exports = { isDeadServerError };
