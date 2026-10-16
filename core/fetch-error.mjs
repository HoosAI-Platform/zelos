/**
 * core/fetch-error.mjs — why a request never got an answer, in words.
 *
 * Node's `fetch` reports every failure to connect as one TypeError whose
 * message is "fetch failed", and keeps the reason on `err.cause`: a refused
 * connection, a name that does not resolve, a certificate for another host, a
 * self-signed one. Every reader passed `err.message` along and dropped the
 * cause, so a calendar said "could not reach 127.0.0.1:5232: fetch failed" and
 * a feed said only "fetch failed" — and a certificate problem could not be told
 * from a dead server, though the two have nothing in common but the symptom
 * (QA, 2026-10-10, TT-3514). A 500, by contrast, always named its host.
 *
 * A leaf on purpose: it imports nothing, so the calendar readers and the
 * transport can all use it without pulling each other in.
 */

/* The causes a person can act on, said as what to do about them. Anything else
   keeps its own code and message, which is still better than "fetch failed". */
const REASONS = new Map([
  ['ECONNREFUSED', 'nothing is listening there (connection refused) — is the server running, and is the port right?'],
  ['ENOTFOUND', 'that name does not resolve — check the address for a typo'],
  ['EAI_AGAIN', 'the name could not be looked up just now — check this computer\'s connection'],
  ['ETIMEDOUT', 'the connection timed out'],
  ['UND_ERR_CONNECT_TIMEOUT', 'the connection timed out'],
  ['ECONNRESET', 'the connection was reset (by the server, or something between)'],
  ['EHOSTUNREACH', 'that host cannot be reached from this network'],
  ['ENETUNREACH', 'this computer has no route to that network'],
  ['CERT_HAS_EXPIRED', 'its certificate has expired'],
  ['CERT_NOT_YET_VALID', 'its certificate is not valid yet — check this computer\'s clock'],
  // https:// on a port that speaks plain http: the classic local CalDAV case.
  ['ERR_SSL_WRONG_VERSION_NUMBER', 'it does not speak https on that port — try its http:// address'],
  ['ERR_SSL_PACKET_LENGTH_TOO_LONG', 'it does not speak https on that port — try its http:// address'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'its certificate is for a different name than the one in the address'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'its certificate is self-signed, so it cannot be trusted'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'its certificate chain is self-signed, so it cannot be trusted'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'its certificate could not be verified (an incomplete chain, or an unknown authority)'],
  ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'its certificate could not be verified (an unknown authority)'],
]);

/**
 * The reason behind a failed `fetch`, as a short phrase. Walks `cause` (undici
 * can nest one), prefers a known code's words, then the deepest cause's own
 * message, and falls back to the error's own message only when there is no
 * cause at all.
 */
export function fetchFailureReason(err) {
  let cause = err?.cause;
  for (let depth = 0; cause?.cause && depth < 3; depth += 1) {
    if (cause.code && REASONS.has(cause.code)) break;
    cause = cause.cause;
  }
  if (!cause) return REASONS.get(err?.code) || err?.message || String(err);
  const code = typeof cause.code === 'string' ? cause.code : '';
  if (REASONS.has(code)) return REASONS.get(code);
  // OpenSSL's own text runs to several lines and an internal source path; the
  // first line is the part a person can read.
  const message = typeof cause.message === 'string' && cause.message
    ? cause.message.split('\n')[0].replace(/:?[^:\s]*\.c:\d+:?\s*$/, '').trim()
    : '';
  if (code && message && !message.includes(code)) return `${code}: ${message}`;
  return message || code || err?.message || String(err);
}
