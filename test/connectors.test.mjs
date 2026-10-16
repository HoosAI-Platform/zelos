/**
 * test/connectors.test.mjs — the seam, and one connector written against it.
 *
 * Two things are being proved here and they are different things.
 *
 * THE SEAM. That `core/connectors/index.mjs` is what config validation and the
 * run loop actually read, rather than a second hardcoded list sitting beside the
 * ones that were there before. The strongest available proof is a source type
 * that did not exist when the run loop was written — `rss`, in `config.sources`,
 * a config key nothing read a week ago — arriving on the board with no branch
 * anywhere in core/sweep.mjs naming it. If the sweep still held a list, that
 * source would be invisible.
 *
 * THE CONNECTOR. RSS was chosen for the proof because it needs no credential and
 * no vendor account: every test below runs against a real HTTP server on
 * 127.0.0.1 with no secret store involved. A contract that were awkward for a
 * source this plain would be the wrong contract.
 *
 * The secret backend is forced anyway. Nothing here reaches core/secrets.mjs —
 * the feed has no credential — but `runSweep` resolves `getSecret` from
 * DEFAULT_DEPS unless a test replaces it, and a test that forgot to would
 * otherwise read the operator's own login keychain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ZELOS_LOG_LEVEL = 'silent';
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-connectors-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { open, close, migrate, listMessages, upsertMessages, getKV, setKV } = await import('../core/db.mjs');
const { runSweep } = await import('../core/sweep.mjs');
const registry = await import('../core/connectors/index.mjs');
const {
  assertShape, describe: describeAll, enabledSources, unknownSources,
  get: connectorFor, originsFor, sourceCursorKey, sourceStateKey, typesFor,
} = registry;
const {
  AuthError, RateLimitError, createHttp, createMeter, parseRetryAfter, originOf, secretHash,
} = await import('../core/connectors/http.mjs');
const { parseFeed } = await import('../core/connectors/rss.mjs');
const { fetchIcsText } = await import('../core/connectors/ics.mjs');
const { validateConfig, SECRET_KEYS } = await import('../core/config.mjs');

let seq = 0;
const openDbs = [];
const servers = [];

function fresh() {
  const db = open(path.join(HOME_ROOT, `c${seq++}.db`));
  migrate(db);
  openDbs.push(db);
  return db;
}

test.after(async () => {
  for (const db of openDbs) close(db);
  for (const server of servers) await new Promise((r) => server.close(r));
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const RSS_TWO = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Alder &amp; Vance Notices</title>
  <link>https://alder.example/</link>
  <item>
    <title>Retainage schedule posted</title>
    <link>https://alder.example/notices/retainage</link>
    <guid isPermaLink="false">alder-2026-08-09-retainage</guid>
    <pubDate>Sun, 09 Aug 2026 14:02:00 +0000</pubDate>
    <description><![CDATA[<p>The <b>retainage</b> schedule for Q3 is posted.</p>]]></description>
  </item>
  <item>
    <title>Pre-con moved to Thursday</title>
    <link>https://alder.example/notices/precon</link>
    <guid isPermaLink="false">alder-2026-08-10-precon</guid>
    <pubDate>Mon, 10 Aug 2026 08:30:00 +0000</pubDate>
    <description>Bring the schedule of values.</description>
  </item>
</channel></rss>`;

const ATOM_ONE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Vance Engineering</title>
  <link rel="self" href="https://vance.example/feed.xml"/>
  <link rel="alternate" href="https://vance.example/"/>
  <entry>
    <title>Stamped drawings are out</title>
    <link rel="enclosure" href="https://vance.example/drawings.pdf"/>
    <link rel="alternate" href="https://vance.example/posts/stamped"/>
    <id>tag:vance.example,2026:post/41</id>
    <updated>2026-08-10T13:00:00Z</updated>
    <author><name>Dana Vance</name></author>
    <summary>Sheets A1 through A9 are stamped and uploaded.</summary>
  </entry>
</feed>`;

/**
 * A feed server whose behaviour each test dictates.
 *
 * `handler` gets `(req, res, hits)` and may answer however it likes; the default
 * serves `body` with an ETag, which is what makes the conditional-request tests
 * possible without a second server.
 *
 * Closed in the TEST's `after`, not the file's, and that is not tidiness. Every
 * one of these binds an ephemeral port, node:test runs the suite's files in
 * parallel, and test/server.test.mjs asserts that a server offered a busy port
 * lands on exactly `busy + 1`. Holding a dozen listeners open for the length of
 * this file made that assertion fail roughly one run in four — a real defect in
 * a test that had been stable, caused entirely by a neighbour. One or two live
 * listeners at a time is what every other file in the suite costs.
 */
