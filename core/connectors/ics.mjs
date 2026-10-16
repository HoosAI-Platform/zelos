/**
 * core/connectors/ics.mjs — a subscribed .ics document over http(s).
 *
 * `fetchIcsText` below is lifted out of core/sweep.mjs, and it deliberately
 * does NOT go through `ctx.http`. Routing it there would turn a 401
 * on a subscription URL into an `AuthError`, and an `AuthError` rests the source
 * for six hours — where today it throws "calendar at host returned 401" on every
 * sweep and the user sees the banner every time they look. That is a behaviour
 * change with a test-visible surface, and this pass is a refactor. New
 * connectors get `ctx.http`; this one keeps its own request until somebody wants
 * to pay for the change on purpose. The BODY is read with the transport's
 * `readCapped`, though: `res.text()` bought a whole 40 MB (or endless) feed
 * before the 8 MB check could refuse it.
 */

import { calendarConnector, eventsFrom } from './calendar.mjs';
import { readCapped } from './http.mjs';
import { assertCleartextAllowed } from '../net.mjs';

const ICS_TIMEOUT_MS = 20_000;
const ICS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read an .ics document over HTTP.
 *
 * At most one redirect is followed, and credentials are never carried across an
 * origin change — a calendar URL that redirects elsewhere must not hand that
 * host the user's password.
 *
 * Nor are they sent over plain http:// unless this calendar's `requireTls`
 * says they may be (QA, 2026-10-10, TT-3425). A protected link typed as
 * `http://` used to put `Authorization: Basic` — the password, readable — on
 * the wire every sweep. The check runs on the URL AFTER `webcal:` has become
 * `https:`, because that rewrite is what decides the scheme that is actually
 * fetched, and before the first request, so a refused calendar costs no
 * connection at all. Only the typed URL is checked: the redirect below drops
 * the credential on any change of origin, http:// or not.
 */
export async function fetchIcsText(rawUrl, { user, pass, requireTls = null, signal, timeoutMs = ICS_TIMEOUT_MS } = {}) {
  const url = new URL(String(rawUrl).replace(/^webcal:/i, 'https:'));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`calendar URL must be http, https or webcal (got ${url.protocol})`);
  }
  assertCleartextAllowed(url, { user, requireTls });

  const headers = { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' };
  if (user) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}`;
  }

  // ONE deadline for the pair, not one per hop: a host that stalls just under
  // the timeout and then answers 302 must not hand the redirect target a whole
  // fresh timeout of its own. core/server.mjs and core/doctor.mjs hold one
  // signal across their two hops for the same reason.
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const deadline = AbortSignal.any(signals);

  const request = async (target, withAuth) => {
    const sendHeaders = withAuth ? headers : { accept: headers.accept };
    return fetch(target, {
      headers: sendHeaders,
      redirect: 'manual',
      signal: deadline,
    });
  };

  let res = await request(url, true);
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) throw new Error(`calendar at ${url.host} redirected without a destination`);
    const next = new URL(location, url);
    const sameOrigin = next.origin === url.origin;
    res = await request(next, sameOrigin);
  }
  if (!res.ok) throw new Error(`calendar at ${url.host} returned ${res.status}`);

  // Off the stream, so a huge or endless feed stops costing memory at the cap
  // rather than after it has all arrived.
  const text = await readCapped(res, ICS_MAX_BYTES, `calendar at ${url.host}`);
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error(`calendar at ${url.host} did not return an iCalendar document`);
  }
  return text;
}

export default calendarConnector({
  type: 'ics',
  label: 'Calendar',
  option: 'Subscribed calendar (.ics over the web)',
  credential: {
    label: 'Password',
    help: 'Only if the address is protected. Most published calendars are not.',
    url: '',
    required: false,
  },
  async read({ source, pass, signal, window }) {
    // `??` and not `||`: `false` is a standing permission for this one host,
    // and collapsing it into "not set" would refuse a server the user excused.
    // Same reasoning as core/connectors/imap.mjs.
    const text = await fetchIcsText(source.url, { user: source.user, pass, requireTls: source.requireTls ?? null, signal });
    return eventsFrom(text, window);
  },
});
