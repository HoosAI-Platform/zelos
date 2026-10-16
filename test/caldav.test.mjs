/**
 * test/caldav.test.mjs — the CalDAV client against a local mock server.
 *
 * Every request goes to a node:http server on 127.0.0.1 that replays response
 * shapes taken from Nextcloud, iCloud and Fastmail — differing namespace
 * prefixes, absolute vs path-only hrefs, split propstat blocks. Nothing here
 * reaches a third-party host and nothing touches the real ~/.zelos.
 *
 * Assertions are on what hits the socket (method, path, Depth, Authorization,
 * request body) as much as on what comes back.
 *
 * The client remembers what it discovered, in a file under the Zelos home, so
 * this file gets a throwaway home of its own and empties the cache before every
 * test. Mock servers are handed a fresh port by the OS and a port can be reused
 * once a server has closed, so a test that counted requests could otherwise be
 * answered from what a previous test's server had taught the cache.
 */

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

/* Settled before the modules that read it are evaluated, which static imports
   would not allow — hence the dynamic imports below. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-caldav-home-'));
process.env.ZELOS_HOME = HOME;
process.env.ZELOS_LOG_LEVEL = 'silent';

const { discover, fetchRange, testConnection, invalidate } = await import('../core/sources/caldav.mjs');
const { parseICS_toEvents } = await import('../core/sources/ics.mjs');

beforeEach(() => invalidate());
after(() => fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const USER = 'nemo@example.test';
const PASS = 'app-specific-password';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`;

/**
 * Start a mock server. `routes` maps "METHOD /path" to a handler that returns
 * {status, body, headers} — or a plain string, meaning 207 + XML.
 * Every request is recorded for assertions.
 */
async function startServer(routes, { requireAuth = true } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = req.url;
      requests.push({
        method: req.method,
        path,
        depth: req.headers.depth ?? null,
        auth: req.headers.authorization ?? null,
        contentType: req.headers['content-type'] ?? null,
        body,
      });

      if (requireAuth && req.headers.authorization !== EXPECTED_AUTH) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' });
        res.end('Unauthorized');
        return;
      }

      const route = routes[`${req.method} ${path}`] ?? routes[`${req.method} *`];
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const result = typeof route === 'function' ? route({ body }) : route;
      if (typeof result === 'string') {
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(result);
        return;
      }
      res.writeHead(result.status ?? 207, {
        'content-type': 'application/xml; charset=utf-8',
        ...(result.headers || {}),
      });
      res.end(result.body ?? '');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { origin, requests, close, server };
}

/* ------------------------------------------------------------------ *
 * Response fixtures
 * ------------------------------------------------------------------ */

/** Nextcloud: `d:` prefix, path-only hrefs. */
const NEXTCLOUD_PRINCIPAL = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/</d:href>
  <d:propstat>
   <d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/users/nemo/</d:href></d:current-user-principal></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat>
   <d:prop><d:resourcetype/></d:prop>
   <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

const NEXTCLOUD_HOME = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/principals/users/nemo/</d:href>
  <d:propstat>
   <d:prop><cal:calendar-home-set><d:href>/remote.php/dav/calendars/nemo/</d:href></cal:calendar-home-set></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

/**
 * The collection listing, with everything that must be filtered out: the home
 * collection itself, a VTODO-only list, a scheduling inbox and an addressbook.
 */
const NEXTCLOUD_COLLECTIONS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"
               xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/personal/</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
    <d:displayname>Personal &amp; family</d:displayname>
    <cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
    <cs:getctag>http://sabre.io/ns/sync/42</cs:getctag>
    <ic:calendar-color>#C1440EFF</ic:calendar-color>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/tasks/</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
    <d:displayname>Tasks</d:displayname>
    <cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/inbox/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><cal:calendar/><cal:schedule-inbox/></d:resourcetype><d:displayname>Inbox</d:displayname></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/addressbooks/nemo/contacts/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><card:addressbook xmlns:card="urn:ietf:params:xml:ns:carddav"/></d:resourcetype></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/work/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat>
   <d:prop><d:displayname/></d:prop>
   <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

const EVENT_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Mock//EN',
  'BEGIN:VEVENT',
  'UID:cd-1@example.test',
  'DTSTART;TZID=America/New_York:20260811T140000',
  'DTEND;TZID=America/New_York:20260811T150000',
  'SUMMARY:Kickoff with Marcus & co',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const RECURRING_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Mock//EN',
  'BEGIN:VEVENT',
  'UID:cd-2@example.test',
  'DTSTART;TZID=America/New_York:20261029T090000',
  'DTEND;TZID=America/New_York:20261029T100000',
  'RRULE:FREQ=WEEKLY;COUNT=2',
  'SUMMARY:Thursday sync',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** calendar-data escaped as text — the common form. */
