/**
 * ui/views/calendar.js — a real time grid.
 *
 * The rule that governs every number in this file: a chip's position comes from
 * the wall-clock minutes in the event's own ISO string, read with a regex
 * (ui/lib/time.js, mirroring core/time.mjs). Passing `2026-08-11T14:00:00-04:00`
 * through `new Date()` and asking for `getHours()` re-expresses it in the
 * viewer's zone — open the same calendar on a laptop set to UTC and every chip
 * slides four hours. So Date is never consulted for placement here.
 *
 * Overlaps are packed cluster-then-greedy-column (see format.js `packColumns`),
 * and month cells show all-day entries first, then appointments in time order.
 * A day-level clash flag includes overlaps hidden behind "+4".
 *
 * The grid opens where the day is, not at 00:00: the now-line when today is on
 * screen, otherwise the first event in the range. It does that on arrival and
 * when the range moves — never on the re-render a finished sweep causes, which
 * would drag a reader back to the morning while they were looking at Thursday
 * evening.
 *
 * And the second rule, which the arrows used to break: THIS GRID IS ONLY EVER A
 * VIEW OF ONE WINDOW. `/api/state` serves the events around today and says so in
 * `eventWindow`; there is no route that fetches another range, and nothing here
 * refetches. So ‹ and › stop at the served edge, and any day inside a range that
 * the window does not cover is drawn as unserved rather than as free. Without
 * that the calendar answered questions it had not been given the data for:
 * measured 2026-08-10, November drew 35 fully styled empty cells, October drew
 * 22, and August's own grid — which begins 2026-07-26 — drew eight, for days
 * whose events were sitting in the local database the whole time.
 */

import { el, button, meander } from '../lib/dom.js';
import { emptyState } from '../lib/items.js';
import {
  dayKey, addDaysToKey, startOfWeekKey, weekdayOfKey, dayName, monthName, formatTime,
} from '../lib/time.js';
import { eventSpanOnDay, eventTimeLabel, packColumns, conflictsFirst } from '../lib/format.js';
import { state, nowMark, eventWindow, dayIsLoaded } from '../lib/store.js';

const MODES = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
];

/**
 * View state survives re-renders; it is a place you are looking, not data.
 * A phone opens on Day: seven columns in 375px is a grid you can see but not
 * read, and Week is one tap away.
 */
const view = {
  // Both optional calls matter: a browser without matchMedia, and a test runner
  // whose window stub has no layout engine behind it, must both land on 'week'
  // rather than throwing before this module has finished loading.
  mode: window.matchMedia?.('(min-width: 48rem)')?.matches === false ? 'day' : 'week',
  anchor: null,
};

/** Where the grid scrolls to when there is nothing better to aim at — 7am. */
const DEFAULT_SCROLL_HOUR = 7;
const MIN_CHIP_MINUTES = 22;

/**
 * How far above the opening target the grid starts.
 *
 * The two targets want different margins. The now-line keeps two hours of the
 * morning above it, because what just happened is usually why the calendar was
 * opened at all. A first event only needs enough room that it is not welded to
 * the top edge, where it reads as a header rather than as the first thing in
 * the day.
 */
const NOW_MARGIN_MINUTES = 120;
const EVENT_MARGIN_MINUTES = 45;

/**
 * The opening scroll position, in minutes from midnight.
 *
 * `nowMinutes` is passed only when today is actually one of the days on screen;
 * a week in March has a now-line nowhere in it, and aiming at 14:20 of a week
 * that has no today is aiming at nothing. `firstEventMinutes` is the earliest
 * timed event anywhere in the range, so a quiet Tuesday opens on the 10am that
 * is the only thing in it rather than on the empty small hours above it.
 * With neither — an empty range, or a range with only all-day entries — the
 * working day is the honest guess.
 */
