/**
 * test/sample-data.test.mjs — the demo week, and the promise that it leaves.
 *
 * The load-bearing test in this file is the last one in section 3: seed the
 * sample into a database that already has real rows in it, clear it, and assert
 * that every table is back to the exact count it had — and that the user's own
 * rows still read exactly as they did. "One click to clear" is only true if that
 * holds, and it is the sort of thing that quietly stops holding the moment
 * somebody adds a table.
 *
 * Nothing here touches the real ~/.zelos: ZELOS_HOME is a temp dir, set before
 * the modules that read it are imported, and no socket is opened at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-sample-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const sample = await import('../core/sample-data.mjs');
const {
  SAMPLE_VERSION, SAMPLE_MARK, MANIFEST_KEY, SAMPLE_SOURCE_ID, SAMPLE_CALENDAR_ID,
  CAST, SAMPLE_SUMMARY, COUNTED_TABLES,
  sampleWeek, rowCounts, isInstalled, sampleStatus, seedSampleData, clearSampleData,
} = sample;

const dbm = await import('../core/db.mjs');
const {
  open, close, migrate, BUCKETS, ITEM_STATES,
  messageRowId, eventRowId, itemRowId,
  listBoard, bucketCounts, listDrafts, listEvents, listMessages, listCaptures,
  getMessage, getItemByKey, getKV, search, upsertMessage, upsertItem, upsertDraft,
} = dbm;

const time = await import('../core/time.mjs');
const { instant, dayKey, minutesIntoDay, wallClock } = time;

let seq = 0;
const opened = [];

function fresh() {
  const db = open(path.join(HOME_ROOT, `s${seq++}.db`));
  migrate(db);
  opened.push(db);
  return db;
}

test.after(() => {
  for (const db of opened) { try { close(db); } catch { /* already gone */ } }
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ================================================================== *
 * 1. The cast is fiction
 * ================================================================== */

test('every address in the cast is under .example, which cannot resolve to anyone', () => {
  const week = sampleWeek();
  const addresses = new Set();
  for (const p of CAST.people) addresses.add(p.email);
  for (const m of week.messages) {
    addresses.add(m.from.email);
    for (const to of m.to) addresses.add(to.email);
  }
  for (const e of week.events) for (const a of e.attendees) addresses.add(a.email);
  for (const d of week.drafts) addresses.add(d.to);
  for (const i of week.items) if (i.personEmail) addresses.add(i.personEmail);

  assert.ok(addresses.size >= 7);
  for (const address of addresses) {
    assert.match(address, /^[^@\s]+@[a-z0-9.-]+\.example$/, `${address} is not a reserved example address`);
  }
});

test('the cast is a named set the UI can describe honestly', () => {
  assert.equal(CAST.people.length, 6);
  for (const p of CAST.people) {
    assert.ok(p.name && p.email && p.role, JSON.stringify(p));
  }
  assert.ok(CAST.firm.name);
  assert.match(SAMPLE_SUMMARY, /Nobody in it is real/);
});

/* ================================================================== *
 * 2. The week itself
 * ================================================================== */

test('every row the sample writes is marked as sample data in its own text', () => {
  const week = sampleWeek();
  for (const m of week.messages) assert.ok(m.subject.startsWith(SAMPLE_MARK), m.subject);
  for (const e of week.events) assert.ok(e.title.startsWith(SAMPLE_MARK), e.title);
  for (const i of week.items) assert.ok(i.headline.startsWith(SAMPLE_MARK), i.headline);
  for (const d of week.drafts) assert.ok(d.subject.startsWith(SAMPLE_MARK), d.subject);
  for (const c of week.captures) assert.ok(c.startsWith(SAMPLE_MARK), c);
  // And one item exists whose whole job is to say so on the board.
  assert.ok(week.items.some((i) => i.bucket === 'note' && /demo data/i.test(i.headline)));
});

