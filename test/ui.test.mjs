/**
 * test/ui.test.mjs — the parts of the UI that can be wrong without anyone
 * noticing until a chip is in the wrong place.
 *
 * Three groups:
 *
 *  1. **Time parity.** The browser cannot import core/time.mjs (the server
 *     serves only ui/ and assets/), so ui/lib/time.js carries a copy of its
 *     display half. This suite imports BOTH and asserts they agree across a
 *     corpus of ISO strings, offsets and DST boundaries. Edit one and not the
 *     other and this goes red — which is the whole reason the copy is allowed
 *     to exist.
 *  2. **Layout maths.** Chip spans, overlap packing and month-cell ordering are
 *     pure functions in ui/lib/format.js, so they are testable without a DOM,
 *     and they are exactly where a calendar silently lies.
 *  3. **Source guards.** No innerHTML anywhere in ui/, no remote URL in the
 *     shipped page, no inline script (the server's CSP has no 'unsafe-inline'
 *     for scripts). These are product guarantees, not style preferences.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

/**
 * A module specifier for a file on disk.
 *
 * import() takes a URL, not a path, and on POSIX an absolute path happens to
 * be an acceptable one. On Windows it is not: 'C:\\…' parses as a URL whose
 * scheme is 'c', and every dynamic import in this file threw at load — which
 * is why the whole file failed on that platform rather than any one test.
 */
const fileUrl = (...parts) => pathToFileURL(path.join(...parts)).href;

/**
 * How many rows a month cell paints, read out of the view that owns it.
 *
 * It is not exported — it is a private layout constant of ui/views/calendar.js
 * and has no business being one — so the boundary test below used to keep its
 * own copy. A constant restated in a second file is a constant that can drift,
 * and this one is load-bearing prose: conflictsFirst's docstring in
 * ui/lib/format.js says a day with "three or more" all-day entries buries a
 * clash, which is only true while this number is 3. A parser that cannot find
 * it fails loudly rather than falling back to a guess, for the same reason
 * test/router-table.mjs does: a silent default is how the copy got stale.
 */
function monthVisible() {
  const src = fs.readFileSync(path.join(UI, 'views/calendar.js'), 'utf8');
  const m = /\nconst MONTH_VISIBLE = (\d+);/.exec(src);
  if (!m) {
    throw new Error('ui/views/calendar.js no longer declares MONTH_VISIBLE where this reader looks — '
      + 'fix the reader, do not restate the number');
  }
  return Number(m[1]);
}

const core = await import(fileUrl(ROOT, 'core/time.mjs'));
const ui = await import(fileUrl(UI, 'lib/time.js'));
const fmt = await import(fileUrl(UI, 'lib/format.js'));

/* ------------------------------------------------------------ 1. parity */

const CORPUS = [
  '2026-08-11T14:00:00-04:00',
  '2026-08-11T14:00:00+05:30',
  '2026-08-11T00:00:00Z',
  '2026-08-11T23:59:00-08:00',
  '2026-01-01T00:30:00+13:00',
  '2026-03-08T02:30:00-05:00',   // US DST spring-forward morning
  '2026-11-01T01:30:00-04:00',   // fall-back hour
  '2026-12-31T23:00:00+01:00',
  '2026-08-11',                  // all-day, no time part
  '2026-02-29',                  // not a real date; must not throw
  '2026-08-11T14:00',            // no seconds
  '2026-08-11 14:00:00-04:00',   // space separator
  'nonsense',
  '',
];

test('ui/lib/time.js mirrors core/time.mjs — wallClock', () => {
  for (const iso of CORPUS) {
    assert.deepEqual(ui.wallClock(iso), core.wallClock(iso), iso);
  }
  assert.equal(ui.wallClock(null), core.wallClock(null));
  assert.equal(ui.wallClock(undefined), core.wallClock(undefined));
});

test('ui/lib/time.js mirrors core/time.mjs — derived readings', () => {
  for (const iso of CORPUS) {
    assert.equal(ui.dayKey(iso), core.dayKey(iso), `dayKey ${iso}`);
    assert.equal(ui.minutesIntoDay(iso), core.minutesIntoDay(iso), `minutesIntoDay ${iso}`);
    assert.equal(ui.instant(iso), core.instant(iso), `instant ${iso}`);
    assert.equal(ui.formatTime(iso), core.formatTime(iso), `formatTime ${iso}`);
    assert.equal(ui.formatDay(iso), core.formatDay(iso), `formatDay ${iso}`);
  }
});

test('ui/lib/time.js mirrors core/time.mjs — key arithmetic', () => {
  const keys = ['2026-01-01', '2026-02-28', '2026-03-01', '2026-08-11', '2026-12-31', 'bad'];
  for (const key of keys) {
    assert.equal(ui.weekdayOfKey(key), core.weekdayOfKey(key), `weekdayOfKey ${key}`);
    assert.equal(ui.startOfWeekKey(key), core.startOfWeekKey(key), `startOfWeekKey ${key}`);
    for (const n of [-31, -7, -1, 0, 1, 7, 45]) {
      assert.equal(ui.addDaysToKey(key, n), core.addDaysToKey(key, n), `addDaysToKey ${key} ${n}`);
    }
    for (const other of keys) {
      assert.equal(ui.daysBetweenKeys(key, other), core.daysBetweenKeys(key, other), `daysBetweenKeys ${key} ${other}`);
    }
  }
});

test('ui/lib/time.js mirrors core/time.mjs — offsets, zoning and deltas', () => {
  const at = new Date('2026-08-11T18:00:00Z');
  const winter = new Date('2026-01-11T18:00:00Z');
  for (const tz of ['America/New_York', 'Europe/London', 'Asia/Kolkata', 'UTC', 'Not/AZone']) {
    assert.equal(ui.offsetFor(tz, at), core.offsetFor(tz, at), `offsetFor ${tz}`);
    assert.equal(ui.offsetFor(tz, winter), core.offsetFor(tz, winter), `offsetFor winter ${tz}`);
    assert.equal(ui.toZonedISO(at, tz), core.toZonedISO(at, tz), `toZonedISO ${tz}`);
  }
  for (const raw of ['+05:30', '-0800', 'Z', '', null, 'junk']) {
    assert.equal(ui.offsetMinutes(raw), core.offsetMinutes(raw), `offsetMinutes ${raw}`);
  }
  const now = Date.parse('2026-08-11T12:00:00Z');
  for (const iso of CORPUS) {
    assert.equal(ui.humanDelta(iso, now), core.humanDelta(iso, now), `humanDelta ${iso}`);
  }
  assert.equal(ui.monthName(8), core.monthName(8));
  assert.equal(ui.dayName(0), core.dayName(0));
  assert.equal(ui.localTimezone(), core.localTimezone());
});

test('an offset in the string is read, never re-expressed in the local zone', () => {
  // 2pm in New York is 2pm on that calendar, wherever this test runs.
  const iso = '2026-08-11T14:00:00-04:00';
  assert.equal(ui.minutesIntoDay(iso), 14 * 60);
  assert.equal(ui.dayKey(iso), '2026-08-11');
  // ...and 1am in Auckland is still the 12th there, not the 11th here.
  assert.equal(ui.dayKey('2026-08-12T01:00:00+12:00'), '2026-08-12');
});

/* -------------------------------------------------------- 2. layout maths */

const day = (h, m = 0) => `2026-08-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`;

test('eventSpanOnDay clamps to the day it is asked about', () => {
  const ev = { starts_at: day(9, 30), ends_at: day(11, 0), all_day: false };
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-11'), { start: 570, end: 660, allDay: false });
  assert.equal(fmt.eventSpanOnDay(ev, '2026-08-12'), null);
});

test('eventSpanOnDay splits an event that runs through midnight', () => {
  const ev = {
    starts_at: '2026-08-11T22:30:00-04:00',
    ends_at: '2026-08-12T01:30:00-04:00',
    all_day: false,
  };
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-11'), { start: 1350, end: 1440, allDay: false });
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-12'), { start: 0, end: 90, allDay: false });
});

test('an event ending exactly at midnight does not appear on the next day', () => {
  const ev = {
    starts_at: '2026-08-11T22:00:00-04:00',
    ends_at: '2026-08-12T00:00:00-04:00',
    all_day: false,
  };
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-11'), { start: 1320, end: 1440, allDay: false });
  assert.equal(fmt.eventSpanOnDay(ev, '2026-08-12'), null);
});

test('a zero-length event still gets a visible span', () => {
  const ev = { starts_at: day(9), ends_at: day(9), all_day: false };
  const span = fmt.eventSpanOnDay(ev, '2026-08-11');
  assert.ok(span.end > span.start);
});

test('all-day events own the whole column', () => {
  const ev = { starts_at: '2026-08-11', ends_at: '2026-08-12', all_day: true };
  assert.deepEqual(fmt.eventSpanOnDay(ev, '2026-08-11'), { start: 0, end: 1440, allDay: true });
});

/**
 * The end of an all-day event is RFC 5545's exclusive DTEND — the day after the
 * last one covered — so a one-day holiday must not paint across two columns.
 */
test('an all-day event stops before its exclusive end date', () => {
  const oneDay = { starts_at: '2026-08-11', ends_at: '2026-08-12', all_day: true };
  assert.equal(fmt.eventSpanOnDay(oneDay, '2026-08-12'), null);

  const fiveDays = { starts_at: '2026-08-07', ends_at: '2026-08-12', all_day: true };
  const covered = ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12']
    .filter((key) => fmt.eventSpanOnDay(fiveDays, key));
  assert.deepEqual(covered, ['2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11']);

  // A calendar that writes DTEND == DTSTART is malformed, but it still means
  // "this one day" — it must not vanish.
  const degenerate = { starts_at: '2026-08-11', ends_at: '2026-08-11', all_day: true };
  assert.deepEqual(fmt.eventSpanOnDay(degenerate, '2026-08-11'), { start: 0, end: 1440, allDay: true });
});

test('packColumns: non-overlapping events all take the full width', () => {
  const packed = fmt.packColumns([
    { start: 540, end: 600 },
    { start: 600, end: 660 },
    { start: 700, end: 730 },
  ]);
  assert.deepEqual(packed.map((p) => [p.col, p.cols]), [[0, 1], [0, 1], [0, 1]]);
});

test('packColumns: a cluster is divided only among its own members', () => {
  // Two overlapping in the morning, two overlapping in the afternoon. Four
  // quarter-width columns would be the bug this exists to prevent.
  const packed = fmt.packColumns([
    { start: 540, end: 660, id: 'a' },
    { start: 600, end: 700, id: 'b' },
    { start: 840, end: 900, id: 'c' },
    { start: 850, end: 950, id: 'd' },
  ]);
  const by = Object.fromEntries(packed.map((p) => [p.id, p]));
  assert.deepEqual([by.a.col, by.a.cols], [0, 2]);
  assert.deepEqual([by.b.col, by.b.cols], [1, 2]);
  assert.deepEqual([by.c.col, by.c.cols], [0, 2]);
  assert.deepEqual([by.d.col, by.d.cols], [1, 2]);
});

test('packColumns: a freed column is reused before a new one is opened', () => {
  const packed = fmt.packColumns([
    { start: 0, end: 60, id: 'a' },
    { start: 30, end: 90, id: 'b' },
    { start: 60, end: 120, id: 'c' },   // a has ended: c belongs in column 0
  ]);
  const by = Object.fromEntries(packed.map((p) => [p.id, p]));
  assert.equal(by.c.col, 0);
  assert.equal(by.c.cols, 2);
});

test('packColumns: a triple booking gets three columns', () => {
  const packed = fmt.packColumns([
    { start: 660, end: 720 },
    { start: 670, end: 730 },
    { start: 680, end: 700 },
  ]);
  assert.deepEqual(packed.map((p) => p.col).sort(), [0, 1, 2]);
  assert.ok(packed.every((p) => p.cols === 3));
});

test('conflictsFirst puts a clash above a quiet earlier event', () => {
  const ordered = fmt.conflictsFirst([
    { start: 480, end: 540, id: 'early-and-quiet' },
    { start: 660, end: 720, id: 'clash-a' },
    { start: 670, end: 700, id: 'clash-b' },
    { start: 900, end: 960, id: 'late-and-quiet' },
  ]);
  assert.deepEqual(ordered.slice(0, 2).map((e) => e.id), ['clash-a', 'clash-b']);
  assert.equal(ordered[0].conflict, true);
  assert.equal(ordered[2].conflict, false);
  // Truncating to three rows must still show both halves of the clash.
  assert.ok(ordered.slice(0, 3).filter((e) => e.conflict).length === 2);
});

test('conflictsFirst leaves a quiet day in time order', () => {
  const ordered = fmt.conflictsFirst([
    { start: 900, end: 960, id: 'c' },
    { start: 480, end: 540, id: 'a' },
    { start: 660, end: 700, id: 'b' },
  ]);
  assert.deepEqual(ordered.map((e) => e.id), ['a', 'b', 'c']);
});

test('an all-day event is not a clash with the day it fills', () => {
  // eventSpanOnDay hands an all-day event minutes 0–1440, so in the overlap
  // pass it overlapped everything: one birthday flagged every event on the day
  // and the month cell painted "clash" over a day where nothing clashes.
  const ordered = fmt.conflictsFirst([
    { start: 0, end: 1440, allDay: true, id: 'holiday' },
    { start: 540, end: 555, id: 'standup' },
  ]);
  assert.deepEqual(ordered.map((e) => e.conflict), [false, false]);
  assert.equal(ordered.some((e) => e.conflict), false, 'nothing overlaps; the cell must not flag one');
});

test('a holiday does not bury the double booking underneath it', () => {
  // The harm is the inverse of the obvious one. When the 0–1440 span made
  // every entry conflict:true the tiebreak went to zero, the sort collapsed to
  // plain start order, and the genuine clash fell behind "+N more". Measured
  // on the shipped code: the three visible rows were HOLIDAY, 8am, 9am.
  const day = [
    { start: 0, end: 1440, allDay: true, id: 'holiday' },
    { start: 480, end: 540, id: '8am' },
    { start: 540, end: 600, id: '9am' },
    { start: 660, end: 720, id: 'clash-a' },
    { start: 670, end: 700, id: 'clash-b' },
  ];
  const ordered = fmt.conflictsFirst(day);
  assert.deepEqual(ordered.slice(0, 3).map((e) => e.id), ['holiday', 'clash-a', 'clash-b']);
  // ...and the all-day entry keeps the top of the cell, where a day-long thing
  // belongs, without claiming to collide with anything.
  assert.equal(ordered[0].allDay, true);
  assert.equal(ordered[0].conflict, false);
});

test('three all-day banners do bury the clash, and the cell badge is what stops it going quiet', () => {
  // The boundary of what conflictsFirst promises, pinned so the docstring above
  // it cannot drift back into promising more. All-day entries sort above
  // everything and MONTH_VISIBLE is 3, so a birthday, a holiday and a PTO day
  // fill the cell and the double booking really is behind "+N more". The
  // sentence that used to sit here — "a conflict cannot hide behind +4" — was
  // false for exactly this day.
  //
  // What keeps that honest is monthCell deriving `has-conflict` from
  // `spans.some(s => s.conflict)` over the WHOLE day rather than the visible
  // slice (ui/views/calendar.js:572), which is the reader this flag is for. If
  // that ever narrows to the visible three, this day goes silent, and the
  // second half of this test is what says so.
  const day = [
    { start: 0, end: 1440, allDay: true, id: 'birthday' },
    { start: 0, end: 1440, allDay: true, id: 'holiday' },
    { start: 0, end: 1440, allDay: true, id: 'pto' },
    { start: 480, end: 510, id: '8am' },
    { start: 540, end: 600, id: 'clash-a' },
    { start: 570, end: 630, id: 'clash-b' },
  ];
  const ordered = fmt.conflictsFirst(day);
  // Read, not restated. This line was `const MONTH_VISIBLE = 3;` with
  // `// ui/views/calendar.js:564` beside it — a number owned by another file,
  // copied here next to a line reference that had already drifted two lines.
  // Widening the cell to four rows would have left this test green while the
  // sentence it exists to protect — "three or more", in ui/lib/format.js's
  // docstring for conflictsFirst — became false.
  const MONTH_VISIBLE = monthVisible();
  assert.deepEqual(ordered.slice(0, MONTH_VISIBLE).map((e) => e.id), ['birthday', 'holiday', 'pto'],
    `the month cell shows ${MONTH_VISIBLE} rows, so three banners no longer fill it — `
    + 'conflictsFirst\'s docstring says "three or more" in as many words and now needs rewriting with it');
  assert.equal(ordered.slice(0, MONTH_VISIBLE).some((e) => e.conflict), false,
    'neither half of the clash is visible — which is the thing the docstring must not deny');
  assert.deepEqual(ordered.filter((e) => e.conflict).map((e) => e.id), ['clash-a', 'clash-b'],
    'the flags are still right; it is only the truncation that hides them');
  assert.equal(ordered.some((e) => e.conflict), true,
    'the expression monthCell uses for its badge still fires, so the day is marked even when the pair is not shown');
});

/* ----------------------------------------------------- items and wording */

test('carriedFor says nothing until a thing is genuinely stale', () => {
  const today = '2026-08-11';
  assert.equal(fmt.carriedFor({ first_seen: '2026-08-11T09:00:00-04:00' }, today), null);
  assert.equal(fmt.carriedFor({ first_seen: '2026-08-08T09:00:00-04:00' }, today), null); // 3 days
  // "waiting", not "carried": carried where? was the audit's reaction.
  assert.equal(fmt.carriedFor({ first_seen: '2026-08-07T09:00:00-04:00' }, today), 'waiting 4 days');
  assert.equal(fmt.carriedFor({ first_seen: '2026-07-21T09:00:00-04:00' }, today), 'waiting 3 weeks');
  assert.equal(fmt.carriedFor({ first_seen: '2026-05-01T09:00:00-04:00' }, today), 'waiting 3 months');
  assert.equal(fmt.carriedFor({}, today), null);
});

test('byUrgency: severity, then soonest due, then longest carried', () => {
  const rows = [
    { id: 'low', severity: 0, due_at: null, first_seen: '2026-08-01T00:00:00Z' },
    { id: 'sev3-later', severity: 3, due_at: '2026-08-12T00:00:00Z', first_seen: '2026-08-10T00:00:00Z' },
    { id: 'sev3-sooner', severity: 3, due_at: '2026-08-11T00:00:00Z', first_seen: '2026-08-10T00:00:00Z' },
    { id: 'sev1-old', severity: 1, due_at: null, first_seen: '2026-07-01T00:00:00Z' },
    { id: 'sev1-new', severity: 1, due_at: null, first_seen: '2026-08-09T00:00:00Z' },
  ];
  assert.deepEqual(
    [...rows].sort(fmt.byUrgency).map((r) => r.id),
    ['sev3-sooner', 'sev3-later', 'sev1-old', 'sev1-new', 'low'],
  );
});

test('a dated item beats an undated one at the same severity', () => {
  const dated = { severity: 2, due_at: '2026-08-11T00:00:00Z', first_seen: '2026-08-10T00:00:00Z' };
  const undated = { severity: 2, due_at: null, first_seen: '2026-01-01T00:00:00Z' };
  assert.ok(fmt.byUrgency(dated, undated) < 0);
  assert.ok(fmt.byUrgency(undated, dated) > 0);
});

test('severityOf clamps whatever the model produced', () => {
  assert.equal(fmt.severityOf({ severity: 9 }), 3);
  assert.equal(fmt.severityOf({ severity: -4 }), 0);
  assert.equal(fmt.severityOf({ severity: '2' }), 2);
  assert.equal(fmt.severityOf({ severity: 'urgent!' }), 0);
  assert.equal(fmt.severityOf(null), 0);
});

test('dueLabel is relative near the deadline and absolute far from it', () => {
  const now = Date.parse('2026-08-11T12:00:00Z');
  assert.equal(fmt.dueLabel({ due_at: '2026-08-11T14:00:00Z' }, now), 'due in 2h');
  assert.equal(fmt.dueLabel({ due_at: '2026-08-11T09:00:00Z' }, now), 'due 3h ago');
  assert.match(fmt.dueLabel({ due_at: '2026-08-20T09:00:00-04:00' }, now), /^due Thu, Aug 20/);
  assert.equal(fmt.dueLabel({ due_at: null }, now), '');
  assert.equal(fmt.dueLabel({ due_at: 'not a date' }, now), '');
  assert.equal(fmt.isOverdue({ due_at: '2026-08-11T09:00:00Z' }, now), true);
  assert.equal(fmt.isOverdue({ due_at: '2026-08-11T14:00:00Z' }, now), false);
});

test('every bucket has a label a person can read without decoding', () => {
  for (const bucket of fmt.BUCKETS) {
    assert.equal(typeof fmt.BUCKET_LABEL[bucket], 'string');
    assert.ok(fmt.BUCKET_LABEL[bucket].length > 0, bucket);
    assert.ok(fmt.BUCKET_TAG[bucket].length > 0, bucket);
  }
  // The two the model names badly are the two that matter most.
  assert.equal(fmt.BUCKET_LABEL.waiting, 'They owe you');
  assert.equal(fmt.BUCKET_LABEL.promised, 'You owe them');
});

test('sweepSummary reads as a sentence, and survives a run with no stats', () => {
  // In a person's words — emails, appointments — and without the duration,
  // which reads as a machine readout beside them and lives in the hover title.
  assert.equal(
    fmt.sweepSummary({ stats: { messages: 1, events: 2, items: 3, ms: 8_430 } }),
    '1 email · 2 appointments · 3 items',
  );
  assert.equal(fmt.sweepSummary({ stats: { messages: 214, events: 28 } }), '214 emails · 28 appointments');
  assert.equal(fmt.sweepSummary({ stats: {} }), '');
  assert.equal(fmt.sweepSummary(null), '');
  assert.equal(fmt.sweepDetail({ stats: { ms: 41_800 } }), 'took 41.8s');
  assert.equal(fmt.sweepDetail({ stats: { ms: 40 } }), '', 'a run that died in milliseconds must not say "took 0.0s"');
  assert.equal(fmt.sweepDetail({ stats: {} }), '');
  assert.equal(fmt.sweepDetail(null), '');
});

test('every item wears where it came from, and "derived" wears that nothing was saved', () => {
  // The stamp comes from the stored kind and the receipt count, never the
  // model's prose. A three-receipt item and an unreceipted assertion looked
  // pixel-identical before this — the opposite of how trust should price them.
  assert.deepEqual(fmt.sourceStamp({ kind: 'mail', sourceRefs: ['msg:a', 'msg:b', 'msg:c'] }),
    { text: 'from your mail (3)', derived: false });
  assert.deepEqual(fmt.sourceStamp({ kind: 'mail', sourceRefs: ['msg:a'] }),
    { text: 'from your mail', derived: false });
  assert.deepEqual(fmt.sourceStamp({ kind: 'calendar', sourceRefs: ['evt:a'] }),
    { text: 'from your calendar', derived: false });
  assert.deepEqual(fmt.sourceStamp({ kind: 'capture', sourceRefs: ['cap:a'] }),
    { text: 'from a note you typed', derived: false });
  assert.deepEqual(fmt.sourceStamp({ kind: 'mixed', sourceRefs: ['msg:a', 'evt:b'] }),
    { text: 'from more than one place (2)', derived: false });
  // "derived" is core/triage.mjs's word for "every cited receipt failed to
  // resolve" — the one stamp that must not read like provenance.
  assert.deepEqual(fmt.sourceStamp({ kind: 'derived', sourceRefs: [] }),
    { text: 'no source saved', derived: true });
  // A kind this build does not know makes no claim rather than a wrong one.
  assert.equal(fmt.sourceStamp({ kind: 'item', sourceRefs: [] }), null);
  assert.equal(fmt.sourceStamp(null), null);
});

test('"new" comes from stored timestamps against the last successful check, never wording', () => {
  const run = { ok: true, started_at: '2026-08-11T12:00:00Z' };
  assert.equal(fmt.isNewSince({ state: 'open', first_seen: '2026-08-11T12:30:00Z' }, run), true);
  assert.equal(fmt.isNewSince({ state: 'open', first_seen: '2026-08-11T12:00:00Z' }, run), true,
    'first seen the instant the check started is still that check\'s news');
  assert.equal(fmt.isNewSince({ state: 'open', first_seen: '2026-08-11T11:59:00Z' }, run), false);
  // Only an OPEN item can be news; the model re-citing a snoozed one is not.
  assert.equal(fmt.isNewSince({ state: 'snoozed', first_seen: '2026-08-11T12:30:00Z' }, run), false);
  assert.equal(fmt.isNewSince({ state: 'done', first_seen: '2026-08-11T12:30:00Z' }, run), false);
  // No prior successful check means no mark at all — against a board that has
  // only just learned to look, everything would read as news.
  assert.equal(fmt.isNewSince({ state: 'open', first_seen: '2026-08-11T12:30:00Z' }, null), false);
  assert.equal(fmt.isNewSince({ state: 'open', first_seen: '2026-08-11T12:30:00Z' },
    { ok: false, started_at: '2026-08-11T12:00:00Z' }), false);
  assert.equal(fmt.isNewSince({ state: 'open', first_seen: '2026-08-11T12:30:00Z' },
    { ok: null, started_at: '2026-08-11T12:00:00Z' }), false, 'a check still running has not succeeded yet');
  assert.equal(fmt.isNewSince({ state: 'open', first_seen: null }, run), false);
});

/* -------------------------------------------------------- 3. source guards */

function uiFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(UI);
  return out;
}

test('no file in ui/ can put a string into the DOM as markup', () => {
  // Mail is attacker-controlled and so is the model's output. A single
  // innerHTML in this directory is a cross-site scripting hole with a subject
  // line as its payload.
  const banned = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment)\b/;
  for (const file of uiFiles().filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      // The one permitted mention is prose explaining why there is none.
      if (line.includes('innerHTML') && /^\s*(\*|\/\/)/.test(line)) continue;
      assert.ok(!banned.test(line), `${path.relative(ROOT, file)}:${i + 1} ${line.trim()}`);
    }
  }
});

test('the page loads no remote resources; its one fixed release link is navigation only', () => {
  // Zero CDN, works offline, and the server's CSP would refuse it anyway.
  const remote = /(https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9]/i;
  for (const file of uiFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      if (/^\s*(\*|\/\/|<!--)/.test(line)) continue;      // prose
      if (line.includes('http://www.w3.org/2000/svg')) continue; // an XML namespace, not a fetch
      if (line.includes('hale.example') || line.includes('example.com')) continue; // placeholder copy
      // This exact constant verifies an external link after a user-initiated
      // local API check. maintenance-ui.test proves render makes no request.
      if (file === path.join(UI, 'lib/updates.js')
        && line.trim() === 'const OFFICIAL_RELEASE = (version) => `https://github.com/HoosAI-Platform/zelos/releases/tag/v${version}`;') continue;
      assert.ok(!remote.test(line), `${path.relative(ROOT, file)}:${i + 1} ${line.trim()}`);
    }
  }
});

test('index.html carries no inline script and no inline event handler', () => {
  // The server sends `default-src 'self'` with no script 'unsafe-inline', so an
  // inline script is not merely poor practice here — it silently does nothing.
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'inline <script> block in index.html');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler attribute in index.html');
  assert.match(html, /<script src="\/boot\.js">/);
  assert.match(html, /<script type="module" src="\/app\.js">/);
});

test('the meander is drawn, not downloaded', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.match(css, /--meander:\s*url\("data:image\/svg\+xml/);
  assert.match(css, /mask-image: var\(--meander\)/);
});

test('every disclosure in ui/ hides with [hidden], and the CSS makes that stick', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  // Without this rule any class that sets `display` outranks the UA's
  // [hidden]{display:none} and every collapsed panel is on screen.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('no reveal animation can strand content in a hidden state', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.ok(!/animation-fill-mode:\s*(both|forwards)/.test(css));
  assert.ok(!/opacity:\s*0;[^}]*animation/.test(css));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

/**
 * Both of these were found by driving the running app, and both are silent
 * failures: nothing throws, the page just renders slightly wrong. The guards are
 * on the source because the behaviour they protect needs a layout engine to
 * observe, and a unit test that cannot see one can still keep the mechanism from
 * being reverted to the version that did not work.
 */
test('a clipped calendar chip title is marked as clipped, not cut mid-word', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const chip = /^\.chip-title \{([^}]*)\}/m.exec(css);
  assert.ok(chip, '.chip-title rule is missing');
  // `text-overflow: ellipsis` alone does nothing here: the title wraps, and
  // text-overflow only ever fires on a single line. A wrapped title needs a box
  // clamp or it is cut mid-word with no mark at all.
  assert.match(chip[1], /-webkit-line-clamp:\s*var\(--chip-lines/);
  assert.match(chip[1], /-webkit-box-orient:\s*vertical/);

  const calendar = fs.readFileSync(path.join(UI, 'views/calendar.js'), 'utf8');
  assert.match(calendar, /setProperty\('--chip-lines'/,
    'the line budget must be measured per chip, not copied out of the stylesheet');
});

test('the phone week calendar has exactly one horizontal scroller', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const narrow = /@media \(max-width: 47\.99rem\) \{\s*\n\s*\.cal-grid\.mode-week \{[\s\S]*?\n\}/m.exec(css);
  assert.ok(narrow, 'the narrow week-grid media block is missing');

  // `.cal-scroll` carries `overflow-y: auto` for the 1440-minute body, and CSS
  // Overflow 3 coerces a `visible` on the other axis to `auto` beside it. So
  // `overflow-x: visible` here did not opt the box out of the outer scroller,
  // it made a SECOND one — on a box still at min-width 0 inside a 584px body.
  // Measured in a live Blink at 375px: clientWidth 344 against scrollWidth
  // 584, and dragging the inner scroller to 220 left `.cal-grid` at 0, i.e.
  // 220px of drift between the date header and the time body beneath it.
  assert.ok(!/\.cal-scroll[^{}]*\{[^{}]*overflow-x/.test(narrow[0]),
    '.cal-scroll must not set overflow-x here — next to overflow-y it can only ever be a scroller');

  const sized = /\.cal-grid\.mode-week \.cal-head,[\s\S]*?\{[^{}]*min-width[^{}]*\}/m.exec(narrow[0]);
  assert.ok(sized, 'the min-width group is missing');
  for (const part of ['.cal-head', '.cal-allday', '.cal-scroll', '.cal-body']) {
    assert.ok(sized[0].includes(`.cal-grid.mode-week ${part},`) || sized[0].includes(`.cal-grid.mode-week ${part} {`),
      `${part} must be sized with its siblings, or it drifts out of register with them`);
  }
});

test('the sticky rail re-measures the header instead of trusting the last paint', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  // The rail sticks at `top: var(--topbar-h)`. Nothing repaints on a window
  // resize, so measuring only after a paint leaves that offset stale and the
  // rail slides under the header.
  assert.match(css, /top:\s*var\(--topbar-h\)/);
  assert.match(app, /new ResizeObserver/);
  assert.match(app, /--topbar-h/);
});

/**
 * The surface tokens (--paper, --ground-2, --ground-3) are translucent fills,
 * not colours. Used as a label colour they render at a few percent white and
 * the text disappears — which is exactly what happened to the pressed calendar
 * segment and the today marker: both were legible while those tokens were
 * opaque, and both went invisible the moment the palette turned to glass.
 * Type that sits on a filled accent has its own token.
 */
test('no translucent surface token is used as a text colour', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const surfaces = ['--paper', '--ground-2', '--ground-3', '--accent-wash', '--accent-edge', '--accent-glow'];
  for (const token of surfaces) {
    const misuse = new RegExp(`(?<!-)color:\\s*var\\(${token}\\b`).exec(css);
    assert.equal(misuse, null, `${token} is a surface fill; it cannot be a text colour`);
  }
});

test('anything filled with the raw accent states its own label colour', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.match(css, /--on-accent:\s*color-mix/, 'the on-accent token must exist');

  const offenders = [];
  for (const [, body] of css.matchAll(/\{([^{}]*)\}/g)) {
    // The raw hue as a fill, not one of the washes. A rule with no `color` at
    // all is a decoration — a progress bar, the now-dot — and needs nothing.
    if (!/background(-color)?:\s*var\(--accent\)\s*;/.test(body)) continue;
    if (!/(?<!-)color:\s*/.test(body)) continue;
    if (!/(?<!-)color:\s*var\(--(on-accent|ground)\)/.test(body)) {
      offenders.push(body.replace(/\s+/g, ' ').trim().slice(0, 80));
    }
  }
  assert.deepEqual(offenders, [], 'text on a filled accent must take --on-accent (or --ground)');
});

/* ------------------------------------------------- 4. store and item state */

/**
 * The store and the API client are plain modules with one browser assumption
 * each: api.js reads the session token off `window.location` when it loads.
 * These stubs satisfy exactly that — no DOM is faked, and anything that tries
 * to build one in here fails loudly, because a unit test quietly exercising a
 * pretend layout engine proves nothing about the real one.
 */
function stubBrowserGlobals() {
  if (!globalThis.window) {
    globalThis.window = {
      location: { href: 'http://127.0.0.1:7777/' },
      history: { replaceState() {} },
      addEventListener() {},
    };
  }
  if (!globalThis.sessionStorage) {
    globalThis.sessionStorage = { getItem: () => '', setItem() {}, removeItem() {} };
  }
  if (!globalThis.localStorage) {
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  }
  if (!globalThis.document) {
    globalThis.document = {
      documentElement: { style: { setProperty() {} } },
      // The board's heartbeat reads this and stops while nobody is looking, so
      // the stub has to have an opinion about it.
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      createElement() { throw new Error('these tests must not build DOM'); },
    };
  }
}

/** Let a chain of already-resolved promises settle, without a real timer. */
async function settle() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('itemsInBucket keeps snoozed rows off the panes; snoozedItems carries them', async () => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  store.state.board = {
    ...store.state.board,
    items: [
      { id: 'a', bucket: 'now', state: 'open' },
      { id: 'b', bucket: 'now', state: 'snoozed', snoozed_until: '2026-08-12T09:00:00-04:00' },
      { id: 'c', bucket: 'now', state: 'done' },
      { id: 'd', bucket: 'now', state: 'snoozed', snoozed_until: null },
      { id: 'e', bucket: 'today', state: 'dismissed' },
    ],
  };
  // The regression this pins: a snoozed row used to stay in its bucket, so the
  // pane showed a sleeping item while the count claimed the board was clear.
  assert.deepEqual(store.itemsInBucket('now').map((i) => i.id), ['a']);
  assert.deepEqual(store.itemsInBucket('today').map((i) => i.id), []);
  assert.deepEqual(store.snoozedItems().map((i) => i.id), ['b', 'd']);
});

test('"Worth knowing" is one number, in the rail and in the section it opens', async () => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  store.state.board = {
    ...store.state.board,
    counts: { now: 0, today: 0, soon: 0, waiting: 0, promised: 0, note: 1, money: 0 },
    // The model is instructed to report a quiet day in `notes`, which no
    // bucket count has ever included — so the rail read "Worth knowing 0"
    // beside a section headed "Worth knowing 3", on the ordinary day.
    notes: ['The invoice went out.', 'Nothing else needs you today.', '   ', 7, null],
    items: [{ id: 'n1', bucket: 'note', state: 'open' }],
    drafts: [],
    events: [],
    now: null,
  };
  assert.equal(store.boardNotes().length, 2, 'blank and non-string notes are not notes');
  // The invariant, in the same terms ui/views/now.js builds its heading from.
  assert.equal(
    store.railCounts().note,
    store.boardNotes().length + store.itemsInBucket('note').length,
  );
  assert.equal(store.railCounts().note, 3);

  const now = fs.readFileSync(path.join(UI, 'views/now.js'), 'utf8');
  assert.match(now, /boardNotes\(\)/,
    'the section must count through the same store export the rail does');
  assert.ok(!/state\.board\.notes/.test(now),
    'a second copy of the filter in the view is how the two numbers drifted apart');
});

test('setItemState carries the snooze deadline, and only when one was chosen', async (t) => {
  stubBrowserGlobals();
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  let captured = null;
  globalThis.fetch = async (reqPath, init = {}) => {
    captured = { path: reqPath, body: init.body ? JSON.parse(init.body) : null };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  t.after(() => { delete globalThis.fetch; });

  await api.setItemState('abc', 'snoozed', { until: '2026-08-12T09:00:00-04:00' });
  assert.equal(captured.path, '/api/items/abc/state');
  assert.deepEqual(captured.body, { state: 'snoozed', until: '2026-08-12T09:00:00-04:00' });

  // No deadline chosen: the field is ABSENT, so the server applies its own
  // default rather than being handed a null to interpret.
  await api.setItemState('abc', 'open');
  assert.deepEqual(captured.body, { state: 'open' });

  // An EXPLICIT null is different from absence and must survive the wire: it
  // is how Undo restores a legacy manual snooze — no deadline, wake by hand —
  // without the server upgrading it to tomorrow morning.
  await api.setItemState('abc', 'snoozed', { until: null });
  assert.deepEqual(captured.body, { state: 'snoozed', until: null });
});

/**
 * REGRESSION. core/server.mjs answers an unexpected error with
 * `{error: 'internal error', detail: 'the reason was written to …'}` — the
 * error's own text is deliberately kept out of the response, and `detail` is
 * the one thing the server does say: where to look. api.js stored it on the
 * ApiError and built the message from `error` alone, and every view renders
 * `err.message`, so what reached the screen was the two words "internal
 * error" with no pointer to the terminal or to desktop.log.
 */
test('a 500\'s detail reaches the message a view renders, and a 4xx\'s is left alone', async (t) => {
  stubBrowserGlobals();
  const { api, ApiError } = await import(fileUrl(UI, 'lib/api.js'));
  let answer = null;
  globalThis.fetch = async () => ({ ok: false, status: answer.status, text: async () => JSON.stringify(answer.body) });
  t.after(() => { delete globalThis.fetch; });

  const pointer = 'the reason was written to /tmp/zelos-home/logs/desktop.log';
  answer = { status: 500, body: { error: 'internal error', detail: pointer } };
  await assert.rejects(api.health(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 500);
    assert.equal(err.message, `internal error — ${pointer}`);
    assert.equal(err.detail, pointer, 'and still there on its own for a reader that wants it apart');
    return true;
  });

  // A 4xx's `error` already names the caller's mistake, and its `detail` is
  // structured — the 409's running-sweep status — not prose to append.
  answer = { status: 409, body: { error: 'a sweep is already running', detail: { running: true, mode: 'full' } } };
  await assert.rejects(api.sweep('full'), (err) => {
    assert.equal(err.message, 'a sweep is already running');
    assert.deepEqual(err.detail, { running: true, mode: 'full' });
    return true;
  });
  // ...and a 4xx whose detail IS prose is not joined either: that text is the
  // route's, to render where it chooses.
  answer = { status: 400, body: { error: 'mode must be auto, light or full', detail: 'got "everything"' } };
  await assert.rejects(api.sweep('everything'), (err) => err.message === 'mode must be auto, light or full');

  // A 5xx with no detail — a proxy's, say — is still just its error.
  answer = { status: 502, body: { error: 'bad gateway' } };
  await assert.rejects(api.health(), (err) => err.message === 'bad gateway' && err.detail === null);
});