export function openingScrollMinutes({ nowMinutes = null, firstEventMinutes = null } = {}) {
  if (nowMinutes !== null && Number.isFinite(nowMinutes)) {
    return Math.max(0, nowMinutes - NOW_MARGIN_MINUTES);
  }
  if (firstEventMinutes !== null && Number.isFinite(firstEventMinutes)) {
    return Math.max(0, firstEventMinutes - EVENT_MARGIN_MINUTES);
  }
  return DEFAULT_SCROLL_HOUR * 60;
}

/**
 * The earliest timed minute among spans, or null when there is none. All-day
 * spans are skipped: they live in their own strip above the grid and start at
 * minute zero, so counting them would aim every range at midnight — which is
 * the bug this whole mechanism exists to end.
 */
export function earliestStartMinutes(spans) {
  let earliest = null;
  for (const span of spans || []) {
    if (!span || span.allDay) continue;
    const start = Number(span.start);
    if (!Number.isFinite(start)) continue;
    if (earliest === null || start < earliest) earliest = start;
  }
  return earliest;
}

/** What makes two renders "the same place": the mode and the days on screen. */
export function rangeSignature(mode, keys) {
  return `${mode}|${keys[0] || ''}|${keys[keys.length - 1] || ''}`;
}

/**
 * Whether this render should move the scroll at all.
 *
 * The calendar rebuilds its whole grid on every render, and a render happens
 * whenever a sweep lands. Aiming the fresh scroller at the opening position
 * each time would throw a reader who had scrolled down to the evening back to
 * the morning, on a schedule they do not control. So the opening position is
 * applied on the two occasions it is wanted — arriving at the view, and moving
 * to a different range — and on every other render the position the user left
 * behind is put back instead.
 */
export function shouldOpenAtTarget({ signature, lastSignature, wasOnScreen }) {
  return !wasOnScreen || signature !== lastSignature;
}

/** Where the grid was left, so a re-render can put it back. */
const scrollMemory = { signature: '', top: 0 };

/**
 * The view node from the last render, and the route day already applied.
 *
 * The node answers one question: was the calendar on screen a moment ago? The
 * shell builds the replacement view before swapping it in, so during a
 * same-view re-render the previous node is still in the document, and after a
 * navigation elsewhere it is not. That is the difference between "leave this
 * reader's scroll alone" and "this is an arrival, open where it is useful".
 */
const mounted = { node: null, sub: null };

function anchorKey() {
  const today = nowMark().key || dayKey(state.board.now) || dayKey(new Date().toISOString());
  if (!view.anchor) view.anchor = today;
  return view.anchor;
}

/**
 * The day named by the route, when the route is naming one worth honouring.
 *
 * `#/calendar/2026-08-11` is how search sends somebody to an event it found:
 * a link, rather than one view reaching into another view's state. The rule
 * has to be narrow in both directions. The anchor must move when that hash is
 * arrived at — including arriving at the same hash a second time, which is what
 * clicking the same result again means — and it must NOT move on the ordinary
 * re-renders that happen while the hash sits there unchanged, or the ‹ and ›
 * buttons would be undone by the next sweep that landed.
 *
 * The mode is left alone throughout: whichever of day, week and month the user
 * last chose is the size they read this calendar at, and a search hit is not a
 * reason to change it.
 */
export function anchorFromRoute(sub, applied, arriving = false) {
  if (typeof sub !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(sub)) return null;
  if (sub === applied && !arriving) return null;
  return sub;
}

/**
 * The days one range covers, for a mode and an anchor.
 *
 * Pure, and exported, because the ‹ and › buttons now have to know what the
 * range they would move to CONTAINS before they decide whether to be clickable
 * — which means computing a range for an anchor that is not the current one.
 */
