/**
 * test/connector-fireflies.test.mjs — the Fireflies.ai connector.
 *
 * Fireflies is a GraphQL API on a fifty-request-a-day free tier, which makes
 * two of its properties testable in a way most connectors' are not, and this
 * file is written around exactly those two:
 *
 *  1. THE COST OF A POLL IS COUNTABLE. The mock below records every request it
 *     receives, so "asks for everything in one round trip" is an assertion
 *     about a number and not a claim about a comment. A connector that fetched
 *     the summary per transcript would answer these tests with 1 + N.
 *
 *  2. FAILURE ARRIVES AS 200. GraphQL states a bad key, a spent allowance and a
 *     mistyped field in the body, so the whole "is this a success" decision is
 *     the connector's rather than the transport's. Several tests below feed it a
 *     200 and demand a rejection; the one that matters most is the partial —
 *     `data` populated AND `errors` present — because that is the shape a
 *     `?? []` reader turns into "you had no meetings".
 *
 *  3. THE SERVER ANSWERS THE DOCUMENT, NOT THE TEST. This one was added after
 *     the first two had been true for a while and were not enough. The original
 *     mock returned a fixture whatever it was asked for, so MEETINGS_QUERY —
 *     the entire design of this connector, per the head of the file it tests —
 *     was unpinned: twelve separate edits to it left every test green, including
 *     dropping `summary { … }` (a poll that reads every meeting and no action
 *     item), removing the date arguments (a poll that ignores the window it
 *     computed) and removing `limit`. `serve()` below parses the document,
 *     refuses fields and arguments a written-out SCHEMA does not have, applies
 *     the arguments, and projects each fixture through the selection set. All
 *     twelve now fail. `ok()` is kept for the handful of cases that need a body
 *     no well-behaved server would produce.
 *
 * EVERY SOCKET GOES TO 127.0.0.1. The connector posts to the real
 * https://api.fireflies.ai/graphql and the transport's origin allow-list is
 * enforced against that real origin; only the last hop — `createHttp`'s
 * `fetchImpl` seam, the same one core/doctor.mjs already uses — swaps the host
 * for the mock. So the allow-list is exercised for real (a test below proves it
 * still refuses a foreign origin) and nothing dials the vendor. `globalThis.
 * fetch` is wrapped for the length of the run so that if an edit ever forgets,
 * this suite says so instead of contacting Fireflies from whatever machine is
 * running it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/* Set before the modules that read it are evaluated, which is why every import
   below is dynamic. `core/log.mjs` fixes its level at import time, and an
   unforced secrets backend would detect the operator's own login keychain no
   matter where ZELOS_HOME points. */
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-fireflies-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';

/* ------------------------------------------------------- outbound guard */

const realFetch = globalThis.fetch;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
  const url = new URL(raw);
  if (!LOOPBACK.test(url.hostname)) {
    throw new Error(`this suite must not contact ${url.host} — every endpoint has to be a local mock`);
  }
  return realFetch(input, init);
};

const connector = (await import('../core/connectors/fireflies.mjs')).default;
const {
  API_URL, MEETINGS_QUERY, WHOAMI_QUERY,
  actionItems, attendeesOf, graphqlError, meetingDate, parseGraphql, rowFrom,
} = await import('../core/connectors/fireflies.mjs');
const { AuthError, RateLimitError, createHttp } = await import('../core/connectors/http.mjs');
const registry = await import('../core/connectors/index.mjs');
const { assertShape } = registry;
const { open, close, migrate, upsertMessages, listMessages, messagesInThread } = await import('../core/db.mjs');
const { diagnose } = await import('../core/doctor.mjs');

let seq = 0;
const openDbs = [];

function freshDb() {
  const db = open(path.join(HOME_ROOT, `ff${seq++}.db`));
  migrate(db);
  openDbs.push(db);
  return db;
}