function reportBody(items) {
  const responses = items
    .map(
      (ics, i) => `
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/personal/e${i}.ics</d:href>
  <d:propstat>
   <d:prop><d:getetag>"etag-${i}"</d:getetag><cal:calendar-data>${xmlEscape(ics)}</cal:calendar-data></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>`,
    )
    .join('');
  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${responses}
</d:multistatus>`;
}

const NEXTCLOUD_ROUTES = {
  'PROPFIND /': NEXTCLOUD_PRINCIPAL,
  'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
  'PROPFIND /remote.php/dav/calendars/nemo/': NEXTCLOUD_COLLECTIONS,
  'REPORT /remote.php/dav/calendars/nemo/personal/': () => reportBody([EVENT_ICS, RECURRING_ICS]),
  'REPORT /remote.php/dav/calendars/nemo/work/': () => reportBody([]),
};

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

test('discover walks principal -> home-set -> calendars', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });

  assert.equal(result.principal, `${mock.origin}/remote.php/dav/principals/users/nemo/`);
  assert.equal(result.homeSet, `${mock.origin}/remote.php/dav/calendars/nemo/`);
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Personal & family', 'work'],
    'VTODO-only lists, inboxes, addressbooks and the home collection are all filtered out',
  );
  assert.equal(result.calendars[0].href, `${mock.origin}/remote.php/dav/calendars/nemo/personal/`);
  assert.equal(result.calendars[0].color, '#C1440EFF');
  assert.equal(result.calendars[0].ctag, 'http://sabre.io/ns/sync/42');
  assert.deepEqual(result.calendars[0].components, ['VEVENT', 'VTODO']);
});

test('discovery sends Basic auth and the right Depth on every hop', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  await discover({ url: mock.origin, user: USER, pass: PASS });

  assert.deepEqual(
    mock.requests.map((r) => [r.method, r.path, r.depth]),
    [
      ['PROPFIND', '/', '0'],
      ['PROPFIND', '/remote.php/dav/principals/users/nemo/', '0'],
      ['PROPFIND', '/remote.php/dav/calendars/nemo/', '1'],
    ],
  );
  for (const r of mock.requests) {
    assert.equal(r.auth, EXPECTED_AUTH, 'every request carries the credentials');
    assert.match(r.contentType, /xml/);
  }
  assert.match(mock.requests[0].body, /current-user-principal/);
  assert.match(mock.requests[1].body, /calendar-home-set/);
  assert.match(mock.requests[2].body, /supported-calendar-component-set/);
});

test('a URL pointing straight at one calendar is discovered by the same call', async (t) => {
  const single = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/dav/calendars/personal/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Just this one</d:displayname></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

  const mock = await startServer({
    'PROPFIND /dav/calendars/personal/': ({ body }) =>
      body.includes('current-user-principal')
        ? `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/calendars/personal/</d:href><d:propstat><d:prop><d:current-user-principal/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`
        : single,
  });
  t.after(() => mock.close());

  const result = await discover({ url: `${mock.origin}/dav/calendars/personal/`, user: USER, pass: PASS });
  assert.equal(result.principal, null);
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Just this one'],
  );
});

test('discovery falls back to /.well-known/caldav when the root is not a DAV resource', async (t) => {
  const mock = await startServer({
    'PROPFIND /': { status: 405, body: 'Method Not Allowed' },
    'PROPFIND /.well-known/caldav': NEXTCLOUD_PRINCIPAL,
    'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
    'PROPFIND /remote.php/dav/calendars/nemo/': NEXTCLOUD_COLLECTIONS,
  });
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.calendars.length, 2);
  assert.deepEqual(
    mock.requests.map((r) => r.path).slice(0, 2),
    ['/', '/.well-known/caldav'],
  );
});

test('iCloud-shaped responses: default namespace and absolute hrefs', async (t) => {
  let origin = '';
  const mock = await startServer({
    'PROPFIND /': () => `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <response>
  <href>/</href>
  <propstat><prop><current-user-principal><href>${origin}/1472538/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat>
 </response>
</multistatus>`,
    'PROPFIND /1472538/principal/': () => `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <response>
  <href>/1472538/principal/</href>
  <propstat><prop><cal:calendar-home-set><href>${origin}/1472538/calendars/</href></cal:calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat>
 </response>
</multistatus>`,
    'PROPFIND /1472538/calendars/': () => `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <response>
  <href>${origin}/1472538/calendars/home/</href>
  <propstat>
   <prop>
    <resourcetype><collection/><cal:calendar/></resourcetype>
    <displayname>Home</displayname>
    <cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
   </prop>
   <status>HTTP/1.1 200 OK</status>
  </propstat>
 </response>
</multistatus>`,
  });
  origin = mock.origin;
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.principal, `${mock.origin}/1472538/principal/`);
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Home'],
  );
  assert.equal(result.calendars[0].href, `${mock.origin}/1472538/calendars/home/`);
});

test('Fastmail-shaped responses: uppercase prefixes', async (t) => {
  const mock = await startServer({
    'PROPFIND /': `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
 <D:response><D:href>/dav/</D:href>
  <D:propstat><D:prop><D:current-user-principal><D:href>/dav/principals/user/nemo@example.test/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
 </D:response>
</D:multistatus>`,
    'PROPFIND /dav/principals/user/nemo@example.test/': `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
 <D:response><D:href>/dav/principals/user/nemo@example.test/</D:href>
  <D:propstat><D:prop><C:calendar-home-set><D:href>/dav/calendars/user/nemo@example.test/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
 </D:response>
</D:multistatus>`,
    'PROPFIND /dav/calendars/user/nemo@example.test/': `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
 <D:response><D:href>/dav/calendars/user/nemo@example.test/6f9c/</D:href>
  <D:propstat><D:prop>
   <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
   <D:displayname>Fastmail calendar</D:displayname>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
 </D:response>
</D:multistatus>`,
  });
  t.after(() => mock.close());

  const result = await discover({ url: `${mock.origin}/`, user: USER, pass: PASS });
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Fastmail calendar'],
  );
});

/* ------------------------------------------------------------------ *
 * Redirects
 * ------------------------------------------------------------------ */

test('one redirect is followed with the method and body intact', async (t) => {
  const mock = await startServer({
    'PROPFIND /': { status: 301, headers: { location: '/remote.php/dav/' }, body: '' },
    'PROPFIND /remote.php/dav/': NEXTCLOUD_PRINCIPAL,
    'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
    'PROPFIND /remote.php/dav/calendars/nemo/': NEXTCLOUD_COLLECTIONS,
  });
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.calendars.length, 2);

  const redirected = mock.requests[1];
  assert.equal(redirected.method, 'PROPFIND', 'the method survives the redirect');
  assert.match(redirected.body, /current-user-principal/, 'so does the body');
  assert.equal(redirected.depth, '0');
});

test('a second redirect is refused', async (t) => {
  const mock = await startServer({
    'PROPFIND /': { status: 302, headers: { location: '/one/' }, body: '' },
    'PROPFIND /one/': { status: 302, headers: { location: '/two/' }, body: '' },
    'PROPFIND /.well-known/caldav': { status: 404, body: '' },
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /redirected more than once/);
});

test('a redirect to a non-HTTP location is refused', async (t) => {
  const mock = await startServer({
    'PROPFIND *': { status: 302, headers: { location: 'file:///etc/passwd' }, body: '' },
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /non-HTTP/);
});

/* ------------------------------------------------------------------ *
 * testConnection
 * ------------------------------------------------------------------ */

test('testConnection reports the calendars it found', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.deepEqual(
    result.calendars.map((c) => c.name),
    ['Personal & family', 'work'],
  );
  assert.deepEqual(Object.keys(result.calendars[0]).sort(), ['href', 'name']);
});

test('wrong credentials fail fast with an actionable message', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: 'wrong' });
  assert.equal(result.ok, false);
  assert.match(result.error, /rejected the credentials/);
  assert.match(result.error, /app-specific password/);
  assert.match(result.error, /127\.0\.0\.1/, 'the message names the host that failed');
  assert.equal(mock.requests.length, 1, 'a 401 stops discovery instead of probing more paths');
});

test('a server with no calendars says so instead of claiming success', async (t) => {
  const mock = await startServer({
    'PROPFIND /': NEXTCLOUD_PRINCIPAL,
    'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
    'PROPFIND /remote.php/dav/calendars/nemo/': `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`,
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /found no calendars/);
});

test('an unreachable host reports the host, not a stack trace', async () => {
  const mock = await startServer({});
  const origin = mock.origin;
  await mock.close(); // nothing is listening any more

  const result = await testConnection({ url: origin, user: USER, pass: PASS, timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not reach 127\.0\.0\.1/);
});

test('a non-HTTP scheme is rejected before any socket is opened', async () => {
  const result = await testConnection({ url: 'ftp://calendar.example.test/dav/', user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be http or https/);
});

/* ------------------------------------------------------------------ *
 * fetchRange
 * ------------------------------------------------------------------ */

test('fetchRange issues a calendar-query with the requested window', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const texts = await fetchRange({
    url: mock.origin,
    user: USER,
    pass: PASS,
    from: '2026-08-01T00:00:00Z',
    to: '2026-11-30T00:00:00Z',
  });

  assert.equal(texts.length, 2);
  for (const text of texts) assert.match(text, /^BEGIN:VCALENDAR/);
  assert.ok(texts[0].includes('Kickoff with Marcus & co'), 'XML entities are decoded back to the raw ICS');

  const reports = mock.requests.filter((r) => r.method === 'REPORT');
  assert.deepEqual(
    reports.map((r) => r.path),
    ['/remote.php/dav/calendars/nemo/personal/', '/remote.php/dav/calendars/nemo/work/'],
    'every discovered calendar is queried',
  );
  assert.equal(reports[0].depth, '1');
  assert.match(reports[0].body, /<c:comp-filter name="VEVENT">/);
  assert.match(reports[0].body, /start="20260801T000000Z"/);
  assert.match(reports[0].body, /end="20261130T000000Z"/);
  assert.match(reports[0].body, /calendar-data/);
});

test('fetchRange output parses into events that carry their offsets', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const texts = await fetchRange({
    url: mock.origin,
    user: USER,
    pass: PASS,
    from: '2026-08-01T00:00:00Z',
    to: '2026-11-30T00:00:00Z',
  });

  const events = texts.flatMap((text) =>
    parseICS_toEvents(text, { from: '2026-08-01T00:00:00Z', to: '2026-11-30T00:00:00Z', tzid: 'America/New_York' }),
  );

  assert.deepEqual(
    events.map((e) => e.startsAt),
    [
      '2026-08-11T14:00:00-04:00',
      '2026-10-29T09:00:00-04:00',
      '2026-11-05T09:00:00-05:00', // the series crosses the end of DST
    ],
  );
  assert.equal(events[0].title, 'Kickoff with Marcus & co');
});

test('calendar-data delivered as CDATA is read too', async (t) => {
  const mock = await startServer({
    ...NEXTCLOUD_ROUTES,
    'REPORT /remote.php/dav/calendars/nemo/personal/': () => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response><d:href>/remote.php/dav/calendars/nemo/personal/e0.ics</d:href>
  <d:propstat><d:prop><cal:calendar-data><![CDATA[${EVENT_ICS}]]></cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>`,
  });
  t.after(() => mock.close());

  const texts = await fetchRange({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes('SUMMARY:Kickoff with Marcus & co'));
});