export function keysForAnchor(mode, key) {
  if (mode === 'day') return [key];
  if (mode === 'week') {
    const start = startOfWeekKey(key, 0);
    return Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));
  }
  // Month: whole weeks covering the month, so the grid is always rectangular.
  const first = `${key.slice(0, 7)}-01`;
  const start = startOfWeekKey(first, 0);
  const cells = [];
  for (let i = 0; i < 42; i += 1) cells.push(addDaysToKey(start, i));
  // Trim a trailing all-next-month week; six rows are only needed sometimes.
  while (cells.length > 35 && cells[cells.length - 7].slice(0, 7) !== key.slice(0, 7)) {
    cells.length -= 7;
  }
  return cells;
}

function keysForRange() {
  return keysForAnchor(view.mode, anchorKey());
}

/**
 * Where ‹ and › land: one day, one week, or the 1st of the neighbouring month.
 *
 * Pulled out of the two button handlers, which held one copy each of the
 * month-wrap arithmetic, so that the buttons and the enabled/disabled test that
 * now sits beside them cannot disagree about where a press would go.
 */
export function stepAnchor(mode, key, direction) {
  if (mode === 'day') return addDaysToKey(key, direction);
  if (mode === 'week') return addDaysToKey(key, 7 * direction);
  const [y, m] = key.split('-').map(Number);
  const raw = m + direction;
  const month = ((raw - 1 + 12) % 12) + 1;
  const year = y + Math.floor((raw - 1) / 12);
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Whether a range is worth letting somebody walk to.
 *
 * OVERLAP, not containment, and the difference is the whole design. `/api/state`
 * serves one window and there is no route that asks for another, so a range past
 * its edge can only ever be drawn empty — which is what the arrows did, silently,
 * for as many presses as anyone cared to make. Refusing anything not FULLY inside
 * the window would be the other failure: the month grid begins on the Sunday
 * before the 1st, so the month before this one always spills over the back edge
 * and month mode would collapse to a single reachable month.
 *
 * So: any range still holding a served day stays reachable, its unserved days
 * are drawn as unserved rather than as empty, and a range holding none at all is
 * where the arrows stop. With no window declared, nothing is refused.
 */
export function rangeIsReachable(keys, served) {
  if (!served) return true;
  return (keys || []).some((k) => k >= served.from && k <= served.to);
}

/** Every event that touches `key`, already clamped to that day's minutes. */
function spansForDay(key) {
  const out = [];
  for (const event of state.board.events) {
    const span = eventSpanOnDay(event, key);
    if (span) out.push({ event, ...span });
  }
  return out;
}

function rangeTitle(keys) {
  if (view.mode === 'day') {
    const k = keys[0];
    const [y, m, d] = k.split('-').map(Number);
    return `${dayName(weekdayOfKey(k))}, ${monthName(m)} ${d}, ${y}`;
  }
  if (view.mode === 'week') {
    const [a, b] = [keys[0], keys[keys.length - 1]];
    const [ya, ma, da] = a.split('-').map(Number);
    const [yb, mb, db] = b.split('-').map(Number);
    const left = `${monthName(ma).slice(0, 3)} ${da}`;
    const right = ma === mb ? `${db}` : `${monthName(mb).slice(0, 3)} ${db}`;
    return `${left} – ${right}${ya === yb ? `, ${yb}` : `, ${ya} – ${yb}`}`;
  }
  const [y, m] = anchorKey().split('-').map(Number);
  return `${monthName(m)} ${y}`;
}

/* ------------------------------------------------------------------ chrome */

function segmented(rerender) {
  const group = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Calendar range' },
    MODES.map((mode) => el('button', {
      type: 'button',
      class: 'seg',
      'aria-pressed': view.mode === mode.id ? 'true' : 'false',
      onclick: () => { view.mode = mode.id; rerender(); },
      text: mode.label,
    })));
  return group;
}