async function feedServer(t, { body = RSS_TWO, etag = null, handler = null } = {}) {
  let hits = 0;
  const seenHeaders = [];
  const server = http.createServer((req, res) => {
    hits += 1;
    seenHeaders.push({ ...req.headers });
    if (handler) { handler(req, res, hits); return; }
    if (etag && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml', ...(etag ? { etag } : {}) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  if (t && typeof t.after === 'function') {
    t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  } else {
    servers.push(server);
  }
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/feed.xml`,
    hits: () => hits,
    headers: () => seenHeaders,
  };
}

function baseConfig(over = {}) {
  return {
    version: 1,
    identity: { name: 'Nemo Hale', email: 'nemo@example.com', timezone: 'UTC' },
    model: {
      protocol: 'openai',
      label: 'Test model',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'test-model',
      keyRef: 'model.default',
      maxTokens: 4096,
      temperature: 0,
    },
    mail: [],
    calendars: [],
    sources: [],
    sweep: { intervalMinutes: 30, activeHours: [0, 23], auto: true },
    ui: { accent: '#5b8cff' },
    privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
    ...over,
  };
}

const feedSource = (over = {}) => ({
  id: 's_feed',
  enabled: true,
  label: 'Alder notices',
  type: 'rss',
  keyRef: null,
  settings: { url: '', maxItems: 50 },
  ...over,
});

/** Light mode and no secrets: these tests are about the fetch, not the model. */
const sweepDeps = { getSecret: async () => null };

/* ================================================================== *
 * The registry is what the sweep and config actually read
 * ================================================================== */

test('the calendar kinds config validates are the ones the registry offers', () => {
  /* Two lists that must agree, guarded the way this repo already guards the
     route table: the value is parsed out of the source rather than restated
     here, so a third copy cannot appear in the test and quietly become the
     thing being compared. core/config.mjs cannot import the registry — it is
     imported BY core/sources/caldav.mjs, so the edge back would be a cycle one
     eager paths() away from a TDZ crash at launch — so this cross-check is what
     is paid instead. */
  const src = fs.readFileSync(path.join(ROOT, 'core/config.mjs'), 'utf8');
  const m = /const CALENDAR_KINDS = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'CALENDAR_KINDS is no longer declared as a literal array in core/config.mjs');
  const kinds = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

  assert.deepEqual(typesFor('calendars'), kinds,
    'config validates a set of calendar kinds the registry does not offer, or the other way round');
});

test('core/sweep.mjs no longer decides anything from a source kind', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core/sweep.mjs'), 'utf8');
  // The two comparisons the unified loop replaced. Either one coming back means
  // the registry has become decoration.
  assert.doesNotMatch(src, /calendar\.kind === '(?:file|caldav|ics)'/,
    'the run loop is branching on a calendar kind again');
  assert.doesNotMatch(src, /config\.mail\s*:\s*\[\]\)\.filter/,
    'the run loop is filtering config.mail itself again instead of asking the registry');
  assert.match(src, /enabledSources\(config\)/, 'the run loop no longer asks the registry what to read');
});

test('enabledSources reads all three places config keeps a source, and drops what names nothing', () => {
  const config = baseConfig({
    mail: [{ id: 'm_1', enabled: true, host: 'imap.example.com' }],
    calendars: [
      { id: 'c_1', enabled: true, kind: 'ics', url: 'https://x.example/a.ics' },
      { id: 'c_off', enabled: false, kind: 'ics', url: 'https://x.example/b.ics' },
      { id: 'c_junk', enabled: true, kind: 'runes', url: 'https://x.example/c.ics' },
    ],
    sources: [
      { id: 's_1', enabled: true, type: 'rss', settings: { url: 'https://x.example/feed' } },
      { id: 's_junk', enabled: true, type: 'nostromo', settings: {} },
    ],
  });

  /* An unrecognised CALENDAR kind falls back to the .ics reader; an
     unrecognised `sources[]` type is dropped. The asymmetry is deliberate and
     it is the behaviour this replaced: the old `defaultFetchEvents` tested
     `=== 'file'`, then `=== 'caldav'`, and let everything else reach
     `fetchIcsText`, so `kind: 'webcal'` produced a real row — events if the URL
     served a calendar, a named error in the Now banner if it did not.

     Dispatching strictly instead made the row VANISH: a calendar the user can
     see in Settings, contributing nothing, with nothing anywhere saying why.
     The registry does have the right answer for that — `unknownSources()` —
     which had no production reader when this was written.

     IT HAS ONE NOW: core/doctor.mjs reads it and names every entry no connector
     claims, asserted in test/connector-seam.test.mjs. So the condition this
     comment set has been met and the fallback below is the LAST thing standing
     between here and a strict dispatch. It is still asserted as a fallback
     because the change belongs in its own diff: the assertion, the comment
     above it and core/connectors/index.mjs's own note all move together, and
     folding that into the pass that built the reader would make both
     unreviewable.

     A generic `sources[]` entry is different: there is no sensible default
     reader for a type nobody claims, so it is dropped and reported. */
  assert.deepEqual(
    enabledSources(config).map(({ connector, source }) => [connector.type, source.id]),
    [['imap', 'm_1'], ['ics', 'c_1'], ['ics', 'c_junk'], ['rss', 's_1']],
  );

  // Dropped rather than thrown on: core/config.mjs:236-238 is explicit that a
  // hand-edited typo must not brick the app that exists to report the typo.
  assert.deepEqual(
    unknownSources(config).map((u) => [u.at, u.id, u.type]),
    [['calendars', 'c_junk', 'runes'], ['sources', 's_junk', 'nostromo']],
  );
});

test('a null entry in config.mail is skipped, not thrown on mid-sweep', () => {
  /* REGRESSION. `enabledSources`'s guard was `source?.enabled !== false`, which
     is TRUE for null — so a null entry produced `{connector, source: null}`, the
     host read `source.label` off it, and the rejection escaped both
     `Promise.all` and `runSweep`. `finish()` then never ran, leaving the `runs`
     row `startRun` opened unfinished: a board showing a sweep that is still
     going and never will be. The old `isEnabled` opened with `!!x`.

     `normalizeAccounts` filters non-objects, so production reaches this only
     through an injected config — which is exactly what the desktop shell's
     documented `deps` seam is. */
  const config = baseConfig({
    mail: [null, { id: 'm_1', enabled: true, host: 'imap.example.com' }],
    calendars: [null],
    sources: [null],
  });
  assert.deepEqual(
    enabledSources(config).map(({ connector, source }) => [connector.type, source.id]),
    [['imap', 'm_1']],
  );
});

test('a source type that did not exist when the run loop was written reaches the board', async (t) => {
  const db = fresh();
  const feed = await feedServer(t);
  const result = await runSweep({
    db,
    config: baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] }),
    mode: 'light',
    deps: sweepDeps,
  });

  assert.equal(result.ok, true);
  const entry = result.stats.sources.find((s) => s.kind === 'rss');
  assert.ok(entry, `no rss source was reported: ${JSON.stringify(result.stats.sources)}`);
  assert.equal(entry.ok, true);
  assert.equal(entry.count, 2);
  assert.equal(entry.label, 'Alder notices', 'a source with one part carries the plain label, with no separator');
  assert.equal(result.stats.messages, 2);

  const stored = listMessages(db);
  assert.deepEqual(stored.map((m) => m.subject).sort(), ['Pre-con moved to Thursday', 'Retainage schedule posted']);
  assert.equal(stored[0].source_id, 's_feed', 'the host stamps the source id, not the connector');
  assert.equal(stored[0].folder, 'Alder & Vance Notices', 'the feed title becomes the folder');
});

/* ================================================================== *
 * Isolation — a connector failing costs its own row and nothing else
 * ================================================================== */

test('one failing feed is isolated to its own sources[] entry', async (t) => {
  const db = fresh();
  const good = await feedServer(t);
  const dead = await feedServer(t, {
    handler: (req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); },
  });

  const result = await runSweep({
    db,
    config: baseConfig({
      sources: [
        feedSource({ id: 's_good', label: 'Good feed', settings: { url: good.url } }),
        feedSource({ id: 's_dead', label: 'Dead feed', settings: { url: dead.url } }),
      ],
    }),
    mode: 'light',
    deps: sweepDeps,
  });

  assert.equal(result.ok, true, 'the run still produced a board');
  const byId = Object.fromEntries(result.stats.sources.map((s) => [s.id, s]));
  assert.equal(byId.s_good.ok, true);
  assert.equal(byId.s_good.count, 2);
  assert.equal(byId.s_dead.ok, false);
  assert.equal(byId.s_dead.count, 0);
  assert.match(byId.s_dead.error, /500/, `the failure must name what failed, got: ${byId.s_dead.error}`);
  assert.equal(result.stats.sourcesOk, 1);
  assert.equal(result.stats.sourcesFailed, 1);
  assert.equal(listMessages(db).length, 2, 'what did arrive was stored');
});

test('a mail account and a feed fail independently of each other', async (t) => {
  const db = fresh();
  const feed = await feedServer(t);
  const result = await runSweep({
    db,
    config: baseConfig({
      mail: [{
        id: 'm_1', enabled: true, label: 'Work', host: 'imap.example.com', port: 993, secure: true,
        user: 'nemo@example.com', keyRef: 'mail.m_1', mailboxes: ['INBOX'], sentMailbox: 'Sent',
        lookbackDays: 14, maxMessages: 400,
      }],
      sources: [feedSource({ settings: { url: feed.url } })],
    }),
    mode: 'light',
    // No password for the mail account; the feed does not need one.
    deps: { getSecret: async () => null },
  });

  const mail = result.stats.sources.filter((s) => s.kind === 'mail');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].ok, false);
  assert.match(mail[0].error, /No password stored for Work/,
    'the sentence a user reads at 07:00 must survive the unified loop word for word');
  const rss = result.stats.sources.find((s) => s.kind === 'rss');
  assert.equal(rss.ok, true);
  assert.equal(rss.count, 2);
});

/* ================================================================== *
 * The cursor, and the property the ordering buys
 * ================================================================== */

test("a connector's cursor survives a run and is handed back to it", async (t) => {
  const db = fresh();
  const feed = await feedServer(t, { etag: '"v1"' });
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  const first = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(first.stats.sources[0].count, 2);
  assert.deepEqual(JSON.parse(getKV(db, sourceCursorKey('s_feed'))), { etag: '"v1"', lastModified: null, url: feed.url });

  const second = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(feed.headers()[1]['if-none-match'], '"v1"',
    'the stored cursor was not sent back, so the feed was re-read in full');
  assert.equal(second.stats.sources[0].ok, true, 'a 304 is a successful read of nothing, not a failure');
  assert.equal(second.stats.sources[0].count, 0);
  assert.equal(listMessages(db).length, 2, 'and nothing was duplicated');
  assert.deepEqual(JSON.parse(getKV(db, sourceCursorKey('s_feed'))), { etag: '"v1"', lastModified: null, url: feed.url },
    'a 304 must keep the cursor, or the next sweep re-reads everything');
});

test('a crash between the fetch and the store leaves the cursor where it was', async (t) => {
  const db = fresh();
  const feed = await feedServer(t, { etag: '"v1"' });
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  /* The persist is made to fail for real rather than mocked: `upsertMessage`
     prepares a statement against `messages`, so a database without that table
     throws from exactly where a disk error would. This is the window §5 of the
     design exists to close — a cursor advanced before the upsert loses those
     rows forever, because the connector comes back next sweep asking for
     everything AFTER a page that was never stored. */
  db.exec('DROP TABLE messages');

  const result = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not store what was fetched/);
  assert.equal(getKV(db, sourceCursorKey('s_feed')), null,
    'the cursor advanced past rows that were never stored — those entries are lost forever');
});

test('a cursor larger than the ceiling is refused rather than stored', async (t) => {
  const db = fresh();
  /* 8 KB of URL. Nothing legitimate does this; a connector caching a page of
     results in its cursor does, and that is a second message store with no
     index, no search and no cleanup. The address is the one part of its cursor
     the rss connector's own trim cannot give up — an 8 KB ETag it now trims to
     fit (the validators-last trim has its own test) — so this is what still
     proves the sweep-side ceiling holds whatever a connector returns. */
  const feed = await feedServer(t, { etag: '"v1"' });
  const config = baseConfig({
    sources: [feedSource({ settings: { url: `${feed.origin}/${'x'.repeat(8192)}/feed.xml` } })],
  });

  const result = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(result.ok, true, 'an oversized cursor is not a reason to fail the run');
  assert.equal(result.stats.sources[0].count, 2, 'nor a reason to lose the rows');
  assert.equal(getKV(db, sourceCursorKey('s_feed')), null);
});

/* ================================================================== *
 * A refused credential, and a source that is deliberately resting
 * ================================================================== */

/* A GitHub source pointed at a loopback "Enterprise" server: the connector
   sends a real token, which is what a refused CREDENTIAL needs. A feed sends
   none, and is the test after these two (TT-3459). */
const githubSource = (apiBase) => ({
  id: 's_gh', enabled: true, label: 'GitHub', type: 'github', keyRef: 'source.s_gh', settings: { apiBase },
});
const tokenDeps = (token) => ({ getSecret: async () => token });
/** GitHub keeps a minimum gap between polls; age the last one so the next sweep is due. */
const dueAgain = (db, id) => {
  const state = JSON.parse(getKV(db, sourceStateKey(id)) || '{}');
  setKV(db, sourceStateKey(id), JSON.stringify({ ...state, lastAt: 0, lastOkAt: 0 }));
};

test('a refused credential rests the source, and the rest is on every run record until it lifts', async (t) => {
  const db = fresh();
  const api = await feedServer(t, {
    handler: (req, res) => { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('nope'); },
  });
  const config = baseConfig({ sources: [githubSource(api.origin)] });

  const first = await runSweep({ db, config, mode: 'light', deps: tokenDeps('ghp_old') });
  assert.equal(first.stats.sources.length, 1);
  assert.equal(first.stats.sources[0].ok, false);
  assert.match(first.stats.sources[0].error, /refused the token/);
  const state = JSON.parse(getKV(db, sourceStateKey('s_gh')));
  assert.ok(state.authBlockedUntil > Date.now(), 'nothing recorded that the credential was refused');

  dueAgain(db, 's_gh');
  const second = await runSweep({ db, config, mode: 'light', deps: tokenDeps('ghp_old') });
  assert.equal(api.hits(), 1, 'the sweep asked again with the credential the host just refused');
  /* A red row — not silence, and not a green one. `{ok: true, count: 0}` would
     inflate stats.sourcesOk — a number three files consume — with a source that
     was never read. Silence was the first design, on the argument that a red
     banner forty-seven times a day is noise for a source deliberately resting;
     but nothing outside core/sweep.mjs reads `source.<id>.state`, so silence
     meant a revoked token was red for one sweep and then a quiet day for the
     remaining five and a half hours of every block. A refused credential is
     the user's to fix and the row stays until they do. The rate-limit rest
     below stays silent, because that one fixes itself. */
  assert.equal(second.stats.sources.length, 1, 'the resting source vanished from the run record');
  assert.equal(second.stats.sources[0].ok, false);
  assert.equal(second.stats.sources[0].count, 0);
  assert.match(second.stats.sources[0].error, /not trying it again until .* or as soon as you sign in again or enter a new one/);
  assert.equal(second.stats.sourcesOk, 0);
  assert.equal(second.stats.sourcesFailed, 1);
});

test('changing the stored credential releases the block immediately', async (t) => {
  const db = fresh();
  const api = await feedServer(t, {
    handler: (req, res, hits) => {
      if (hits === 1) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    },
  });
  const config = baseConfig({ sources: [githubSource(api.origin)] });

  await runSweep({ db, config, mode: 'light', deps: tokenDeps('ghp_old') });
  // The user pastes a different token. The block is keyed on WHICH credential
  // was refused, not on a flag, because that is the real shape of the failure:
  // somebody rotates a token and the six-hour wait must not apply to the new one.
  dueAgain(db, 's_gh');
  const second = await runSweep({ db, config, mode: 'light', deps: tokenDeps('ghp_new') });
  assert.equal(api.hits(), 2);
  assert.equal(second.stats.sources[0].ok, true, second.stats.sources[0].error);
});

test('a feed that answers 401 or 403 is not told about a credential, and is not rested (TT-3459)', async (t) => {
  /* QA, 2026-10-10: any 401 or 403 became an AuthError, so a feed — which has
     no credential — was told "rejected the credential … check it in Settings"
     beside an Edit form that says it needs none, and rested six hours until a
     secret that does not exist changed. After its address was corrected, the
     next check never asked the new one. */
  const db = fresh();
  for (const status of [401, 403]) {
    const feed = await feedServer(t, {
      handler: (req, res, hits) => {
        if (hits === 1) { res.writeHead(status); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        res.end(RSS_TWO);
      },
    });
    const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

    const first = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
    assert.equal(first.stats.sources[0].ok, false);
    assert.doesNotMatch(first.stats.sources[0].error, /credential/i, `a ${status} was blamed on a credential`);
    assert.match(first.stats.sources[0].error, new RegExp(`refused to serve this address \\(${status}\\).*check the address`));
    const state = JSON.parse(getKV(db, sourceStateKey('s_feed')) || '{}');
    assert.ok(!(state.authBlockedUntil > Date.now()), `a ${status} rested a source that has no credential`);

    const second = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
    assert.equal(feed.hits(), 2, 'the next check did not ask again');
    assert.equal(second.stats.sources[0].ok, true);
  }

  // A feed rested by the old rule, before an upgrade, is not kept resting: its
  // secret is always null, so nothing the user does could lift it.
  const feed = await feedServer(t);
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });
  setKV(db, sourceStateKey('s_feed'), JSON.stringify({ authBlockedUntil: Date.now() + 6 * 3_600_000, secretHash: secretHash(null) }));
  const resting = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(feed.hits(), 1, 'a feed rested before the upgrade was still not asked');
  assert.equal(resting.stats.sources[0].ok, true);

  // And the leftover rest is cleared even when that read fails, so Settings
  // stops offering "can retry after…" and Check all connections comes back.
  const broken = await feedServer(t, { handler: (req, res) => { res.writeHead(404); res.end(); } });
  const brokenConfig = baseConfig({ sources: [feedSource({ settings: { url: broken.url } })] });
  setKV(db, sourceStateKey('s_feed'), JSON.stringify({ authBlockedUntil: Date.now() + 6 * 3_600_000, secretHash: secretHash(null) }));
  const failed = await runSweep({ db, config: brokenConfig, mode: 'light', deps: sweepDeps });
  assert.equal(failed.stats.sources[0].ok, false);
  const { readSourceStatus } = await import('../core/source-status.mjs');
  const row = readSourceStatus(db, brokenConfig).find((r) => r.id === 's_feed');
  assert.ok(row, 'no status row for the feed');
  assert.equal(row.retryAt ?? null, null, `a stale rest still holds the feed until ${row.retryAt}`);
});

test('a stated rate limit rests the source until the moment the host named', async (t) => {
  const db = fresh();
  const feed = await feedServer(t, {
    handler: (req, res) => { res.writeHead(429, { 'retry-after': '3600' }); res.end(); },
  });
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  const first = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(first.stats.sources[0].ok, false);
  assert.match(first.stats.sources[0].error, /rate limiting/);
  const state = JSON.parse(getKV(db, sourceStateKey('s_feed')));
  assert.ok(state.notBefore - Date.now() > 3_000_000, `Retry-After was not honoured: ${state.notBefore - Date.now()}ms`);

  const second = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(feed.hits(), 1);
  assert.deepEqual(second.stats.sources, []);
});

/* ================================================================== *
 * The row identity trap, measured
 * ================================================================== */

test('a feed row carries no uid at all, and a second sweep inserts nothing', async (t) => {
  const db = fresh();
  const feed = await feedServer(t);
  const config = baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] });

  const first = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  assert.equal(first.stats.newMessages, 2);

  const second = await runSweep({ db, config, mode: 'light', deps: sweepDeps });
  /* The whole point. core/db.mjs:384 reads
     `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` becomes
     0 and an OMITTED uid becomes null — two different messageRowIds for one
     entry. A connector that drifts between the two re-inserts every row it has
     ever seen on every sweep, forever: newMessages never settles, shouldRunFull
     forces a full run every time, and the user is billed for a model call every
     thirty minutes. */
  assert.equal(second.stats.newMessages, 0, 'the same entries were inserted a second time');
  assert.equal(listMessages(db).length, 2);
  assert.equal(listMessages(db)[0].uid, null, 'a uid appeared where the connector emitted none');
});

test('the RSS connector is a pure function of its ctx — no db, no server, no secret store', async (t) => {
  const rss = connectorFor('rss');
  const feed = await feedServer(t, { body: ATOM_ONE });
  const emitted = [];
  const ctx = {
    source: { id: 's_1', settings: { url: feed.url } },
    label: 'Vance',
    secret: null,
    cursor: null,
    window: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: '2026-08-11T09:00:00Z',
    emit: (message, done, total) => emitted.push([message, done, total]),
    signal: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: createHttp({ origins: [feed.origin], limits: rss.limits }),
    deps: {},
  };

  const r = await rss.collect(ctx);
  assert.equal(r.parts.length, 1);
  const row = r.parts[0].rows[0];
  assert.equal(r.parts[0].rows.length, 1);
  assert.equal(row.messageId, 'tag:vance.example,2026:post/41');
  assert.ok(!('uid' in row), 'a uid key must never appear on a row with no integer identity');
  assert.equal(row.subject, 'Stamped drawings are out');
  assert.equal(row.from.name, 'Dana Vance');
  assert.equal(row.direction, 'in');
  assert.match(row.date, /^2026-08-10T13:00/);
  assert.match(row.snippet, /Sheets A1 through A9/);
  assert.deepEqual(emitted, [['Vance: 1 entries', 1, 1]]);
});

test('parseFeed reads what a feed means, not what its markup says', () => {
  const rss = parseFeed(RSS_TWO);
  assert.equal(rss.title, 'Alder & Vance Notices', 'entities are decoded');
  assert.equal(rss.entries.length, 2);
  assert.equal(rss.entries[0].id, 'alder-2026-08-09-retainage');
  assert.equal(rss.entries[0].body, 'The retainage schedule for Q3 is posted.',
    'CDATA is a quoting device and the HTML inside it is markup, not text');

  const atom = parseFeed(ATOM_ONE);
  assert.equal(atom.title, 'Vance Engineering', 'the channel title, not the first entry title');

  /* A channel with no title of its own. Taking the first <title> in the
     document would name the feed after whatever article happens to be at the
     top of it today — so the folder every stored row is filed under would
     change on the publisher's schedule, and the board would show one source as
     several. Nothing is the right answer here; the caller falls back to the
     host the user typed. */
  const headless = parseFeed('<rss><channel><link>https://x.example/</link>'
    + '<item><title>Whatever is at the top today</title><guid>g1</guid></item></channel></rss>');
  assert.equal(headless.title, '');
  assert.equal(headless.entries[0].title, 'Whatever is at the top today');
  assert.equal(atom.entries[0].link, 'https://vance.example/posts/stamped',
    'rel="enclosure" is a media file and rel="self" is the feed; neither is the article');

  // A commented-out <item> is a real thing in a hand-edited feed and is not an entry.
  assert.equal(parseFeed('<rss><channel><title>T</title><!-- <item><title>X</title></item> --></channel></rss>').entries.length, 0);
  // Nothing here should ever throw on a stranger's XML.
  for (const junk of ['', '<not xml', null, undefined, '<rss><channel>']) {
    assert.deepEqual(parseFeed(junk).entries, [], JSON.stringify(junk));
  }
});

test('REGRESSION: an Atom author with a uri or email is sent by their name alone', () => {
  /* The whole <author> element was read as text, so a person construct with a
     <uri> became the sender "Ines Calder http://…/ines". */
  const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>'
    + '<entry><id>e1</id><author><name>Ines Calder</name><uri>https://calder.example/ines</uri>'
    + '<email>ines@calder.example</email></author></entry>'
    + '<entry><id>e2</id><author>\n  <uri>https://calder.example/</uri>\n  <name>Kit Alder</name>\n</author></entry>'
    + '</feed>');
  assert.equal(atom.entries[0].author, 'Ines Calder');
  assert.equal(atom.entries[1].author, 'Kit Alder', 'the name is found wherever it sits in the construct');

  // RSS's <author> is plain text and <dc:creator> a name; both read as before.
  const rss = parseFeed('<rss><channel><item><guid>g1</guid><author>dana@vance.example (Dana Vance)</author></item>'
    + '<item><guid>g2</guid><dc:creator><![CDATA[Nemo Hale]]></dc:creator><author>x@y.example</author></item>'
    + '</channel></rss>');
  assert.equal(rss.entries[0].author, 'dana@vance.example (Dana Vance)');
  assert.equal(rss.entries[1].author, 'Nemo Hale');
});

test('REGRESSION: entity-encoded HTML in a feed reaches the AI as text, not markup', () => {
  /* RSS 2.0's own form for markup in a description is entity-encoded HTML, and
     Atom's type="html" is the same. textOf stripped tags first and decoded
     second, so `&lt;b&gt;cash&lt;/b&gt;` came out as `<b>cash</b>` — the model
     was shown the markup, the stored row kept it, and a search for a word only
     the markup contained ("strong") found the entry. */
  const rss = parseFeed('<rss><channel><title>T</title><item><guid>g1</guid>'
    + '<title>Fish &amp;amp; chips &lt;b&gt;Friday&lt;/b&gt;</title>'
    + '<description>Bring &lt;strong&gt;cash&lt;/strong&gt; &amp;amp; a mug. '
    + '&lt;a href=&quot;https://x.example/menu&quot;&gt;Menu&lt;/a&gt;</description>'
    + '</item></channel></rss>');
  assert.equal(rss.entries[0].title, 'Fish & chips Friday');
  assert.equal(rss.entries[0].body, 'Bring cash & a mug. Menu');
  assert.doesNotMatch(rss.entries[0].body, /strong|href|</, 'the markup reached the body');

  const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>e1</id>'
    + '<content type="html">&lt;p&gt;Pour is &lt;em&gt;Tuesday&lt;/em&gt;, 5 &amp;lt; 6&lt;/p&gt;</content>'
    + '</entry></feed>');
  assert.equal(atom.entries[0].body, 'Pour is Tuesday, 5 < 6',
    'an escaped `&lt;` inside the HTML is a character, not a tag');

  /* CDATA is already the HTML, so it is decoded once, as HTML: `&amp;lt;` inside
     it is the HTML for the literal text "&lt;", and decoding it twice would make
     a tag the publisher escaped on purpose. And
     Atom's xhtml content, real elements in the XML, still reads as before. */
  const cdata = parseFeed('<rss><channel><item><guid>g2</guid>'
    + '<description><![CDATA[<p>Use &amp;lt;b&amp;gt; for bold</p>]]></description></item></channel></rss>');
  assert.equal(cdata.entries[0].body, 'Use &lt;b&gt; for bold');
  const xhtml = parseFeed('<feed><entry><id>e2</id><content type="xhtml">'
    + '<div xmlns="http://www.w3.org/1999/xhtml"><p>Cash &amp; a <b>mug</b></p></div></content></entry></feed>');
  assert.equal(xhtml.entries[0].body, 'Cash & a mug');
});

test('decoding a feed\'s XML layer first does not cost text that only looks like markup', () => {
  /* The other side of the fix above. Once `&lt;` is decoded, "x&lt;y" is "x<y",
     and an unterminated `<y` used to read as a tag running to the end of the
     field — the rest of the title gone. */
  const rss = parseFeed('<rss><channel><title>Dev &lt; Ops</title><item><guid>g1</guid>'
    + '<title>Why x&lt;y and more</title>'
    + '<description>Revenue &lt;5% and before &lt;!-- not closed and after</description>'
    + '</item></channel></rss>');
  assert.equal(rss.title, 'Dev < Ops');
  assert.equal(rss.entries[0].title, 'Why x<y and more');
  assert.equal(rss.entries[0].body, 'Revenue <5% and before <!-- not closed and after');

  /* Atom says how to read its text. type="text" is the characters themselves,
     and in xhtml the elements are the markup while `&lt;` is text. */
  const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Use &lt;b&gt; for bold</title>'
    + '<entry><id>e1</id><title type="text">Returns List&lt;T&gt;</title>'
    + '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Use &lt;em&gt; for <b>emphasis</b></p></div></content>'
    + '</entry><entry><id>e2</id><summary type="text">a &amp;amp; b, &lt;i&gt;</summary></entry></feed>');
  assert.equal(atom.title, 'Use <b> for bold');
  assert.equal(atom.entries[0].title, 'Returns List<T>');
  assert.equal(atom.entries[0].body, 'Use <em> for emphasis');
  assert.equal(atom.entries[1].body, 'a &amp; b, <i>', 'text is decoded once, as XML, and never as HTML');

  // A `<` inside a quoted attribute value is valid HTML and belongs to its tag.
  const quoted = parseFeed('<rss><channel><item><guid>g1</guid><description>'
    + '&lt;a title=&quot;x&lt;y&quot; href=&quot;u&quot;&gt;Link&lt;/a&gt; after '
    + '&lt;button onclick=&quot;if(a&lt;b)go()&quot;&gt;Go&lt;/button&gt; end</description></item></channel></rss>');
  assert.equal(quoted.entries[0].body, 'Link after Go end');

  /* An Atom element with no `type` is text by RFC 4287, and is read as HTML on
     purpose: feeds that escape HTML there without saying so are real, and the
     other reading hands the model the markup. See textTypeOf. */
  const untyped = parseFeed('<feed><entry><id>e1</id><title>Bring &lt;b&gt;cash&lt;/b&gt;</title></entry></feed>');
  assert.equal(untyped.entries[0].title, 'Bring cash');
});

test('a feed\'s stray-`<` guard stays linear on input built to defeat it', () => {
  const unit = "'='a<a";
  const body = unit.repeat(Math.floor(512 * 1024 / unit.length)).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const started = performance.now();
  parseFeed(`<rss><channel><item><guid>g</guid><description>${body}</description></item></channel></rss>`);
  const ms = performance.now() - started;
  assert.ok(ms < 2_000, `512 KB took ${Math.round(ms)} ms — the scan has gone quadratic`);
});

test('REGRESSION: an escaped ampersand in a link is decoded, because it is a row identity', () => {
  /* Found by pointing this connector at NASA's real feed instead of a fixture.
     Two of ten entries came back as
     `https://www.nasa.gov/?post_type=image-article&#038;p=1036264` — the raw
     `&#038;` stored verbatim — because `&` is not legal raw in XML character
     data, so every feed MUST escape it, and a person writing a test fixture
     types a clean URL and never sees this.

     It is not cosmetic. The link is the `<guid>` fallback, so it becomes
     `messageId`, and `messageRowId` hashes it — if the publisher's escaping
     ever changes (`&#038;` to `&amp;`, or a CDN normalising on the way out) the
     same article hashes to a different row and arrives again as new. It is also
     `threadKey`, so one article can become two threads.

     All three spellings a feed may use, and a clean URL that must not be
     touched. */
  const xml = '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>'
    + '<item><title>numeric</title><link>https://x.example/?a=1&#038;b=2</link>'
    + '<guid>https://x.example/?a=1&#038;b=2</guid></item>'
    + '<item><title>named</title><link>https://x.example/?c=3&amp;d=4</link><guid>g-amp</guid></item>'
    + '<item><title>hex</title><link>https://x.example/?e=5&#x26;f=6</link><guid>g-hex</guid></item>'
    + '<item><title>clean</title><link>https://x.example/plain</link><guid>g-clean</guid></item>'
    + '</channel></rss>';

  const [numeric, named, hex, clean] = parseFeed(xml).entries;
  assert.equal(numeric.link, 'https://x.example/?a=1&b=2', 'a numeric reference survived into the link');
  assert.equal(numeric.id, 'https://x.example/?a=1&b=2', 'the guid is the row identity and it kept an entity');
  assert.equal(named.link, 'https://x.example/?c=3&d=4');
  assert.equal(hex.link, 'https://x.example/?e=5&f=6');
  assert.equal(clean.link, 'https://x.example/plain', 'a URL with nothing to decode was altered');

  // A reference that is not a character stays as written rather than becoming
  // a replacement character — better a visibly odd URL than a silently wrong one.
  const weird = parseFeed('<rss><channel><item><link>https://x.example/?z=&#xD800;</link></item></channel></rss>');
  assert.match(weird.entries[0].link, /&#xD800;/, 'a lone surrogate was decoded into something it is not');
});

test('a feed longer than the number the user chose is capped at it', async (t) => {
  const db = fresh();
  const items = Array.from({ length: 12 }, (_, i) =>
    `<item><title>Notice ${i}</title><guid>n-${i}</guid><pubDate>Mon, 10 Aug 2026 08:0${i % 10}:00 +0000</pubDate></item>`);
  const feed = await feedServer(t, { body: `<rss><channel><title>Long</title>${items.join('')}</channel></rss>` });

  const result = await runSweep({
    db,
    config: baseConfig({ sources: [feedSource({ settings: { url: feed.url, maxItems: 5 } })] }),
    mode: 'light',
    deps: sweepDeps,
  });
  assert.equal(result.stats.sources[0].count, 5, 'the connector honours the number the user chose');
  assert.equal(listMessages(db).length, 5);
});

test('REGRESSION: a hostile entry cannot put an unbounded subject or body in a row', async (t) => {
  /* The connector capped the body slice and the snippet and nothing else.
     `subject` was the collapsed <title> verbatim, and the link was concatenated
     AFTER the body slice — measured, a 500,000-character title and a
     300,000-character link produced row.subject.length = 500,000 and
     row.text.length = 320,021 against BODY_CHARS = 20,000, bounded by nothing
     but the transport's 8 MiB response ceiling. A feed is a stranger's XML, and
     both fields land in `messages`, in the search index's title, and on every
     surface that renders subjects. The numbers and the budget are folder.mjs's:
     the title stops at 300, the link at 2,000, and the link is measured FIRST
     so the pair can never pass the body's cap — slicing the pair afterwards
     would silently drop the link for any body at the ceiling. */
  const rss = connectorFor('rss');
  const feed = await feedServer(t, {
    body: `<rss version="2.0"><channel><title>${'F'.repeat(9_000)}</title>`
      + `<item><title>${'T'.repeat(500_000)}</title><link>https://x.example/${'p'.repeat(300_000)}</link>`
      + `<guid>g-huge</guid><description>${'d'.repeat(30_000)}</description></item>`
      + '<item><title>Small</title><link>https://x.example/small</link><guid>g-small</guid>'
      + `<description>${'d'.repeat(30_000)}</description></item>`
      + '</channel></rss>',
  });
  const r = await rss.collect({
    source: { id: 's_hostile', settings: { url: feed.url } },
    label: 'Feed',
    secret: null,
    cursor: null,
    window: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: '2026-08-11T09:00:00Z',
    emit() {},
    signal: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: createHttp({ origins: [feed.origin], limits: rss.limits }),
    deps: {},
  });

  const rows = r.parts[0].rows;
  const huge = rows.find((row) => row.messageId === 'g-huge');
  assert.ok(huge.subject.length <= 300, `the subject is ${huge.subject.length} characters — an unbounded title reached the database`);
  assert.ok(huge.text.length <= 20_000, `the body is ${huge.text.length} characters — the link is appended after the slice, so the cap is not a cap`);
  assert.ok(huge.folder.length <= 300, `the folder is ${huge.folder.length} characters`);
  assert.ok(huge.from.name.length <= 120, `the sender name is ${huge.from.name.length} characters`);

  // And the budget spends the truncation on the body, never on the link: an
  // ordinary link survives even when the body sits at the ceiling.
  const small = rows.find((row) => row.messageId === 'g-small');
  assert.ok(small.text.length <= 20_000, `the body is ${small.text.length} characters`);
  assert.match(small.text, /https:\/\/x\.example\/small$/,
    'the cap ate the link, which is the one line in the body a reader acts on');
});

test('REGRESSION: parseFeed is linear in the length of hostile input', () => {
  /* The first parser answered "which elements are items" with
     `<item(\s[^>]*)?>([\s\S]*?)</item\s*>` and matchAll, and a lazy quantifier
     with no closer to stop it scans to the end of the input for EVERY opener:
     measured on Node 26.3.0 before the rewrite, 1 MiB of `<item>` took 12.7 s
     and 1 MiB of `<!--` 23.8 s, four times longer per doubling, so the
     transport's 8 MiB cap was a quarter of an hour with the event loop pinned
     — the board, /api/state and Settings all stop in the same process, and
     the sweep's abort signal cannot interrupt a synchronous regex. `first()`,
     `unwrapCdata` and the Atom `<link …/>` scan had the same shape: 64 KB of
     `<title>` inside one item 55 ms, of `<link ` 512 ms, of `<![CDATA[` 22 ms,
     each quadrupling per doubling. A feed of twenty thousand well-formed items
     parsed in 5 ms throughout, so the answers were never wrong; the clock was.
     A budget is the only assertion that catches it coming back. Every shape
     below is a megabyte and none takes more than 45 ms now. */
  const mib = 1024 * 1024;
  const rep = (s) => s.repeat(Math.ceil(mib / s.length));
  const shapes = [
    ['unclosed items', rep('<item>')],
    ['unclosed entries', rep('<entry>')],
    ['unclosed comments', rep('<!--')],
    ['unclosed titles inside one item', `<item>${rep('<title>')}</item>`],
    ['unclosed link tags inside one item', `<item>${rep('<link ')}</item>`],
    ['unclosed CDATA inside one description', `<item><description>${rep('<![CDATA[')}</description></item>`],
    ['closers that never opened', rep('</item>')],
    ['benign items', rep('<item><title>Notice</title><guid>g</guid><pubDate>Mon, 10 Aug 2026 08:00:00 +0000</pubDate><description>Bring the schedule.</description></item>')],
  ];
  for (const [name, xml] of shapes) {
    assert.ok(xml.length >= mib, `${name}: the input must be a megabyte to be worth timing`);
    const started = Date.now();
    const feed = parseFeed(xml);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `${name}: took ${elapsed}ms for ${xml.length} characters`);
    assert.ok(Array.isArray(feed.entries), `${name}: the parser stopped answering`);
  }
  assert.equal(parseFeed(shapes.at(-1)[1]).entries.length, 200, 'the benign feed is capped at MAX_ENTRIES, not dropped');
});

test('REGRESSION: an entry with no date of its own still reaches the prompt window', async (t) => {
  /* `pubDate` is optional in RSS 2.0 and hand-rolled feeds leave it out. The
     connector emitted `date: null` for such an entry, which lands in
     `messages.sent_at` as NULL; core/db.mjs:441 filters the prompt with
     `sent_at >= ?`, which SQLite evaluates to NULL for a NULL row — so the
     entry was stored, counted as new, reported ok with a count of one, and
     never once reached the model or the board. The same defect fireflies.mjs
     had (fab9f6f). Asserted against the real `upsertMessages` and the real
     `listMessages` with the arguments core/sweep.mjs's gatherPromptInput uses,
     because the whole defect lives in what SQLite does with a NULL.

     The fallback is the channel's own date first — `<lastBuildDate>` is the
     publisher's claim about when this feed was built, and the entry was in it
     — and only then the instant of the read. */
  const rss = connectorFor('rss');
  const NOW = '2026-08-21T09:00:00Z';
  const built = '<rss version="2.0"><channel><title>Built</title>'
    + '<lastBuildDate>Thu, 20 Aug 2026 10:00:00 GMT</lastBuildDate>'
    + '<item><title>Dated</title><guid>g-dated</guid><pubDate>Wed, 19 Aug 2026 08:00:00 GMT</pubDate></item>'
    + '<item><title>Undated</title><guid>g-undated</guid><description>No pubDate anywhere.</description></item>'
    + '</channel></rss>';
  const bare = '<rss version="2.0"><channel><title>Bare</title>'
    + '<item><title>Undated</title><guid>g-undated</guid></item></channel></rss>';
  const feed = await feedServer(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(req.url === '/bare.xml' ? bare : built);
    },
  });
  const ctxFor = (url) => ({
    source: { id: 's_nodate', settings: { url } },
    label: 'Feed',
    secret: null,
    cursor: null,
    window: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: NOW,
    emit() {},
    signal: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: createHttp({ origins: [feed.origin], limits: rss.limits }),
    deps: {},
  });

  const r = await rss.collect(ctxFor(feed.url));
  const rows = r.parts[0].rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find((x) => x.subject === 'Dated').date, '2026-08-19T08:00:00+00:00', 'an entry with a date keeps it');
  assert.equal(rows.find((x) => x.subject === 'Undated').date, '2026-08-20T10:00:00+00:00',
    'the channel said when it was built, and that beats the read instant');

  const db = fresh();
  upsertMessages(db, rows.map((row) => ({ ...row, sourceId: 's_nodate' })));
  const sinceISO = new Date(Date.parse(NOW) - 21 * 86_400_000).toISOString();
  assert.deepEqual(listMessages(db, { sinceISO, limit: 500 }).map((m) => m.subject).sort(), ['Dated', 'Undated'],
    'the poll reported two entries and the prompt was handed one — a null `sent_at` fails `sent_at >= ?` in SQLite, silently');

  // No channel date either: the read instant, in the same form a parsed date has.
  const bareRow = (await rss.collect(ctxFor(`${feed.origin}/bare.xml`))).parts[0].rows[0];
  assert.equal(bareRow.date, '2026-08-21T09:00:00+00:00', 'with nothing to go on, the read instant is the honest date');
});