/**
 * The same rule, other transport. The join above landed in request() and not in
 * openStream's non-ok path, so a 500 on POST /api/ask still painted the two
 * words "internal error" into the answer with the server's one pointer dropped.
 */
test('a stream that fails to open joins the 500\'s detail the way request() does', async (t) => {
  stubBrowserGlobals();
  const { openStream, ApiError } = await import(fileUrl(UI, 'lib/api.js'));
  let answer = null;
  globalThis.fetch = async () => ({ ok: false, status: answer.status, text: async () => JSON.stringify(answer.body) });
  t.after(() => { delete globalThis.fetch; });

  const pointer = 'the reason was written to /tmp/zelos-home/logs/desktop.log';
  answer = { status: 500, body: { error: 'internal error', detail: pointer } };
  await assert.rejects(openStream('/api/ask', { method: 'POST', body: { question: 'x' }, onEvent() {} }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, `internal error — ${pointer}`);
    assert.equal(err.detail, pointer, 'and still there on its own for a reader that wants it apart');
    return true;
  });

  // A 4xx stays its own sentence, and carries its structured detail apart.
  answer = { status: 409, body: { error: 'a sweep is already running', detail: { running: true } } };
  await assert.rejects(openStream('/api/sweep/stream', { onEvent() {} }), (err) => {
    assert.equal(err.message, 'a sweep is already running');
    assert.deepEqual(err.detail, { running: true });
    return true;
  });
});

test('the snooze chooser offers three future deadlines in the configured zone', async () => {
  stubBrowserGlobals();
  const items = await import(fileUrl(UI, 'lib/items.js'));
  const tz = 'America/New_York';
  const noon = Date.parse('2026-08-11T16:00:00Z'); // Tuesday, noon in New York

  const [later, tomorrow, nextWeek] = items.snoozeChoices(tz, noon);
  assert.equal(later.label, 'In 4 hours');
  assert.equal(later.until, ui.toZonedISO(new Date(noon + 4 * 3_600_000), tz));
  assert.equal(tomorrow.until, '2026-08-12T09:00:00-04:00');
  assert.equal(nextWeek.until, '2026-08-17T09:00:00-04:00');
  assert.equal(ui.weekdayOfKey(ui.dayKey(nextWeek.until)), 1, 'next week means a Monday');

  // Each choice prints the clock it is promising. The deadline was always
  // concrete; "Tomorrow morning" only became legible as 9 AM after the click,
  // which is the wrong side of it.
  assert.equal(later.when, '4 PM');
  assert.equal(tomorrow.when, '9 AM');
  assert.equal(nextWeek.when, 'Mon, Aug 17 9 AM');

  // From a Monday, "next week" is the FOLLOWING Monday, not later today.
  const monday = Date.parse('2026-08-10T16:00:00Z');
  const [, , fromMonday] = items.snoozeChoices(tz, monday);
  assert.equal(fromMonday.until, '2026-08-17T09:00:00-04:00');
});

test('a four-hour snooze names the next day when its deadline crosses midnight', async () => {
  stubBrowserGlobals();
  const items = await import(fileUrl(UI, 'lib/items.js'));
  const [later] = items.snoozeChoices('America/New_York', Date.parse('2026-08-12T02:00:00Z'));
  assert.equal(later.until, '2026-08-12T02:00:00-04:00');
  assert.equal(later.label, 'In 4 hours');
  assert.equal(later.when, 'Wed, Aug 12 2 AM');
});

test('a toast dismisses itself, and an action toast is given longer', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  t.mock.timers.enable({ apis: ['setTimeout'] });

  store.notify('saved');
  t.mock.timers.tick(5_900);
  assert.ok(store.state.toast, 'a plain toast must live its whole window');
  t.mock.timers.tick(200);
  assert.equal(store.state.toast, null, 'a plain toast must dismiss itself');

  // A toast with an action must not vanish mid-reach for the button.
  store.notify('Marked done: the invoice', { action: { label: 'Undo', run: () => {} } });
  t.mock.timers.tick(6_500);
  assert.ok(store.state.toast, 'an action toast outlives the plain window');
  t.mock.timers.tick(2_000);
  assert.equal(store.state.toast, null);

  // A replacement restarts the clock along with the message.
  store.notify('one');
  t.mock.timers.tick(4_000);
  store.notify('two');
  t.mock.timers.tick(4_000);
  assert.equal(store.state.toast?.message, 'two', 'the replacement restarted the clock');
  t.mock.timers.tick(2_100);
  assert.equal(store.state.toast, null);
});

test('done raises an Undo that restores the exact prior state, deadline included', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const board = {
    items: [{ id: 'x', bucket: 'now', state: 'snoozed', snoozed_until: '2026-08-12T09:00:00-04:00', headline: 'chase the survey invoice' }],
    counts: {}, events: [], drafts: [], runs: { last: null }, notes: [], first: null, now: null,
  };
  const posts = [];
  globalThis.fetch = async (reqPath, init = {}) => {
    if (init.method === 'POST') posts.push({ path: reqPath, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => (reqPath === '/api/state' ? JSON.stringify(board) : '{}') };
  };
  t.after(() => { delete globalThis.fetch; });
  store.state.board = { ...store.state.board, ...board };

  await store.setItemState('x', 'done');
  assert.deepEqual(posts[0].body, { state: 'done' });
  assert.equal(store.state.toast?.action?.label, 'Undo');

  await store.state.toast.action.run();
  // The undo does not merely reopen the item — it re-snoozes it to the same
  // deadline it had, because that deadline was a decision the user made.
  assert.deepEqual(posts[1].body, { state: 'snoozed', until: '2026-08-12T09:00:00-04:00' });
  store.notify(null);
});

/**
 * The failure rollback used to restore the whole pre-click snapshot. A sweep's
 * `done` → refreshBoard(), and the heartbeat, both replace `state.board.items`
 * while the POST is in flight — so a rollback to the snapshot silently erased
 * whatever they brought, with a toast that explained only the failed tick.
 */
test('a failed action rolls back the one row, not the whole pre-click board', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));

  store.state.board = {
    ...store.state.board,
    items: [{ id: 'x', bucket: 'now', state: 'open', headline: 'chase the survey invoice' }],
  };
  globalThis.fetch = async () => {
    // A refresh lands while the request is out: fresher rows, then the POST fails.
    store.state.board = {
      ...store.state.board,
      items: [
        { id: 'x', bucket: 'now', state: 'open', headline: 'chase the survey invoice' },
        { id: 'y', bucket: 'today', state: 'open', headline: 'the new arrival' },
      ],
    };
    return { ok: false, status: 503, text: async () => '{"error":"the server is not there"}' };
  };
  t.after(() => { delete globalThis.fetch; store.notify(null); });

  await store.setItemState('x', 'done');
  assert.deepEqual(store.state.board.items.map((i) => [i.id, i.state]), [['x', 'open'], ['y', 'open']],
    'the rollback must restore the one row inside the CURRENT items');
});

/* ------------------------------------------ 5. shell behaviour, from source */

/**
 * The behaviours below need a layout engine to observe directly, so — like the
 * chip-clamp and sticky-rail guards above — they are pinned at the source: the
 * mechanism that made the bug impossible must still be present.
 */
test('the capture panel is built once, and no repaint path rebuilds it', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  // Exactly one call site (the one-time chrome build) plus the definition. A
  // second call site means some repaint mints a fresh panel — which is the
  // note-wipe bug: every sweep tick destroyed a half-typed note.
  assert.equal(app.split('capturePanel(').length - 1, 2,
    'capturePanel must have exactly one call site besides its definition');
  const paint = /function paintChrome\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(paint, 'paintChrome is missing');
  assert.ok(!paint[0].includes('capturePanel('), 'paintChrome rebuilds the capture panel');
  assert.match(paint[0], /if \(!chrome\) chrome = buildChrome\(\)/,
    'the chrome must be built once and reused');
});

test('a board-driven re-render defers while a text field in main has focus', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const render = /function render\(\{ force = false \}[\s\S]*?\n\}/m.exec(app);
  assert.ok(render, 'render is missing');
  assert.match(render[0], /editingInMain\(\)/, 'render must check for a focused field');
  assert.match(render[0], /renderQueued = true/, 'a mid-edit render must queue, not run');
  assert.match(app, /document\.addEventListener\('focusout'/, 'the queued render must flush on blur');
});

/**
 * Two holes in the deferral above, both measured on v1.5.0. The guard was
 * gated on `layout === 'chrome'`, so the onboarding flow — which runs the bare
 * skeleton — got no deferral at all: any rev bump rebuilt the whole screen,
 * typed address and open mail card included, even mid-keystroke. And
 * editingInMain() counted only the three text-control tags, so Tab from a
 * field to "Save account" rested focus on a BUTTON and the queued render
 * flushed in that gap — the open editor and everything typed into it gone
 * before the button could be pressed, the result of "Test the connection"
 * written into detached nodes.
 */
test('the deferral covers onboarding, and holds while focus is on a button in an open editor', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const render = /function render\(\{ force = false \}[\s\S]*?\n\}/m.exec(app);
  assert.ok(render, 'render is missing');
  assert.match(render[0], /\(layout === 'chrome' \|\| layout === 'bare'\)/,
    'the deferral must cover the onboarding skeleton, not only the chrome one');

  const editing = /function editingInMain\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(editing, 'editingInMain is missing');
  // Focus INSIDE an open editor still counts as editing; focus anywhere else
  // in main — an item row's tick, a panel-level button — still flushes,
  // because those hold no half-finished typing to protect.
  assert.match(editing[0], /closest\('form, \.account-form'\)/,
    'focus inside an open editor must still count as editing');
});

test('view navigation resets the scroll; same-view re-renders leave it alone', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const onRoute = /function onRoute\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(onRoute, 'onRoute is missing');
  assert.match(onRoute[0], /window\.scrollTo\(0, 0\)/);
  assert.match(onRoute[0], /before !== route\.view/,
    'the reset must be gated on the view actually changing');

  // Two call sites, and exactly two: onRoute above, and the skeleton handover
  // in render() — leaving onboarding for the board is a navigation in
  // everything but the hash, and onRoute cannot see it because the view name is
  // 'now' on both sides. Anything beyond those two is a repaint moving the
  // page under a reader, which is its own bug: a deferred board refresh that
  // yanks the scroll to the top is exactly the thing this guard is here for.
  assert.equal(app.split('scrollTo').length - 1, 2);
  const handover = /if \(layout !== 'chrome'\) \{[\s\S]*?\n  \}/m.exec(app);
  assert.ok(handover, 'the skeleton handover branch is missing');
  assert.match(handover[0], /window\.scrollTo\(0, 0\)/,
    'the second call site must be the skeleton handover, not a repaint');
  for (const fn of ['paintChrome', 'flushQueuedRender', 'paintSweepLine']) {
    const body = new RegExp(`function ${fn}\\([^)]*\\)[\\s\\S]*?\\n\\}`, 'm').exec(app);
    assert.ok(body, `${fn} is missing`);
    assert.ok(!body[0].includes('scrollTo'), `${fn} must not move the scroll`);
  }
});

test('exactly one document-level keydown listener, and it closes the note panel', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  assert.equal(app.split("document.addEventListener('keydown'").length - 1, 1);
  assert.match(app, /e\.key !== 'Escape'/);
});

test('the calendar empty state is a claim about the config AND an empty board', () => {
  const cal = fs.readFileSync(path.join(UI, 'views/calendar.js'), 'utf8');
  // "No calendar connected" while a calendar is connected was the lie; a
  // connected calendar with a quiet fortnight must still get its grid. But the
  // config cannot be the whole story: the demo seeds a week of events without
  // writing any config entry, and a demo board deserves its grid too. So the
  // setup card appears only when BOTH are empty.
  assert.match(cal, /\(state\.config\?\.calendars\?\.length \|\| 0\) === 0 && !state\.board\.events\.length/);
});

test('the clash flag cannot escape its month cell', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const flag = /^\.month-flag \{([^}]*)\}/m.exec(css);
  assert.ok(flag, '.month-flag rule is missing');
  assert.match(flag[1], /max-width:\s*100%/);
  assert.match(flag[1], /overflow:\s*hidden/);
  assert.match(flag[1], /text-overflow:\s*ellipsis/);
  // The flex row above it must be allowed to shrink, or max-width: 100% is
  // measured against a row that already blew the cell open.
  const row = /^\.month-num-row \{([^}]*)\}/m.exec(css);
  assert.ok(row, '.month-num-row rule is missing');
  assert.match(row[1], /min-width:\s*0/);
});

test('a sweep that lost one source says so, and does not call the run failed', () => {
  const src = fs.readFileSync(path.join(UI, 'views/now.js'), 'utf8');
  // A run that lost ONE source comes back ok:true. The banner returned null
  // unless the WHOLE run had failed, so a revoked app password, a 404'd .ics
  // or a Sent folder that is not called Sent rendered as "Nothing needs you."
  // and nothing else — the board simply got quieter while the app reassured.
  assert.ok(!/if \(!live && !\(last && last\.ok === false\)\) return null;/.test(src),
    'the banner must not be gated on the whole run having failed');
  const trouble = /function sweepTrouble\(\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(trouble, 'sweepTrouble is missing');
  assert.match(trouble[0], /sourcesFailed/, 'the count every sweep writes must have a reader');
  assert.match(trouble[0], /'partial'/);

  const banner = /function failureBanner\(trouble, navigate\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(banner, 'failureBanner is missing');
  // Its own tone and its own sentence. "The last check failed" over a run that
  // read four sources out of five is a lie in the alarming direction, and it
  // sends the reader looking for a broken app instead of a dead password.
  assert.match(banner[0], /The last check could not read everything/);
  assert.match(banner[0], /banner-warn/);
  assert.match(banner[0], /The last check failed/);

  const render = /export function renderNow\(ctx\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(render, 'renderNow is missing');
  assert.match(render[0], /sweepTrouble\(\)/, 'the view has to actually ask');

  // The empty state under the banner has to branch its TITLE, not only its
  // detail. Branching the detail alone left "Nothing on the board yet." as the
  // largest text on the screen after a partial failure, and "yet" is exactly
  // the reassurance the banner exists to withdraw: it tells the reader the
  // board is merely between sweeps. The detail line underneath does not undo a
  // headline.
  const emptyUnderBanner = /body\.appendChild\(banner[\s\S]*?: emptyForContext\(navigate\)\);/m.exec(render[0]);
  assert.ok(emptyUnderBanner, 'the banner/empty-state branch in renderNow is missing');
  const titles = [...emptyUnderBanner[0].matchAll(/title: '([^']*)'/g)].map((m) => m[1]);
  assert.equal(titles.length, 2, 'the two failures must get two titles');
  assert.notEqual(titles[0], titles[1], 'both failures are still using the same headline');
  assert.ok(titles.some((t) => /yet/.test(t)), 'the whole-failure case keeps "yet" — a sweep really is still to come');
  assert.ok(
    titles.filter((t) => /yet/.test(t)).length === 1,
    'the partial-failure title must not say "yet": that sweep finished, and what is missing is what could not be read',
  );
  /* The two assertions above are order-blind, and swapping the two objects
     leaves them both green while putting the reassurance back on exactly the
     case this test exists for. `titles[0]` is the `trouble === 'partial'` arm —
     the first branch of the ternary matched below — so tie the title to its
     arm, not to the pair. */
  assert.ok(
    !/yet/.test(titles[0]),
    `the partial arm is the first ternary branch and it must not be the one that says "yet" (got ${JSON.stringify(titles[0])})`,
  );
  assert.match(emptyUnderBanner[0], /trouble === 'partial'/, 'the branch has to be on the trouble kind');
});

test('the first screen paints its action row whether or not it is in the document', () => {
  const src = fs.readFileSync(path.join(UI, 'views/onboarding.js'), 'utf8');
  const paint = /const paintActions = \(\) => \{[\s\S]*?\n  \};/m.exec(src);
  assert.ok(paint, 'paintActions is missing');
  // It is called synchronously twelve lines before shell() puts `actions` in a
  // tree, so a live-node guard is always false on the pass that matters — and
  // the two probe .finally callbacks that covered for it are gated on
  // module-level caches, so the SECOND build of this screen got neither. The
  // row kept its placeholder: no "Use Ollama and open the board", no "Try it
  // with sample data" (the only way into the sample data anywhere in ui/), no
  // "Choose a model", no demo-week note. watchBoard rebuilds this screen every
  // three minutes, so it emptied itself with nobody touching it.
  assert.ok(!/isConnected/.test(paint[0]),
    'paintActions must not gate on the row being in the document');
  assert.match(src, /Look around with made-up data first/);
  const start = /function startScreen\(rerender, navigate\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(start, 'startScreen is missing');
  assert.match(start[0], /\n {2}paintActions\(\);\n/,
    'the row must be painted on the way out, not only when a probe lands');
});

test('a settings sub-tab change moves focus instead of dropping it on <body>', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const onRoute = /function onRoute\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(onRoute, 'onRoute is missing');
  // A sub-route change still forces replace(main, currentView()), so the
  // .subtab button that was pressed is detached and focus falls to <body> —
  // with aria-selected written onto freshly built nodes nobody is focused on,
  // announced to no one, on all eight panels. Comparing only route.view left
  // it there.
  assert.match(onRoute[0], /beforeSub !== route\.sub/,
    'onRoute must notice a sub-route change, not only a view change');
  assert.match(onRoute[0], /refocusSelectedTab\(\)/);
  assert.ok(onRoute[0].indexOf('render({ force: true })') < onRoute[0].indexOf('refocusSelectedTab()'),
    'focus has to be restored after the rebuild, not before it');

  const refocus = /function refocusSelectedTab\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(refocus, 'refocusSelectedTab is missing');
  assert.match(refocus[0], /\[role="tab"\]\[aria-selected="true"\]/);
  assert.match(refocus[0], /focusQuietly/);
  // A sub-route with no tablist behind it — #/calendar/2026-08-11 — must be
  // left alone. Yanking focus to the top of the page on a date change is this
  // same bug pointed the other way.
  assert.match(refocus[0], /if \(selected\)/);

  // The same-hash branch of navigate() rebuilds the view without a hashchange,
  // so activating the tab you are already on loses focus by the same route
  // while onRoute never runs at all.
  const nav = /function navigate\(hash\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(nav, 'navigate is missing');
  assert.match(nav[0], /refocusSelectedTab\(\)/);
  /* And it has to come second. This assertion used to be presence alone, which
     is order-blind about a defect that is entirely an ordering: refocus reads
     the tab out of the tree render() has just built, so hoisting it above the
     render — a plausible tidy-up, since both lines are about the same view —
     focuses the button that is one line away from being detached and puts the
     orphaning back exactly as it was, with the guard still green. */
  assert.ok(nav[0].indexOf('render({ force: true })') < nav[0].indexOf('refocusSelectedTab()'),
    'focus has to be restored after the rebuild, not before it');
});

/* ------------------------------------------- 6. the overnight window, and
                                                   the things nobody could hear */

/**
 * A bare "due 2026-08-12" is a DAY, not an instant, and `instant()` reads it as
 * UTC midnight because it is the ordering rule. Used as a deadline that made an
 * item turn overdue-red at 8pm the evening before in New York, and read "due
 * 16h ago" for the whole of the day it was actually due. dueInstant() is the
 * deadline reading; instant() is left exactly as the parity suite pins it.
 */
test('dueInstant puts a bare deadline at the end of its own day, in the right zone', () => {
  const tz = 'America/New_York';
  assert.equal(ui.dueInstant('2026-08-12', tz), Date.parse('2026-08-12T23:59:59.999-04:00'));
  // ...and the same date in January lands on the winter offset, not the summer one.
  assert.equal(ui.dueInstant('2026-01-12', tz), Date.parse('2026-01-12T23:59:59.999-05:00'));
  // A due date that names a time is that time, untouched.
  assert.equal(ui.dueInstant('2026-08-12T09:00:00-04:00', tz), Date.parse('2026-08-12T09:00:00-04:00'));
  assert.equal(ui.dueInstant('nonsense', tz), null);
  // The ordering rule is deliberately unchanged.
  assert.equal(ui.instant('2026-08-12'), Date.parse('2026-08-12T00:00:00Z'));
});

test('a bare due date is not overdue during its own day, west of Greenwich', () => {
  const tz = 'America/New_York';
  const item = { due_at: '2026-08-12' };
  // 8:30pm on the 11th — half an hour past the UTC midnight the old reading
  // used, which is where an item due tomorrow started rendering overdue-red.
  assert.equal(fmt.isOverdue(item, Date.parse('2026-08-12T00:30:00Z'), tz), false);
  assert.equal(fmt.isOverdue(item, Date.parse('2026-08-12T13:00:00Z'), tz), false); // 9am, its own day
  assert.equal(fmt.isOverdue(item, Date.parse('2026-08-13T03:00:00Z'), tz), false); // 11pm, still its day
  // Half past midnight: the day it was promised for is over, and now it is late.
  assert.equal(fmt.isOverdue(item, Date.parse('2026-08-13T04:30:00Z'), tz), true);
});

test('a bare due date reads as a day, not as hours since UTC midnight', () => {
  const tz = 'America/New_York';
  const due = { due_at: '2026-08-12' };
  assert.equal(fmt.dueLabel(due, Date.parse('2026-08-12T13:00:00Z'), tz), 'due today');
  assert.equal(fmt.dueLabel(due, Date.parse('2026-08-11T22:00:00Z'), tz), 'due tomorrow');
  assert.equal(fmt.dueLabel(due, Date.parse('2026-08-13T13:00:00Z'), tz), 'due yesterday');
  assert.equal(fmt.dueLabel({ due_at: '2026-08-20' }, Date.parse('2026-08-12T13:00:00Z'), tz), 'due Thu, Aug 20');
  // A deadline that names a time still counts down to it.
  assert.equal(
    fmt.dueLabel({ due_at: '2026-08-11T14:00:00Z' }, Date.parse('2026-08-11T12:00:00Z'), tz),
    'due in 2h',
  );
});

test('the day cost is stated in tokens, or not at all', () => {
  assert.equal(fmt.tokenLine({ in: 12_400, out: 1_120 }), '12k tokens in · 1.1k out');
  // The sweep engine's own field names read the same.
  assert.equal(fmt.tokenLine({ tokensIn: 900, tokensOut: 40 }), '900 tokens in · 40 out');
  // Absence is not zero: an older database, or a machine that has never swept,
  // has nothing to report and must render nothing rather than "0 tokens in".
  assert.equal(fmt.tokenLine(null), '');
  assert.equal(fmt.tokenLine(undefined), '');
  assert.equal(fmt.tokenLine({}), '');
  assert.equal(fmt.tokenLine({ in: 0, out: 0 }), '');
  // A rolling total is only today's while today is still today.
  assert.equal(fmt.tokenLine({ day: '2026-08-11', in: 500, out: 20 }, '2026-08-12'), '');
  assert.equal(fmt.tokenLine({ day: '2026-08-12', in: 500, out: 20 }, '2026-08-12'), '500 tokens in · 20 out');
  // Zelos does not know what anyone pays per token and must never imply it does.
  assert.ok(!/[$€£]/.test(fmt.tokenLine({ in: 12_400, out: 1_120 })));
  assert.equal(fmt.compactCount(999), '999');
  assert.equal(fmt.compactCount(1_050), '1.1k');
  assert.equal(fmt.compactCount(2_400_000), '2.4M');
});

test('a window left open past midnight keeps its date, its now-line and its day', async () => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  store.state.board = {
    ...store.state.board,
    now: '2026-08-11T23:30:00-04:00',
    events: [
      { id: 'tonight', starts_at: '2026-08-11T21:00:00-04:00' },
      { id: 'tomorrow', starts_at: '2026-08-12T09:00:00-04:00' },
    ],
  };
  store.state.boardAt = Date.now() - 3 * 3_600_000;

  // The old nowMark answered {key: null} the moment the clock passed midnight:
  // blank header date, no now-line, no events, and the calendar's "Today"
  // button anchored to yesterday until someone reloaded the page.
  const nm = store.nowMark();
  assert.equal(nm.key, '2026-08-12');
  assert.ok(Math.abs(nm.minutes - 150) < 2, `2:30am, not ${nm.minutes}`);
  assert.deepEqual(store.eventsToday().map((e) => e.id), ['tomorrow']);
});

test('the Calendar count includes continuing appointments and respects exclusive end dates', async () => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  store.state.board = {
    ...store.state.board,
    now: '2026-08-12T09:00:00-04:00',
    events: [
      { id: 'trip', starts_at: '2026-08-11', ends_at: '2026-08-14', all_day: true },
      { id: 'overnight', starts_at: '2026-08-11T23:00:00-04:00', ends_at: '2026-08-12T10:00:00-04:00' },
      { id: 'today', starts_at: '2026-08-12T14:00:00-04:00', ends_at: '2026-08-12T15:00:00-04:00' },
      { id: 'ended', starts_at: '2026-08-11', ends_at: '2026-08-12', all_day: true },
      { id: 'midnight', starts_at: '2026-08-11T23:00:00-04:00', ends_at: '2026-08-12T00:00:00-04:00' },
      { id: 'future', starts_at: '2026-08-13', ends_at: '2026-08-14', all_day: true },
    ],
  };
  store.state.boardAt = Date.now();
  assert.deepEqual(store.eventsToday().map((e) => e.id), ['trip', 'overnight', 'today']);
  assert.equal(store.railCounts().events, 3);
});

test('an untouched window refetches the board on a timer, and stops while hidden', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  t.mock.timers.enable({ apis: ['setInterval'] });

  let fetched = 0;
  const board = {
    items: [], counts: {}, events: [], drafts: [], runs: { last: null },
    notes: [], first: null, now: '2026-08-12T02:30:00-04:00',
  };
  globalThis.fetch = async (reqPath) => {
    if (reqPath === '/api/state') fetched += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(board) };
  };
  t.after(() => {
    delete globalThis.fetch;
    globalThis.document.visibilityState = 'visible';
  });

  store.state.phase = 'ready';
  const stop = store.watchBoard({ intervalMs: 60_000 });
  t.after(stop);

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fetched, 1, 'nothing was refetching the board at all');

  globalThis.document.visibilityState = 'hidden';
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fetched, 1, 'a tab nobody is looking at must not poll');

  globalThis.document.visibilityState = 'visible';
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fetched, 2, 'the heartbeat resumes when the tab comes back');
  assert.equal(store.state.board.now, '2026-08-12T02:30:00-04:00');
});

test('the heartbeat refetches through the store, so it defers like any board change', () => {
  const store = fs.readFileSync(path.join(UI, 'lib/store.js'), 'utf8');
  const watch = /export function watchBoard\([\s\S]*?\n\}/m.exec(store);
  assert.ok(watch, 'watchBoard is missing');
  assert.match(watch[0], /setInterval/);
  assert.match(watch[0], /visibilityState === 'hidden'/, 'a hidden tab must not poll');
  assert.match(watch[0], /visibilitychange/, 'and it must catch up when the tab returns');
  // loadBoard + emit is the same path a finished sweep takes, which is what
  // puts this refresh under the shell's deferred-render rule: a refetch landing
  // while a draft is being typed queues until that field blurs.
  assert.match(watch[0], /await loadBoard\(\)/);
  assert.match(watch[0], /\n\s*emit\(\);/);
  assert.ok(!/notify\(/.test(watch[0]), 'a background refetch must not toast its failures');

  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  assert.match(app, /watchBoard\(\)/, 'the shell never starts the heartbeat');
});

/**
 * The heartbeat's ordinary tick brings back the same board with a newer server
 * clock. `rev` used to bump anyway, and `rev` is in the shell's renderKey — so
 * every three minutes, and on every tab return, the view rebuilt for a board
 * that said nothing new. On the chrome layout the deferral caught the typing
 * case; on the bare one it emptied the onboarding email step under its own
 * cursor, and on a tab return (focus on a link, not a field) no deferral can
 * help — not bumping is the only fix that covers it.
 */
test('a refetch that brings the same board does not bump rev — only `now` moved', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));

  const board = (now, items = []) => ({
    items, counts: {}, events: [], drafts: [], runs: { last: null },
    notes: [], first: null, now,
  });
  let answer = board('2026-08-27T09:00:00-04:00');
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answer) });
  t.after(() => { delete globalThis.fetch; });

  await store.loadBoard();
  const after = store.state.rev;

  answer = board('2026-08-27T09:03:00-04:00');
  await store.loadBoard();
  assert.equal(store.state.rev, after, 'an unchanged board must not bump rev');
  assert.equal(store.state.board.now, '2026-08-27T09:03:00-04:00', 'the fresh clock is still kept');

  answer = board('2026-08-27T09:06:00-04:00', [{ id: 'a', bucket: 'now', state: 'open' }]);
  await store.loadBoard();
  assert.equal(store.state.rev, after + 1, 'a board that actually changed must still bump');
});

/**
 * A live region announces MUTATIONS made while it is in the document. Both of
 * the app's regions were built with their text already set and then swapped in
 * whole — so sweep progress, sweep failure and every single toast were silent.
 * ui/views/ai-access.js documents the same trap and works around it the same way.
 */
test('the sweep line and the toast can actually be heard', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');

  const build = /function buildSweepLine\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(build, 'buildSweepLine is missing');
  assert.match(build[0], /'aria-live': 'polite'/);
  assert.ok(!/text:/.test(build[0]), 'a live region born with its text set announces nothing');

  const paint = /function paintSweepLine\(parts\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(paint, 'paintSweepLine is missing');
  assert.match(paint[0], /announce\(parts\.textNode/);

  const announce = /function announce\(node, text\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(announce, 'announce is missing');
  assert.match(announce[0], /requestAnimationFrame/, 'the text must land after insertion');

  // Replacing the region is the same silence in another coat, so the repaint
  // path must update the one that is already there.
  const paintChrome = /function paintChrome\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(paintChrome, 'paintChrome is missing');
  assert.ok(!paintChrome[0].includes('buildSweepLine('), 'paintChrome mints a fresh live region');
  assert.match(paintChrome[0], /paintSweepLine\(chrome\.sweep\)/);

  const toast = /function toastBar\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(toast, 'toastBar is missing');
  assert.ok(!/text: state\.toast\.message/.test(toast[0]), 'the toast bakes its message in');
  assert.match(paintChrome[0], /announce\(built\.text, state\.toast\.message\)/);
});

test('the page declares the one theme it actually has', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  // "light dark" on an app with a single black theme makes a light-mode OS draw
  // its scrollbars, form controls and caret pale against pure black.
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.ok(!/content="light dark"/.test(html));
});

test('the search route is registered, and its view module answers to it', async () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  assert.match(app, /import \{ renderSearch \} from '\.\/views\/search\.js';/);
  assert.match(app, /\{ id: 'search', label: 'Search', render: renderSearch, countKey: null \}/);
  // No count badge: every other number in the rail is work that is waiting, and
  // "how many things could you find" is not that.
  assert.ok(!/id: 'search'[^}]*countKey: '/.test(app));

  assert.ok(fs.existsSync(path.join(UI, 'views/search.js')), 'ui/views/search.js is missing');
  stubBrowserGlobals();
  const mod = await import(fileUrl(UI, 'views/search.js'));
  assert.equal(typeof mod.renderSearch, 'function', 'search.js must export renderSearch');
});

/* ------------------------------------- 7. the view helpers worth pinning */

/**
 * The search and calendar views keep their arithmetic in exported pure
 * functions precisely so it can be checked here, without a layout engine. Both
 * modules are imported rather than read as text: these are behaviours, not
 * mechanisms, and a source guard would only pin the spelling.
 */
test('a search hit knows where — and whether — it can be opened', async () => {
  stubBrowserGlobals();
  const search = await import(fileUrl(UI, 'views/search.js'));

  assert.deepEqual(search.refParts('msg:abc'), { prefix: 'msg', id: 'abc' });
  // Message ids are not guaranteed to be colon-free; only the first one splits.
  assert.deepEqual(search.refParts('msg:a:b'), { prefix: 'msg', id: 'a:b' });
  assert.equal(search.refParts('msg:'), null);
  assert.equal(search.refParts('other:1'), null);
  assert.equal(search.refParts(null), null);

  assert.equal(search.hashForBucket('waiting'), '#/owed');
  assert.equal(search.hashForBucket('money'), '#/today');
  assert.equal(search.hashForBucket('nonsense'), '#/now');

  const items = [
    { id: 'i1', bucket: 'waiting', sourceRefs: ['msg:m1'] },
    { id: 'i2', bucket: 'now', sourceRefs: [] },
  ];
  const events = [{ id: 'e1', starts_at: '2026-08-11T14:00:00-04:00' }];

  // The hash carries the day, so opening a March event lands on March rather
  // than on whatever range the calendar was last left showing.
  assert.deepEqual(search.destinationFor('evt:e1', { items, events }), {
    where: 'calendar', hash: '#/calendar/2026-08-11', event: events[0], day: '2026-08-11',
  });
  assert.equal(search.destinationFor('item:i1', { items, events }).hash, '#/owed');
  // A message is not a page in this app, but the item a sweep raised from it is.
  const raised = search.destinationFor('msg:m1', { items, events });
  assert.equal(raised.item.id, 'i1');
  assert.equal(raised.raised, true);
  // A hit nothing on the board cites offers no way in, which is honest: an
  // item that has been done is not on a page any more.
  assert.equal(search.destinationFor('msg:gone', { items, events }), null);
  assert.equal(search.destinationFor('evt:gone', { items, events }), null);
  assert.equal(search.destinationFor('item:gone', { items, events }), null);
});

test('snoozed search hits open Now with the Snoozed section visible', async (t) => {
  withPlainDom(t);
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const search = await import(fileUrl(UI, 'views/search.js'));
  const { renderNow } = await import(fileUrl(UI, 'views/now.js'));
  const item = {
    id: 'asleep', state: 'snoozed', bucket: 'today', headline: 'The postponed invoice',
    sourceRefs: ['msg:mail', 'cap:note'], snoozed_until: '2026-08-13T09:00:00-04:00',
  };
  store.state.config = { mail: [{ id: 'mail' }], calendars: [], sources: [] };
  store.state.health = { model: { configured: true } };
  store.state.board = { ...store.state.board, items: [item], finished: [], notes: [], counts: {}, runs: {} };
  store.state.sweep.error = null;
  for (const ref of ['item:asleep', 'msg:mail', 'cap:note']) {
    const destination = search.destinationFor(ref, { items: [item] });
    assert.equal(destination.hash, '#/now/snoozed', ref);
    const view = renderNow({ tz: 'UTC', sub: destination.hash.split('/')[2], navigate() {} });
    assert.match(onScreen(view), /The postponed invoice/);
    const toggle = findButtons(view, /^Snoozed/)[0];
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  }
  const ordinary = renderNow({ tz: 'UTC', sub: null, navigate() {} });
  assert.doesNotMatch(onScreen(ordinary), /The postponed invoice/, 'ordinary Now still starts folded');
});

test('the results summary counts in the words the app uses, board first', async () => {
  stubBrowserGlobals();
  const search = await import(fileUrl(UI, 'views/search.js'));
  assert.equal(
    search.summariseKinds([
      { kind: 'message' }, { kind: 'item' }, { kind: 'message' }, { kind: 'event' },
    ]),
    'board 1 · mail 2 · calendar 1',
  );
  assert.equal(search.summariseKinds([]), '');
  assert.equal(search.summariseKinds(null), '');
  // The database's own vocabulary must not reach the screen.
  assert.equal(search.kindLabel('capture'), 'note');
  assert.equal(search.kindLabel('message'), 'mail');
  assert.equal(search.kindLabel(''), 'result');
});

test('the calendar opens where the day is, not at midnight', async () => {
  stubBrowserGlobals();
  const cal = await import(fileUrl(UI, 'views/calendar.js'));

  // Now wins, with two hours of context above it.
  assert.equal(cal.openingScrollMinutes({ nowMinutes: 14 * 60, firstEventMinutes: 9 * 60 }), 12 * 60);
  // Early enough and it clamps rather than going negative.
  assert.equal(cal.openingScrollMinutes({ nowMinutes: 30 }), 0);
  // A range with no today aims at its first timed event instead.
  assert.equal(cal.openingScrollMinutes({ firstEventMinutes: 10 * 60 }), 10 * 60 - 45);
  // And with neither, the working day.
  assert.equal(cal.openingScrollMinutes({}), 7 * 60);

  // All-day spans start at minute zero and live in their own strip; counting
  // them would aim every range at midnight.
  assert.equal(cal.earliestStartMinutes([
    { start: 0, allDay: true }, { start: 600 }, { start: 540 },
  ]), 540);
  assert.equal(cal.earliestStartMinutes([{ start: 0, allDay: true }]), null);
  assert.equal(cal.earliestStartMinutes([]), null);

  // A re-render in the same place keeps the scroll the reader chose; arriving,
  // or moving to another range, does not.
  const sig = cal.rangeSignature('week', ['2026-08-09', '2026-08-15']);
  assert.equal(sig, cal.rangeSignature('week', ['2026-08-09', '2026-08-10', '2026-08-15']));
  assert.equal(cal.shouldOpenAtTarget({ signature: sig, lastSignature: sig, wasOnScreen: true }), false);
  assert.equal(cal.shouldOpenAtTarget({ signature: sig, lastSignature: sig, wasOnScreen: false }), true);
  assert.equal(cal.shouldOpenAtTarget({ signature: sig, lastSignature: 'week|x|y', wasOnScreen: true }), true);
});