test('one failing calendar does not cost the user the others', async (t) => {
  const mock = await startServer({
    ...NEXTCLOUD_ROUTES,
    'REPORT /remote.php/dav/calendars/nemo/personal/': { status: 500, body: 'boom' },
    'REPORT /remote.php/dav/calendars/nemo/work/': () => reportBody([EVENT_ICS]),
  });
  t.after(() => mock.close());

  const texts = await fetchRange({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(texts.length, 1);
  assert.equal(texts.incomplete, true, 'partial collections cannot authorize cache deletion');
});

test('responses that are not calendar data are ignored', async (t) => {
  const mock = await startServer({
    ...NEXTCLOUD_ROUTES,
    'REPORT /remote.php/dav/calendars/nemo/personal/': `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response><d:href>/x.ics</d:href>
  <d:propstat><d:prop><cal:calendar-data>not a calendar at all</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response><d:href>/y.ics</d:href>
  <d:propstat><d:prop><cal:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
</d:multistatus>`,
    'REPORT /remote.php/dav/calendars/nemo/work/': () => reportBody([]),
  });
  t.after(() => mock.close());

  assert.deepEqual(await fetchRange({ url: mock.origin, user: USER, pass: PASS }), []);
});

/* ------------------------------------------------------------------ *
 * What a second sweep costs
 * ------------------------------------------------------------------ */

/** Every PROPFIND the mock was asked for, in order. */
const propfinds = (mock) => mock.requests.filter((r) => r.method === 'PROPFIND').map((r) => r.path);
const reports = (mock) => mock.requests.filter((r) => r.method === 'REPORT').map((r) => r.path);

test('the discovery walk happens once across two sweeps, not once per sweep', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const window = { from: '2026-08-01T00:00:00Z', to: '2026-11-30T00:00:00Z' };
  await fetchRange({ url: mock.origin, user: USER, pass: PASS, ...window });

  assert.deepEqual(
    propfinds(mock),
    ['/', '/remote.php/dav/principals/users/nemo/', '/remote.php/dav/calendars/nemo/'],
    'the first sweep pays for the whole walk',
  );

  mock.requests.length = 0;
  await fetchRange({ url: mock.origin, user: USER, pass: PASS, ...window });

  assert.deepEqual(
    propfinds(mock),
    ['/remote.php/dav/calendars/nemo/'],
    'the second sweep re-reads only the collection listing — that is where the ctags are',
  );
});

test('a changed account is rediscovered rather than answered from the last one', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES, { requireAuth: false });
  t.after(() => mock.close());

  await fetchRange({ url: mock.origin, user: USER, pass: PASS });
  mock.requests.length = 0;

  await fetchRange({ url: mock.origin, user: 'someone.else@example.test', pass: PASS });
  assert.deepEqual(
    propfinds(mock),
    ['/', '/remote.php/dav/principals/users/nemo/', '/remote.php/dav/calendars/nemo/'],
    'a different username is a different account and gets its own walk',
  );

  // And the edits that change neither URL nor username still get a fresh walk
  // when Settings says so.
  mock.requests.length = 0;
  await fetchRange({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(propfinds(mock).length, 1, 'the first account is still remembered');

  invalidate({ url: mock.origin, user: USER });
  mock.requests.length = 0;
  await fetchRange({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(propfinds(mock).length, 3, 'invalidate() puts the full walk back');
});

test('a ctag that has not moved skips the calendar-query entirely', async (t) => {
  let ctag = 'sync/42';
  const collections = () => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/personal/</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
    <d:displayname>Personal</d:displayname>
    <cs:getctag>${ctag}</cs:getctag>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

  const mock = await startServer({
    'PROPFIND /': NEXTCLOUD_PRINCIPAL,
    'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
    'PROPFIND /remote.php/dav/calendars/nemo/': () => collections(),
    'REPORT /remote.php/dav/calendars/nemo/personal/': () => reportBody([EVENT_ICS]),
  });
  t.after(() => mock.close());

  const sweep = () => fetchRange({
    url: mock.origin,
    user: USER,
    pass: PASS,
    from: '2026-08-01T00:00:00Z',
    to: '2026-11-30T00:00:00Z',
  });

  const first = await sweep();
  assert.equal(first.length, 1);
  assert.equal(reports(mock).length, 1);

  mock.requests.length = 0;
  const second = await sweep();
  assert.deepEqual(reports(mock), [], 'an unchanged ctag means no REPORT at all');
  assert.deepEqual(second, first, 'and the caller still gets the events, not an empty answer');

  // The collection changes, so the ctag changes, so the query runs again.
  ctag = 'sync/43';
  mock.requests.length = 0;
  const third = await sweep();
  assert.deepEqual(reports(mock), ['/remote.php/dav/calendars/nemo/personal/']);
  assert.deepEqual(third, first);
});

test('a calendar that advertises no ctag is read every time', async (t) => {
  // NEXTCLOUD_COLLECTIONS gives `work` no getctag, so there is nothing that
  // could say it had not changed. Skipping it would be a guess.
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  const sweep = () => fetchRange({ url: mock.origin, user: USER, pass: PASS });
  await sweep();
  mock.requests.length = 0;
  await sweep();

  assert.deepEqual(reports(mock), ['/remote.php/dav/calendars/nemo/work/']);
});

test('a remembered layout that stops working falls back to the full walk', async (t) => {
  let listable = true;
  const mock = await startServer({
    'PROPFIND /': NEXTCLOUD_PRINCIPAL,
    'PROPFIND /remote.php/dav/principals/users/nemo/': NEXTCLOUD_HOME,
    'PROPFIND /remote.php/dav/calendars/nemo/': () =>
      (listable ? NEXTCLOUD_COLLECTIONS : { status: 404, body: 'Not Found' }),
    'REPORT *': () => reportBody([EVENT_ICS]),
  });
  t.after(() => mock.close());

  assert.equal((await fetchRange({ url: mock.origin, user: USER, pass: PASS })).length, 2);

  listable = false;
  mock.requests.length = 0;
  assert.deepEqual(await fetchRange({ url: mock.origin, user: USER, pass: PASS }), []);
  assert.deepEqual(
    propfinds(mock),
    [
      '/remote.php/dav/calendars/nemo/',            // the remembered hop, now a 404
      '/remote.php/dav/principals/users/nemo/',     // the rung above it, which still answers
      '/',                                          // ...but points back at the 404, so the walk runs
      '/remote.php/dav/principals/users/nemo/',
      '/remote.php/dav/calendars/nemo/',
      '/',                                          // ...down to the last candidate root
    ],
    'the record is dropped and rediscovery is attempted, rather than the sweep giving up',
  );

  // And once the server is well again, the next sweep works without anyone
  // clearing anything by hand.
  listable = true;
  assert.equal((await fetchRange({ url: mock.origin, user: USER, pass: PASS })).length, 2);
});

/* ------------------------------------------------------------------ *
 * The rungs above the listing root
 * ------------------------------------------------------------------ */

/**
 * The layout record keeps three URLs, and the two above the listing root are
 * the ones that make a *moved* collection cheap. A provider that renames a
 * calendar almost always leaves the home set alone, and one that moves the home
 * set almost always leaves the principal alone — so a listing that stops
 * answering walks back up the record before it re-runs the walk from the URL
 * the user typed. Remembering them and never reading them back would be two
 * strings that cost a write and bought nothing.
 *
 * The layout here is the one a person creates by pasting the address of a
 * single calendar into Settings: the listing root is that collection, and the
 * home set is somewhere else entirely.
 */
const MOVED_PRINCIPAL = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/dav/one/</d:href>
  <d:propstat>
   <d:prop><d:current-user-principal><d:href>/dav/principals/nemo/</d:href></d:current-user-principal></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

const homeSetDoc = (href) => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response><d:href>/dav/principals/nemo/</d:href>
  <d:propstat>
   <d:prop><cal:calendar-home-set><d:href>${href}</d:href></cal:calendar-home-set></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

const listingDoc = (href, name, ctag) => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
 <d:response><d:href>${href}</d:href>
  <d:propstat>
   <d:prop>
    <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
    <d:displayname>${name}</d:displayname>
    <cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
    <cs:getctag>${ctag}</cs:getctag>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

const GONE = { status: 404, body: 'Not Found' };

test('a collection that moved is found from the remembered home set, not by walking again', async (t) => {
  let oneLists = true;
  let homeLists = false;

  const mock = await startServer({
    // Depth:0 asks who I am; Depth:1 asks what is here. Same path, so the body
    // is what tells them apart.
    'PROPFIND /dav/one/': ({ body }) => {
      if (body.includes('current-user-principal')) return MOVED_PRINCIPAL;
      return oneLists ? listingDoc('/dav/one/', 'The one calendar', 'one/1') : GONE;
    },
    'PROPFIND /dav/principals/nemo/': homeSetDoc('/dav/home/nemo/'),
    'PROPFIND /dav/home/nemo/': () => (homeLists ? listingDoc('/dav/home/nemo/personal/', 'Personal', 'home/1') : GONE),
    'REPORT *': () => reportBody([EVENT_ICS]),
  });
  t.after(() => mock.close());

  const sweep = () => fetchRange({ url: `${mock.origin}/dav/one/`, user: USER, pass: PASS });

  // The home set will not list, so discovery settles on the collection itself —
  // which is how the listing root and the home set come to be different URLs.
  assert.equal((await sweep()).length, 1);

  // The provider moves the calendar out of that collection and starts answering
  // on the home set.
  oneLists = false;
  homeLists = true;
  mock.requests.length = 0;
  assert.equal((await sweep()).length, 1, 'a moved collection lost the sweep its calendars');
  assert.deepEqual(
    propfinds(mock),
    ['/dav/one/', '/dav/home/nemo/'],
    'the remembered home set was never asked; the whole walk ran instead',
  );

  // And the record now names the URL that answered, so the sweep after it is
  // back to the one request it was before anything moved.
  mock.requests.length = 0;
  assert.equal((await sweep()).length, 1);
  assert.deepEqual(propfinds(mock), ['/dav/home/nemo/']);
});

test('a home set that moved is found from the remembered principal', async (t) => {
  let homeSet = '/dav/home/nemo/';

  const mock = await startServer({
    'PROPFIND /dav/one/': ({ body }) => (body.includes('current-user-principal') ? MOVED_PRINCIPAL : GONE),
    'PROPFIND /dav/principals/nemo/': () => homeSetDoc(homeSet),
    'PROPFIND /dav/home/nemo/': () =>
      (homeSet === '/dav/home/nemo/' ? listingDoc('/dav/home/nemo/personal/', 'Personal', 'h1/1') : GONE),
    'PROPFIND /dav/home2/nemo/': () => listingDoc('/dav/home2/nemo/personal/', 'Personal', 'h2/1'),
    'REPORT *': () => reportBody([EVENT_ICS]),
  });
  t.after(() => mock.close());

  const sweep = () => fetchRange({ url: `${mock.origin}/dav/one/`, user: USER, pass: PASS });
  assert.equal((await sweep()).length, 1);

  // The account is migrated to a new home set. The principal is the one URL a
  // server almost never moves, and asking it is two requests where the walk is
  // four — so nothing here should touch the well-known path or the origin.
  homeSet = '/dav/home2/nemo/';
  mock.requests.length = 0;
  assert.equal((await sweep()).length, 1, 'a moved home set lost the sweep its calendars');
  assert.deepEqual(
    propfinds(mock),
    ['/dav/home/nemo/', '/dav/principals/nemo/', '/dav/home2/nemo/'],
    'the remembered principal was never asked; the whole walk ran instead',
  );

  mock.requests.length = 0;
  assert.equal((await sweep()).length, 1);
  assert.deepEqual(propfinds(mock), ['/dav/home2/nemo/'], 'the new layout was not remembered');
});

test('a rejected credential is still a credential answer, cache or no cache', async (t) => {
  let authRequired = false;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (authRequired) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' });
        res.end('Unauthorized');
        return;
      }
      const route = NEXTCLOUD_ROUTES[`${req.method} ${req.url}`];
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const body = typeof route === 'function' ? route({ body: '' }) : route;
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(typeof body === 'string' ? body : body.body ?? '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await fetchRange({ url: origin, user: USER, pass: PASS });

  authRequired = true;
  await assert.rejects(
    () => fetchRange({ url: origin, user: USER, pass: PASS }),
    /rejected the credentials/,
    'a 401 on the remembered hop must reach the caller, not be swallowed as a stale cache',
  );
});

/* ------------------------------------------------------------------ *
 * Partitioned accounts — one account, two origins
 * ------------------------------------------------------------------ */

/**
 * Apple splits an account across hosts: an unauthenticated PROPFIND to
 * caldav.icloud.com comes back with `x-apple-user-partition: 64` and an
 * `X-Responding-Instance` naming a p64 box, so the hrefs a front host hands out
 * can point at an origin the person never typed. The pin sends those hops
 * anonymously — that is the whole point of it, since a hostile href and a
 * partition href are the same thing until somebody answers — and a host that
 * wanted a password answers 401.
 *
 * That 401 is not a verdict on the password. Reading it as one used to end the
 * walk on the spot, before `base` — the URL the person actually typed — had had
 * its Depth:1 listing, which on this layout is the one call that works.
 *
 * Two origins here means two servers on 127.0.0.1 with a port apiece: URL.origin
 * and the pin both count the port, so this is a genuine cross-origin hop on
 * every OS, with no second loopback address to alias.
 */
const partitionPrincipal = (href) => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/</d:href>
  <d:propstat>
   <d:prop><d:current-user-principal><d:href>${href}</d:href></d:current-user-principal></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

const NO_COLLECTIONS = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`;

/**
 * The other origin. Its route is unreachable by design — every request arrives
 * without Authorization and is 401'd before routing — so if the pin ever leaks
 * the password here the calendar called LEAKED turns up in the results and the
 * name assertions fail, not just the header ones.
 */
const startPartitionHost = () =>
  startServer({ 'PROPFIND *': listingDoc('/p64/calendars/leaked/', 'LEAKED', 'p64/1') });

const hostPart = (origin) => origin.slice('http://'.length);

test('a home set on a second origin does not cost the typed URL its Depth:1 listing', async (t) => {
  const partition = await startPartitionHost();
  t.after(() => partition.close());

  const front = await startServer({
    // Depth:0 asks who I am, Depth:1 asks what is here. Same path, so the body
    // is what tells them apart.
    'PROPFIND /': ({ body }) =>
      (body.includes('current-user-principal')
        ? partitionPrincipal('/dav/principals/nemo/')
        : listingDoc('/dav/calendars/home/', 'Home', 'front/1')),
    'PROPFIND /dav/principals/nemo/': () => homeSetDoc(`${partition.origin}/1472538/calendars/`),
    'REPORT /dav/calendars/home/': () => reportBody([EVENT_ICS]),
  });
  t.after(() => front.close());

  const probe = await testConnection({ url: front.origin, user: USER, pass: PASS });
  assert.equal(probe.ok, true, 'the anonymous 401 ended the walk before the typed URL was listed');
  assert.deepEqual(probe.calendars.map((c) => c.name), ['Home']);

  assert.equal(
    (await fetchRange({ url: front.origin, user: USER, pass: PASS })).length,
    1,
    'and the sweep collects events instead of throwing',
  );

  assert.ok(partition.requests.length >= 1, 'the cross-origin home set was followed at all');
  for (const r of partition.requests) {
    assert.equal(r.auth, null, 'the pin still spends the password on exactly one origin');
  }
  assert.ok(
    front.requests.some((r) => r.method === 'PROPFIND' && r.path === '/' && r.depth === '1'),
    'the URL the user typed was listed at Depth:1',
  );
});

test('a principal on a second origin fails loudly instead of sweeping empty for ever', async (t) => {
  const partition = await startPartitionHost();
  t.after(() => partition.close());

  const front = await startServer({
    'PROPFIND /': ({ body }) =>
      (body.includes('current-user-principal')
        ? partitionPrincipal(`${partition.origin}/1472538/principal/`)
        : NO_COLLECTIONS),
  });
  t.after(() => front.close());

  // The worse of the two shapes, because it used to raise nothing at all: the
  // home-set hop was swallowed, the front host listed no calendars, and
  // discovery returned an empty list as if that were an answer. A calendar
  // configured this way contributed nothing to every sweep for ever and never
  // said why.
  await assert.rejects(
    () => fetchRange({ url: front.origin, user: USER, pass: PASS }),
    (err) => {
      assert.match(err.message, /asked for a password/);
      assert.ok(err.message.includes(hostPart(partition.origin)), 'the message names the host to paste');
      assert.match(err.message, /put its address in the calendar URL directly/);
      return true;
    },
    'the sweep came back empty and silent instead of reporting the host it was refused by',
  );

  const probe = await testConnection({ url: front.origin, user: USER, pass: PASS });
  assert.equal(probe.ok, false);
  assert.match(
    probe.error,
    /put its address in the calendar URL directly/,
    'the message carries the remedy, rather than "found no calendars"',
  );

  for (const r of partition.requests) {
    assert.equal(r.auth, null, 'the pin still spends the password on exactly one origin');
  }
});

test('a remembered home set on the other origin does not end the sweep either', async (t) => {
  const partition = await startPartitionHost();
  t.after(() => partition.close());

  let listAtOne = true;
  let homeSet = `${partition.origin}/1472538/calendars/`;

  const front = await startServer({
    'PROPFIND /dav/one/': ({ body }) => {
      if (body.includes('current-user-principal')) return MOVED_PRINCIPAL;
      return listAtOne ? listingDoc('/dav/one/', 'The one calendar', 'one/1') : GONE;
    },
    'PROPFIND /dav/principals/nemo/': () => homeSetDoc(homeSet),
    'PROPFIND /dav/home/nemo/': () => listingDoc('/dav/home/nemo/personal/', 'Personal', 'home/1'),
    'REPORT *': () => reportBody([EVENT_ICS]),
  });
  t.after(() => front.close());

  const sweep = () => fetchRange({ url: `${front.origin}/dav/one/`, user: USER, pass: PASS });

  // The home set is on the other origin and will not talk to an anonymous
  // caller, so discovery settles on the collection itself — and remembers a
  // record whose home set is a host it may never authenticate to.
  assert.equal((await sweep()).length, 1);

  // Then the provider empties that collection and moves the home set back onto
  // the front host. The remembered rungs are walked in order: the listing root
  // 404s, the remembered home set 401s anonymously — which must not end the
  // sweep — and the principal names the home set that answers.
  listAtOne = false;
  homeSet = '/dav/home/nemo/';
  front.requests.length = 0;
  assert.equal((await sweep()).length, 1, 'the anonymous 401 on the remembered home set ended the sweep');
  assert.deepEqual(propfinds(front), ['/dav/one/', '/dav/principals/nemo/', '/dav/home/nemo/']);
  for (const r of partition.requests) {
    assert.equal(r.auth, null, 'the pin still spends the password on exactly one origin');
  }
});

test('the layout cache holds no credentials', async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  await fetchRange({ url: mock.origin, user: USER, pass: PASS });

  const dir = path.join(HOME, 'cache', 'caldav');
  const files = fs.readdirSync(dir);
  assert.ok(files.length >= 1, 'something was remembered');
  for (const name of files) {
    const raw = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.equal(raw.includes(PASS), false, 'the calendar password must never be written down');
    assert.equal(raw.includes(USER), false, 'nor the username the key was derived from');
  }
});

/**
 * The mode the cache is written with, split out from what is *in* it so the two
 * halves can be judged separately: the contents claim holds everywhere and must
 * keep running everywhere, while the mode is a POSIX promise Windows does not
 * implement. There `fs.chmod` sets little beyond the read-only flag and `fs.stat`
 * reports a synthesised 0666, so 0600 is not observable and asserting anything
 * looser would be dressing up an unenforced claim as a passing test. Windows
 * protects this the way docs/SECURITY.md now says it does — with the ACL on the
 * user's profile directory — which is not something this test can read.
 */
test('the layout cache is written 0600', {
  skip: process.platform === 'win32'
    ? 'Windows has no POSIX file modes: fs.chmod sets little more than the read-only flag and fs.stat reports a synthesised 0666, so the 0600 this asserts is unobservable there. At-rest protection on Windows is the profile-directory ACL (see docs/SECURITY.md), which this test cannot verify.'
    : false,
}, async (t) => {
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());

  await fetchRange({ url: mock.origin, user: USER, pass: PASS });

  const dir = path.join(HOME, 'cache', 'caldav');
  const files = fs.readdirSync(dir);
  assert.ok(files.length >= 1, 'something was remembered');
  for (const name of files) {
    assert.equal(
      fs.statSync(path.join(dir, name)).mode & 0o777,
      0o600,
      `${name} is readable by every other account on the machine`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Hostile responses
 * ------------------------------------------------------------------ */

test('a DOCTYPE with entity declarations is skipped, never expanded', async (t) => {
  // The billion-laughs shape. If these declarations were honoured the parser
  // would allocate gigabytes; they are skipped along with the whole DOCTYPE, so
  // "&lol9;" survives as literal text and expands to nothing.
  const bomb = `<?xml version="1.0"?>
<!DOCTYPE multistatus [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY lol9 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response>
  <d:href>/remote.php/dav/calendars/nemo/personal/</d:href>
  <d:propstat>
   <d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>&lol9;</d:displayname></d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>`;

  const noPrincipal = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`;
  const mock = await startServer({
    // The Depth:0 principal probe and the Depth:1 listing hit the same path;
    // the request body is what distinguishes them.
    'PROPFIND /': ({ body }) => (body.includes('current-user-principal') ? noPrincipal : bomb),
    'PROPFIND /.well-known/caldav': { status: 404, body: '' },
  });
  t.after(() => mock.close());

  const started = Date.now();
  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.calendars.length, 1);
  assert.equal(result.calendars[0].name, '&lol9;', 'an undeclared-as-far-as-we-care entity stays literal');
});

test('an href pointing at another scheme is dropped rather than followed', async (t) => {
  const mock = await startServer({
    'PROPFIND /': `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/</d:href>
  <d:propstat><d:prop><d:current-user-principal><d:href>file:///etc/passwd</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>`,
    'PROPFIND /.well-known/caldav': { status: 404, body: '' },
  });
  t.after(() => mock.close());

  const result = await discover({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.principal, null, 'a file: principal is not a principal');
  assert.deepEqual(result.calendars, []);
  assert.ok(
    mock.requests.every((r) => r.method === 'PROPFIND'),
    'nothing outside the DAV flow was requested',
  );
});

test('malformed discovery XML reports a failure instead of an empty calendar', async (t) => {
  const mock = await startServer({
    'PROPFIND *': '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/broken/',
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /incomplete calendar discovery/i);
});

test('an oversized response is refused before it is buffered', async (t) => {
  const mock = await startServer({
    'PROPFIND *': { status: 207, headers: { 'content-length': String(64 * 1024 * 1024) }, body: '' },
  });
  t.after(() => mock.close());

  const result = await testConnection({ url: mock.origin, user: USER, pass: PASS });
  assert.equal(result.ok, false);
  assert.match(result.error, /too large/);
});

test('a 207 whose body never finishes is abandoned at the deadline', async (t) => {
  // The trap this guards: fetch() resolves as soon as the headers arrive, so a
  // deadline torn down at that moment leaves the body read unbounded — a
  // server that sends "207, <?xml" and then goes silent used to hang the
  // whole sweep forever.
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
      res.write('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">');
      // ...and nothing more, ever.
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });

  // The race is the assertion: with the old behaviour testConnection never
  // settles, and only the sentinel comes back.
  let sentinel;
  const result = await Promise.race([
    testConnection({ url: `http://127.0.0.1:${server.address().port}`, user: USER, pass: PASS, timeoutMs: 300 }),
    new Promise((resolve) => {
      sentinel = setTimeout(() => resolve('hung'), 5000);
    }),
  ]);
  clearTimeout(sentinel);

  assert.notEqual(result, 'hung', 'the stalled body must be abandoned, not awaited forever');
  assert.equal(result.ok, false);
  assert.match(result.error, /within 300ms/);
});

test('a chunked body past the size cap is cut off with "too large"', async (t) => {
  // No content-length header, so the pre-flight check cannot catch it: the cap
  // has to be enforced while the body streams. The server sends well past the
  // cap and then goes quiet without ever finishing — a client that only checks
  // size after buffering the whole body never gets a whole body to check, so
  // the streaming check is the only thing that can end this request.
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0x61);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/.well-known/caldav') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
      res.on('error', () => {}); // the client is expected to hang up on us
      let sent = 0;
      const pump = () => {
        while (sent < 48 * 1024 * 1024 && res.writable) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        // ...and then silence: the response is never ended.
      };
      pump();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });

  let sentinel;
  const result = await Promise.race([
    testConnection({
      url: `http://127.0.0.1:${server.address().port}`,
      user: USER,
      pass: PASS,
      timeoutMs: 15000,
    }),
    new Promise((resolve) => {
      sentinel = setTimeout(() => resolve('hung'), 10000);
    }),
  ]);
  clearTimeout(sentinel);

  assert.notEqual(result, 'hung', 'the cap must trip mid-stream, not after a body that never completes');
  assert.equal(result.ok, false);
  assert.match(result.error, /too large/);
});