test('the week obeys the board rules the engine would enforce', () => {
  const week = sampleWeek();
  const nowItems = week.items.filter((i) => i.bucket === 'now');
  assert.ok(nowItems.length <= 4, `at most 4 now items, got ${nowItems.length}`);
  assert.ok(week.items.filter((i) => i.bucket === 'today').length <= 10);
  for (const i of week.items) {
    assert.ok(BUCKETS.includes(i.bucket), i.bucket);
    assert.ok(Number.isInteger(i.severity) && i.severity >= 0 && i.severity <= 3);
    assert.ok(i.headline.length <= 90 + SAMPLE_MARK.length, `${i.headline.length}: ${i.headline}`);
    assert.ok(i.why.length <= 240);
    assert.equal(i.payload.sample, true);
  }
  // A draft carrying a bracketed placeholder is rejected by core/triage.mjs.
  // Shipping one in the demo would be shipping something the engine refuses.
  for (const d of week.drafts) {
    assert.ok(!/\[[^\]]+\]/.test(d.body), d.body);
    assert.ok(!/\[[^\]]+\]/.test(d.subject), d.subject);
    assert.ok(d.body.length > 80, 'a demo draft should look like a real one');
  }
});

test('the week files a debt the right way round: nobody is "waiting on" you under They owe you (TT-3529)', () => {
  const week = sampleWeek();
  // `waiting` is "They owe you". An item saying someone is waiting on the
  // user is a debt the user owes, and the board would file it backwards.
  for (const i of week.items.filter((x) => x.bucket === 'waiting')) {
    assert.doesNotMatch(i.headline, /is waiting on|waiting for you|wants? a (yes or no|reply)/i, i.headline);
  }
  // Delphine asked for a yes or no and has not had one: a reply you owe.
  const referral = week.items.find((i) => i.key === 'sample-delphine-referral');
  assert.equal(referral.bucket, 'soon');
  assert.equal(referral.kind, 'reply');
});

test('there is a genuine double-booking: two events that really overlap', () => {
  const week = sampleWeek();
  const overlaps = [];
  for (let i = 0; i < week.events.length; i += 1) {
    for (let j = i + 1; j < week.events.length; j += 1) {
      const a = week.events[i];
      const b = week.events[j];
      const aStart = instant(a.startsAt);
      const aEnd = instant(a.endsAt);
      const bStart = instant(b.startsAt);
      const bEnd = instant(b.endsAt);
      if (aStart < bEnd && bStart < aEnd) overlaps.push([a, b]);
    }
  }
  assert.equal(overlaps.length, 1, 'exactly one clash, so the board has a point to make');
  const [a, b] = overlaps[0];
  assert.equal(dayKey(a.startsAt), dayKey(b.startsAt));
  assert.notEqual(a.location, b.location, 'a clash you can attend twice is not a clash');
  assert.equal(week.conflictAt, a.startsAt);

  // And the board says so, in the one bucket that means "right now".
  const clash = week.items.find((i) => i.kind === 'conflict');
  assert.equal(clash.bucket, 'now');
  assert.equal(clash.severity, 3);
  assert.equal(clash.dueAt, week.conflictAt);
});

test('event times carry an explicit offset and message times are all in the past', () => {
  const now = '2026-08-09T10:15:00-04:00';
  const week = sampleWeek({ now, timezone: 'America/New_York' });
  const nowMs = instant(now);

  for (const e of week.events) {
    for (const iso of [e.startsAt, e.endsAt]) {
      const w = wallClock(iso);
      assert.ok(w, iso);
      assert.match(w.offset ?? '', /^[+-]\d{2}:\d{2}$/, `${iso} lost its offset`);
      assert.equal(w.dateOnly, false);
    }
    assert.ok(instant(e.endsAt) > instant(e.startsAt), `${e.title} ends before it starts`);
  }
  // The clash is at 2pm wall-clock, read off the string the way the calendar does.
  assert.equal(minutesIntoDay(week.conflictAt), 14 * 60);

  for (const m of week.messages) {
    assert.ok(instant(m.date) <= nowMs, `${m.subject} is dated in the future`);
    assert.ok(instant(m.date) > nowMs - 8 * 86_400_000, 'the demo is a week, not an archive');
  }
});