test('the tab bar does not keep a second copy of how many views there are', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const bar = /^\.tabbar \{([^}]*)\}/m.exec(css);
  assert.ok(bar, '.tabbar rule is missing');
  // A literal column count here is VIEWS.length written down twice; adding the
  // seventh view wrapped the extra tab onto a row below the bar.
  assert.ok(!/grid-template-columns:\s*repeat\(\d/.test(bar[1]), 'the tab count is hardcoded in CSS');
  assert.match(bar[1], /grid-auto-flow: column/);
  assert.match(bar[1], /grid-auto-columns: minmax\(0, 1fr\)/);
});

test('no rule still branches on a theme attribute that is never set', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  // There is one theme. A dead `[data-theme=…]` override is a rule that looks
  // like it is handling a case and is not.
  assert.ok(!/\[data-theme[~^|*$]?=/.test(css), 'app.css still branches on data-theme');
  assert.ok(!/data-theme=/.test(html), 'index.html still carries a data-theme attribute');
});

/* ------------------------------------------- 8. the fixes that were not wired,
                                                  and the failures nobody saw */

/**
 * A zone parameter nothing passes is not a fix.
 *
 * `dueLabel` and `isOverdue` both take a zone and both default it to the
 * BROWSER's, and every row on the board called them without one — so a bare
 * "due 2026-08-12" was judged against the laptop's zone while the carried-for
 * badge on the same line was judged in the configured one. The two readings are
 * a whole day apart for anyone away from home. `dueBit` is the single place the
 * zone is threaded, and the two assertions below are the two halves that matter:
 * that it actually consults the zone, and that no call site has been left behind.
 */
test('a deadline is read in the configured zone, wherever the browser thinks it is', async () => {
  stubBrowserGlobals();
  const items = await import(fileUrl(UI, 'lib/items.js'));
  const item = { due_at: '2026-08-12' };
  // 1pm UTC on the 12th. In New York that is 9am of the day it is due; in
  // Kiritimati it is 3am of the day AFTER. Two zones, two honest answers, and
  // neither of them depends on where this test is being run.
  const now = Date.parse('2026-08-12T13:00:00Z');

  const inNewYork = items.dueBit(item, { tz: 'America/New_York', now });
  assert.deepEqual(inNewYork, { text: 'due today', hot: false });

  const inKiritimati = items.dueBit(item, { tz: 'Pacific/Kiritimati', now });
  assert.deepEqual(inKiritimati, { text: 'due yesterday', hot: true });

  assert.equal(items.dueBit({ due_at: null }, { tz: 'America/New_York', now }), null);
});

test('every production call of dueLabel/isOverdue is handed a zone', () => {
  // The fix lived in format.js and was reachable only from the tests. This walks
  // the shipped modules and fails on a call site that left the zone to chance —
  // which is what metaLine() and itemHero() were both doing.
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(UI);

  let callSites = 0;
  for (const file of files) {
    // format.js declares them; a declaration is not a call.
    if (file.endsWith(path.join('lib', 'format.js'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(dueLabel|isOverdue)\s*\(([^)]*)\)/g)) {
      callSites += 1;
      assert.match(m[2], /\bzone\b|\btz\b/,
        `${path.relative(UI, file)} calls ${m[1]}(${m[2]}) without a zone`);
    }
  }
  assert.ok(callSites > 0, 'the call sites moved; this guard is now pinning nothing');
});

/**
 * The memo is exact, not approximate: both Intl lookups inside dueInstant are
 * taken at instants derived from the zone and the day-key alone, so the same
 * pair can never produce a different answer. What it buys is the cost — the
 * lookups are something like a hundred times the string parse they replaced, and
 * a board row asks for the same deadline twice, once for its words and once for
 * whether it is late.
 */
test('a deadline costs its zone lookup once per zone and day, not once per row', (t) => {
  const real = Intl.DateTimeFormat;
  let built = 0;
  // A subclass rather than a wrapper: `new Intl.DateTimeFormat(...)` must keep
  // returning something with formatToParts on it.
  class Counting extends real {
    constructor(...args) {
      built += 1;
      super(...args);
    }
  }
  Intl.DateTimeFormat = Counting;
  t.after(() => { Intl.DateTimeFormat = real; });

  const tz = 'America/New_York';
  // A key this process has certainly not seen, so the memo starts cold.
  const first = ui.dueInstant('2031-08-12', tz);
  assert.ok(built > 0, 'the first reading must actually consult the zone');
  const beforeRepeat = built;

  for (let i = 0; i < 20; i += 1) {
    assert.equal(ui.dueInstant('2031-08-12', tz), first);
  }
  assert.equal(built, beforeRepeat, 'the same zone and day were looked up again');

  // A different day, and a different zone on the same day, are both still real
  // work — the memo must not be answering from the wrong entry.
  assert.equal(ui.dueInstant('2031-01-12', tz), Date.parse('2031-01-12T23:59:59.999-05:00'));
  assert.equal(ui.dueInstant('2031-08-12', 'Europe/London'), Date.parse('2031-08-12T23:59:59.999+01:00'));
  assert.equal(first, Date.parse('2031-08-12T23:59:59.999-04:00'));
});

/**
 * The heartbeat swallowed every error, which left the app permanently and
 * invisibly stale in the exact scenario it was added for: the window open
 * overnight, whose hours-old board looks precisely like a current one.
 */
test('a run of failed heartbeats says so, and one blip does not', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  t.mock.timers.enable({ apis: ['setInterval'] });

  const board = {
    items: [], counts: {}, events: [], drafts: [], runs: { last: null },
    notes: [], first: null, now: '2026-08-12T02:30:00-04:00',
  };
  let answering = false;
  globalThis.fetch = async () => (answering
    ? { ok: true, status: 200, text: async () => JSON.stringify(board) }
    : { ok: false, status: 503, text: async () => '{"error":"the server is not there"}' });
  t.after(() => {
    delete globalThis.fetch;
    store.state.fatal = null;
    store.state.phase = 'ready';
  });

  store.state.phase = 'ready';
  store.state.fatal = null;
  const stop = store.watchBoard({ intervalMs: 60_000 });
  t.after(stop);

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(store.state.fatal, null, 'one missed refetch is a wifi hiccup, not news');
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(store.state.fatal, null, 'two is still not a story');

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(store.state.fatal?.title, 'Zelos is not answering',
    'a heartbeat that keeps failing must stop pretending the board is current');
  assert.equal(store.state.phase, 'down');

  // ...and it comes back down by itself when the server does.
  answering = true;
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(store.state.fatal, null, 'a server that came back must clear its own screen');
  assert.equal(store.state.phase, 'ready');
});

test('the heartbeat states its failure in the same words the boot path uses', () => {
  const store = fs.readFileSync(path.join(UI, 'lib/store.js'), 'utf8');
  const watch = /export function watchBoard\([\s\S]*?\n\}/m.exec(store);
  assert.ok(watch, 'watchBoard is missing');
  // One screen, one wording. Two copies of "Zelos is not answering" is two
  // sentences that will drift.
  assert.match(watch[0], /fatalFor\(err\)/);
  assert.equal(store.split("title: 'Zelos is not answering'").length - 1, 1);
  const refresh = /export async function refresh\([\s\S]*?\n\}/m.exec(store);
  assert.ok(refresh, 'refresh is missing');
  assert.match(refresh[0], /fatalFor\(err\)/);
});

/**
 * `nowMark()` rolls its key past midnight rather than giving up, and the
 * now-line is a child of whichever column was today when the grid was built. So
 * at 00:03 the line was being repositioned three minutes down YESTERDAY's
 * column — a confident claim about the wrong day.
 */
test('past midnight the now-line changes column, or leaves', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const cal = await import(fileUrl(UI, 'views/calendar.js'));

  // A grid small enough to reason about: the handful of node behaviours
  // tickNowLine actually uses, and nothing else.
  const node = (day) => {
    const self = {
      dataset: day ? { day } : {},
      children: [],
      parentNode: null,
      classes: new Set(day ? [] : []),
      style: {},
      classList: {
        add(c) { self.classes.add(c); },
        remove(c) { self.classes.delete(c); },
      },
      appendChild(child) {
        child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
        child.parentNode = self;
        self.children.push(child);
        return child;
      },
      remove() {
        const kids = self.parentNode?.children;
        if (kids) kids.splice(kids.indexOf(self), 1);
        self.parentNode = null;
      },
    };
    return self;
  };

  const grid = (dayKeys) => {
    const cols = dayKeys.map((d) => node(d));
    const line = node(null);
    cols[0].appendChild(line);
    cols[0].classList.add('is-today');
    const realDoc = globalThis.document;
    globalThis.document = {
      ...realDoc,
      querySelector: (sel) => (sel === '.cal-days .now-line' && line.parentNode ? line : null),
      querySelectorAll: (sel) => (sel === '.cal-days .cal-col' ? cols : []),
    };
    t.after(() => { globalThis.document = realDoc; });
    return { cols, line };
  };

  // The board was fetched at 23:30 and nobody has touched the window since; it
  // is now three hours later, which is 02:30 of the NEXT day.
  store.state.board = { ...store.state.board, now: '2026-08-11T23:30:00-04:00' };
  store.state.boardAt = Date.now() - 3 * 3_600_000;
  assert.equal(store.nowMark().key, '2026-08-12', 'the premise of this test has moved');

  const week = grid(['2026-08-11', '2026-08-12']);
  cal.tickNowLine();
  assert.equal(week.line.parentNode, week.cols[1],
    'the now-line stayed in yesterday and moved itself down inside it');
  assert.ok(week.cols[1].classes.has('is-today'));
  assert.ok(!week.cols[0].classes.has('is-today'), 'the grid is claiming two todays');
  assert.match(week.line.style.top, /^calc\(15\d(\.\d+)? \* var\(--min-h\)\)$/);

  // A grid the new day is not on has no honest place to draw "now".
  const stale = grid(['2026-08-11']);
  cal.tickNowLine();
  assert.equal(stale.line.parentNode, null, 'a line for a day not on screen must go');
});

/**
 * `paint()` runs on every board render, and the board now has a heartbeat — so
 * rewriting the status region unconditionally announces stale search results to
 * a screen reader on a timer, forever.
 */
test('the search status announces a change, not a repaint', () => {
  const search = fs.readFileSync(path.join(UI, 'views/search.js'), 'utf8');
  const paint = /function paint\(\)[\s\S]*?\n\}/m.exec(search);
  assert.ok(paint, 'paint is missing');
  assert.ok(!/statusNode\.textContent\s*=/.test(paint[0]),
    'paint writes the live region on every render');
  assert.match(paint[0], /announce\(statusNode/);

  const announce = /function announce\(node, text\)[\s\S]*?\n\}/m.exec(search);
  assert.ok(announce, 'announce is missing');
  assert.match(announce[0], /if \(announced === value\) return/, 'the guard must be on the text');
  assert.match(announce[0], /requestAnimationFrame/, 'the text must land after insertion');
});

/**
 * 'Check a token' reverted to the just-minted token on every repaint, so the
 * second press of Test checked something other than what was on screen.
 */
test('what was typed into the token test survives a repaint', () => {
  const src = fs.readFileSync(path.join(UI, 'views/ai-access.js'), 'utf8');
  const block = /function testBlock\(v\)[\s\S]*?\n  \}/m.exec(src);
  assert.ok(block, 'testBlock is missing');
  assert.ok(!/^\s*if \(revealed\) tokenInput\.value = revealed\.value;$/m.test(block[0]),
    'the field is still overwritten with the minted token on every repaint');
  assert.match(block[0], /if \(tokenDraft !== null\) tokenInput\.value = tokenDraft;/);
  assert.match(block[0], /addEventListener\('input'[\s\S]*?tokenDraft = tokenInput\.value/);
  // Module scope, not closure scope: the panel is rebuilt wholesale, so a draft
  // kept inside the builder would not survive the thing it exists to survive.
  assert.match(src, /^let tokenDraft = null;$/m);
  // Minting is the one write that is allowed to replace it.
  const mint = /async function mint\(label\)[\s\S]*?\n  \}/m.exec(src);
  assert.ok(mint, 'mint is missing');
  assert.match(mint[0], /tokenDraft = null;/);
});

/* ------------------------------------- 9. the setting that existed everywhere
                                            except where anyone could reach it */

/**
 * `requireTls` was stored by core/config.mjs, enforced by core/sources/imap.mjs
 * and forwarded by the sweep, the doctor and the mail-test route — and `grep -rn
 * requireTls ui/` matched nothing. A security setting nobody can see is not a
 * setting, and the account editor had no way to say "this bridge on my own
 * machine is deliberate" short of hand-editing config.json.
 *
 * The mapping is checked as behaviour because it is the whole of the risk: get
 * it backwards, or coerce a stray string, and Zelos quietly stops requiring
 * encryption for a real mail server on the public internet.
 */
test('the TLS choice maps to the three values config stores, and junk lands on the safe one', async () => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const config = await import(fileUrl(ROOT, 'core/config.mjs'));

  assert.deepEqual(settings.TLS_CHOICES.map((c) => c.value), ['auto', 'require', 'allow']);
  for (const choice of settings.TLS_CHOICES) {
    assert.ok(choice.label.length > 0, choice.value);
    // The copy is about the password, not about the protocol. A user deciding
    // this should not have to know what STARTTLS is.
    assert.ok(!/STARTTLS|TLS handshake|cleartext/i.test(choice.label), choice.label);
  }

  assert.equal(settings.requireTlsFor('auto'), null);
  assert.equal(settings.requireTlsFor('require'), true);
  assert.equal(settings.requireTlsFor('allow'), false);
  // A select can only hand back its own values, but the direction of the
  // failure matters: anything unrecognised must resolve to "decide from the
  // host", never to permission.
  for (const junk of ['', 'false', 'true', null, undefined, 0, 'Allow']) {
    assert.equal(settings.requireTlsFor(junk), null, JSON.stringify(junk));
  }

  assert.equal(settings.tlsChoiceFor(true), 'require');
  assert.equal(settings.tlsChoiceFor(false), 'allow');
  // What every account saved before this setting existed says, and what a new
  // one gets: the default the config module itself ships.
  assert.equal(config.MAIL_ACCOUNT_DEFAULTS.requireTls, null);
  assert.equal(settings.tlsChoiceFor(null), 'auto');
  assert.equal(settings.tlsChoiceFor(undefined), 'auto');
  // A truthy string is not a boolean, and must not read as permission either.
  for (const junk of ['false', 'true', 0, 1, 'no']) {
    assert.equal(settings.tlsChoiceFor(junk), 'auto', JSON.stringify(junk));
  }
});

/**
 * The editor and the test button are pinned at the source because building the
 * form needs a layout engine, and the failure is in the wiring rather than in
 * any function: "Test the connection" composed its body by hand and left
 * `requireTls` out of it, so the one moment a user is told "this works" was the
 * moment least like the sweep that runs at 07:00.
 */
