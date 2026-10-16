/**
 * test/connector-github.test.mjs — the notifications reader, against a real
 * socket.
 *
 * This file exists because an adversarial review proved the connector had NO
 * behavioural coverage: nine mutations applied at once — `direction: 'out'`,
 * `uid: null`, the no-id guard deleted, the pulls-to-issues rewrite deleted,
 * the To line blanked, `participating` forced false, `all=false` flipped to
 * `all=true`, the `If-Modified-Since` header deleted, and the short-page break
 * deleted — left the whole suite green. Every one of those is a defect a
 * refactor could reintroduce with no signal, and two of them (`uid: null` and
 * the To line) are the exact failures other connectors already have dedicated
 * tests for.
 *
 * Nothing here contacts github.com. A loopback server answers, which is also
 * the only way to assert on the REQUEST — the conditional header, the
 * participating flag, the pagination stop — and the request is half of what
 * this connector is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { default: github, tokenUrlOf } = await import('../core/connectors/github.mjs');
const { createHttp } = await import('../core/connectors/http.mjs');
const { upsertMessages, listMessages, open, close, migrate } = await import('../core/db.mjs');

/* ------------------------------------------------------------------ *
 * A GitHub that does what each test says
 * ------------------------------------------------------------------ */

function notification(over = {}) {
  return {
    id: '1',
    reason: 'review_requested',
    updated_at: '2026-08-11T12:30:00Z',
    repository: { full_name: 'octocat/Hello-World' },
    subject: {
      title: 'Retainage schedule',
      type: 'PullRequest',
      url: 'https://api.github.com/repos/octocat/Hello-World/pulls/456',
    },
    ...over,
  };
}

async function githubServer(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: { ...req.headers } });
    handler(req, res, seen.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}

/** A ctx shaped like the one the sweep builds, pointed at the loopback server. */
function ctxFor(origin, { settings = {}, cursor = null, signal = null } = {}) {
  const emitted = [];
  return {
    source: { id: 's_gh', label: 'GitHub', settings: { apiBase: origin, ...settings } },
    secret: 'ghp_a_token',
    cursor,
    label: 'GitHub',
    window: { from: '2026-08-01T00:00:00Z', to: '2026-08-12T00:00:00Z' },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: '2026-08-11T13:00:00+00:00',
    emit: (m) => emitted.push(m),
    signal,
    log: { warn() {}, info() {}, debug() {} },
    emitted,
    http: createHttp({
      origins: [origin],
      limits: github.limits,
      credential: github.credential,
      secret: 'ghp_a_token',
    }),
  };
}