test('the week is built around the day it is asked for, in the zone it is asked for', () => {
  for (const [now, tz] of [
    ['2026-01-15T08:00:00+00:00', 'Europe/London'],
    ['2026-06-15T08:00:00+05:30', 'Asia/Kolkata'],
    ['2026-11-01T08:00:00-04:00', 'America/New_York'],
    ['2026-12-31T23:30:00+13:00', 'Pacific/Auckland'],
  ]) {
    const week = sampleWeek({ now, timezone: tz });
    assert.equal(dayKey(week.conflictAt), dayKey(now), `${tz} put the clash on the wrong day`);
    assert.equal(minutesIntoDay(week.conflictAt), 840);
    for (const e of week.events) assert.ok(instant(e.startsAt) !== null, `${tz}: ${e.startsAt}`);
  }
});

/* ================================================================== *
 * 3. Seed and clear — the whole point
 * ================================================================== */

test('a fresh database says the sample is not installed, and clearing is a no-op', () => {
  const db = fresh();
  assert.equal(isInstalled(db), false);
  const status = sampleStatus(db);
  assert.equal(status.installed, false);
  assert.equal(status.counts, null);

  const before = rowCounts(db);
  const result = clearSampleData(db);
  assert.equal(result.cleared, false);
  assert.deepEqual(rowCounts(db), before, 'clearing nothing must change nothing');
});

test('seeding fills the board, and every table it names', () => {
  const db = fresh();
  const out = seedSampleData(db, { now: '2026-08-09T10:15:00-04:00', timezone: 'America/New_York' });

  assert.equal(out.installed, true);
  assert.equal(out.alreadyInstalled, false);
  assert.equal(out.added.messages.length, 8);
  assert.equal(out.added.events.length, 7);
  assert.equal(out.added.items.length, 8);
  assert.equal(out.added.drafts.length, 2);
  assert.equal(out.added.captures.length, 1);
  assert.equal(out.added.runs.length, 1);

  assert.equal(isInstalled(db), true);
  const status = sampleStatus(db);
  assert.equal(status.installed, true);
  assert.equal(status.version, SAMPLE_VERSION);
  assert.equal(status.counts.events, 7);
  assert.equal(status.seededAt, '2026-08-09T10:15:00-04:00');

  const board = listBoard(db);
  assert.equal(board.length, 8);
  for (const item of board) {
    assert.ok(item.headline.startsWith(SAMPLE_MARK));
    assert.ok(ITEM_STATES.includes(item.state));
  }
  const counts = bucketCounts(db);
  assert.equal(counts.now, 2);
  assert.ok(counts.now <= 4);

  assert.equal(listMessages(db, { sourceId: SAMPLE_SOURCE_ID }).length, 8);
  assert.equal(listEvents(db, { calendarId: SAMPLE_CALENDAR_ID }).length, 7);
  assert.equal(listDrafts(db, { states: ['pending'] }).length, 2);
  assert.equal(listCaptures(db).length, 1);

  // A message the user sent reads as outbound, so "you owe them" works.
  assert.equal(listMessages(db, { sourceId: SAMPLE_SOURCE_ID, direction: 'out' }).length, 2);

  // The drafts hang off the items they belong to.
  const drafts = listDrafts(db);
  assert.ok(drafts.every((d) => getItemByKey(db, 'sample-marked-up-drawings') || getItemByKey(db, 'sample-confirm-timber-window')));
  assert.ok(drafts.some((d) => d.item_id === itemRowId('sample-marked-up-drawings')));

  // And it is findable, which is what Ask reads from.
  const hits = search(db, 'Harrowmere timber');
  assert.ok(hits.length > 0, 'the sample should be searchable');
  assert.ok(search(db, 'sill detail').some((h) => h.ref.startsWith('item:')), 'items go into the index too');
});

test('seeding twice does not double the board', () => {
  const db = fresh();
  seedSampleData(db);
  const after = rowCounts(db);
  const again = seedSampleData(db);
  assert.equal(again.alreadyInstalled, true);
  assert.deepEqual(rowCounts(db), after, 'a second seed must add nothing');
  assert.equal(listBoard(db).length, 8);
});