test('the mail editor can set requireTls, and the test connects under the same rule', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');

  // A control, actually placed in the returned form — not merely built.
  assert.match(form[0], /select\(TLS_CHOICES, \{ value: tlsChoiceFor\(draft\.requireTls\) \}\)/,
    'the editor must offer the three stored values');
  assert.match(form[0], /field\('Sending your password', tlsSelect/,
    'the control must be in the form, with a label about the password');

  // Both paths out of this form carry it, and both read the same control.
  const probe = /api\.testMail\(\{[\s\S]*?\}\)/m.exec(form[0]);
  assert.ok(probe, 'the testMail call is missing');
  assert.match(probe[0], /requireTls: requireTls\(\)/,
    'the connection test omits requireTls and so tests different rules than the sweep');
  // The account literal the save sends. It moved into a `patch` object when the
  // form learned to adopt identity.email, so this reads the literal rather than
  // the shape of the saveConfig call — the assertion is about what is in the
  // account, not about how many keys travel beside it.
  const save = /mail: \[\.\.\.others, \{[\s\S]*?\}\]/m.exec(form[0]);
  assert.ok(save, 'the saved account literal is missing');
  assert.match(save[0], /requireTls: requireTls\(\)/, 'the save drops what the editor chose');
  assert.match(form[0], /await saveConfig\(patch\)/, 'the assembled patch must actually be saved');

  // The blank a new account opens on is the config module's blank. A literal
  // `false` here would excuse cleartext for a host nobody has named yet. The
  // literal moved into the simple form when the full one started opening
  // beneath its card rather than in its place.
  const blank = /expertSlot\.replaceChildren\(mailForm\(\{[\s\S]*?\}, \{/m.exec(src);
  assert.ok(blank, 'the new-account literal is missing');
  assert.match(blank[0], /requireTls: null/, 'a new account must start on "decide from the address"');
});

/**
 * `identity.name` and `identity.email` had a schema, a validator, and readers in
 * the scorer and the prompt — and nothing a user could reach ever set them.
 * `grep identity ui/` returned one hit and it read `timezone`. No panel, no
 * onboarding step, no CLI flag; only a hand-crafted PUT or an edit to
 * config.json.
 *
 * Verified on a fresh home: `identity.email` stayed `''`, `sameEmail(a, '')` is
 * false for every message, and the +6 To: and −2 Cc: branches at
 * core/triage.mjs:434-435 never fired once. At the item cap that is not
 * cosmetic — a message written straight to the user was cut from the sweep
 * prompt entirely while newer Cc-only rollups survived. `identity.name` stayed
 * `''` too, so every prompt read "name: (not set — do not invent one)" and
 * every draft came back unsigned with nothing on screen to say why.
 *
 * Both ends are named here on purpose. WRITER: the You panel's
 * `saveConfig({ identity: … })`, and the mail form adopting the first account's
 * address. READER: `core/triage.mjs` `buildSweepPrompt`, whose behaviour is
 * asserted in test/triage.test.mjs, and `core/sweep.mjs` `directionOf`.
 */
test('Settings can set who you are, and the value has a reader on the other end', async () => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');

  // The panel is reachable, not merely defined.
  const panels = /const PANELS = \[[\s\S]*?\];/m.exec(src);
  assert.ok(panels, 'PANELS is missing');
  assert.match(panels[0], /id: 'you'/, 'the You panel is not in the tab strip');
  assert.match(src, /if \(panel === 'you'\) body = youPanel\(\)/,
    'the tab exists but renderSettings never builds the panel');

  // It writes the two keys the readers read, and nothing else.
  const panel = /function youPanel\(\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(panel, 'youPanel is missing');
  assert.match(panel[0], /saveConfig\(\{ identity: \{ name: nameInput\.value\.trim\(\), email \} \}\)/,
    'the You panel does not persist name and email');
  // The timezone is resolved from the machine on every load, so writing it back
  // would freeze the zone the user was in the day they typed it.
  assert.ok(!/timezone:/.test(panel[0].replace(/'[^']*'|`[^`]*`/g, '')),
    'the panel persists a timezone, which core/config.mjs resolves at read time');

  // The default for an install that predates the panel.
  assert.equal(settings.defaultIdentityEmail({ mail: [{ enabled: true, user: 'me@example.com' }] }), 'me@example.com');
  assert.equal(
    settings.defaultIdentityEmail({ mail: [{ enabled: false, user: 'old@example.com' }, { enabled: true, user: 'me@example.com' }] }),
    'me@example.com',
    'a disabled account is not who you are',
  );
  assert.equal(settings.defaultIdentityEmail({ mail: [{ enabled: true, user: 'not-an-address' }] }), '',
    'a username that is not an address must not be offered as one — core/config.mjs would reject it');
  for (const empty of [null, undefined, {}, { mail: [] }, { mail: 'nope' }, { mail: [null] }]) {
    assert.equal(settings.defaultIdentityEmail(empty), '', JSON.stringify(empty));
  }

  // The second writer: saving a mailbox adopts its address when nothing is set,
  // so an install that has been running for months stops being wrong without
  // anyone having to find a new tab.
  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');
  assert.match(form[0], /state\.config\?\.identity\?\.email/, 'the mail form never looks at what is already set');
  assert.match(form[0], /patch\.identity = \{ email: adopted \}/, 'the mail form does not adopt the address');
  assert.match(form[0], /!known &&/, 'an address the user already chose must not be overwritten');
  assert.match(form[0], /Zelos will also treat \$\{adopted\}/, 'adopting it silently is how this became invisible in the first place');

  // The readers, named rather than assumed.
  const triage = fs.readFileSync(path.join(ROOT, 'core/triage.mjs'), 'utf8');
  assert.match(triage, /const userEmail = str\(identity\.email\)/, 'core/triage.mjs no longer reads identity.email');
  assert.match(triage, /sameEmail\(a\?\.email, ctx\.userEmail\)\)\) score \+= 6/, 'the To: branch this feeds is gone');
  const sweep = fs.readFileSync(path.join(ROOT, 'core/sweep.mjs'), 'utf8');
  assert.match(sweep, /config\?\.identity\?\.email/, 'core/sweep.mjs no longer reads identity.email');
});

/**
 * The credential slot was painted only by the "How Zelos signs in" change
 * listener: opened for an existing account, the form showed no password field
 * and no sign-in block until the picker was touched. The paint must also run
 * once after the tree is built — after, because the TLS field's initial hide
 * walks `closest('.field')` and finds nothing in a half-built tree.
 */
test('the mail form paints its credential slot on open, not first on a picker change', () => {
  const src = fs.readFileSync(path.join(ROOT, 'ui/views/settings.js'), 'utf8');
  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');
  const tree = form[0].split(`class: 'account-form'`)[1] ?? '';
  assert.match(tree, /paintCredential\(\);/,
    'the form never paints the slot for the state it opens in');
});

/**
 * `sentMailbox` is appended to every fetch by `mailboxesFor()` and had no writer
 * anywhere in `ui/` — the string appeared exactly once, in a blank-account
 * literal. The stored default is the bare word "Sent", which is wrong for Gmail,
 * Microsoft 365 and iCloud: three of the eight providers this app hardcodes and
 * the three largest. Reproduced against a Microsoft 365 folder set:
 * `{label:"Work / Sent", ok:false, error:"Mailbox doesn't exist: Sent"}` on
 * every sweep forever, run still `ok:true`, doctor still "pass".
 *
 * WRITER: the field below, into `saveConfig({ mail: [...] })`. READER:
 * `mailboxesFor()` and `directionOf()` in core/connectors/imap.mjs, plus the
 * mail check in core/doctor.mjs — pinned in test/doctor.test.mjs. The prefill's
 * own source is the SPECIAL-USE flag `listMailboxes()` has computed since the
 * client was written and which nothing outside a test had ever read.
 *
 * The two readers used to sit in core/sweep.mjs and were moved to the IMAP
 * connector when the run loop stopped knowing what an IMAP account is. Nothing
 * about the behaviour changed — the functions moved file, character for
 * character — so the assertion follows them, and it now pins the whole chain
 * rather than one end of it: the reader exists, AND the run loop still reaches
 * it. Pinning only the new file would have let a later edit orphan the reader
 * without this test noticing, which is the exact failure it was written for.
 */
test('the Outlook note tells the user to press something that exists', async () => {
  /* REGRESSION, and it shipped for a few hours in exactly this shape.
     `core/sources/imap.mjs` grew AUTHENTICATE XOAUTH2 and the device grant, the
     preset note was rewritten to say "Set “How Zelos signs in” to “Sign in with
     Microsoft”", and `core/doctor.mjs:660` renders that note verbatim to anyone
     whose mail sign-in fails — which, for outlook.com, hotmail, live and msn,
     is now everyone. The control it names did not exist. The advice was
     therefore worse than the false sentence it replaced: the old one was wrong
     about Microsoft, the new one sent people looking around the screen for a
     button.

     So this asserts the CHAIN, not the parts. The note names a label; the label
     is a real option; the option's value is what config validates and what the
     connector reads; and the form places the control and can actually start,
     poll and cancel a sign-in. Any one of those drifting on its own is the bug. */
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');

  const outlook = settings.IMAP_HINTS.find((h) => h.host === 'outlook.office365.com');
  assert.ok(outlook?.note, 'the Outlook preset lost its note — it is the only warning that Microsoft stopped taking passwords');

  const named = /“([^”]+)”\s*$|to “([^”]+)”/.exec(outlook.note);
  const wanted = settings.MAIL_AUTH_CHOICES.find((c) => c.value === 'xoauth2');
  assert.ok(wanted, 'there is no xoauth2 option for the note to point at');
  assert.ok(outlook.note.includes(wanted.label.replace(/\s*\(.*\)$/, '')) || outlook.note.includes('Sign in with Microsoft'),
    `the note does not name the option a user has to pick: ${JSON.stringify(outlook.note)}`);

  // The value the UI stores is the one the other two halves already agree on.
  const cfg = fs.readFileSync(path.join(ROOT, 'core/config.mjs'), 'utf8');
  assert.match(cfg, /MAIL_AUTH_METHODS[^\n]*'xoauth2'/, 'config does not validate the value this picker writes');
  const connector = fs.readFileSync(path.join(ROOT, 'core/connectors/imap.mjs'), 'utf8');
  assert.match(connector, /xoauth2/, 'the IMAP connector does not read the value this picker writes');

  // The control is placed in the returned form, not merely constructed.
  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');
  assert.match(form[0], /field\('How Zelos signs in', authSelect/, 'the sign-in picker is built but never placed');
  assert.match(form[0], /credentialSlot/, 'the credential block has nowhere to render');

  // And all three ends of the device flow are reachable from here. The flow
  // itself moved out of the form into `microsoftSignIn` when the simple mail
  // form learned to show the same block, so the assertion follows it: the
  // form builds the block through the factory, and the factory makes the calls.
  assert.match(form[0], /const buildMicrosoft = \(\) => microsoftSignIn\(\{/, 'the form no longer builds the sign-in block');
  const flow = /\nfunction microsoftSignIn\([\s\S]*?\n\}/m.exec(src);
  assert.ok(flow, 'microsoftSignIn is missing');
  for (const call of ['beginMailOAuth', 'mailOAuthStatus', 'cancelMailOAuth']) {
    assert.match(flow[0], new RegExp(`api\\.${call}\\(`), `the sign-in block never calls api.${call}`);
  }
  const apiSrc = fs.readFileSync(path.join(UI, 'lib/api.js'), 'utf8');
  for (const call of ['beginMailOAuth', 'mailOAuthStatus', 'cancelMailOAuth']) {
    assert.match(apiSrc, new RegExp(`${call}:`), `ui/lib/api.js has no ${call}`);
  }
});

test('the mail editor can set the sent folder, and takes it from the server when asked', async () => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');

  // A control, actually in the returned form, and actually saved.
  assert.match(form[0], /field\('Sent folder', sentInput/, 'the control is built but never placed');
  assert.match(form[0], /sentMailbox: sentInput\.value\.trim\(\)/, 'the save drops what the editor chose');
  // The three provider spellings, so nobody has to already know theirs.
  for (const spelling of ['\\[Gmail\\]/Sent Mail', 'Sent Items', 'Sent Messages']) {
    assert.match(form[0], new RegExp(spelling), `the hint does not name ${spelling}`);
  }

  // The prefill reads the flag off the test response.
  assert.match(form[0], /sentMailboxFromTest\(result\.mailboxes, sentInput\.value\)/,
    'the SPECIAL-USE flag is on the wire and in the response object with nowhere to land');

  const M365 = [
    { name: 'INBOX', specialUse: 'inbox' },
    { name: 'Sent Items', specialUse: 'sent' },
    { name: 'Drafts', specialUse: 'drafts' },
  ];
  assert.equal(settings.sentMailboxFromTest(M365, 'Sent'), 'Sent Items',
    'the default "Sent" is not on this server, so the flag has to win');
  assert.equal(settings.sentMailboxFromTest(M365, ''), 'Sent Items');
  // What the user typed wins — but only when the server actually has it. A name
  // the server does not have is a typo, and keeping it is how the whole defect
  // looked like nothing at all.
  assert.equal(settings.sentMailboxFromTest([...M365, { name: 'Archive/Sent', specialUse: null }], 'Archive/Sent'), 'Archive/Sent');
  assert.equal(settings.sentMailboxFromTest([{ name: 'INBOX' }, { name: 'Sent' }], 'Sent'), 'Sent',
    'a server with no SPECIAL-USE flags at all must not have the choice taken away');
  // Nothing to say is said with nothing: no flag and no typed name leaves it be.
  assert.equal(settings.sentMailboxFromTest([{ name: 'INBOX' }], ''), '');
  assert.equal(settings.sentMailboxFromTest([{ name: 'INBOX' }], 'Sent'), 'Sent');
  for (const junk of [null, undefined, 'not-an-array', 42]) {
    assert.equal(settings.sentMailboxFromTest(junk, 'Sent'), 'Sent', JSON.stringify(junk));
  }

  // The reader, named — and the path from the run loop to it, also named.
  const imap = fs.readFileSync(path.join(ROOT, 'core/connectors/imap.mjs'), 'utf8');
  assert.match(imap, /account\.sentMailbox === 'string' \? account\.sentMailbox\.trim\(\)/,
    'core/connectors/imap.mjs no longer reads sentMailbox, so this field writes to nothing');
  assert.match(imap, /mailboxesFor\(account\)/, 'the reader exists but nothing in the connector calls it');
  const sweep = fs.readFileSync(path.join(ROOT, 'core/sweep.mjs'), 'utf8');
  assert.match(sweep, /from '\.\/connectors\/index\.mjs'/,
    'the run loop no longer reaches the connector registry, so the reader above runs for nobody');
});

/**
 * The tab strip set `role="tablist"`, `role="tab"` and `aria-selected` while the
 * panel had no `role="tabpanel"`, no `aria-labelledby`, and the tabs had no
 * `id` and no `aria-controls`. A control that announces "tab, selected" while
 * pointing at nothing is worse than a plain button: the user is told there are
 * eight tabs and given no way to find out what any of them controls.
 *
 * Finished rather than dropped, because `refocusSelectedTab()` in ui/app.js now
 * finds the pressed tab again through `[role="tab"][aria-selected="true"]` —
 * the roles carry the focus fix as well.
 */
test('the Settings tab strip is a whole tablist, not half of one', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const render = /export function renderSettings\(ctx\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(render, 'renderSettings is missing');

  // Ids that survive a rebuild. `nextId()` ticks on every render, which would
  // leave aria-labelledby pointing at the id the tab had one paint ago.
  assert.match(src, /const tabId = \(id\) => `settings-tab-\$\{id\}`/);
  assert.match(src, /const panelId = \(id\) => `settings-panel-\$\{id\}`/);

  assert.match(render[0], /id: tabId\(p\.id\)/, 'a tab with no id cannot be pointed at');
  assert.match(render[0], /'aria-selected': selected \? 'true' : 'false'/);
  // Only the live panel is in the document, so only the selected tab may claim
  // to control one: seven dangling references read as empty relationships.
  assert.match(render[0], /'aria-controls': selected \? panelId\(p\.id\) : null/);
  // Roving tabindex, so the strip is one tab stop with arrows inside it.
  assert.match(render[0], /tabindex: selected \? '0' : '-1'/);
  assert.match(render[0], /onkeydown: onTabKey/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.match(render[0], new RegExp(`'${key}'`), `${key} does nothing in the tablist`);
  }

  // The other half of the relationship.
  assert.match(render[0], /body\.setAttribute\('role', 'tabpanel'\)/);
  assert.match(render[0], /body\.setAttribute\('id', panelId\(panel\)\)/);
  assert.match(render[0], /body\.setAttribute\('aria-labelledby', tabId\(panel\)\)/);

  // The ids the two halves use have to be the same ids, which is only true if
  // both go through the helpers rather than spelling the string out.
  assert.equal((src.match(/settings-tab-/g) ?? []).length, 1, 'the tab id is spelled out in more than one place');
  assert.equal((src.match(/settings-panel-/g) ?? []).length, 1, 'the panel id is spelled out in more than one place');
});

/**
 * The removal half of the midnight fix. `tickNowLine` dropped the line when the
 * new day was off screen and left `is-today` on the column that was today when
 * the grid was built — so a day grid showing the 12th, ticked at 00:03 on the
 * 13th, went on tinting the 12th and labelling it today.
 */
test('a now-line that leaves takes the today marker with it', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const cal = await import(fileUrl(UI, 'views/calendar.js'));

  const node = (day) => {
    const self = {
      dataset: day ? { day } : {},
      children: [],
      parentNode: null,
      classes: new Set(),
      style: {},
      classList: {
        add(c) { self.classes.add(c); },
        remove(c) { self.classes.delete(c); },
      },
      appendChild(child) {
        child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
        child.parentNode = self;
        self.children.push(child);
        return child;
      },
      remove() {
        const kids = self.parentNode?.children;
        if (kids) kids.splice(kids.indexOf(self), 1);
        self.parentNode = null;
      },
    };
    return self;
  };

  const grid = (dayKeys) => {
    const cols = dayKeys.map((d) => node(d));
    const line = node(null);
    cols[0].appendChild(line);
    cols[0].classList.add('is-today');
    const realDoc = globalThis.document;
    globalThis.document = {
      ...realDoc,
      querySelector: (sel) => (sel === '.cal-days .now-line' && line.parentNode ? line : null),
      querySelectorAll: (sel) => (sel === '.cal-days .cal-col' ? cols : []),
    };
    t.after(() => { globalThis.document = realDoc; });
    return { cols, line };
  };

  // A day grid built on the 12th, still open at three minutes past midnight.
  store.state.board = { ...store.state.board, now: '2026-08-12T23:30:00-04:00' };
  store.state.boardAt = Date.now() - 33 * 60_000;
  const mark = store.nowMark();
  assert.equal(mark.key, '2026-08-13', 'the premise of this test has moved');
  assert.ok(Math.abs(mark.minutes - 3) < 2, `00:03, not ${mark.minutes}`);

  const day = grid(['2026-08-12']);
  cal.tickNowLine();
  assert.equal(day.line.parentNode, null, 'the line has no honest place on this grid');
  assert.ok(!day.cols[0].classes.has('is-today'),
    'the 12th is still being drawn as today, on the 13th');

  // The other way out: no reading of "now" at all. The marker goes with it,
  // because it was only ever a claim about a clock this grid can no longer read.
  const orphan = grid(['2026-08-12', '2026-08-13']);
  store.state.board = { ...store.state.board, now: null };
  assert.equal(store.nowMark().key, null, 'the premise of this test has moved');
  cal.tickNowLine();
  assert.equal(orphan.line.parentNode, null);
  assert.ok(!orphan.cols.some((c) => c.classes.has('is-today')), 'a today marker outlived its clock');
});

/* ------------------------------------------------------------ 10. first run */

/**
 * The operator's own install never worked: 38 runs, every one "No API key
 * configured", no config.json, no sources. Three of the reasons were this
 * screen and this store — a model save nothing downstream could see, a Test
 * button that ignored the key sitting in the field, and a board whose only
 * action after the first scheduled failure was to fail again. Each is pinned
 * below at the line that stranded him.
 */

test('REGRESSION: a config save refetches health, so a model just saved is a model the screens can see', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));

  // `model.configured` lives in /api/health and nowhere else, and the
  // onboarding's "Sweep now", its "Missing: a model" note, the rail foot and
  // the Now view's empty state all read it from state.health. saveConfig
  // updated config and secretRefs and never health, so pasting a working
  // hosted key ended on a disabled button naming the thing just done as
  // missing, until a page reload.
  const model = { protocol: 'anthropic', baseUrl: 'https://api.example.invalid', model: 'm', keyRef: 'model.default' };
  const calls = [];
  globalThis.fetch = async (reqPath, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${reqPath}`);
    if (reqPath === '/api/config') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ config: { model }, errors: [], secretRefs: ['model.default'] }) };
    }
    if (reqPath === '/api/health') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: { configured: true } }) };
    }
    throw new Error(`unexpected ${reqPath}`);
  };
  t.after(() => { delete globalThis.fetch; });

  store.state.health = { model: { configured: false } };
  await store.saveConfig({ model });
  assert.equal(store.state.config.model.model, 'm', 'the premise of this test has moved');
  assert.ok(calls.includes('GET /api/health'), `the save never asked the server whether the model is usable now (${calls.join(', ')})`);
  assert.equal(store.state.health?.model?.configured, true, 'the screens that gate on a model are still reading the answer from before the save');

  // A health fetch that fails must not turn a save that succeeded into an error.
  globalThis.fetch = async (reqPath) => {
    if (reqPath === '/api/config') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ config: { model }, errors: [], secretRefs: ['model.default'] }) };
    }
    return { ok: false, status: 503, text: async () => '{"error":"not now"}' };
  };
  await assert.doesNotReject(() => store.saveConfig({ model }));

  // The other moment a stale answer is noticed: the banner a failed sweep
  // raises sits beside the same gated screens, and `done` already refetched.
  const src = fs.readFileSync(path.join(UI, 'lib/store.js'), 'utf8');
  const failed = /\} else if \(event === 'failed'\) \{[\s\S]*?\n {12}\}/m.exec(src);
  assert.ok(failed, 'the failed branch of watchSweeps is missing');
  assert.match(failed[0], /loadHealth\(\)/, 'a failed sweep leaves the health document where it was');
});

test('REGRESSION: the mail editor refuses to save or test a password account with no password anywhere', () => {
  // The operator's first real mailbox went in with no secret and said
  // "Saved."; the sweep then reported "No password stored" forever. The
  // model panel gained this guard in the round before; the mail form had not.
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');
  const body = form[0];
  assert.match(body, /const passwordMissing = \(\) => authMethod\(\) === 'password' && !passInput\.value && !passwordStored\(\)/,
    'the rule: password auth, nothing typed, nothing stored');
  assert.match(body, /storedHere\.add\(draft\.keyRef\)/, 'a password stored on the way into Test must count at Save');
  // Both buttons ask before they act, and before "Saving…"/"Connecting…" is shown.
  const save = body.indexOf("button('Save account'");
  const test = body.indexOf("button('Test the connection'");
  assert.ok(save > 0 && test > save);
  const saveBody = body.slice(save, test);
  const testBody = body.slice(test);
  assert.ok(saveBody.indexOf('passwordMissing()') > 0 && saveBody.indexOf('passwordMissing()') < saveBody.indexOf("status.working('Saving…')"),
    'Save must refuse before it says Saving…');
  assert.ok(testBody.indexOf('passwordMissing()') > 0 && testBody.indexOf('passwordMissing()') < testBody.indexOf('status.working('),
    'Test must refuse before it says Connecting…');
  // The wording moved up to module level when the simple form learned to
  // refuse with it too: one constant, two forms, one rule.
  assert.match(src, /\nconst NEEDS_PASSWORD = '[^']*app password, not the account one/, 'the refusal names what Gmail and Yahoo actually want');
  assert.match(body, /status\.bad\(NEEDS_PASSWORD\)/, 'the mail editor no longer refuses with it');
  // Microsoft sign-in carries no password, so the guard must not fire there.
  assert.match(body, /authMethod\(\) === 'password' &&/, 'xoauth2 accounts are exempt');
});

test('REGRESSION: Test and List store the key in the field first, and Save refuses a hosted endpoint with no key', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const panel = /export function modelPanel\([\s\S]*?\n\}/m.exec(src);
  assert.ok(panel, 'modelPanel is missing');

  // "Test the connection" and "List available models" sent only the stored
  // keyRef. Paste a key, press Test, and the call went out naming a ref that
  // held nothing yet, and came back "No API key configured" about the key in
  // the field — the message contradicting the screen. There is no route that
  // carries a key alongside a test (secrets travel only through POST
  // /api/secrets, by design), so the fix is the one Save already had: store
  // the field, clear it, then call.
  const helper = /async function storeTypedKey\(\)[\s\S]*?\n {4}\}/m.exec(panel[0]);
  assert.ok(helper, 'storeTypedKey is missing');
  assert.match(helper[0], /api\.setSecret\(draft\.keyRef, key\)/);
  assert.match(helper[0], /keyInput\.value = ''/, 'a stored key must leave the field, as it does on Save');

  const testFn = /async function test\(\)[\s\S]*?\n {4}\}/m.exec(panel[0]);
  assert.ok(testFn, 'test() is missing');
  const listFn = /async function loadModels\(\)[\s\S]*?\n {4}\}/m.exec(panel[0]);
  assert.ok(listFn, 'loadModels() is missing');
  for (const [name, fn, call] of [['test', testFn[0], 'api.testModel('], ['loadModels', listFn[0], 'api.listModels(']]) {
    const stored = fn.indexOf('await storeTypedKey()');
    assert.ok(stored >= 0, `${name} ignores the key typed in the form`);
    assert.ok(stored < fn.indexOf(call), `${name} stores the key only after the call that needed it`);
    // With nothing typed and nothing stored, a hosted endpoint is refused
    // here, about the field, instead of by the server after the call.
    const guard = fn.indexOf('!isLocal() && !keyStored()');
    assert.ok(guard >= 0, `${name} lets a keyless call to a hosted endpoint go out`);
    assert.ok(guard < fn.indexOf(call), `${name} checks for a key after the call`);
  }

  // Save accepted a remote endpoint with no key, said nothing, and in
  // onboarding advanced on the strength of it — a model every sweep fails on.
  const saveFn = /async function save\(\)[\s\S]*?\n {4}\}/m.exec(panel[0]);
  assert.ok(saveFn, 'save() is missing');
  const refuse = /if \(!isLocal\(\) && !keyStored\(\) && !keyInput\.value\.trim\(\)\) \{[\s\S]*?status\.bad\([\s\S]*?return false;/m.exec(saveFn[0]);
  assert.ok(refuse, 'save() still writes a hosted model with no key');
  assert.ok(saveFn[0].indexOf(refuse[0]) < saveFn[0].indexOf('saveConfig('), 'the refusal comes after the save');

  // The trap in the fix: `state.secretRefs` is refreshed by a config save,
  // not by POST /api/secrets, so a key stored on the way into Test would
  // still read as missing when Save is pressed a moment later — and be
  // refused by the guard above, for a key the server already holds.
  assert.match(panel[0], /const keyStored = \(\) => state\.secretRefs\.includes\(draft\.keyRef\) \|\| storedHere\.has\(draft\.keyRef\)/,
    'keyStored() does not know about a key this panel stored itself');
  assert.match(helper[0], /storedHere\.add\(draft\.keyRef\)/);
});

test('REGRESSION: a failed sweep on an unconfigured home still offers "Choose a model", and the banner agrees', () => {
  const src = fs.readFileSync(path.join(UI, 'views/now.js'), 'utf8');

  // sweepTrouble() says 'whole' for any failed last run, and under a whole
  // failure renderNow drew the plain "Nothing on the board yet" shell instead
  // of emptyForContext — the only place "Choose a model" lives. On a home
  // with no model the first scheduled run fails thirty minutes in, so the
  // call to action the first screen exists for vanished at the first tick,
  // and the banner's one action, "Sweep again", ran the same failure.
  const missing = /function missingSetup\(\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(missing, 'missingSetup is missing');
  assert.match(missing[0], /state\.health\?\.model\?\.configured/);
  assert.match(missing[0], /'sources'/);

  const render = /export function renderNow\(ctx\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(render, 'renderNow is missing');
  assert.match(render[0], /if \(trouble === 'whole' && missingSetup\(\)\) \{\n\s*body\.appendChild\(emptyForContext\(navigate\)\);/,
    'under a whole failure on an unconfigured home the context empty state is still skipped');
  assert.match(render[0], /failureBanner\(trouble, navigate\)/, 'the banner cannot route anywhere without navigate');

  const banner = /function failureBanner\(trouble, navigate\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(banner, 'failureBanner is missing');
  assert.match(banner[0], /button\('Choose an AI', \{[^}]*navigate\('#\/settings\/model'\)/,
    'the banner on a modelless home does not open the model settings');
  assert.match(banner[0], /button\('Connect an email account', \{[^}]*navigate\('#\/settings\/mail'\)/,
    'the banner on a sourceless home does not open the mail settings');
  assert.match(banner[0], /button\('Check again'/, 'a configured home still gets the retry');
  // And on a home with no AI the sentence is about the choice, not about the
  // address the engine would have called — the one thing the audit's reader
  // had never typed and saw named in red.
  assert.match(banner[0], /missing === 'model' \? NO_AI_YET/, 'the whole-failure copy on a modelless home still repeats the engine\'s error');
  assert.match(src, /const NO_AI_YET = 'Zelos can’t read anything yet because no AI has been chosen\.'/);
  // The swap is on the whole-failure kind only: a partial failure read
  // something, and "Sweep again" there is real advice.
  assert.match(banner[0], /trouble === 'whole' \? missingSetup\(\) : null/);
});

test('REGRESSION: the secrets copy names the store in use — on the encrypted-file store they are in the folder it says to copy', async () => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');

  // Three hints said "your OS keychain" unconditionally, one of them under
  // the `rm -rf` block that follows "back it up by copying it". On the
  // encrypted-file store, secrets.enc and .seed both sit inside the home, and
  // a plain cp -R of it yields every credential in the clear from the copy.
  const file = settings.secretStoreNotes('encrypted-file');
  assert.match(file.data, /secrets\.enc/);
  assert.match(file.data, /\.seed/);
  assert.match(file.data, /copy of the folder is a copy of the credentials plus their key/);
  assert.doesNotMatch(file.data, /not in that directory/);
  for (const [slot, text] of Object.entries(file)) {
    assert.doesNotMatch(text, /keychain/i, `${slot} still promises a keychain on the file store`);
    assert.match(text, /secrets\.enc/, `${slot} does not say where the secret goes`);
  }

  // A real keychain keeps the wording it had; so does "not loaded yet".
  for (const name of ['macos-keychain', 'windows-credential-manager', 'libsecret', undefined, 'unknown']) {
    const notes = settings.secretStoreNotes(name);
    assert.match(notes.data, /OS keychain/, String(name));
    assert.match(notes.data, /not in that directory/, String(name));
    assert.match(notes.field, /OS keychain/, String(name));
    assert.match(notes.password, /OS keychain/, String(name));
  }

  // All three sites read the store the health document reports — the same
  // field aboutPanel reads — and none keeps a literal of its own.
  const read = /secretStoreNotes\(state\.health\?\.backend\?\.name\)/;
  const data = /function dataPanel\(\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(data, 'dataPanel is missing');
  assert.match(data[0], /secretStoreNotes\(state\.health\?\.backend\?\.name\)\.data/, 'the note under rm -rf is not branched on the store');
  assert.doesNotMatch(data[0], /OS keychain/, 'dataPanel still carries the unconditional keychain sentence');
  const cred = /export function credentialControl\([\s\S]*?\n\}/m.exec(src);
  assert.ok(cred, 'credentialControl is missing');
  assert.match(cred[0], /secretStoreNotes\(state\.health\?\.backend\?\.name\)\.field/, 'the connector credential hint is not branched on the store');
  assert.doesNotMatch(cred[0], /OS keychain/);
  const mail = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(mail, 'mailForm is missing');
  assert.match(mail[0], /secretStoreNotes\(state\.health\?\.backend\?\.name\)\.password/, 'the mail password hint is not branched on the store');
  assert.doesNotMatch(mail[0], /straight to your OS keychain/);
  assert.ok(read.test(src));
});

test('REGRESSION: the Now view sends a failed sweep to the terminal or desktop.log, never to a log file nothing writes', () => {
  const src = fs.readFileSync(path.join(UI, 'views/now.js'), 'utf8');
  // The default logger goes to stderr only; the one file logger in the tree
  // is the desktop shell's and is named desktop.log. The empty state under a
  // failed run pointed at "the log in your Zelos home", which is an empty
  // directory — the same wrong answer core/server.mjs's 500 detail used to
  // give, and corrected there first.
  assert.doesNotMatch(src, /zelos\.log/);
  assert.doesNotMatch(src, /The log in your Zelos home/);
  const failed = /title: 'The last check did not finish',\n\s*detail: ([^\n]+)/.exec(src);
  assert.ok(failed, 'the failed-sweep empty state is missing');
  assert.match(failed[1], /terminal/, 'the CLI case has to say the reason went to the terminal');
  assert.match(failed[1], /desktop\.log/, 'the desktop case has to name the file that exists');
  assert.match(failed[1], /no log file of its own/);
});

test('REGRESSION: the About panel names /api/mcp as the one call that does not carry the session token', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  // --help and the README already say it. The Settings view is where the AI
  // token is minted, and its "Where Zelos stands" list said "every API call
  // carries a session token minted at launch" with no exception — the
  // sentence somebody reads before deciding whether to switch AI access on.
  const about = /function aboutPanel\(\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(about, 'aboutPanel is missing');
  const line = /session token minted at launch[^\n]*/.exec(about[0]);
  assert.ok(line, 'the session-token sentence is gone');
  assert.match(line[0], /\/api\/mcp/, 'the panel does not mention the one route the session gate skips');
  assert.match(line[0], /AI token/, 'and it has to say which token that route carries instead');
  assert.match(line[0], /outlive a restart|survives? a restart|until you turn/,
    'the exception is only useful if it says the AI token is not per-launch');
});

/* ------------------------------------------------- 4. simple mail setup */

/**
 * The operator's first real mailbox took: know the IMAP host, find the
 * app-password page, paste, Test, Save, fix the sent folder — and it went in
 * with no password. "Sign in with Google" is what people expect, and Zelos
 * cannot ship it (docs/OAUTH.md: reading Gmail is a restricted scope, which
 * is an annual audit). So the app-password path is made to feel like sign-in:
 * one address, one button to the provider's own page, one paste, one Connect
 * that tests, finds the sent folder and saves. The wiring is pinned at the
 * source because the forms need a layout engine; the sequence itself runs for
 * real against a fake fetch, two tests down.
 */
test('Add an email account opens the simple form, and the simple form reaches the full one beneath its card', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const simple = /export function simpleMailForm\(\{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(simple, 'simpleMailForm is missing');

  // The Add path builds the simple form. The full form is the simple form's
  // own: "Server settings (for experts)" opens it in a slot BENEATH the card
  // — on the same id and keyRef, so a password Connect already stored is the
  // one the full form saves — and its Cancel empties that slot, leaving the
  // address and the card where they were. The old Advanced replaced the
  // whole card and threw the typed address away.
  const panel = /export function mailPanel\([\s\S]*?\n\}/m.exec(src);
  assert.ok(panel, 'mailPanel is missing');
  const add = /const addButton = button\('Add an email account'[\s\S]*?\n  \}\);/m.exec(panel[0]);
  assert.ok(add, 'the Add button is missing');
  assert.match(add[0], /editor\.replaceChildren\(simpleMailForm\(\{/, 'Add an email account no longer opens the simple form');
  assert.ok(!/onAdvanced/.test(panel[0]), 'the panel still swaps the card for the full form');
  const open = /async function openAdvanced\(\)[\s\S]*?\n  \}/m.exec(simple[0]);
  assert.ok(open, 'openAdvanced is missing');
  assert.match(open[0], /expertSlot\.replaceChildren\(mailForm\(\{/, 'the expert form does not open beneath the card');
  assert.match(open[0], /\.\.\.prefill\(\),/, 'what the guess found never reaches the full form');
  assert.match(open[0], /onCancel: \(\) => expertSlot\.replaceChildren\(\),/, 'closing the full form must leave the card, not the editor, behind');
  assert.match(open[0], /if \(expertSlot\.children\.length\) \{ expertSlot\.replaceChildren\(\); return; \}/, 'pressing the expert button again must close the drawer');
  const prefill = /const prefill = \(\) => \(\{[\s\S]*?\}\);/m.exec(simple[0]);
  assert.ok(prefill, 'prefill is missing');
  assert.match(prefill[0], /keyRef,/, 'the full form opens on a different keyRef, so the stored password is lost');
  // The card and the slot are both in the returned form, slot after card.
  const returned = /return el\('div', \{ class: 'account-form' \}, \[[\s\S]*?\]\);\n\}/m.exec(simple[0]);
  assert.ok(returned, 'the simple form returns nothing');
  assert.ok(returned[0].indexOf('card,') < returned[0].indexOf('expertSlot,'), 'the expert slot is not beneath the card');
  // Editing an account keeps the full form.
  assert.match(panel[0], /editor\.replaceChildren\(mailForm\(account, \{/, 'editing an account no longer uses the full form');
  // The button says what it is, and there are exactly two: under the address
  // before a card is up, and in the card after.
  assert.equal(simple[0].split("'Server settings (for experts)'").length - 1, 2, 'one expert button under the address and one in the card — no third');
  assert.ok(!/button\('Advanced'/.test(simple[0]), 'a bare "Advanced" is the label the audit\'s reader pressed hoping for help');

  // The guess comes from the server, by POST: the address travels in a body,
  // never in a query string.
  assert.match(simple[0], /api\.guessMail\(address\)/, 'the provider is never looked up');
  const apiSrc = fs.readFileSync(path.join(UI, 'lib/api.js'), 'utf8');
  assert.match(apiSrc, /guessMail: \(email\) => request\('\/api\/mail\/guess', \{ method: 'POST', body: \{ email \} \}\)/,
    'the address has to travel in a body, never in a query string');

  // The one button is a real link to the provider's own page — https only,
  // target=_blank, which is what desktop/guard.js hands to the system browser.
  assert.match(simple[0], /\/\^https:\\\/\\\/\/\.test\(guess\.appPasswordUrl \|\| ''\)/, 'a non-https page would be linked');
  assert.match(simple[0], /el\('a', \{ class: 'btn', href: guess\.appPasswordUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Get an app password' \}\)/);

  // Nothing typed and nothing stored is refused by the full form's rule,
  // before anything goes out — in the card's own words, about the box the
  // card has just opened: the old refusal said "paste it above" about a
  // password box that was still folded away.
  assert.match(simple[0], /const passwordMissing = \(\) => !passInput\.value && !storedHere\.has\(keyRef\)/);
  const connect = /async function connect\(\)[\s\S]*?\n  \}/m.exec(simple[0]);
  assert.ok(connect, 'connect() is missing');
  const guard = connect[0].indexOf('status.bad(needsPassword(guess))');
  assert.ok(guard > 0 && guard < connect[0].indexOf('connectSimpleMail('), 'Connect goes ahead with no password');
  const reveal = connect[0].indexOf('revealPassword();');
  assert.ok(reveal > 0 && reveal < guard, 'the password box must be opened before the card asks for a paste into it');

  // Microsoft's personal domains get the existing sign-in block, not a copy.
  assert.match(simple[0], /microsoft = microsoftSignIn\(\{/, 'the xoauth2 branch does not reuse the sign-in block');
  for (const call of ['beginMailOAuth', 'mailOAuthStatus', 'cancelMailOAuth']) {
    assert.ok(!simple[0].includes(`api.${call}(`), `the simple form carries its own api.${call} — the device flow now exists twice`);
  }
  // Proton goes to the full form with Bridge's address already in it.
  assert.match(simple[0], /guess\.auth === 'bridge'/, 'Proton Bridge is not recognised');
  // A failed Connect leaves the card's own Advanced as the way to the full
  // form, and adds no second one under the error.
  assert.ok(!/Show advanced/.test(simple[0]), 'a failure adds a second route to the full form');
});

/**
 * The operator's screenshot, v1.2.0, his own Workspace address: the card read
 * "A provider Zelos does not know · imap.<his domain>:993", printed a literal
 * "null" where the app-password link goes, and after Connect failed there
 * were two buttons to the full form. The null came from the DOM's own
 * replaceChildren, which turns a null child into the text "null" where
 * dom.js's el()/replace() skip it; the fix is to paint the card through
 * replace(). The rest is what the server now says about HOW it knows.
 */
test('the provider card prints no null, says how it knows, and keeps one route to the full form', async () => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const simple = /export function simpleMailForm\(\{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(simple, 'simpleMailForm is missing');
  assert.match(src, /import \{[^}]*\breplace\b[^}]*\} from '\.\.\/lib\/dom\.js'/, 'replace() is not imported from dom.js');

  // dom.js's contract, which the card relies on: a null child is skipped.
  const dom = fs.readFileSync(path.join(UI, 'lib/dom.js'), 'utf8');
  assert.match(dom, /function append\(node, children\) \{\n  if \(children === null \|\| children === undefined \|\| children === false\) return;/);
  assert.match(dom, /export function replace\(node, children\) \{\n  node\.replaceChildren\(\);\n  append\(node, children\);/);

  // No native replaceChildren call that paints the CARD carries a child that
  // can be null: walk each call to its closing paren and look for a ternary
  // or && that yields one. (The expert slot's call opens the full form on an
  // account literal, whose `requireTls: null` is a value, not a child.)
  const calls = [];
  let from = 0;
  for (;;) {
    const at = simple[0].indexOf('card.replaceChildren(', from);
    if (at < 0) break;
    let depth = 0;
    let end = at + 'card.replaceChildren('.length - 1;
    for (; end < simple[0].length; end += 1) {
      if (simple[0][end] === '(') depth += 1;
      else if (simple[0][end] === ')') { depth -= 1; if (depth === 0) break; }
    }
    calls.push(simple[0].slice(at, end + 1));
    from = end;
  }
  assert.ok(calls.length > 0, 'the card is never painted');
  for (const call of calls) {
    assert.ok(!/:\s*null\b/.test(call) && !/&&\s*el\(/.test(call), `a native replaceChildren carries a child that can be null — the card prints "null":\n${call}`);
  }
  // The password branch — the one with the optional link — goes through
  // replace(), and the optional link is built into the password path with el(),
  // which skips a null child too.
  assert.match(simple[0], /replace\(card, \[\n\s+head,\n\s+note,\n\s+passwordPath,/, 'the app-password path is not painted through replace()');
  assert.match(simple[0], /const passwordPath = el\('div', \{ class: 'stack' \}, \[\n\s+page \? el\('div', \{ class: 'row-inline' \}, \[page\]\) : null,/, 'the optional link is not built through el()');

  // The mono line says how the server knows, for a domain it looked up — and
  // only for one it looked up. A recognised provider shows its name and not
  // "imap.gmail.com:993", which read to the audit's reader as an address to
  // check; the server's own line is kept one drawer down.
  const paint = /function paintCard\(\)[\s\S]*?\n  \}/m.exec(simple[0]);
  assert.ok(paint, 'paintCard is missing');
  assert.match(paint[0], /guess\.via === 'mx' \? ' · found through your domain\\'s mail records'/, 'an MX hit does not say so');
  assert.match(paint[0], /guess\.via === 'srv' \? ' · advertised by your domain'/, 'an SRV hit does not say so');
  assert.match(paint[0], /guess\.host && !guess\.known \? el\('span', \{ class: 'mono account-host', text: `\$\{guess\.host\}:\$\{guess\.port\}\$\{via\}` \}\) : null/, 'the via line is shown for a recognised provider, or not shown for a guess');
  assert.match(paint[0], /text: `\$\{guess\.host\}:\$\{guess\.port\}\$\{via\}\. \$\{guess\.note\}`/, 'the server\'s own note and host are gone rather than folded');
  assert.match(paint[0], /const note = el\('p', \{ class: 'quiet-note', text: plainProviderNote\(guess\) \}\)/, 'the card\'s note is not the plain one');
  // A plain guess still says it is guessing, in plainProviderNote's words.
  assert.match(settings.plainProviderNote({ host: 'imap.hale.example', port: 993, known: false }), /We guessed imap\.hale\.example — Connect will tell you if that is right/);
  assert.match(settings.plainProviderNote({ host: 'imap.gmail.com', port: 993, known: true, label: 'Gmail', signIn: 'google', clientReady: false }), /16-letter password/);
  assert.match(settings.plainProviderNote({ host: 'imap.mail.me.com', port: 993, known: true, label: 'iCloud Mail' }), /^iCloud needs a special password/);

  // One route to the full form: the card's expert button, and nothing added on failure.
  const connect = /async function connect\(\)[\s\S]*?\n  \}/m.exec(simple[0]);
  assert.ok(connect, 'connect() is missing');
  assert.ok(!/openAdvanced/.test(connect[0]), 'connect() builds its own way to the full form');
  assert.ok(!/\bfallback\b/.test(simple[0]), 'the failure-path container is still there');
  assert.equal(simple[0].split("'Server settings (for experts)'").length - 1, 2, 'one expert button under the address (hidden once a card is up) and one in the card — no third');
  // And the password a failed Connect stored still carries over.
  assert.match(connect[0], /storedHere\.add\(keyRef\)/);
  assert.match(simple[0], /if \(storedHere\.size\) await loadConfig\(\)\.catch\(\(\) => \{\}\);\n\s+expertSlot\.replaceChildren\(mailForm\(\{/);

  // The hint under the address is one sentence, and it is about the person,
  // not about DNS. (What goes to the resolver — the domain, never the address
  // — is still true, still in core/sources/imap.mjs, and pinned there.)
  assert.match(simple[0], /hint: 'Your address stays on this computer\.'/);
});

test('Connect stores, tests, reads the sent folder and saves — in that order and no other', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const fn = /export async function connectSimpleMail\([\s\S]*?\n\}/m.exec(src);
  assert.ok(fn, 'connectSimpleMail is missing');
  const at = (needle) => {
    const i = fn[0].indexOf(needle);
    assert.ok(i >= 0, `${needle} is missing from connectSimpleMail`);
    return i;
  };
  const stored = at('api.setSecret(');
  const tested = at('api.testMail(');
  const sent = at('sentMailboxFromTest(result.mailboxes');
  const saved = at('await saveConfig(patch)');
  assert.ok(stored < tested, 'the test goes out naming a ref that holds nothing yet');
  assert.ok(tested < sent, 'the sent folder is read before the server has listed it');
  assert.ok(sent < saved, 'the account is saved before its sent folder is known');
  // The test and the saved account carry the TLS rule the full form's Test
  // sends for a new account, and adopt the address by the full form's rule.
  assert.match(fn[0], /const requireTls = requireTlsFor\('auto'\)/);
  assert.match(fn[0], /patch\.identity = \{ email: adopted \}/);
  assert.match(fn[0], /!known &&/, 'an address the user already chose must not be overwritten');
});

test('Connect with a passing test saves an account whose sent folder is the one the server flags', async (t) => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const store = await import(fileUrl(UI, 'lib/store.js'));

  const calls = [];
  let config = { identity: { name: '', email: '' }, mail: [] };
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const answer = async (reqPath, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: reqPath, body });
    if (reqPath === '/api/secrets') return ok({ ok: true });
    if (reqPath === '/api/mail/test') {
      return ok({ ok: true, capabilities: [], error: null, mailboxes: [
        { name: 'INBOX', specialUse: 'inbox' },
        { name: '[Gmail]/Sent Mail', specialUse: 'sent' },
        { name: '[Gmail]/Drafts', specialUse: 'drafts' },
      ] });
    }
    if (reqPath === '/api/config') {
      config = { ...config, ...body, identity: { ...config.identity, ...(body.identity || {}) } };
      return ok({ config, errors: [], secretRefs: ['mail.m_1'] });
    }
    if (reqPath === '/api/health') return ok({ model: { configured: false } });
    throw new Error(`unexpected ${reqPath}`);
  };
  globalThis.fetch = answer;
  t.after(() => { delete globalThis.fetch; });
  store.state.config = config;

  const guess = { label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, auth: 'password', appPasswordUrl: 'https://example.com/app', note: '', known: true };
  const outcome = await settings.connectSimpleMail({ id: 'm_1', keyRef: 'mail.m_1', email: 'nemo@gmail.com', password: 'abcd efgh ijkl mnop', guess });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.sentMailbox, '[Gmail]/Sent Mail');
  assert.equal(outcome.mailboxes, 3);
  assert.equal(outcome.adopted, 'nemo@gmail.com', 'the first mailbox becomes who you are, as it does in the full form');

  // The wire, in order: the password, then the test naming its ref, then the save.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`).slice(0, 3), ['POST /api/secrets', 'POST /api/mail/test', 'PUT /api/config']);
  assert.deepEqual(calls[0].body, { ref: 'mail.m_1', value: 'abcd efgh ijkl mnop' });
  assert.deepEqual(calls[1].body, { host: 'imap.gmail.com', port: 993, secure: true, user: 'nemo@gmail.com', keyRef: 'mail.m_1', requireTls: null });

  const saved = calls[2].body;
  assert.equal(saved.mail.length, 1);
  const account = saved.mail[0];
  assert.equal(account.sentMailbox, '[Gmail]/Sent Mail', 'the stored default "Sent" does not exist on Gmail');
  assert.equal(account.user, 'nemo@gmail.com');
  assert.equal(account.keyRef, 'mail.m_1');
  assert.equal(account.auth, 'password');
  assert.equal(account.requireTls, null);
  assert.equal(account.label, 'Gmail');
  assert.deepEqual(account.mailboxes, ['INBOX']);
  assert.equal(account.lookbackDays, 14);
  assert.equal(account.maxMessages, 400);
  assert.deepEqual(saved.identity, { email: 'nemo@gmail.com' });
  assert.ok(!JSON.stringify(saved).includes('abcd efgh'), 'the password reached the config');

  // A refused connection saves nothing and says what the server said.
  calls.length = 0;
  globalThis.fetch = async (reqPath, init) => (reqPath === '/api/mail/test'
    ? ok({ ok: false, mailboxes: [], error: 'imap.gmail.com: [AUTHENTICATIONFAILED] Invalid credentials' })
    : answer(reqPath, init));
  const refused = await settings.connectSimpleMail({ id: 'm_2', keyRef: 'mail.m_2', email: 'nemo@gmail.com', password: 'wrong', guess });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /AUTHENTICATIONFAILED/, 'the server\'s own words, verbatim');
  assert.ok(!calls.some((c) => c.method === 'PUT' && c.path === '/api/config'), 'a refused account was saved anyway');

  // A retry with the field left empty does not overwrite the stored password with nothing.
  calls.length = 0;
  globalThis.fetch = answer;
  await settings.connectSimpleMail({ id: 'm_3', keyRef: 'mail.m_3', email: 'nemo@gmail.com', password: '', guess });
  assert.ok(!calls.some((c) => c.path === '/api/secrets'), 'an empty field was stored over the password');
  // And the address is not adopted twice: it was set by the first save.
  assert.equal(calls.find((c) => c.path === '/api/config').body.identity, undefined);
});

/* ----------------------------------------------- 6. "Sign in with Google" */

/**
 * The product decision: app passwords are the floor, and Google and Microsoft
 * sign in on top of it. The Google block is built against the route contract
 * before the route exists, so what these pin is the page's half of it — the
 * calls it makes, the shape it returns, what it shows first, and the two things
 * that must never be on screen for longer than they are needed.
 */