test('REGRESSION: a dateless feed arrives on the board through the sweep, not only through collect', async (t) => {
  /* The end-to-end half: a real sweep, a real database, and the read the
     prompt makes. No fixture date anywhere, so this cannot age into a failure
     the way test/connector-linear.test.mjs:763 did — the fallback instant is
     the sweep's own clock and the window is measured from it. */
  const db = fresh();
  const feed = await feedServer(t, {
    body: '<rss version="2.0"><channel><title>Undated notices</title>'
      + '<item><title>First</title><guid>u-1</guid></item><item><title>Second</title><guid>u-2</guid></item>'
      + '</channel></rss>',
  });
  const result = await runSweep({
    db,
    config: baseConfig({ sources: [feedSource({ settings: { url: feed.url } })] }),
    mode: 'light',
    deps: sweepDeps,
  });
  assert.equal(result.stats.sources[0].count, 2);
  const sinceISO = new Date(Date.now() - 21 * 86_400_000).toISOString();
  assert.deepEqual(listMessages(db, { sinceISO, limit: 500 }).map((m) => m.subject).sort(), ['First', 'Second'],
    'two rows stored, none visible to the prompt');
});

test('REGRESSION: a dateless entry keeps the instant it was first seen across re-reads', async (t) => {
  /* The half that makes the fallback safe. core/db.mjs's upsert sets
     `sent_at = excluded.sent_at` unconditionally and a feed is re-parsed whole
     on every 200, so `|| readAt` alone would re-date every dateless entry to
     "now" each time anything in the feed changed — a month-old post walking
     back into the prompt window as today's, every time its neighbours moved.
     The instant is chosen once and the cursor remembers it per entry; a new
     entry gets its own first-seen instant, and an entry that leaves the feed
     leaves the memory. */
  const rss = connectorFor('rss');
  let body = '<rss version="2.0"><channel><title>Undated</title>'
    + '<item><title>Old</title><guid>u-old</guid></item></channel></rss>';
  const feed = await feedServer(t, {
    handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.end(body); },
  });
  const read = (now, cursor) => rss.collect({
    source: { id: 's_pin', settings: { url: feed.url } },
    label: 'Feed',
    secret: null,
    cursor,
    window: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now,
    emit() {},
    signal: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: createHttp({ origins: [feed.origin], limits: rss.limits }),
    deps: {},
  });

  const first = await read('2026-08-11T09:00:00Z', null);
  assert.equal(first.parts[0].rows[0].date, '2026-08-11T09:00:00+00:00');
  assert.ok(first.cursor && first.cursor.seen, 'the cursor does not remember when the entry was first seen');
  assert.ok(JSON.stringify(first.cursor).length < 4096, 'a cursor the sweep would refuse');

  // The feed changes a day later: a new dateless entry appears above the old one.
  body = '<rss version="2.0"><channel><title>Undated</title>'
    + '<item><title>New</title><guid>u-new</guid></item><item><title>Old</title><guid>u-old</guid></item></channel></rss>';
  const second = await read('2026-08-12T09:00:00Z', first.cursor);
  const by = Object.fromEntries(second.parts[0].rows.map((r) => [r.subject, r.date]));
  assert.equal(by.Old, '2026-08-11T09:00:00+00:00', 'the entry was re-dated to the second read, and the upsert would overwrite sent_at with it');
  assert.equal(by.New, '2026-08-12T09:00:00+00:00', 'a new entry is dated when it was first seen');
  assert.equal(Object.keys(second.cursor.seen).length, 2);

  // The old entry drops off the feed, and the memory of it goes too.
  body = '<rss version="2.0"><channel><title>Undated</title>'
    + '<item><title>New</title><guid>u-new</guid></item></channel></rss>';
  const third = await read('2026-08-13T09:00:00Z', second.cursor);
  assert.equal(third.parts[0].rows[0].date, '2026-08-12T09:00:00+00:00');
  assert.equal(Object.keys(third.cursor.seen).length, 1, 'an entry no longer in the feed is still in the cursor');
});