/* ------------------------------------------------------------------ *
 * The password over plain http://
 *
 * QA, 2026-10-10, TT-3425. `basicAuth` put the username and password on every
 * request to the typed origin, and an account typed as `http://` sent them
 * that way — readable — on every sweep, with nothing anywhere to stop it or say
 * so. Mail's `requireTls` rule now applies, read off the calendar's own
 * `requireTls`, and it is applied before the first request: these tests stub
 * `fetch` and assert it was never called, on a `.test` host that could not be
 * reached anyway.
 * ------------------------------------------------------------------ */

/** A `fetch` that records and refuses, so "never called" is checkable and nothing leaves. */
function stubFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input?.url ?? input), auth: init.headers?.Authorization ?? null });
    throw new Error('stubbed: no network in this test');
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

test('a username on a plain http:// address is refused before any request, by every entry point', async (t) => {
  const calls = stubFetch(t);
  const url = 'http://cal.example.test/dav/';

  for (const pass of [PASS, '', null]) {
    // An empty password still sends `Basic nemo:` — a header naming the
    // account — so the trigger is the username, not the pair.
    await assert.rejects(() => discover({ url, user: USER, pass }), (err) => {
      assert.equal(err.cleartextRefused, true);
      assert.equal(err.host, 'cal.example.test');
      assert.match(err.message, /^Zelos stopped before your calendar password left this machine: cal\.example\.test is a plain http:\/\/ address\./);
      return true;
    });
    await assert.rejects(() => fetchRange({ url, user: USER, pass }), { cleartextRefused: true });
    const probed = await testConnection({ url, user: USER, pass });
    assert.equal(probed.ok, false);
    assert.equal(probed.cleartextRefused, true, 'the Test route and the doctor branch on this flag');
    assert.match(probed.error, /Let this one server take it unencrypted/);
  }
  // `requireTls: true` is "decide from the host" made strict — still refused.
  await assert.rejects(() => discover({ url, user: USER, pass: PASS, requireTls: true }), { cleartextRefused: true });

  assert.deepEqual(calls, [], 'a request was made — the password was on the wire before the refusal');
});