const googleBlock = (src) => {
  const m = /\nfunction googleSignIn\(\{ keyRef, email, clientReady[^)]*\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(m, 'googleSignIn is missing, or no longer takes { keyRef, email, clientReady, … }');
  return m[0];
};

test('Sign in with Google has the shape of Sign in with Microsoft, and opens Google in a new tab', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const flow = googleBlock(src);

  // The same three calls as the Microsoft block, the same provider on the wire,
  // and the same return shape, so either form can show either block.
  for (const call of ['beginMailOAuth', 'mailOAuthStatus', 'cancelMailOAuth']) {
    assert.match(flow, new RegExp(`api\\.${call}\\(`), `the Google block never calls api.${call}`);
  }
  assert.match(flow, /api\.beginMailOAuth\(\{\n\s+provider: 'google',\n\s+keyRef,\n\s+email: address\(\),/, 'the flow does not name its provider, keyRef and address');
  assert.match(flow, /return \{\n\s+node,\n\s+oauth,[\s\S]*?stop\(\) \{/, 'the block does not return { node, oauth, stop }');
  assert.match(flow, /const oauth = \(\) => \(\{ provider: 'google', clientId: clientIdInput\.value\.trim\(\) \|\| grantedClientId \}\)/, 'oauth() is not the account shape');

  // The sign-in page opens through an https-only target=_blank anchor — what
  // desktop/guard.js hands to the system browser — and the anchor stays on
  // screen as the thing to press if the automatic open was blocked.
  assert.match(flow, /\/\^https:\\\/\\\/\/\.test\(flow\.authUrl \|\| ''\)/, 'a non-https sign-in page would be opened');
  assert.match(flow, /el\('a', \{ class: 'btn', href: flow\.authUrl, target: '_blank', rel: 'noopener noreferrer', text: /, 'the sign-in page is not a real new-tab link');
  assert.match(flow, /page\?\.click\(\)/, 'the tab is never opened for the user');
  assert.ok(!/window\.open\(/.test(flow), 'window.open is a popup the shell denies; the anchor is the route guard.js routes');

  // Every 1.5 s, and the verdict is read off `status` or `state`, whichever the
  // server sent — the device flow has always said `state`.
  assert.match(flow, /\}, 1500\);/, 'the poll is not every 1.5 s');
  assert.match(src, /\nconst flowStatus = \(flow\) => flow\?\.status \?\? flow\?\.state;/, 'flowStatus no longer reads both spellings');
  assert.match(flow, /if \(flowStatus\(now\) === 'pending'\) return;/, 'the poll reads the field by one name only');
  assert.match(flow, /flowStatus\(flow\)/, 'the landing reads the field by one name only');
  const microsoft = /\nfunction microsoftSignIn\([\s\S]*?\n\}/m.exec(src);
  assert.ok(microsoft, 'microsoftSignIn is missing');
  assert.ok(!/\bnow\.state\b|\bflow\.state\b/.test(microsoft[0]), 'the Microsoft block still reads `state` by name, so the renamed field strands it');

  // What it says, and what it hands back: the address the token is for, and
  // the account shape the caller saves.
  assert.match(flow, /`Signed in as \$\{flow\.user\}/, 'the status line does not say who is signed in');
  assert.match(flow, /onConnected\?\.\(\{ keyRef, provider: 'google', clientId: oauth\(\)\.clientId, user: flow\.user \|\| '' \}\)/, 'onConnected does not hand back the account shape');
  // And the address is never in anything this block builds a URL from.
  assert.ok(!/href:[^\n]*address\(\)/.test(flow) && !/href:[^\n]*email/.test(flow), 'the address is put in a URL');
});

test('a Gmail address is offered Google first when Zelos can sign in, and the app password first when it cannot', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const simple = /export function simpleMailForm\(\{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(simple, 'simpleMailForm is missing');
  const paint = /function paintCard\(\)[\s\S]*?\n  \}/m.exec(simple[0]);
  assert.ok(paint, 'paintCard is missing');

  // The Google branch comes before the password one, reuses the one block,
  // and paints through replace() like the password branch (a null page link).
  const google = paint[0].indexOf("if (guess.signIn === 'google') {");
  const password = paint[0].indexOf('replace(card, [\n      head,\n      note,\n      passwordPath,');
  assert.ok(google > 0, 'no branch for a provider that signs in with Google');
  assert.ok(password > google, 'the password card is painted before the Google one is considered');
  assert.match(paint[0], /const ready = guess\.clientReady === true;/, 'the card does not read the server\'s clientReady');
  assert.match(paint[0], /google = googleSignIn\(\{\n\s+keyRef,\n\s+email,\n\s+clientReady: ready,/, 'the card does not reuse the Google block, or does not pass the server\'s clientReady');
  const branch = paint[0].slice(google, password);
  // With a client: Google first, password one link beneath. Without one —
  // which is every build until Google's review is done — the app password IS
  // the card, and the sign-in with its "paste your own client" fields is a
  // drawer a developer opens. The audit's reader met the sign-in first, was
  // told it did not work yet, and was asked for a Google Cloud client.
  assert.match(branch, /replace\(card, ready\n\s+\? \[\n\s+head,\n\s+note,\n\s+google\.node,\n\s+usePassword,\n\s+passwordPath,/, 'with a client the Google block is not first, or the password path is not beneath it');
  assert.match(branch, /: \[\n\s+head,\n\s+note,\n\s+passwordPath,\n[\s\S]*?fold\('For developers', google\.node\),/, 'without a client the password path is not the card, or the sign-in is not folded under For developers');

  // The password path is the existing nodes, hidden with [hidden] until the
  // link is pressed when a sign-in is on offer — and on screen from the start
  // when it is the only way in. Connect opens it too, before it asks for a
  // paste into it.
  assert.match(branch, /button\('Use an app password instead', \{\n\s+class: 'link',/, 'there is no "Use an app password instead" link');
  assert.match(branch, /passwordPath\.hidden = ready;/, 'the password path is hidden when it is the only way in, or shown when a sign-in is on offer');
  assert.match(branch, /usePassword\.hidden = !ready;/, 'the link to a hidden path is offered when nothing is hidden');
  assert.match(branch, /onClick: \(\) => \{ passwordPath\.hidden = false; usePassword\.hidden = true; \}/, 'the link does not reveal the password path');
  assert.match(branch, /revealPassword = \(\) => \{ passwordPath\.hidden = false; usePassword\.hidden = true; \};/, 'Connect has no way to open the password box');
  assert.match(paint[0], /field\('App password', passInput,/, 'the password path is a second password field, not the existing one');
  // Still exactly one route to the full form, and the simple form still
  // makes none of the OAuth calls itself.
  assert.equal(simple[0].split("'Server settings (for experts)'").length - 1, 2, 'the Google card added a route to the full form');
  for (const call of ['beginMailOAuth', 'mailOAuthStatus', 'cancelMailOAuth']) {
    assert.ok(!simple[0].includes(`api.${call}(`), `the simple form carries its own api.${call}`);
  }
  // Both blocks are stopped wherever the Microsoft one was.
  for (const stop of ['microsoft?.stop();\n    google?.stop();', 'microsoft?.stop(); google?.stop(); onCancel();']) {
    assert.ok(simple[0].includes(stop), `a Google poll outlives its card: ${stop}`);
  }
  // The onboarding step promises nothing about providers; the card does the
  // explaining once the address is typed.
  const onboarding = fs.readFileSync(path.join(UI, 'views/onboarding.js'), 'utf8');
  assert.ok(!/Gmail, iCloud and Yahoo will all refuse your normal password/.test(onboarding), 'onboarding still says Gmail only takes an app password');
  assert.match(onboarding, /Type your email address and Zelos will show you the next step\./, 'the email step does not say the one thing it needs to');
});

test('the Google client secret is typed into a password field, sent once and not kept', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const flow = googleBlock(src);
  assert.match(flow, /const secretInput = el\('input', \{ class: 'input', type: 'password', autocomplete: 'off'/, 'the client secret is not a password field');
  const start = /async function start\(\)[\s\S]*?\n  \}/m.exec(flow);
  assert.ok(start, 'start() is missing');
  const read = start[0].indexOf('const clientSecret = secretInput.value;');
  const cleared = start[0].indexOf("secretInput.value = '';");
  const sent = start[0].indexOf('await api.beginMailOAuth(');
  assert.ok(read > 0, 'the secret is never read');
  assert.ok(cleared > read && cleared < sent, 'the field still holds the secret while the request is out');
  assert.match(start[0], /\.\.\.\(clientSecret \? \{ clientSecret \} : \{\}\)/, 'an empty secret is sent as a field');
  // Never in what the block hands back, never in the account.
  assert.ok(!/oauth = \(\) => \([^)]*[Ss]ecret/.test(flow), 'oauth() carries the secret into the saved account');
  assert.ok(!/onConnected\?\.\([^)]*[Ss]ecret/.test(flow), 'onConnected carries the secret');
  // The own-client fields are collapsed under one link, with [hidden].
  assert.match(flow, /ownClient\.hidden = !clientId;/, 'the own-client fields are not collapsed');
  assert.match(flow, /button\('Use your own Google Cloud client', \{\n\s+class: 'link',/, 'there is no link to reveal them');
  // And with the shipped client ready they are not offered at all: one button.
  assert.match(flow, /clientReady\n\s+\? \[signInButton, signInStatus\.node, flowBox\]/, 'a ready client still shows the registration fields');
  assert.match(flow, /Zelos’s own Google app is not registered yet/, 'no sentence says why the fields are there');
});

test('a Google sign-in stops asking the server when its block is stopped', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const flow = googleBlock(src);
  assert.match(flow, /const stopPolling = \(\) => \{ if \(poll\) \{ clearInterval\(poll\); poll = null; \} \};/, 'there is no way to clear the timer');
  assert.match(flow, /stop\(\) \{ stopPolling\(\); flowBox\.replaceChildren\(\); \}/, 'stop() does not clear the timer');
  assert.match(flow, /poll = setInterval\(async \(\) => \{/, 'the poll is not the interval stop() clears');
  // A finished flow, a cancelled one, and a 404 all stop it too.
  const landed = /const landed = \(flow\) => \{\n\s+stopPolling\(\);/.test(flow);
  assert.ok(landed, 'a landed flow keeps polling');
  const cancel = /const cancel = async \(\) => \{\n\s+const id = flowId;\n\s+stopPolling\(\);/.test(flow);
  assert.ok(cancel, 'Give up keeps polling');
  assert.match(flow, /\} catch \(err\) \{\n\s+\/\/ A 404[\s\S]*?stopPolling\(\);/, 'a 404 keeps polling');
  assert.match(flow, /if \(id\) await api\.cancelMailOAuth\(id\)\.catch/, 'Give up does not tell the server');
});

test('Connect on a mailbox signed in with Google saves an OAuth account and stores no password', async (t) => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const store = await import(fileUrl(UI, 'lib/store.js'));

  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (reqPath, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: reqPath, body });
    if (reqPath === '/api/mail/test') {
      return ok({ ok: true, capabilities: [], error: null, mailboxes: [
        { name: 'INBOX', specialUse: 'inbox' },
        { name: '[Gmail]/Sent Mail', specialUse: 'sent' },
      ] });
    }
    if (reqPath === '/api/config') return ok({ config: { identity: { email: 'nemo@gmail.com' }, mail: body.mail }, errors: [], secretRefs: ['mail.m_7'] });
    if (reqPath === '/api/health') return ok({ model: { configured: false } });
    throw new Error(`unexpected ${reqPath}`);
  };
  t.after(() => { delete globalThis.fetch; });
  store.state.config = { identity: { name: '', email: 'nemo@gmail.com' }, mail: [] };

  const guess = { label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, auth: 'password', signIn: 'google', clientReady: true, appPasswordUrl: 'https://example.com/app', note: '', known: true };
  const outcome = await settings.connectSimpleMail({
    id: 'm_7', keyRef: 'mail.m_7', email: 'nemo@gmail.com', password: '', guess,
    // The block's oauth() carries the client the sign-in actually ran
    // against — the server's own, when the field on screen was empty —
    // because a saved `clientId: ''` is an account the sweep cannot refresh.
    auth: 'xoauth2', oauth: { provider: 'google', clientId: '4242-zelos.apps.googleusercontent.com' },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sentMailbox, '[Gmail]/Sent Mail');

  // No password goes anywhere; the test and the saved account both say how
  // the mailbox signs in, in the shape the sweep reads.
  assert.ok(!calls.some((c) => c.path === '/api/secrets'), 'a password was stored for a signed-in mailbox');
  const tested = calls.find((c) => c.path === '/api/mail/test').body;
  assert.equal(tested.auth, 'xoauth2');
  assert.deepEqual(tested.oauth, { provider: 'google', clientId: '4242-zelos.apps.googleusercontent.com' });
  assert.equal(tested.keyRef, 'mail.m_7', 'the test names the ref the grant was filed under');
  const account = calls.find((c) => c.path === '/api/config').body.mail[0];
  assert.equal(account.auth, 'xoauth2');
  assert.deepEqual(account.oauth, { provider: 'google', clientId: '4242-zelos.apps.googleusercontent.com' });
  assert.equal(account.host, 'imap.gmail.com');

  // And the simple form routes a finished Google sign-in through exactly
  // this: a guess that said "password" becomes xoauth2 once the sign-in has
  // landed, with the block's own oauth() and no password.
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const simple = /export function simpleMailForm\(\{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(simple, 'simpleMailForm is missing');
  assert.match(simple[0], /const viaGoogle = \(\) => guess\?\.signIn === 'google' && signedIn;/, 'the form cannot tell a Google sign-in has landed');
  const connect = /async function connect\(\)[\s\S]*?\n  \}/m.exec(simple[0]);
  assert.ok(connect, 'connect() is missing');
  assert.match(connect[0], /const auth = viaGoogle\(\) \? 'xoauth2' : guess\.auth;/, 'a signed-in Gmail mailbox is still connected as a password account');
  assert.match(connect[0], /const password = auth === 'xoauth2' \? '' : passInput\.value;/, 'a pasted password rides along with a sign-in');
  assert.match(connect[0], /auth,\n\s+oauth: auth === 'xoauth2' \? signInBlock\(\)\?\.oauth\(\) \?\? null : null,/, 'connect() does not pass the block\'s oauth()');
  assert.match(connect[0], /if \(auth === 'password' && passwordMissing\(\)\)/, 'a signed-in mailbox is refused for having no password');
  // The prefill Advanced opens on carries the sign-in the same way.
  assert.match(simple[0], /\.\.\.\(guess\?\.auth === 'xoauth2' \|\| viaGoogle\(\) \? \{ auth: 'xoauth2', oauth: signInBlock\(\)\?\.oauth\(\) \?\? null \} : \{\}\)/, 'Advanced loses a finished Google sign-in');
});

test('Advanced offers Sign in with Google, and an account signed in that way says so', async () => {
  stubBrowserGlobals();
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');

  // The option sits next to Microsoft's, and its value is the picker's own:
  // config validates two methods, and this is not a third.
  const values = settings.MAIL_AUTH_CHOICES.map((c) => c.value);
  assert.deepEqual(values, ['password', 'google', 'xoauth2'], 'the picker does not offer Google next to Microsoft');
  assert.equal(settings.MAIL_AUTH_CHOICES.find((c) => c.value === 'google').label, 'Sign in with Google');
  const cfg = fs.readFileSync(path.join(ROOT, 'core/config.mjs'), 'utf8');
  assert.ok(!/MAIL_AUTH_METHODS[^\n]*'google'/.test(cfg), 'the picker value leaked into config as a method');

  const form = /function mailForm\(account, \{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(form, 'mailForm is missing');
  const body = form[0];
  // The translation: the picker says google, the draft says xoauth2 + provider.
  assert.match(body, /const authMethod = \(\) => \(authSelect\.value === 'password' \? 'password' : 'xoauth2'\);/, 'the Google choice is written to draft.auth as-is');
  assert.match(body, /const provider = \(\) => \(authSelect\.value === 'google' \? 'google' : 'microsoft'\);/, 'the form cannot tell which provider was picked');
  assert.match(body, /const googleAccount = \(\) => draft\.auth === 'xoauth2' && draft\.oauth\?\.provider === 'google';/, 'an account with no provider is not read as Microsoft');
  assert.match(body, /value: draft\.auth === 'xoauth2' \? \(googleAccount\(\) \? 'google' : 'xoauth2'\) : 'password',/, 'editing a Google account opens the picker on Microsoft');
  // The credential slot shows the same block the simple form does, and an
  // account already signed in says so with a way to sign in again.
  assert.match(body, /const buildGoogle = \(\) => googleSignIn\(\{/, 'the full form does not reuse the Google block');
  assert.match(body, /signedInAs: googleAccount\(\) \? draft\.user : '',/, 'an existing Google account does not say who it is signed in as');
  const flow = googleBlock(src);
  assert.match(flow, /if \(signedInAs\) signInStatus\.good\(`Signed in · \$\{signedInAs\}`\);/, 'the block does not read "Signed in · <user>"');
  assert.match(flow, /button\(signedInAs \? 'Sign in again' : 'Sign in with Google'/, 'there is no "Sign in again"');
  assert.match(body, /credentialSlot\.replaceChildren\(google\.node\);/, 'the Google block is built but never placed');
  // Whether a client is ready is the server's answer, asked once, about the
  // provider rather than the account's address.
  assert.match(body, /googleReady = \(await api\.guessMail\('you@gmail\.com'\)\)\.clientReady === true;/, 'clientReady is guessed on the page instead of asked of the server');
  assert.match(body, /onConnected: \(oauth\) => \{ draft\.auth = 'xoauth2'; draft\.oauth = \{ provider: 'google', clientId: oauth\.clientId \}; \},/, 'a finished sign-in does not land on the draft');
  // Test the connection tests the account that will be saved: with its auth.
  assert.match(body, /\.\.\.\(authMethod\(\) === 'xoauth2' \? \{ auth: 'xoauth2', oauth: activeOAuth\(\) \} : \{\}\),/, 'Test the connection tests a signed-in account as a password one');
  // Moving the picker stops whichever block is no longer showing.
  assert.match(body, /if \(!xo \|\| viaGoogle\) microsoft\?\.stop\(\);\n\s+if \(!viaGoogle\) google\?\.stop\(\);/, 'a poll outlives its slot');
});

test('the Microsoft registration form is hidden when the server ships the client', () => {
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const flow = /\nfunction microsoftSignIn\(\{ keyRef, user, clientId = '', tenantId = 'common', clientReady = false,[\s\S]*?\n\}/m.exec(src);
  assert.ok(flow, 'microsoftSignIn does not take clientReady');
  // Folded under "For work accounts (advanced)" and hidden with [hidden], so
  // the CSS rule every disclosure relies on applies; the fields stay, because
  // a tenant of one's own is typed into them. A shipped client hides the
  // whole drawer; without one the drawer is there, closed, and the button
  // above it is still the first thing.
  assert.match(flow[0], /const registration = el\('div', \{ class: 'stack' \}, \[\n\s+field\('Application \(client\) ID', clientIdInput,/, 'the fields are not wrapped to be hidden');
  assert.match(flow[0], /const workAccounts = fold\('For work accounts \(advanced\)', registration\);/, 'the registration fields are on the card rather than in a drawer');
  assert.match(flow[0], /workAccounts\.hidden = clientReady;/, 'the registration drawer is not hidden for a shipped client');
  // The id is required only when there is no client to fall back on, and is
  // sent only when typed — the provider is always named. And when it is
  // missing, the big button answers with the page that walks through the
  // one-time setup, never with a sentence about an "application (client) ID".
  assert.match(flow[0], /if \(!clientReady && !clientIdInput\.value\.trim\(\)\) \{/, 'a shipped client still demands a client id');
  const missing = /if \(!clientReady && !clientIdInput\.value\.trim\(\)\) \{[\s\S]*?\n {6}return;\n {4}\}/.exec(flow[0]);
  assert.ok(missing, 'the missing-client branch is gone');
  assert.ok(!/is required/.test(missing[0]), 'the button still answers "…ID is required"');
  assert.match(missing[0], /setupLink\(setupUrl\)/, 'the button does not route to the setup page');
  assert.match(src, /function setupLink\(href\)[\s\S]*?text: 'Show me how ↗'/, 'there is no Show me how link');
  // The page itself is the server's (GET /api/guides): ui/ names no remote host.
  assert.ok(!/github\.com|OAUTH\.md#/.test(src.replace(/^\s*(\*|\/\/).*$/gm, '')), 'the setup page is spelled out in ui/');
  const server = fs.readFileSync(path.join(ROOT, 'core/server.mjs'), 'utf8');
  assert.match(server, /microsoftSetup: 'https:\/\/github\.com\/HoosAI-Platform\/zelos\/blob\/main\/docs\/OAUTH\.md#microsoft/, 'the server does not point at the OAuth doc\'s Microsoft section');
  assert.match(flow[0], /api\.beginMailOAuth\(\{\n\s+provider: 'microsoft',\n\s+keyRef,\n\s+\.\.\.\(chosen\.clientId \? \{ clientId: chosen\.clientId \} : \{\}\),/, 'the Microsoft flow does not name its provider, or sends an empty client id');
  assert.match(flow[0], /const oauth = \(\) => \(\{ provider: 'microsoft', clientId:/, 'a Microsoft account is saved without its provider');
  // And the simple form passes the server's word for it, and puts the setup
  // page on the card before the button when there is no client to press it with.
  const simple = /export function simpleMailForm\(\{ onSaved, onCancel \}\)[\s\S]*?\n\}/m.exec(src);
  assert.ok(simple, 'simpleMailForm is missing');
  assert.match(simple[0], /microsoft = microsoftSignIn\(\{\n\s+keyRef,\n\s+user: email,[\s\S]*?clientReady: guess\.clientReady === true,/, 'the card does not pass clientReady to the Microsoft block');
  assert.match(simple[0], /guess\.clientReady \? null : el\('div', \{ class: 'row-inline' \}, \[setupLink\(guess\.setupUrl\)\]\)/, 'a Hotmail card with no client does not show the way to the one-time setup');
  assert.match(simple[0], /Promise\.all\(\[api\.guessMail\(address\), guideLinks\(\)\]\)/, 'the card does not ask the server for the setup page');
});

test('beginMailOAuth names the provider and carries the secret and address, and an old caller sends what it always sent', async (t) => {
  stubBrowserGlobals();
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  let captured = null;
  globalThis.fetch = async (reqPath, init = {}) => {
    captured = { path: reqPath, method: init.method, body: init.body ? JSON.parse(init.body) : null };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  t.after(() => { delete globalThis.fetch; });

  await api.beginMailOAuth({ provider: 'google', keyRef: 'mail.m_1', clientId: 'abc.apps', clientSecret: 'not-a-real-secret', email: 'nemo@gmail.com' });
  assert.equal(captured.path, '/api/mail/oauth');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, { provider: 'google', keyRef: 'mail.m_1', clientId: 'abc.apps', clientSecret: 'not-a-real-secret', email: 'nemo@gmail.com' });
  assert.ok(!reqPathHolds(captured.path, 'nemo@gmail.com'), 'the address is in the URL');

  // The call the Microsoft block made before Google existed: the same three
  // fields and nothing else, so the server's default provider still applies.
  await api.beginMailOAuth({ keyRef: 'mail.m_2', clientId: '00000000-0000-0000-0000-000000000000', tenantId: 'common' });
  assert.deepEqual(captured.body, { keyRef: 'mail.m_2', clientId: '00000000-0000-0000-0000-000000000000', tenantId: 'common' });

  // The other two are untouched.
  await api.mailOAuthStatus('f1');
  assert.equal(captured.path, '/api/mail/oauth/f1');
  await api.cancelMailOAuth('f1');
  assert.equal(captured.method, 'DELETE');
});

/** True when a request path carries the given text anywhere — query string included. */
function reqPathHolds(reqPath, text) {
  return String(reqPath).includes(encodeURIComponent(text)) || String(reqPath).includes(text);
}

/* ------------------------------------------------- 7. plain words */

/**
 * A persona audit — a 70-year-old who has never heard of IMAP — stopped at
 * the first screen ("Nothing answered on the four ports"), at the AI step
 * ("Base URL", "OS keychain", "config.json"), at the mail card ("over IMAP",
 * "DNS resolver", "Entra app registration"), at the calendar step ("CalDAV",
 * ".ics", "webcal://") and at Settings → Data (`rm -rf`). Every one of those
 * words is still in the product, under a control that says "Advanced" or
 * "for experts"; none of them may be on the screen before that control is
 * pressed.
 *
 * These tests RENDER the screens against a small DOM and read what is not
 * hidden, rather than grepping the source: a source grep cannot tell a word
 * under a closed drawer from one on the card. The DOM is the same fifty
 * lines the connector-seam suite uses — ui/lib/dom.js is createElement and
 * textContent and nothing else, so "enough DOM" is genuinely small. It is
 * swapped in for the duration of each test and swapped back, because
 * stubBrowserGlobals() above installs a document whose createElement throws,
 * on purpose, for the tests that must not build one.
 */
class PlainNode {
  constructor(tag) {
    this.tag = tag;
    this.attributes = {};
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.parentNode = null;
    this.style = { setProperty() {}, height: '', width: '' };
    this.classList = { add() {}, remove() {}, toggle() {} };
  }

  get firstChild() { return this.children[0] ?? null; }

  get isConnected() { return true; }

  get hidden() { return 'hidden' in this.attributes; }

  set hidden(value) { if (value) this.attributes.hidden = ''; else delete this.attributes.hidden; }

  /** A `value` attribute is an input's default value, which a browser reflects as `.value` until someone types. */
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'value') this.value = String(value);
  }

  getAttribute(key) { return this.attributes[key] ?? null; }

  removeAttribute(key) { delete this.attributes[key]; }

  toggleAttribute(key, force) {
    const on = force === undefined ? !(key in this.attributes) : Boolean(force);
    if (on) this.attributes[key] = ''; else delete this.attributes[key];
    return on;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener() {}

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }

  prepend(child) { child.parentNode = this; this.children.unshift(child); }

  replaceChildren(...kids) {
    for (const kid of kids) kid.parentNode = this;
    this.children = kids;
  }

  replaceWith(other) {
    const p = this.parentNode;
    if (!p) return;
    p.children = p.children.map((c) => (c === this ? other : c));
    other.parentNode = p;
  }

  remove() {}

  focus() {}

  click() { this.fire('click'); }

  scrollIntoView() {}

  closest(selector) {
    const cls = selector.replace(/^\./, '');
    for (let n = this; n; n = n.parentNode) {
      if ((n.attributes.class || '').split(/\s+/).includes(cls)) return n;
    }
    return null;
  }

  querySelectorAll() { return []; }

  /** Fire a listener the way a browser would: `this` is the node, as is the target. */
  fire(type) {
    for (const fn of this.listeners.get(type) ?? []) fn.call(this, { target: this, currentTarget: this, preventDefault() {} });
  }
}

function withPlainDom(t) {
  stubBrowserGlobals();
  const realDoc = globalThis.document;
  const realNode = globalThis.Node;
  const realRaf = globalThis.requestAnimationFrame;
  globalThis.Node = PlainNode;
  globalThis.document = {
    documentElement: { style: { setProperty() {} } },
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    createElement: (tag) => new PlainNode(tag),
    createTextNode: (text) => {
      const node = new PlainNode('#text');
      node.textContent = String(text);
      return node;
    },
    body: new PlainNode('body'),
    activeElement: null,
  };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
  t.after(() => {
    globalThis.document = realDoc;
    globalThis.Node = realNode;
    globalThis.requestAnimationFrame = realRaf;
  });
}

const plainWalk = (node, out = []) => {
  out.push(node);
  for (const child of node.children ?? []) plainWalk(child, out);
  return out;
};

/** True when the node or any ancestor is hidden — by property or by attribute. */
const plainHidden = (node) => {
  for (let n = node; n; n = n.parentNode) {
    if (n.hidden === true || 'hidden' in (n.attributes || {})) return true;
  }
  return false;
};

/** Every string a person can SEE in a rendered tree: text, placeholders, labels — not what is folded away. */
const onScreen = (root) => plainWalk(root)
  .filter((n) => !plainHidden(n))
  .flatMap((n) => [n.textContent, n.attributes?.placeholder, n.attributes?.['aria-label'], n.attributes?.title])
  .filter(Boolean)
  .join(' | ');

/** Every string in a rendered tree, hidden or not. */
const anywhere = (root) => plainWalk(root).map((n) => n.textContent).filter(Boolean).join(' | ');

/** A node's own text plus its descendants' — a button built by dom.js carries its label as a text-node child. */
const textOf = (n) => [n.textContent, ...(n.children ?? []).map(textOf)].filter(Boolean).join('');
const findButton = (root, label) => plainWalk(root).find((n) => n.tag === 'button' && textOf(n) === label);
const findButtons = (root, re) => plainWalk(root).filter((n) => n.tag === 'button' && re.test(textOf(n)));
const findInput = (root, pred) => plainWalk(root).find((n) => (n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea') && pred(n));

/**
 * The words a first-timer must not meet. Each is a protocol, a file name, a
 * port, a token, or the engine's own vocabulary ("model", "sweep",
 * "runtime", "source"); all of them are still in the product, one drawer
 * down. `\b` keeps "important" and "support" from tripping "port".
 */
const JARGON = /\b(IMAP|CalDAV|endpoints?|keychain|config\.json|DNS|ports?|tokens?|models?|sweeps?|sweeping|swept|runtimes?|OAuth|XOAUTH2|SMTP|TLS|STARTTLS|PKCE|MCP|Entra|tenant|SRV|MX|API|URL|webcal|base url|client id|protocol)\b|secrets\.enc|\.seed/i;

/** The real presets, so the guided cards are tested against what the server would send. */
const llmPresets = async () => (await import(fileUrl(ROOT, 'core/llm.mjs'))).PRESETS;
const connectorManifests = async () => JSON.parse(JSON.stringify((await import(fileUrl(ROOT, 'core/connectors/index.mjs'))).describe()));

/**
 * A fetch for the screens under test. Every route the onboarding and the
 * Settings panels call, answered with the server's real shapes; anything
 * else throws, so a screen that reaches somewhere new says so.
 */
function plainFetch({ probe = [], guesses = {}, presets, manifests, guides = GUIDES, calls = [] } = {}) {
  const ok = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  let config = { identity: { name: '', email: '' }, model: {}, mail: [], calendars: [], sources: [], sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: true }, privacy: { sendBodies: true, bodyChars: 4000, maxItemsPerSweep: 150 } };
  return async (reqPath, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: reqPath, body });
    if (reqPath === '/api/local/probe') return ok(probe);
    if (reqPath === '/api/model/presets') return ok(presets);
    if (reqPath === '/api/guides') return ok(guides);
    if (reqPath === '/api/help') return ok(helpAnswer(body));
    if (reqPath === '/api/sample-data') return ok({ installed: false, summary: 'A made-up week.' });
    if (reqPath === '/api/connectors') return ok({ connectors: manifests });
    if (reqPath === '/api/mail/guess') {
      const found = guesses[body.email];
      return found ? ok(found) : ok({ error: 'no guess' }, 400);
    }
    if (reqPath === '/api/secrets') return ok({ ok: true });
    if (reqPath === '/api/model/test') return ok({ ok: true, ms: 12, sample: 'Hello.' });
    if (reqPath === '/api/config') {
      if ((init.method || 'GET') === 'PUT') config = { ...config, ...body };
      return ok({ config, errors: [], secretRefs: [] });
    }
    if (reqPath === '/api/health') return ok({ model: { configured: false }, home: '/tmp/zelos-home', backend: { name: 'encrypted-file', writable: true, note: 'This does NOT protect against a process already running as this user.' } });
    if (reqPath === '/api/state') return ok({ items: [], events: [], notes: [], counts: {}, runs: {} });
    if (reqPath === '/api/data') return ok({ dbBytes: 3_215_360, walBytes: 0, messageCount: 214, oldestMessageAt: '2026-03-04T09:00:00-05:00', eventCount: 12, itemCount: 9, accounts: [{ id: 'mail-1', label: 'frank@gmail.com', messages: 214 }] });
    if (reqPath.startsWith('/api/ai')) return ok({ error: 'not found' }, 404);
    throw new Error(`unexpected ${init.method || 'GET'} ${reqPath}`);
  };
}

/**
 * What POST /api/help answers — the shape core/server.mjs serves, with
 * reserved hosts. The message is a stand-in: what the page is entitled to is
 * two https links and a message to copy, and the message's own content is
 * test/help.test.mjs's business.
 */
function helpAnswer(body) {
  const prompt = `A message for the ${body?.step} step${body?.provider ? ` about ${body.provider}` : ''}.`;
  const q = encodeURIComponent(prompt);
  return {
    step: body?.step,
    platform: 'mac',
    title: `Help with ${body?.step}`,
    prompt,
    claude: `https://claude.example/new?q=${q}`,
    chatgpt: `https://chatgpt.example/?q=${q}`,
  };
}

/** What GET /api/guides answers — the shape core/server.mjs serves, with reserved hosts. */
const GUIDES = {
  microsoftSetup: 'https://docs.example/oauth#microsoft',
  calendars: {
    google: { settings: 'https://calendar.example/settings' },
    icloud: { caldav: 'https://caldav.example/', appPasswords: 'https://appleid.example/manage' },
    outlook: { calendar: 'https://outlook.example/calendar/' },
  },
};

const GUESSES = {
  'frank@gmail.com': { label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, auth: 'password', signIn: 'google', clientReady: false, appPasswordUrl: 'https://myaccount.google.com/apppasswords', note: '"Sign in with Google" connects this mailbox in one step. Gmail requires 2-Step Verification plus a 16-character App Password. This provider does not accept your normal password over IMAP.', known: true },
  'frank@hotmail.com': { label: 'Outlook / Microsoft', host: 'outlook.office365.com', port: 993, secure: true, auth: 'xoauth2', signIn: 'microsoft', clientReady: false, appPasswordUrl: null, note: 'Hotmail and Outlook.com need a one-time setup at Microsoft’s website first (about ten minutes) — the app shows you every step. There is no password to paste: Microsoft switched password sign-in off for personal Outlook, Hotmail, Live and MSN accounts on 16 September 2024.', known: true },
  'frank@icloud.com': { label: 'iCloud Mail', host: 'imap.mail.me.com', port: 993, secure: true, auth: 'password', signIn: null, clientReady: false, appPasswordUrl: 'https://account.apple.com/account/manage', note: 'iCloud Mail requires an app-specific password. This provider does not accept your normal password over IMAP.', known: true },
};

function runAppScenario({ initiallyConfigured = true, storageUnavailable = false, beforeBoot = '', scenario }) {
  // Run the actual shell in its own process: its subscriptions and timers live
  // for the whole page, and must not leak into the renderer tests in this file.
    const script = `
      import assert from 'node:assert/strict';
      const PlainNode = ${PlainNode.toString()};
      const plainWalk = ${plainWalk.toString()};
      const textOf = ${textOf.toString()};
      const findButton = ${findButton.toString()};
      const storage = () => {
        const values = new Map();
        return {
          getItem: k => values.get(k) || null,
          setItem: (k, v) => { if (${JSON.stringify(storageUnavailable)}) throw new Error('storage disabled'); values.set(k, String(v)); },
          removeItem: k => values.delete(k),
        };
      };
      globalThis.Node = PlainNode;
      globalThis.localStorage = storage();
      globalThis.sessionStorage = storage();
      const windowEvents = {};
      globalThis.window = {
        location: { href: 'http://127.0.0.1/?t=test', host: '127.0.0.1', hash: '#/now' },
        history: { replaceState() {} }, addEventListener: (name, fn) => { windowEvents[name] = fn; }, scrollTo() {},
        matchMedia: () => ({ matches: true }),
      };
      const root = new PlainNode('div');
      PlainNode.prototype.contains = function(node) { return plainWalk(this).includes(node); };
      PlainNode.prototype.focus = function() { document.activeElement = this; };
      PlainNode.prototype.getBoundingClientRect = () => ({ height: 100 });
      PlainNode.prototype.querySelector = function(selector) {
        return plainWalk(this).find(n => (n.attributes.class || '').split(' ').includes(selector.slice(1))) || null;
      };
      globalThis.document = {
        documentElement: { style: { setProperty() {} } }, body: new PlainNode('body'), activeElement: null,
        visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
        createElement: tag => new PlainNode(tag),
        createTextNode: text => { const n = new PlainNode('#text'); n.textContent = String(text); return n; },
        getElementById: id => id === 'app' ? root : null,
      };
      globalThis.requestAnimationFrame = fn => { fn(); return 0; };
      globalThis.setInterval = () => 0;
      globalThis.fetch = async path => {
        if (path === '/api/sweep/stream') return new Promise(() => {});
        assert.equal(path, '/api/sample-data');
        return { ok: true, status: 200, text: async () => JSON.stringify({ installed: false }) };
      };
      let configured = ${JSON.stringify(initiallyConfigured)};
      let config = {
        identity: {}, ui: {}, mail: [], calendars: [], sources: [],
        model: { protocol: 'openai', model: 'local-test', baseUrl: 'http://127.0.0.1:1234', keyRef: 'model.default' },
      };
      const { api } = await import(${JSON.stringify(fileUrl(UI, 'lib/api.js'))});
      api.health = async () => ({ model: { configured }, backend: { name: 'memory' } });
      api.config = async () => ({ config, errors: [], secretRefs: [] });
      api.state = async () => ({ items: [], drafts: [], events: [], counts: {}, notes: [], runs: {}, now: '2026-08-12T09:00:00-04:00' });
      api.saveConfig = async patch => { configured = true; config = { ...config, ...patch }; return { config, errors: [], secretRefs: [] }; };
      api.presets = api.probeLocal = async () => [];
      api.helpLinks = async () => ({});
      const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
      ${beforeBoot}
      await import(${JSON.stringify(fileUrl(UI, 'app.js'))});
      await settle();
      ${scenario}
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message || run.stdout);
}

test('the skip link focuses the current view without changing its route', () => {
  runAppScenario({ scenario: `
    window.location.hash = '#/today';
    windowEvents.hashchange();
    const main = plainWalk(root).find(n => n.attributes.id === 'main');
    const content = main.firstChild;
    const skip = plainWalk(root).find(n => n.attributes.class === 'skip-link');
    assert.ok(skip);
    document.activeElement = skip;
    let prevented = false;
    for (const listener of skip.listeners.get('click') || []) {
      listener.call(skip, { target: skip, currentTarget: skip, preventDefault() { prevented = true; } });
    }
    // Emulate the anchor's browser default, including the real hash router.
    if (!prevented) {
      window.location.hash = skip.getAttribute('href');
      windowEvents.hashchange();
    }
    assert.equal(window.location.hash, '#/today');
    assert.equal(main.firstChild, content, 'the current calendar must stay in place');
    assert.equal(document.activeElement, main);
  ` });
});

test('first-run setup stays on Email after saving the AI, and can finish even when storage refuses writes', () => {
  for (const [initiallyConfigured, storageUnavailable] of [[false, false], [false, true], [true, false]]) {
    runAppScenario({ initiallyConfigured, storageUnavailable, scenario: `
      if (${JSON.stringify(initiallyConfigured)}) {
        assert.ok(!findButton(root, 'Set up Zelos'), 'existing configured homes still open the board');
      } else {
        findButton(root, 'Set up Zelos').fire('click');
        await settle();
        assert.match(textOf(root), /Step 2 of 5/);
        findButton(root, 'Save').fire('click');
        await settle();
        assert.match(textOf(root), /Step 3 of 5/, 'saving the AI must advance to Email');
        assert.equal(localStorage.getItem('zelos.onboarded'), null);
        findButton(root, 'Skip the rest').fire('click');
        await settle();
        assert.doesNotMatch(textOf(root), /Step 3 of 5/);
        assert.match(textOf(root), /Nothing to read yet/, 'Skip must leave the entire setup flow');
        const store = await import(${JSON.stringify(fileUrl(UI, 'lib/store.js'))});
        assert.equal(store.onboardingDone(), true, 'completion survives unavailable storage for this session');
        assert.equal(localStorage.getItem('zelos.onboarded'), ${JSON.stringify(storageUnavailable ? null : '1')});
      }
    ` });
  }
});

test('first-run sample data recovers from availability and loading failures without losing the way to the board', () => {
  runAppScenario({ initiallyConfigured: false, beforeBoot: `
    let reads = 0;
    let loads = 0;
    let loaded = false;
    globalThis.fetch = async (path, init = {}) => {
      if (path === '/api/sweep/stream') return new Promise(() => {});
      assert.equal(path, '/api/sample-data');
      if (init.method === 'POST') {
        loads += 1;
        if (loads === 1) return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'Please try loading again' }) };
        loaded = true;
      } else if (++reads === 1) {
        return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'Temporarily unavailable' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ installed: loaded }) };
    };
    api.state = async () => ({ items: loaded ? [{ id: 'sample-item', state: 'open', bucket: 'now', headline: 'Sample · Review the studio plan' }] : [], events: [], drafts: [], notes: [], counts: {}, runs: {} });
  `, scenario: `
    assert.match(textOf(root), /Temporarily unavailable/);
    const retry = findButton(root, 'Retry sample data');
    assert.ok(retry, 'a temporary sample probe failure needs a retry without reloading setup');
    retry.fire('click');
    await settle();
    findButton(root, 'Look around with made-up data first').fire('click');
    await settle();
    assert.match(textOf(root), /Please try loading again/);
    assert.equal(localStorage.getItem('zelos.onboarded'), null, 'failed loading must stay in setup');
    findButton(root, 'Look around with made-up data first').fire('click');
    await settle();
    assert.match(textOf(root), /Sample · Review the studio plan/);
    assert.equal(localStorage.getItem('zelos.onboarded'), '1');
    assert.equal(loads, 2);
    const store = await import(${JSON.stringify(fileUrl(UI, 'lib/store.js'))});
    store.notify(null);
  ` });
});

test('no screen in onboarding, and no mail card, shows a first-timer a protocol word', async (t) => {
  withPlainDom(t);
  const calls = [];
  globalThis.fetch = plainFetch({ presets: await llmPresets(), manifests: await connectorManifests(), guesses: GUESSES, calls });
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const onboarding = await import(fileUrl(UI, 'views/onboarding.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, backend: { name: 'encrypted-file' } };
  store.state.secretRefs = [];

  let view = null;
  const ctx = { navigate() {}, rerender() { view = onboarding.renderOnboarding(ctx); } };
  ctx.rerender();
  const stepButton = (n) => plainWalk(view).filter((b) => b.tag === 'button' && (b.attributes.class || '').includes('ob-step-btn'))[n - 1];
  const goTo = (n) => { stepButton(n).fire('click'); };

  // 1. Welcome: the names of all five steps, the count, the two buttons, no probe text.
  let seen = onScreen(view);
  assert.match(seen, /Step 1 of 5/);
  for (const name of ['Welcome', 'AI', 'Email', 'Calendar', 'Done']) assert.match(seen, new RegExp(`\\b${name}\\b`), `step name ${name} is not on the first screen`);
  assert.match(seen, /Zelos reads your email and calendar, and tells you what needs you\./);
  assert.match(seen, /It never sends, moves or deletes your mail\. Your archive is stored on this computer\./);
  assert.ok(findButton(view, 'Set up Zelos'), 'no "Set up Zelos" button');
  await settle();
  assert.ok(findButton(view, 'Look around with made-up data first'), 'no "Look around with made-up data first" button');
  assert.doesNotMatch(onScreen(view), JARGON, `the welcome screen: ${onScreen(view).match(JARGON)?.[0]}`);
  assert.ok(!calls.some((c) => c.path === '/api/local/probe'), 'the welcome screen must not probe for a local runtime');

  // 2. AI: two named cards, then a guided card with one button and one key box.
  goTo(2);
  await settle();
  seen = onScreen(view);
  assert.match(seen, /Step 2 of 5/);
  assert.match(seen, /Pick the AI that reads your mail\./);
  assert.ok(findButtons(view, /^Claude, by Anthropic — Recommended/).length === 1, 'no Claude card');
  assert.ok(findButtons(view, /^OpenAI, who make ChatGPT/).length === 1, 'no OpenAI card');
  assert.doesNotMatch(seen, JARGON, `the AI step before a choice: ${seen.match(JARGON)?.[0]}`);
  assert.doesNotMatch(seen, /Nothing answered|four ports/, 'the probe sentence is on the AI step');
  assert.match(anywhere(view), /Ollama on 11434/, 'the probe sentence is gone rather than folded');
  findButtons(view, /^Claude, by Anthropic/)[0].fire('click');
  seen = onScreen(view);
  assert.match(seen, /1\. Open.*Anthropic’s key page ↗.*they may ask you to sign in or make an account/);
  assert.match(seen, /2\. Press Create Key and copy it\./);
  assert.match(seen, /3\. Paste it here\./);
  assert.match(seen, /Pay-as-you-go\. You can set a monthly spending cap on their site\./);
  assert.doesNotMatch(seen, /[$€£]\s?\d|\d\s?(a|per) month/i, 'a price was invented');
  assert.ok(findButton(view, 'Check it works'), 'no "Check it works" button');
  assert.doesNotMatch(seen, JARGON, `the guided AI card: ${seen.match(JARGON)?.[0]}`);
  assert.match(anywhere(view), /Base URL/, 'the expert form is gone rather than folded');
  // Pressing the button with nothing pasted says so, in the service's name.
  findButton(view, 'Check it works').fire('click');
  await settle();
  assert.match(onScreen(view), /Paste the key first — Claude will not answer without one\./);
  assert.doesNotMatch(onScreen(view), JARGON, `the refusal: ${onScreen(view).match(JARGON)?.[0]}`);

  // 3. Email: the address, then the card — Gmail without a client, Hotmail without a client, iCloud.
  goTo(3);
  seen = onScreen(view);
  assert.match(seen, /Step 3 of 5/);
  assert.match(seen, /Connect your email\./);
  assert.doesNotMatch(seen, JARGON, `the email step: ${seen.match(JARGON)?.[0]}`);
  findButton(view, 'Add an email account').fire('click');
  seen = onScreen(view);
  assert.match(seen, /Your address stays on this computer\./);
  assert.ok(findButton(view, 'Server settings (for experts)'), 'no expert button under the address');
  assert.doesNotMatch(seen, JARGON, `the empty email form: ${seen.match(JARGON)?.[0]}`);
  const emailInput = findInput(view, (n) => n.attributes.type === 'email');
  for (const [address, expect] of [
    ['frank@gmail.com', /Google does not let other programs use your normal password[\s\S]*16-letter password just for Zelos[\s\S]*2-Step Verification/],
    ['frank@hotmail.com', /Hotmail and Outlook\.com need a one-time setup at Microsoft’s website first — about ten minutes/],
    ['frank@icloud.com', /iCloud needs a special password made just for Zelos/],
  ]) {
    emailInput.value = address;
    emailInput.fire('change');
    await settle();
    seen = onScreen(view);
    assert.match(seen, expect, `${address}: the card does not say the plain thing`);
    assert.doesNotMatch(seen, JARGON, `${address}: ${seen.match(JARGON)?.[0]}`);
    assert.doesNotMatch(seen, /imap\.|outlook\.office365|:993/, `${address}: the card shows a host`);
    // The server's own note — host, port and all — appears with the expert
    // form, which opens BENEATH the card and closes back to it. The card and
    // the address survive the round trip; the old Advanced replaced both.
    assert.doesNotMatch(anywhere(view), /over IMAP|16 September 2024/, `${address}: the server's note is on screen before anyone asked`);
    const expert = findButtons(view, /^Server settings \(for experts\)$/).find((b) => !plainHidden(b));
    assert.ok(expert, `${address}: no expert button on the card`);
    expert.fire('click');
    await settle();
    assert.match(anywhere(view), /over IMAP|16 September 2024/, `${address}: the server's own note is gone rather than folded`);
    assert.match(onScreen(view), new RegExp(GUESSES[address].host.replace(/\./g, '\\.')), `${address}: the expert form does not show the host`);
    expert.fire('click');
    await settle();
    assert.doesNotMatch(onScreen(view), /IMAP host/, `${address}: the expert form did not close`);
    assert.equal(emailInput.value, address, `${address}: closing the expert form lost the address`);
    assert.match(onScreen(view), expect, `${address}: closing the expert form lost the card`);
  }
  // Gmail: Connect with nothing pasted opens the password box and says what to paste.
  emailInput.value = 'frank@gmail.com';
  emailInput.fire('change');
  await settle();
  assert.match(onScreen(view), /Google opens in a new tab and may ask you to sign in\. Type a name like ‘Zelos’, press Create, copy the 16 letters, then come back here and paste them\./);
  assert.ok(plainWalk(view).some((n) => n.tag === 'a' && textOf(n) === 'Get an app password' && !plainHidden(n)), 'the app-password link is not on screen');
  assert.ok(!plainWalk(view).some((n) => n.tag === 'button' && textOf(n) === 'Sign in with Google' && !plainHidden(n)), 'a Google sign-in with no client is on screen');
  assert.match(anywhere(view), /For developers/, 'the developer drawer is missing');
  findButton(view, 'Connect').fire('click');
  await settle();
  assert.match(onScreen(view), /Paste the 16-letter app password from Google here\. Don’t have one yet\? Press Get an app password\./);
  assert.ok(!plainHidden(findInput(view, (n) => n.attributes.type === 'password')), 'Connect asked for a paste into a hidden box');
  // Hotmail: the big button routes to the setup page and never demands an ID.
  emailInput.value = 'frank@hotmail.com';
  emailInput.fire('change');
  await settle();
  assert.ok(plainWalk(view).some((n) => n.tag === 'a' && textOf(n) === 'Show me how ↗' && !plainHidden(n)), 'no "Show me how" link on the Hotmail card');
  assert.ok(plainHidden(findInput(view, (n) => n.attributes.placeholder === '00000000-0000-0000-0000-000000000000')), 'the client-id field is on the card');
  findButton(view, 'Sign in with Microsoft').fire('click');
  await settle();
  seen = onScreen(view);
  assert.doesNotMatch(seen, /is required/, 'the button still answers "…ID is required"');
  assert.match(seen, /One more step first/);
  assert.doesNotMatch(seen, JARGON, `after pressing Sign in with Microsoft: ${seen.match(JARGON)?.[0]}`);
  assert.ok(!calls.some((c) => c.path === '/api/mail/oauth'), 'a sign-in was started with no client');

  // 4. Calendar: four named choices; iCloud is guided with the address already in.
  goTo(4);
  seen = onScreen(view);
  assert.match(seen, /Step 4 of 5/);
  assert.match(seen, /Add your calendar\./);
  for (const name of ['Google Calendar', 'iPhone or Mac (iCloud)', 'Outlook', 'Something else']) {
    assert.ok(findButtons(view, new RegExp(`^${name.replace(/[()]/g, '\\$&')}`)).length === 1, `no "${name}" choice`);
  }
  assert.doesNotMatch(seen, JARGON, `the calendar step: ${seen.match(JARGON)?.[0]}`);
  findButtons(view, /^iPhone or Mac/)[0].fire('click');
  await settle();
  seen = onScreen(view);
  assert.match(seen, /appleid\.apple\.com ↗.*Sign-In and Security → App-Specific Passwords → name it Zelos/);
  assert.match(seen, /Your Apple ID email/);
  assert.ok(findButton(view, 'Check it works and save'), 'no one-button finish on the guided calendar');
  assert.doesNotMatch(seen, JARGON, `the iCloud card: ${seen.match(JARGON)?.[0]}`);
  const addr = findInput(view, (n) => n.value === GUIDES.calendars.icloud.caldav);
  assert.ok(addr, 'the iCloud address is not filled in');
  assert.ok(plainHidden(addr), 'the iCloud address is on the card rather than under Advanced');
  assert.match(anywhere(view), /CalDAV/, 'the expert kind picker is gone rather than folded');
  findButtons(view, /^Google Calendar/)[0].fire('click');
  await settle();
  seen = onScreen(view);
  assert.match(seen, /1\. Open.*Google Calendar on the web ↗/);
  assert.match(seen, /3\. Scroll to ‘Secret address in iCal format’ and copy it\./);
  assert.doesNotMatch(seen, JARGON, `the Google Calendar card: ${seen.match(JARGON)?.[0]}`);

  // 5. Done: what is still missing, by step number, and the one button.
  goTo(5);
  seen = onScreen(view);
  assert.match(seen, /Step 5 of 5/);
  assert.match(seen, /Read my mail for the first time\./);
  assert.match(seen, /Zelos can’t read anything yet — it still needs an AI \(step 2\) and an email account \(step 3\)\./);
  const read = findButton(view, 'Read my mail now');
  assert.ok(read, 'no "Read my mail now" button');
  assert.equal(read.attributes.disabled, '', 'the button is pressable with nothing to read');
  assert.doesNotMatch(seen, JARGON, `the last step: ${seen.match(JARGON)?.[0]}`);
  assert.equal(onboarding.notReadyLine({ model: true }), 'Zelos can’t read anything yet — it still needs an AI (step 2).');
  assert.equal(onboarding.notReadyLine({ sources: true }), 'Zelos can’t read anything yet — it still needs an email account (step 3).');
  assert.equal(onboarding.notReadyLine({}), '');

  // The step is module state: leave it where a fresh page starts, while the
  // DOM stub is still in place to render it.
  goTo(1);
});

