/**
 * core/net.mjs — the one rule about when a password may cross the network in
 * the clear, and the loopback test it rests on.
 *
 * A leaf on purpose: it imports nothing. `isLoopbackHost` and
 * `tlsRequiredByDefault` were born in core/sources/imap.mjs because mail was
 * the first reader to need them, and a calendar reader importing three
 * thousand lines of IMAP client to ask "is this 127.0.0.1?" would be paying
 * for a socket library it never opens. imap.mjs re-exports both, so every
 * caller that already imports them from there keeps working unchanged.
 *
 * Callers hand these a HOSTNAME — `URL.hostname`, not `URL.host`. `host`
 * carries the port, and for IPv6 the brackets: `[::1]:5232` is loopback, and a
 * test handed the whole of it would call it a network.
 */

/**
 * Loopback, in every spelling a person or a provider actually writes.
 *
 * This matters because loopback is the one address where a cleartext session
 * is defensible: Proton Bridge and the other local proxies that decrypt on
 * your behalf listen on 127.0.0.1 with no TLS on purpose, and so does a
 * Radicale or Baïkal somebody runs on their own laptop, and that traffic never
 * leaves the machine. `guessImapHost` returns exactly that for a proton.me
 * address. Any other host is a network, and a network has people on it.
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  const v4 = mapped ? mapped[1] : h;
  if (!/^127(?:\.\d{1,3}){3}$/.test(v4)) return false;
  return v4.split('.').every((octet) => Number(octet) <= 255);
}

/**
 * Whether an account must prove the connection is encrypted before it hands
 * over a password, when the config has not said either way. On by default
 * everywhere except loopback — see `isLoopbackHost`.
 */
export function tlsRequiredByDefault(host) {
  return !isLoopbackHost(host);
}

/**
 * Refuse, before a single byte is sent, to put a password on a plain http://
 * request the account has not been excused for. (QA, 2026-10-10, TT-3425)
 *
 * Mail has had this rule since `requireTls` existed: the IMAP client will not
 * LOGIN over a socket that is not encrypted unless the account says so. The
 * calendar readers had nothing of the kind. A CalDAV account or a protected
 * .ics link typed as `http://` sent `Authorization: Basic` — the username and
 * password, base64'd, which is to say in plain text — on every sweep, to a
 * host anyone on the same café wifi could read it from, and nothing anywhere
 * said so.
 *
 * The rule is mail's, word for word, and reads the same tri-state:
 *   - `requireTls: true`  — never send it unencrypted, loopback included;
 *   - `requireTls: false` — this one server may take it in the clear (a
 *     calendar server on your own network that has no https);
 *   - `requireTls: null`  — decide from the host: required everywhere except
 *     loopback. Absent means null, which is what every calendar saved before
 *     this existed says.
 *
 * "A password is being sent" is "a username is set", NOT "a username and a
 * password are set". Both readers send `Basic user:` with an empty password
 * when only a username is filled in, and an empty password is still a header
 * that names the account to everybody listening — and the Test button has to
 * reach the same verdict as the sweep, or "Test it" passes a calendar that
 * then fails at seven in the morning.
 *
 * Only the scheme of the URL the user TYPED is checked, and that is enough:
 * both readers pin the credential to that origin, so a redirect or an href to
 * any other origin — http:// included — is followed anonymously and carries
 * nothing to protect.
 *
 * It throws rather than returning a verdict so a caller cannot forget to look.
 * The error carries `cleartextRefused: true` and the `host`, which is what the
 * doctor and the Test route branch on — never the wording, which is for a
 * person and is allowed to change.
 */
export function assertCleartextAllowed(url, { user = '', requireTls = null } = {}) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    // Not this function's question: every caller has already refused an
    // address it cannot parse, with a message about the address.
    return;
  }
  if (!user || parsed.protocol !== 'http:') return;
  // Read exactly as the IMAP client reads it: only a real `false` excuses a
  // host. A stray 0 or '' that slipped past validation must land on the safe
  // side, not on permission.
  const required = requireTls === null || requireTls === undefined
    ? tlsRequiredByDefault(parsed.hostname)
    : requireTls !== false;
  if (!required) return;
  const err = new Error(cleartextRefusal(parsed.host));
  err.name = 'CleartextRefusedError';
  err.cleartextRefused = true;
  err.host = parsed.host;
  throw err;
}

/**
 * The sentence, in one place, because three readers (the sweep, the Test
 * button and `zelos doctor`) show it and docs/SECURITY.md quotes it. It names
 * the fix in the words of the control that makes it — the picker in Settings →
 * Calendars — rather than in the name of the config key.
 */
export function cleartextRefusal(host) {
  return `Zelos stopped before your calendar password left this machine: ${host} is a plain http:// address. `
    + 'Use its https:// address — or, if this server is on your own network and has no https, set '
    + '“Sending the password” to “Let this one server take it unencrypted” for this calendar.';
}