const okJson = (res, body, headers = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** The instant `ctxFor` hands the connector as `ctx.now`. */
const NOW_MS = Date.parse('2026-08-11T13:00:00+00:00');

/** github.mjs's MAX_POLL_MS. Written out so a change to it fails these tests. */
const MAX_POLL_MS = 15 * 60_000;

/* ================================================================== *
 * The request
 * ================================================================== */

test('the first read asks only for unread threads the user participates in', async (t) => {
  /* `all=false` and `participating=true` are the whole reason this connector is
     a "what needs you" feed rather than a firehose. Flipping either turns a
     board into every notification from every watched repo, which is the thing
     the connector exists not to do — and neither flip changes a single row's
     SHAPE, so nothing else here would notice. */
  const { origin, seen } = await githubServer(t, (req, res) => okJson(res, [notification()]));
  const ctx = ctxFor(origin);

  await github.collect(ctx);

  assert.match(seen[0].url, /all=false/, 'the reader asked for read notifications too');
  assert.match(seen[0].url, /participating=true/, 'the reader asked for watched repos it was not told to watch');
  assert.equal(seen[0].headers['x-github-api-version'], '2022-11-28',
    'the pinned API version is missing, so the payload shape can change on a date nobody here chose');
});

test('includeWatched widens the request, and that is the only thing that does', async (t) => {
  const { origin, seen } = await githubServer(t, (req, res) => okJson(res, []));
  await github.collect(ctxFor(origin, { settings: { includeWatched: true } }));
  assert.match(seen[0].url, /participating=false/, 'the setting did not reach the request');
});

/* ================================================================== *
 * Scoping
 * ================================================================== */

test('REGRESSION: a repository address pasted without a scheme still matches', async (t) => {
  /* The field hint promises "Pasting a repository’s web address works too", and
     the strip used to require `^https?://`. Measured before the fix:
     `github.com/octocat/Hello-World` parsed as owner `github.com`, repo
     `octocat` — so `inScope` was false for every notification the account has
     and the source returned 0 rows, `ok: true`, no error, forever. That is the
     exact failure the function's own comment says it exists to prevent, and it
     arrives on the commonest paste there is: Safari drops the scheme when you
     copy an address, and a person retyping one never types `https://`.

     Each spelling is driven through the real `collect` rather than through
     `scopeList` alone, because the thing that broke was whether a row came
     back, not what an exported helper returned. */
  for (const typed of [
    'github.com/octocat/Hello-World',
    'www.github.com/octocat/Hello-World',
    'https://github.com/octocat/Hello-World/pull/3',
    'git@github.com:octocat/Hello-World.git',
    'octocat/hello-world',
  ]) {
    const { origin } = await githubServer(t, (req, res) => okJson(res, [notification()]));
    const rows = (await github.collect(ctxFor(origin, { settings: { repos: typed } }))).parts.flatMap((p) => p.rows);
    assert.equal(rows.length, 1, `"${typed}" matched nothing, so this source is silently empty forever`);
  }
});

test('a scope still excludes what it does not name', async (t) => {
  /* The other half of the same fix: loosening the parse must not turn the
     filter into "everything". */
  const { origin } = await githubServer(t, (req, res) => okJson(res, [
    notification({ id: '1', repository: { full_name: 'octocat/Hello-World' } }),
    notification({ id: '2', repository: { full_name: 'acme/widgets' } }),
  ]));
  const rows = (await github.collect(ctxFor(origin, { settings: { repos: 'github.com/acme/widgets' } }))).parts.flatMap((p) => p.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].folder, 'acme/widgets', 'the scope let through a repository it does not name');
});

/* ================================================================== *
 * The rows
 * ================================================================== */

test('a row carries no uid, so a second sweep of the same notification inserts nothing', async (t) => {
  /* The rule that has already cost this project once: `uid: null` coerces to 0
     in upsertMessage while an omitted uid stays null, and the two hash to
     different row ids — so a connector that flips between them re-inserts every
     row it has ever seen, on every sweep, forever. Asserted against the REAL
     database rather than by reading the object, because the coercion is the
     part that bites. */
  const { origin } = await githubServer(t, (req, res) => okJson(res, [notification()]));
  const result = await github.collect(ctxFor(origin));
  const rows = result.parts.flatMap((p) => p.rows);
  assert.equal(rows.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'uid'), false,
    'the row carries a uid key — omit it entirely or always give it a number, never null');

  const db = open(':memory:');
  t.after(() => close(db));
  migrate(db);
  const first = upsertMessages(db, rows);
  const second = upsertMessages(db, rows);
  assert.equal(first.inserted, 1, 'the first sweep stored nothing');
  assert.equal(second.inserted, 0,
    'the same notification inserted twice — the row id is not stable, so the board duplicates every sweep');
});

test('REGRESSION: a notification with no readable updated_at still reaches the prompt window', async (t) => {
  /* Latent rather than live — GitHub always sends `updated_at` — but it was
     the exact shape fireflies.mjs (fab9f6f) and rss.mjs failed on: `date:
     null` lands in `messages.sent_at` as NULL, core/db.mjs:441 filters the
     prompt with `sent_at >= ?`, and SQLite makes that NULL for a NULL row, so
     the notification is stored, counted, and never shown. Asserted against
     the real database, because the defect lives in what SQLite does with a
     NULL. The fallback is the sweep's own clock, `ctx.now`, in the form a
     parsed date has. */
  const { origin } = await githubServer(t, (req, res) => okJson(res, [
    notification(),
    notification({ id: '2', updated_at: '', subject: { title: 'No instant', type: 'Issue', url: 'https://api.github.com/repos/octocat/Hello-World/issues/7' } }),
  ]));
  const rows = (await github.collect(ctxFor(origin))).parts.flatMap((p) => p.rows);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.messageId === 'github:thread:2').date, '2026-08-11T13:00:00+00:00',
    'a notification with no readable time was dated with nothing at all');

  const db = open(':memory:');
  t.after(() => close(db));
  migrate(db);
  upsertMessages(db, rows.map((r) => ({ ...r, sourceId: 's_gh' })));
  const sinceISO = new Date(NOW_MS - 21 * 86_400_000).toISOString();
  assert.equal(listMessages(db, { sinceISO, limit: 500 }).length, 2,
    'the poll reported two notifications and the prompt was handed one — a null `sent_at` fails `sent_at >= ?` in SQLite, silently');
});