/**
 * The Done step's gate counted mail and calendars only, while ui/views/now.js
 * and the server both count the connector sources under Settings → Other
 * things it can read. A home reading only Slack was told "it still needs an
 * email account" with the one button disabled — a false sentence over a check
 * that would have succeeded.
 */
test('the Done step counts connector-only homes as having something to read', async (t) => {
  withPlainDom(t);
  globalThis.fetch = plainFetch({ presets: await llmPresets(), manifests: await connectorManifests() });
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const onboarding = await import(fileUrl(UI, 'views/onboarding.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [{ id: 's1', kind: 'slack' }] };
  store.state.health = { model: { configured: true, label: 'Claude' }, backend: { name: 'encrypted-file' } };
  store.state.secretRefs = [];

  let view = null;
  const ctx = { navigate() {}, rerender() { view = onboarding.renderOnboarding(ctx); } };
  ctx.rerender();
  const stepButton = (n) => plainWalk(view).filter((b) => b.tag === 'button' && (b.attributes.class || '').includes('ob-step-btn'))[n - 1];
  stepButton(5).fire('click');

  const seen = onScreen(view);
  assert.doesNotMatch(seen, /can’t read anything yet/, 'a connector-only home has something to read');
  const read = findButton(view, 'Read my mail now');
  assert.ok(read, 'no "Read my mail now" button');
  assert.equal(read.attributes.disabled, undefined, 'the button must be pressable');

  // Leave the module's step where a fresh page starts.
  stepButton(1).fire('click');
});

/**
 * The one Owed defect the shell cannot fix: a queued render can flush the
 * moment the draft textarea blurs, and the rebuilt card reads
 * `state.board.drafts` — which held the body fetched BEFORE the edit, so the
 * user watched their own words revert while the server was saving them.
 * The card patches the board's copy before the request goes out.
 */
test('a draft edit lands in the board copy before the save returns, so a repaint cannot revert it', async (t) => {
  withPlainDom(t);
  const puts = [];
  globalThis.fetch = async (reqPath, init = {}) => {
    puts.push({ path: reqPath, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => '{}' };
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  store.state.board = {
    ...store.state.board,
    items: [],
    drafts: [{ id: 'd1', state: 'pending', to_email: 'sam@example.com', subject: 'the survey', body: 'The fetched body.', item_id: null }],
  };

  const view = owed.renderOwed({ tz: 'UTC', navigate() {}, rerender() {} });
  const area = findInput(view, (n) => n.tag === 'textarea' && (n.attributes['aria-label'] || '').startsWith('Draft to'));
  assert.ok(area, 'no draft textarea');
  area.value = 'The body as edited.';
  area.fire('input');
  area.fire('blur');
  assert.equal(store.state.board.drafts[0].body, 'The body as edited.',
    'the board copy must already hold what a rebuilt card will paint');
  await settle();
  assert.deepEqual(puts.filter((p) => p.method === 'PUT').map((p) => p.body),
    [{ body: 'The body as edited.', state: 'edited' }]);
});

test('native leave flushes a draft before its debounce and waits for the write', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  let release;
  let saved = 'Original';
  t.mock.method(api, 'updateDraft', async (_id, patch) => {
    await new Promise(resolve => { release = resolve; });
    saved = patch.body;
  });
  store.state.board = { ...store.state.board, items: [], drafts: [{ id: 'leave-before-debounce', state: 'pending', body: saved }] };
  const area = findInput(owed.renderOwed({ tz: 'UTC' }), n => n.tag === 'textarea');
  area.value = 'Typed immediately before quitting.';
  area.fire('input');
  assert.equal(saved, 'Original');
  let left = false;
  const leaving = owed.flushDrafts().then(() => { left = true; });
  await settle();
  assert.equal(left, false, 'native quit must wait for the pending server write');
  release();
  await leaving;
  assert.equal(saved, area.value);
  assert.equal(left, true);
});

test('native leave saves edits typed during an earlier draft write', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  const bodies = [];
  let release;
  t.mock.method(api, 'updateDraft', async (_id, patch) => {
    bodies.push(patch.body);
    if (bodies.length === 1) await new Promise(resolve => { release = resolve; });
  });
  store.state.board = { ...store.state.board, items: [], drafts: [{ id: 'leave-during-write', state: 'pending', body: 'Original' }] };
  const area = findInput(owed.renderOwed({ tz: 'UTC' }), n => n.tag === 'textarea');
  area.value = 'First edit';
  area.fire('input');
  area.fire('blur');
  await settle();
  area.value = 'Latest edit';
  area.fire('input');
  const leaving = owed.flushDrafts();
  release();
  await leaving;
  assert.deepEqual(bodies, ['First edit', 'Latest edit']);
});

test('a failed native leave keeps draft text and retries saving on the next request', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  let fail = true;
  let saved;
  t.mock.method(api, 'updateDraft', async (_id, patch) => {
    if (fail) throw new Error('Could not write the draft');
    saved = patch.body;
  });
  store.state.board = { ...store.state.board, items: [], drafts: [{ id: 'leave-save-failure', state: 'pending', body: 'Original' }] };
  const view = owed.renderOwed({ tz: 'UTC' });
  const area = findInput(view, n => n.tag === 'textarea');
  area.value = 'Keep this text after the failure';
  area.fire('input');
  await assert.rejects(owed.flushDrafts(), /save/i);
  assert.equal(area.value, 'Keep this text after the failure');
  assert.match(onScreen(view), /Could not write the draft/);
  fail = false;
  await owed.flushDrafts();
  assert.equal(saved, area.value);
});

test('a board refresh after a failed leave keeps unsaved draft text visible for copying', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  let fail = true;
  t.mock.method(api, 'updateDraft', async () => { if (fail) throw new Error('Save failed'); });
  const serverDraft = { id: 'leave-refresh-failure', state: 'pending', body: 'Old saved text' };
  store.state.board = { ...store.state.board, items: [], drafts: [serverDraft] };
  const area = findInput(owed.renderOwed({ tz: 'UTC' }), n => n.tag === 'textarea');
  area.value = 'Unsaved words to keep and copy';
  area.fire('input');
  await assert.rejects(owed.flushDrafts(), /save/i);
  store.state.board = { ...store.state.board, drafts: [serverDraft] };
  const rebuilt = owed.renderOwed({ tz: 'UTC' });
  const restored = findInput(rebuilt, n => n.tag === 'textarea');
  // Restore the write before assertions so this shared module leaves no
  // failed draft behind for a following test, including on the red run.
  fail = false;
  await owed.flushDrafts();
  assert.equal(restored.value, 'Unsaved words to keep and copy');
});

test('an older failed card cannot overwrite a newer saved edit when leaving', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  let fail = true;
  let saved = 'Original';
  const writes = [];
  t.mock.method(api, 'updateDraft', async (_id, patch) => {
    writes.push(patch.body);
    if (fail) throw new Error('Save failed');
    saved = patch.body;
  });
  store.state.board = { ...store.state.board, items: [], drafts: [{ id: 'leave-stale-failure', state: 'pending', body: saved }] };
  const oldArea = findInput(owed.renderOwed({ tz: 'UTC' }), n => n.tag === 'textarea');
  oldArea.value = 'Older failed edit';
  oldArea.fire('input');
  await assert.rejects(owed.flushDrafts(), /save/i);
  const newArea = findInput(owed.renderOwed({ tz: 'UTC' }), n => n.tag === 'textarea');
  newArea.value = 'Latest successfully saved edit';
  newArea.fire('input');
  fail = false;
  newArea.fire('blur');
  await settle();
  assert.equal(saved, 'Latest successfully saved edit');
  await owed.flushDrafts();
  assert.equal(saved, 'Latest successfully saved edit');
  assert.deepEqual(writes, ['Older failed edit', 'Latest successfully saved edit']);
});

test('a refresh during saving cannot repaint old text after the save succeeds', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  let release;
  let saved;
  t.mock.method(api, 'updateDraft', async (_id, patch) => {
    await new Promise(resolve => { release = resolve; });
    saved = patch.body;
  });
  const serverDraft = { id: 'leave-refresh-during-save', state: 'pending', body: 'Old server copy' };
  store.state.board = { ...store.state.board, items: [], drafts: [serverDraft] };
  const area = findInput(owed.renderOwed({ tz: 'UTC' }), n => n.tag === 'textarea');
  area.value = 'Latest edited text';
  area.fire('input');
  const leaving = owed.flushDrafts();
  await settle();
  store.state.board = { ...store.state.board, drafts: [serverDraft] };
  assert.equal(findInput(owed.renderOwed({ tz: 'UTC' }), n => n.tag === 'textarea').value, 'Latest edited text');
  release();
  await leaving;
  assert.equal(saved, 'Latest edited text');
  assert.equal(findInput(owed.renderOwed({ tz: 'UTC' }), n => n.tag === 'textarea').value, 'Latest edited text');
});

test('a stalled draft request is aborted so a later native leave can retry', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  let stalled = true;
  let aborted = false;
  let saved;
  globalThis.fetch = async (_path, init) => {
    if (stalled) return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true }));
    saved = JSON.parse(init.body).body;
    return { ok: true, text: async () => '{}' };
  };
  t.after(() => { delete globalThis.fetch; });
  store.state.board = { ...store.state.board, items: [], drafts: [{ id: 'leave-stalled-request', state: 'pending', body: 'Original' }] };
  const view = owed.renderOwed({ tz: 'UTC' });
  const area = findInput(view, n => n.tag === 'textarea');
  area.value = 'Keep this while saving is stalled';
  area.fire('input');
  const rejected = assert.rejects(owed.flushDrafts(), /save/i);
  await settle();
  t.mock.timers.tick(8_001);
  await rejected;
  assert.equal(aborted, true);
  assert.match(onScreen(view), /Saving took too long/);
  assert.equal(area.value, 'Keep this while saving is stalled');
  stalled = false;
  await owed.flushDrafts();
  assert.equal(saved, area.value);
});

test('discard waits for an older card save and prevents its delayed edit from resurrecting the draft', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  let serverDraft = { id: 'discard-race', state: 'pending', to_email: 'sam@example.com', subject: 'Reply', body: 'Original.' };
  const puts = [];
  let releaseSave;
  globalThis.fetch = async (reqPath, init = {}) => {
    if (reqPath === '/api/state') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], events: [], notes: [], counts: {}, runs: {}, drafts: serverDraft.state === 'discarded' ? [] : [serverDraft] }) };
    }
    assert.equal(reqPath, '/api/drafts/discard-race');
    const patch = JSON.parse(init.body);
    puts.push(patch);
    if (puts.length === 1) await new Promise(resolve => { releaseSave = resolve; });
    serverDraft = { ...serverDraft, ...patch };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  t.after(() => { releaseSave?.(); delete globalThis.fetch; store.notify(null); });
  store.state.board = { ...store.state.board, items: [], drafts: [serverDraft] };
  const ctx = { tz: 'UTC', navigate() {}, rerender() {} };
  const first = owed.renderOwed(ctx);
  const area = findInput(first, n => n.tag === 'textarea');
  area.value = 'First edit.';
  area.fire('input');
  area.fire('blur');
  await settle();
  assert.equal(puts.length, 1);
  area.value = 'One more edit before leaving.';
  area.fire('input');

  // Navigation rebuilds the card while its previous instance still has work.
  const rebuilt = owed.renderOwed(ctx);
  findButton(rebuilt, 'Discard').fire('click');
  t.mock.timers.tick(1_000);
  await settle();
  const sentBeforeSaveFinished = puts.length;
  releaseSave();
  await settle();
  await settle();

  assert.equal(sentBeforeSaveFinished, 1, 'Discard must wait for the already-running save');
  assert.equal(puts.at(-1).state, 'discarded', 'an old debounce must never send an edit after Discard');
  assert.equal(serverDraft.state, 'discarded');
  assert.deepEqual(store.state.board.drafts, []);
});

test('a successful discard stays final when refreshing the board fails', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  const puts = [];
  globalThis.fetch = async (reqPath, init = {}) => {
    if (reqPath === '/api/state') {
      return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'Board temporarily unavailable' }) };
    }
    puts.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '{}' };
  };
  t.after(() => { delete globalThis.fetch; store.notify(null); });
  store.state.board = { ...store.state.board, items: [], drafts: [{ id: 'discard-refresh-failure', state: 'pending', body: 'Original.' }] };
  const view = owed.renderOwed({ tz: 'UTC', navigate() {}, rerender() {} });
  const area = findInput(view, n => n.tag === 'textarea');
  const discard = findButton(view, 'Discard');
  area.value = 'Unsaved text that I chose to discard.';
  area.fire('input');
  discard.fire('click');
  await settle();
  // Neither the old debounce nor a later blur may reopen a successful discard.
  t.mock.timers.tick(1_000);
  area.fire('blur');
  await settle();
  assert.deepEqual(puts, [{ state: 'discarded' }]);
  assert.deepEqual(store.state.board.drafts, []);
  assert.equal(area.disabled, true);
  assert.equal(discard.disabled, true);
  assert.equal(store.state.toast.message, 'Could not refresh the board: Board temporarily unavailable');
});

test('a failed discard preserves the edited text and allows saving and retrying', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  let failDiscard = true;
  const puts = [];
  globalThis.fetch = async (reqPath, init = {}) => {
    if (reqPath === '/api/state') return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], events: [], drafts: [], notes: [], counts: {}, runs: {} }) };
    const patch = JSON.parse(init.body);
    puts.push(patch);
    if (patch.state === 'discarded' && failDiscard) return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'Try again later' }) };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  t.after(() => { delete globalThis.fetch; store.notify(null); });
  store.state.board = { ...store.state.board, items: [], drafts: [{ id: 'discard-failure', state: 'pending', to_email: 'sam@example.com', subject: 'Reply', body: 'Original.' }] };
  const view = owed.renderOwed({ tz: 'UTC', navigate() {}, rerender() {} });
  const area = findInput(view, n => n.tag === 'textarea');
  const discard = findButton(view, 'Discard');
  area.value = 'Keep these words if discard fails.';
  area.fire('input');
  discard.fire('click');
  await settle();
  assert.equal(area.value, 'Keep these words if discard fails.');
  assert.equal(area.disabled, false);
  assert.equal(discard.disabled, false);
  assert.match(store.state.toast.message, /Could not discard that draft: Try again later/);
  area.value += ' Updated.';
  area.fire('input');
  area.fire('blur');
  await settle();
  assert.deepEqual(puts.at(-1), { body: area.value, state: 'edited' });
  failDiscard = false;
  discard.fire('click');
  await settle();
  assert.equal(puts.at(-1).state, 'discarded');
  assert.deepEqual(store.state.board.drafts, []);
});

test('a failed discard resumes an unsaved edit held by the previous card', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  const { api } = await import(fileUrl(UI, 'lib/api.js'));
  const puts = [];
  let releaseSave;
  t.mock.method(api, 'updateDraft', async (_id, patch) => {
    puts.push(patch);
    if (puts.length === 1) await new Promise(resolve => { releaseSave = resolve; });
    if (patch.state === 'discarded') throw new Error('Try again later');
  });
  t.after(() => { releaseSave?.(); store.notify(null); });
  store.state.board = { ...store.state.board, items: [], drafts: [{ id: 'discard-old-failure', state: 'pending', body: 'Original.' }] };
  const ctx = { tz: 'UTC', navigate() {}, rerender() {} };
  const area = findInput(owed.renderOwed(ctx), n => n.tag === 'textarea');
  area.value = 'First edit.';
  area.fire('input');
  area.fire('blur');
  await settle();
  area.value = 'The most recent words must survive.';
  area.fire('input');
  const rebuilt = owed.renderOwed(ctx);
  findButton(rebuilt, 'Discard').fire('click');
  t.mock.timers.tick(1_000);
  releaseSave();
  await settle();
  await settle();
  assert.match(store.state.toast.message, /Could not discard/);
  assert.deepEqual(puts.at(-1), { body: 'The most recent words must survive.', state: 'edited' });
  assert.equal(store.state.board.drafts[0].body, 'The most recent words must survive.');
});

/** A fetch for the board-row tests below: records every call, answers /api/state with an empty board. */
const rowFetch = (calls) => async (reqPath, init = {}) => {
  calls.push({ method: init.method || 'GET', path: reqPath, body: init.body ? JSON.parse(init.body) : null });
  if (reqPath === '/api/state') {
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], events: [], notes: [], counts: {}, drafts: [], runs: {} }) };
  }
  return { ok: true, status: 200, text: async () => '{}' };
};

test('a mailto body past what email programs honour is cut clean and flagged', async () => {
  stubBrowserGlobals();
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  assert.deepEqual(owed.mailtoDraft('a@b.c', 'Hi', 'One.\nTwo.'),
    { href: 'mailto:a%40b.c?subject=Hi&body=One.%0D%0ATwo.', truncated: false });

  const long = owed.mailtoDraft('a@b.c', 'Hi', 'word '.repeat(2000));
  assert.equal(long.truncated, true);
  assert.ok(long.href.length <= 1900, `${long.href.length} characters is past where email programs cut`);
  const sent = decodeURIComponent(long.href.slice(long.href.indexOf('&body=') + 6));
  assert.ok(sent.length > 1000, 'the start must actually ride along');
  assert.ok('word '.repeat(2000).startsWith(sent), 'the cut must be a clean prefix');

  // The cut never splits a two-part character — half of one is not encodable.
  const emoji = owed.mailtoDraft('a@b.c', '', '🙂'.repeat(1000));
  assert.equal(emoji.truncated, true);
  assert.match(decodeURIComponent(emoji.href.slice(emoji.href.indexOf('&body=') + 6)), /^(?:🙂)*$/u);

  // No recipient still yields an address a client can open.
  assert.match(owed.mailtoDraft('', '', 'x').href, /^mailto:\?subject=&body=x$/);
});

test('the mailto rides the live textarea at click time, and says so when only the start fits', async (t) => {
  withPlainDom(t);
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const owed = await import(fileUrl(UI, 'views/owed.js'));
  t.after(() => { delete globalThis.fetch; store.notify(null); });
  store.state.board = {
    ...store.state.board,
    items: [],
    drafts: [{ id: 'd1', state: 'pending', to_email: 'sam@example.com', subject: 'the survey', body: 'First line.\nSecond line.', item_id: null }],
  };

  const view = owed.renderOwed({ tz: 'UTC', navigate() {}, rerender() {} });
  const open = plainWalk(view).find((n) => n.tag === 'a' && textOf(n) === 'Open in your email program');
  assert.ok(open, 'no mailto link');

  // The click reads the textarea NOW — first the fetched body, CRLF-encoded...
  open.fire('click');
  assert.equal(open.getAttribute('href'),
    'mailto:sam%40example.com?subject=the%20survey&body=First%20line.%0D%0ASecond%20line.');

  // ...then the edited one, with no save round-trip in between. Sending the
  // reply used to be copy, switch, click, click, paste.
  const area = findInput(view, (n) => n.tag === 'textarea');
  area.value = 'The reply as edited.';
  area.fire('input');
  open.fire('click');
  assert.match(open.getAttribute('href'), /&body=The%20reply%20as%20edited\.$/);
  area.fire('blur');
  await settle();

  // A short reply carries no warning...
  const note = plainWalk(view).find((n) => (n.attributes.class || '').includes('draft-note'));
  assert.ok(note, 'the honesty note is missing from the card');
  assert.equal(note.hidden, true);

  // ...and a long one says the start is filled in, before the click happens.
  area.value = 'A reply that will not fit. '.repeat(200);
  area.fire('input');
  assert.equal(note.hidden, false);
  assert.match(textOf(note), /start/);
  open.fire('click');
  const href = open.getAttribute('href');
  assert.ok(href.length <= 1900, `a ${href.length}-character address will be cut by the email program itself`);
  assert.ok('A reply that will not fit. '.repeat(200)
    .startsWith(decodeURIComponent(href.slice(href.indexOf('&body=') + 6))));
  area.fire('blur');
  await settle();

  // Copy stays the first-class door.
  const actions = plainWalk(view).find((n) => (n.attributes.class || '') === 'draft-actions');
  assert.equal(textOf(actions.children[0]), 'Copy the text');
  assert.match(actions.children[0].attributes.class, /solid/);
});

test('the hero can be told "Not a thing", through the same controls the rows get', async (t) => {
  withPlainDom(t);
  const calls = [];
  globalThis.fetch = rowFetch(calls);
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const items = await import(fileUrl(UI, 'lib/items.js'));
  t.after(() => { delete globalThis.fetch; store.notify(null); });

  const hero = items.itemHero({ id: 'h9', bucket: 'now', state: 'open', headline: 'Noise' }, { tz: 'UTC' });
  const dismiss = findButton(hero, 'Not a thing');
  assert.ok(dismiss, 'the hero has no way to say the top pick is noise');
  dismiss.fire('click');
  await settle();
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/items/h9/state' && c.body?.state === 'dismissed'),
    'the dismissal never reached the server');

  // Reused, not forked, so hero and rows cannot drift apart again. The hero
  // keeps its own top-level Snooze button — its most-used second action does
  // not belong two clicks deep — but it must be the SHARED snoozeControl, and
  // "Not a thing" must still arrive through the rows' own moreControls.
  const src = fs.readFileSync(path.join(UI, 'lib/items.js'), 'utf8');
  const heroFn = /export function itemHero[\s\S]*?\n\}/m.exec(src);
  assert.ok(heroFn, 'itemHero is missing');
  assert.match(heroFn[0], /moreControls\(item\)/, 'the hero must build the same controls the rows do');
  assert.match(heroFn[0], /snoozeControl\(item\)/, 'the hero lost its top-level Snooze');
  const snoozeToggle = findButton(hero, 'Snooze');
  assert.ok(snoozeToggle, 'Snooze must stay one click away on the hero');
});

test('the snooze menu prints each promise and can be told a day of your own', async (t) => {
  withPlainDom(t);
  const calls = [];
  globalThis.fetch = rowFetch(calls);
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const items = await import(fileUrl(UI, 'lib/items.js'));
  const priorConfig = store.state.config;
  store.state.config = { identity: { timezone: 'America/New_York' } };
  t.after(() => { store.state.config = priorConfig; delete globalThis.fetch; store.notify(null); });

  const row = items.itemRow({ id: 's1', bucket: 'now', state: 'open', headline: 'Call Sam' }, { tz: 'America/New_York' });
  plainWalk(row).find((n) => (n.attributes.class || '') === 'disclosure').fire('click');
  findButton(row, 'Snooze').fire('click');

  // The three fixed choices say when, before the click.
  assert.equal(findButtons(row, /^In 4 hours · (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}(:\d{2})? [AP]M$/).length, 1, 'the four-hour choice does not print its deadline');
  assert.equal(findButtons(row, /^Tomorrow morning · 9 AM$/).length, 1);
  assert.equal(findButtons(row, /^Next week · \w{3}, \w{3} \d{1,2} 9 AM$/).length, 1);

  // The fourth: any day, back on the board at 9 that morning.
  const pick = findButton(row, 'Pick a day…');
  assert.ok(pick, 'there is no way to say Saturday');
  pick.fire('click');
  const day = findInput(row, (n) => n.attributes.type === 'date');
  assert.ok(day, 'no date field behind Pick a day…');
  const min = ui.addDaysToKey(ui.todayKey('America/New_York'), 1);
  assert.equal(day.getAttribute('min'), min, 'yesterday must not be on offer');

  const picked = ui.addDaysToKey(min, 30);
  day.value = picked;
  day.fire('input');
  findButton(row, 'Back that morning · 9 AM').fire('click');
  await settle();
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/items/s1/state');
  assert.ok(post, 'the picked day never reached the server');
  assert.equal(post.body.state, 'snoozed');
  assert.match(post.body.until, new RegExp(`^${picked}T09:00:00[-+]\\d{2}:\\d{2}$`),
    'the promise is 9:00 that morning, carrying the configured zone');
  assert.equal(ui.dayKey(post.body.until), picked);
});

test('connection status keeps successful read times separate from failures, paused and never-checked sources', async (t) => {
  withPlainDom(t);
  globalThis.fetch = plainFetch({});
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const now = await import(fileUrl(UI, 'views/now.js'));
  t.after(() => { delete globalThis.fetch; });
  store.state.config = { identity: { timezone: 'UTC' }, model: {}, mail: [{ id: 'm1', label: 'Studio mail', user: 'sam@example.com' }], calendars: [{ id: 'c1', label: 'Team calendar', kind: 'ics' }], sources: [{ id: 's1', label: 'Paused tasks', type: 'todoist', enabled: false }, { id: 's2', label: 'New tasks', type: 'linear' }] };
  store.state.health = { model: { configured: true } };
  store.state.sweep = { running: false, error: null };
  store.state.board = { ...store.state.board, items: [], notes: [], events: [], counts: {}, finished: [], runs: {}, sourceStatus: [
    { id: 'm1', kind: 'mail', configKey: 'mail', label: 'Studio mail', enabled: true, ok: false, lastAttemptAt: '2026-09-09T18:00:00Z', lastSuccessAt: '2026-09-08T15:00:00Z', error: 'Sign in again', retryAt: '2026-09-10T18:00:00Z' },
    { id: 'c1', kind: 'calendar', configKey: 'calendars', label: 'Team calendar', enabled: true, ok: true, lastAttemptAt: '2026-09-09T18:00:00Z', lastSuccessAt: '2026-09-09T18:00:00Z', error: null },
    { id: 's1', kind: 'todoist', configKey: 'sources', label: 'Paused tasks', enabled: false, ok: false, lastAttemptAt: null, lastSuccessAt: null, error: 'Old problem' },
    { id: 's2', kind: 'linear', configKey: 'sources', label: 'New tasks', enabled: true, ok: null, lastAttemptAt: null, lastSuccessAt: null, error: null },
  ] };
  const mail = settings.mailPanel();
  assert.match(onScreen(mail), /Needs attention/);
  assert.match(onScreen(mail), /Last successful read: Tue, Sep 8, 2026 · 3 PM/);
  assert.match(onScreen(mail), /Last tried: Wed, Sep 9, 2026 · 6 PM/);
  assert.match(onScreen(mail), /Sign in again/);
  assert.match(onScreen(mail), /Can retry after: Thu, Sep 10, 2026 · 6 PM/);
  assert.match(onScreen(settings.calendarPanel()), /Read successfully.*Last successful read: Wed, Sep 9, 2026 · 6 PM/);
  const sources = onScreen(settings.sourcesPanel());
  assert.match(sources, /Paused tasks.*Paused/);
  assert.match(sources, /New tasks.*Not checked yet/);
  assert.doesNotMatch(sources, /Old problem/);
  const paths = [];
  const board = now.renderNow({ tz: 'UTC', navigate: path => paths.push(path) });
  assert.match(onScreen(board), /Reading status/);
  assert.match(onScreen(board), /Studio mail.*Sign in again/);
  findButton(board, 'Review connection').fire('click');
  assert.deepEqual(paths, ['#/settings/mail/m1']);
});

test('an older server never invents a successful read time for missing or failed source reports', async (t) => {
  withPlainDom(t);
  globalThis.fetch = plainFetch({});
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  t.after(() => { delete globalThis.fetch; });
  store.state.config = { identity: { timezone: 'UTC' }, mail: [{ id: 'legacy', label: 'Older mail', user: 'sam@example.com' }], calendars: [], sources: [] };
  store.state.board = { ...store.state.board, sourceStatus: undefined, runs: { last: { ok: true, ended_at: '2026-09-09T18:00:00Z', stats: { sources: [{ id: 'legacy', kind: 'mail', ok: false, error: 'Password refused' }] } } } };
  const failed = onScreen(settings.mailPanel());
  assert.match(failed, /Needs attention.*No successful read time recorded.*Last tried: Wed, Sep 9, 2026 · 6 PM/);
  store.state.board.runs.last.stats.sources = [];
  const missing = onScreen(settings.mailPanel());
  assert.match(missing, /No reading result available/);
  assert.doesNotMatch(missing, /Read successfully|Last successful read:|Last tried:/);
});

test('custom snooze dates reject past and impossible days with recoverable feedback', async (t) => {
  withPlainDom(t);
  const calls = [];
  globalThis.fetch = rowFetch(calls);
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const items = await import(fileUrl(UI, 'lib/items.js'));
  const priorConfig = store.state.config;
  store.state.config = { identity: { timezone: 'UTC' } };
  t.after(() => { store.state.config = priorConfig; delete globalThis.fetch; store.notify(null); });
  const row = items.itemRow({ id: 'invalid-snooze', bucket: 'now', state: 'open', headline: 'Call Sam' }, { tz: 'UTC' });
  plainWalk(row).find(n => n.attributes.class === 'disclosure').fire('click');
  findButton(row, 'Snooze').fire('click');
  findButton(row, 'Pick a day…').fire('click');
  const day = findInput(row, n => n.attributes.type === 'date');
  const confirm = findButton(row, 'Back that morning · 9 AM');
  for (const invalid of [ui.todayKey('UTC'), '2099-02-31', 'not a date']) {
    day.value = invalid;
    day.fire('input');
    assert.equal(confirm.disabled, true, `${invalid} must not enable snoozing`);
    assert.equal(day.attributes['aria-invalid'], 'true');
    assert.match(onScreen(row), /Choose a valid date from tomorrow onward/);
    confirm.fire('click');
    await settle();
  }
  assert.equal(calls.length, 0, 'an invalid date must not reach the server');
  day.value = ui.addDaysToKey(ui.todayKey('UTC'), 2);
  day.fire('input');
  assert.equal(confirm.disabled, false);
  assert.equal(day.attributes['aria-invalid'], 'false');
  assert.doesNotMatch(onScreen(row), /Choose a valid date/);
  confirm.fire('click');
  await settle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('finished items offer clear Restore and Reopen actions, and reopening has an accurate accessible name', async (t) => {
  withPlainDom(t);
  const calls = [];
  globalThis.fetch = rowFetch(calls);
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const items = await import(fileUrl(UI, 'lib/items.js'));
  t.after(() => { delete globalThis.fetch; store.notify(null); });
  const done = items.itemRow({ id: 'restore-done', bucket: 'now', state: 'done', headline: 'Sent the survey' }, { tz: 'UTC' });
  const dismissed = items.itemRow({ id: 'restore-dismissed', bucket: 'now', state: 'dismissed', headline: 'A real request' }, { tz: 'UTC' });
  const tick = plainWalk(done).find(n => n.attributes.role === 'checkbox');
  assert.equal(tick.attributes['aria-label'], 'Reopen: Sent the survey');
  for (const [row, label] of [[done, 'Reopen'], [dismissed, 'Restore']]) {
    const restore = findButton(row, label);
    assert.ok(restore, `${label} should be visible without opening More`);
    assert.equal(plainHidden(restore), false);
    restore.fire('click');
    await settle();
  }
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => [c.path, c.body]), [
    ['/api/items/restore-done/state', { state: 'open' }],
    ['/api/items/restore-dismissed/state', { state: 'open' }],
  ]);
});

test('inactive finished tasks explain why they cannot be restored onto the current board', async (t) => {
  withPlainDom(t);
  const items = await import(fileUrl(UI, 'lib/items.js'));
  const row = items.itemRow({ id: 'old-finished-task', state: 'done', bucket: 'now', headline: 'An old task', sourceInactive: true }, { tz: 'UTC' });
  const tick = plainWalk(row).find(n => n.attributes.role === 'checkbox');
  assert.equal(tick.attributes.disabled, '');
  assert.equal(findButton(row, 'Restore'), undefined);
  assert.equal(findButton(row, 'Reopen'), undefined);
  assert.equal(plainWalk(row).some(n => n.attributes.class === 'disclosure'), true);
  assert.ok(findButton(row, 'What changed?'));
  for (const label of ['Snooze', 'Wake', 'Not a thing']) assert.equal(findButton(row, label), undefined);
  assert.match(onScreen(row), /No longer in task selection.*include this task in your source selection again/);
});