function toolbar(keys, rerender) {
  // Named `served`, not `window`: this file runs in a browser, and shadowing the
  // global inside a function that builds DOM is a trap for whoever edits it next.
  const served = eventWindow();
  const arrow = (label, direction, ariaLabel) => {
    const target = stepAnchor(view.mode, anchorKey(), direction);
    const reachable = rangeIsReachable(keysForAnchor(view.mode, target), served);
    return button(label, {
      class: 'btn icon',
      'aria-label': ariaLabel,
      ...(reachable ? {} : {
        disabled: true,
        title: `Zelos is holding ${served.from} to ${served.to}. There is nothing loaded past that — a check moves the window.`,
      }),
      onClick: () => {
        if (!reachable) return;
        view.anchor = target;
        rerender();
      },
    });
  };

  return el('div', { class: 'cal-bar' }, [
    el('div', { class: 'cal-nav' }, [
      arrow('‹', -1, 'Previous'),
      button('Today', {
        class: 'btn quiet',
        onClick: () => { view.anchor = nowMark().key || dayKey(state.board.now); rerender(); },
      }),
      arrow('›', 1, 'Next'),
    ]),
    el('h2', { class: 'cal-title', text: rangeTitle(keys) }),
    segmented(rerender),
  ]);
}

/**
 * The line under the toolbar that says the grid is only part of an answer.
 *
 * It appears only when the range on screen actually straddles the edge, so the
 * common case — a week inside the window — carries no chrome at all. The count
 * is measured off the keys rather than described, because "some days" beside a
 * grid with two marked cells is the kind of vagueness that makes a reader
 * distrust the marked cells too.
 */
function windowNote(keys) {
  const served = eventWindow();
  if (!served) return null;
  const missing = keys.filter((k) => !dayIsLoaded(k)).length;
  if (!missing) return null;
  return el('p', {
    class: 'meta',
    role: 'status',
    text: `${missing === 1 ? 'One day here is' : `${missing} days here are`} outside what Zelos has loaded (${served.from} to ${served.to}) — they are marked, not empty.`,
  });
}

/* ----------------------------------------------------------------- time grid */

function chip({ event, start, end, col, cols }, { today, nowMinutes, compact }) {
  const height = Math.max(MIN_CHIP_MINUTES, end - start);
  const past = today && nowMinutes !== null && nowMinutes >= end;
  const live = today && nowMinutes !== null && nowMinutes >= start && nowMinutes < end;
  const width = 100 / cols;
  // Under about 45 minutes the chip is one line tall, so stacking time above
  // title hides the title entirely. Those chips go horizontal instead.
  const short = height < 45;

  return el('article', {
    class: `chip-ev${short ? ' is-short' : ''}${past ? ' is-past' : ''}${live ? ' is-live' : ''}${cols > 1 ? ' is-packed' : ''}`,
    style: {
      top: `calc(${start} * var(--min-h))`,
      height: `calc(${height} * var(--min-h))`,
      left: `${col * width}%`,
      width: `${width}%`,
    },
    title: `${eventTimeLabel(event)} — ${event.title || '(untitled)'}`,
  }, [
    // Ended is drawn as an outline in quieter ink; this says it in words.
    past ? el('span', { class: 'visually-hidden', text: 'Ended: ' }) : null,
    el('span', { class: 'chip-time mono', text: formatTime(event.starts_at) }),
    el('span', { class: 'chip-title', text: event.title || '(untitled)' }),
    !compact && event.location ? el('span', { class: 'chip-where', text: event.location }) : null,
  ]);
}

/**
 * The mark a day that was never served wears.
 *
 * Styled inline rather than with a class, because ui/app.css has no rule for
 * this and inventing one there is not this change's to make. It is deliberately
 * quiet — this is not an error, it is the edge of an answer — but it is text, in
 * the cell, saying the thing: an empty grid that means "nothing on" and an empty
 * grid that means "nobody asked" are the same picture, and the second one is the
 * one that gets believed.
 */
const NOT_LOADED_TITLE =
  'Zelos has not loaded this day. The board carries a window around today; check your mail, or come back when it has moved.';