test('a review request puts the user on the To line, which is how triage sees it at all', async (t) => {
  /* core/triage.mjs scores from `to`/`cc`/`flags`/`direction` and never reads
     prose, so a connector that only wrote "Review requested" into the subject
     would have told a human and hidden it from the ranker. */
  const { origin } = await githubServer(t, (req, res) => okJson(res, [
    notification({ id: '1', reason: 'review_requested' }),
    notification({ id: '2', reason: 'subscribed', subject: { title: 'FYI', type: 'Issue', url: `${origin}/repos/o/r/issues/9` } }),
  ]));
  const rows = (await github.collect(ctxFor(origin))).parts.flatMap((p) => p.rows);

  const addressed = rows.find((r) => /Retainage/.test(r.subject));
  const watched = rows.find((r) => /FYI/.test(r.subject));
  assert.ok(addressed.to?.some((a) => /nemo@example\.com/i.test(a?.email ?? '')),
    'a review request did not put the user on the To line, so triage cannot weigh it');
  assert.ok(!watched.to?.some((a) => /nemo@example\.com/i.test(a?.email ?? '')),
    'a merely-watched thread was addressed to the user, which inflates everything');
  assert.equal(addressed.direction, 'in', 'a notification is something that arrived');
});

test('every notification on one pull request is one board item', async (t) => {
  /* GitHub reports the same PR under `pulls/456` and `issues/456` depending on
     the event. Keyed naively that is two conversations, and six comments on one
     review is six board items. */
  const { origin } = await githubServer(t, (req, res) => okJson(res, [
    notification({ id: '1', subject: { title: 'Retainage', type: 'PullRequest', url: `${origin}/repos/o/r/pulls/456` } }),
    notification({ id: '2', subject: { title: 'Retainage', type: 'Issue', url: `${origin}/repos/o/r/issues/456` } }),
  ]));
  const rows = (await github.collect(ctxFor(origin))).parts.flatMap((p) => p.rows);
  assert.equal(new Set(rows.map((r) => r.threadKey)).size, 1,
    'the same pull request produced two threads, so it will be two items on the board');
});

test('REGRESSION: two discussions in one repository are two board items', async (t) => {
  /* GitHub sends `subject.url: null` for a Discussion — subjectPath's own
     comment says so — so a Discussion took the fallback written for CheckSuite
     and every discussion in a repository collapsed onto `github:o/r:discussion`.
     Measured: two notifications about two unrelated questions produced ONE
     thread key, `messagesInThread` returned both, and `threadIndex`
     (core/triage.mjs:403) counted them as a single conversation — so the model
     was handed two fragments glued together and the board showed one row whose
     contents changed each sweep. Merging is right for builds and false for
     conversations. */
  const discussion = (id, title) => notification({
    id,
    reason: 'mention',
    subject: { title, type: 'Discussion', url: null },
    repository: { full_name: 'octocat/Hello-World' },
  });
  const { origin } = await githubServer(t, (req, res) => okJson(res, [
    discussion('1', 'Should we drop the retainage clause?'),
    discussion('2', 'Crane schedule for the week of the 24th'),
    discussion('3', 'Should we drop the retainage clause?'), // a second notification about the FIRST one
  ]));
  const rows = (await github.collect(ctxFor(origin))).parts.flatMap((p) => p.rows);

  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.threadKey)).size, 2,
    'two unrelated discussions landed on one thread key, so the board shows them as one item');
  assert.equal(rows[0].threadKey, rows[2].threadKey,
    'two notifications about ONE discussion split into two threads, which is the defect the key exists to prevent');
});