test.after(() => {
  globalThis.fetch = realFetch;
  for (const db of openDbs) close(db);
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const KEY = 'ff_test_0e2a4c6b';

const NOW = '2026-08-11T09:00:00.000Z';
const WINDOW_FROM = '2026-08-04T09:00:00.000Z';   // the sweep's now − 7 days
const WINDOW_TO = '2026-10-10T09:00:00.000Z';     // the sweep's now + 60 days

/**
 * A meeting with a full recap. `date` is derived from `dateString` rather than
 * typed out, so the two encodings cannot silently disagree in the fixture and
 * make a test pass for the wrong reason.
 */
const MEETING_FULL = {
  id: 'tr_0f1e',
  title: 'Alder & Vance pre-con',
  dateString: '2026-08-10T16:00:00.000Z',
  date: Date.parse('2026-08-10T16:00:00.000Z'),
  duration: 42.5,
  transcript_url: 'https://app.fireflies.ai/view/tr_0f1e',
  host_email: 'dana@vance.example',
  organizer_email: 'dana@vance.example',
  participants: ['dana@vance.example', 'nemo@example.com', 'kit@alder.example'],
  meeting_attendees: [
    { displayName: 'Dana Vance', name: 'Dana Vance', email: 'dana@vance.example' },
    { displayName: 'Nemo Hale', name: 'Nemo Hale', email: 'nemo@example.com' },
  ],
  summary: {
    overview: 'The team walked the schedule of values line by line and agreed the crane window moves to the following Tuesday.',
    short_summary: 'Schedule of values walked; crane window moved.',
    gist: 'Pre-con',
    action_items: '- Send the retainage schedule by Thursday\n- Confirm the crane window with the GC',
  },
};

/**
 * The same instant told a different way, and it is the whole point of this
 * fixture: 13:00−04:00 is 17:00Z, which is LATER than MEETING_FULL's 16:00Z,
 * but the string `2026-08-10T13:00:00-04:00` sorts BELOW `2026-08-10T16:00…`.
 * A cursor that compared ISO strings would move backwards here.
 */
const MEETING_LATER_BUT_LOWER = {
  id: 'tr_77aa',
  title: 'Retainage walkthrough',
  dateString: '2026-08-10T13:00:00-04:00',
  date: Date.parse('2026-08-10T17:00:00.000Z'),
  duration: 18,
  transcript_url: 'https://app.fireflies.ai/view/tr_77aa',
  host_email: 'kit@alder.example',
  participants: ['kit@alder.example', 'nemo@example.com'],
  meeting_attendees: [],
  // No summary yet — Fireflies generates it after the call ends, and this is
  // what a poll that caught the meeting in that gap actually receives.
  summary: null,
};

/**
 * A meeting three weeks before the sweep window opens.
 *
 * It exists so the date arguments in MEETINGS_QUERY have something to exclude.
 * A mock that hands back its whole fixture list no matter what it was asked
 * cannot tell a document that filters from one that does not — and "the
 * endpoint ignores the question" is a defect that looks exactly like a healthy
 * poll from inside the connector.
 */
const MEETING_OUT_OF_WINDOW = {
  id: 'tr_old1',
  title: 'Kickoff, three weeks ago',
  dateString: '2026-07-21T15:00:00.000Z',
  date: Date.parse('2026-07-21T15:00:00.000Z'),
  duration: 60,
  transcript_url: 'https://app.fireflies.ai/view/tr_old1',
  host_email: 'dana@vance.example',
  participants: ['dana@vance.example'],
  meeting_attendees: [],
  summary: { overview: 'Kickoff', short_summary: '', gist: '', action_items: '' },
};

const ok = (transcripts) => JSON.stringify({ data: { transcripts } });

/* ================================================================== *
 * A mock that answers the DOCUMENT rather than the test
 * ================================================================== *
 *
 * `ok([MEETING_FULL])` hands back the same body whatever was asked for, and
 * that is the difference between a test file and a test file that catches
 * something. Measured by mutating the connector and re-running this suite as it
 * stood: TWELVE separate edits to MEETINGS_QUERY left every test green —
 * dropping `summary { … }` entirely, dropping `action_items` from it, renaming
 * `transcripts` to `transcript`, renaming `fromDate`, removing the date
 * arguments altogether, removing `limit`, dropping `title`, `transcript_url`,
 * `dateString`, `duration`, `host_email` and `meeting_attendees`. Every one of
 * those is a live connector that returns rows and reads nothing, and the stub
 * agreed with all of them, because the fixture it returns was written by the
 * test rather than derived from the request.
 *
 * So the mock below is a small GraphQL server instead: it parses the document,
 * refuses fields and arguments that are not in SCHEMA the way a real endpoint
 * does (200 with an `errors` array — the vendor's own failure shape), applies
 * `fromDate`/`toDate`/`limit`/`skip`, and PROJECTS each fixture through the
 * selection set so a field the document did not ask for is not in the answer.
 *
 * SCHEMA is written out rather than derived from MEETINGS_QUERY on purpose. A
 * schema generated from the document would accept the document by construction,
 * which is the circularity that let the twelve mutants through in the first
 * place.
 */

/** Object types have subfields; anything else is a leaf. */
const SCHEMA = {
  Query: {
    transcripts: { type: 'Transcript', list: true, args: ['fromDate', 'toDate', 'limit', 'skip', 'mine', 'host_email', 'participant_email', 'user_id'] },
    transcript: { type: 'Transcript', list: false, args: ['id'] },
    users: { type: 'User', list: true, args: [] },
    user: { type: 'User', list: false, args: ['id'] },
  },
  Transcript: {
    id: 'ID', title: 'String', date: 'Float', dateString: 'DateTime', duration: 'Float',
    transcript_url: 'String', audio_url: 'String', video_url: 'String', meeting_link: 'String',
    host_email: 'String', organizer_email: 'String', participants: 'String', calendar_id: 'String',
    meeting_attendees: 'Attendee', summary: 'Summary', sentences: 'Sentence', speakers: 'Speaker',
  },
  Summary: {
    overview: 'String', short_summary: 'String', gist: 'String', action_items: 'String',
    keywords: 'String', bullet_gist: 'String', shorthand_bullet: 'String', outline: 'String',
    meeting_type: 'String', topics_discussed: 'String',
  },
  Attendee: { displayName: 'String', name: 'String', email: 'String', phoneNumber: 'String', location: 'String' },
  User: { user_id: 'ID', name: 'String', email: 'String', num_transcripts: 'Int', minutes_consumed: 'Float', is_admin: 'Boolean' },
  Sentence: { index: 'Int', text: 'String', speaker_name: 'String', start_time: 'Float' },
  Speaker: { id: 'Int', name: 'String' },
};

const TOKEN = /\$?[A-Za-z_][A-Za-z0-9_]*|"[^"]*"|-?\d+(?:\.\d+)?|[{}():,![\]=]/g;

/**
 * The selection set of a single-operation query document.
 *
 * Enough GraphQL for the two documents this connector sends and no more: an
 * operation header, variable definitions (skipped as a paren block), fields,
 * literal-or-variable arguments, and nesting. A document this cannot parse
 * throws, which is a louder failure than quietly matching nothing.
 */
function parseDocument(text) {
  const tokens = String(text ?? '').match(TOKEN) || [];
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  const skipParens = () => {
    let depth = 0;
    do {
      const t = take();
      if (t === '(') depth += 1;
      else if (t === ')') depth -= 1;
      else if (t === undefined) throw new Error('unbalanced ( in the document');
    } while (depth > 0);
  };

  if (peek() === 'query' || peek() === 'mutation') {
    take();
    if (peek() && peek() !== '{' && peek() !== '(') take();   // operation name
    if (peek() === '(') skipParens();                          // variable definitions
  }
  const root = parseSelectionSet();
  if (i < tokens.length) throw new Error(`trailing tokens in the document at ${tokens[i]}`);
  return root;

  function parseSelectionSet() {
    if (take() !== '{') throw new Error('expected a selection set');
    const out = [];
    while (peek() && peek() !== '}') out.push(parseField());
    if (take() !== '}') throw new Error('unclosed selection set');
    return out;
  }
  function parseField() {
    const name = take();
    if (!/^[A-Za-z_]/.test(String(name))) throw new Error(`expected a field name, got ${name}`);
    const args = {};
    if (peek() === '(') {
      take();
      while (peek() && peek() !== ')') {
        const key = take();
        if (take() !== ':') throw new Error(`expected a value for argument ${key}`);
        args[key] = take();
        if (peek() === ',') take();
      }
      take();
    }
    const children = peek() === '{' ? parseSelectionSet() : null;
    return { name, args, children };
  }
}

/** What a GraphQL server says about a document its schema does not recognise. */
function validateAgainstSchema(fields, typeName, errors) {
  for (const f of fields) {
    const def = SCHEMA[typeName]?.[f.name];
    if (!def) {
      errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } });
      continue;
    }
    const type = typeof def === 'string' ? def : def.type;
    const allowed = typeof def === 'string' ? [] : def.args;
    for (const arg of Object.keys(f.args)) {
      if (!allowed.includes(arg)) {
        errors.push({ message: `Unknown argument "${arg}" on field "${typeName}.${f.name}".`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } });
      }
    }
    const isObject = !!SCHEMA[type];
    if (isObject && !f.children) {
      errors.push({ message: `Field "${f.name}" of type "${type}" must have a selection of subfields.`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } });
    } else if (!isObject && f.children) {
      errors.push({ message: `Field "${f.name}" must not have a selection since type "${type}" has no subfields.`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } });
    } else if (isObject) {
      validateAgainstSchema(f.children, type, errors);
    }
  }
}

/** A fixture, reduced to the fields the document actually selected. */
function project(value, fields, typeName) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => project(v, fields, typeName));
  const out = {};
  for (const f of fields) {
    const def = SCHEMA[typeName]?.[f.name];
    const type = typeof def === 'string' ? def : def?.type;
    const raw = value[f.name];
    out[f.name] = f.children ? project(raw, f.children, type) : (raw === undefined ? null : raw);
  }
  return out;
}

const instantOf = (t) => Date.parse(String(t?.dateString ?? '')) || Number(t?.date) || 0;

/**
 * An answerer for `graphqlServer`: a real-enough Fireflies endpoint over the
 * fixtures it is given.
 *
 * `transcripts` honours the arguments the DOCUMENT named — not the ones the
 * connector meant to name — so a query that stopped filtering by date, or
 * stopped capping with `limit`, hands back rows the assertions can see.
 */
function serve({ transcripts = [], users = [] } = {}) {
  return (nth, body) => {
    let doc;
    try {
      doc = parseDocument(body?.query);
    } catch (err) {
      return JSON.stringify({ errors: [{ message: `Syntax Error: ${err.message}` }] });
    }
    const errors = [];
    validateAgainstSchema(doc, 'Query', errors);
    if (errors.length) return JSON.stringify({ errors });

    const vars = body?.variables ?? {};
    const value = (raw) => {
      if (raw === undefined) return undefined;
      if (String(raw).startsWith('$')) return vars[String(raw).slice(1)];
      return String(raw).replace(/^"|"$/g, '');
    };

    const data = {};
    for (const f of doc) {
      if (f.name === 'users') { data.users = project(users, f.children, 'User'); continue; }
      if (f.name === 'user') {
        const id = value(f.args.id);
        data.user = project(users.find((u) => u.user_id === id) ?? users[0] ?? null, f.children, 'User');
        continue;
      }
      if (f.name === 'transcript') {
        const id = value(f.args.id);
        data.transcript = project(transcripts.find((t) => t.id === id) ?? null, f.children, 'Transcript');
        continue;
      }
      // transcripts
      const fromMs = Date.parse(String(value(f.args.fromDate) ?? ''));
      const toMs = Date.parse(String(value(f.args.toDate) ?? ''));
      const limit = Number(value(f.args.limit));
      const skip = Number(value(f.args.skip));
      let rows = transcripts.filter((t) => {
        const at = instantOf(t);
        if (Number.isFinite(fromMs) && at < fromMs) return false;
        if (Number.isFinite(toMs) && at > toMs) return false;
        return true;
      });
      if (Number.isFinite(skip) && skip > 0) rows = rows.slice(skip);
      if (Number.isFinite(limit) && limit >= 0) rows = rows.slice(0, limit);
      data.transcripts = project(rows, f.children, 'Transcript');
    }
    return JSON.stringify({ data });
  };
}

/** The meetings half, which is what almost every test wants. */
const meetings = (...list) => serve({ transcripts: list });

/* ------------------------------------------------------------------ *
 * The mock, the transport and the ctx
 * ------------------------------------------------------------------ */

/**
 * A GraphQL endpoint on 127.0.0.1 that records what it was asked.
 *
 * `answer` is either a fixed string or `(nth, body) => string`, so a test can
 * make the second request differ from the first — which is how the "one round
 * trip" assertion below has teeth: if the connector went back for summaries,
 * the mock would hand it something and the count would say so.
 */
