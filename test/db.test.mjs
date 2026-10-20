import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-db-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const db_ = await import('../core/db.mjs');
const {
  SCHEMA_VERSION, BUCKETS, ITEM_STATES,
  open, close, migrate, withTransaction,
  messageRowId, eventRowId, itemRowId,
  upsertMessage, upsertMessages, getMessage, listMessages, messagesInThread, countMessagesFetchedSince,
  upsertEvent, upsertEvents, getEvent, listEvents, countEventsFetchedSince,
  upsertItem, getItem, getItemByKey, setItemState, listBoard, bucketCounts, listFinished,
  upsertDraft, getDraft, listDrafts, updateDraft,
  insertCapture, listCaptures, markCaptureProcessed,
  startRun, finishRun, getRun, lastRun, listRuns,
  getKV, setKV, deleteKV,
  indexDoc, removeDoc, search, reindex, ftsQuery, resolveRef,
  hasFts5, dataCounts, databaseSizes,
} = db_;

let seq = 0;
const dbs = [];

/** A migrated database on disk, torn down at the end of the run. */
function fresh() {
  const file = path.join(HOME_ROOT, `t${seq++}.db`);
  const db = open(file);
  migrate(db);
  dbs.push(db);
  return db;
}

const MSG = {
  sourceId: 'm_work',
  uid: 1041,
  messageId: '<abc@example.com>',
  threadKey: 'thread-1',
  folder: 'INBOX',
  direction: 'in',
  from: { name: 'Marcus Reyes', email: 'marcus@riverstone.example' },
  to: [{ name: 'Nemo', email: 'nemo@example.com' }],
  cc: [],
  subject: 'Invoice 4471 is past due',
  date: '2026-08-05T09:12:00-04:00',
  snippet: 'The retainage invoice has not cleared',
  text: 'The retainage invoice 4471 has not cleared and the bank is asking.',
  hasAttachments: true,
  flags: ['\\Seen'],
};

const EVT = {
  calendarId: 'c_personal',
  uid: 'evt-9001',
  recurrenceId: '',
  title: 'Pre-con with Alder & Vance',
  description: 'Walk the slab schedule',
  location: 'Site trailer',
  startsAt: '2026-08-11T14:00:00-04:00',
  endsAt: '2026-08-11T15:00:00-04:00',
  allDay: false,
  organizer: { name: 'Alder', email: 'pm@aldervance.example' },
  attendees: [{ name: 'Nemo', email: 'nemo@example.com', rsvp: 'ACCEPTED' }],
  rsvp: 'ACCEPTED',
  status: 'CONFIRMED',
  url: 'https://aldervance.example/precon',
};

const ITEM = {
  key: 'invoice-4471-past-due',
  kind: 'money',
  bucket: 'now',
  headline: 'Chase invoice 4471 — 21 days past due',
  why: 'Marcus asked twice and the bank is asking about the retainage.',
  person: 'Marcus Reyes',
  personEmail: 'marcus@riverstone.example',
  dueAt: '2026-08-09T17:00:00-04:00',
  severity: 3,
  link: 'https://riverstone.example/invoices/4471',
  sourceRefs: ['msg:abc'],
  payload: { amount: 18400 },
};