test('a row and the hero wear "new" and their source at the end of the line', async (t) => {
  withPlainDom(t);
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const items = await import(fileUrl(UI, 'lib/items.js'));
  const priorBoard = store.state.board;
  store.state.board = { ...store.state.board, runs: { last: { ok: true, started_at: '2026-08-11T12:00:00Z' } } };
  t.after(() => { store.state.board = priorBoard; });

  const row = items.itemRow({
    id: 'r1', bucket: 'now', state: 'open', headline: 'Call Sam', person: 'Sam',
    kind: 'mail', sourceRefs: ['msg:a', 'msg:b', 'msg:c'], first_seen: '2026-08-11T12:30:00Z',
  }, { tz: 'UTC' });
  const meta = plainWalk(row).find((n) => (n.attributes.class || '') === 'meta mono');
  assert.ok(meta, 'no meta line');
  const bits = meta.children.map(textOf);
  assert.equal(bits.at(-1), '· from your mail (3)', 'the source stamp ends the line, dimmest');
  assert.equal(bits.at(-2), '· new');

  // Seen before the check started: not news, however the model worded it.
  const old = items.itemRow({
    id: 'r2', bucket: 'now', state: 'open', headline: 'Old', kind: 'mail',
    sourceRefs: ['msg:a'], first_seen: '2026-08-11T11:00:00Z',
  }, { tz: 'UTC' });
  const oldMeta = plainWalk(old).find((n) => (n.attributes.class || '') === 'meta mono');
  assert.ok(!oldMeta.children.map(textOf).some((b) => b === 'new' || b === '· new'),
    'an item the last check merely re-cited is wearing the mark');

  const hero = items.itemHero({
    id: 'h1', bucket: 'now', state: 'open', headline: 'Top', kind: 'derived',
    sourceRefs: [], first_seen: '2026-08-11T12:30:00Z',
  }, { tz: 'UTC' });
  const hm = plainWalk(hero).find((n) => (n.attributes.class || '') === 'hero-meta mono');
  const texts = hm.children.map(textOf);
  assert.ok(texts.includes('new'), 'the hero hides the newness the rows show');
  assert.ok(texts.includes('no source saved'), 'an unreceipted assertion must say so');
  const derived = hm.children.find((n) => textOf(n) === 'no source saved');
  assert.match(derived.attributes.class, /meta-derived/, '"no source saved" must not dress like provenance');
});

/**
 * The two lost-session screens. Neither is rendered by the walk above — one is
 * app.js-internal, the other a store answer — but both are states a
 * non-expert genuinely reaches (a bookmarked board after a restart), so their
 * words are held to the same rule, at the source and at the export. And the
 * desktop shell has no terminal to reopen from: its way back is Board →
 * Reload board, so both screens must know which shell they are on.
 */
test('the two lost-session screens speak the register the walk enforces', async () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const screen = /function noTokenScreen\(\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(screen, 'noTokenScreen is missing');
  for (const [literal] of screen[0].matchAll(/'[^']*'/g)) {
    assert.doesNotMatch(literal, JARGON, `noTokenScreen: ${literal.match(JARGON)?.[0]}`);
    assert.doesNotMatch(literal, /127\.0\.0\.1/, 'a loopback address is the same register');
  }
  assert.match(screen[0], /window\.zelos/, 'the screen must branch on the shell it is in');
  assert.match(screen[0], /Reload board/);

  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const { ApiError } = await import(fileUrl(UI, 'lib/api.js'));
  const lost = store.fatalFor(new ApiError('no', { status: 401 }));
  assert.doesNotMatch(`${lost.title} ${lost.detail}`, JARGON,
    `the 401 screen in a browser: ${`${lost.title} ${lost.detail}`.match(JARGON)?.[0]}`);
  assert.match(lost.detail, /terminal/, 'a browser tab is pointed back to the printed address');
  globalThis.window.zelos = { desktop: true };
  try {
    const desk = store.fatalFor(new ApiError('no', { status: 401 }));
    assert.doesNotMatch(`${desk.title} ${desk.detail}`, JARGON,
      `the 401 screen in the shell: ${`${desk.title} ${desk.detail}`.match(JARGON)?.[0]}`);
    assert.match(desk.detail, /Reload board/, 'the desktop shell has no terminal — its menu is the way back');
  } finally {
    delete globalThis.window.zelos;
  }
});

test('the guided AI card stores the key, tests, picks the model itself, saves and moves on — in that order', async (t) => {
  withPlainDom(t);
  const calls = [];
  const presets = await llmPresets();
  globalThis.fetch = plainFetch({ presets, calls });
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, backend: { name: 'encrypted-file' } };
  store.state.secretRefs = [];

  // The defaults are read off the presets, never invented here.
  const anthropic = presets.find((p) => p.id === 'anthropic');
  const openai = presets.find((p) => p.id === 'openai');
  assert.equal(settings.pickDefaultModel(anthropic), 'claude-sonnet-5');
  assert.ok(anthropic.suggestedModels.includes('claude-sonnet-5'), 'the guided default is not a model the preset names');
  assert.equal(settings.pickDefaultModel(openai), openai.suggestedModels[0]);
  assert.equal(settings.pickDefaultModel({ id: 'anthropic', suggestedModels: ['x'] }), 'x', 'a preferred id not on the list must fall back to the list');
  assert.equal(settings.pickDefaultModel({ suggestedModels: [] }), '');
  assert.equal(settings.pickDefaultModel(null), '');
  assert.doesNotMatch(settings.COST_LINE, /\d|[$€£]/, 'the cost line must never carry a number');

  let done = 0;
  const panel = settings.modelPanel({ compact: true, onDone: () => { done += 1; } });
  await settle();
  findButtons(panel, /^Claude, by Anthropic/)[0].fire('click');
  const key = findInput(panel, (n) => n.attributes.type === 'password');
  assert.ok(key && !plainHidden(key), 'the key box is not on the guided card');
  key.value = 'sk-ant-not-a-real-key';
  findButton(panel, 'Check it works').fire('click');
  await settle();
  await settle();

  // Every write, in order. The "Stuck? Ask Claude" line under the panel asks
  // POST /api/help for its message on each paint; that is a read with a body,
  // not a write, and it is the other test's business.
  const wire = calls.filter((c) => c.method !== 'GET' && c.path !== '/api/help').map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(wire, ['POST /api/secrets', 'POST /api/model/test', 'PUT /api/config'], `the wire was ${wire.join(', ')}`);
  assert.deepEqual(calls.find((c) => c.path === '/api/secrets').body, { ref: 'model.default', value: 'sk-ant-not-a-real-key' });
  const tested = calls.find((c) => c.path === '/api/model/test').body;
  assert.equal(tested.model, 'claude-sonnet-5', 'the test did not carry the model the card picked');
  assert.equal(tested.baseUrl, anthropic.baseUrl);
  const saved = calls.find((c) => c.path === '/api/config').body.model;
  assert.deepEqual(saved, { protocol: 'anthropic', label: 'Anthropic', baseUrl: anthropic.baseUrl, model: 'claude-sonnet-5', keyRef: 'model.default' });
  assert.equal(key.value, '', 'the key is still in the box after it was stored');
  assert.match(onScreen(panel), /Working\. Zelos will use Claude\./);
  assert.equal(done, 1, 'onDone did not fire, so onboarding would not advance');

  // A fresh home. core/config.mjs's DEFAULTS pre-select the Anthropic preset
  // with an empty model id, so the panel opens on the Claude card already —
  // and that card has to have picked its model, or the first press of "Check
  // it works" refuses with "could not pick a model". Found by driving the app.
  const { DEFAULTS } = await import(fileUrl(ROOT, 'core/config.mjs'));
  assert.equal(DEFAULTS.model.baseUrl, anthropic.baseUrl, 'the premise: a fresh home points at Anthropic');
  assert.equal(DEFAULTS.model.model, '', 'the premise: with no model chosen');
  calls.length = 0;
  store.state.config = { ...store.state.config, model: { ...DEFAULTS.model } };
  const fresh = settings.modelPanel({ compact: true });
  await settle();
  assert.match(onScreen(fresh), /1\. Open.*Anthropic’s key page ↗/, 'a fresh home does not open on the Claude card');
  const freshKey = findInput(fresh, (n) => n.attributes.type === 'password');
  freshKey.value = 'sk-ant-not-a-real-key';
  findButton(fresh, 'Check it works').fire('click');
  await settle();
  await settle();
  assert.doesNotMatch(onScreen(fresh), /could not pick a model/, 'the restored card has no model');
  assert.equal(calls.find((c) => c.path === '/api/model/test')?.body.model, 'claude-sonnet-5', 'the restored card did not pick the default model');
  assert.match(onScreen(fresh), /Working\. Zelos will use Claude\./);
  store.state.config = { ...store.state.config, model: {} };

  // A runtime on this machine is offered first, as "Most private", and only when found.
  calls.length = 0;
  globalThis.fetch = plainFetch({ presets, calls, probe: [{ label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'llama3.2' }] }] });
  const withLocal = settings.modelPanel({ compact: true });
  await settle();
  const local = findButtons(withLocal, /^An AI program on this computer — Ollama/);
  assert.equal(local.length, 1, 'a found runtime is not offered by name');
  assert.match(textOf(local[0]), /Most private/);
  const order = plainWalk(withLocal).filter((n) => n.tag === 'button');
  assert.ok(order.indexOf(local[0]) < order.indexOf(findButtons(withLocal, /^Claude/)[0]), 'the local card is not first');
  assert.doesNotMatch(onScreen(withLocal), JARGON, `the AI panel with a local runtime: ${onScreen(withLocal).match(JARGON)?.[0]}`);
  local[0].fire('click');
  assert.match(onScreen(withLocal), /Zelos found Ollama running on this computer\. Nothing you read will leave this computer\./);
  assert.doesNotMatch(onScreen(withLocal), JARGON, `the local guided card: ${onScreen(withLocal).match(JARGON)?.[0]}`);
});

/**
 * The two sign-in blocks save the client the flow actually RAN AGAINST.
 *
 * When the server has a client of its own the id field is never on screen,
 * so oauth() used to hand back `clientId: ''` — and connectSimpleMail saved
 * it, the card said "Connected · N mailboxes", and every sweep after it
 * threw before the stored grant was even consulted. The server has always
 * answered begin/status with the resolved `clientId`; these tests pin that
 * the blocks pick it up and that the saved account is self-describing.
 */
test('the guided AI setup keeps a refused key recoverable and advances only after a successful retry', async (t) => {
  withPlainDom(t);
  const calls = [];
  const base = plainFetch({ presets: await llmPresets(), calls });
  let refused = true;
  globalThis.fetch = async (reqPath, init = {}) => {
    if (reqPath === '/api/model/test' && refused) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'That key was refused. Try a new key.' }) };
    return base(reqPath, init);
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [] };
  store.state.health = { model: { configured: false } };
  store.state.secretRefs = [];
  let advances = 0;
  const panel = settings.modelPanel({ compact: true, onDone: () => { advances += 1; } });
  await settle();
  findButtons(panel, /^Claude, by Anthropic/)[0].fire('click');
  const key = findInput(panel, n => n.attributes.type === 'password');
  key.value = 'refused-test-key';
  findButton(panel, 'Check it works').fire('click');
  await settle();
  assert.match(onScreen(panel), /That key was refused/);
  assert.equal(advances, 0);
  assert.equal(calls.some(c => c.method === 'PUT'), false);
  refused = false;
  key.value = 'replacement-test-key';
  findButton(panel, 'Check it works').fire('click');
  await settle();
  assert.match(onScreen(panel), /Working\. Zelos will use Claude/);
  assert.equal(advances, 1);
  assert.deepEqual(calls.filter(c => c.path === '/api/secrets').map(c => c.body.value), ['refused-test-key', 'replacement-test-key']);
});

test('email setup can retry a refused connection with a replacement password and the same address', async (t) => {
  withPlainDom(t);
  const calls = [];
  const base = plainFetch({ guesses: GUESSES, calls });
  let refused = true;
  globalThis.fetch = async (reqPath, init = {}) => {
    if (reqPath === '/api/mail/test') return { ok: true, status: 200, text: async () => JSON.stringify(refused
      ? { ok: false, error: 'That password was refused. Try a new password.' }
      : { ok: true, mailboxes: [{ name: 'INBOX' }, { name: 'Sent', specialUse: 'sent' }] }) };
    return base(reqPath, init);
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [] };
  store.state.secretRefs = [];
  let advances = 0;
  const form = settings.simpleMailForm({ onSaved: () => { advances += 1; }, onCancel() {} });
  const email = findInput(form, n => n.attributes.type === 'email');
  email.value = 'frank@icloud.com';
  email.fire('change');
  await settle();
  const password = findInput(form, n => n.attributes.type === 'password');
  password.value = 'refused-test-password';
  findButton(form, 'Connect').fire('click');
  await settle();
  assert.match(onScreen(form), /That password was refused/);
  assert.equal(advances, 0);
  assert.equal(email.value, 'frank@icloud.com');
  assert.equal(calls.some(c => c.method === 'PUT'), false);
  refused = false;
  password.value = 'replacement-test-password';
  findButton(form, 'Connect').fire('click');
  await settle();
  assert.match(onScreen(form), /Connected · 2 mailboxes/);
  assert.equal(advances, 1);
  assert.equal(store.state.config.mail[0].user, 'frank@icloud.com');
  assert.deepEqual(calls.filter(c => c.path === '/api/secrets').map(c => c.body.value), ['refused-test-password', 'replacement-test-password']);
});

test('the simple card saves the client a Google sign-in ran against, not the empty field it never showed', async (t) => {
  withPlainDom(t);
  const RESOLVED = '4242-zelos.apps.googleusercontent.com';
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (reqPath, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: reqPath, body });
    if (reqPath === '/api/mail/guess') return ok({ ...GUESSES['frank@gmail.com'], clientReady: true });
    if (reqPath === '/api/guides') return ok(GUIDES);
    if (reqPath === '/api/help') return ok(helpAnswer(body));
    if (reqPath === '/api/mail/oauth') {
      return ok({ id: 'f1', provider: 'google', state: 'connected', status: 'connected', keyRef: body.keyRef, clientId: RESOLVED, user: 'frank@gmail.com', error: null });
    }
    if (reqPath === '/api/mail/test') {
      return ok({ ok: true, capabilities: [], error: null, mailboxes: [{ name: 'INBOX', specialUse: 'inbox' }, { name: '[Gmail]/Sent Mail', specialUse: 'sent' }] });
    }
    if (reqPath === '/api/config') return ok({ config: { identity: { email: 'frank@gmail.com' }, mail: body?.mail ?? [] }, errors: [], secretRefs: [] });
    if (reqPath === '/api/health') return ok({ model: { configured: false } });
    throw new Error(`unexpected ${reqPath}`);
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = { identity: { name: '', email: '' }, mail: [], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, backend: { name: 'encrypted-file' } };
  store.state.secretRefs = [];

  const form = settings.simpleMailForm({ onSaved() {}, onCancel() {} });
  const email = findInput(form, (n) => n.attributes.type === 'email');
  email.value = 'frank@gmail.com';
  email.fire('change');
  await settle();
  findButton(form, 'Sign in with Google').fire('click');
  await settle();
  findButton(form, 'Connect').fire('click');
  await settle();
  assert.equal(calls.find((c) => c.path === '/api/mail/oauth').body.clientId, undefined, 'an empty field lets the server pick its own client');
  assert.deepEqual(calls.find((c) => c.path === '/api/mail/test').body.oauth, { provider: 'google', clientId: RESOLVED },
    'the account is tested with the client the grant was minted for');
  assert.deepEqual(calls.find((c) => c.method === 'PUT' && c.path === '/api/config').body.mail[0].oauth, { provider: 'google', clientId: RESOLVED },
    'and saved with it — a saved clientId of \'\' is an account the sweep cannot refresh');
});

test('the simple card saves the client a Microsoft sign-in ran against, the same way', async (t) => {
  withPlainDom(t);
  const RESOLVED = '11111111-2222-3333-4444-555555555555';
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (reqPath, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: reqPath, body });
    if (reqPath === '/api/mail/guess') return ok({ ...GUESSES['frank@hotmail.com'], clientReady: true });
    if (reqPath === '/api/guides') return ok(GUIDES);
    if (reqPath === '/api/help') return ok(helpAnswer(body));
    if (reqPath === '/api/mail/oauth') {
      return ok({ id: 'f2', provider: 'microsoft', state: 'connected', status: 'connected', keyRef: body.keyRef, clientId: RESOLVED, error: null });
    }
    if (reqPath === '/api/mail/test') {
      return ok({ ok: true, capabilities: [], error: null, mailboxes: [{ name: 'INBOX', specialUse: 'inbox' }, { name: 'Sent Items', specialUse: 'sent' }] });
    }
    if (reqPath === '/api/config') return ok({ config: { identity: { email: 'frank@hotmail.com' }, mail: body?.mail ?? [] }, errors: [], secretRefs: [] });
    if (reqPath === '/api/health') return ok({ model: { configured: false } });
    throw new Error(`unexpected ${reqPath}`);
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = { identity: { name: '', email: '' }, mail: [], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, backend: { name: 'encrypted-file' } };
  store.state.secretRefs = [];

  const form = settings.simpleMailForm({ onSaved() {}, onCancel() {} });
  const email = findInput(form, (n) => n.attributes.type === 'email');
  email.value = 'frank@hotmail.com';
  email.fire('change');
  await settle();
  findButton(form, 'Sign in with Microsoft').fire('click');
  await settle();
  findButton(form, 'Connect').fire('click');
  await settle();
  assert.equal(calls.find((c) => c.path === '/api/mail/oauth').body.clientId, undefined, 'an empty field lets the server pick its own client');
  assert.deepEqual(calls.find((c) => c.path === '/api/mail/test').body.oauth, { provider: 'microsoft', clientId: RESOLVED, tenantId: 'common' },
    'Connect is not refused for a client id the user never saw');
  assert.deepEqual(calls.find((c) => c.method === 'PUT' && c.path === '/api/config').body.mail[0].oauth, { provider: 'microsoft', clientId: RESOLVED, tenantId: 'common' });
});

test('the account editor asks the server whether Microsoft sign-in is ready, the way its Google branch does', async (t) => {
  withPlainDom(t);
  const RESOLVED = '11111111-2222-3333-4444-555555555555';
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (reqPath, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: reqPath, body });
    if (reqPath === '/api/mail/guess') return ok({ ...GUESSES['frank@hotmail.com'], clientReady: true });
    if (reqPath === '/api/guides') return ok(GUIDES);
    if (reqPath === '/api/help') return ok(helpAnswer(body));
    if (reqPath === '/api/mail/oauth') {
      return ok({ id: 'f3', provider: 'microsoft', state: 'connected', status: 'connected', keyRef: body.keyRef, clientId: RESOLVED, error: null });
    }
    if (reqPath === '/api/config') return ok({ config: { identity: { email: 'frank@hotmail.com' }, mail: body?.mail ?? [] }, errors: [], secretRefs: [] });
    if (reqPath === '/api/health') return ok({ model: { configured: false } });
    throw new Error(`unexpected ${reqPath}`);
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const account = {
    id: 'm_9', keyRef: 'mail.m_9', enabled: true, label: 'Hotmail', host: 'outlook.office365.com',
    port: 993, secure: true, requireTls: null, user: 'frank@hotmail.com', auth: 'xoauth2',
    oauth: { provider: 'microsoft', clientId: '', tenantId: 'common' },
    mailboxes: ['INBOX'], sentMailbox: 'Sent Items', lookbackDays: 14, maxMessages: 400,
  };
  store.state.config = { identity: { name: '', email: 'frank@hotmail.com' }, mail: [account], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, backend: { name: 'encrypted-file' } };
  store.state.secretRefs = [];

  const panel = settings.mailPanel({ rerender() {} });
  findButton(panel, 'Edit').fire('click');
  // The picker already says Microsoft; opening the form paints the slot,
  // and painting the slot is what asks — no change event required.
  await settle();
  assert.equal(calls.filter((c) => c.path === '/api/mail/guess').length, 1, 'whether a client is ready is the server\'s answer, asked once');
  findButton(panel, 'Sign in with Microsoft').fire('click');
  await settle();
  const began = calls.find((c) => c.path === '/api/mail/oauth');
  assert.ok(began, 'the editor refused a sign-in the server\'s own client could run — the reconnect path is dead-ended');
  assert.equal(began.body.clientId, undefined, 'an empty field lets the server pick its own client');
  findButton(panel, 'Save account').fire('click');
  await settle();
  assert.deepEqual(calls.find((c) => c.method === 'PUT' && c.path === '/api/config').body.mail.find((m) => m.id === 'm_9').oauth,
    { provider: 'microsoft', clientId: RESOLVED, tenantId: 'common' },
    'reconnecting from the editor saves the client the grant was minted for');
});

test('the account editor\'s Microsoft refusal shows the setup page, not the name of a file', async (t) => {
  withPlainDom(t);
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (reqPath, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: reqPath, body });
    if (reqPath === '/api/mail/guess') return ok({ ...GUESSES['frank@hotmail.com'] });
    if (reqPath === '/api/guides') return ok(GUIDES);
    if (reqPath === '/api/help') return ok(helpAnswer(body));
    if (reqPath === '/api/config') return ok({ config: { identity: { email: 'frank@hotmail.com' }, mail: [] }, errors: [], secretRefs: [] });
    if (reqPath === '/api/health') return ok({ model: { configured: false } });
    throw new Error(`unexpected ${reqPath}`);
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const account = {
    id: 'm_8', keyRef: 'mail.m_8', enabled: true, label: 'Hotmail', host: 'outlook.office365.com',
    port: 993, secure: true, requireTls: null, user: 'frank@hotmail.com', auth: 'xoauth2',
    oauth: { provider: 'microsoft', clientId: '', tenantId: 'common' },
    mailboxes: ['INBOX'], sentMailbox: 'Sent Items', lookbackDays: 14, maxMessages: 400,
  };
  store.state.config = { identity: { name: '', email: 'frank@hotmail.com' }, mail: [account], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, backend: { name: 'encrypted-file' } };
  store.state.secretRefs = [];

  const panel = settings.mailPanel({ rerender() {} });
  findButton(panel, 'Edit').fire('click');
  findInput(panel, (n) => n.tag === 'select' && n.value === 'xoauth2').fire('change');
  await settle();
  findButton(panel, 'Sign in with Microsoft').fire('click');
  await settle();
  assert.match(onScreen(panel), /One more step first/);
  assert.ok(plainWalk(panel).some((n) => n.tag === 'a' && textOf(n) === 'Show me how ↗' && !plainHidden(n)),
    'the refusal promises "the page below" and shows no page');
  assert.doesNotMatch(onScreen(panel), /docs\/OAUTH\.md/, 'a repo file path stands where the link belongs');
});

test('removing a calendar deletes its stored password, as removing a mail account does', async (t) => {
  withPlainDom(t);
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (reqPath, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: reqPath, body });
    if (reqPath === '/api/config') return ok({ config: { identity: {}, mail: [], calendars: body?.calendars ?? [], sources: [] }, errors: [], secretRefs: [] });
    if (reqPath.startsWith('/api/secrets/')) return ok({ ok: true });
    if (reqPath === '/api/help') return ok(helpAnswer(body));
    if (reqPath === '/api/health') return ok({ model: { configured: false } });
    throw new Error(`unexpected ${reqPath}`);
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = {
    identity: {}, mail: [], sources: [],
    calendars: [{ id: 'c_1', enabled: true, kind: 'caldav', label: 'iCloud', url: 'https://caldav.icloud.com/', user: 'nemo@icloud.com', keyRef: 'calendar.c_1' }],
  };
  store.state.health = { model: { configured: false }, backend: { name: 'encrypted-file' } };
  store.state.secretRefs = ['calendar.c_1'];

  const panel = settings.calendarPanel({ rerender() {} });
  findButton(panel, 'Remove').fire('click');
  await settle();
  assert.ok(calls.some((c) => c.method === 'PUT' && c.path === '/api/config'), 'Remove did not save');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/secrets/calendar.c_1'),
    'the calendar is gone from config but its stored password stays in the secret store forever');
});

test('Settings opens on Email, reads in plain words, keeps every route, and puts Colour last', async (t) => {
  withPlainDom(t);
  globalThis.fetch = plainFetch({ presets: await llmPresets() });
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [], sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: true }, privacy: { sendBodies: true, bodyChars: 4000, maxItemsPerSweep: 150 } };
  store.state.health = { model: { configured: false }, home: '/tmp/zelos-home', backend: { name: 'encrypted-file', note: 'It does NOT protect against a process already running as this user.' } };
  store.state.secretRefs = [];
  store.state.configErrors = [];
  store.state.board = { items: [], events: [], notes: [], counts: {}, runs: {}, tokens: null };

  const view = settings.renderSettings({ sub: null, navigate() {}, rerender() {} });
  const panel = plainWalk(view).find((n) => n.attributes.role === 'tabpanel');
  assert.equal(panel.attributes.id, 'settings-panel-mail', 'Settings no longer opens on Email');
  assert.equal(settings.DEFAULT_PANEL, 'mail');
  const tabs = plainWalk(view).filter((n) => n.attributes.role === 'tab').map(textOf);
  assert.deepEqual(tabs, ['You', 'AI', 'Email', 'Calendars', 'Schedule', 'Privacy', 'Other things it can read (optional)', 'Share with another AI (advanced)', 'Your data', 'About', 'Colour']);
  // The routes are the ids they always were: every deep link keeps working.
  const src = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  const ids = [...src.matchAll(/\{ id: '([a-z]+)', label: '[^']+' \}/g)].map((m) => m[1]);
  for (const id of ['you', 'model', 'mail', 'calendars', 'sources', 'sweep', 'privacy', 'ai', 'data', 'about']) {
    assert.ok(ids.includes(id), `#/settings/${id} no longer routes anywhere`);
  }
  // The colour picker is no longer the first thing on the screen.
  assert.ok(!plainWalk(view).some((n) => (n.attributes.class || '').includes('accent-swatch')), 'the colour picker is still in the Settings header');
  const colour = settings.renderSettings({ sub: 'appearance', navigate() {}, rerender() {} });
  assert.ok(plainWalk(colour).some((n) => (n.attributes.class || '').includes('accent-swatch')), 'the Colour tab has no picker');

  // A stale or mistyped deep link (#/settings/appearence) opens the default
  // panel with its tab selected — not the AI panel under no tab at all, with
  // an aria-labelledby naming an element that does not exist.
  const lost = settings.renderSettings({ sub: 'appearence', navigate() {}, rerender() {} });
  const lostPanel = plainWalk(lost).find((n) => n.attributes.role === 'tabpanel');
  assert.equal(lostPanel.attributes.id, 'settings-panel-mail', 'an unknown sub-route falls through to the AI panel');
  const lostTab = plainWalk(lost).find((n) => n.attributes.role === 'tab' && n.attributes['aria-selected'] === 'true');
  assert.ok(lostTab, 'no tab is selected for an unknown sub-route');
  assert.equal(lostPanel.attributes['aria-labelledby'], lostTab.attributes.id, 'the panel and the selected tab disagree');

  // Share with another AI opens with the sentence that keeps it from being mistaken for the AI tab.
  const share = settings.renderSettings({ sub: 'ai', navigate() {}, rerender() {} });
  const first = plainWalk(share).find((n) => n.attributes.role === 'tabpanel').children[0];
  assert.match(textOf(first), /^This is NOT where you choose the AI that reads your mail — that is under AI\. Leave this off unless you know what it is\./);

  // Other things it can read opens by telling most people to leave.
  const other = settings.renderSettings({ sub: 'sources', navigate() {}, rerender() {} });
  assert.match(onScreen(other), /Most people need nothing here\. If you use any of these work tools, add them\./);

  // You: the address is "yours", and a blank name is explained in terms of the replies.
  const you = settings.renderSettings({ sub: 'you', navigate() {}, rerender() {} });
  assert.match(onScreen(you), /The address Zelos treats as yours \(usually the same as your mailbox\)/);
  assert.match(onScreen(you), /If you leave this blank, the replies Zelos writes for you will not be signed\./);
  assert.doesNotMatch(onScreen(you), /prompt/, 'the You tab still talks about prompts');

  // Privacy: two sentences and one switch on the card; the two numbers under Advanced.
  const privacy = settings.renderSettings({ sub: 'privacy', navigate() {}, rerender() {} });
  assert.match(onScreen(privacy), /Zelos only talks to the AI service you chose\. It sends nothing to us and nothing to anyone else\./);
  assert.match(onScreen(privacy), /Let the AI read the full text of your emails \(recommended — it does a better job\)/);
  assert.doesNotMatch(onScreen(privacy), /Characters of each|Most items per|telemetry|endpoint/, 'the expert numbers are on the Privacy card');
  assert.match(anywhere(privacy), /Characters of each email sent to the AI/, 'the expert numbers are gone rather than folded');

  // About: one plain line on passwords, the spend as "AI usage today", the essay folded and un-shouted.
  const about = settings.renderSettings({ sub: 'about', navigate() {}, rerender() {} });
  assert.match(onScreen(about), /Your passwords are locked in an encrypted file on this computer\./);
  assert.match(onScreen(about), /AI usage today/);
  assert.doesNotMatch(onScreen(about), /AES|0600|\.seed|attacker|does NOT protect/, 'the security essay is on the About card');
  assert.match(anywhere(about), /does not protect against a process/, 'the store note is gone, or still in capitals');
  assert.match(anywhere(about), /Security details/);
});

test('the schedule speaks am/pm and stores the 24-hour numbers config validates', async (t) => {
  withPlainDom(t);
  const calls = [];
  globalThis.fetch = plainFetch({ calls });
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));

  assert.equal(settings.hourLabel(0), '12 am');
  assert.equal(settings.hourLabel(6), '6 am');
  assert.equal(settings.hourLabel(12), '12 pm');
  assert.equal(settings.hourLabel(13), '1 pm');
  assert.equal(settings.hourLabel(23), '11 pm');
  assert.equal(settings.hourLabel(24), '', '24 is not an hour config accepts');
  assert.equal(settings.HOUR_CHOICES.length, 24);
  assert.equal(settings.HOUR_CHOICES[0].value, '0');
  // The end picker stops at 11 pm: core/config.mjs wants 0–23 with start < end,
  // and the old number box wrote a 24 that validateConfig then refused.
  assert.equal(settings.END_HOUR_CHOICES[0].value, '1');
  assert.equal(settings.END_HOUR_CHOICES.at(-1).value, '23');
  assert.ok(settings.END_HOUR_CHOICES.every((c) => Number(c.value) >= 1 && Number(c.value) <= 23));

  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [], sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: true } };
  store.state.health = { model: { configured: false } };
  store.state.configErrors = [];
  const view = settings.renderSettings({ sub: 'sweep', navigate() {}, rerender() {} });
  const seen = onScreen(view);
  assert.match(seen, /Check my mail every \(minutes\)/);
  assert.match(seen, /Check my mail automatically/);
  assert.doesNotMatch(seen, /re-derives|staleness|\bsweep/i, 'the staleness essay is on the Schedule card');
  assert.match(anywhere(view), /re-derives what is stale/, 'the essay is gone rather than folded');
  const selects = plainWalk(view).filter((n) => n.tag === 'select');
  assert.equal(selects.length, 2);
  assert.equal(selects[0].value, '6');
  assert.equal(selects[1].value, '23');
  assert.ok(plainWalk(selects[0]).some((o) => o.tag === 'option' && o.textContent === '6 am'));
  assert.ok(plainWalk(selects[1]).some((o) => o.tag === 'option' && o.textContent === '11 pm'));
  selects[0].value = '8';
  selects[1].value = '21';
  findButton(view, 'Save').fire('click');
  await settle();
  const saved = calls.find((c) => c.method === 'PUT' && c.path === '/api/config').body.sweep;
  assert.deepEqual(saved.activeHours, [8, 21], 'the pickers did not store the 24-hour numbers');
  assert.equal(saved.intervalMinutes, 30);
});