async function graphqlServer(t, answer, { status = 200, headers = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body, raw });
      const text = typeof answer === 'function' ? answer(requests.length, body) : answer;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(text);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, requests };
}

/**
 * The real transport, built from the real manifest, pointed at the mock.
 *
 * `origins`, `limits`, `credential` and `graphql` all come off the connector,
 * so flipping any of them in core/connectors/fireflies.mjs turns these tests
 * red — which is the point. The `fetchImpl` swap happens AFTER the allow-list
 * has already accepted `https://api.fireflies.ai`, so it cannot widen what is
 * reachable; it only decides which socket the accepted request lands on.
 */
function transportFor(mock, { secret = KEY, graphql = connector.graphql === true } = {}) {
  return createHttp({
    origins: connector.origins,
    limits: connector.limits,
    credential: connector.credential,
    graphql,
    secret,
    fetchImpl: (input, init) => {
      const url = new URL(String(input));
      return realFetch(`${mock.origin}${url.pathname}${url.search}`, init);
    },
  });
}

function ctxFor(httpClient, over = {}) {
  const emitted = [];
  const ctx = {
    source: {
      id: 's_ff',
      enabled: true,
      label: 'Team meetings',
      type: 'fireflies',
      keyRef: 'fireflies.s_ff',
      settings: { meetings: 25 },
    },
    label: 'Team meetings',
    secret: KEY,
    cursor: null,
    window: { from: WINDOW_FROM, to: WINDOW_TO },
    timezone: 'UTC',
    identityEmail: 'nemo@example.com',
    now: NOW,
    emit: (message, done = 0, total = 0) => emitted.push({ message, done, total }),
    signal: undefined,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    http: httpClient,
    ...over,
  };
  return { ctx, emitted };
}

/** The variables of the nth recorded request. */
const varsOf = (mock, n = 0) => mock.requests[n].body.variables;

/* ================================================================== *
 * 1. The manifest
 * ================================================================== */

test('the manifest satisfies the connector interface and declares the endpoint it posts to', () => {
  assert.doesNotThrow(() => assertShape(connector));

  assert.equal(connector.type, 'fireflies');
  assert.equal(connector.configKey, 'sources');
  assert.equal(connector.sink, 'messages', 'a recap is a message-shaped row, not a calendar event');
  assert.equal(connector.graphql, true, 'without this core/connectors/http.mjs refuses postJson entirely');

  /* The declared origin and the URL `collect` posts to must be the same host,
     and they are written in two places — the manifest wants a bare origin and
     the request wants a path. A derivation would hide a mismatch; this catches
     one. */
  assert.deepEqual(connector.origins, ['https://api.fireflies.ai']);
  assert.ok(connector.origins.includes(new URL(API_URL).origin),
    `the connector posts to ${API_URL}, which its own allow-list would refuse`);

  // Non-negotiable #3: the user mints the credential, and it travels in a
  // header where core/log.mjs can redact it.
  assert.equal(connector.credential.required, true);
  assert.equal(connector.credential.send.as, 'header');
  assert.match(connector.credential.url, /^https:\/\/app\.fireflies\.ai\//);
});

test('the declared budget is one an hourly poll actually fits inside the free tier', () => {
  /* THE FREE TIER IS 50 REQUESTS A DAY. This is arithmetic on the manifest,
     not a restatement of it: `collect` makes one request, so the day's cost is
     the number of polls a day the interval permits. The sweep's own default
     cadence is 30 minutes, which would be 48 — over the budget below and
     within a rounding error of the vendor's ceiling, with nothing left for
     `zelos doctor`. */
  const DAY_MS = 24 * 60 * 60 * 1000;
  const FREE_TIER_PER_DAY = 50;

  const budget = connector.limits.budget;
  assert.ok(budget, 'a source on a fifty-a-day allowance must declare a real budget');
  assert.equal(budget.perMs, DAY_MS, 'the allowance is stated per day, so the window has to be a day');

  const pollsPerDay = Math.floor(DAY_MS / connector.limits.minIntervalMs);
  assert.ok(pollsPerDay <= budget.calls,
    `an hourly poll is ${pollsPerDay} requests a day against a budget of ${budget.calls}`);
  assert.ok(budget.calls < FREE_TIER_PER_DAY,
    `the budget must leave headroom under ${FREE_TIER_PER_DAY}: core/doctor.mjs builds its check transport `
    + 'without the persisted meter, so every `zelos doctor` run spends a request this budget never sees');

  // And the row cap is above what the connector can ever ask for, so it only
  // fires when the server ignored the `limit` it was given.
  const meetings = connector.fields.find((f) => f.name === 'meetings');
  assert.ok(connector.limits.maxRows > meetings.max);
});

/* ================================================================== *
 * 2. One round trip
 * ================================================================== */

test('collect asks for the meetings and their summaries in ONE request', async (t) => {
  const answer = meetings(MEETING_FULL);
  const mock = await graphqlServer(t, (nth, body) => {
    // Anything after the first would be an N+1 fetch. It is answered rather
    // than refused so the failure is a count, not a crash.
    if (nth > 1) return ok([]);
    return answer(nth, body);
  });
  const { ctx } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);

  assert.equal(mock.requests.length, 1,
    `a poll cost ${mock.requests.length} requests; the free tier allows 50 a day and an hourly poll must cost 24`);

  const row = result.parts[0].rows[0];
  // The proof that it was ONE trip and not a lucky first one: the summary the
  // row carries can only have come out of that single response.
  assert.match(row.text, /Send the retainage schedule by Thursday/);
  assert.match(row.text, /crane window moves to the following Tuesday/);
});

test('the request carries the key as a Bearer header and a JSON GraphQL document', async (t) => {
  const mock = await graphqlServer(t, meetings(MEETING_FULL));
  const { ctx } = ctxFor(transportFor(mock));

  await connector.collect(ctx);

  const req = mock.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/graphql');
  assert.equal(req.headers.authorization, `Bearer ${KEY}`,
    'the manifest declares credential.send, and the transport is what attaches it');
  assert.match(req.headers['content-type'], /application\/json/);
  assert.equal(req.body.query, MEETINGS_QUERY);
  assert.deepEqual(Object.keys(req.body.variables).sort(), ['from', 'limit', 'to']);
});

test('`graphql: true` is what makes the POST legal at all', async (t) => {
  const mock = await graphqlServer(t, ok([]));
  // The same transport the sweep would build for a manifest that did not
  // declare it. Every other test in this file passes `connector.graphql`, so
  // flipping the manifest turns them all red; this one names the reason.
  const { ctx } = ctxFor(transportFor(mock, { graphql: false }));

  await assert.rejects(connector.collect(ctx), /did not declare `graphql: true`/);
  assert.equal(mock.requests.length, 0, 'a refused POST must not reach a socket');
});

test('the whole day\'s allowance is spendable through one transport, header or no header', async (t) => {
  /* The regression test for `ffda7ee`, from the connector that pays for it.
     `res.headers.get()` is null for a header that is not there, `Number(null)`
     is 0, `Number.isFinite(0)` is true and `0 >= 0` is true — so the transport
     used to read "zero calls remaining" out of a header the server never sent
     and spend the entire declared budget on the FIRST response. Fireflies
     sends no `x-ratelimit-remaining` (the mock above sends only a
     content-type, which is the honest shape), so this connector is exactly the
     one that would go back to reading one meeting a day if it returned.

     Forty polls through ONE transport — the whole declared allowance, which is
     more than the hourly interval can spend in a day — and then the refusal,
     which is the budget doing its job rather than a header doing it wrongly. */
  const mock = await graphqlServer(t, meetings(MEETING_FULL));
  const client = transportFor(mock);
  const { calls } = connector.limits.budget;

  for (let i = 0; i < calls; i += 1) {
    const result = await connector.collect(ctxFor(client).ctx);
    assert.equal(result.parts[0].rows.length, 1, `poll ${i + 1} of ${calls} read nothing`);
  }
  assert.equal(mock.requests.length, calls, 'one request per poll, all the way to the end of the allowance');
  assert.equal(client.meter.spent, calls);

  await assert.rejects(connector.collect(ctxFor(client).ctx), RateLimitError,
    'the allowance is spent and the next poll must be refused here rather than at the vendor');
});