test('CI activity still collapses to one thread per repository, on purpose', async (t) => {
  /* The other half: a CheckSuite has no URL either, and merging IS the intent
     there — "the build for this repo needs looking at" is one board item however
     many workflows failed. A fix for the discussion case that split these too
     would trade one defect for another. */
  const build = (id, title) => notification({
    id,
    reason: 'ci_activity',
    subject: { title, type: 'CheckSuite', url: null },
    repository: { full_name: 'octocat/Hello-World' },
  });
  const { origin } = await githubServer(t, (req, res) => okJson(res, [
    build('1', 'nightly workflow run failed'),
    build('2', 'release workflow run failed'),
  ]));
  const rows = (await github.collect(ctxFor(origin, { settings: { includeCi: true } }))).parts.flatMap((p) => p.rows);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.threadKey)).size, 1,
    'a repository\'s CI noise split into one board item per workflow');
});

test('REGRESSION: the body is capped, and the link survives the cap', async (t) => {
  /* This was the only messages-sink connector in the repo with no BODY_CHARS.
     Measured: a `subject.title` of 500,000 characters produced a `text` of
     500,081, which goes into `messages.body` AND into the FTS index via
     `indexDoc` (core/db.mjs:411) — four page-loads of it per sweep, bounded by
     nothing but readCapped's 8 MiB. github.com caps an issue title at 256
     characters; a GHES install or a proxy does not. */
  const huge = 'x'.repeat(500_000);
  const { origin } = await githubServer(t, (req, res) => okJson(res, [
    notification({ subject: { title: huge, type: 'PullRequest', url: `${origin}/repos/o/r/pulls/456` } }),
  ]));
  const [row] = (await github.collect(ctxFor(origin))).parts.flatMap((p) => p.rows);

  assert.ok(row.text.length <= 20_000,
    `the body is ${row.text.length} characters — an unbounded payload string reached SQLite and the search index`);
  assert.ok(row.snippet.length <= 400);
  assert.match(row.text, /\/pull\/456$/,
    'the truncation ate the link, which is the one line in the body a human clicks');
  /* The subject is built from the SAME title, and the body fix left it whole:
     measured, the 500,000-character title above produced a 500,019-character
     `messages.subject`, re-written into the FTS title on every sweep's upsert.
     slack caps its subject at 120 and linear at 200; this is the same rule. */
  assert.ok(row.subject.length <= 200,
    `the subject is ${row.subject.length} characters — the exact payload the body cap was written about still lands in messages.subject whole`);
});

test('REGRESSION: the pager says so when it stops at its ceiling with GitHub still offering more', async (t) => {
  /* The loop used to read four FULL pages and return `ok, 0` with no note when
     the repo scope rejected everything — while the scoped repository's
     notifications sat on page five, never fetched, and the page-1 validator was
     stored, so later sweeps 304 past them until something changes. linear.mjs
     names the identical silence as the defect it fixed ("Reading hasNextPage
     and dropping it on the floor is what made the note below state a total it
     knew was false") and slack notes both of its cuts; github — the file whose
     own header calls a source that has quietly stopped the one failure mode
     this product cannot afford — said nothing. */
  const page = (n) => Array.from({ length: 50 }, (_, i) => notification({ id: `${n}-${i}` }));
  const { origin, seen } = await githubServer(t, (req, res, n) => okJson(res, page(n)));
  const scoped = await github.collect(ctxFor(origin, { settings: { repos: 'acme/widgets' } }));

  assert.equal(seen.length, 4, 'the page ceiling itself moved');
  assert.equal(scoped.parts.flatMap((p) => p.rows).length, 0);
  assert.match(String(scoped.parts[0].note), /never fetched/,
    `four full pages, everything filtered out, and the source reads "ok, 0": ${scoped.parts[0].note}`);

  // A read that genuinely ended is not nagged about.
  const { origin: quiet } = await githubServer(t, (req, res) => okJson(res, [notification()]));
  const whole = await github.collect(ctxFor(quiet));
  assert.equal(whole.parts[0].note, null, 'a complete read carries a warning about nothing');
});

/* ================================================================== *
 * The cursor
 * ================================================================== */