test('add then clear returns every table to the exact count it had', () => {
  const db = fresh();
  const empty = rowCounts(db);
  assert.deepEqual(Object.keys(empty).sort(), [...COUNTED_TABLES].sort());

  seedSampleData(db);
  const seeded = rowCounts(db);
  for (const table of COUNTED_TABLES) {
    assert.ok(seeded[table] > empty[table], `${table} did not grow`);
  }

  const cleared = clearSampleData(db);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.removed.messages, 8);
  assert.equal(cleared.removed.events, 7);
  assert.equal(cleared.removed.items, 8);
  assert.equal(cleared.removed.drafts, 2);
  assert.equal(cleared.removed.captures, 1);
  assert.equal(cleared.removed.runs, 1);

  assert.deepEqual(rowCounts(db), empty, 'the database must be exactly where it started');
  assert.equal(isInstalled(db), false);
  assert.equal(getKV(db, MANIFEST_KEY), null);
  assert.equal(listBoard(db).length, 0);
  assert.equal(search(db, 'Harrowmere timber').length, 0, 'the FTS index has to come out too');
});

/**
 * The one that matters. A real user does not clear the sample from an empty
 * database — they clear it from the one holding their own mail.
 */
test('clearing leaves real rows exactly as they were', () => {
  const db = fresh();

  const mine = {
    sourceId: 'm_real',
    uid: 4242,
    messageId: '<real@somewhere.example>',
    threadKey: 'real-thread',
    folder: 'INBOX',
    direction: 'in',
    from: { name: 'A Real Person', email: 'real@somewhere.example' },
    to: [{ name: 'Me', email: 'me@somewhere.example' }],
    subject: 'A real message',
    date: '2026-08-07T09:00:00-04:00',
    snippet: 'genuinely mine',
    text: 'This row belongs to the user and must survive everything below.',
  };
  upsertMessage(db, mine);
  upsertItem(db, {
    key: 'real-item',
    kind: 'reply',
    bucket: 'today',
    headline: 'A real thing to do',
    why: 'Because it is mine.',
    severity: 2,
  });

  const before = rowCounts(db);
  const beforeMessage = getMessage(db, messageRowId('m_real', 4242, '<real@somewhere.example>'));
  const beforeItem = getItemByKey(db, 'real-item');

  seedSampleData(db);
  assert.equal(listBoard(db).length, 9, 'the real item and the sample share the board');

  clearSampleData(db);

  assert.deepEqual(rowCounts(db), before);
  assert.deepEqual(getMessage(db, messageRowId('m_real', 4242, '<real@somewhere.example>')), beforeMessage);
  assert.deepEqual(getItemByKey(db, 'real-item'), beforeItem);
  assert.equal(listBoard(db).length, 1);
  assert.ok(search(db, 'genuinely mine').length > 0, 'the real row is still indexed');
});

/**
 * Belt and braces on the identity hash: if a row with a sample id somehow
 * already exists, the seed must leave it alone AND leave it out of the manifest,
 * so the clear cannot delete something it did not create.
 */
test('a pre-existing row that collides with a sample id is never adopted, and never deleted', () => {
  const db = fresh();
  const collidingId = messageRowId(SAMPLE_SOURCE_ID, 9001, '<sample-9001@quillonrow.example>');

  upsertMessage(db, {
    sourceId: SAMPLE_SOURCE_ID,
    uid: 9001,
    messageId: '<sample-9001@quillonrow.example>',
    folder: 'INBOX',
    direction: 'in',
    from: { name: 'Not The Sample', email: 'someone@somewhere.example' },
    to: [],
    subject: 'This was here first',
    date: '2026-08-01T09:00:00-04:00',
    snippet: 'mine',
    text: 'mine',
  });
  const before = rowCounts(db);

  const out = seedSampleData(db);
  assert.ok(!out.added.messages.includes(collidingId), 'the manifest claimed a row it did not insert');
  assert.equal(out.added.messages.length, 7);
  assert.equal(getMessage(db, collidingId).subject, 'This was here first', 'the seed overwrote a real row');

  clearSampleData(db);
  assert.deepEqual(rowCounts(db), before);
  assert.equal(getMessage(db, collidingId).subject, 'This was here first');
});

/**
 * A sweep that ran while the demo was installed can mint items *about* the
 * fictional cast — model output, so the manifest never heard of them and they
 * carry no SAMPLE_MARK. The tell is their source refs: an item citing nothing
 * but sample rows is about nobody real and must go with the fiction; an item
 * holding even one real ref is evidence of real work and must stay.
 */