test('the connector reaches the network only through `ctx.http`', async (t) => {
  /* Two claims, and only the second one is a real guard.

     The text scan is a lint: it says the module contains no call to `fetch`,
     `http.request` or a socket, which is worth having and is not proof of
     anything at run time. The behaviour is: `globalThis.fetch` is replaced
     with a throw for the length of one poll, and the poll still succeeds —
     which can only be true if every byte went through the transport `ctx.http`
     was built from. That is what makes the origin allow-list, the redirect
     rule, the byte cap and the budget unavoidable rather than merely offered. */
  const source = fs.readFileSync(new URL('../core/connectors/fireflies.mjs', import.meta.url), 'utf8');
  for (const forbidden of [/\bfetch\s*\(/, /\bhttps?\.request\s*\(/, /\bnet\.(connect|createConnection)\s*\(/, /child_process/]) {
    assert.doesNotMatch(source, forbidden, `core/connectors/fireflies.mjs reaches past ctx.http with ${forbidden}`);
  }

  const mock = await graphqlServer(t, meetings(MEETING_FULL));
  const { ctx } = ctxFor(transportFor(mock));
  const guard = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the connector called globalThis.fetch'); };
  try {
    const rows = (await connector.collect(ctx)).parts[0].rows;
    assert.equal(rows.length, 1);
  } finally {
    globalThis.fetch = guard;
  }
});

test('the transport built from this manifest refuses any other host', async (t) => {
  const mock = await graphqlServer(t, ok([]));
  const client = transportFor(mock);

  await assert.rejects(
    client.postJson(`${mock.origin}/graphql`, { query: WHOAMI_QUERY }),
    /not one of this source's addresses/,
  );
  assert.equal(mock.requests.length, 0,
    'the allow-list is checked before a socket exists, so nothing should have arrived');
});

/* ================================================================== *
 * 3. A 200 with an errors body is a failure
 * ================================================================== */

test('a 200 carrying only an errors array is a failure, never an empty read', async (t) => {
  const mock = await graphqlServer(t, JSON.stringify({
    errors: [{ message: 'Cannot query field "summry" on type "Transcript".' }],
  }));
  const { ctx, emitted } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.match(err.message, /Cannot query field "summry"/, 'the vendor\'s own words are the diagnosis');
    return true;
  });
  assert.deepEqual(emitted, [], 'a failed poll must not report a count of zero meetings');
});

test('a 200 carrying BOTH data and errors is still a failure', async (t) => {
  /* The shape that turns a `?? []` reader into a liar in the other direction:
     there IS a `transcripts` array, so a connector that only looked at `data`
     would return one row and call the poll a success while the rest of the
     response was refused. */
  const mock = await graphqlServer(t, JSON.stringify({
    data: { transcripts: [MEETING_FULL] },
    errors: [{ message: 'Field "meeting_attendees" is restricted on this plan', extensions: { code: 'paid_required' } }],
  }));
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), /restricted on this plan/);
});

test('a 200 with neither meetings nor errors is a failure', async (t) => {
  const mock = await graphqlServer(t, JSON.stringify({ data: {} }));
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), /neither transcripts nor an error/);
});

test('a 200 that is not JSON at all is a failure that quotes what arrived', async (t) => {
  const mock = await graphqlServer(t, '<html><body>upstream connect error</body></html>');
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.match(err.message, /not JSON/);
    assert.match(err.message, /upstream connect error/);
    return true;
  });
});

test('a rejected key arrives as 200 and is still promoted to an AuthError', async (t) => {
  /* core/connectors/http.mjs raises AuthError on a 401 or a 403 and can do
     nothing with this body — Fireflies answers a dead key with 200. The class
     is what core/sweep.mjs keys its six-hour rest on, and the comment there is
     about this exact allowance: "Retrying a 401 against a host that allows
     fifty calls a day burns forty-eight of them before lunch." */
  const mock = await graphqlServer(t, JSON.stringify({
    errors: [{ message: 'Please provide a valid API key', extensions: { code: 'unauthenticated' } }],
  }));
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(err instanceof AuthError,
      `a 200 that means "your key is dead" came back as ${err.constructor.name}, so the sweep would retry it 24 times a day`);
    assert.match(err.message, /Please provide a valid API key/);
    return true;
  });
});

test('a stated rate limit arrives as 200 and is still promoted to a RateLimitError', async (t) => {
  const mock = await graphqlServer(t, JSON.stringify({
    errors: [{ message: 'Too many requests, please try again later', extensions: { code: 'too_many_requests' } }],
  }));
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(err instanceof RateLimitError, `came back as ${err.constructor.name}`);
    assert.ok(err.retryAfterMs > 0, 'a rate limit with no rest attached rests nothing');
    return true;
  });
});

test('a stranger error message is capped and flattened before it reaches a doctor row', () => {
  /* core/sweep.mjs caps what it STORES (ERROR_CHARS = 500). core/doctor.mjs:80
     does not: `errorText` is `err?.message` with no ceiling and the verdict's
     detail is printed whole, so the cap has to be here. */
  const err = graphqlError({ errors: [{ message: `${'ka-'.repeat(4000)}\nsecond line\nthird line` }] });
  assert.ok(err.message.length < 700, `an unbounded ${err.message.length}-char error reaches the terminal`);
  assert.doesNotMatch(err.message, /\n/, 'a multi-line error rendered into a one-line doctor row is unreadable');
});

test('graphqlError says nothing about a healthy body', () => {
  assert.equal(graphqlError({ data: { transcripts: [] } }), null);
  // Several servers send an explicit null on success; it must not read as one.
  assert.equal(graphqlError({ data: { transcripts: [] }, errors: null }), null);
  assert.equal(graphqlError({ data: { transcripts: [] }, errors: [] }), null);
});

/* ---------------------------------------------------------------- *
 * The classifier, branch by branch.
 *
 * `graphqlError` decides between AuthError (core/sweep.mjs rests the
 * credential for six hours), RateLimitError (it rests the clock) and a plain
 * Error (it rests nothing and retries in an hour, forever). On a fifty-a-day
 * allowance those are three completely different outcomes, and the function
 * reaches each of them down TWO independent paths — the extension code and the
 * prose — because, as the comment there says, the prose has been more stable
 * than the codes.
 *
 * Until these tests landed, every 200-body case in this file carried BOTH a
 * recognisable code and recognisable prose, so either path could be deleted
 * whole and the suite stayed green. Measured: removing the code branch,
 * removing the message branch, and reducing the code pattern to
 * `/unauthenticated/` were all invisible. Each test below feeds exactly one
 * path and blinds the other.
 * ---------------------------------------------------------------- */

test('an auth failure stated ONLY in the extension code is still an AuthError', () => {
  for (const code of ['unauthenticated', 'unauthorized', 'forbidden', 'invalid_api_key']) {
    const err = graphqlError({ errors: [{ message: 'Something went wrong', extensions: { code } }] });
    assert.ok(err instanceof AuthError, `${code} came back as ${err?.constructor?.name} — the sweep would retry it every hour`);
  }
});

test('`require_elevated_privilege` is an AuthError in either spelling', () => {
  /* The pattern read `require_elevated_privileges` and a substring test for the
     plural does not match the singular, so one of the two spellings a vendor
     might ship was classified and the other was not. A missed auth failure is
     not a worse message: core/sweep.mjs:745 answers a plain Error with
     `record({})` — no rest at all — so the source spends 24 of its 50 daily
     requests every day, forever, on a key that will never gain the privilege.
     The stem matches both. */
  for (const code of ['require_elevated_privilege', 'require_elevated_privileges']) {
    const err = graphqlError({ errors: [{ message: 'You do not have access to this resource', extensions: { code } }] });
    assert.ok(err instanceof AuthError,
      `${code} came back as ${err?.constructor?.name}, so a key that is missing a privilege is retried hourly forever`);
  }
});

test('an auth failure stated ONLY in the prose is still an AuthError', () => {
  /* No `extensions` at all — the shape a vendor sends the day it renames its
     codes, which is the case the message pattern exists for. */
  for (const message of [
    'Please provide a valid API key',
    'You are not authenticated',
    'Unauthorised',
    'invalid token supplied',
    'expired token',
  ]) {
    const err = graphqlError({ errors: [{ message }] });
    assert.ok(err instanceof AuthError, `"${message}" came back as ${err?.constructor?.name}`);
  }
});