test('the conditional header is sent, and a 304 is a free read of nothing', async (t) => {
  const { origin, seen } = await githubServer(t, (req, res, n) => {
    if (n === 1) { okJson(res, [notification()], { 'last-modified': 'Tue, 11 Aug 2026 12:30:00 GMT' }); return; }
    res.writeHead(304, { 'last-modified': 'Tue, 11 Aug 2026 12:30:00 GMT' });
    res.end();
  });

  const first = await github.collect(ctxFor(origin));
  assert.equal(first.cursor.lastModified, 'Tue, 11 Aug 2026 12:30:00 GMT', 'the validator was not stored');

  const second = await github.collect(ctxFor(origin, { cursor: { ...first.cursor, polledAtMs: 0 } }));
  assert.equal(seen[1].headers['if-modified-since'], 'Tue, 11 Aug 2026 12:30:00 GMT',
    'the validator was stored and then not sent, which spends the hourly budget for nothing');
  assert.equal(second.parts.flatMap((p) => p.rows).length, 0);
});

test('REGRESSION: changing what is asked for throws the validator away', async (t) => {
  /* `Last-Modified` describes the answer to ONE question. Add a repo, switch CI
     activity on, widen to watched threads — and the stored validator still
     describes the old question, so GitHub answers 304 and the connector says
     "nothing new" about notifications that were on the server all along.
     Measured before the fix: a sweep scoped to one repo, the user adds a
     second, and the next sweep reports zero rows while the new repo's
     notifications were in the response body both times. On a quiet account the
     validator holds for a day, so the user edits Settings, sees a confident
     green zero, and has nothing to read. */
  const { origin, seen } = await githubServer(t, (req, res, n) => {
    if (n === 1) { okJson(res, [notification()], { 'last-modified': 'Tue, 11 Aug 2026 12:30:00 GMT' }); return; }
    // A server that would answer 304 to the OLD question, and has rows for the new one.
    if (req.headers['if-modified-since']) { res.writeHead(304); res.end(); return; }
    okJson(res, [notification({ id: '2', repository: { full_name: 'acme/widgets' } })],
      { 'last-modified': 'Tue, 11 Aug 2026 13:00:00 GMT' });
  });

  const first = await github.collect(ctxFor(origin, { settings: { repos: 'octocat/Hello-World' } }));
  assert.ok(first.cursor.shape, 'the cursor does not record the shape of the question it answered');

  // The user widens the scope in Settings; the cursor is the one from before.
  const widened = await github.collect(ctxFor(origin, {
    settings: { repos: 'octocat/Hello-World, acme/widgets' },
    cursor: { ...first.cursor, polledAtMs: 0 },
  }));

  assert.ok(!seen[1].headers['if-modified-since'],
    'the stale validator was sent for a question it does not describe, so GitHub answered 304 about the old scope');
  assert.equal(widened.parts.flatMap((p) => p.rows).length, 1,
    'widening the scope returned nothing — the notification was in the response body and was thrown away');
});

test('REGRESSION: a cursor asking for a day between polls cannot retire the source', async (t) => {
  /* `pollIntervalFrom` clamps to 15 minutes when the header is PARSED, and for a
     long time that was the only clamp. A cursor is a persisted kv row that
     outlives the code that wrote it — an older release, a hand-edited row, a
     restored backup — so the ceiling has to hold on the read as well.

     Measured before the fix, with `{pollIntervalMs: 86_400_000}` in the cursor:
     `collect` made ZERO requests, emitted "GitHub asked for 86400s between polls
     — 86399s to go", and returned `rows: 0, error: null`, which the sweep
     records as `ok: true, count: 0`. The same cursor came back unchanged, so the
     number never shrank: a source silently stopped for a day while reporting a
     successful read of nothing. */
  const bad = { lastModified: null, shape: null, pollIntervalMs: 86_400_000 };

  // Sixteen minutes since the last poll: past the ceiling, nowhere near a day.
  const { origin, seen } = await githubServer(t, (req, res) => okJson(res, [notification()]));
  const woken = await github.collect(ctxFor(origin, { cursor: { ...bad, polledAtMs: NOW_MS - 16 * 60_000 } }));
  assert.equal(seen.length, 1, 'the connector asked GitHub for nothing — the out-of-range interval was obeyed');
  assert.equal(woken.parts.flatMap((p) => p.rows).length, 1);
  assert.equal(woken.cursor.pollIntervalMs, MAX_POLL_MS,
    'the out-of-range interval was copied forward into the new cursor, so the next sweep suppresses itself instead');

  // One second since the last poll: legitimately gated, but by 15 minutes.
  const ctx = ctxFor(origin, { cursor: { ...bad, polledAtMs: NOW_MS - 1_000 } });
  const gated = await github.collect(ctx);
  assert.equal(seen.length, 1, 'the poll gate stopped working — 250ms after a read is not a polite interval');
  assert.equal(gated.cursor.pollIntervalMs, MAX_POLL_MS,
    'the cursor was handed back carrying the value it arrived with, so it never heals');
  assert.ok(!/86400s/.test(ctx.emitted.join(' ')),
    `the Now banner told the user GitHub asked for a day between polls: ${ctx.emitted.join(' ')}`);
});