function notLoadedMark({ block = false } = {}) {
  return el('span', {
    class: 'cal-unloaded mono',
    title: NOT_LOADED_TITLE,
    style: {
      'font-size': '0.5625rem',
      'letter-spacing': '0.08em',
      'text-transform': 'uppercase',
      color: 'var(--ink-3)',
      ...(block ? { display: 'block', 'text-align': 'center', 'margin-top': '0.6rem' } : {}),
    },
    text: 'not loaded',
  });
}

function dayColumn(key, { todayKeyStr, nowMinutes, compact }) {
  const spans = spansForDay(key).filter((s) => !s.allDay);
  const packed = packColumns(spans);
  const isToday = key === todayKeyStr;
  const loaded = dayIsLoaded(key);

  return el('div', {
    class: `cal-col${isToday ? ' is-today' : ''}${loaded ? '' : ' is-unloaded'}`,
    dataset: { day: key },
    ...(loaded ? {} : { title: NOT_LOADED_TITLE }),
  }, [
    ...packed.map((entry) => chip(entry, { today: isToday, nowMinutes, compact })),
    isToday && nowMinutes !== null
      ? el('div', {
        class: 'now-line',
        style: { top: `calc(${nowMinutes} * var(--min-h))` },
        'aria-hidden': 'true',
      }, el('span', { class: 'now-dot' }))
      : null,
  ]);
}

function allDayStrip(keys) {
  const rows = keys.map((key) => spansForDay(key).filter((s) => s.allDay));
  if (!rows.some((r) => r.length)) return null;
  return el('div', { class: 'cal-allday' }, [
    el('div', { class: 'cal-gutter-cell mono', text: 'all day' }),
    el('div', { class: 'cal-allday-days', style: { '--cols': String(keys.length) } },
      rows.map((row) => el('div', { class: 'cal-allday-cell' },
        row.map(({ event }) => el('span', { class: 'chip-allday', text: event.title || '(untitled)' }))))),
  ]);
}