test('a rate limit stated in EITHER the code or the prose rests the clock', () => {
  const byCode = graphqlError({ errors: [{ message: 'oops', extensions: { code: 'too_many_requests' } }] });
  assert.ok(byCode instanceof RateLimitError, `by code: ${byCode?.constructor?.name}`);

  const byProse = graphqlError({ errors: [{ message: 'Rate limit exceeded for this workspace' }] });
  assert.ok(byProse instanceof RateLimitError, `by prose: ${byProse?.constructor?.name}`);

  // Three hours, not a day: core/sweep.mjs turns this into `notBefore`, and the
  // free allowance rolls over at an hour nothing tells us.
  assert.equal(byCode.retryAfterMs, 3 * 60 * 60 * 1000);
});

test('an error the vendor sent no message for still says something, and none of them are dropped', () => {
  /* GraphQL permits an error with an `extensions.code` and no message, and
     `.filter(Boolean)` over `e.message` alone would turn that into an Error
     whose text is the empty string — a doctor row that says a source failed and
     will not say how. */
  const nameless = graphqlError({ errors: [{ extensions: { code: 'object_not_found' } }] });
  assert.match(nameless.message, /object_not_found/, 'an error with only a code was reported as nothing at all');

  const several = graphqlError({
    errors: [{ message: 'first thing broke' }, { message: 'second thing broke' }, { message: 'third thing broke' }],
  });
  assert.match(several.message, /first thing broke/);
  assert.match(several.message, /third thing broke/,
    'only the first error survived; a document can fail in several places at once and the last one is as much the diagnosis as the first');
});

/* ---------------------------------------------------------------- *
 * Failure on the STATUS LINE, which is the other half.
 *
 * Everything above is a 200 with a body, because that is the shape this vendor
 * has bitten people with. But Fireflies is still HTTP, an intermediary is still
 * an intermediary, and the manifest is what decides whether the transport can
 * classify a 401 or read a `Retry-After` at all — `credential.send` has to be
 * present for the header to be attached, and `limits.budget` has to be present
 * for a 429 to close the window. None of that was exercised.
 * ---------------------------------------------------------------- */

test('a 401 on the status line is an AuthError, the same as a 200 that means one', async (t) => {
  const mock = await graphqlServer(t, JSON.stringify({ errors: [{ message: 'nope' }] }), { status: 401 });
  const { ctx } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(err instanceof AuthError,
      `a 401 came back as ${err.constructor.name}; core/sweep.mjs only rests the credential for an AuthError`);
    return true;
  });
});

test('a 429 rests for the number the SERVER named, not the one this file guessed', async (t) => {
  /* `Retry-After: 90` is a fact and RATE_LIMIT_REST_MS is a guess, and the
     transport is written so the fact wins. Worth pinning here rather than only
     in the transport's own tests, because it only works if this manifest
     declares a budget: core/connectors/http.mjs:327 closes the window on a 429
     so the rest of the process does not spend an allowance the server has
     already refused, and that line is a no-op for a connector with no budget. */
  const mock = await graphqlServer(t, '{}', { status: 429, headers: { 'retry-after': '90' } });
  const client = transportFor(mock);
  const { ctx } = ctxFor(client);

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.ok(err instanceof RateLimitError, `came back as ${err.constructor.name}`);
    assert.equal(err.retryAfterMs, 90_000, 'the server said 90 seconds and Zelos rested for something else');
    return true;
  });
  assert.equal(client.meter.spent, connector.limits.budget.calls,
    'a 429 must close this window: the allowance is fifty a day and the server has already said no');
});

test('a body that stops halfway is a failure, not an empty read', async (t) => {
  /* A dropped connection mid-response is the commonest way a proxy answers 200
     and hands over half a body. `JSON.parse` throws on it, and the whole point
     of this file is that a throw is the correct outcome and `?? []` is not. */
  const mock = await graphqlServer(t, `{"data":{"transcripts":[{"id":"tr_0f1e","title":"Alder & Va`);
  const { ctx, emitted } = ctxFor(transportFor(mock));

  await assert.rejects(connector.collect(ctx), (err) => {
    assert.match(err.message, /not JSON/);
    assert.match(err.message, /tr_0f1e/, 'the fragment that arrived is the only clue there is; quote it');
    return true;
  });
  assert.deepEqual(emitted, [], 'a truncated response must not be reported as a count of zero meetings');
});

test('parseGraphql hands back the field it was asked for', () => {
  assert.deepEqual(parseGraphql(JSON.stringify({ data: { users: [{ name: 'Dana' }] } }), 'users'), [{ name: 'Dana' }]);
  // An account with no meetings is an empty ARRAY, and that is a real answer.
  assert.deepEqual(parseGraphql(ok([]), 'transcripts'), []);
});

/* ================================================================== *
 * 4. The row
 * ================================================================== */

test('a recap becomes a message-shaped row: title, summary, attendees, meeting time', async (t) => {
  const mock = await graphqlServer(t, meetings(MEETING_FULL));
  const { ctx, emitted } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);
  const [row] = result.parts[0].rows;

  assert.equal(row.subject, 'Alder & Vance pre-con');
  assert.equal(row.folder, 'Team meetings');
  assert.equal(row.direction, 'in');
  assert.deepEqual(row.from, { name: 'Dana Vance', email: 'dana@vance.example' });
  assert.deepEqual(row.to.map((a) => a.email), ['nemo@example.com', 'kit@alder.example'],
    'the host goes in `from`; everyone else is a recipient, and the bare participant list fills the gaps');
  assert.equal(Date.parse(row.date), Date.parse('2026-08-10T16:00:00.000Z'), 'the meeting time is the date');
  assert.match(row.text, /app\.fireflies\.ai\/view\/tr_0f1e/, 'the recap has to be openable');
  assert.match(row.text, /43 min/);
  assert.deepEqual(emitted, [{ message: 'Team meetings: 1 meeting', done: 1, total: 1 }]);
});

test('the action items lead the body and the snippet — they are what you owe', async (t) => {
  const mock = await graphqlServer(t, meetings(MEETING_FULL));
  const { ctx } = ctxFor(transportFor(mock));

  const [row] = (await connector.collect(ctx)).parts[0].rows;

  /* Not a preference. core/triage.mjs:816 shrinks the per-message body budget
     to `floor(room / entries)` when the prompt does not fit and `clean()` at
     :482 caps from the TAIL, so whatever is at the bottom of a body is the
     first thing the model stops seeing. An overview runs to thousands of
     characters; the action items run to a few hundred. */
  const items = row.text.indexOf('Send the retainage schedule');
  const overview = row.text.indexOf('walked the schedule of values');
  assert.ok(items >= 0 && overview >= 0, row.text);
  assert.ok(items < overview,
    'the overview is above the action items, so a squeezed prompt drops the only part that is a commitment');

  assert.match(row.snippet, /^Action items: Send the retainage schedule by Thursday; Confirm the crane window/);
  assert.ok(row.snippet.length <= 400);
});

test('a meeting whose summary has not been generated yet still produces a usable row', async (t) => {
  const mock = await graphqlServer(t, meetings(MEETING_LATER_BUT_LOWER));
  const { ctx } = ctxFor(transportFor(mock));

  const [row] = (await connector.collect(ctx)).parts[0].rows;

  assert.equal(row.subject, 'Retainage walkthrough');
  assert.equal(row.snippet, '', 'there is nothing to summarise yet, and inventing something would be worse');
  assert.match(row.text, /app\.fireflies\.ai\/view\/tr_77aa/);
  assert.equal(Date.parse(row.date), Date.parse('2026-08-10T17:00:00.000Z'));

  /* This fixture has `host_email` and no `organizer_email`, which is what makes
     it the one that proves the document asks for `host_email` at all: every
     other meeting here carries both, so dropping one selection from
     MEETINGS_QUERY was invisible until this line. */
  assert.deepEqual(row.from, { name: 'kit@alder.example', email: 'kit@alder.example' },
    'with no display name anywhere, the address is the best name there is — and it has to have been asked for');
});

test('both spellings of the meeting instant are asked for, because only one of them arrives', async (t) => {
  /* The document asks for `date` AND `dateString` and the file says why: they
     are the same instant in two encodings and which one is populated has not
     been stable across the vendor's own examples. Every other fixture in this
     file carries both, so either selection could be dropped from
     MEETINGS_QUERY and nothing noticed. These two carry one each. */
  const isoOnly = { ...MEETING_FULL, id: 'tr_iso', date: null };
  const epochOnly = { ...MEETING_FULL, id: 'tr_epoch', dateString: null };
  const mock = await graphqlServer(t, meetings(isoOnly, epochOnly));
  const { ctx } = ctxFor(transportFor(mock));

  const rows = (await connector.collect(ctx)).parts[0].rows;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(Date.parse(row.date), Date.parse('2026-08-10T16:00:00.000Z'),
      `${row.messageId} lost its meeting time — one of the two encodings is not in the document`);
  }
});