test('Your data shows the folder and says "drag it to the Trash"; the command is under For experts', async (t) => {
  withPlainDom(t);
  globalThis.fetch = plainFetch({});
  t.after(() => { delete globalThis.fetch; delete globalThis.window.zelos; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, home: '/Users/nemo/Library/Zelos', backend: { name: 'encrypted-file' } };
  store.state.configErrors = [];

  // In a browser tab: copy the path, and the one sentence that turns it into a window.
  delete globalThis.window.zelos;
  let view = settings.renderSettings({ sub: 'data', navigate() {}, rerender() {} });
  let seen = onScreen(view);
  assert.match(seen, /To erase everything: quit Zelos, then drag this folder to the Trash and empty the Trash\./);
  assert.match(seen, /Your saved passwords are in this folder too, encrypted\. If you back the folder up, keep the backup somewhere private\./);
  assert.doesNotMatch(seen, /rm -rf|stray web page|secrets\.enc|\.seed|JSON/, 'the expert text is on the Your data card');
  assert.match(anywhere(view), /rm -rf "\/Users\/nemo\/Library\/Zelos"/, 'the command is gone rather than folded');
  assert.match(anywhere(view), /For experts/);
  assert.ok(findButton(view, 'Copy the folder path'), 'a browser tab has no way to the folder');
  assert.ok(!findButton(view, 'Show the Zelos folder'), 'a browser tab offers a button only the desktop shell can honour');
  assert.equal(settings.folderHint('darwin'), 'In Finder press ⌘⇧G, paste, and press Return.');
  assert.match(settings.folderHint('win32'), /File Explorer/);
  assert.match(settings.folderHint('linux'), /Ctrl\+L/);

  // In the desktop shell: the button, through the one bridge the preload exposes.
  let shown = 0;
  globalThis.window.zelos = { desktop: true, platform: 'darwin', showHome: async () => { shown += 1; return true; } };
  view = settings.renderSettings({ sub: 'data', navigate() {}, rerender() {} });
  const show = findButton(view, 'Show the Zelos folder');
  assert.ok(show, 'the desktop shell has no "Show the Zelos folder" button');
  show.fire('click');
  await settle();
  assert.equal(shown, 1, 'the button did not ask the shell');
  assert.doesNotMatch(onScreen(view), JARGON, `the Your data card: ${onScreen(view).match(JARGON)?.[0]}`);

  // The keychain stores say where the passwords are instead, in the same register.
  assert.match(settings.plainSecretNotes('macos-keychain').data, /not in this folder/);
  assert.doesNotMatch(settings.plainSecretNotes('macos-keychain').data, /keychain|com\.zelos/i);
  for (const name of ['encrypted-file', 'macos-keychain', undefined]) {
    assert.doesNotMatch(Object.values(settings.plainSecretNotes(name)).join(' '), JARGON, String(name));
  }
});

test('no user-facing failure names an address the person did not type, and the board speaks of checks and AIs', () => {
  // core/llm.mjs's empty-model error and core/sweep.mjs's stand-down reasons
  // reach the board's banner verbatim. Neither may interpolate the base URL.
  const llm = fs.readFileSync(path.join(ROOT, 'core/llm.mjs'), 'utf8');
  const noModel = /throw new LLMError\(('[^']*No AI has been chosen yet[^']*'), \{ address \}\)/.exec(llm);
  assert.ok(noModel, 'core/llm.mjs no longer throws the plain empty-model error with the address on the side');
  assert.ok(!/\$\{/.test(noModel[1]), 'the empty-model sentence interpolates something');
  assert.ok(!/No model selected for \$\{address\}/.test(llm), 'the old sentence naming the address is back');
  const sweep = fs.readFileSync(path.join(ROOT, 'core/sweep.mjs'), 'utf8');
  const reason = /async function modelNotReadyReason\([\s\S]*?\n\}/m.exec(sweep);
  assert.ok(reason, 'modelNotReadyReason is missing');
  assert.ok(!/\$\{model\.baseUrl\}/.test(reason[0]), 'the stand-down reason names the base URL');
  assert.match(reason[0], /'No AI has been chosen yet — open Settings → AI and pick one'/);
  assert.match(reason[0], /'No key has been saved for the AI you chose — open Settings → AI and paste one'/);
  assert.ok(!/Settings → Model/.test(reason[0]) && !/Settings → Model/.test(llm), 'a tab that is now labelled "AI" is still named "Model"');

  // The board: "check", "AI", "Promises", "Add a reminder", "Not checked yet", "More".
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  assert.match(app, /button\('Check now', \{/);
  assert.match(app, /state\.sweep\.running \? 'Checking…' : 'Check now'/);
  assert.match(app, /if \(!last\) return withAgain\('Not checked yet'\);/);
  assert.match(app, /return withAgain\(`Last checked \$\{humanDelta\(last\.ended_at \|\| last\.started_at\)\}/);
  assert.match(app, /label: 'Promises', render: renderOwed/);
  assert.match(app, /button\('Add a reminder', \{/);
  assert.match(app, /class: 'btn solid', text: 'Save' \}/);
  assert.match(app, /: 'no AI chosen yet' \}/);
  // Tokens and duration left the line for its hover title and the About panel.
  assert.ok(!/tokenNode/.test(app), 'the token line is still painted beside the header');
  assert.match(app, /parts\.node\.setAttribute\('title', title\)/, 'the duration and spend have no hover title');
  assert.match(app, /export function sweepLineTitle\(last, tokens, todayKeyStr\)[\s\S]*?sweepDetail\(last\), tokenLine\(tokens, todayKeyStr\)/);
  for (const word of ['Sweep now', 'Sweeping…', 'Never swept', "'Owed'", "'Note'", 'Keep it', 'no model yet']) {
    assert.ok(!app.includes(word), `ui/app.js still says ${word}`);
  }
  const items = fs.readFileSync(path.join(UI, 'lib/items.js'), 'utf8');
  assert.match(items, /title: 'More',\n\s+'aria-label': `More — \$\{item\.headline \|\| 'this item'\}`/, 'the ··· button has no name');
  const owed = fs.readFileSync(path.join(UI, 'views/owed.js'), 'utf8');
  assert.match(owed, /section\('Replies it wrote for you', \{/);
  assert.match(owed, /note: 'Open one in your email program, check it, and press send there\./);
  assert.match(owed, /button\('Copy the text', \{/);
  assert.ok(!/section\('Ready to send'/.test(owed), '"Ready to send" is back beside "never sends mail"');
  const today = fs.readFileSync(path.join(UI, 'views/today.js'), 'utf8');
  assert.match(today, /section\('Money', \{ count: money\.length, note: 'Bills and invoices found in your mail\.' \}/);
  assert.match(today, /button\('Choose an AI'/);
  assert.match(today, /button\('Check now'/);
  const now = fs.readFileSync(path.join(UI, 'views/now.js'), 'utf8');
  for (const word of ['Sweep now', 'Sweep again', 'Choose a model', 'Connect a source', 'The last sweep', 'Swept ']) {
    assert.ok(!now.includes(word), `ui/views/now.js still says ${word}`);
  }
  const storeSrc = fs.readFileSync(path.join(UI, 'lib/store.js'), 'utf8');
  for (const word of ["'Sweeping…'", "'Sweep finished'", "'Sweep failed'", "'the sweep failed'"]) {
    assert.ok(!storeSrc.includes(word), `ui/lib/store.js still says ${word}`);
  }
  assert.match(storeSrc, /message: 'Checking your mail…'/);
});

/**
 * The stragglers. The pass that put "AI" on the tab and "Check now" on the
 * button left four corners of the board still speaking the engine's language:
 * Ask said "model" three ways, Search said "the sweeps have read", the Calendar
 * said "sweep, or come back" in a hover title and "CalDAV" in its empty state,
 * and the sharing panel said "token" and "MCP" in its first sentence. This
 * renders each of those screens against the small DOM and reads what is NOT
 * folded away — including hover titles and placeholders, which a source grep
 * does not see as text. The expert's words are still there: the sharing panel
 * keeps both settings-file blocks under "For experts: connecting it".
 */
test('Search explicitly includes task history and never links inactive hits to missing board rows', async (t) => {
  withPlainDom(t);
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const search = await import(`${fileUrl(UI, 'views/search.js')}?task-history-test`);
  const calls = [];
  globalThis.fetch = async reqPath => {
    const url = new URL(reqPath, 'http://127.0.0.1');
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: url.searchParams.get('includeHistory') === '1'
      ? [{ ref: 'item:old-task', kind: 'item', title: 'Old task', excerpt: 'The retained task history.', sourceInactive: true }]
      : [] }) };
  };
  t.after(() => { delete globalThis.fetch; });
  // Even a stale board payload must not lend a historical hit a dead link.
  store.state.board = { ...store.state.board, items: [{ id: 'old-task', state: 'open', bucket: 'now' }], events: [] };
  const view = search.renderSearch({ navigate() {} });
  const field = findInput(view, n => n.attributes.type === 'search');
  const form = plainWalk(view).find(n => n.tag === 'form');
  field.value = 'task';
  form.fire('submit');
  await settle();
  assert.equal(calls[0].searchParams.has('includeHistory'), false);
  const history = findInput(view, n => n.attributes.type === 'checkbox');
  assert.ok(history, 'the retained task history must be reachable');
  history.checked = true;
  history.fire('change');
  await settle();
  assert.equal(calls.at(-1).searchParams.get('includeHistory'), '1');
  assert.match(onScreen(view), /Old task.*retained task history.*No longer in task selection/);
  assert.equal(findButton(view, 'Open on the board'), undefined);
  history.checked = false;
  history.fire('change');
  await settle();
  assert.equal(calls.at(-1).searchParams.has('includeHistory'), false);
  assert.doesNotMatch(onScreen(view), /Old task/);
});

test('Ask labels a response cut short by its answer limit and keeps that notice out of Copy', async (t) => {
  withPlainDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const ask = await import(`${fileUrl(UI, 'views/ask.js')}?answer-limit-test`);
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => { copied = text; } } }, configurable: true });
  t.after(() => {
    delete globalThis.fetch;
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator); else delete globalThis.navigator;
  });
  let stopReason = 'length';
  globalThis.fetch = async reqPath => {
    assert.equal(reqPath, '/api/ask');
    return new Response(`event: sources\ndata: ${JSON.stringify([{ ref: 'msg:old-task', kind: 'message', title: 'Old task', sourceInactive: true }, { ref: 'msg:current', kind: 'message', title: 'Current mail', sourceInactive: false }])}\n\nevent: delta\ndata: ${JSON.stringify({ text: 'The reply so far' })}\n\nevent: done\ndata: ${JSON.stringify({ stopReason })}\n\n`);
  };
  store.state.health = { model: { configured: true } };
  const view = ask.renderAsk({ navigate() {} });
  const field = findInput(view, n => n.attributes['aria-label'] === 'Your question');
  const form = plainWalk(view).find(n => n.tag === 'form');
  field.value = 'What happened?';
  form.fire('submit');
  await settle();
  const exchange = plainWalk(view).find(n => n.attributes.class === 'exchange');
  const answer = plainWalk(exchange).find(n => n.attributes.class === 'answer');
  const note = plainWalk(exchange).find(n => n.attributes.class === 'exchange-note-slot');
  const sources = plainWalk(exchange).find(n => n.attributes.class === 'sources-slot');
  assert.equal((textOf(sources).match(/No longer in task selection/g) || []).length, 1, 'historical task evidence must be visibly labelled separately from current mail');
  assert.equal(textOf(answer), 'The reply so far');
  assert.match(textOf(note), /answer limit.*may be incomplete/);
  assert.equal(answer.attributes['aria-busy'], 'false');
  // Reflect the real DOM's descendant textContent for the clipboard read.
  Object.defineProperty(answer, 'textContent', { get: () => answer.children.map(textOf).join('') });
  findButton(exchange, 'Copy').fire('click');
  await settle();
  assert.equal(copied, 'The reply so far');
  assert.equal(findButton(view, 'Ask').disabled, false);

  stopReason = 'stop';
  field.value = 'And next?';
  form.fire('submit');
  await settle();
  const next = plainWalk(view).find(n => n.attributes.class === 'exchange');
  assert.equal(textOf(plainWalk(next).find(n => n.attributes.class === 'exchange-note-slot')), '', 'a normal answer must not get the warning');
});

test('Ask, Search, the Calendar and the sharing panel meet a first-timer without a word from the engine', async (t) => {
  withPlainDom(t);
  const STRAGGLERS = /IMAP|CalDAV|endpoint|keychain|config\.json|MCP|token|model\b|sweep/i;
  const base = plainFetch({ presets: await llmPresets(), manifests: await connectorManifests() });
  // The sharing panel, switched on, with one key, one line in its log and a
  // real install path — every row type it can draw, drawn.
  const aiPayload = {
    enabled: true,
    scopes: { board: true, 'mail.bodies': true },
    effectiveScopes: { board: true, 'mail.metadata': true, 'mail.bodies': true },
    maxRows: 50,
    tokens: [{ id: 't_9f3a1c', label: 'Claude Desktop', createdAt: '2026-08-20T09:00:00Z', lastUsedAt: '2026-08-22T09:00:00Z' }],
    access: [{ at: '2026-08-22T09:00:00Z', tool: 'zelos_board', scope: 'board', rows: 4, ok: true, label: 'Claude Desktop' }],
    accessMore: false,
    accessMax: 500,
    client: { command: '/usr/local/bin/node', args: ['/opt/zelos/bin/zelos', 'mcp'], home: '/tmp/zelos-home', httpUrl: 'http://127.0.0.1:7777/api/mcp' },
    scopeInfo: [
      { id: 'board', label: 'Board', summary: 'Items.', tools: ['zelos_board', 'zelos_item'] },
      { id: 'calendar', label: 'Calendar', summary: 'Events.', tools: ['zelos_calendar'] },
      { id: 'mail.metadata', label: 'Mail, without the mail', summary: 'Headers.', tools: ['zelos_search', 'zelos_thread'] },
      { id: 'mail.bodies', label: 'Mail, in full', summary: 'Bodies.', tools: [], implies: ['mail.metadata'], sensitive: true },
      { id: 'drafts', label: 'Drafts', summary: 'Drafts.', tools: ['zelos_drafts'] },
      { id: 'people', label: 'People', summary: 'People.', tools: ['zelos_people'] },
    ],
  };
  globalThis.fetch = async (reqPath, init = {}) => {
    if (reqPath === '/api/ai' || reqPath.startsWith('/api/ai?')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(aiPayload) };
    }
    return base(reqPath, init);
  };
  t.after(() => { delete globalThis.fetch; });

  const store = await import(fileUrl(UI, 'lib/store.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, backend: { name: 'encrypted-file' } };
  store.state.secretRefs = [];
  // A served window of one day, so both calendar arrows are at the edge and
  // wear the hover title that used to say "a sweep moves the window".
  const today = new Date().toISOString().slice(0, 10);
  store.state.board = { ...store.state.board, items: [], events: [], notes: [], counts: {}, runs: {}, eventWindow: { from: today, to: today } };
  const ctx = { navigate() {}, rerender() {}, sub: null, tz: 'UTC' };
  const explain = (name, seen) => `${name}: "${seen.match(STRAGGLERS)?.[0]}" is on screen — in: ${seen.slice(Math.max(0, seen.search(STRAGGLERS) - 60), seen.search(STRAGGLERS) + 60)}`;

  // Ask, with no AI chosen: the empty state that sends people to Settings.
  const ask = await import(fileUrl(UI, 'views/ask.js'));
  let seen = onScreen(ask.renderAsk(ctx));
  assert.match(seen, /Ask needs an AI/);
  assert.match(seen, /Questions are answered by the AI you choose/);
  assert.ok(findButton(ask.renderAsk(ctx), 'Choose an AI'), 'the empty state does not offer "Choose an AI"');
  assert.doesNotMatch(seen, STRAGGLERS, explain('Ask, empty', seen));
  // And with one: the page itself, lede and form.
  store.state.health = { model: { configured: true }, backend: { name: 'encrypted-file' } };
  seen = onScreen(ask.renderAsk(ctx));
  assert.match(seen, /Ask about your own mail, calendar and notes/);
  assert.doesNotMatch(seen, STRAGGLERS, explain('Ask', seen));
  // The one sentence the page says when the server answers 409 is not
  // reachable without a server, so it is read off the source.
  const askSrc = fs.readFileSync(path.join(UI, 'views/ask.js'), 'utf8');
  assert.match(askSrc, /'No AI has been chosen yet\. Pick one under Settings → AI and ask again\.'/);
  for (const word of ["'Ask needs a model'", "'Choose a model'", 'the model stopped answering', 'The model returned nothing', 'before the model said anything']) {
    assert.ok(!askSrc.includes(word), `ui/views/ask.js still says ${word}`);
  }

  // Search, before anyone has typed.
  const search = await import(fileUrl(UI, 'views/search.js'));
  seen = onScreen(search.renderSearch(ctx));
  assert.match(seen, /Nothing searched yet/);
  assert.match(seen, /Everything Zelos has read is in here/);
  assert.doesNotMatch(seen, STRAGGLERS, explain('Search', seen));
  const searchSrc = fs.readFileSync(path.join(UI, 'views/search.js'), 'utf8');
  assert.match(searchSrc, /detail: 'Zelos can only find what it has read\. /, 'the no-match state still blames "the index" and "the sweeps"');
  assert.ok(!searchSrc.includes('the sweeps have read'), 'ui/views/search.js still says "the sweeps have read"');

  // The Calendar, with nothing connected: the empty state, plus the toolbar
  // whose arrows carry a hover title at the served edge.
  const calendar = await import(fileUrl(UI, 'views/calendar.js'));
  const calView = calendar.renderCalendar(ctx);
  seen = onScreen(calView);
  assert.match(seen, /No calendar connected/);
  assert.match(seen, /a check moves the window/, 'the arrows at the edge of the window carry no title');
  assert.doesNotMatch(seen, STRAGGLERS, explain('Calendar', seen));
  const calSrc = fs.readFileSync(path.join(UI, 'views/calendar.js'), 'utf8');
  assert.match(calSrc, /const NOT_LOADED_TITLE =\n\s+'Zelos has not loaded this day\. The board carries a window around today; check your mail, or come back when it has moved\.'/);
  assert.ok(!calSrc.includes('sweep, or come back'), 'ui/views/calendar.js still says "sweep, or come back"');

  // The sharing panel, as Settings shows it: the one-line warning first, then
  // the panel once it has read its own state.
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const access = await import(fileUrl(UI, 'views/ai-access.js'));
  const panel = access.aiAccessPanel();
  await settle();
  seen = onScreen(panel);
  assert.match(seen, /If you already use another AI program, such as Claude, you can let it read what Zelos has collected\. It is off unless you switch it on\./);
  assert.match(seen, /Sharing is on/);
  assert.ok(findButton(panel, 'Create a key for that program'), 'no "Create a key for that program" button');
  assert.ok(!findButton(panel, 'Mint a token'), '"Mint a token" is still the button');
  assert.match(seen, /The most exposing choice/, 'the marker on full message text is gone');
  assert.doesNotMatch(seen, /THE MOST EXPOSING CHOICE/, 'the marker shouts');
  assert.doesNotMatch(seen, STRAGGLERS, explain('Sharing', seen));
  // The expert's blocks are folded, not deleted: one press and the settings
  // file is there, protocol and all.
  const expert = findButtons(panel, /For experts: connecting it$/).find((b) => !plainHidden(b));
  assert.ok(expert, 'no "For experts: connecting it" drawer');
  assert.match(anywhere(panel), /"mcpServers"/, 'the settings-file block is gone rather than folded');
  assert.match(anywhere(panel), /Any MCP client, over HTTP/, 'the HTTP block is gone rather than folded');
  assert.doesNotMatch(seen, /"mcpServers"|claude_desktop_config\.json/, 'the settings-file block is on screen before anyone asked');
  expert.fire('click');
  assert.match(onScreen(panel), /"mcpServers"/, 'the drawer does not open');
  assert.match(onScreen(panel), /claude_desktop_config\.json/, 'the drawer does not show the path');
  // Settings still puts its own warning above the panel, in the same words.
  const settingsSrc = fs.readFileSync(path.join(UI, 'views/settings.js'), 'utf8');
  assert.match(settingsSrc, /This is NOT where you choose the AI that reads your mail — that is under AI\./);
  assert.equal(typeof settings.fold, 'function');
  // The uppercase was the stylesheet's: the marker is sentence case in the
  // markup and the rule that shouted it is gone.
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  const mark = /^\.scope-mark \{([^}]*)\}/m.exec(css);
  assert.ok(mark, '.scope-mark rule is missing');
  assert.ok(!/text-transform: uppercase/.test(mark[1]), '.scope-mark still shouts');
});

/* ------------------------------------------------ 8. "Stuck? Ask Claude" */

/**
 * One quiet line under every setup screen: "Stuck? Ask Claude to walk me
 * through this · or ChatGPT · Copy this message". The two links open a chat
 * with a message the server wrote about that exact screen; this test drives
 * every screen the line is meant to be on and reads the line back — which
 * step it asked the server about, that the links are https in a new tab
 * (what desktop/guard.js hands to the system browser), that Copy exists and
 * falls back to a visible box when the clipboard is refused — and, the one
 * that matters, that nothing the page sends to /api/help carries the address
 * the person typed. The provider goes by its NAME; the address stays in the
 * box it was typed into.
 */
test('"Stuck? Ask Claude" sits under every setup screen, names the step, links https in a new tab, and never sends the address', async (t) => {
  withPlainDom(t);
  const calls = [];
  globalThis.fetch = plainFetch({ presets: await llmPresets(), manifests: await connectorManifests(), guesses: GUESSES, calls });
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const onboarding = await import(fileUrl(UI, 'views/onboarding.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const now = await import(fileUrl(UI, 'views/now.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [], sweep: { intervalMinutes: 30, activeHours: [6, 23], auto: true }, privacy: { sendBodies: true, bodyChars: 4000, maxItemsPerSweep: 150 } };
  store.state.health = { model: { configured: false }, home: '/tmp/zelos-home', backend: { name: 'encrypted-file' } };
  store.state.secretRefs = [];
  store.state.configErrors = [];
  store.state.board = { items: [], events: [], notes: [], counts: {}, runs: {}, first: null, tokens: null };

  const helpCalls = () => calls.filter((c) => c.path === '/api/help');
  const helpOn = (root) => plainWalk(root).filter((n) => n.dataset?.helpStep && !plainHidden(n));
  /** The one visible line on a screen, checked for its step, its links and its button. */
  const expectHelp = async (root, step, where, { provider = undefined } = {}) => {
    await settle();
    const shown = helpOn(root);
    assert.equal(shown.length, 1, `${where}: ${shown.length} help lines on screen (${shown.map((n) => n.dataset.helpStep).join(', ')})`);
    const line = shown[0];
    assert.equal(line.dataset.helpStep, step, `${where}: the line is about the wrong step`);
    assert.match(textOf(line), /Stuck\? Ask Claude to walk me through this · or ChatGPT · Copy this message/, `${where}: the line does not read as one line`);
    const links = plainWalk(line).filter((n) => n.tag === 'a');
    assert.equal(links.length, 2, `${where}: two links expected`);
    assert.equal(textOf(links[0]), 'Ask Claude to walk me through this');
    assert.equal(textOf(links[1]), 'ChatGPT');
    for (const a of links) {
      assert.match(a.attributes.href || '', /^https:\/\//, `${where}: ${textOf(a)} is not an https link — ${a.attributes.href}`);
      assert.equal(a.attributes.target, '_blank', `${where}: ${textOf(a)} opens in this window`);
      assert.equal(a.attributes.rel, 'noopener noreferrer', `${where}: ${textOf(a)} leaks an opener`);
    }
    assert.ok(findButton(line, 'Copy this message'), `${where}: no Copy button`);
    assert.doesNotMatch(onScreen(line), JARGON, `${where}: ${onScreen(line).match(JARGON)?.[0]}`);
    // What the page asked the server: the step, and the provider by name when one is known.
    const asked = helpCalls().find((c) => c.body.step === step && (provider === undefined || c.body.provider === provider));
    assert.ok(asked, `${where}: the page never asked /api/help about ${step}${provider === undefined ? '' : ` for ${provider}`} — asked: ${JSON.stringify(helpCalls().map((c) => c.body))}`);
    assert.equal(asked.method, 'POST', `${where}: the ask is not a POST`);
    return line;
  };

  // Onboarding, step by step.
  let view = null;
  const ctx = { navigate() {}, rerender() { view = onboarding.renderOnboarding(ctx); } };
  ctx.rerender();
  const stepButton = (n) => plainWalk(view).filter((b) => b.tag === 'button' && (b.attributes.class || '').includes('ob-step-btn'))[n - 1];
  const goTo = (n) => { stepButton(n).fire('click'); };

  await expectHelp(view, 'general', 'Welcome');

  goTo(2);
  await expectHelp(view, 'ai', 'AI step', { provider: null });
  findButtons(view, /^Claude, by Anthropic/)[0].fire('click');
  await expectHelp(view, 'ai', 'AI step, Claude chosen', { provider: 'Claude' });

  goTo(3);
  await expectHelp(view, 'email', 'Email step', { provider: null });
  findButton(view, 'Add an email account').fire('click');
  await expectHelp(view, 'email', 'Email step, form open', { provider: null });
  const emailInput = findInput(view, (n) => n.attributes.type === 'email');
  for (const [address, name] of [['frank@gmail.com', 'Gmail'], ['frank@hotmail.com', 'Outlook / Microsoft'], ['frank@icloud.com', 'iCloud Mail']]) {
    emailInput.value = address;
    emailInput.fire('change');
    await settle();
    await expectHelp(view, 'email', `Email step, ${address}`, { provider: name });
  }
  // The Hotmail ask carries what the guess said about the sign-in, and no more.
  const hotmail = helpCalls().find((c) => c.body.provider === 'Outlook / Microsoft');
  assert.deepEqual(hotmail.body, { step: 'email', provider: 'Outlook / Microsoft', signIn: 'microsoft', clientReady: false });

  goTo(4);
  await expectHelp(view, 'calendar', 'Calendar step', { provider: null });
  findButtons(view, /^iPhone or Mac/)[0].fire('click');
  await expectHelp(view, 'calendar', 'Calendar step, iCloud chosen', { provider: 'icloud' });
  findButtons(view, /^Something else/)[0].fire('click');
  await expectHelp(view, 'calendar', 'Calendar step, Something else', { provider: null });

  goTo(5);
  await expectHelp(view, 'first-check', 'Done step');
  goTo(1);

  // Settings: the three panels carry the same line.
  await expectHelp(settings.renderSettings({ sub: 'model', navigate() {}, rerender() {} }), 'ai', 'Settings › AI');
  await expectHelp(settings.renderSettings({ sub: 'mail', navigate() {}, rerender() {} }), 'email', 'Settings › Email');
  await expectHelp(settings.renderSettings({ sub: 'calendars', navigate() {}, rerender() {} }), 'calendar', 'Settings › Calendars');
  // And not the ones that are not setup screens.
  for (const sub of ['you', 'sweep', 'privacy', 'data', 'about', 'appearance']) {
    const panel = settings.renderSettings({ sub, navigate() {}, rerender() {} });
    await settle();
    assert.equal(helpOn(panel).length, 0, `Settings › ${sub} carries a help line it has no screen for`);
  }

  // The board with no AI: the empty state offers the AI step.
  const board = now.renderNow({ navigate() {}, rerender() {}, tz: 'UTC' });
  assert.ok(findButton(board, 'Choose an AI'), 'the empty state lost its button');
  await expectHelp(board, 'ai', 'Now, no AI yet');

  // PRIVACY: nothing the page sent to /api/help carries an address, a path, or a password.
  assert.ok(helpCalls().length >= 8, `only ${helpCalls().length} asks — the sweep is broken`);
  for (const c of helpCalls()) {
    const wire = JSON.stringify(c.body);
    assert.doesNotMatch(wire, /@/, `an address went to /api/help: ${wire}`);
    assert.doesNotMatch(wire, /frank|hotmail\.com|gmail\.com|icloud\.com/, `the typed address's parts went to /api/help: ${wire}`);
    assert.deepEqual(Object.keys(c.body).sort(), ['clientReady', 'provider', 'signIn', 'step'], `the ask carries more than the four fields: ${wire}`);
  }
  // And ui/ names neither chat host: the links are the server's, like every outbound address on these screens.
  for (const file of ['views/settings.js', 'views/onboarding.js', 'views/now.js', 'lib/api.js']) {
    const src = fs.readFileSync(path.join(UI, file), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      assert.doesNotMatch(line, /claude\.ai|chatgpt\.com/, `${file}:${i + 1} names a chat host`);
    }
  }
});

test('"Copy this message" copies the server\'s message, says so, and shows the message in a box when the clipboard is refused', async (t) => {
  withPlainDom(t);
  const calls = [];
  globalThis.fetch = plainFetch({ calls });
  t.after(() => { delete globalThis.fetch; });
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  const expected = helpAnswer({ step: 'first-check' }).prompt;

  // A browser whose clipboard takes the text.
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied = null;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { copied = text; } } }, configurable: true, writable: true });
  t.after(() => { if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator); else delete globalThis.navigator; });

  const line = settings.askClaude({ step: 'first-check' });
  await settle();
  const box = findInput(line, (n) => n.tag === 'textarea');
  assert.ok(box, 'no box for the message');
  assert.ok(plainHidden(box), 'the box is on screen before the clipboard has been refused');
  findButton(line, 'Copy this message').fire('click');
  await settle();
  assert.equal(copied, expected, 'the clipboard did not get the server\'s message');
  assert.match(onScreen(line), /Copied\. Paste it into the chat\./);
  assert.ok(plainHidden(box), 'the box opened although the clipboard took the text');
  assert.doesNotMatch(onScreen(line), JARGON, onScreen(line).match(JARGON)?.[0]);

  // A browser whose clipboard refuses: the message in a box the person can select.
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } }, configurable: true, writable: true });
  const refused = settings.askClaude({ step: 'first-check' });
  await settle();
  findButton(refused, 'Copy this message').fire('click');
  await settle();
  const shown = findInput(refused, (n) => n.tag === 'textarea');
  assert.ok(!plainHidden(shown), 'the clipboard was refused and no box appeared');
  assert.equal(shown.value, expected, 'the box does not hold the message');
  assert.equal(shown.attributes.readonly, '', 'the box is editable');
  assert.match(onScreen(refused), /Select the text below and copy it\./);
  assert.doesNotMatch(onScreen(refused), /Copied/, 'the page claims a copy that did not happen');

  // A server without the route: the line removes itself rather than offering a dead link.
  globalThis.fetch = async (reqPath, init = {}) => {
    if (reqPath === '/api/help') return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
    return plainFetch({ calls })(reqPath, init);
  };
  const gone = settings.askClaude({ step: 'general' });
  await settle();
  assert.equal(gone.hidden, true, 'a 404 left a line with no links on screen');
});

/* ------------------------------------------------- 9. the chrome tells the truth */

/**
 * Four quality-of-life claims, each pinned where it can rot: the header's
 * check line must speak from STORED runs and the scheduler (not from whatever
 * is still in memory), "new since the last check" must come from stored
 * timestamps and never from the model's wording, About must mean "today" when
 * it says today, and Your data must count what the folder actually holds.
 */

test('the words for the next check come from the scheduler, in plain words or not at all', async () => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  // No scheduler block — an older server, or health not loaded — is no claim.
  assert.equal(store.checkAgainLine(null), '');
  assert.equal(store.checkAgainLine(undefined), '');
  assert.equal(store.checkAgainLine('soon'), '');
  // Auto off beats a leftover target time: the off switch is the truth.
  assert.equal(store.checkAgainLine({ auto: false, nextRunAt: '2026-08-28T14:40:00-04:00' }), 'automatic checks are off');
  assert.equal(store.checkAgainLine({ auto: true, nextRunAt: '2026-08-28T14:40:00-04:00' }), 'checks again around 2:40 PM');
  // Auto on but no armed target (a one-shot server) makes no promise.
  assert.equal(store.checkAgainLine({ auto: true, nextRunAt: null }), '');
});

test('the check line reads the stored run: a failure survives a reload, a quick look says so', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const text = /export function sweepLineText\([\s\S]*?\n\}/m.exec(app);
  assert.ok(text, 'sweepLineText is missing');
  // The in-memory error dies with the tab; the stored run does not. After a
  // reload a failed check must still say so, and point at the details.
  assert.match(text[0], /last\.ok === false/, 'the line never consults the stored run');
  assert.match(text[0], /The last check failed — details on Now/);
  // A light run reads far less than a full one, and "Last checked 2h ago"
  // over one quietly overstates how much was read.
  assert.match(text[0], /last\.kind === 'light'/);
  assert.match(text[0], /quick look/);
  // The next check is stated from the scheduler, never invented.
  assert.match(text[0], /checkAgainLine\(/);
  // The one-paint finished note is what a check ends on.
  assert.match(text[0], /s\.finished/);

  const paint = /function paintSweepLine\(parts\)[\s\S]*?\n\}/m.exec(app);
  assert.ok(paint, 'paintSweepLine is missing');
  assert.match(paint[0], /state\.health\?\.scheduler/, 'the paint never hands the line the scheduler');
  assert.match(paint[0], /last\?\.ok === false/, 'a stored failure must get the bad styling, not only a live one');
  assert.match(paint[0], /finished: null/, 'the finished note must last one paint, not forever');
});

test('"new since the last check" is derived from stored timestamps, never the model\'s wording', async () => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const items = [
    { id: 'old', bucket: 'now', state: 'open', first_seen: '2026-08-28T08:00:00-04:00' },
    { id: 'fresh', bucket: 'today', state: 'open', first_seen: '2026-08-28T12:00:30-04:00' },
    { id: 'ticked', bucket: 'now', state: 'done', first_seen: '2026-08-28T12:00:40-04:00' },
    { id: 'undated', bucket: 'now', state: 'open' },
  ];
  const run = (ok) => ({ id: 'run_1', kind: 'full', ok, started_at: '2026-08-28T12:00:00-04:00' });

  store.state.board = { ...store.state.board, items, runs: { last: run(true) } };
  assert.deepEqual(store.newSinceLastCheck().map((i) => i.id), ['fresh'],
    'new is: open, and first seen at or after the last successful run started');
  store.state.board = { ...store.state.board, runs: { last: run(false) } };
  assert.deepEqual(store.newSinceLastCheck(), [], 'a failed run marks nothing');
  store.state.board = { ...store.state.board, runs: { last: null } };
  assert.deepEqual(store.newSinceLastCheck(), [], 'no run at all marks nothing');
  store.state.board = { ...store.state.board, runs: { last: { ...run(true), started_at: 'nonsense' } } };
  assert.deepEqual(store.newSinceLastCheck(), [], 'an unreadable run timestamp marks nothing');

  // The done branch says what the check found — counted from the rule above,
  // and only when there was a prior successful run to compare against.
  const src = fs.readFileSync(path.join(UI, 'lib/store.js'), 'utf8');
  const done = /\} else if \(event === 'done'\) \{[\s\S]*?(?=\} else if \(event === 'failed'\))/m.exec(src);
  assert.ok(done, 'the done branch of watchSweeps is missing');
  assert.match(done[0], /newSinceLastCheck\(\)/, 'the count must come from the one derivation');
  assert.match(done[0], /nothing new/);
  assert.match(done[0], /new thing/);
  assert.ok(done[0].indexOf('runs?.last') < done[0].indexOf('refreshBoard('),
    'whether a prior successful run exists must be read BEFORE the refresh replaces it');
});

test('About says "AI usage today" and means it: a stale counter reads as quiet, not as spend', async (t) => {
  withPlainDom(t);
  globalThis.fetch = plainFetch({ presets: await llmPresets() });
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, home: '/tmp/zelos-home', backend: { name: 'encrypted-file' } };
  store.state.configErrors = [];

  const lifetime = { tokensIn: 84_000, tokensOut: 9_100, runs: 40, modelRuns: 17 };
  const boardWith = (tokens) => {
    store.state.board = { items: [], events: [], notes: [], counts: {}, runs: {}, tokens, now: '2026-08-28T10:00:00-04:00' };
    store.state.boardAt = Date.now();
  };
  const aboutText = () => onScreen(settings.renderSettings({ sub: 'about', navigate() {}, rerender() {} }));

  // Today's counter: the spend, how often the AI was asked to think, and the
  // running total since the start — with the no-price stance intact.
  boardWith({ day: '2026-08-28', tokensIn: 12_400, tokensOut: 1_120, runs: 9, modelRuns: 3, lifetime });
  let seen = aboutText();
  assert.match(seen, /AI usage today/);
  assert.doesNotMatch(seen, /AI usage this session/, 'the label still claims a session');
  assert.match(seen, /12k tokens in · 1\.1k out/);
  assert.match(seen, /asked to think 3 times/);
  assert.match(seen, /84k tokens in · 9\.1k out/);
  assert.match(seen, /asked to think 17 times/);
  assert.match(seen, /What that costs depends on your AI service’s prices; Zelos does not see them\./);
  assert.doesNotMatch(seen, /[$€£]/, 'a price was invented');

  // Yesterday's counter on an untouched machine: today is quiet and says so,
  // while the lifetime totals — which no day can stale — stay.
  boardWith({ day: '2026-08-27', tokensIn: 500, tokensOut: 20, runs: 2, modelRuns: 1, lifetime });
  seen = aboutText();
  assert.match(seen, /Nothing sent to the AI yet today\./);
  assert.doesNotMatch(seen, /500 tokens in/, 'yesterday\'s spend renders as current');
  assert.doesNotMatch(seen, /asked to think 1 time\b/, 'yesterday\'s checks render as today\'s');
  assert.match(seen, /84k tokens in · 9\.1k out/);

  // No counter at all — a database from before the counter existed.
  boardWith(null);
  seen = aboutText();
  assert.match(seen, /Nothing sent to the AI yet today\./);
  assert.doesNotMatch(seen, /asked to think/);
});

test('Now folds "Finished recently" at the very bottom, and the tick on a done row reopens it', async (t) => {
  withPlainDom(t);
  const calls = [];
  globalThis.fetch = async (reqPath, init = {}) => {
    calls.push({ method: init.method || 'GET', path: reqPath, body: init.body ? JSON.parse(init.body) : null });
    if (reqPath.startsWith('/api/items/')) return { ok: true, status: 200, text: async () => '{}' };
    if (reqPath === '/api/state') return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], events: [], notes: [], counts: {}, runs: {} }) };
    return { ok: false, status: 404, text: async () => '{"error":"not found"}' };
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const now = await import(fileUrl(UI, 'views/now.js'));

  store.state.config = { identity: {}, model: { label: 'Claude' }, mail: [{ id: 'm1' }], calendars: [], sources: [] };
  store.state.health = { model: { configured: true, label: 'Claude' } };
  store.state.sweep = { running: false, phase: '', message: '', done: 0, total: 0, error: null, lastResult: null };
  store.state.board = {
    ...store.state.board,
    items: [{ id: 'a', bucket: 'now', state: 'open', headline: 'Pay the invoice' }],
    counts: { now: 1, today: 0, soon: 0, waiting: 0, promised: 0, note: 0, money: 0 },
    events: [],
    drafts: [],
    notes: [],
    runs: { last: { id: 'run_1', kind: 'full', ok: true, started_at: '2026-08-28T09:00:00-04:00', ended_at: '2026-08-28T09:01:00-04:00', stats: {} } },
    first: 'a',
    now: '2026-08-28T10:00:00-04:00',
    finished: [
      { id: 'f1', bucket: 'now', state: 'done', headline: 'Sent the survey', state_at: '2026-08-28T09:30:00-04:00' },
      { id: 'f2', bucket: 'today', state: 'dismissed', headline: 'The newsletter', state_at: '2026-08-28T08:00:00-04:00' },
    ],
  };
  store.state.boardAt = Date.now();

  const view = now.renderNow({ tz: 'America/New_York', navigate() {} });
  const fold = plainWalk(view).find((n) => n.tag === 'section' && (n.attributes.class || '').includes('is-finished'));
  assert.ok(fold, 'no Finished recently section');
  const toggle = plainWalk(fold).find((n) => n.tag === 'button' && textOf(n).includes('Finished recently'));
  assert.ok(toggle, 'the fold has no toggle');
  assert.match(textOf(toggle), /2/, 'the fold does not say how many rows it holds');
  const panel = plainWalk(fold).find((n) => (n.attributes.class || '').includes('worth-body'));
  assert.ok(panel, 'the fold has no body');
  assert.ok('hidden' in panel.attributes, 'the section must start folded');
  assert.match(anywhere(panel), /Sent the survey/);
  assert.match(anywhere(panel), /The newsletter/);
  // ...and the last section on the page: what you finished sits below even the snoozed.
  assert.equal(view.children[view.children.length - 1], fold, 'Finished recently is not the last thing on Now');

  toggle.fire('click');
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.equal(panel.hidden, false, 'opening the fold did not reveal the rows');

  // The way back: the done row's tick is already a reopen button.
  const tick = plainWalk(fold).find((n) => n.tag === 'button' && n.attributes.role === 'checkbox' && n.attributes['aria-checked'] === 'true');
  assert.ok(tick, 'the done row lost its tick');
  tick.fire('click');
  await settle();
  const posted = calls.find((c) => c.method === 'POST' && c.path === '/api/items/f1/state');
  assert.ok(posted, 'ticking a finished row never reached the server');
  assert.deepEqual(posted.body, { state: 'open' }, 'the tick on a done row must reopen it');

  // Search keeps treating items[] as the board; the finished live beside it.
  const search = fs.readFileSync(path.join(UI, 'views/search.js'), 'utf8');
  assert.ok(!/finished/.test(search), 'search must not learn about the finished array');
  // Dimmed like the snoozed: off the board, still on the record.
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.match(css, /\.worth\.is-finished \.row \{[^}]*opacity/, 'the finished rows are not dimmed');
});

test('a board without the finished field folds nothing and breaks nothing', async (t) => {
  stubBrowserGlobals();
  const store = await import(fileUrl(UI, 'lib/store.js'));
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ items: [], events: [], notes: [], counts: {}, runs: {}, now: '2026-08-28T10:00:00-04:00' }) });
  t.after(() => { delete globalThis.fetch; });
  await store.loadBoard();
  assert.deepEqual(store.state.board.finished, [], 'an older server\'s payload must default to an empty list');
  assert.deepEqual(store.finishedItems(), []);
  store.state.board = { ...store.state.board, finished: [{ id: 'f1', state: 'done' }] };
  assert.deepEqual(store.finishedItems().map((i) => i.id), ['f1']);
  store.state.board = { ...store.state.board, finished: 'nonsense' };
  assert.deepEqual(store.finishedItems(), [], 'a malformed field is an empty list, not a crash');
});

test('Your data counts what Zelos is holding, and stands unchanged when the route is missing', async (t) => {
  withPlainDom(t);
  const data = {
    dbBytes: 320_000_000,
    walBytes: 7_000_000,
    messageCount: 2143,
    oldestMessageAt: '2026-03-04T09:12:00-05:00',
    eventCount: 480,
    itemCount: 57,
    accounts: [
      { id: 'm1', label: 'frank@gmail.com', messages: 1801 },
      { id: 'm2', label: 'the shop', messages: 342 },
    ],
  };
  globalThis.fetch = async (reqPath, init = {}) => {
    if (reqPath === '/api/data') return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    return plainFetch({})(reqPath, init);
  };
  t.after(() => { delete globalThis.fetch; });
  const store = await import(fileUrl(UI, 'lib/store.js'));
  const settings = await import(fileUrl(UI, 'views/settings.js'));
  store.state.config = { identity: {}, model: {}, mail: [], calendars: [], sources: [] };
  store.state.health = { model: { configured: false }, home: '/Users/nemo/Library/Zelos', backend: { name: 'encrypted-file' } };
  store.state.configErrors = [];

  const view = settings.renderSettings({ sub: 'data', navigate() {}, rerender() {} });
  await settle();
  const seen = onScreen(view);
  // The one line the panel exists for: exact counts, the oldest month, the size.
  assert.match(seen, /2,143 emails back to March 2026 · 312 MB on disk/);
  assert.match(seen, /480 appointments · 57 items/);
  // Per-account counts, in the account's own name.
  assert.match(seen, /frank@gmail\.com/);
  assert.match(seen, /1,801 emails/);
  assert.match(seen, /the shop/);
  assert.match(seen, /342 emails/);
  assert.doesNotMatch(seen, JARGON, `the stats block: ${seen.match(JARGON)?.[0]}`);

  // A build without the route: the panel stands, claiming nothing it cannot count.
  globalThis.fetch = async (reqPath, init = {}) => {
    if (reqPath === '/api/data') return { ok: false, status: 404, text: async () => '{"error":"not found"}' };
    return plainFetch({})(reqPath, init);
  };
  const bare = settings.renderSettings({ sub: 'data', navigate() {}, rerender() {} });
  await settle();
  assert.match(onScreen(bare), /Your board and saved history live in one folder on this computer\./);
  assert.doesNotMatch(onScreen(bare), /on disk/, 'a panel with no answer must not claim a size');
});
