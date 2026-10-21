/**
 * ui/lib/format.js — words and ordering. No DOM here.
 *
 * The vocabulary matters: `waiting` and `promised` are the model's words, and
 * neither reads as anything to a person at 8am. The board says "they owe you"
 * and "you owe them", which is the same fact in a sentence you do not decode.
 */

import {
  dayKey, daysBetweenKeys, dueInstant, formatTime, formatDay, humanDelta, instant,
  localTimezone, minutesIntoDay, toZonedISO, wallClock,
} from './time.js';

export const BUCKETS = ['now', 'today', 'soon', 'waiting', 'promised', 'note', 'money'];

export const BUCKET_LABEL = {
  now: 'Now',
  today: 'Today',
  soon: 'Soon',
  waiting: 'They owe you',
  promised: 'You owe them',
  note: 'Worth knowing',
  money: 'Money',
};

/** Short form for a chip beside a headline, where the long form would crowd. */
export const BUCKET_TAG = {
  now: 'now',
  today: 'today',
  soon: 'soon',
  waiting: 'owed to you',
  promised: 'you owe',
  note: 'note',
  money: 'money',
};

export const SEVERITY_LABEL = ['background', 'ordinary', 'pressing', 'urgent'];

export function severityOf(item) {
  const n = Number(item?.severity);
  return Number.isFinite(n) ? Math.min(3, Math.max(0, Math.round(n))) : 0;
}

/**
 * How long this has been on the board. Deliberately silent under four days:
 * a badge on everything is a badge on nothing, and the point of this one is
 * that a thing you have carried for a fortnight should feel uncomfortable.
 */
export function carriedFor(item, todayKeyStr) {
  const seen = dayKey(item?.first_seen);
  if (!seen || !todayKeyStr) return null;
  const days = daysBetweenKeys(seen, todayKeyStr);
  if (days === null || days < 4) return null;
  // "waiting", not "carried": carried where? was the audit's reaction, and the
  // fact the badge states is how long this has been waiting on you.
  if (days >= 60) return `waiting ${Math.round(days / 30)} months`;
  if (days >= 14) return `waiting ${Math.floor(days / 7)} weeks`;
  return `waiting ${days} days`;
}

/**
 * "due in 2h" / "due today" / "due Tue, Aug 11" / "" — one line, never both
 * forms at once.
 *
 * A deadline written as a bare date is a DAY, and both branches below treat it
 * as one. Counting hours to it ("due in 9h") states a precision the promise
 * never had, and — before dueInstant existed — counted them from UTC midnight,
 * so an item due today read "due 16h ago" all day long in any western zone.
 */
export function dueLabel(item, now = Date.now(), tz = localTimezone()) {
  if (!item?.due_at) return '';
  const at = dueInstant(item.due_at, tz);
  if (at === null) return '';
  if (wallClock(item.due_at)?.dateOnly) {
    const days = daysBetweenKeys(dayKey(toZonedISO(now, tz)), dayKey(item.due_at));
    if (days === 0) return 'due today';
    if (days === 1) return 'due tomorrow';
    if (days === -1) return 'due yesterday';
    return `due ${formatDay(item.due_at)}`;
  }
  const withinADay = Math.abs(at - now) < 36 * 3_600_000;
  if (withinADay) return `due ${humanDelta(item.due_at, now)}`;
  const time = formatTime(item.due_at);
  return `due ${formatDay(item.due_at)}${time ? ` · ${time}` : ''}`;
}

/** Late — which, for a bare date, means its day is over. See dueInstant. */
export function isOverdue(item, now = Date.now(), tz = localTimezone()) {
  if (!item?.due_at) return false;
  const at = dueInstant(item.due_at, tz);
  return at !== null && at < now;
}

/** Severity first, then soonest due, then longest carried. */
export function byUrgency(a, b) {
  const sev = severityOf(b) - severityOf(a);
  if (sev) return sev;
  const da = instant(a.due_at);
  const db = instant(b.due_at);
  if (da !== null && db !== null && da !== db) return da - db;
  if (da !== null && db === null) return -1;
  if (da === null && db !== null) return 1;
  const fa = instant(a.first_seen) ?? 0;
  const fb = instant(b.first_seen) ?? 0;
  return fa - fb;
}