function timeGrid(keys, { wasOnScreen }) {
  const { key: todayKeyStr, minutes: nowMinutes } = nowMark();
  const compact = keys.length > 1;

  const head = el('div', { class: 'cal-head', style: { '--cols': String(keys.length) } }, [
    el('div', { class: 'cal-gutter-cell' }),
    el('div', { class: 'cal-head-days' }, keys.map((key) => {
      const [, , d] = key.split('-').map(Number);
      const loaded = dayIsLoaded(key);
      /* The mark goes in the HEADER, not in the column below it. The column is
         1,440 minutes tall and holds absolutely-positioned chips, so a note
         dropped into it lands at an arbitrary hour and reads as an event. The
         header is where the date already is, which is where a reader is already
         looking to ask what day this is. */
      return el('div', {
        class: `cal-head-cell${key === todayKeyStr ? ' is-today' : ''}${loaded ? '' : ' is-unloaded'}`,
      }, [
        el('span', { class: 'cal-head-dow', text: dayName(weekdayOfKey(key)).slice(0, 3) }),
        el('span', { class: 'cal-head-num mono', text: String(d) }),
        loaded ? null : notLoadedMark({ block: true }),
      ]);
    })),
  ]);

  const hours = el('div', { class: 'cal-gutter' }, Array.from({ length: 24 }, (_, h) => el('div', {
    class: 'cal-hour mono',
    style: { top: `calc(${h * 60} * var(--min-h))` },
    text: h === 0 ? '' : formatTime(`2026-01-01T${String(h).padStart(2, '0')}:00:00`),
  })));

  const days = el('div', { class: 'cal-days', style: { '--cols': String(keys.length) } },
    keys.map((key) => dayColumn(key, { todayKeyStr, nowMinutes, compact })));

  /* The hours scroll in a box with nothing focusable inside, and WebKit does
     not make a scroll box focusable by itself, so the hours out of view could
     not be reached by keyboard (QA, 2026-10-10, TT-3472). A tab stop, with a
     name to announce when it takes focus, lets the arrow keys scroll it. */
  const scroller = el('div', {
    class: 'cal-scroll',
    tabindex: '0',
    role: 'region',
    'aria-label': view.mode === 'day' ? 'Day schedule' : 'Week schedule',
  }, [
    el('div', { class: 'cal-body' }, [hours, days]),
  ]);

  // Where this render should start, and whether it is allowed to say so.
  const signature = rangeSignature(view.mode, keys);
  const openAtTarget = shouldOpenAtTarget({
    signature,
    lastSignature: scrollMemory.signature,
    wasOnScreen,
  });
  const restoreTop = scrollMemory.top;
  scrollMemory.signature = signature;
  if (openAtTarget) scrollMemory.top = 0;
  scroller.addEventListener('scroll', () => {
    scrollMemory.top = scroller.scrollTop;
  }, { passive: true });

  /**
   * How many title lines each chip can actually show.
   *
   * Measured rather than derived: the chip's height comes from `--min-h`, which
   * differs between the week grid and the day grid, and a constant copied out of
   * the stylesheet would be wrong in one of them the first time either changed.
   * The measurement runs after layout, once per render.
   */
  const budgetChipTitles = () => {
    for (const title of days.querySelectorAll('.chip-title')) {
      const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) continue;
      title.style.setProperty('--chip-lines', String(Math.max(1, Math.floor(title.clientHeight / lineHeight))));
    }
  };

  const targetMinutes = openingScrollMinutes({
    nowMinutes: keys.includes(todayKeyStr) ? nowMinutes : null,
    firstEventMinutes: earliestStartMinutes(keys.flatMap((key) => spansForDay(key))),
  });

  /**
   * Put the scroller at `top`, and keep trying if the browser refuses.
   *
   * An assignment to `scrollTop` on an element that is not yet scrollable is
   * silently clamped to zero — and zero is midnight, the exact place this whole
   * mechanism exists to avoid. So the result is read back, and a clamp is
   * retried a bounded number of times: never a loop, and it stops the moment
   * the position takes.
   */
  /**
   * Put the scroller at `top`, and keep trying until it takes.
   *
   * Two things can swallow the attempt, and both were doing so. A scroller
   * that is not in the document yet ignores the assignment entirely — the
   * shell builds a view node and swaps it in afterwards, and in this app that
   * can land a second or more after the render that created it, so a budget
   * counted in frames expired long before the grid existed. A scroller that is
   * attached but not yet laid out clamps the assignment to zero, and zero is
   * midnight: the exact place this whole mechanism exists to avoid.
   *
   * So the budget is wall-clock rather than a frame count, and it ends the
   * moment the position takes. rAF stops in a hidden tab, which is the right
   * behaviour here too — there is nothing to scroll for until someone looks.
   */
  const SETTLE_BUDGET_MS = 3_000;
  const applyScrollTop = (top, deadline = performance.now() + SETTLE_BUDGET_MS) => {
    const again = () => {
      if (performance.now() < deadline) requestAnimationFrame(() => applyScrollTop(top, deadline));
    };
    if (!scroller.isConnected) { again(); return; }
    scroller.scrollTop = top;
    if (scroller.scrollTop === 0 && top > 0) { again(); return; }
    // Remember where it actually landed. Leaving the memory at zero let any
    // re-render that arrived before the browser's own scroll event restore
    // midnight over the position just applied.
    scrollMemory.top = scroller.scrollTop;
  };

  const settleScroll = () => {
    if (!openAtTarget) {
      applyScrollTop(restoreTop);
      return;
    }
    const minH = parseFloat(getComputedStyle(scroller).getPropertyValue('--min-h')) || 0.8;
    applyScrollTop(targetMinutes * minH);
  };

  // Two frames, not one. A rAF callback runs BEFORE the layout of the frame it
  // belongs to, so a scroller attached in this same task still reports
  // scrollHeight === clientHeight there, and both the measurement and the
  // scroll would be taken against a grid with no height yet. The second frame
  // is after layout.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    budgetChipTitles();
    settleScroll();
  }));

  return el('div', { class: `cal-grid mode-${view.mode}`, style: { '--cols': String(keys.length) } }, [
    head,
    allDayStrip(keys),
    scroller,
  ]);
}