test('the interval GitHub actually asks for is kept, and a missing header does not erase it', async (t) => {
  /* The clamp must not become "always 15 minutes": a stated 300s is GitHub's
     answer and is what the next sweep has to respect. */
  const { origin } = await githubServer(t, (req, res) => okJson(res, [notification()], { 'x-poll-interval': '300' }));
  const first = await github.collect(ctxFor(origin));
  assert.equal(first.cursor.pollIntervalMs, 300_000, 'the interval the server stated was not carried in the cursor');

  const { origin: quiet } = await githubServer(t, (req, res) => okJson(res, [notification()]));
  const second = await github.collect(ctxFor(quiet, { cursor: { ...first.cursor, polledAtMs: 0 } }));
  assert.equal(second.cursor.pollIntervalMs, 300_000,
    'a response with no X-Poll-Interval threw away the interval the server stated last time');
});

/* ================================================================== *
 * Failure
 * ================================================================== */

test('an auth failure is an error, never an empty day', async (t) => {
  /* The worst possible lie this product can tell: a revoked token reported as
     "nothing needs you". The board goes quiet and the silence looks like calm. */
  const { origin } = await githubServer(t, (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
  });
  await assert.rejects(() => github.collect(ctxFor(origin)),
    (err) => {
      assert.match(String(err?.message ?? ''), /credential|token|auth/i,
        `the error does not say the token is the problem: ${err?.message}`);
      return true;
    });
});

test('REGRESSION: a GitHub Enterprise user is told to mint a token on their own server', async (t) => {
  /* TOKEN_URL was fixed to github.com, so the 401 message and doctor's advice
     sent an Enterprise user somewhere their server has never heard of. */
  assert.equal(tokenUrlOf({}), 'https://github.com/settings/tokens');
  assert.equal(tokenUrlOf({ apiBase: 'https://api.github.com/' }), 'https://github.com/settings/tokens');
  assert.equal(tokenUrlOf({ apiBase: 'https://ghe.corp.example/api/v3' }), 'https://ghe.corp.example/settings/tokens');
  assert.equal(tokenUrlOf({ apiBase: 'https://api.ghe.corp.example:8443/api/v3' }),
    'https://api.ghe.corp.example:8443/settings/tokens', 'an Enterprise host that happens to start with api. is kept');
  assert.equal(tokenUrlOf({ apiBase: 'https://api.acme.ghe.com' }), 'https://acme.ghe.com/settings/tokens');
  assert.equal(tokenUrlOf({ apiBase: 'not a url' }), 'https://github.com/settings/tokens');

  const { origin } = await githubServer(t, (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
  });
  await assert.rejects(() => github.collect(ctxFor(origin)), (err) => {
    assert.ok(err.message.includes(`${origin}/settings/tokens`), err.message);
    assert.doesNotMatch(err.message, /github\.com/);
    return true;
  });
  const ctx = ctxFor(origin);
  const verdict = await github.check(ctx.source, ctx);
  assert.equal(verdict.status, 'fail');
  assert.ok(verdict.action.includes(`${origin}/settings/tokens`), verdict.action);
});

test('a 200 that is not a list of notifications is a failure, not zero rows', async (t) => {
  const { origin } = await githubServer(t, (req, res) => okJson(res, { message: 'Bad credentials' }));
  await assert.rejects(() => github.collect(ctxFor(origin)));
});