export function personLabel(item) {
  const name = (item?.person || '').trim();
  const email = (item?.person_email || '').trim();
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} · ${email}`;
  return name || email || '';
}

/**
 * Where an item came from, from its stored kind and receipt count — never from
 * the model's prose. A three-receipt item and an unreceipted assertion used to
 * look pixel-identical, which is the opposite of how trust should price them.
 * `derived` is core/triage.mjs's word for "every cited receipt failed to
 * resolve", and it comes back flagged so the board can dress it differently:
 * it is the absence of provenance, not a variety of it. A kind this build does
 * not know makes no claim rather than a wrong one.
 */
export function sourceStamp(item) {
  const refs = Array.isArray(item?.sourceRefs) ? item.sourceRefs.length : 0;
  const count = refs > 1 ? ` (${refs})` : '';
  const kind = item?.kind;
  if (kind === 'mail') return { text: `from your mail${count}`, derived: false };
  if (kind === 'calendar') return { text: `from your calendar${count}`, derived: false };
  if (kind === 'capture') return { text: `from a note you typed${count}`, derived: false };
  if (kind === 'mixed') return { text: `from more than one place${count}`, derived: false };
  if (kind === 'derived') return { text: 'no source saved', derived: true };
  return null;
}

/**
 * Whether an open item arrived with the last check — STORED timestamps only,
 * never the model's wording, which rewrites the whole board every run. The
 * rule: the last run exists, succeeded, and the item was first seen at or
 * after the instant that run started. No successful run on record means no
 * mark at all — against a board that has only just learned to look,
 * everything would read as news.
 */
export function isNewSince(item, run) {
  if (!item || item.state !== 'open') return false;
  if (!run || run.ok !== true) return false;
  const seen = instant(item.first_seen);
  const started = instant(run.started_at);
  if (seen === null || started === null) return false;
  return seen >= started;
}

/* ------------------------------------------------------------------ events */

/** Minutes [start, end) of an event within one day-key, clamped to that day. */
export function eventSpanOnDay(event, key) {
  // A provider keeps cancelled occurrences as receipts; they occupy no time.
  if (String(event.status || '').trim().toUpperCase() === 'CANCELLED') return null;
  const startKey = dayKey(event.starts_at);
  const endKey = dayKey(event.ends_at) || startKey;
  if (!startKey) return null;
  if (key < startKey || key > endKey) return null;
  if (event.all_day) {
    // `ends_at` on an all-day event is RFC 5545's exclusive DTEND — the day
    // AFTER the last one covered (core/sources/ics.mjs keeps it that way). So
    // the end key itself is not part of the span, and a one-day holiday would
    // otherwise paint across two columns.
    if (key === endKey && key !== startKey) return null;
    return { start: 0, end: 1440, allDay: true };
  }

  let start = key === startKey ? (minutesIntoDay(event.starts_at) ?? 0) : 0;
  let end = key === endKey ? (minutesIntoDay(event.ends_at) ?? start + 60) : 1440;
  // An end at exactly midnight belongs to the previous day, not a zero-height
  // sliver at the top of the next one.
  if (key === endKey && key !== startKey && end === 0) return null;
  if (end <= start) end = Math.min(1440, start + 30);
  start = Math.max(0, Math.min(1439, start));
  end = Math.max(start + 15, Math.min(1440, end));
  return { start, end, allDay: false };
}

export function eventTimeLabel(event) {
  if (event.all_day) return 'All day';
  const from = formatTime(event.starts_at);
  const to = formatTime(event.ends_at);
  if (from && to) return `${from} – ${to}`;
  return from || to || '';
}

/**
 * Cluster-then-greedy-column packing.
 *
 * Two passes, because they answer different questions. The cluster pass finds
 * every group of chips that transitively overlap — that is what decides how many
 * columns the group is divided into, so two independent pairs of overlapping
 * events do not each get squeezed to a quarter width. The greedy pass then drops
 * each chip into the first column whose last occupant has already ended.
 *
 * Input entries: {start, end, ...}. Returns the same objects with {col, cols}.
 */
export function packColumns(entries) {
  const sorted = [...entries].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const columns = []; // columns[i] = end minute of the last chip placed there
    for (const entry of cluster) {
      let col = columns.findIndex((end) => end <= entry.start);
      if (col === -1) {
        col = columns.length;
        columns.push(entry.end);
      } else {
        columns[col] = entry.end;
      }
      entry.col = col;
    }
    for (const entry of cluster) entry.cols = columns.length;
    out.push(...cluster);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const entry of sorted) {
    if (cluster.length && entry.start >= clusterEnd) flush();
    cluster.push(entry);
    clusterEnd = Math.max(clusterEnd, entry.end);
  }
  flush();
  return out;
}

/**
 * Order a day's events so a real conflict comes ahead of every other TIMED
 * entry — the whole reason a month cell truncates is that most days are dull,
 * and the day that is not must say so in the three rows it gets.
 *
 * All-day entries are held OUT of the overlap pass and merged back at the top
 * for display. eventSpanOnDay gives an all-day event minutes 0–1440, so in the
 * pass it overlapped literally everything: one birthday flagged every event on
 * the day, the month cell painted a "clash" badge over a day where nothing
 * clashes — and, worse, the tiebreak collapsed to a constant and the sort
 * degraded to plain start order. Measured on a day holding a real double
 * booking: the three visible rows went from `REAL-CLASH-A, REAL-CLASH-B, 8am`
 * to `HOLIDAY, 8am, 9am`, so adding a holiday silently disabled the one thing
 * this function exists to do. A thing that runs all day is not a conflict with
 * anything; it is the day.
 *
 * Where the guarantee stops, said plainly, because an earlier version of this
 * comment promised more than the code does: all-day entries sort above
 * everything, and the month cell paints `MONTH_VISIBLE` rows —
 * `ui/views/calendar.js:566`, three of them — so a day carrying three or more
 * of them pushes the clashing pair behind "+N more" whatever their flags say.
 * Measured with a birthday, a holiday and a PTO day plus a 9:00/9:30 double
 * booking — visible rows `BIRTHDAY, HOLIDAY, PTO`.
 *
 * That "three" is the one number in this paragraph that belongs to another
 * file, so it is not left on trust. The test behind this boundary reads
 * MONTH_VISIBLE out of calendar.js rather than restating it — it used to carry
 * its own `const MONTH_VISIBLE = 3` beside a line number that had already
 * moved — so widening the cell to four rows turns that test red instead of
 * leaving this sentence quietly false.
 *
 * What the day does NOT do is go quiet: `monthCell` derives its `has-conflict`
 * badge from `spans.some(s => s.conflict)` over the whole day rather than over
 * the visible slice (`ui/views/calendar.js:572`), so the cell is still marked
 * and the count still invites the click. Banners at the top of a day is what
 * every calendar does, and the badge is what keeps that honest.
 */
export function conflictsFirst(entries) {
  const flagged = entries.map((e) => ({ ...e, conflict: false }));
  // filter() keeps the same objects, so flagging through `timed` flags `flagged`.
  const timed = flagged.filter((e) => !e.allDay);
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      if (timed[i].start < timed[j].end && timed[j].start < timed[i].end) {
        timed[i].conflict = true;
        timed[j].conflict = true;
      }
    }
  }
  return flagged.sort((a, b) =>
    ((b.allDay ? 1 : 0) - (a.allDay ? 1 : 0))
    || (b.conflict - a.conflict)
    || (a.start - b.start));
}

/**
 * "3 emails · 2 appointments" — the sweep's own numbers, in the words a
 * person uses for them. The run's duration is deliberately not here: "41.8s"
 * beside the counts read as a machine readout, and it lives in the hover
 * title the header gives the line (sweepDetail below) rather than on it.
 */
export function sweepSummary(run) {
  if (!run) return '';
  const s = run.stats || {};
  const bits = [];
  // Feeds, Slack, GitHub and the rest are stored as messages too, and were
  // all counted as "emails" (QA, 2026-10-10, TT-3515). A run that lists its
  // sources says how many came from email; one that does not keeps the old
  // count, which is all it has.
  const sources = Array.isArray(s.sources) ? s.sources : null;
  if (sources && s.messages) {
    const fromMail = sources.filter((x) => x?.kind === 'mail').reduce((n, x) => n + (Number(x.count) || 0), 0);
    const emails = Math.min(fromMail, s.messages);
    if (emails) bits.push(plural(emails, 'email'));
    if (s.messages > emails) bits.push(`${s.messages - emails} from other sources`);
  } else if (s.messages) bits.push(`${s.messages} email${s.messages === 1 ? '' : 's'}`);
  if (s.events) bits.push(`${s.events} appointment${s.events === 1 ? '' : 's'}`);
  if (s.items) bits.push(`${s.items} item${s.items === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/**
 * "took 41.8s" — the duration, for a tooltip, or '' when the run has none.
 * A run that died in a few milliseconds — no AI chosen, nothing fetched — is
 * not "took 0.0s"; under a tenth of a second there is nothing worth saying.
 */
export function sweepDetail(run) {
  const ms = Number(run?.stats?.ms);
  if (!Number.isFinite(ms) || ms < 100) return '';
  return `took ${(ms / 1000).toFixed(1)}s`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What "Test it" says a calendar check found. A reader that counts (a .ics
 * link, a file) says how many appointments; CalDAV does not count — it lists
 * the calendars it found — and its result has no `events`, so the line used to
 * read "Site visits: 0 appointments found" for a calendar holding two (QA,
 * 2026-10-10, TT-3456). It names the calendars Zelos will read instead, which
 * is the fact a person checking a calendar account actually needs.
 */
export function calendarTestSummary(result) {
  const calendars = Array.isArray(result?.calendars) ? result.calendars : [];
  const first = calendars[0]?.name || 'calendar';
  if (typeof result?.events === 'number') return `${first}: ${plural(result.events, 'appointment')} found.`;
  const names = calendars.map((c) => c?.name || 'a calendar without a name');
  if (!names.length) return 'Connected.';
  const shown = names.length > 5 ? [...names.slice(0, 5), `${names.length - 5} more`] : names;
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  return `Connected. Zelos will read ${plural(names.length, 'calendar')}: ${list}.`;
}

/** "1.2k" / "3.4M" — a size, not an accountancy. Under a thousand is exact. */
export function compactCount(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1_000) return String(v);
  if (v < 1_000_000) return `${(v / 1_000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0)}M`;
}

/**
 * The day's token spend, worded — or '' when there is nothing honest to say.
 *
 * Two silences are deliberate. There is no dollar figure: Zelos knows how many
 * tokens went to the model and has no idea what anyone is paying for them, and
 * a made-up price in the chrome would be the most quietly damaging number on
 * the screen. And an absent counter renders NOTHING rather than "0 tokens in" —
 * a database written before the counter existed, or a machine that has not
 * swept yet, has no spend to report, which is not the same as a spend of zero.
 *
 * The payload is read tolerantly because the sweep engine owns its shape:
 * either `{in, out}` or the run's own `{tokensIn, tokensOut}` reads correctly.
 * A counter that names the day it covers is dropped once that day is over,
 * since a rolling total is only "today's" while today is still today.
 */
export function tokenLine(tokens, todayKeyStr = null) {
  if (!tokens || typeof tokens !== 'object') return '';
  const day = typeof tokens.day === 'string' ? tokens.day : null;
  if (day && todayKeyStr && day !== todayKeyStr) return '';
  const into = Number(tokens.in ?? tokens.tokensIn ?? 0) || 0;
  const outOf = Number(tokens.out ?? tokens.tokensOut ?? 0) || 0;
  if (into <= 0 && outOf <= 0) return '';
  return `${compactCount(into)} tokens in · ${compactCount(outOf)} out`;
}
