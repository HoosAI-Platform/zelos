/**
 * core/connectors/caldav.mjs — a CalDAV collection.
 *
 * The protocol lives in core/sources/caldav.mjs (1,112 lines behind 1,341 lines
 * of tests) and none of it moved. This file is the manifest the sweep reads and
 * the ten lines that turn a list of documents into a window of events.
 */

import { fetchRange } from '../sources/caldav.mjs';
import { calendarConnector, eventsFrom } from './calendar.mjs';

export default calendarConnector({
  type: 'caldav',
  label: 'Calendar',
  option: 'CalDAV (Fastmail, Nextcloud, iCloud…)',
  credential: {
    label: 'App password',
    help: 'Most CalDAV hosts want an app-specific password rather than the one you log in with.',
    url: '',
    required: false,
  },
  async read({ source, pass, signal, window }) {
    const docs = await fetchRange({
      url: source.url,
      user: source.user,
      pass,
      // Forwarded with `??`, as core/connectors/imap.mjs forwards mail's: the
      // setting is three-valued and `false` is a real answer. (TT-3425)
      requireTls: source.requireTls ?? null,
      from: window.from,
      to: window.to,
      signal,
    });
    const events = [];
    // Each document is expanded and capped on its own, so the truncation is
    // per-document: a collection of a hundred small VEVENT files cannot fill the
    // budget between them, and one enormous recurring series can.
    let truncated = false;
    let incomplete = docs.incomplete === true;
    for (const doc of docs) {
      const part = eventsFrom(doc, window);
      if (part.truncated) truncated = true;
      if (part.incomplete) incomplete = true;
      events.push(...part.events);
    }
    return { events, truncated, incomplete };
  },

  /**
   * What `zelos doctor` used to ask inside `if (calendar.kind === 'caldav')`.
   *
   * It reaches the server through `ctx.testCalDav` rather than importing
   * `testConnection` beside `fetchRange` above, and the asymmetry is deliberate:
   * doctor's whole suite runs against a `deps` object whose every network
   * function throws, so a check that opened its own connection would be a
   * diagnostic no test could hold still. The sweep injects `deps.fetchEvents`
   * for exactly the same reason; each host owns its own seam and the connector
   * uses whichever one it was handed.
   *
   * The read of the stored password is swallowed on purpose. A secret store that
   * will not answer is already a `fail` on doctor's own "Secret store" line, and
   * reporting it twice sends the reader to fix the calendar. Trying the
   * connection unauthenticated instead lets the server's answer be the
   * diagnosis, which is the more useful of the two.
   */
  async check(source, ctx) {
    let pass = null;
    try {
      pass = source.keyRef ? await ctx.getSecret(source.keyRef) : null;
    } catch { /* reported as a connection failure below */ }
    const result = await ctx.testCalDav({
      url: source.url,
      user: source.user || '',
      pass,
      // The rule the sweep reads, or this is a more permissive client than the
      // one that runs at seven — and it would call a calendar healthy on the
      // morning it stops syncing. core/doctor.mjs makes the same point for mail.
      requireTls: source.requireTls ?? null,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    /* Before the sign-in advice below, and on the flag rather than the wording
       (QA, 2026-10-10, TT-3425). The refusal mentions the password, and "check
       the username and the password" is exactly wrong for it: nothing was
       rejected, because nothing was sent. The fix is an address or a setting. */
    if (result?.cleartextRefused) {
      return {
        status: 'fail',
        detail: `${source.url}: ${result.error}`,
        action: 'Change the address in Settings → Calendars to its https:// form. If this server is on your own network and really has no https, set “Sending the password” to “Let this one server take it unencrypted” for this calendar instead.',
      };
    }
    if (!result?.ok) {
      return {
        status: 'fail',
        detail: `${source.url}: ${result?.error || 'the connection failed'}`,
        action: 'Check the server address, the username and the password in Settings → Calendars. iCloud and Fastmail need an app-specific password here, not your account password.',
      };
    }
    return {
      status: 'pass',
      detail: `${result.calendars.length} calendar${result.calendars.length === 1 ? '' : 's'} at ${source.url}`,
    };
  },
});