test('REGRESSION: a cancelled read does not report itself as a clean empty one', async (t) => {
  /* Measured before the fix: with `signal.aborted` already true, `collect` made
     zero requests and returned `rows: [], error: null, note: null` with a cursor
     whose `polledAtMs` had advanced to now — which the sweep records as
     `ok: true, count: 0`, i.e. "I read GitHub and there was nothing" for a read
     that never asked. Nothing is lost today only because core/sweep.mjs:762
     drops the run before cursors are persisted; that is the sweep's guarantee,
     not this connector's. */
  const { origin, seen } = await githubServer(t, (req, res) => okJson(res, [notification()]));
  const before = { lastModified: 'Tue, 11 Aug 2026 12:30:00 GMT', shape: null, pollIntervalMs: 60_000, polledAtMs: 111 };
  const stopped = await github.collect(ctxFor(origin, { cursor: before, signal: AbortSignal.abort() }));

  assert.equal(seen.length, 0, 'the read was cancelled and the connector went to the network anyway');
  assert.deepEqual(stopped.cursor, before,
    'a read that never happened advanced the cursor, so the poll clock and the validator moved for nothing');
  assert.ok(stopped.parts[0].note, 'a cancelled read is shaped exactly like a successful empty one');
});

test('REGRESSION: a read cancelled mid-walk keeps its rows and does not move the validator', async (t) => {
  /* The sharper half. Pages 1-2 came back as a COMPLETE answer carrying the new
     `Last-Modified`, so the pages never fetched would have been 304'd away on
     the next sweep and lost for good. */
  const controller = new AbortController();
  const page = (n) => Array.from({ length: 50 }, (_, i) => notification({ id: `${n}-${i}` }));
  const { origin, seen } = await githubServer(t, (req, res, nth) => {
    if (nth === 1) controller.abort(); // the user pressed stop while page one was in flight
    okJson(res, page(nth), { 'last-modified': `LM-PAGE-${nth}` });
  });

  const before = { lastModified: 'LM-OLD', shape: null, pollIntervalMs: 0, polledAtMs: 111 };
  const result = await github.collect(ctxFor(origin, {
    settings: { maxItems: 200 },
    cursor: before,
    signal: controller.signal,
  }));

  assert.equal(seen.length, 1, 'the walk carried on past the cancellation');
  assert.equal(result.parts.flatMap((p) => p.rows).length, 50,
    'the page already read was thrown away, and the next sweep will not be sent it again');
  assert.equal(result.cursor.lastModified, 'LM-OLD',
    'the validator advanced over pages that were never fetched, so those notifications can never arrive');
});

/* ================================================================== *
 * The diagnostic
 * ================================================================== */

test('REGRESSION: doctor does not blame the network when GitHub is rate limiting', async (t) => {
  /* A diagnostic that names the wrong cause is worse than one that says it does
     not know. Measured before the fix: a 429 came back as `fail` with the action
     "Check that this machine can reach GitHub, and that the API address in
     Settings → Sources is right" — the machine can reach GitHub, it just did,
     and the address is right. The detail printed the host twice, because the
     transport's own message already names it. */
  const { origin } = await githubServer(t, (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '600' });
    res.end('{}');
  });
  const ctx = ctxFor(origin);
  const verdict = await github.check(ctx.source, ctx);

  const words = `${verdict.detail} ${verdict.action ?? ''}`;
  assert.doesNotMatch(words, /can reach GitHub|API address/,
    `doctor blamed the network for a rate limit: ${words}`);
  assert.equal(verdict.status, 'warn',
    'a rate limit set doctor\'s exit code, so a transient allowance reads as a broken configuration');
  assert.match(verdict.detail, /rate limit/i, 'the detail does not say what actually happened');
  assert.match(verdict.detail, /10 minutes/, 'Retry-After was on the error and the user was not told when to come back');
  assert.equal((verdict.detail.match(/127\.0\.0\.1/g) ?? []).length, 1, 'the host is printed twice');
});

test('doctor still blames the token for a 401, and names the account on success', async (t) => {
  /* The arm above must not swallow the two verdicts doctor exists to give. */
  const { origin: bad } = await githubServer(t, (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
  });
  const badCtx = ctxFor(bad);
  const refused = await github.check(badCtx.source, badCtx);
  assert.equal(refused.status, 'fail');
  assert.match(`${refused.detail} ${refused.action}`, /token/i);

  const { origin: good } = await githubServer(t, (req, res) => okJson(res, { login: 'nemo' }, {
    'x-oauth-scopes': 'notifications, read:user',
  }));
  const goodCtx = ctxFor(good);
  const named = await github.check(goodCtx.source, goodCtx);
  assert.equal(named.status, 'pass');
  assert.match(named.detail, /@nemo/, 'doctor did not name the account, which is the line it exists to print');
});