test('clearing removes model echoes of the fiction and keeps anything with a real ref', () => {
  const db = fresh();
  seedSampleData(db);

  const sampleMsgId = messageRowId(SAMPLE_SOURCE_ID, 9001, '<sample-9001@quillonrow.example>');
  const sampleEvtId = eventRowId(SAMPLE_CALENDAR_ID, 'sample-evt-5001', '');

  upsertMessage(db, {
    sourceId: 'm_real',
    uid: 4242,
    messageId: '<real@somewhere.example>',
    folder: 'INBOX',
    direction: 'in',
    from: { name: 'A Real Person', email: 'real@somewhere.example' },
    to: [],
    subject: 'A real message',
    date: '2026-08-07T09:00:00-04:00',
    snippet: 'genuinely mine',
    text: 'genuinely mine',
  });
  const realMsgId = messageRowId('m_real', 4242, '<real@somewhere.example>');

  // The echo: unmarked, unmanifested, and citing only fiction.
  const echo = upsertItem(db, {
    key: 'echo-rafe-drawings',
    kind: 'mixed',
    bucket: 'today',
    headline: 'Send Rafe Ondrik the marked-up drawings echoword',
    why: 'Minted by a sweep from sample mail.',
    severity: 2,
    sourceRefs: [`msg:${sampleMsgId}`, `evt:${sampleEvtId}`],
  });
  dbm.indexDoc(db, { ref: `item:${echo.id}`, kind: 'item', title: 'drawings echoword', body: '' });
  upsertDraft(db, {
    itemId: echo.id,
    to: 'rafe@thistlebank.example',
    subject: 'Re: drawings',
    body: 'Rafe — the set goes over tonight, no placeholders in here at all.',
    state: 'pending',
  });

  // One sample ref plus one real ref: real work happened, so it stays.
  upsertItem(db, {
    key: 'mixed-refs',
    kind: 'mail',
    bucket: 'today',
    headline: 'Chase the thing both threads mention',
    why: 'One of its sources is genuinely mine.',
    severity: 2,
    sourceRefs: [`msg:${sampleMsgId}`, `msg:${realMsgId}`],
  });

  // No refs at all proves nothing about origin, so it also stays.
  upsertItem(db, {
    key: 'no-refs',
    kind: 'note',
    bucket: 'note',
    headline: 'A thought with no sources',
    why: 'Typed, not derived.',
    severity: 0,
    sourceRefs: [],
  });

  const result = clearSampleData(db);
  assert.equal(result.cleared, true);

  assert.equal(getItemByKey(db, 'echo-rafe-drawings'), null, 'the echo item must go with the fiction');
  assert.equal(listDrafts(db, { itemId: echo.id }).length, 0, 'and its draft with it');
  assert.equal(search(db, 'echoword').length, 0, 'and its search entry');

  const mixed = getItemByKey(db, 'mixed-refs');
  assert.ok(mixed, 'an item with a real ref survives the clear');
  assert.deepEqual(mixed.sourceRefs, [`msg:${sampleMsgId}`, `msg:${realMsgId}`]);
  assert.ok(getItemByKey(db, 'no-refs'), 'an unreferenced item is never guessed at');
  assert.ok(getMessage(db, realMsgId), 'the real message is untouched');
});

test('a corrupt manifest disables the automatic clear rather than deleting at random', () => {
  const db = fresh();
  seedSampleData(db);
  const seeded = rowCounts(db);

  dbm.setKV(db, MANIFEST_KEY, '{not json');
  assert.equal(isInstalled(db), false);
  const result = clearSampleData(db);
  assert.equal(result.cleared, false);
  // Nothing was guessed at: every row is still there, minus nothing.
  assert.deepEqual(rowCounts(db), seeded);
});

test('the sample run is its own kind, so it cannot be mistaken for a real sweep', () => {
  const db = fresh();
  seedSampleData(db);
  const runs = dbm.listRuns(db);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, 'sample');
  assert.equal(runs[0].stats.sample, true);
  // core/sweep.mjs decides light-vs-full from the last *full* run. A sample run
  // must not answer that question, or seeding the demo would suppress a sweep.
  assert.equal(dbm.lastRun(db, { kind: 'full', okOnly: true }), null);
});