test('a three-hour meeting cannot put an unbounded body or snippet in the database', async (t) => {
  /* Both ceilings existed and neither was exercised: every fixture here is a
     few hundred characters, so `.slice(0, BODY_CHARS)` and
     `.slice(0, SNIPPET_CHARS)` could both be deleted and the suite stayed
     green. They are not decoration. The snippet is what the board renders
     directly (core/triage.mjs:544 puts it at every level but `bare`), and an
     all-hands recap with forty action items is a real thing that would push a
     wall of text through it. */
  const huge = {
    ...MEETING_FULL,
    id: 'tr_long',
    summary: {
      overview: 'The team went through it. '.repeat(4000),
      short_summary: '',
      gist: '',
      action_items: Array.from({ length: 60 }, (_, n) => `Chase deliverable number ${n} with the trade partner`).join('\n'),
    },
  };
  const mock = await graphqlServer(t, meetings(huge));
  const { ctx } = ctxFor(transportFor(mock));
  const [row] = (await connector.collect(ctx)).parts[0].rows;

  assert.ok(row.text.length <= 20_000, `a ${row.text.length}-character body reached the database`);
  assert.ok(row.snippet.length <= 400, `a ${row.snippet.length}-character snippet reached the board`);
  // And the cap keeps the useful end: the action items still lead both.
  assert.match(row.text, /^Action items\n- Chase deliverable number 0/);
  assert.match(row.snippet, /^Action items: Chase deliverable number 0/);
});

test('a transcript with no id is dropped rather than given a colliding row id', async (t) => {
  const mock = await graphqlServer(t, meetings({ ...MEETING_FULL, id: '' }, MEETING_FULL));
  const { ctx } = ctxFor(transportFor(mock));

  const rows = (await connector.collect(ctx)).parts[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, 'fireflies:tr_0f1e');
});

test('a row never mentions `uid`, and two polls of the same meeting insert it once', async (t) => {
  /* THE RULE THAT HAS ALREADY BITTEN. core/db.mjs:384 reads
     `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` becomes
     0 while an OMITTED uid stays null — two different `messageRowId`s for the
     same meeting. A connector that flipped between them would re-insert every
     recap it has ever seen on every sweep.

     Asserting the key is absent is half of it; the other half is driving the
     real `upsertMessage` twice and watching the second poll insert nothing. */
  const mock = await graphqlServer(t, meetings(MEETING_FULL));
  /* A transport per poll, because that is what the sweep does: `createHttp` is
     built fresh inside the per-source task on every sweep.

     THE SECOND REASON THIS COMMENT USED TO GIVE HAS EXPIRED. It said two polls
     through ONE transport could not be written, because
     `Number(res.headers.get('x-ratelimit-remaining'))` is `Number(null)` is 0
     for a vendor that does not send the header — Fireflies does not — and that
     drove `state.spent` to the whole budget on the first response. That was
     true and was fixed at `ffda7ee`, which reads the header first and believes
     only a number that is really there (core/connectors/http.mjs:354-358). The
     test below spends the whole allowance through a single transport, which is
     the measurement that says so. A transport per poll is kept here because it
     is what production does, not because the other shape is impossible. */
  const poll = async () => (await connector.collect(ctxFor(transportFor(mock)).ctx)).parts[0].rows;

  const first = await poll();
  assert.equal(Object.prototype.hasOwnProperty.call(first[0], 'uid'), false,
    '`uid: null` and an omitted uid hash to different row ids — a meeting has no integer identity, so the key must be absent');

  const db = freshDb();
  const stamp = (rows) => rows.map((r) => ({ ...r, sourceId: 's_ff' }));
  const one = upsertMessages(db, stamp(first));
  assert.equal(one.inserted, 1);

  const second = await poll();
  const two = upsertMessages(db, stamp(second));
  assert.equal(two.inserted, 0, 'the same meeting was inserted a second time — the row id is not stable');
  assert.equal(listMessages(db, { sourceId: 's_ff' }).length, 1);
});

test('the row carries exactly the keys the message contract has, and no others', async (t) => {
  /* `hasOwnProperty('uid')` above catches the one key that has cost this
     project three times. It does not catch the fourth. The contract at
     core/db.mjs:12 is a closed shape and the failure mode is a key that is
     added, not one that is removed — so the whole set is pinned, which makes
     `uid` a special case of a rule instead of the only rule.
     `hasAttachments`, `cc` and `flags` are here for the same reason: nothing
     read them, so nothing would have noticed a recap that started claiming an
     attachment it does not have. */
  const mock = await graphqlServer(t, meetings(MEETING_FULL));
  const { ctx } = ctxFor(transportFor(mock));
  const [row] = (await connector.collect(ctx)).parts[0].rows;

  assert.deepEqual(Object.keys(row).sort(), [
    'cc', 'date', 'direction', 'flags', 'folder', 'from', 'hasAttachments',
    'messageId', 'snippet', 'subject', 'text', 'threadKey', 'to',
  ].sort());
  assert.equal(row.hasAttachments, false, 'a recap is prose; a paperclip on the board would be a lie about it');
  assert.deepEqual(row.cc, []);
  assert.deepEqual(row.flags, []);
});

test('one meeting is one thread, and two meetings are two', async (t) => {
  /* `threadKey` was the last field in this row that nothing read: setting it to
     a constant left the whole suite green, and a constant is what a connector
     that "groups by source" would produce. It is a real index —
     core/db.mjs:145 — and core/triage.mjs:550 hands the model a thread at a
     time, so collapsing every meeting into one would present six unrelated
     recaps as one conversation. A transcript IS the meeting: there is nothing
     coarser to group by and nothing finer to split on. */
  const mock = await graphqlServer(t, meetings(MEETING_FULL, MEETING_LATER_BUT_LOWER));
  const { ctx } = ctxFor(transportFor(mock));
  const rows = (await connector.collect(ctx)).parts[0].rows;

  for (const row of rows) {
    assert.equal(row.threadKey, row.messageId, 'one transcript is one meeting is one thread');
  }

  const db = freshDb();
  upsertMessages(db, rows.map((r) => ({ ...r, sourceId: 's_thread' })));
  assert.equal(messagesInThread(db, 'fireflies:tr_0f1e').length, 1);
  assert.equal(messagesInThread(db, 'fireflies:tr_77aa').length, 1,
    'two separate meetings landed in one thread — the board would read them as one conversation');
});

test('a meeting Zelos cannot place in time still reaches the model', async (t) => {
  /* THE DEFECT THIS TEST WAS WRITTEN FOR. `date` used to be `meetingDate()`
     straight through, which is null when neither `dateString` nor `date` came
     back in a parseable shape — a vendor release that populates only one of
     them, an empty string, an epoch of 0. A null lands in `messages.sent_at` as
     NULL, and core/db.mjs:441 filters the prompt with `sent_at >= ?`, which
     SQLite evaluates to NULL for a NULL column: not true, so the row is not
     returned. The poll still emits "2 meetings", `stats.newMessages` still
     counts two, `zelos doctor` still passes, both rows are really in the
     database — and the model is handed one.

     This is asserted against the REAL `upsertMessages` and the REAL
     `listMessages`, with the same arguments core/sweep.mjs:1115 uses, because
     the whole defect lives in what SQLite does with a NULL and no mock of the
     database would have reproduced it. */
  const undated = { ...MEETING_FULL, id: 'tr_nodate', title: 'No readable instant', dateString: '', date: 0 };
  /* The raw answerer, not the honouring one: `serve` has to place a fixture in
     time to apply `fromDate`, so it is the one server that CANNOT hand over a
     meeting with no time. That is the shape a real vendor sends when a field
     stops populating, and it is the whole subject here. */
  const mock = await graphqlServer(t, ok([MEETING_FULL, undated]));
  const { ctx, emitted } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);
  const rows = result.parts[0].rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(emitted, [{ message: 'Team meetings: 2 meetings', done: 2, total: 2 }]);

  const db = freshDb();
  upsertMessages(db, rows.map((r) => ({ ...r, sourceId: 's_nodate' })));

  const sinceISO = new Date(Date.parse(NOW) - 21 * 86_400_000).toISOString();
  const seen = listMessages(db, { sinceISO, limit: 500 }).map((m) => m.subject).sort();
  assert.deepEqual(seen, ['Alder & Vance pre-con', 'No readable instant'],
    'the poll reported two meetings and the prompt was handed one — a null `sent_at` fails `sent_at >= ?` in SQLite, silently');

  /* And the fallback is the read instant rather than an invention: `ctx.now`,
     which is what the sweep is calling this poll. */
  const undatedRow = rows.find((r) => r.messageId === 'fireflies:tr_nodate');
  assert.equal(undatedRow.date, NOW);
});

