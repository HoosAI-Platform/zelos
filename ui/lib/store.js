/**
 * ui/lib/store.js — one copy of the truth, and the sweep stream that keeps it
 * honest.
 *
 * Everything the views render lives here: /api/health, /api/config and the
 * board from /api/state. Views subscribe; nothing reaches into another view.
 *
 * `now` deserves a note. The board carries the server's `now` as an ISO string
 * in the *user's configured* zone, and the calendar positions its now-line from
 * that string's wall-clock minutes. Ticking that forward with the local clock
 * would be wrong the moment the two zones differ, so the tick is applied as
 * elapsed milliseconds since the payload arrived — a duration, which is the same
 * in every zone.
 */

import { api, openStream, ApiError } from './api.js';
import { minutesIntoDay, dayKey, addDaysToKey, localTimezone, instant, formatTime } from './time.js';
import { plural, isNewSince, eventSpanOnDay } from './format.js';

const ACCENT_KEY = 'zelos.accent';
const ONBOARDED_KEY = 'zelos.onboarded';

/** Blank board, so a view rendered before the first fetch has real shapes. */
const EMPTY_BOARD = Object.freeze({
  items: [],
  counts: { now: 0, today: 0, soon: 0, waiting: 0, promised: 0, note: 0, money: 0 },
  events: [],
  drafts: [],
  runs: { last: null },
  // What was recently marked done or dismissed, newest first — a separate list
  // on purpose, so everything that reads items[] keeps meaning "on the board".
  // An older server sends no such field, and this default is that case.
  finished: [],
  notes: [],
  first: null,
  now: null,
  // The sweep engine's rolling token counter, when this database has one. It
  // is null rather than a zeroed pair on purpose: "nothing has been spent" and
  // "this build never counted" must not render as the same line.
  tokens: null,
  /**
   * WHICH DAYS `events` IS AN ANSWER ABOUT — `{from, to}` as day keys, straight
   * from /api/state.
   *
   * `events` is not the whole calendar and never was; it is one window around
   * today, and until this field existed nothing said so. The calendar's ‹ and ›
   * are unclamped and there is no route that fetches another range, so paging
   * out of the window drew a fully styled grid of empty cells for months whose
   * events were sitting in the local database the whole time — measured
   * 2026-08-10: November, 35 empty cells; October, 22; and August's own grid,
   * which begins 2026-07-26, eight.
   *
   * Null means the server made no claim — an older build, or the blank board
   * below before the first fetch — and the calendar then draws everything
   * without markings, exactly as it always did. It is not a stand-in for "empty
   * window": an empty window is a `{from, to}` that excludes the day.
   */
  eventWindow: null,
});

export const state = {
  /** 'boot' until the first health+state pair lands, then 'ready' or 'down'. */
  phase: 'boot',
  /**
   * Bumped whenever the *content* of the board or the config changes. The app
   * shell re-renders the current view on a change of `rev`, not on every emit —
   * a sweep-progress tick must not rebuild a draft textarea under someone's
   * cursor.
   */
  rev: 0,
  /** Set when the server itself is unreachable — a designed screen, not a toast. */
  fatal: null,
  health: null,
  config: null,
  configErrors: [],
  secretRefs: [],
  // Whether a key is saved for the configured AI service's address.
  modelKeyStored: false,
  board: EMPTY_BOARD,
  boardAt: 0,
  sweep: { running: false, phase: '', message: '', done: 0, total: 0, error: null, lastResult: null },
  /** Non-fatal, dismissible: a save that failed, a draft that would not persist. */
  toast: null,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error('a subscriber threw', err);
    }
  }
}

/**
 * A toast should not need to be dismissed to go away: it auto-dismisses after a
 * few seconds, and a NEW toast restarts the clock by replacing the old timer
 * along with the old message. A toast carrying an action (Undo, mostly) gets
 * longer — vanishing under a cursor that is on its way to the button is worse
 * than lingering — but it still goes eventually; a permanent toast is a banner
 * that chose the wrong container.
 */
const TOAST_MS = 6_000;
const TOAST_ACTION_MS = 8_000;
let toastTimer = null;