test('a remembered layout cannot carry a refused account past the check', async (t) => {
  // fetchRange can reach a REPORT without calling discover at all, once the
  // layout is cached, so it checks for itself. Prime the cache under the
  // permission, then take the permission away.
  const mock = await startServer(NEXTCLOUD_ROUTES);
  t.after(() => mock.close());
  const url = mock.origin; // http://127.0.0.1 — loopback, allowed by default
  const window = { from: '2026-08-01T00:00:00Z', to: '2026-11-30T00:00:00Z' };
  await fetchRange({ url, user: USER, pass: PASS, ...window });
  const before = mock.requests.length;
  assert.ok(before > 0);

  await assert.rejects(() => fetchRange({ url, user: USER, pass: PASS, requireTls: true, ...window }), { cleartextRefused: true });
  assert.equal(mock.requests.length, before, 'the cached layout was used to send the password anyway');
});

test('requireTls: false lets one http:// server take it; loopback and no username need nothing', async (t) => {
  const calls = stubFetch(t);

  // Each of these reaches `fetch` — the stub refuses it, so the walk fails
  // with "could not reach", which is the point: it was allowed to try.
  const allowed = [
    { url: 'http://cal.example.test/dav/', user: USER, pass: PASS, requireTls: false },
    { url: 'http://localhost:5232/', user: USER, pass: PASS },
    { url: 'http://[::1]:5232/', user: USER, pass: PASS },
    { url: 'http://cal.example.test/dav/', user: '', pass: '' },
    { url: 'https://cal.example.test/dav/', user: USER, pass: PASS, requireTls: true },
  ];
  for (const opts of allowed) {
    const before = calls.length;
    const result = await testConnection(opts);
    assert.equal(result.ok, false);
    assert.equal(result.cleartextRefused, undefined, JSON.stringify(opts));
    assert.ok(calls.length > before, `${JSON.stringify(opts)} was refused, and should have been tried`);
  }
});