test('a meeting with no readable time does not drag the cursor to now', async (t) => {
  /* The other half of the fallback, and the reason it is applied in `rowFrom`
     rather than in `meetingDate`. If the high-water mark were read off
     `row.date`, one meeting with no readable instant would push the cursor to
     NOW — and the next poll would ask from now − 6h, so every meeting older
     than six hours that had not been read yet would be skipped for good. The
     cursor moves on the vendor's instant, which for that meeting is nothing. */
  const undated = { ...MEETING_FULL, id: 'tr_nodate', dateString: '', date: 0 };
  // `ok()` for the same reason as the test above: `serve` cannot place an
  // undated meeting in its window, so it is the one thing it will not return.
  const mock = await graphqlServer(t, ok([MEETING_LATER_BUT_LOWER, undated]));
  const { ctx } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);

  assert.equal(result.parts[0].rows.length, 2, 'the undated meeting has to be IN the batch for this to prove anything');
  assert.equal(result.cursor.newestAt, '2026-08-10T17:00:00.000Z',
    'the cursor followed a row whose time was invented, and the next poll would skip everything older than six hours');
});

test('a null inside the transcripts list is skipped, not a crash', async (t) => {
  /* GraphQL nulls a list entry whose non-nullable field failed to resolve, and
     a whole poll — every other meeting in it — must not be lost to one of them.
     The mock is bypassed here because a well-behaved server will not produce
     this; the connector still has to survive one that does. */
  const mock = await graphqlServer(t, ok([null, MEETING_FULL, 'not an object']));
  const { ctx } = ctxFor(transportFor(mock));

  const rows = (await connector.collect(ctx)).parts[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, 'fireflies:tr_0f1e');
});

test('action items survive whether the vendor sends a string or a list', () => {
  const asString = actionItems({ action_items: '- Send the SOV\n* Book the crane\n\n• Sign the change order' });
  const asList = actionItems({ action_items: ['Send the SOV', 'Book the crane', 'Sign the change order'] });
  assert.deepEqual(asString, ['Send the SOV', 'Book the crane', 'Sign the change order']);
  assert.deepEqual(asList, asString, 'guessing wrong here drops the row\'s most valuable field, silently');
  assert.deepEqual(actionItems({}), []);
  assert.deepEqual(actionItems(null), []);
});

test('REGRESSION: a `**Name**` speaker heading keeps both of its asterisks', () => {
  /* The bullet strip read the heading's first `*` as a list bullet, so the AI
     and the stored body got `*Dana Vance**` — the comment above actionItems()
     promises the headings are kept. */
  assert.deepEqual(actionItems({ action_items: '**Dana Vance**\n* Send the SOV\n*Book the crane\n- **Nemo Hale** to sign' }),
    ['**Dana Vance**', 'Send the SOV', 'Book the crane', '**Nemo Hale** to sign']);
  assert.deepEqual(actionItems({ action_items: ['  **Dana Vance**  ', '* Send the SOV'] }),
    ['**Dana Vance**', 'Send the SOV']);
});

test('attendees fold across both lists the vendor sends, on the address', () => {
  assert.deepEqual(attendeesOf(MEETING_FULL), [
    { name: 'Dana Vance', email: 'dana@vance.example' },
    { name: 'Nemo Hale', email: 'nemo@example.com' },
    { name: '', email: 'kit@alder.example' },
  ]);
  assert.deepEqual(attendeesOf({ participants: ['A@Example.com', 'a@example.com'] }),
    [{ name: '', email: 'A@Example.com' }], 'the same person twice is one attendee');
});

test('REGRESSION: a stranger cannot put an unbounded title or attendee list in a row', () => {
  /* `subject` was the collapsed title with no ceiling — measured, a
     300,000-character title reached `messages.subject` whole — and attendeesOf
     folded but never bounded the list or its fields, so `to_json` was limited
     only by the transport's 8 MiB ceiling. A meeting's title and its attendee
     list are settable by anyone who invites the user to a meeting, which is
     this file's own threat posture everywhere else ("a stranger's error text…
     bound it"). The numbers are linear.mjs's. */
  const titled = rowFrom({ id: 'tr_huge', title: 'F'.repeat(300_000), summary: {} }, { folder: 'Fireflies' });
  assert.ok(titled.subject.length <= 200,
    `the subject is ${titled.subject.length} characters — an unbounded title reached the database`);

  const padded = {
    meeting_attendees: Array.from({ length: 500 }, (_, n) => ({
      displayName: `P${n}-`.padEnd(50_000, 'x'),
      email: `p${n}@example.com`,
    })),
  };
  const attendees = attendeesOf(padded);
  assert.ok(attendees.length <= 100, `${attendees.length} attendees reached the row — to_json is a column, not an archive`);
  for (const a of attendees.slice(0, 3)) {
    assert.ok(a.name.length <= 120, `an attendee name of ${a.name.length} characters survived the fold`);
  }
});

test('meetingDate reads either encoding, and neither is a crash', () => {
  assert.equal(Date.parse(meetingDate({ dateString: '2026-08-10T16:00:00.000Z' })), Date.parse('2026-08-10T16:00:00.000Z'));
  assert.equal(Date.parse(meetingDate({ date: Date.parse('2026-08-10T16:00:00.000Z') })), Date.parse('2026-08-10T16:00:00.000Z'));
  assert.equal(meetingDate({}), null);
  assert.equal(meetingDate({ dateString: 'sometime tuesday', date: 'nope' }), null);
});

test('rowFrom leaves the folder to the caller and never invents a from address', () => {
  const row = rowFrom({ id: 'x', title: '', summary: {} }, { folder: 'Sales calls' });
  assert.equal(row.folder, 'Sales calls');
  assert.equal(row.subject, '(untitled meeting)');
  assert.deepEqual(row.from, { name: 'Fireflies', email: '' });
});

/* ================================================================== *
 * 5. The cursor and the window
 * ================================================================== */

test('the first poll asks from the sweep window and no later than now', async (t) => {
  const mock = await graphqlServer(t, meetings(MEETING_OUT_OF_WINDOW));
  const { ctx } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);

  assert.equal(varsOf(mock).from, WINDOW_FROM);
  assert.equal(varsOf(mock).to, NOW,
    'the sweep window reaches 60 days into the future; a meeting that has not happened has no recap');
  assert.equal(result.cursor, null, 'nothing has ever been seen, so there is nothing to remember');

  /* The variables are half the claim and the weaker half. `from` and `to` can
     be perfect while the DOCUMENT spends them on nothing — an argument the
     schema does not have, or no date arguments at all — and the poll then reads
     the whole account every hour and calls it a week. The server above honours
     what it was asked, so the only way this row stays out is if MEETINGS_QUERY
     really did narrow the window. */
  assert.deepEqual(result.parts[0].rows, [],
    'a meeting from three weeks before the window came back, so `fromDate` is not reaching the endpoint');
});

test('a poll resumes from the cursor, minus the window a summary can arrive late in', async (t) => {
  const mock = await graphqlServer(t, meetings());
  const { ctx } = ctxFor(transportFor(mock), { cursor: { newestAt: '2026-08-10T17:00:00.000Z' } });

  const result = await connector.collect(ctx);

  assert.equal(varsOf(mock).from, '2026-08-10T11:00:00.000Z',
    'six hours of overlap is how a recap that was still being generated last poll gets picked up');
  assert.deepEqual(result.cursor, { newestAt: '2026-08-10T17:00:00.000Z' },
    'a poll that found nothing must hand the high-water mark back, not reset it');
});