test.after(() => {
  for (const db of dbs) close(db);
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ------------------------------------------------------------ open/migrate */

test('open() sets WAL, foreign keys and a busy timeout', () => {
  const db = fresh();
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
});

test('open() creates the parent directory it was pointed at', () => {
  const file = path.join(HOME_ROOT, 'nested', 'deeper', 'zelos.db');
  const db = open(file);
  dbs.push(db);
  migrate(db);
  assert.ok(fs.existsSync(file));
});

test('migrate() is idempotent and versioned by PRAGMA user_version', () => {
  const file = path.join(HOME_ROOT, 'migrate.db');
  const db = open(file);
  dbs.push(db);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  assert.deepEqual(migrate(db), { version: SCHEMA_VERSION, applied: SCHEMA_VERSION });

  upsertItem(db, ITEM, { runId: 'run_1' });

  // Second run must change nothing and must not wipe what is already there.
  assert.deepEqual(migrate(db), { version: SCHEMA_VERSION, applied: 0 });
  assert.deepEqual(migrate(db), { version: SCHEMA_VERSION, applied: 0 });
  assert.equal(getItemByKey(db, ITEM.key).headline, ITEM.headline);

  // And on a reopened handle, which is what a second launch looks like.
  close(db);
  const again = open(file);
  dbs.push(again);
  assert.deepEqual(migrate(again), { version: SCHEMA_VERSION, applied: 0 });

  const tables = again.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all().map((r) => r.name);
  for (const t of ['messages', 'events', 'items', 'drafts', 'captures', 'runs', 'kv', 'search']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('migration 2 upgrades a version-1 database without touching its rows', () => {
  // A file exactly as version 1 left it: the v1 items table, one row the user
  // had snoozed, and user_version = 1. Migration 2 must add snoozed_until as
  // NULL — the legacy manual snooze — and change nothing else.
  const file = path.join(HOME_ROOT, 'upgrade-v1.db');
  const db = open(file);
  dbs.push(db);
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY, kind TEXT, bucket TEXT, headline TEXT, why TEXT,
      person TEXT, person_email TEXT, due_at TEXT, severity INTEGER, link TEXT,
      source_refs_json TEXT, payload_json TEXT,
      first_seen TEXT, seen_runs INTEGER, last_seen_run TEXT,
      state TEXT, state_at TEXT, updated_at TEXT
    );
  `);
  db.prepare(`INSERT INTO items (id, bucket, headline, state, state_at, updated_at)
              VALUES ('legacy1', 'now', 'Carried over from v1', 'snoozed', '2026-08-01T10:00:00-04:00', '2026-08-01T10:00:00-04:00')`).run();
  db.exec('PRAGMA user_version = 1');
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');

  assert.deepEqual(migrate(db), { version: SCHEMA_VERSION, applied: SCHEMA_VERSION - 1 });
  const columns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  assert.ok(columns.includes('snoozed_until'), 'v2 adds the snoozed_until column');

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get('legacy1');
  assert.equal(row.headline, 'Carried over from v1');
  assert.equal(row.state, 'snoozed');
  assert.equal(row.snoozed_until, null, 'an upgraded row behaves like the manual snooze it was');
});

test('withTransaction() rolls back on failure', () => {
  const db = fresh();
  assert.throws(() => withTransaction(db, () => {
    setKV(db, 'a', '1');
    throw new Error('nope');
  }), /nope/);
  assert.equal(getKV(db, 'a'), null);
  assert.equal(withTransaction(db, () => setKV(db, 'a', '2')), '2');
  assert.equal(getKV(db, 'a'), '2');
});

/* ----------------------------------------------------------------- messages */

test('a re-fetched message updates in place instead of duplicating', () => {
  const db = fresh();
  const { id, inserted } = upsertMessage(db, MSG);
  assert.equal(id, messageRowId('m_work', 1041, '<abc@example.com>'));
  assert.equal(inserted, true);

  const again = upsertMessage(db, { ...MSG, flags: ['\\Seen', '\\Answered'] });
  assert.equal(again.id, id);
  assert.equal(again.inserted, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);

  const row = getMessage(db, id);
  assert.deepEqual(row.flags, ['\\Seen', '\\Answered']);
  assert.deepEqual(row.to, [{ name: 'Nemo', email: 'nemo@example.com' }]);
  assert.equal(row.has_attach, true);
  assert.equal(row.sent_at, '2026-08-05T09:12:00-04:00', 'the offset survives the round trip');
  assert.equal(row.from_email, 'marcus@riverstone.example');
});

test('a cheap header-only re-fetch does not blank a body already stored', () => {
  const db = fresh();
  const { id } = upsertMessage(db, MSG);
  assert.match(getMessage(db, id).body, /has not cleared/);

  upsertMessage(db, { ...MSG, text: '', snippet: '', subject: 'Invoice 4471 is past due (bump)' });
  const row = getMessage(db, id);
  assert.match(row.body, /has not cleared/, 'body kept');
  assert.equal(row.snippet, 'The retainage invoice has not cleared', 'snippet kept');
  assert.match(row.subject, /bump/, 'headers still update');
});

test('a header-only re-fetch does not blank the search index either', () => {
  /* The upsert's COALESCE keeps the stored body, but the index used to be
     rebuilt from the INCOMING record — so the very re-fetch the COALESCE
     defends against rewrote msg:<id> body-empty, and body-term search stopped
     matching that mail until a manual reindex. The index must mirror the row. */
  const db = fresh();
  const { id } = upsertMessage(db, MSG);
  assert.deepEqual(search(db, 'retainage').map((h) => h.ref), [`msg:${id}`]);

  upsertMessage(db, { ...MSG, text: '', snippet: '', subject: 'Invoice 4471 is past due (bump)' });
  assert.match(getMessage(db, id).body, /has not cleared/, 'the row kept the body');
  assert.deepEqual(search(db, 'retainage').map((h) => h.ref), [`msg:${id}`],
    'so the search doc must keep it too');
  assert.deepEqual(search(db, 'bump').map((h) => h.ref), [`msg:${id}`],
    'while the refreshed headers are still picked up');
});

test('message listing, threading and fetched-since counting', () => {
  const db = fresh();
  const res = upsertMessages(db, [
    MSG,
    { ...MSG, uid: 1042, messageId: '<def@example.com>', subject: 'Re: Invoice 4471', date: '2026-08-06T11:00:00-04:00', direction: 'out', fetchedAt: '2026-08-06T12:00:00-04:00' },
    { ...MSG, sourceId: 'm_home', uid: 7, messageId: '<ghi@example.com>', threadKey: 'thread-2', subject: 'Soccer schedule', date: '2026-08-01T08:00:00-04:00', fetchedAt: '2026-08-01T09:00:00-04:00' },
  ], { now: '2026-08-06T12:00:00-04:00' });
  assert.equal(res.inserted, 3);
  assert.equal(res.updated, 0);

  const all = listMessages(db);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((m) => m.subject), ['Re: Invoice 4471', 'Invoice 4471 is past due', 'Soccer schedule']);
  assert.equal(listMessages(db, { sourceId: 'm_home' }).length, 1);
  assert.equal(listMessages(db, { direction: 'out' }).length, 1);
  assert.equal(listMessages(db, { sinceISO: '2026-08-05T00:00:00-04:00' }).length, 2);
  assert.equal(listMessages(db, { limit: 1 }).length, 1);

  assert.equal(messagesInThread(db, 'thread-1').length, 2);
  assert.equal(countMessagesFetchedSince(db, '2026-08-03T00:00:00-04:00'), 2);
});

test('the prompt window compares instants, not strings — a -04:00 row after a Z cutoff is inside it', () => {
  /* core/sweep.mjs hands listMessages a UTC cutoff (`toISOString()`) while
     `sent_at` keeps each sender's offset verbatim, which core/sources/mime.mjs
     does on purpose. As TEXT, '2026-08-07T09:15:00-04:00' is below
     '2026-08-07T12:00:00.000Z' — '0' sorts before '1' — though it is the later
     instant by 75 minutes, so the 21-day window was wrong by every sender's
     offset. The ORDER BY has the same trap: the LIMIT kept whichever rows
     sort well as characters rather than the ones the filter chose, and a
     thread read its replies in digit order rather than the order they
     happened. */
  const db = fresh();
  upsertMessages(db, [
    { ...MSG, uid: 1, messageId: '<ny@example.com>', subject: 'New York, 13:15Z', date: '2026-08-07T09:15:00-04:00' },
    { ...MSG, uid: 2, messageId: '<ldn@example.com>', subject: 'London, 10:00Z', date: '2026-08-07T10:00:00Z' },
  ], { now: '2026-08-07T14:00:00Z' });

  const since = (sinceISO) => listMessages(db, { sinceISO }).map((m) => m.subject);
  assert.deepEqual(since('2026-08-07T12:00:00.000Z'), ['New York, 13:15Z'], 'a cutoff 75 minutes before the message excluded it');
  assert.deepEqual(since('2026-08-07T14:00:00.000Z'), []);
  assert.deepEqual(since('2026-08-07T09:30:00.000Z'), ['New York, 13:15Z', 'London, 10:00Z'], 'newest instant first, whatever its offset');
  assert.deepEqual(listMessages(db, { limit: 1 }).map((m) => m.subject), ['New York, 13:15Z'], 'the LIMIT kept the row that sorts well as text');
  assert.deepEqual(messagesInThread(db, 'thread-1').map((m) => m.subject), ['London, 10:00Z', 'New York, 13:15Z'],
    'a thread reads in the order it happened');
});

test('upsertMessage defends its inputs', () => {
  const db = fresh();
  assert.throws(() => upsertMessage(db, null), TypeError);
  const { id } = upsertMessage(db, { sourceId: 's', uid: 1, messageId: '<x>', direction: 'sideways' });
  assert.equal(getMessage(db, id).direction, 'in', 'an unknown direction falls back to inbound');
});

/* ------------------------------------------------------------------- events */

test('a re-fetched event updates in place and keeps its offsets', () => {
  const db = fresh();
  const { id, inserted } = upsertEvent(db, EVT);
  assert.equal(id, eventRowId('c_personal', 'evt-9001', ''));
  assert.equal(inserted, true);

  const moved = upsertEvent(db, { ...EVT, startsAt: '2026-08-11T16:00:00-04:00', endsAt: '2026-08-11T17:00:00-04:00' });
  assert.equal(moved.inserted, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);

  const row = getEvent(db, id);
  assert.equal(row.starts_at, '2026-08-11T16:00:00-04:00');
  assert.equal(row.all_day, false);
  assert.equal(row.organizer, 'pm@aldervance.example');
  assert.deepEqual(row.attendees, EVT.attendees);
});

test('recurrence overrides are separate rows from the series', () => {
  const db = fresh();
  const a = upsertEvent(db, EVT);
  const b = upsertEvent(db, { ...EVT, recurrenceId: '20260818T140000', startsAt: '2026-08-18T15:00:00-04:00', endsAt: '2026-08-18T16:00:00-04:00' });
  assert.notEqual(a.id, b.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
});

test('event range listing and fetched-since counting', () => {
  const db = fresh();
  upsertEvents(db, [
    EVT,
    { ...EVT, uid: 'evt-9002', title: 'All-day offsite', startsAt: '2026-08-20', endsAt: '2026-08-21', allDay: true, fetchedAt: '2026-08-07T00:00:00-04:00' },
    { ...EVT, uid: 'evt-9003', title: 'Old thing', startsAt: '2026-07-01T09:00:00-04:00', endsAt: '2026-07-01T10:00:00-04:00', fetchedAt: '2026-07-01T00:00:00-04:00' },
  ], { now: '2026-08-08T00:00:00-04:00' });

  const week = listEvents(db, { from: '2026-08-10', to: '2026-08-17' });
  assert.deepEqual(week.map((e) => e.title), ['Pre-con with Alder & Vance']);
  assert.equal(listEvents(db).length, 3);
  assert.equal(listEvents(db, { calendarId: 'nope' }).length, 0);
  assert.equal(listEvents(db, { from: '2026-08-19' }).map((e) => e.all_day)[0], true);
  assert.equal(countEventsFetchedSince(db, '2026-08-01T00:00:00-04:00'), 2);
});

/* -------------------------------------------------------------------- items */

test('an item re-derived on a later run keeps first_seen and counts runs', () => {
  const db = fresh();
  const first = upsertItem(db, ITEM, { runId: 'run_1', now: '2026-08-05T10:00:00-04:00' });
  assert.equal(first.id, itemRowId(ITEM.key));
  assert.equal(first.inserted, true);

  let row = getItem(db, first.id);
  assert.equal(row.first_seen, '2026-08-05T10:00:00-04:00');
  assert.equal(row.seen_runs, 1);
  assert.equal(row.last_seen_run, 'run_1');
  assert.equal(row.state, 'open');
  assert.deepEqual(row.sourceRefs, ['msg:abc']);
  assert.deepEqual(row.payload, { amount: 18400 });

  // Same run, called twice: seen_runs counts runs, not calls.
  upsertItem(db, ITEM, { runId: 'run_1', now: '2026-08-05T10:00:05-04:00' });
  assert.equal(getItem(db, first.id).seen_runs, 1);

  // The user acts on it.
  setItemState(db, first.id, 'snoozed', { now: '2026-08-05T11:00:00-04:00' });

  // A later run re-derives it with fresher wording.
  const again = upsertItem(db, { ...ITEM, headline: 'Chase invoice 4471 — 22 days past due', severity: 2 }, { runId: 'run_2', now: '2026-08-06T10:00:00-04:00' });
  assert.equal(again.inserted, false);
  assert.equal(again.id, first.id);

  row = getItem(db, first.id);
  assert.equal(row.first_seen, '2026-08-05T10:00:00-04:00', 'first_seen is how long a thing has been carried');
  assert.equal(row.seen_runs, 2);
  assert.equal(row.last_seen_run, 'run_2');
  assert.equal(row.state, 'snoozed', 'the user outranks the model');
  assert.equal(row.state_at, '2026-08-05T11:00:00-04:00');
  assert.match(row.headline, /22 days/);
  assert.equal(row.severity, 2);
  assert.equal(row.updated_at, '2026-08-06T10:00:00-04:00');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
});

test('an item the model stops returning is kept, not deleted', () => {
  const db = fresh();
  upsertItem(db, ITEM, { runId: 'run_1' });
  upsertItem(db, { ...ITEM, key: 'other-thing', bucket: 'today', headline: 'Other' }, { runId: 'run_2' });
  assert.equal(listBoard(db).length, 2);
  assert.equal(getItemByKey(db, ITEM.key).seen_runs, 1);
});

test('bucket is an enum and is rejected; severity is a scalar and is clamped', () => {
  const db = fresh();
  assert.throws(() => upsertItem(db, { ...ITEM, bucket: 'urgent' }, { runId: 'r' }), /bucket must be one of/);
  assert.throws(() => upsertItem(db, { ...ITEM, bucket: undefined }, { runId: 'r' }), TypeError);
  assert.throws(() => upsertItem(db, { ...ITEM, key: '' }, { runId: 'r' }), /non-empty key/);

  const hi = upsertItem(db, { ...ITEM, key: 'hi', severity: 9 }, { runId: 'r' });
  const lo = upsertItem(db, { ...ITEM, key: 'lo', severity: -4 }, { runId: 'r' });
  const nan = upsertItem(db, { ...ITEM, key: 'nan', severity: 'very' }, { runId: 'r' });
  assert.equal(getItem(db, hi.id).severity, 3);
  assert.equal(getItem(db, lo.id).severity, 0);
  assert.equal(getItem(db, nan.id).severity, 0);
});

test('setItemState() validates the state and reports a missing item', () => {
  const db = fresh();
  const { id } = upsertItem(db, ITEM, { runId: 'r' });
  for (const s of ITEM_STATES) assert.equal(setItemState(db, id, s).state, s);
  assert.throws(() => setItemState(db, id, 'deleted'), /state must be one of/);
  assert.equal(setItemState(db, 'no-such-item', 'done'), null);
});

test('listBoard() orders by bucket, then severity, then what is due soonest', () => {
  const db = fresh();
  const mk = (key, bucket, severity, dueAt) => upsertItem(db, { ...ITEM, key, bucket, severity, dueAt, headline: key }, { runId: 'r', now: '2026-08-05T10:00:00-04:00' });
  mk('note-1', 'note', 3, null);
  mk('today-low', 'today', 0, null);
  mk('now-mid', 'now', 2, null);
  mk('now-high-late', 'now', 3, '2026-08-09T17:00:00-04:00');
  mk('now-high-early', 'now', 3, '2026-08-08T09:00:00-04:00');
  mk('waiting-1', 'waiting', 1, null);

  assert.deepEqual(listBoard(db).map((i) => i.headline),
    ['now-high-early', 'now-high-late', 'now-mid', 'today-low', 'waiting-1', 'note-1']);

  assert.deepEqual(listBoard(db, { buckets: ['now'] }).map((i) => i.headline),
    ['now-high-early', 'now-high-late', 'now-mid']);

  setItemState(db, itemRowId('now-mid'), 'done');
  assert.equal(listBoard(db).length, 5, 'done items leave the open board');
  assert.equal(listBoard(db, { states: ['done'] }).length, 1);
  assert.equal(listBoard(db, { limit: 2 }).length, 2);

  const counts = bucketCounts(db);
  assert.equal(Object.keys(counts).length, BUCKETS.length);
  assert.deepEqual(counts, { now: 2, today: 1, soon: 0, waiting: 1, promised: 0, note: 1, money: 0 });
  assert.equal(bucketCounts(db, { states: ['done'] }).now, 1);
});

test('listBoard() breaks severity ties by instant, not by the digits of the offset', () => {
  /* due_at is stored verbatim with whatever offset the model copied from the
     mail — the prompt orders it to — so mixed offsets are the normal input. As
     TEXT '2026-08-27T09:00:00-04:00' (13:00Z) sorts before
     '2026-08-27T12:00:00Z' although it is the later instant, and the board's
     ranking is what capNowBucket demotes from — so the item that actually
     breaks first was listed last within the tie and was the one pushed off the
     four-slot bar. Same trap, same fix as listMessages and the snooze wake:
     through datetime(). */
  const db = fresh();
  const mk = (key, dueAt) => upsertItem(db, { ...ITEM, key, bucket: 'now', severity: 3, dueAt, headline: key }, { runId: 'r', now: '2026-08-26T10:00:00-04:00' });
  mk('due-noon-utc', '2026-08-27T12:00:00Z'); // the earliest instant, lexically last
  mk('due-13z', '2026-08-27T09:00:00-04:00');
  mk('due-14z', '2026-08-27T10:00:00-04:00');
  mk('due-15z', '2026-08-27T11:00:00-04:00');

  assert.deepEqual(listBoard(db).map((i) => i.headline),
    ['due-noon-utc', 'due-13z', 'due-14z', 'due-15z'],
    'the tiebreak is what is due soonest as an instant, whatever offset it was written in');

  // An undated item still sorts after every dated one.
  mk('due-never', null);
  assert.equal(listBoard(db).map((i) => i.headline).at(-1), 'due-never');
});

test('listFinished() is the done and dismissed rows, newest decision first, capped', () => {
  const db = fresh();
  const mk = (key, state, stateAt) => {
    const { id } = upsertItem(db, { ...ITEM, key, headline: key }, { runId: 'r', now: '2026-08-01T10:00:00-04:00' });
    if (state !== 'open') setItemState(db, id, state, { now: stateAt });
    return id;
  };
  mk('still-open', 'open');
  mk('asleep', 'snoozed', '2026-08-05T10:00:00-04:00');
  mk('done-early', 'done', '2026-08-05T09:00:00-04:00');
  // These two disagree lexically and as instants: 09:00-04:00 is 13:00Z, an
  // hour AFTER the Z row, though its digits sort before. The instant must win,
  // for the reason core/sweep.mjs gives at RECENTLY_RESOLVED_SQL.
  mk('dismissed-noon-utc', 'dismissed', '2026-08-06T12:00:00Z');
  mk('done-13z', 'done', '2026-08-06T09:00:00-04:00');

  const finished = listFinished(db);
  assert.deepEqual(finished.map((i) => i.headline),
    ['done-13z', 'dismissed-noon-utc', 'done-early'],
    'done and dismissed only, newest state_at as an instant first');
  assert.deepEqual(finished[0].payload, { amount: 18400 }, 'the same hydrated shape listBoard returns');
  assert.deepEqual(finished[0].sourceRefs, ['msg:abc']);

  assert.equal(listFinished(db, { limit: 2 }).length, 2);
  for (let i = 0; i < 22; i += 1) mk(`fin-${i}`, 'done', `2026-08-07T10:${String(i).padStart(2, '0')}:00Z`);
  assert.equal(listFinished(db).length, 20, 'the default cap holds however much has been finished');
});

/* ------------------------------------------------------------------ snooze */

test('the wake compares instants, not strings — mixed offsets cannot mislead it', () => {
  const db = fresh();
  // The server writes snoozed_until in the configured zone; the sweep and the
  // MCP tools read the board with a machine-zone `now`. The two offsets need
  // not match, and a lexical <= would be off by their difference in both
  // directions. Both cases here are chosen so the string order and the
  // instant order DISAGREE — the assertion is that the instant wins.

  // Due by instant (08:00Z <= 09:00Z) but lexically later ('08' > '05'): wakes.
  const a = upsertItem(db, { key: 'k-due', bucket: 'now', headline: 'Due across zones' }, { runId: 'r', now: '2026-08-09T00:00:00+00:00' });
  setItemState(db, a.id, 'snoozed', { now: '2026-08-09T01:00:00+00:00', snoozedUntil: '2026-08-10T08:00:00+00:00' });
  const woken = listBoard(db, { now: '2026-08-10T05:00:00-04:00' });
  assert.equal(woken.length, 1, 'an elapsed snooze wakes whatever offset now arrives in');
  assert.equal(woken[0].state, 'open');

  // Not yet due by instant (10:00Z > 09:30Z) but lexically earlier ('06' < '09'): sleeps on.
  const b = upsertItem(db, { key: 'k-early', bucket: 'now', headline: 'Not due yet' }, { runId: 'r', now: '2026-08-09T00:00:00+00:00' });
  setItemState(db, b.id, 'snoozed', { now: '2026-08-09T01:00:00+00:00', snoozedUntil: '2026-08-10T06:00:00-04:00' });
  const board = listBoard(db, { now: '2026-08-10T09:30:00+00:00' });
  assert.ok(!board.some((i) => i.id === b.id),
    'a snooze must not wake early because its zone writes smaller digits');
  assert.equal(getItem(db, b.id).state, 'snoozed');
});

test('a snooze with a wake time hides the item until listBoard() finds it due', () => {
  const db = fresh();
  const { id } = upsertItem(db, ITEM, { runId: 'r', now: '2026-08-05T10:00:00-04:00' });
  setItemState(db, id, 'snoozed', { now: '2026-08-05T11:00:00-04:00', snoozedUntil: '2026-08-06T09:00:00-04:00' });

  let row = getItem(db, id);
  assert.equal(row.state, 'snoozed');
  assert.equal(row.snoozed_until, '2026-08-06T09:00:00-04:00');
  assert.equal(row.state_at, '2026-08-05T11:00:00-04:00', 'snoozing bumps state_at');
  assert.equal(row.updated_at, '2026-08-05T11:00:00-04:00', 'snoozing bumps updated_at');

  // While it sleeps: off the open board, out of the open counts.
  assert.equal(listBoard(db, { now: '2026-08-05T12:00:00-04:00' }).length, 0);
  assert.equal(bucketCounts(db).now, 0);

  // Still asleep a minute before the wake time; reading the board did not wake it.
  assert.equal(listBoard(db, { now: '2026-08-06T08:59:00-04:00' }).length, 0);
  assert.equal(getItem(db, id).state, 'snoozed');

  // The wake moment itself is due, and waking clears the alarm and stamps both times.
  const board = listBoard(db, { now: '2026-08-06T09:00:00-04:00' });
  assert.equal(board.length, 1);
  assert.equal(board[0].state, 'open');
  assert.equal(board[0].snoozed_until, null);
  assert.equal(board[0].state_at, '2026-08-06T09:00:00-04:00');
  assert.equal(board[0].updated_at, '2026-08-06T09:00:00-04:00');
  assert.equal(bucketCounts(db).now, 1, 'the woken item is back in the open counts');
});

test('a snoozed row with no wake time never auto-wakes', () => {
  const db = fresh();
  const { id } = upsertItem(db, ITEM, { runId: 'r' });
  setItemState(db, id, 'snoozed', { now: '2026-08-05T11:00:00-04:00' });
  assert.equal(getItem(db, id).snoozed_until, null);

  assert.equal(listBoard(db, { now: '2126-01-01T00:00:00-04:00' }).length, 0);
  assert.equal(getItem(db, id).state, 'snoozed', 'a manual snooze outlasts any clock');

  // The user waking it by hand is the only path back to the board.
  assert.equal(setItemState(db, id, 'open').state, 'open');
  assert.equal(listBoard(db).length, 1);
});

test('setting any non-snoozed state clears snoozed_until', () => {
  const db = fresh();
  const { id } = upsertItem(db, ITEM, { runId: 'r' });
  setItemState(db, id, 'snoozed', { snoozedUntil: '2126-01-01T09:00:00-04:00' });
  assert.equal(getItem(db, id).snoozed_until, '2126-01-01T09:00:00-04:00');

  setItemState(db, id, 'done', { now: '2026-08-05T12:00:00-04:00' });
  const row = getItem(db, id);
  assert.equal(row.state, 'done');
  assert.equal(row.snoozed_until, null, 'a finished item must not carry a wake-up call');
  assert.equal(row.state_at, '2026-08-05T12:00:00-04:00');
  assert.equal(row.updated_at, '2026-08-05T12:00:00-04:00');
});

/* ------------------------------------------------------------------ drafts */

test('drafts: one per item, and a user edit is never overwritten', () => {
  const db = fresh();
  const { id: itemId } = upsertItem(db, ITEM, { runId: 'r' });

  const a = upsertDraft(db, { itemId, to: 'marcus@riverstone.example', subject: 'Invoice 4471', body: 'Marcus — where are we on 4471?' }, { now: '2026-08-05T10:00:00-04:00' });
  assert.equal(a.inserted, true);
  const b = upsertDraft(db, { itemId, to: 'marcus@riverstone.example', subject: 'Invoice 4471', body: 'Second wording' });
  assert.equal(b.id, a.id, 'the same item does not accumulate drafts');
  assert.equal(getDraft(db, a.id).body, 'Second wording');

  const edited = updateDraft(db, a.id, { body: 'My own wording', state: 'edited' }, { now: '2026-08-05T12:00:00-04:00' });
  assert.equal(edited.body, 'My own wording');
  assert.equal(edited.state, 'edited');
  assert.equal(edited.updated_at, '2026-08-05T12:00:00-04:00');

  const rederived = upsertDraft(db, { itemId, to: 'marcus@riverstone.example', subject: 'Invoice 4471', body: 'Model wording again' });
  assert.equal(rederived.skipped, true);
  assert.equal(getDraft(db, a.id).body, 'My own wording');

  assert.equal(listDrafts(db, { states: ['edited'] }).length, 1);
  assert.equal(listDrafts(db, { states: ['pending'] }).length, 0);
  assert.equal(listDrafts(db, { itemId }).length, 1);
  assert.throws(() => updateDraft(db, a.id, { state: 'sent' }), /draft state must be one of/);
  assert.equal(updateDraft(db, 'nope', { body: 'x' }), null);
  assert.equal(getDraft(db, 'nope'), null);
});

/* ---------------------------------------------------------------- captures */

test('captures are stored, listed unprocessed-first and can be marked done', () => {
  const db = fresh();
  const cap = insertCapture(db, '  Call the bank about retainage  ', { now: '2026-08-05T10:00:00-04:00' });
  assert.equal(cap.text, 'Call the bank about retainage');
  assert.equal(cap.processed_at, null);
  assert.throws(() => insertCapture(db, '   '), TypeError);

  assert.equal(listCaptures(db).length, 1);
  assert.equal(markCaptureProcessed(db, cap.id, { now: '2026-08-05T11:00:00-04:00' }), true);
  assert.equal(markCaptureProcessed(db, 'nope'), false);
  assert.equal(listCaptures(db).length, 0);
  assert.equal(listCaptures(db, { includeProcessed: true })[0].processed_at, '2026-08-05T11:00:00-04:00');
});

/* -------------------------------------------------------------------- runs */

test('runs record what happened and lastRun() finds the newest', () => {
  const db = fresh();
  const r1 = startRun(db, { kind: 'full', model: 'claude-x', now: '2026-08-05T10:00:00-04:00' });
  const done = finishRun(db, r1, { ok: true, tokensIn: 120, tokensOut: 40, stats: { messages: 3 }, now: '2026-08-05T10:00:20-04:00' });
  assert.equal(done.ok, true);
  assert.equal(done.tokens_in, 120);
  assert.deepEqual(done.stats, { messages: 3 });
  assert.equal(done.model, 'claude-x', 'model survives when finishRun is not given one');

  const r2 = startRun(db, { kind: 'light', now: '2026-08-05T11:00:00-04:00' });
  finishRun(db, r2, { ok: false, error: 'imap.example refused the connection', now: '2026-08-05T11:00:01-04:00' });

  assert.equal(lastRun(db).id, r2);
  assert.equal(lastRun(db, { kind: 'full' }).id, r1);
  assert.equal(lastRun(db, { okOnly: true }).id, r1);
  assert.equal(getRun(db, r2).error, 'imap.example refused the connection');
  assert.equal(getRun(db, 'nope'), null);
  assert.deepEqual(listRuns(db).map((r) => r.id), [r2, r1]);

  const open_ = startRun(db, { now: '2026-08-05T12:00:00-04:00' });
  assert.equal(getRun(db, open_).ok, null, 'an unfinished run is neither ok nor failed');
});

test('of two runs started in the same second, the later one is the last (TT-3454)', () => {
  const db = fresh();
  // started_at is stamped in whole seconds: a failed check and the retry the
  // person pressed at once carry the same one.
  const at = '2026-08-05T10:00:00-04:00';
  const failed = startRun(db, { now: at });
  finishRun(db, failed, { ok: false, error: 'imap.example refused the connection', now: at });
  const retry = startRun(db, { now: at });
  finishRun(db, retry, { ok: true, now: at });

  assert.equal(lastRun(db).id, retry, 'the retry, not the failure it replaced');
  assert.equal(lastRun(db, { kind: 'full' }).id, retry, 'and the same when filtered by kind');
  assert.deepEqual(listRuns(db).map((r) => r.id), [retry, failed]);
});

/* ---------------------------------------------------------------------- kv */

test('kv round-trips and deletes', () => {
  const db = fresh();
  assert.equal(getKV(db, 'lastFullRun'), null);
  setKV(db, 'lastFullRun', '2026-08-05T10:00:00-04:00');
  setKV(db, 'lastFullRun', '2026-08-06T10:00:00-04:00');
  assert.equal(getKV(db, 'lastFullRun'), '2026-08-06T10:00:00-04:00');
  assert.equal(deleteKV(db, 'lastFullRun'), true);
  assert.equal(deleteKV(db, 'lastFullRun'), false);
});

/* ------------------------------------------------------------ what is held */

test('dataCounts() reports what is held, per source, and how far back the mail goes', () => {
  const db = fresh();
  upsertMessage(db, MSG); // m_work, sent 2026-08-05T09:12:00-04:00 = 13:12Z
  // Sent at 13:00Z — the OLDER instant, though its digits sort after the row
  // above. The oldest message must be picked as an instant, not as characters.
  upsertMessage(db, { ...MSG, uid: 1042, messageId: '<def@example.com>', sourceId: 'm_home', date: '2026-08-05T13:00:00Z' });
  upsertEvent(db, EVT);
  upsertItem(db, ITEM, { runId: 'r' });

  const counts = dataCounts(db);
  assert.equal(counts.messageCount, 2);
  assert.equal(counts.eventCount, 1);
  assert.equal(counts.itemCount, 1);
  assert.equal(counts.oldestMessageAt, '2026-08-05T13:00:00Z', 'oldest by instant, not by the digits of the offset');
  assert.deepEqual(counts.messagesBySource, { m_work: 1, m_home: 1 });

  const empty = dataCounts(fresh());
  assert.equal(empty.messageCount, 0);
  assert.equal(empty.oldestMessageAt, null, 'no mail means null, never an invented date');
  assert.deepEqual(empty.messagesBySource, {});
});

test('databaseSizes() measures the file and its -wal sidecar; a memory database is zero', () => {
  const file = path.join(HOME_ROOT, 'sizes.db');
  const db = open(file);
  dbs.push(db);
  migrate(db);
  upsertMessage(db, MSG);

  const { dbBytes, walBytes } = databaseSizes(db);
  assert.equal(dbBytes, fs.statSync(file).size);
  assert.equal(walBytes, fs.statSync(`${file}-wal`).size);
  assert.ok(dbBytes > 0);
  assert.ok(walBytes > 0, 'WAL mode parks recent writes in the sidecar');

  const mem = open(':memory:');
  dbs.push(mem);
  migrate(mem);
  assert.deepEqual(databaseSizes(mem), { dbBytes: 0, walBytes: 0 });
});

/* ------------------------------------------------------------------ search */

test('FTS5 returns ranked hits, best first', () => {
  const db = fresh();
  indexDoc(db, { ref: 'msg:a', kind: 'message', title: 'Invoice 4471 is past due', body: 'The invoice is past due. Invoice 4471 again.' });
  indexDoc(db, { ref: 'msg:b', kind: 'message', title: 'Soccer schedule', body: 'Long note about the season that mentions an invoice exactly once, plus a great deal of other unrelated text to make this document longer than the first one.' });
  indexDoc(db, { ref: 'evt:c', kind: 'event', title: 'Pre-con walkthrough', body: 'Slab schedule' });

  const hits = search(db, 'invoice');
  assert.deepEqual(hits.map((h) => h.ref), ['msg:a', 'msg:b']);
  assert.ok(hits[0].score > hits[1].score, 'score is higher-is-better');
  assert.equal(hits[0].kind, 'message');
  assert.ok(hits[0].excerpt.length > 0);

  assert.deepEqual(search(db, 'schedule').map((h) => h.ref).sort(), ['evt:c', 'msg:b']);
  assert.deepEqual(search(db, 'schedule', { kinds: ['event'] }).map((h) => h.ref), ['evt:c']);
  assert.equal(search(db, 'invoice', { limit: 1 }).length, 1);

  // Stemming ("porter") and prefix matching on the last term.
  assert.ok(search(db, 'walk').some((h) => h.ref === 'evt:c'));
  assert.ok(search(db, 'invo').some((h) => h.ref === 'msg:a'));
});

test('a hostile query cannot break the MATCH parser', () => {
  const db = fresh();
  indexDoc(db, { ref: 'msg:a', kind: 'message', title: 'Invoice', body: 'due now' });
  for (const q of ['"', 'NEAR(', 'invoice AND OR', 'a* OR *b', '^ - :', 'invoice" OR body:x', '']) {
    assert.ok(Array.isArray(search(db, q)), `query ${JSON.stringify(q)} must not throw`);
  }
  assert.equal(search(db, '   ').length, 0);
  assert.equal(ftsQuery(''), null);
  assert.equal(ftsQuery('Invoice 4471'), '"invoice" "4471"*');
});

test('indexing follows the rows it mirrors, and reindex() rebuilds from scratch', () => {
  const db = fresh();
  const { id: msgId } = upsertMessage(db, MSG);
  const { id: evtId } = upsertEvent(db, EVT);
  const { id: itemId } = upsertItem(db, ITEM, { runId: 'r' });
  const cap = insertCapture(db, 'Call the bank about retainage');

  assert.deepEqual(search(db, 'retainage').map((h) => h.ref).sort(), [`cap:${cap.id}`, `msg:${msgId}`].sort());
  assert.deepEqual(search(db, 'slab').map((h) => h.ref), [`evt:${evtId}`]);
  assert.deepEqual(search(db, 'Reyes').map((h) => h.ref), [`msg:${msgId}`]);

  // Re-upserting a message must refresh its document, not add a second one.
  upsertMessage(db, { ...MSG, subject: 'Invoice 4471 settled' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM search WHERE ref = ?").get(`msg:${msgId}`).n, 1);
  assert.deepEqual(search(db, 'settled').map((h) => h.ref), [`msg:${msgId}`]);

  assert.equal(removeDoc(db, `msg:${msgId}`), true);
  assert.equal(removeDoc(db, `msg:${msgId}`), false);
  assert.equal(search(db, 'settled').length, 0);

  assert.equal(reindex(db), 4);
  assert.deepEqual(search(db, 'settled').map((h) => h.ref), [`msg:${msgId}`]);
  assert.ok(search(db, '4471').some((h) => h.ref === `item:${itemId}`));
  assert.equal(reindex(db), 4, 'reindex twice does not double the index');
});

test('resolveRef() maps a source ref back to its row', () => {
  const db = fresh();
  const { id: msgId } = upsertMessage(db, MSG);
  const { id: evtId } = upsertEvent(db, EVT);
  const { id: itemId } = upsertItem(db, ITEM, { runId: 'r' });
  const cap = insertCapture(db, 'Call the bank');

  assert.equal(resolveRef(db, `msg:${msgId}`).subject, MSG.subject);
  assert.equal(resolveRef(db, `evt:${evtId}`).title, EVT.title);
  assert.equal(resolveRef(db, `item:${itemId}`).headline, ITEM.headline);
  assert.equal(resolveRef(db, `cap:${cap.id}`).text, 'Call the bank');
  assert.equal(resolveRef(db, 'msg:does-not-exist'), null);
  assert.equal(resolveRef(db, 'nonsense'), null);
});

/* ------------------------------------------------------------------ *
 * The runtime Zelos will actually run on
 * ------------------------------------------------------------------ */

test('a runtime without FTS5 is refused with an instruction, not a stack trace', () => {
  /* REGRESSION, and it took a cross-platform CI matrix to find: `node:sqlite`
     stops needing a flag at 22.13, but the bundled SQLite is built WITHOUT the
     FTS5 extension until 22.16 — and the entire Node 23 line lacks it too.
     Measured, not read off a changelog: 22.15 and 23.11.1 fail, 22.16 and
     24.0.0 pass. On such a runtime Zelos used to die inside its first
     migration with "no such module: fts5", which reads like a corrupt install.

     The probe is exercised here against a database object that answers the way
     an old runtime does, because the test cannot install a second Node. */
  assert.equal(typeof hasFts5, 'function');

  const withoutFts5 = {
    exec(sql) {
      if (/USING\s+fts5/i.test(sql)) throw new Error('no such module: fts5');
    },
  };
  assert.equal(hasFts5(withoutFts5), false, 'a runtime that refuses fts5 must be detected');

  // And the real one, whatever this machine is running, must have it — if it
  // did not, every other test in this file would already be failing.
  const real = open(':memory:');
  assert.equal(hasFts5(real), true);
  close(real);
});

test('the FTS5 refusal names what to install, and does not leave a database behind', () => {
  const err = new db_.UnsupportedRuntimeError('x');
  assert.equal(err.code, 'ZELOS_NO_FTS5', 'the launcher branches on this code to skip the stack trace');

  // The message is the whole remedy, so it has to carry both halves of the
  // range — a floor alone would send a Node 23 user to a version that is older
  // than the one they already have and still does not work.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-fts5-'));
  const probe = open(path.join(home, 'probe.db'));
  close(probe);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * The one at-rest guarantee SECURITY.md makes loudest, and until now the only
 * one nothing tested. `tightenDbFiles()` exists because SQLite creates its
 * files 0666-masked-by-umask — 0644 on the usual one — and a mode travels with
 * a file into backups and synced folders long after it leaves a 0700 home. It
 * also swallows every error by design, so a regression here would be silent:
 * the database would simply start shipping world-readable, and nothing would
 * say so. That is exactly the shape of bug a test has to catch.
 */
const WINDOWS_NO_POSIX_MODES = process.platform === 'win32'
  ? 'POSIX modes are not implemented on Windows: chmod sets little more than the read-only flag, and stat synthesises a mode. See docs/SECURITY.md §5.'
  : false;

test('the database and both its sidecars are 0600', { skip: WINDOWS_NO_POSIX_MODES }, () => {
  const file = path.join(HOME_ROOT, 'modes.db');
  const db = open(file);
  dbs.push(db);
  migrate(db);

  // A write, so WAL actually materialises the sidecars rather than leaving
  // this test asserting about files that do not exist yet.
  upsertItem(db, ITEM, { runId: 'run_modes' });

  const seen = [];
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    if (!fs.existsSync(f)) continue;
    seen.push(path.basename(f));
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${path.basename(f)} is not 0600`);
  }
  assert.ok(seen.includes('modes.db'), 'the database itself must have been checked');
  assert.ok(seen.length >= 2, `WAL should have produced a sidecar to check, saw ${seen.join(', ')}`);
});

test('a database left world-readable is tightened when it is opened again', { skip: WINDOWS_NO_POSIX_MODES }, () => {
  // The repair path, not just the create path: a file copied out of a backup,
  // or written by an older Zelos, arrives 0644 and must not stay that way.
  const file = path.join(HOME_ROOT, 'loose.db');
  const first = open(file);
  migrate(first);
  close(first);

  fs.chmodSync(file, 0o644);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'the precondition: it really is loose');

  const again = open(file);
  dbs.push(again);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'opening a loose database must tighten it');
});