test('REGRESSION: the cursor is trimmed to what the sweep will store, validators last', async (t) => {
  /* core/sweep.mjs refuses a cursor over 4,096 serialised characters OUTRIGHT,
     with only a log line — so an oversized cursor is not a big cursor, it is NO
     cursor: the validators gone (a full re-read every sweep, defeating the 304
     economy) and every first-seen pin gone with them, so every dateless entry
     is re-dated on each parse — the exact walk-back into the prompt window the
     pin exists to prevent. Sixty-four pins are ~3 KB on their own, so a
     token-bearing feed address plus a CDN's long ETag was enough to sink the
     whole thing: measured, 70 dateless entries behind a 900-character ETag at a
     1,400-character address serialised to 5,138. slack.mjs already trims in
     packCursor; rss assumed the arithmetic instead of enforcing it. The pins go
     first, oldest instant first, and the validators last — one 304 pays for
     them every sweep. */
  const rss = connectorFor('rss');
  const items = Array.from({ length: 70 }, (_, i) => `<item><title>N${i}</title><guid>guid-${i}</guid></item>`).join('');
  const etag = `W/"${'e'.repeat(900)}"`;
  const feed = await feedServer(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml', etag });
      res.end(`<rss version="2.0"><channel><title>T</title>${items}</channel></rss>`);
    },
  });
  const r = await rss.collect({
    source: { id: 's_long', settings: { url: `${feed.origin}/${'p'.repeat(1_400)}/feed.xml`, maxItems: 200 } },
    label: 'Feed',
    secret: null,
    cursor: null,
    window: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: '2026-08-11T09:00:00Z',
    emit() {},
    signal: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: createHttp({ origins: [feed.origin], limits: rss.limits }),
    deps: {},
  });

  const size = JSON.stringify(r.cursor).length;
  assert.ok(size <= 4096,
    `a ${size}-character cursor — core/sweep.mjs drops it whole, and this feed loses ALL of its state on every sweep`);
  assert.equal(r.cursor.etag, etag, 'the validators go last — they are what makes the next read cost nothing');
  assert.ok(Object.keys(r.cursor.seen).length > 0, 'fitting the budget must not mean throwing every pin away');
});