/* --------------------------------------------------------------------- month */

const MONTH_VISIBLE = 3;

function monthCell(key, { todayKeyStr, monthPrefix }) {
  // Keep conflict marks across the full day, but read in displayed time order
  // before splitting visible and overflow entries. The day flag covers both.
  const spans = conflictsFirst(spansForDay(key))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
  const [, , d] = key.split('-').map(Number);
  const outside = key.slice(0, 7) !== monthPrefix;
  const hasConflict = spans.some((s) => s.conflict);
  /* `outside` and `loaded` are two different facts about a cell and the grid has
     to keep them apart: `is-outside` means "this day belongs to the neighbouring
     month", which is a layout note about a day that IS drawn correctly, and
     `is-unloaded` means "the board carries no answer about this day at all". */
  const loaded = dayIsLoaded(key);

  const list = el('div', { class: 'month-list' });
  const shown = spans.slice(0, MONTH_VISIBLE);
  for (const span of shown) list.appendChild(monthEntry(span));

  const cell = el('div', {
    class: `month-cell${outside ? ' is-outside' : ''}${key === todayKeyStr ? ' is-today' : ''}${hasConflict ? ' has-conflict' : ''}${loaded ? '' : ' is-unloaded'}`,
    ...(loaded ? {} : { title: NOT_LOADED_TITLE }),
  }, [
    el('div', { class: 'month-num-row' }, [
      el('span', { class: 'month-num mono', text: String(d) }),
      hasConflict ? el('span', { class: 'month-flag', title: 'Overlapping events', text: 'clash' }) : null,
      hasConflict || loaded ? null : notLoadedMark(),
    ]),
    list,
  ]);

  if (spans.length > MONTH_VISIBLE) {
    const rest = spans.slice(MONTH_VISIBLE);
    const restWrap = el('div', { class: 'month-list', hidden: true }, rest.map(monthEntry));
    list.after(restWrap);
    cell.appendChild(el('button', {
      type: 'button',
      class: 'month-more',
      'aria-expanded': 'false',
      onclick() {
        const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', open ? 'false' : 'true');
        restWrap.hidden = open;
        this.textContent = open ? `+${rest.length} more` : 'fewer';
      },
    }, `+${rest.length} more`));
  }
  return cell;
}

function monthEntry({ event, conflict }) {
  return el('div', { class: `month-ev${conflict ? ' is-conflict' : ''}` }, [
    el('span', { class: 'month-ev-time mono', text: event.all_day ? '' : formatTime(event.starts_at) }),
    el('span', { class: 'month-ev-title', text: event.title || '(untitled)' }),
  ]);
}

function monthGrid(keys) {
  const { key: todayKeyStr } = nowMark();
  const monthPrefix = anchorKey().slice(0, 7);
  return el('div', { class: 'month' }, [
    el('div', { class: 'month-dow' }, Array.from({ length: 7 }, (_, i) =>
      el('span', { class: 'month-dow-cell', text: dayName(i).slice(0, 3) }))),
    el('div', { class: 'month-cells' }, keys.map((key) => monthCell(key, { todayKeyStr, monthPrefix }))),
  ]);
}

/**
 * Take the line off the grid, and take the day marker with it.
 *
 * Removing the line alone left the highlight behind on whichever column was
 * today when the grid was built — so a day grid showing the 12th, ticked at
 * 00:03 on the 13th, dropped its line and went on drawing the 12th as today.
 * Losing the line is the quiet half of that; the tinted column is the half a
 * user reads, and it went on naming the wrong date until something forced a
 * full render. Every column is cleared rather than only the line's parent,
 * because the claim being withdrawn is "today is on this screen", and no column
 * on this screen is entitled to it.
 */