export function notify(message, { tone = 'info', action = null } = {}) {
  clearTimeout(toastTimer);
  toastTimer = null;
  state.toast = message ? { message, tone, action, at: Date.now() } : null;
  if (state.toast) {
    toastTimer = setTimeout(() => {
      toastTimer = null;
      state.toast = null;
      emit();
    }, action ? TOAST_ACTION_MS : TOAST_MS);
    // A pending toast is no reason to keep a process alive. The browser's
    // timer id is a number and has no unref; Node's (the tests) does.
    toastTimer?.unref?.();
  }
  emit();
}

/* ------------------------------------------------------------------- accent */

/**
 * There is one theme — black — and one colour choice on top of it. Everything
 * in the stylesheet derives from this single hex via color-mix, including the
 * ambient light behind the glass, so this is genuinely the only value stored.
 */
export const DEFAULT_ACCENT = '#5b8cff';

/** Six digit hex only. Anything else is refused rather than written to a CSS
 *  custom property, where a hostile string would land unescaped in a style. */
export function isAccent(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

export function currentAccent() {
  const fromConfig = state.config?.ui?.accent;
  if (isAccent(fromConfig)) return fromConfig.toLowerCase();
  try {
    const stored = localStorage.getItem(ACCENT_KEY);
    if (isAccent(stored)) return stored.toLowerCase();
  } catch {
    /* storage disabled; fall through to the default */
  }
  return DEFAULT_ACCENT;
}

export function applyAccent(accent) {
  const hex = isAccent(accent) ? accent.toLowerCase() : DEFAULT_ACCENT;
  document.documentElement.style.setProperty('--accent', hex);
  try {
    localStorage.setItem(ACCENT_KEY, hex);
  } catch {
    /* the property above is what actually colours the app */
  }
  return hex;
}

export async function setAccent(accent) {
  const hex = applyAccent(accent);
  if (state.config) state.config = { ...state.config, ui: { ...state.config.ui, accent: hex } };
  emit();
  try {
    await saveConfig({ ui: { accent: hex } });
  } catch (err) {
    notify(`Accent not saved: ${err.message}`, { tone: 'warn' });
  }
}

/* -------------------------------------------------------------- onboarding */

/**
 * Onboarding is "have you finished it", not "is anything configured" — a user
 * who deliberately skipped every step must not be dragged back through the flow
 * on the next launch. The mark lives in localStorage rather than config.json
 * because it is a fact about this browser profile, not about the account.
 */
let onboardingCompletedHere = null;

export function onboardingDone() {
  if (onboardingCompletedHere !== null) return onboardingCompletedHere;
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markOnboarded(done = true) {
  // Keep the explicit choice for this page even when private browsing or a
  // full storage quota refuses persistence. Finishing must still leave setup.
  onboardingCompletedHere = Boolean(done);
  try {
    if (done) localStorage.setItem(ONBOARDED_KEY, '1');
    else localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    /* the flow still completes; it will simply offer itself again */
  }
}

export function needsOnboarding() {
  if (onboardingDone()) return false;
  return !state.health?.model?.configured;
}

/* ------------------------------------------------------------------ loading */

export async function loadHealth() {
  state.health = await api.health();
  return state.health;
}

export async function loadConfig() {
  const res = await api.config();
  state.config = res.config;
  state.configErrors = res.errors || [];
  state.secretRefs = res.secretRefs || [];
  state.modelKeyStored = res.modelKeyStored === true;
  state.rev += 1;
  return state.config;
}

/** The board's content as a comparable string — `now` excluded, because the
 *  server's clock moves on every fetch and is not a change in the board. */
function boardStamp(board) {
  return JSON.stringify({ ...board, now: null });
}

export async function loadBoard() {
  const board = await api.state();
  const next = { ...EMPTY_BOARD, ...board };
  // `rev` moves only when the content did. The heartbeat refetches an
  // unchanged board every three minutes and on every tab return, and a bump
  // for each of those rebuilds the current view — including the onboarding
  // flow, whose half-typed forms do not survive it. The fresh payload is
  // still kept: `now` and `boardAt` are what keep the clock honest.
  if (boardStamp(next) !== boardStamp(state.board)) state.rev += 1;
  state.board = next;
  state.boardAt = Date.now();
  return state.board;
}

export async function saveConfig(patch) {
  const res = await api.saveConfig(patch);
  state.config = res.config;
  state.configErrors = res.errors || [];
  state.secretRefs = res.secretRefs || [];
  state.modelKeyStored = res.modelKeyStored === true;
  // The health document is where `model.configured` lives, and every screen
  // that gates on a model — the onboarding's "Sweep now", its "Missing: a
  // model" note, the rail foot, the Now view's empty state — reads it from
  // here and nowhere else. A config save is exactly the moment that answer
  // changes, and until this line it was refetched only at boot and when a
  // sweep finished, so pasting a working hosted key ended on a disabled
  // button naming the thing just done as missing, until a page reload. Its
  // failure is swallowed: the save itself succeeded, and the heartbeat and
  // the next sweep both retry.
  await loadHealth().catch(() => {});
  state.rev += 1;
  emit();
  return res;
}

/**
 * The fatal screen for a failure to reach the server, in one place.
 *
 * The boot path and the heartbeat both need it and must word it identically: a
 * window that goes dark at 3am should say what a window that never came up says,
 * because it is the same fact about the same server.
 */
export function fatalFor(err) {
  if (err instanceof ApiError && err.status === 401) {
    // Said in the words the plain-words guard allows, with the way back that
    // actually exists where the reader is: the desktop shell has no terminal
    // to reopen from — its Board menu reloads the board with a fresh key.
    return {
      title: 'This tab has lost its key',
      detail: (typeof window !== 'undefined' && window.zelos)
        ? 'Zelos hands each window a new key every time it starts, and the one this window holds is no longer good. Choose Board → Reload board and Zelos opens it again with a fresh key.'
        : 'Zelos hands each window a new key every time it starts, and the one this tab holds is no longer good. Open the address printed in the terminal that started Zelos — that address carries a fresh key.',
    };
  }
  return {
    title: 'Zelos is not answering',
    detail: err?.message || 'The reason did not survive the trip.',
  };
}

/** health + config + board, in parallel. The first one is what boots the app. */
export async function refresh({ silent = false } = {}) {
  try {
    await Promise.all([loadHealth(), loadConfig(), loadBoard()]);
    state.phase = 'ready';
    state.fatal = null;
  } catch (err) {
    state.fatal = fatalFor(err);
    state.phase = 'down';
  }
  if (!silent) emit();
  return state;
}

export async function refreshBoard() {
  try {
    await loadBoard();
    emit();
  } catch (err) {
    notify(`Could not refresh the board: ${err.message}`, { tone: 'warn' });
  }
}

/* ------------------------------------------------------------------- sweeps */

export async function startSweep(mode = 'auto') {
  state.sweep = { ...state.sweep, error: null, message: 'Starting…', running: true };
  emit();
  try {
    await api.sweep(mode);
  } catch (err) {
    // 409 means one is already in flight, which is not an error the user caused.
    state.sweep = {
      ...state.sweep,
      running: err instanceof ApiError && err.status === 409,
      error: err instanceof ApiError && err.status === 409 ? null : err.message,
    };
    emit();
  }
}

/**
 * Follow /api/sweep/stream forever. The stream survives across sweeps, so a
 * dropped connection means the server restarted or the laptop slept — reconnect
 * with a backoff rather than leaving the board silently stale.
 */
export function watchSweeps() {
  let delay = 1_000;
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      try {
        await openStream('/api/sweep/stream', {
          onEvent(event, data) {
            delay = 1_000;
            if (event === 'hello') {
              state.sweep = { ...state.sweep, running: Boolean(data?.running) };
            } else if (event === 'started') {
              // "Checking", never "sweeping": a sweep is the code's word for
              // it, and it made the audit's reader think of a broom.
              state.sweep = { running: true, phase: 'start', message: 'Checking your mail…', done: 0, total: 0, error: null, lastResult: null };
            } else if (event === 'progress') {
              state.sweep = {
                ...state.sweep,
                running: true,
                phase: String(data?.phase || ''),
                message: String(data?.message || ''),
                done: Number(data?.done) || 0,
                total: Number(data?.total) || 0,
              };
            } else if (event === 'done') {
              // Whether "— 2 new things" may be said is decided BEFORE the
              // refresh replaces runs.last with the run that just ended: with
              // no prior successful run to compare against — the first check
              // ever, or a failure just before this one — everything would
              // count as new, so the line stays plain instead.
              const hadPrior = state.board.runs?.last?.ok === true;
              state.sweep = { running: false, phase: 'done', message: 'Finished checking', done: 0, total: 0, error: null, lastResult: data || null };
              refreshBoard().then(() => {
                if (!hadPrior) return;
                // Counted from stored timestamps, never from the model's
                // wording — see newSinceLastCheck. One paint only; the
                // chrome clears it on the repaint after it is shown.
                const fresh = newSinceLastCheck().length;
                state.sweep = {
                  ...state.sweep,
                  finished: fresh
                    ? `Finished checking — ${plural(fresh, 'new thing')}`
                    : 'Finished checking — nothing new',
                };
                emit();
              });
              loadHealth().catch(() => {});
            } else if (event === 'failed') {
              state.sweep = {
                running: false,
                phase: 'failed',
                message: 'The check failed',
                done: 0,
                total: 0,
                error: String(data?.error || 'the check failed'),
                lastResult: data || null,
              };
              refreshBoard();
              // A failed sweep is the usual way a stale health document gets
              // noticed — the banner it raises sits beside screens that gate
              // on `model.configured`, so both should be answers to the same
              // question at the same moment, as they are after `done`.
              loadHealth().catch(() => {});
            }
            emit();
          },
        });
      } catch {
        // Transport failure; the retry below is the whole recovery story.
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  };

  run();
  return () => { stopped = true; };
}

/**
 * How often an untouched window refetches the board. Minutes, not seconds: this
 * is a local HTTP call against a SQLite file, but the point of it is only to
 * keep a window that has been open all night honest — the sweep stream is what
 * delivers actual news.
 */
const BOARD_REFRESH_MS = 3 * 60_000;

/**
 * Keep the board from quietly rotting in a window nobody has touched.
 *
 * A sweep pushes its results down the stream, but a window that sat open past
 * midnight was never told the day had changed, and one whose laptop slept woke
 * up with an hours-old board and no reason to refetch it. Both are the same
 * missing piece: a slow heartbeat.
 *
 * Two properties matter more than the interval itself.
 *
 * It goes out through `loadBoard` + `emit`, which is the SAME path a sweep's
 * `done` event takes — so the shell's deferred-render rule applies to it
 * unchanged, and a refresh that lands while someone is typing in a draft queues
 * until that field blurs instead of rebuilding the form under their hands.
 *
 * And it is quiet about a single failure, but not about a run of them. One
 * missed refetch is a laptop changing wifi, and a warning every three minutes
 * while someone is on a train is worse than a board a few minutes old. Three in
 * a row is a server that has gone away, and a heartbeat that swallowed that
 * would leave the app permanently and invisibly stale in the exact scenario it
 * was written for — the overnight window, whose board is hours old and looks
 * exactly like a board that is current. So the run of failures raises the SAME
 * fatal screen the boot path raises, once, and a refetch that succeeds takes it
 * back down. No toast: a toast per tick is the noise this was avoiding.
 */
export function watchBoard({ intervalMs = BOARD_REFRESH_MS } = {}) {
  let stopped = false;
  const hidden = () => document.visibilityState === 'hidden';

  // How many refetches in a row must fail before the window says so. Three
  // ticks is the better part of ten minutes at the default interval, which is
  // long past "the wifi hiccuped".
  const MISSES_BEFORE_FATAL = 3;
  let misses = 0;
  // Whether the screen currently showing is one this heartbeat put up. Only
  // that one may be taken down here — a fatal from the boot path or from a lost
  // session key is somebody else's to clear.
  let raised = false;

  const tick = async () => {
    // A hidden tab is a tab nobody is reading. Refetching it burns battery to
    // paint pixels no one will see, and the visibility handler below catches
    // up the moment it comes back.
    if (stopped || hidden() || state.phase === 'boot') return;
    try {
      await loadBoard();
      misses = 0;
      if (raised) {
        raised = false;
        state.fatal = null;
        state.phase = 'ready';
      }
      emit();
    } catch (err) {
      misses += 1;
      if (misses < MISSES_BEFORE_FATAL || state.fatal) return;
      state.fatal = fatalFor(err);
      state.phase = 'down';
      raised = true;
      emit();
    }
  };

  const timer = setInterval(tick, intervalMs);
  const onVisible = () => { if (!hidden()) tick(); };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener?.('visibilitychange', onVisible);
  };
}

/* ------------------------------------------------------------------- derived */

export function timezone() {
  return state.config?.identity?.timezone || localTimezone();
}

/**
 * The user's "now" as {key, minutes}, ticked forward by elapsed duration.
 *
 * Midnight used to end this function: past 1440 minutes it answered {key:null},
 * which is what a window left open overnight actually did to the app — the
 * header date went blank, the now-line vanished, Today's events fell to zero
 * and the calendar's "Today" button pointed at yesterday, all of it until
 * someone reloaded. Nothing refetched the board on a timer, so "until someone
 * reloaded" could be days.
 *
 * So the day is ROLLED instead of dropped: whole days elapsed are added to the
 * key and the remainder is the minute of the new day. That is arithmetic on a
 * duration and a date-key, neither of which needs a zone. The one thing it
 * cannot see is a DST change inside the elapsed span, which leaves the line an
 * hour out until watchBoard() refetches — minutes later, at worst.
 */
export function nowMark() {
  const iso = state.board.now;
  const base = minutesIntoDay(iso);
  if (base === null) return { key: null, minutes: null };
  const elapsed = Math.max(0, Date.now() - state.boardAt) / 60_000;
  const total = base + elapsed;
  const daysOver = Math.floor(total / 1440);
  const key = daysOver ? addDaysToKey(dayKey(iso), daysOver) : dayKey(iso);
  if (!key) return { key: null, minutes: null };
  return { key, minutes: total - daysOver * 1440 };
}

/**
 * What a pane shows for a bucket. Snoozed rows are excluded on purpose: the
 * whole point of a snooze is that the thing leaves the board until its time,
 * and a pane that still lists it — while the count above says otherwise — is
 * two answers to one question. The snoozed live in their own folded section on
 * Now, via snoozedItems().
 */
export function itemsInBucket(bucket) {
  return state.board.items.filter((i) =>
    i.bucket === bucket && i.state !== 'done' && i.state !== 'dismissed' && i.state !== 'snoozed');
}

export function snoozedItems() {
  return state.board.items.filter((i) => i.state === 'snoozed');
}

/**
 * What was recently finished — done or dismissed — newest first, exactly as
 * /api/state sends it. A separate list, never folded into items[]: everything
 * that reads items[] means "on the board", and search's idea of where a result
 * lives depends on that staying true. An older server has no such field, and
 * the answer is then an empty list, not a crash.
 */
export function finishedItems() {
  const list = state.board.finished;
  return Array.isArray(list) ? list : [];
}

export function openDrafts() {
  return state.board.drafts.filter((d) => d.state === 'pending' || d.state === 'edited');
}

/**
 * The model's narrative notes from the last sweep, filtered the one way.
 *
 * They are counted in two places — the rail's "Worth knowing" row and the
 * section of that name on Now — and this export exists because those two
 * numbers disagreeing is exactly the bug below.
 */
export function boardNotes() {
  return (state.board.notes || []).filter((n) => typeof n === 'string' && n.trim());
}

/**
 * What the rail shows: every bucket, plus the two counts that are not buckets.
 *
 * `note` is the one bucket whose row is not merely its bucket. That row is a
 * LINK to the "Worth knowing" section on Now, and that section shows the note
 * items PLUS the model's narrative notes for the sweep, which no bucket count
 * has ever included. So the rail read "Worth knowing 0" beside a section
 * headed "Worth knowing 3" — on a quiet day by design, since core/triage.mjs
 * is instructed to report a quiet day in `notes` and nowhere else. A number on
 * a link is a claim about what the link opens.
 */
export function railCounts() {
  const counts = state.board.counts || EMPTY_BOARD.counts;
  return {
    ...counts,
    note: (counts.note || 0) + boardNotes().length,
    drafts: openDrafts().length,
    events: eventsToday().length,
  };
}

export function eventsToday() {
  const { key } = nowMark();
  if (!key) return [];
  // Count the same day overlap that the agenda and calendar display, including
  // overnight and multi-day entries but excluding an end at today's midnight.
  return state.board.events.filter((e) => eventSpanOnDay(e, key));
}

/**
 * The open items that arrived with the last check — from STORED timestamps
 * only, never from the model's wording, which rewrites the whole board every
 * run. An item is new iff the last run exists, succeeded, and the item's
 * first_seen is at or after that run's started_at; with no successful last
 * run to compare against, nothing is new. first_seen survives re-runs on
 * purpose (core/db.mjs), which is exactly what makes it usable here. The rule
 * itself lives in ONE place — format.js's isNewSince, the same predicate the
 * rows use for their "new" mark — so the count and the marks cannot drift.
 */
export function newSinceLastCheck() {
  const last = state.board.runs?.last;
  return state.board.items.filter((i) => isNewSince(i, last));
}

/**
 * The words for the NEXT check, from /api/health's scheduler block — or ''
 * when the server made no claim (an older build, health not loaded yet, a
 * one-shot server with nothing armed). The off switch outranks a leftover
 * target time: "automatic checks are off" is the truth that matters then.
 */
export function checkAgainLine(scheduler) {
  if (!scheduler || typeof scheduler !== 'object') return '';
  if (scheduler.auto === false) return 'automatic checks are off';
  const at = formatTime(scheduler.nextRunAt);
  return at ? `checks again around ${at}` : '';
}

/* ------------------------------------------------------------ event window */

/**
 * The `{from, to}` day keys /api/state said its `events` covers, or null when it
 * said nothing.
 *
 * Validated rather than trusted, and shaped so a partial answer is no answer:
 * a window with one end missing cannot decide whether a day is inside it, and
 * half a claim used as a whole one is how a grid ends up marking arbitrary days
 * "not loaded". Both ends or nothing.
 */
export function eventWindow() {
  const w = state.board.eventWindow;
  if (!w || typeof w !== 'object') return null;
  const key = /^\d{4}-\d{2}-\d{2}$/;
  if (!key.test(String(w.from ?? '')) || !key.test(String(w.to ?? ''))) return null;
  return { from: w.from, to: w.to };
}

/**
 * Whether `events` is an answer about this day at all.
 *
 * The distinction the calendar needs is not "are there events on this day" but
 * "was this day in the question" — a day inside the window with nothing on it is
 * a genuinely free day, and a day outside it is a day nobody asked about. Those
 * two rendered identically, and the second is the one that reads as a confident
 * lie. With no window (an older server, or before the first fetch) every day is
 * loaded, which is the behaviour every build before this one had.
 *
 * Day keys are `YYYY-MM-DD`, so `<=`/`>=` on the strings IS the date comparison.
 */
export function dayIsLoaded(key) {
  const w = eventWindow();
  if (!w) return true;
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return true;
  return key >= w.from && key <= w.to;
}

/* -------------------------------------------------------------- item actions */

/** What the Undo toast calls the thing it can undo. */
const STATE_VERB = { done: 'Marked done', dismissed: 'Dismissed', snoozed: 'Snoozed' };

export async function setItemState(id, next, { until = undefined, silent = false } = {}) {
  const before = state.board.items;
  const prior = before.find((i) => i.id === id) || null;
  // Optimistic: the board is the user's own decision surface, and a round-trip
  // of latency on "done" makes it feel broken. A failure puts the row back.
  // `snoozed_until` follows the server's rule locally too: it exists only while
  // the state is `snoozed`, and any other state clears it.
  state.board = {
    ...state.board,
    items: before.map((i) => (i.id === id
      ? { ...i, state: next, snoozed_until: next === 'snoozed' ? (until ?? null) : null }
      : i)),
  };
  state.rev += 1;
  emit();
  try {
    await api.setItemState(id, next, until === undefined ? {} : { until });
    await loadBoard();
    // "Done", "dismissed" and "snoozed" all take a row off the board, and all
    // three are one slipped click away from losing something real — so each
    // offers its undo in the toast, restoring the exact prior state, snooze
    // deadline included. The undo itself is silent: a toast offering to undo
    // an undo is a hall of mirrors.
    if (!silent && prior && STATE_VERB[next]) {
      // Restoring to `snoozed` states the deadline explicitly — including an
      // explicit null for the legacy manual snooze, which the server reads as
      // "no deadline" rather than as a request for its morning default. Any
      // other prior state carries no deadline to restore.
      notify(`${STATE_VERB[next]}: ${prior.headline || 'that item'}`, {
        action: {
          label: 'Undo',
          run: () => setItemState(id, prior.state, prior.state === 'snoozed'
            ? { until: prior.snoozed_until ?? null, silent: true }
            : { silent: true }),
        },
      });
    }
  } catch (err) {
    // The row goes back inside the CURRENT items, not via the pre-click
    // snapshot: a refresh can land while the request is out, and restoring
    // `before` wholesale would silently discard everything it brought.
    state.board = {
      ...state.board,
      items: state.board.items.map((i) => (i.id === id && prior
        ? { ...i, state: prior.state, snoozed_until: prior.snoozed_until ?? null }
        : i)),
    };
    notify(`Could not update that item: ${err.message}`, { tone: 'warn' });
  }
  state.rev += 1;
  emit();
}