test('REGRESSION: a feed address edited in Settings does not inherit the old address\'s validators', async (t) => {
  /* Nothing clears `source.<id>.cursor` on a settings save, so the cursor
     minted at the old address was replayed against the new one. A server
     ignores `If-Modified-Since` beside an `If-None-Match` (RFC 9110 §13.1.3),
     but the old feed need not have sent an ETag — and then a new feed whose
     own Last-Modified is the older of the two answers 304, forever, about
     entries it has never sent: "unchanged", 0 entries, ok, until the new feed
     happens to publish something newer than the old feed's last change. */
  const rss = connectorFor('rss');
  const feeds = {
    '/a.xml': { modified: 'Thu, 20 Aug 2026 10:00:00 GMT', body: '<rss><channel><title>A</title><item><title>A post</title><guid>a-1</guid></item></channel></rss>' },
    '/b.xml': { modified: 'Mon, 10 Aug 2026 10:00:00 GMT', body: '<rss><channel><title>B</title><item><title>B post</title><guid>b-1</guid></item></channel></rss>' },
  };
  const feed = await feedServer(t, {
    handler: (req, res) => {
      const served = feeds[req.url];
      // Ordinary validator semantics: not modified since the date you name.
      const since = Date.parse(req.headers['if-modified-since'] || '');
      if (Number.isFinite(since) && since >= Date.parse(served.modified)) { res.writeHead(304); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/rss+xml', 'last-modified': served.modified });
      res.end(served.body);
    },
  });
  const read = (path, cursor) => rss.collect({
    source: { id: 's_moved', settings: { url: `${feed.origin}${path}` } },
    label: 'Feed',
    secret: null,
    cursor,
    window: { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: '2026-08-21T09:00:00Z',
    emit() {},
    signal: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: createHttp({ origins: [feed.origin], limits: rss.limits }),
    deps: {},
  });

  const first = await read('/a.xml', null);
  assert.deepEqual(first.parts[0].rows.map((r) => r.subject), ['A post']);
  assert.equal(first.cursor.lastModified, feeds['/a.xml'].modified);

  // The user edits the address in Settings; the cursor is the one from before.
  const moved = await read('/b.xml', first.cursor);
  assert.equal(feed.headers()[1]['if-modified-since'], undefined,
    'the old address\'s validator was sent to the new one, and a standard server answers 304 to it forever');
  assert.equal(feed.headers()[1]['if-none-match'], undefined);
  assert.deepEqual(moved.parts[0].rows.map((r) => r.subject), ['B post'], 'the new feed\'s entries never arrived');
  assert.equal(moved.cursor.lastModified, feeds['/b.xml'].modified, 'and the cursor now describes the new address');

  // The same address again is still a cheap read: the validator is honoured
  // where it was minted.
  const again = await read('/b.xml', moved.cursor);
  assert.equal(feed.headers()[2]['if-modified-since'], feeds['/b.xml'].modified);
  assert.equal(again.parts[0].rows.length, 0);
});

/* ================================================================== *
 * The transport, on its own
 * ================================================================== */

test('ctx.http refuses an address that is not the source\'s own', async (t) => {
  const feed = await feedServer(t);
  const other = await feedServer(t);
  const http1 = createHttp({ origins: [feed.origin], limits: {} });

  await assert.rejects(() => http1.get(other.url), /not one of this source's addresses/,
    'a URL that arrived from somewhere other than the user was fetchable');
  await assert.rejects(() => http1.get('file:///etc/passwd'), /only be read over http or https/);
  await assert.rejects(() => http1.get('http://169.254.169.254/latest/meta-data/'),
    /not one of this source's addresses/);
  // The one it was given works, so the refusals above are not a broken client.
  assert.equal((await http1.get(feed.url)).status, 200);
});

test('the transport, not the connector, decides what a 401 and a 429 mean', async (t) => {
  /* The two error classes are the entire replacement for a status enum, and
     this is what makes them free: a connector writes no code at all to get the
     behaviour, because the transport throws them. A connector that never calls
     ctx.http — imap, ics, caldav, file — therefore cannot raise either, which
     is what keeps their failure behaviour byte-identical to what it was. */
  const refuses = await feedServer(t, { handler: (req, res) => { res.writeHead(401); res.end(); } });
  const limits = await feedServer(t, { handler: (req, res) => { res.writeHead(429, { 'retry-after': '90' }); res.end(); } });

  const credential = { label: 'Token', send: { as: 'header', name: 'authorization', prefix: 'Bearer ' } };
  await assert.rejects(
    () => createHttp({ origins: [refuses.origin], limits: {}, credential, secret: 'a-token' }).get(refuses.url),
    AuthError,
  );
  // With no credential sent, a 401 is an ordinary failure, not an AuthError (TT-3459).
  await assert.rejects(
    () => createHttp({ origins: [refuses.origin], limits: {} }).get(refuses.url),
    (err) => !(err instanceof AuthError) && /refused to serve this address \(401\)/.test(err.message),
  );
  await assert.rejects(
    () => createHttp({ origins: [limits.origin], limits: {} }).get(limits.url),
    (err) => err instanceof RateLimitError && err.retryAfterMs === 90_000,
  );
});

test('a redirect off the origin is refused, and one on it costs the credential nothing', async (t) => {
  const away = await feedServer(t);
  const home = await feedServer(t, {
    handler: (req, res, hits) => {
      if (req.url === '/away') { res.writeHead(302, { location: away.url }); res.end(); return; }
      if (req.url === '/hop') { res.writeHead(302, { location: '/feed.xml' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(RSS_TWO);
    },
  });
  const client = createHttp({
    origins: [home.origin],
    limits: {},
    credential: { label: 'Token', send: { as: 'header', name: 'authorization', prefix: 'Bearer ' } },
    secret: 'a-token',
  });

  await assert.rejects(() => client.get(`${home.origin}/away`), /not one of this source's addresses/);
  assert.equal(away.hits(), 0, 'the off-origin destination was contacted before the refusal');

  const ok = await client.get(`${home.origin}/hop`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Alder/);
  // Three requests reached this host — /away, /hop, and the hop's destination —
  // and every one of them is the origin the user configured, so every one of
  // them carries the credential. The property being pinned is that the
  // credential never leaves that origin, which `away.hits() === 0` above and
  // this equality together state.
  assert.equal(home.hits(), 3);
  assert.equal(home.headers().filter((h) => h.authorization === 'Bearer a-token').length, 3);
});

test('only one redirect is followed, however many the host offers', async (t) => {
  const home = await feedServer(t, {
    handler: (req, res, hits) => { res.writeHead(302, { location: `/hop${hits}` }); res.end(); },
  });
  const client = createHttp({ origins: [home.origin], limits: {} });
  await assert.rejects(() => client.get(`${home.origin}/start`), /returned 302/,
    'a redirect chain was followed past the single hop this transport allows');
  assert.equal(home.hits(), 2);
});

test("the sweep's .ics reader holds one deadline across a redirect, not one per hop", async (t) => {
  /* `fetchIcsText` stays outside the transport on purpose (see its header), so
     it must hand-roll this rule the way core/server.mjs and core/doctor.mjs
     already do: a host that stalls just under the timeout and then answers 302
     must not hand the redirect target a whole fresh deadline of its own. */
  const home = await feedServer(t, {
    handler: (req, res) => {
      if (req.url === '/start') {
        setTimeout(() => { res.writeHead(302, { location: '/end.ics' }); res.end(); }, 400);
        return;
      }
      // The redirect's destination: never answers. Closed by the test's after.
    },
  });
  const started = Date.now();
  await assert.rejects(() => fetchIcsText(`${home.origin}/start`, { timeoutMs: 600 }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 800, `one 600ms deadline should cover both hops, took ${elapsed}ms`);
});

test("the sweep's .ics reader refuses an endless feed at its 8 MB cap, off the stream", async (t) => {
  /* It used to `res.text()` and only then compare the length, so a feed with no
     Content-Length that never ends was read until the deadline, all of it held
     in memory. The server below writes until the client hangs up and counts
     what it managed to send; the reader must stop near the cap. */
  const MiB = 1024 * 1024;
  let sent = 0;
  const home = await feedServer(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      const chunk = Buffer.from('BEGIN:VCALENDAR\r\n'.padEnd(64 * 1024, 'X'));
      const pump = () => {
        while (!res.destroyed && sent < 64 * MiB) {
          sent += chunk.length;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      res.on('close', () => res.removeAllListeners('drain'));
      pump();
    },
  });
  await assert.rejects(() => fetchIcsText(`${home.origin}/cal.ics`, { timeoutMs: 15_000 }),
    /calendar at 127\.0\.0\.1:\d+ returned more than 8388608 bytes/);
  // The cap plus what sat in socket buffers when the reader let go; nowhere near 64 MiB.
  assert.ok(sent < 24 * MiB, `the server got ${(sent / MiB).toFixed(1)} MiB out before the reader stopped`);
});

test('a body larger than the cap is refused off the stream, not after buying it', async (t) => {
  const home = await feedServer(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      // No content-length: a host that wants to hand Zelos 48 MiB does not announce it.
      for (let i = 0; i < 40; i += 1) res.write('x'.repeat(64 * 1024));
      res.end();
    },
  });
  const client = createHttp({ origins: [home.origin], limits: {}, maxBytes: 128 * 1024 });
  await assert.rejects(() => client.get(home.url), /more than 131072 bytes/);
});

test('postJson is closed unless the manifest declared graphql', async (t) => {
  const home = await feedServer(t);
  const closed = createHttp({ origins: [home.origin], limits: {} });
  await assert.rejects(() => closed.postJson(home.url, { query: '{ me }' }), /may only read with GET/);
  const open = createHttp({ origins: [home.origin], limits: {}, graphql: true });
  assert.equal((await open.postJson(home.url, { query: '{ me }' })).status, 200);
});

test('a persisted budget does not refill because the process restarted', async (t) => {
  const home = await feedServer(t);
  const limits = { minGapMs: 0, budget: { calls: 3, perMs: 3_600_000 } };
  const startedAt = Date.now();

  // What a previous run left in `source.<id>.state`.
  const meter = createMeter(limits, { spent: 3, windowStartedAt: startedAt }, startedAt);
  assert.equal(meter.spent, 3, 'the window is still open, so the spend carries');
  const client = createHttp({ origins: [home.origin], limits, meter });
  await assert.rejects(() => client.get(home.url), RateLimitError);
  assert.equal(home.hits(), 0, 'the request went out anyway');

  // A window that has rolled over starts clean.
  const rolled = createMeter(limits, { spent: 3, windowStartedAt: startedAt - 3_600_001 }, startedAt);
  assert.equal(rolled.spent, 0);
});

test('Retry-After is read in both forms the RFC allows', () => {
  const now = Date.parse('2026-08-11T09:00:00Z');
  assert.equal(parseRetryAfter('120', now), 120_000);
  assert.equal(parseRetryAfter('Tue, 11 Aug 2026 09:02:00 GMT', now), 120_000);
  assert.equal(parseRetryAfter('Tue, 11 Aug 2026 08:00:00 GMT', now), 0, 'a moment in the past is now');
  assert.equal(parseRetryAfter('', now), null);
  assert.equal(parseRetryAfter('soon', now), null);
});

test('originOf and secretHash keep their promises', () => {
  assert.equal(originOf('https://api.github.com/repos/x/y?a=1'), 'https://api.github.com');
  assert.equal(originOf('webcal://cal.example.com/x.ics'), 'https://cal.example.com');
  assert.equal(originOf('file:///etc/passwd'), null);
  assert.equal(originOf('not a url'), null);
  assert.equal(secretHash(null), null);
  assert.equal(secretHash('hunter2').length, 16);
  assert.notEqual(secretHash('hunter2'), 'hunter2');
});

/* ================================================================== *
 * assertShape — the interface, enforced at import
 * ================================================================== */

const validManifest = (over = {}) => ({
  type: 'sample',
  family: 'sample',
  label: 'Sample',
  option: 'A sample source',
  configKey: 'sources',
  sink: 'messages',
  credential: null,
  origins: ['https://api.example.com'],
  fields: [],
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: null },
  collect: async () => ({ parts: [] }),
  ...over,
});

test('assertShape accepts a well-formed manifest and every connector that ships', () => {
  assert.doesNotThrow(() => assertShape(validManifest()));
  for (const c of registry.all()) assert.doesNotThrow(() => assertShape(c, new Set()), c.type);
});

test('assertShape refuses a settings field named anything config would strip', () => {
  /* The clause nobody would think of. `stripSecrets` deletes these key names
     anywhere at any depth on every save and logs "config: refused to store
     credential fields" — so a connector field called `key`, holding an innocuous
     project key, vanishes on save with a warning that reads like a false
     positive. Every name in the set is checked, not a sample, because the set is
     the thing that has to stay in sync. */
  for (const name of SECRET_KEYS) {
    if (!/^[a-z][A-Za-z0-9_]*$/.test(name)) continue; // api_key etc. fail the identifier rule first
    assert.throws(
      () => assertShape(validManifest({ fields: [{ name, type: 'text', label: 'X' }] })),
      /strips from every save/,
      `a field named "${name}" was accepted and would silently vanish on save`,
    );
  }
  assert.doesNotThrow(() => assertShape(validManifest({ fields: [{ name: 'projectKey', type: 'text', label: 'Project' }] })));
});

test('assertShape refuses a manifest that could change something at a source', () => {
  /* Non-negotiable #2 as a property of the SHAPE rather than a convention. A
     reviewer asking "can Zelos send?" reads this list, not eleven connectors. */
  for (const verb of ['send', 'reply', 'archive', 'complete', 'write', 'delete']) {
    assert.throws(
      () => assertShape(validManifest({ [verb]: async () => {} })),
      /not part of the connector interface/,
      `a connector declaring \`${verb}\` was accepted`,
    );
  }
});

test('assertShape refuses the rest of the ways a manifest can be wrong', () => {
  const cases = [
    [{ type: 'Sample' }, /lowercase `type`/],
    [{ family: '' }, /needs a `family`/],
    [{ configKey: 'somewhere' }, /configKey must be one of/],
    [{ sink: 'captures' }, /sink must be one of/],
    [{ collect: undefined }, /needs a collect/],
    [{ origins: undefined }, /needs an `origins` array/],
    [{ origins: ['https://api.example.com/v3'] }, /must be a bare origin/],
    [{ origins: ['ftp://api.example.com'] }, /must be http or https/],
    [{ limits: undefined }, /needs a `limits` object/],
    [{ limits: { minIntervalMs: NaN, minGapMs: 0 } }, /minIntervalMs must be a number/],
    [{ limits: { minIntervalMs: 0, minGapMs: 0, budget: { calls: 0, perMs: 1 } } }, /budget.calls must be positive|budget\.calls must be a positive/],
    [{ limits: { minIntervalMs: 0, minGapMs: 0, maxRows: 0 } }, /maxRows must be a positive integer/],
    [{ fields: [{ name: 'ok', type: 'colour', label: 'X' }] }, /must be one of/],
    [{ fields: [{ name: 'ok', type: 'choice', label: 'X' }] }, /choice with no choices/],
    [{ credential: { label: 'T', send: { as: 'query', name: 'token' } } }, /There is no "query"/],
  ];
  for (const [over, re] of cases) {
    assert.throws(() => assertShape(validManifest(over)), re, JSON.stringify(over));
  }
  const seen = new Set();
  assertShape(validManifest(), seen);
  assert.throws(() => assertShape(validManifest(), seen), /registered twice/);
});

test('describe() survives JSON and carries no functions', () => {
  const manifests = describeAll();
  assert.deepEqual(JSON.parse(JSON.stringify(manifests)), manifests,
    'the UI reaches core/ only over HTTP, so a manifest that does not round-trip is unreachable');
  for (const m of manifests) {
    for (const v of Object.values(m)) assert.notEqual(typeof v, 'function');
  }
  /* Asserted against the registry rather than against a list written here.
     A second copy of the connector names would have to be edited every time one
     is added — which is the thing the registry exists to stop, and it would have
     drifted the first time somebody added six at once. What this still catches
     is the real risk: `describe()` silently dropping a connector the app has, or
     inventing one it does not, which would show as a Settings picker that
     disagrees with what the sweep will actually read. */
  assert.deepEqual(manifests.map((m) => m.type), registry.all().map((c) => c.type),
    'describe() and the registry disagree about which connectors this build has');
  assert.ok(manifests.length >= 5, 'describe() came back suspiciously short');
  assert.equal(manifests.find((m) => m.type === 'imap').credential.required, true);
  assert.equal(manifests.find((m) => m.type === 'file').credential, null,
    'a source with nothing to paste must not be described as needing something');
});

test('REGRESSION: a server that sends no rate-limit header has not reported zero remaining', async (t) => {
  /* This one line stopped three connectors from working at all, and shipped.

     `res.headers.get()` returns null for a header that is not there,
     `Number(null)` is 0, and both `Number.isFinite(0)` and `0 >= 0` are true —
     so `state.spent = budget.calls - 0` marked the WHOLE declared budget spent
     on the first response from any server that does not send
     `x-ratelimit-remaining`.

     GitHub sends it, which is why GitHub worked and hid this. Slack, Linear and
     Todoist do not. All three therefore made exactly one request per window and
     then rested: Slack read no messages at all, and neither of the other two
     could reach a second page. Measured before the fix — a declared budget of
     100 calls, one success, and the second call refused with "this source's own
     allowance of 100 requests is spent".

     Both directions are asserted, because the naive fix (ignore the header) is
     just as wrong: a server that really does say zero must still stop us. */
  const silent = await feedServer(t, {
    handler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); },
  });
  const generous = createHttp({
    origins: [silent.origin],
    limits: { budget: { calls: 100, perMs: 3_600_000 }, minGapMs: 0 },
  });
  for (let i = 0; i < 5; i += 1) {
    await generous.get(`${silent.origin}/x`);       // must not throw
  }
  assert.equal(silent.hits(), 5, 'a declared budget of 100 refused a call before the fifth');

  const exhausted = await feedServer(t, {
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' });
      res.end('{}');
    },
  });
  const client = createHttp({
    origins: [exhausted.origin],
    limits: { budget: { calls: 100, perMs: 3_600_000 }, minGapMs: 0 },
  });
  await client.get(`${exhausted.origin}/x`);
  await assert.rejects(() => client.get(`${exhausted.origin}/x`), /allowance/,
    'a server that really reported zero remaining was ignored');
});

test('originsFor is the user\'s addresses plus the connector\'s, and nothing a document said', () => {
  const rss = connectorFor('rss');
  assert.deepEqual(originsFor(rss, { settings: { url: 'https://alder.example/feed.xml' } }),
    ['https://alder.example/feed.xml']);
  assert.deepEqual(originsFor(connectorFor('ics'), { url: 'https://cal.example/x.ics' }),
    ['https://cal.example/x.ics']);
  assert.deepEqual(originsFor(rss, { settings: {} }), [], 'nothing configured means nothing reachable');
});

/* ================================================================== *
 * config.sources[] — the envelope, and only the envelope
 * ================================================================== */

test('validateConfig checks a source envelope and leaves the payload to the registry', () => {
  const good = baseConfig({
    sources: [feedSource({ keyRef: 'rss.s_feed', settings: { url: 'https://alder.example/feed.xml' } })],
  });
  assert.deepEqual(validateConfig(good), { ok: true, errors: [] });

  // A config written before `sources` existed is not broken.
  const older = baseConfig();
  delete older.sources;
  assert.equal(validateConfig(older).ok, true);

  const bad = validateConfig(baseConfig({
    sources: [
      { id: '', enabled: 'yes', label: 4, type: '', keyRef: 'bad ref!', settings: [] },
      feedSource({ id: 's_dup' }),
      feedSource({ id: 's_dup' }),
    ],
  }));
  const at = bad.errors.map((e) => e.path);
  for (const p of ['sources[0].id', 'sources[0].enabled', 'sources[0].label', 'sources[0].type',
    'sources[0].keyRef', 'sources[0].settings', 'sources[2].id']) {
    assert.ok(at.includes(p), `expected an error at ${p}, got ${at.join(', ')}`);
  }

  /* The deliberate non-check. A hand-edited type that names no connector LOADS:
     the sweep reports that source unread and `zelos doctor` names it, which is
     strictly better than refusing to load the file that has the typo in it. */
  assert.equal(validateConfig(baseConfig({ sources: [feedSource({ type: 'runes' })] })).ok, true);
});

test('a source with no credential is never told a password is missing', async (t) => {
  const db = fresh();
  const feed = await feedServer(t);
  const result = await runSweep({
    db,
    config: baseConfig({ sources: [feedSource({ keyRef: 'rss.s_feed', settings: { url: feed.url } })] }),
    mode: 'light',
    deps: { getSecret: async () => null },
  });
  assert.equal(result.stats.sources[0].ok, true,
    '`credential: null` must not be read as `credential: {required: false}` with a missing value');
});

/* ================================================================== *
 * The zero-dependency claim, extended to the new directory
 * ================================================================== */

test('no connector reaches the network except through the transport', () => {
  const dir = path.join(ROOT, 'core/connectors');
  const offenders = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    /* Two files are allowed a socket and both are named here rather than
       detected: http.mjs IS the transport, and ics.mjs carries core/sweep.mjs's
       original .ics reader verbatim because routing it through the transport
       would turn a 401 on a subscription URL into a six-hour rest — a behaviour
       change, deferred on purpose. Every other connector, and every connector
       added later, must go through ctx.http, because docs/SECURITY.md's
       invitation to check with tcpdump survives ten connectors only as a test. */
    if (name === 'http.mjs' || name === 'ics.mjs') continue;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/(^|[^.\w])fetch\s*\(/.test(code) || /globalThis\.fetch/.test(code)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `these connectors open their own sockets:\n  ${offenders.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * oauthFor — the sweep's half of "Sign in with Google / Microsoft"
 * ------------------------------------------------------------------ */

test('oauthFor resolves an empty clientId to the configured client, and carries the ref its secret is under', async () => {
  const { oauthFor } = await import('../core/connectors/imap.mjs');
  const { GOOGLE_CLIENT_SECRET_REF, googleSecretRefFor, oauthClient } = await import('../core/sources/oauth.mjs');
  const config = {
    oauth: {
      clients: {
        google: { clientId: '4242-zelos.apps.googleusercontent.com' },
        microsoft: { clientId: '11111111-2222-3333-4444-555555555555', tenantId: 'consumers' },
      },
    },
  };

  /* The account the sign-in buttons save when the server's own client ran the
     flow carries `clientId: ''`. The sweep has to read it with that same
     client — resolved from config exactly as the begin route resolved it —
     or the card says "Connected" and every sweep after it throws
     not_configured before the stored grant is even consulted. */
  const google = oauthFor({ keyRef: 'mail.m_1', oauth: { provider: 'google', clientId: '' } }, config);
  assert.equal(google.clientId, '4242-zelos.apps.googleusercontent.com');
  assert.equal(google.tokenRef, 'mail.m_1');
  assert.equal(google.clientSecretRef, GOOGLE_CLIENT_SECRET_REF, 'the configured client keeps the install-wide secret ref');

  const microsoft = oauthFor({ keyRef: 'mail.m_2', oauth: { provider: 'microsoft', clientId: '', tenantId: 'common' } }, config);
  assert.equal(microsoft.clientId, '11111111-2222-3333-4444-555555555555');
  assert.equal(microsoft.tenantId, 'common', 'the tenant the grant was minted under, not the config one');
  assert.equal(microsoft.clientSecretRef, undefined, 'a Microsoft public client has no secret to file');

  /* An account with a client of its own keeps it, and its Google secret is
     read from the ref connect filed it under — scoped to that client, so a
     second Cloud project's paste cannot overwrite the first's. */
  const own = oauthFor({ keyRef: 'mail.m_3', oauth: { provider: 'google', clientId: 'other.apps.googleusercontent.com' } }, config);
  assert.equal(own.clientId, 'other.apps.googleusercontent.com');
  assert.equal(own.clientSecretRef, googleSecretRefFor(oauthClient(config, 'google'), 'other.apps.googleusercontent.com'));
  assert.match(own.clientSecretRef, /^oauth\.google\.clientSecret\.[0-9a-f]{16}$/);

  // A Microsoft account that names its own client needs no config, and a
  // password account still has no block.
  const registered = oauthFor({ keyRef: 'mail.m_4', oauth: { clientId: '22222222-2222-3333-4444-555555555555' } }, null);
  assert.equal(registered.provider, 'microsoft');
  assert.equal(registered.clientId, '22222222-2222-3333-4444-555555555555');
  assert.equal(oauthFor({ keyRef: 'mail.m_5' }, config), null);
});

/* ================================================================== *
 * A calendar password over plain http://
 *
 * QA, 2026-10-10, TT-3425. Both calendar readers that sign in — CalDAV and a
 * protected .ics link — sent `Authorization: Basic` to any http:// address
 * they were given. Each now runs mail's `requireTls` rule (core/net.mjs) on the
 * URL it is about to fetch, before the first request. `fetch` is stubbed here
 * and asserted never called, on `.test` hosts that resolve nowhere.
 * ================================================================== */

/** A `fetch` that records and refuses. */
function recordingFetch(t) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const headers = init.headers ?? {};
    calls.push({ url: String(input?.url ?? input), auth: headers.authorization ?? headers.Authorization ?? null });
    throw new Error('stubbed: no network in this test');
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

const CAL_WINDOW = { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', tzid: 'UTC', email: null, max: 100 };

test("the sweep's .ics reader refuses a username on http:// before any request — empty password too", async (t) => {
  const calls = recordingFetch(t);
  for (const pass of ['a-password', '', undefined]) {
    await assert.rejects(() => fetchIcsText('http://cal.example.test/feed.ics', { user: 'nemo', pass }), (err) => {
      assert.equal(err.cleartextRefused, true);
      assert.match(err.message, /^Zelos stopped before your calendar password left this machine: cal\.example\.test is a plain http:\/\/ address\./);
      return true;
    });
  }
  assert.deepEqual(calls, [], 'the password was on the wire before the refusal');
});

test("the sweep's .ics reader checks the scheme it will actually fetch, and lets the allowed shapes through", async (t) => {
  const calls = recordingFetch(t);
  const allowed = [
    // webcal: is rewritten to https: BEFORE the check — the rewrite is what
    // decides the scheme on the wire, so a webcal link with a username is fine.
    ['webcal://cal.example.test/feed.ics', { user: 'nemo', pass: 'p' }, 'https://cal.example.test/feed.ics'],
    ['http://cal.example.test/feed.ics', { user: 'nemo', pass: 'p', requireTls: false }, 'http://cal.example.test/feed.ics'],
    ['http://localhost:5232/feed.ics', { user: 'nemo', pass: 'p' }, 'http://localhost:5232/feed.ics'],
    ['http://[::1]:5232/feed.ics', { user: 'nemo', pass: 'p' }, 'http://[::1]:5232/feed.ics'],
    ['http://cal.example.test/feed.ics', {}, 'http://cal.example.test/feed.ics'],
  ];
  for (const [url, opts, fetched] of allowed) {
    await assert.rejects(() => fetchIcsText(url, opts), /stubbed/, `${url} ${JSON.stringify(opts)} was refused`);
    assert.equal(calls.at(-1).url, fetched);
  }
  assert.equal(calls.length, allowed.length);
});

test('both calendar connectors forward the calendar’s requireTls to the reader', async (t) => {
  const calls = recordingFetch(t);
  for (const type of ['ics', 'caldav']) {
    const connector = registry.get(type);
    const source = { id: `c_${type}`, kind: type, url: 'http://cal.example.test/cal/', user: 'nemo', keyRef: `calendar.c_${type}` };

    // Unset is "decide from the host", and this host is not loopback.
    const before = calls.length;
    await assert.rejects(() => connector.read({ source, pass: 'p', window: CAL_WINDOW }), { cleartextRefused: true }, type);
    assert.equal(calls.length, before, `${type}: a request was made before the refusal`);

    // `false` is a standing permission for this one server, and has to reach
    // the reader as `false` — `|| null` here would quietly refuse it again.
    await assert.rejects(() => connector.read({ source: { ...source, requireTls: false }, pass: 'p', window: CAL_WINDOW }), (err) => {
      assert.equal(err.cleartextRefused, undefined, `${type}: the permission did not reach the reader`);
      return true;
    });
    assert.ok(calls.length > before, `${type}: the excused server was never asked`);
    assert.ok(calls.at(-1).auth?.startsWith('Basic '), `${type}: the permitted request went without its credential`);
  }
});

test('the CalDAV doctor check reports a refused http:// password as itself, not as a wrong password', async (t) => {
  recordingFetch(t);
  const { testConnection } = await import('../core/sources/caldav.mjs');
  const connector = registry.get('caldav');
  const asked = [];
  const ctx = {
    getSecret: async () => 'a-password',
    testCalDav: async (spec) => { asked.push(spec); return testConnection(spec); },
    timeoutMs: 1_000,
    signal: undefined,
  };
  const source = { id: 'c_plain', kind: 'caldav', url: 'http://cal.example.test/dav/', user: 'nemo', keyRef: 'calendar.c_plain' };

  const verdict = await connector.check(source, ctx);
  assert.equal(verdict.status, 'fail');
  assert.match(verdict.detail, /stopped before your calendar password left this machine/);
  assert.match(verdict.action, /https:\/\//);
  assert.match(verdict.action, /Sending the password/);
  assert.doesNotMatch(verdict.action, /username and the password|app-specific password/,
    'nothing was rejected — nothing was sent — so password advice sends the reader the wrong way');
  assert.equal(asked[0].requireTls, null, 'the check must run under the rule the sweep reads');

  await connector.check({ ...source, requireTls: false }, ctx);
  assert.equal(asked[1].requireTls, false, 'a standing permission must reach the probe as false');
});