function dropNowLine(line) {
  line.remove();
  for (const column of document.querySelectorAll('.cal-days .cal-col')) {
    column.classList?.remove('is-today');
  }
}

/**
 * Move the now-line without rebuilding the grid.
 *
 * Re-rendering the calendar once a minute would be simpler and would also throw
 * the user's scroll position back to the top every sixty seconds. The line is
 * the only thing that actually changed, so it is the only thing that moves.
 *
 * The DAY has to move with it. The line is a child of the column that was today
 * when the grid was built, and `nowMark()` rolls its key past midnight rather
 * than giving up — so a window left open to 00:03 was putting the line at three
 * minutes past the top of YESTERDAY's column, which reads as a confident claim
 * about the wrong day. The line follows its day into the neighbouring column
 * when that day is on screen, and leaves altogether when it is not: a grid
 * showing last week has no honest place to draw "now".
 */
export function tickNowLine() {
  const line = document.querySelector('.cal-days .now-line');
  if (!line) return;
  const { key, minutes } = nowMark();
  if (minutes === null || !key) {
    dropNowLine(line);
    return;
  }

  // Matched by reading each column's own key rather than by building a selector
  // out of one: the columns are already in hand, and a query never has to be
  // trusted with a value.
  let column = null;
  for (const candidate of document.querySelectorAll('.cal-days .cal-col')) {
    if (candidate.dataset?.day === key) {
      column = candidate;
      break;
    }
  }
  if (!column) {
    dropNowLine(line);
    return;
  }

  if (line.parentNode !== column) {
    // The old column stops being today at the same moment, or the grid paints
    // two of them until the next full render.
    line.parentNode?.classList?.remove('is-today');
    column.classList?.add('is-today');
    column.appendChild(line);
  }
  line.style.top = `calc(${minutes} * var(--min-h))`;
}

/* -------------------------------------------------------------------- render */

export function renderCalendar(ctx) {
  const rerender = ctx.rerender;
  // Read before anything is built: the previous view node is still in the
  // document at this point, and whether it is decides both where the grid opens
  // and whether the day in the route is applied again.
  const wasOnScreen = Boolean(mounted.node?.isConnected);

  const jump = anchorFromRoute(ctx.sub, mounted.sub, !wasOnScreen);
  if (jump) view.anchor = jump;
  mounted.sub = typeof ctx.sub === 'string' ? ctx.sub : null;

  const keys = keysForRange();
  const body = el('div', { class: 'view view-calendar' }, [toolbar(keys, rerender), meander()]);
  mounted.node = body;

  // "No calendar connected" is a claim about the CONFIG, so it branches on the
  // config. Branching on the events list alone told a connected calendar with a
  // quiet fortnight that it did not exist — and hid the grid, which was the
  // only way to scroll to a week that has something in it. The events check
  // that remains covers the one case config can't: the demo seeds events into
  // the database without adding a config entry, and a demo board with a week
  // of meetings deserves its grid, not a setup card.
  if ((state.config?.calendars?.length || 0) === 0 && !state.board.events.length) {
    body.appendChild(emptyState({
      title: 'No calendar connected',
      detail: 'Add your calendar in Settings, and your week appears here. Times are kept exactly as your calendar has them, so an appointment at 2pm stays at 2pm.',
      action: button('Connect a calendar', { class: 'btn solid', onClick: () => ctx.navigate('#/settings/calendars') }),
    }));
    return body;
  }

  const note = windowNote(keys);
  if (note) body.appendChild(note);
  body.appendChild(view.mode === 'month' ? monthGrid(keys) : timeGrid(keys, { wasOnScreen }));
  return body;
}