test('a stale cursor cannot widen the ask beyond the sweep window', async (t) => {
  const mock = await graphqlServer(t, meetings(MEETING_OUT_OF_WINDOW));
  const { ctx } = ctxFor(transportFor(mock), { cursor: { newestAt: '2019-03-01T00:00:00.000Z' } });

  const result = await connector.collect(ctx);
  assert.equal(varsOf(mock).from, WINDOW_FROM,
    'a laptop shut for a year must not ask Fireflies for a year of meetings');
  assert.deepEqual(result.parts[0].rows, [],
    'the 2019 cursor was clamped to the window, and the window is what the endpoint was given');
});

test('a cursor from a previous version is ignored, never obeyed and never fatal', async (t) => {
  /* `kv` outlives the code that wrote it. core/sweep.mjs stores whatever a
     connector hands back and reads it into `ctx.cursor` on the next poll, so
     the first run after an upgrade hands this function a shape from BEFORE the
     upgrade — a bare ISO string, a differently-named key, epoch milliseconds
     where an ISO string now goes. All three have to land on "I have never read
     this source", which is the sweep window: the alternatives are a crash
     inside `new Date(NaN).toISOString()` and, worse, a silent ask from 1970.
     None of this was covered — the guard could be deleted whole and the suite
     stayed green. */
  const mock = await graphqlServer(t, meetings(MEETING_OUT_OF_WINDOW));
  const stale = [
    'v1:2026-08-10T17:00:00.000Z',            // an older release stored a string
    { since: '2026-08-10T17:00:00.000Z' },    // and an older one still named it differently
    { newestAt: 1_760_000_000_000 },          // epoch ms where an ISO string goes now
    { newestAt: 'last tuesday' },             // and something nobody ever wrote on purpose
    [],
    42,
  ];

  for (const cursor of stale) {
    const { ctx } = ctxFor(transportFor(mock), { cursor });
    const result = await connector.collect(ctx);
    assert.equal(varsOf(mock, mock.requests.length - 1).from, WINDOW_FROM,
      `a cursor of ${JSON.stringify(cursor)} was allowed to decide the window`);
    assert.deepEqual(result.parts[0].rows, []);
  }
});

test('the cursor tracks the latest INSTANT, not the highest-sorting string', async (t) => {
  /* Both meetings are on 10 August. `2026-08-10T13:00:00-04:00` is 17:00Z —
     later than 16:00Z — but sorts BELOW `2026-08-10T16:00:00…` as text, and
     `meetingDate` deliberately preserves whatever offset the vendor sent. A
     lexical high-water mark would settle on 16:00Z and re-read the 17:00
     meeting on every poll for as long as it stayed in the window. */
  const mock = await graphqlServer(t, meetings(MEETING_FULL, MEETING_LATER_BUT_LOWER));
  const { ctx } = ctxFor(transportFor(mock));

  const result = await connector.collect(ctx);

  assert.equal(result.cursor.newestAt, '2026-08-10T17:00:00.000Z',
    'the cursor moved to the string that sorts highest rather than the meeting that happened last');
});

test('the meeting count the user configured is what is asked for, clamped to the vendor ceiling', async (t) => {
  /* Sixty meetings inside the window, so every clamp below has more to refuse
     than it asks for. An empty fixture list would let a document that dropped
     `limit` altogether pass all three assertions. */
  const MANY = Array.from({ length: 60 }, (_, n) => ({
    ...MEETING_FULL,
    id: `tr_many_${n}`,
    dateString: new Date(Date.parse('2026-08-05T00:00:00.000Z') + n * 60_000).toISOString(),
    date: Date.parse('2026-08-05T00:00:00.000Z') + n * 60_000,
  }));
  const mock = await graphqlServer(t, serve({ transcripts: MANY }));
  const build = (count) => ctxFor(transportFor(mock), {
    source: { id: 's_ff', label: 'Team meetings', type: 'fireflies', settings: { meetings: count } },
  }).ctx;

  const asked10 = await connector.collect(build(10));
  const asked500 = await connector.collect(build(500));
  const asked0 = await connector.collect(build(0));

  assert.equal(varsOf(mock, 0).limit, 10);
  assert.equal(varsOf(mock, 1).limit, 50, 'Fireflies caps `limit` at 50 and asking for more is a rejected document');
  assert.equal(varsOf(mock, 2).limit, 25, 'a blank or zero setting falls back to the field default');

  /* And the variable is SPENT, not merely sent. A document that computes the
     right `limit` and then never passes it to `transcripts` reads the whole
     account on every poll: 60 rows against a `maxRows` of 100 is silent today
     and a truncation notice the day somebody records their 101st meeting. */
  assert.equal(asked10.parts[0].rows.length, 10, '`limit` is in the variables but not in the document');
  assert.equal(asked500.parts[0].rows.length, 50);
  assert.equal(asked0.parts[0].rows.length, 25);
});

/* ================================================================== *
 * 6. zelos doctor
 * ================================================================== */

/** Anything network-shaped throws, so a test that reaches one says so loudly. */
const SILENT_DEPS = {
  backend: async () => ({ name: 'macos-keychain', writable: true, note: 'Stored in your login keychain.' }),
  getSecret: async () => KEY,
  listModels: async () => [{ id: 'test-model', label: 'Test model' }],
  testImap: async () => { throw new Error('testImap should not have been called'); },
  testCalDav: async () => { throw new Error('testCalDav should not have been called'); },
};

function doctorConfig() {
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
    sources: [{
      id: 's_ff',
      enabled: true,
      label: 'Team meetings',
      type: 'fireflies',
      keyRef: 'fireflies.s_ff',
      settings: { meetings: 25 },
    }],
    sweep: { intervalMinutes: 60, activeHours: [0, 23], auto: true },
    ui: { accent: '#5b8cff' },
    privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
  };
}

/**
 * Put the connector in the registry for the length of one test.
 *
 * The import line into core/connectors/index.mjs belongs to whoever registers
 * this connector, not to this file — so until it lands, this is how doctor can
 * see it at all. Once it lands, `get('fireflies')` answers and registering
 * again would throw "is registered twice", so the already-there case is a
 * no-op. Either way the assertions below are about the same object.
 */
function withRegistered(t) {
  if (registry.get('fireflies')) return;
  const off = registry.register(connector);
  t.after(off);
}

async function diagnoseAgainst(t, mock) {
  return diagnose({
    config: doctorConfig(),
    deps: {
      ...SILENT_DEPS,
      fetchImpl: (input, init) => {
        const url = new URL(String(input));
        return realFetch(`${mock.origin}${url.pathname}${url.search}`, init);
      },
    },
  });
}

const lineFor = (report, id) => report.checks.find((c) => c.id === id);

test('doctor runs the check and names the account the key belongs to', async (t) => {
  withRegistered(t);
  const mock = await graphqlServer(t, serve({ users: [{ user_id: 'u_1', name: 'Nemo Hale', email: 'nemo@example.com' }] }));

  const report = await diagnoseAgainst(t, mock);
  const line = lineFor(report, 'source.s_ff');

  assert.ok(line, `no line for the source: ${report.checks.map((c) => c.id).join(', ')}`);
  assert.equal(line.status, 'pass', line.detail);
  assert.equal(line.label, 'Fireflies · Team meetings');
  assert.match(line.detail, /Nemo Hale <nemo@example\.com>/,
    'a probe that cannot say WHOSE key this is answers the wrong question');

  assert.equal(mock.requests.length, 1, 'a diagnostic costs one of fifty requests a day');
  assert.equal(mock.requests[0].body.query, WHOAMI_QUERY);
  assert.equal(mock.requests[0].headers.authorization, `Bearer ${KEY}`);
});

test("doctor reports the vendor's own words when the key is refused with a 200", async (t) => {
  withRegistered(t);
  const mock = await graphqlServer(t, JSON.stringify({
    errors: [{ message: 'Please provide a valid API key', extensions: { code: 'unauthenticated' } }],
  }));

  const report = await diagnoseAgainst(t, mock);
  const line = lineFor(report, 'source.s_ff');

  assert.equal(line.status, 'fail',
    'a 200 that means "your key is dead" was reported as a healthy source');
  assert.match(line.detail, /Please provide a valid API key/);
  assert.match(line.action, /app\.fireflies\.ai/, 'a failure with nowhere to go is not a diagnosis');
});

test('doctor says so when the key is valid but names nobody', async (t) => {
  withRegistered(t);
  const mock = await graphqlServer(t, serve({ users: [] }));

  const report = await diagnoseAgainst(t, mock);
  const line = lineFor(report, 'source.s_ff');

  assert.equal(line.status, 'warn');
  assert.match(line.detail, /named no account/);
});
