/**
 * core/sweep.mjs — the run loop.
 *
 * A sweep is: fetch every enabled source in parallel, persist what came back,
 * decide whether this run has to think, think if so, merge the result, and
 * record what happened. The two properties that matter more than speed:
 *
 *   ISOLATION. One dead IMAP host, one expired calendar URL, one account with
 *   no stored password — none of those may cost the user the rest of the run.
 *   Every source is fetched inside its own try/catch and reports its own
 *   outcome, and the run's `ok` reflects whether the run *worked*, not whether
 *   every source was reachable. A partial board beats an error page.
 *
 *   HONESTY ABOUT COST. A full run calls the model; a light run does not. The
 *   light/full decision is made from what is actually new, not from a timer, so
 *   a quiet afternoon costs nothing and a busy morning is re-thought.
 *
 * Nothing here ever acts on message or model content: text is fetched, stored,
 * rendered into a prompt and rendered into rows. No eval, no exec, no fetch of
 * anything a message asked for.
 */

import { loadConfig } from './config.mjs';
import { complete as llmComplete, extractJSON, LLMError, isLocalAddress } from './llm.mjs';
import { getSecret as realGetSecret, setSecret as realSetSecret, deleteSecret as realDeleteSecret } from './secrets.mjs';
import { readModelKey, isModelKeyRef } from './model-key.mjs';
import {
  enabledSources,
  get as connectorFor,
  originsFor,
  sourceCursorKey,
  sourceStateKey,
} from './connectors/index.mjs';
import { ICS_MAX_INSTANCES } from './connectors/calendar.mjs';
import { read as imapRead } from './connectors/imap.mjs';
import { AuthError, RateLimitError, AUTH_BLOCK_MS, createHttp, createMeter, secretHash } from './connectors/http.mjs';
import {
  upsertMessages,
  upsertEvents,
  reconcileEvents,
  reconcileTaskActivity,
  listMessages,
  listEvents,
  listCaptures,
  markCaptureProcessed,
  listBoard,
  bucketCounts,
  startRun,
  finishRun,
  lastRun,
  getKV,
  setKV,
  getItem,
  setItemBucket,
  withTransaction,
} from './db.mjs';
import { buildSweepPrompt, mergeSweep, SWEEP_KV } from './triage.mjs';
import { cap, screenContent, SafetyError } from './safety.mjs';
import { SAMPLE_SOURCE_ID, SAMPLE_CALENDAR_ID, SAMPLE_MARK } from './sample-data.mjs';
import {
  nowISO,
  instant,
  toZonedISO,
  wallClock,
  dayKey,
  addDaysToKey,
  localTimezone,
} from './time.mjs';
import { log } from './log.mjs';
import { recordSourceResults } from './source-status.mjs';

const slog = log.child('[sweep]');

/*
 * What core/model-key.mjs needs to read the key for the configured AI service.
 * A pre-upgrade `model.default` key is moved only when the sweep reads the real
 * secret store: a test's fake `getSecret` must never lead to a write in the
 * real one.
 */
function modelKeyDeps(getSecret, config) {
  const real = getSecret === realGetSecret;
  return {
    getSecret,
    setSecret: real ? realSetSecret : null,
    deleteSecret: real ? realDeleteSecret : null,
    configuredBaseUrl: config?.model?.baseUrl ?? null,
    log: slog,
  };
}

/** A full run is forced after this long regardless of how quiet things were. */
export const FULL_RUN_MAX_AGE_MS = 4 * 60 * 60 * 1000;

/** Calendar window fetched and stored, relative to now. */
const CALENDAR_BACK_DAYS = 7;
const CALENDAR_FORWARD_DAYS = 60;

/** How much history the prompt draws on, independent of what a fetch returned. */
const PROMPT_LOOKBACK_DAYS = 21;
const PROMPT_MESSAGE_LIMIT = 600;

/**
 * How many items may sit in `now` on the persisted board.
 *
 * The same four core/safety.mjs allows in a single reply, and it is the same
 * number for a reason: the promise the product makes is about the board the user
 * opens, not about one exchange with a model.
 */
const NOW_BOARD_LIMIT = 4;

/**
 * How many finished items are named back to the model as already handled.
 *
 * The window they are drawn from is PROMPT_LOOKBACK_DAYS, the prompt's own mail
 * lookback, and that is the whole justification for the number: the only way a
 * closed item comes back is for the model to read the mail that produced it and
 * write it up again, and no mail older than that window is in front of it. A
 * resolution older than the oldest message in the prompt cannot be re-raised from
 * that message, so paying context for it would buy nothing. The ceiling matches
 * the 120 open items the prior board itself may carry, and is affordable for the
 * same reason that number is: past the few that get full lines, a closed item
 * costs the prompt only its key on the compact keys line, and the prompt's
 * budget trims further if it has to. It was 40 when every named item cost a
 * full line — and a busy three weeks can close more than 40, so everything past
 * the ceiling was re-raised as if the user had never done it.
 */
const RESOLVED_LIMIT = 120;

/**
 * How large a cursor may be, serialised.
 *
 * `kv` has no ceiling of its own, and a connector caching a page of results in
 * its cursor would be a second message store with no index, no search and no
 * cleanup — one that /api/state never shows and no `zelos doctor` check counts.
 * Four kilobytes is generous for the thing a cursor actually is: a page token,
 * an ETag, a high-water timestamp.
 */
const CURSOR_MAX_CHARS = 4096;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function activeHoursOf(config) {
  const raw = config?.sweep?.activeHours;
  if (Array.isArray(raw) && raw.length === 2) {
    const start = Number(raw[0]);
    const end = Number(raw[1]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 24 && start < end) {
      return [start, end];
    }
  }
  return [6, 23];
}

function intervalMinutesOf(config) {
  const n = Number(config?.sweep?.intervalMinutes);
  if (!Number.isFinite(n)) return 30;
  return Math.min(1440, Math.max(5, Math.round(n)));
}

function timezoneOf(config) {
  const tz = config?.identity?.timezone;
  return typeof tz === 'string' && tz.trim() ? tz : localTimezone();
}

/**
 * The instant at which `hour:00` falls on the day `ms` lands on in `tz`,
 * optionally shifted by whole days.
 *
 * Built by rewriting the time portion of a zoned ISO string rather than by
 * arithmetic on a Date, because the offset is only correct for the day it was
 * read from. Across a DST boundary the first guess can land an hour out, so the
 * result is re-read in the zone and corrected once — twice is never needed for a
 * one-hour transition, and a zone with a stranger rule still lands within an hour.
 */
function atHourInZone(ms, hour, tz, dayShift = 0) {
  const w = wallClock(toZonedISO(new Date(ms), tz));
  if (!w) return ms;
  const pad = (n) => String(n).padStart(2, '0');
  let key = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  if (dayShift) key = addDaysToKey(key, dayShift) || key;
  const guess = Date.parse(`${key}T${pad(hour)}:00:00${w.offset || 'Z'}`);
  if (Number.isNaN(guess)) return ms;
  const check = wallClock(toZonedISO(new Date(guess), tz));
  if (check && check.hour !== hour) return guess + (hour - check.hour) * 3_600_000;
  return guess;
}

/**
 * When the next automatic sweep is due: one interval from `now`, pushed forward
 * to the next moment inside the active hours if that lands outside them.
 * -> ISO8601 string carrying the user's offset.
 */
export function nextRunAt(config, now = nowISO()) {
  const tz = timezoneOf(config);
  const [startHour, endHour] = activeHoursOf(config);
  const base = instant(now) ?? Date.now();
  let t = base + intervalMinutesOf(config) * 60_000;

  const hourAt = (ms) => wallClock(toZonedISO(new Date(ms), tz))?.hour ?? 0;
  const h = hourAt(t);
  if (h < startHour) t = atHourInZone(t, startHour, tz);
  else if (h >= endHour) t = atHourInZone(t, startHour, tz, 1);

  return toZonedISO(new Date(t), tz);
}

/** True when `now` sits inside the configured active hours. */
export function isActiveHour(config, now = nowISO()) {
  const [startHour, endHour] = activeHoursOf(config);
  const w = wallClock(now);
  if (!w) return true;
  return w.hour >= startHour && w.hour < endHour;
}

/**
 * Light or full?
 *
 * Full when the model has something new to think about — mail or events that
 * were inserted or materially changed since the last successful full run, or a
 * note the user typed that has not been triaged — or when the last full run is
 * old enough that the world has moved on regardless.
 *
 * "New" means source information changed, counted as it is stored, not
 * `fetched_at > lastRun`: every sweep re-touches `fetched_at` on every message
 * it re-reads, so a timestamp comparison would make every run a full run and the
 * light/full distinction would quietly stop existing.
 */
export function shouldRunFull(db, config, now = nowISO()) {
  const last = lastRun(db, { kind: 'full', okOnly: true });
  if (!last || !last.started_at) return true;

  if (Number(getKV(db, SWEEP_KV.pendingNew)) > 0) return true;
  // The same SAMPLE_MARK filter gatherPromptInput applies, and it has to be:
  // the demo capture never reaches a prompt, so nothing ever marks it processed
  // — counting it here made every scheduled sweep a full, model-billed run for
  // as long as the demo sat on the board, on a home with nothing new in it.
  if (listCaptures(db, { includeProcessed: false, limit: 50 })
    .some((c) => !String(c.text || '').startsWith(SAMPLE_MARK))) return true;

  const lastMs = instant(last.started_at);
  const nowMs = instant(now) ?? Date.now();
  if (lastMs === null) return true;
  return nowMs - lastMs >= FULL_RUN_MAX_AGE_MS;
}

function bumpPendingNew(db, n) {
  if (!n) return;
  const current = Number(getKV(db, SWEEP_KV.pendingNew)) || 0;
  setKV(db, SWEEP_KV.pendingNew, String(current + n));
}

/* ------------------------------------------------------------------ *
 * Sources
 *
 * Everything that knows what a particular KIND of source is like now lives in
 * core/connectors/. What is left here is the two default readers, and they are
 * left here because they are the shape of `deps` — the seam the desktop shell
 * and 38 tests inject through. Their signatures are byte-identical to what they
 * were when they held the vendor branches themselves; that is the whole
 * migration gate, and it is why `deps.fetchEvents` stays FAMILY-level rather
 * than becoming three per-kind seams.
 * ------------------------------------------------------------------ */

/**
 * Carry "this was truncated" back out with the events.
 *
 * A property on the array rather than a `{events, truncated}` wrapper, because
 * the caller spreads and maps the result and both of those drop it silently —
 * so the shape stays exactly what every existing caller, including an injected
 * `deps.fetchEvents`, already returns. The reader is the calendar connector,
 * which looks at it BEFORE the `.map`.
 */
function markTruncated(events) {
  const list = Array.isArray(events) ? events : [];
  list.truncated = true;
  return list;
}

/**
 * The default calendar reader: whichever connector the kind names.
 *
 * The two `calendar.kind` comparisons this function used to open with are gone;
 * the registry answers the same question and a fourth calendar kind adds no
 * line here. What did NOT change is the argument object, the return value, or
 * the fact that a truncated read comes back as an array wearing a property.
 */
async function defaultFetchEvents({ calendar, pass, from, to, timezone, email, signal }) {
  // The same fallback enabledSources applies: a kind that names no connector is
  // read as a subscribed .ics. Re-deriving strictly here threw `no calendar
  // reader named webcal` one layer under the registry that had just routed the
  // calendar to the ics reader — an error row every sweep, while `zelos doctor`
  // read the same address as a subscribed .ics and passed it.
  const connector = connectorFor(calendar.kind) ?? connectorFor('ics');
  if (!connector || typeof connector.read !== 'function') {
    throw new Error(`no calendar reader named ${calendar.kind}`);
  }
  const { events, truncated, incomplete } = await connector.read({
    source: calendar,
    pass,
    signal,
    window: { from, to, tzid: timezone, email, max: ICS_MAX_INSTANCES },
  });
  if (incomplete && Array.isArray(events)) Object.defineProperty(events, 'incomplete', { value: true, configurable: true });
  return truncated ? markTruncated(events) : events;
}

/**
 * The default mail reader.
 *
 * A shim, and worth its two lines: `{...DEFAULT_DEPS, ...deps}` below replaces
 * exactly this function when a caller injects one, and naming it here keeps the
 * seam visible from the run loop rather than only from the connector. The body,
 * and the paragraph explaining why `requireTls` is forwarded with `??` and not
 * `||`, moved to core/connectors/imap.mjs with the rest of IMAP's semantics.
 */
function defaultFetchMail({ account, mailbox, pass, sinceDays, limit, onProgress, signal }) {
  return imapRead({ account, mailbox, pass, sinceDays, limit, onProgress, signal });
}

const DEFAULT_DEPS = Object.freeze({
  fetchMail: defaultFetchMail,
  fetchEvents: defaultFetchEvents,
  complete: llmComplete,
  getSecret: realGetSecret,
});

/* ------------------------------------------------------------------ *
 * Per-source memory: a cursor and a state row
 *
 * Two `kv` rows per source, following the SWEEP_KV pattern in core/triage.mjs.
 * No collision is possible: SWEEP_KV's five keys are all `sweep.*` and these
 * are all `source.*`.
 *
 *   source.<id>.cursor   opaque, whatever the connector last returned
 *   source.<id>.state    {lastAt, lastOkAt, notBefore, authBlockedUntil,
 *                         secretHash, spent, windowStartedAt}
 *
 * TWO ROWS RATHER THAN ONE, AND THE SPLIT IS LOAD-BEARING. The cursor is
 * written only when the fetch succeeded AND the rows were stored; the state is
 * written on every attempt, including the failures. Shared, a failed run would
 * either lose the record of the failure or lose the cursor.
 *
 * Neither row is created for a source that has nothing to remember, which is
 * why the four connectors that predate this — imap, ics, caldav, file — leave
 * `kv` exactly as they found it. They declare no limits and return no cursor,
 * so there is nothing a later run would read.
 * ------------------------------------------------------------------ */

function readSourceState(db, id) {
  try {
    const raw = getKV(db, sourceStateKey(id));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A state row we cannot read is a state row we ignore: the worst it costs
    // is one early retry, and refusing to sweep over it would be absurd.
    return {};
  }
}

function writeSourceState(db, id, state) {
  setKV(db, sourceStateKey(id), JSON.stringify(state));
}

function readCursor(db, id) {
  try {
    const raw = getKV(db, sourceCursorKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Store what a connector handed back, or refuse it and say why.
 *
 * `null` clears the row — that is how a connector says "the validator I was
 * using is gone, start clean" — while `undefined` never reaches here at all and
 * means "leave whatever was there". Anything that will not serialise, or that
 * is larger than a cursor has any business being, is dropped rather than
 * stored: the alternative is a `kv` row nobody can read and a sweep that fails
 * on it at the same point every time.
 */
function writeCursor(db, id, cursor) {
  if (cursor === null) {
    setKV(db, sourceCursorKey(id), '');
    return;
  }
  let text;
  try {
    text = JSON.stringify(cursor);
  } catch (err) {
    slog.warn('a source returned a cursor that will not serialise; ignoring it', { id, error: errorText(err) });
    return;
  }
  if (typeof text !== 'string') return;
  if (text.length > CURSOR_MAX_CHARS) {
    slog.warn('a source returned a cursor larger than the ceiling; ignoring it', { id, chars: text.length, max: CURSOR_MAX_CHARS });
    return;
  }
  setKV(db, sourceCursorKey(id), text);
}

/** True when a connector could ever read its own state back. */
function keepsState(connector) {
  const lim = connector?.limits ?? {};
  return (lim.minIntervalMs > 0) || !!lim.budget;
}

/**
 * Is this source resting, and why?
 *
 * -> null to read it, or a sentence for the debug log.
 *
 * A gated source pushes NOTHING into `sources[]`. It did not fail, and its rows
 * are already in the database — `gatherPromptInput` reads from there, not from
 * this fetch — so the board is identical either way. Reporting it as `ok: true`
 * with a count of zero would inflate `stats.sourcesOk`, a number three files
 * consume, with sources that were never read; reporting it as a failure would
 * put a red banner on the screen forty-seven times a day for a source that is
 * deliberately resting. Nothing outside this file reads `source.<id>.state`,
 * so a rest is invisible by design — which is also why the refused-credential
 * rest (`authResting`, and the `stillRefused` branch in runSweep) is the one
 * rest that IS pushed: that source is waiting on the user, not pacing itself.
 */
function restingFor(connector, state, nowMs) {
  const minInterval = Number(connector?.limits?.minIntervalMs) || 0;
  const lastAt = Number(state.lastAt) || 0;
  if (minInterval > 0 && lastAt && nowMs - lastAt < minInterval) {
    return `read ${Math.round((nowMs - lastAt) / 1000)}s ago; this source asks for ${Math.round(minInterval / 1000)}s between reads`;
  }
  const notBefore = Number(state.notBefore) || 0;
  if (notBefore && nowMs < notBefore) {
    return `rate limited; not before ${new Date(notBefore).toISOString()}`;
  }
  return null;
}

/**
 * Is this source resting on a credential the host already refused?
 *
 * Checked after the secret is read, because the answer depends on WHICH secret:
 * the block lifts the moment the stored credential changes. That is the real
 * shape of the failure — the user rotates a token and pastes a narrower one —
 * and it is why the hash is stored rather than a flag. Retrying a 401 against a
 * host that allows fifty calls a day burns forty-eight of them before lunch.
 */
/**
 * Stamp a row with the source it came from — and nothing else.
 *
 * The one thing this must NOT do is fill in a `uid`. core/db.mjs:384 reads
 * `Number.isFinite(Number(msg.uid)) ? Number(msg.uid) : null`, so an OMITTED uid
 * becomes null and `uid: null` becomes 0 — two different `messageRowId`s for the
 * same message (measured: 58ac70ac2a9131aa against 36c5d228c13041e4). If this
 * function normalised a missing uid to null "for tidiness", every connector
 * without an integer identity would re-insert every row it has ever seen on
 * every sweep: `stats.newMessages` would never settle, `shouldRunFull` would
 * force a full run every time, and the user would be billed for a model call
 * every thirty minutes. The spread copies what the connector emitted, exactly.
 */
function stampFor(connector, source) {
  return connector.sink === 'events'
    ? (row) => ({ ...row, calendarId: source.id })
    : (row) => ({ ...row, sourceId: source.id });
}

function authResting(state, secret, nowMs) {
  const until = Number(state.authBlockedUntil) || 0;
  if (!until || nowMs >= until) return null;
  if (state.secretHash && state.secretHash !== secretHash(secret)) return null;
  return `The saved sign-in or key was refused, so Zelos is not trying it again until ${new Date(until).toISOString()} — or as soon as you sign in again or enter a new one in Settings.`;
}

function errorText(err) {
  if (!err) return 'unknown error';
  if (err instanceof LLMError && err.address) return err.message;
  return err.message || String(err);
}

/**
 * How much of a failure's own words survive into the run record.
 *
 * Every string in this file that describes a failure ends up in three places
 * that are not this process: `runs.error` and `runs.stats_json` in SQLite,
 * `/api/state` on every board read (and every three-minute heartbeat behind
 * it), and the Settings export. IMAP is the source that makes that dangerous —
 * `err.message` there is server-supplied text with no ceiling of its own, and a
 * hostile or broken mail server can put an arbitrary amount of it in a tagged
 * `NO` or a flushed `* BYE`. Measured against a mock that answered with 48 MiB:
 * the stored `sources[0].error` was 50,331,713 characters and `GET /api/state`
 * answered 200 with a 50,332,527-byte body, on every read, until the next
 * successful sweep.
 *
 * 500 characters is chosen against the reader, not the writer: the banner in
 * ui/views/now.js prints `label: error` in a list item, and a sentence longer
 * than this is already past the point where anybody reads it. Nothing in the
 * repo's own vocabulary of failures comes close to the ceiling — CalDAV's are
 * fixed templates and the model adapter caps its own at 400 — so this only ever
 * fires on text that came from a stranger's server.
 */
const ERROR_CHARS = 500;

/** `errorText`, bounded. Every path that stores or serves a failure uses this. */
function storedError(err) {
  return cap(errorText(err), ERROR_CHARS);
}

/**
 * The same ceiling for a sentence this file wrote AROUND a stranger's words.
 *
 * `finish(false, …)` messages are prose with `errorText` interpolated into
 * them, so capping only the interpolation would still let the sentence carry an
 * unbounded tail if one were ever added. Capping the finished sentence is the
 * property that actually matters — `runs.error` is one column — and the prose
 * is short enough that the budget is spent on the part that came from outside.
 */
function storedMessage(text) {
  return cap(text, ERROR_CHARS);
}

/**
 * A fragment of model output, safe to store beside an error.
 *
 * The "it began …" quotes below exist so a person can see WHY a reply was not a
 * board, and they are already length-capped. Length is not the risk: the string
 * is model output, it lands in `runs.error`, and `runs.error` is re-served by
 * /api/state and copied into the settings export — so `<script>` reaching it is
 * exactly the case docs/SECURITY.md says never happens ("a string trying to be
 * markup never reaches storage, a log, a clipboard, or an export"). Screened
 * rather than escaped: the sample is a courtesy, and dropping it costs the
 * reader a hint, while keeping it costs the product a stated guarantee.
 */
function modelSample(text) {
  const sample = String(text ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
  if (!sample) return '';
  try {
    return screenContent(sample);
  } catch (err) {
    if (err instanceof SafetyError) return '';
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * runSweep
 * ------------------------------------------------------------------ */

/**
 * What an unlabelled calendar is called on the board: the site its address is
 * on, never the address. The label fell back to `source.url` whole, and for an
 * .ics subscription that URL is the credential — Google's "Secret address in
 * iCal format" — so it went into `runs.stats_json`, the Now banner, the log
 * line below, and from /api/state into the board snapshot (QA, 2026-10-10,
 * TT-3423). A local file's path is not a secret and stays as it was.
 */
function siteOf(address) {
  const raw = typeof address === 'string' ? address.trim() : '';
  if (!/^(?:https?|webcal):/i.test(raw)) return raw;
  try { return new URL(raw).host || 'calendar'; } catch { return 'calendar'; }
}

/**
 * Run one sweep.
 *
 * -> {runId, ok, stats:{messages, events, items, now, tokensIn, tokensOut, ms}, error?}
 *
 * `deps` is a seam for tests and for the desktop shell: it replaces the mail
 * reader, the calendar reader, the model call and the secret lookup with
 * anything of the same shape. It defaults to the real modules, so production
 * callers pass `{db, config}` and nothing else.
 */
export async function runSweep({
  db,
  config = loadConfig(),
  mode = 'auto',
  onProgress,
  signal,
  deps = {},
} = {}) {
  if (!db) throw new TypeError('runSweep: a database handle is required');
  const { fetchMail, fetchEvents, complete, getSecret } = { ...DEFAULT_DEPS, ...deps };

  const startedMs = Date.now();
  const tz = timezoneOf(config);
  const now = nowISO(tz);
  const identityEmail = String(config?.identity?.email ?? '');

  const emit = (phase, message, done = 0, total = 0, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ phase, message, done, total, ...extra });
    } catch (err) {
      // A listener that throws is the listener's problem, not the sweep's.
      slog.debug('onProgress listener threw', { error: err.message });
    }
  };

  const wantFull = mode === 'full' ? true : mode === 'light' ? false : shouldRunFull(db, config, now);
  const runId = startRun(db, { kind: wantFull ? 'full' : 'light', model: config?.model?.model ?? '', now });
  emit('start', wantFull ? 'Starting a full sweep' : 'Starting a light sweep', 0, 0, { runId });

  const sources = [];
  const stats = {
    messages: 0,
    events: 0,
    items: 0,
    now: 0,
    tokensIn: 0,
    tokensOut: 0,
    ms: 0,
    kind: wantFull ? 'full' : 'light',
    newMessages: 0,
    newEvents: 0,
    changedMessages: 0,
    changedEvents: 0,
    removedEvents: 0,
    taskActivityChanges: 0,
    sourcesOk: 0,
    sourcesFailed: 0,
  };

  const abort = () => signal?.aborted === true;
  const finish = (ok, error, extra = {}) => {
    stats.ms = Date.now() - startedMs;
    const endedAt = nowISO(tz);
    recordSourceResults(db, sources, now);
    finishRun(db, runId, {
      ok,
      error,
      tokensIn: stats.tokensIn,
      tokensOut: stats.tokensOut,
      stats: { ...stats, sources },
      now: endedAt,
    });
    // Spend is recorded whether or not the run succeeded. A run that failed
    // after the model answered — a reply that was cut off, or JSON that was not
    // a board — was still billed for every token of it, and that is precisely
    // the spend a user would be most surprised to find missing from the counter.
    // What a failed run does not add to is the run counts: it spent money and it
    // produced no board, and those are two different things to be honest about.
    recordTokens(db, {
      tokensIn: stats.tokensIn,
      tokensOut: stats.tokensOut,
      thought: stats.kind === 'full',
      ok,
      now: endedAt,
    });
    const result = { runId, ok, stats: { ...stats, sources }, ...extra };
    if (error) result.error = error;
    emit(ok ? 'done' : 'error', error || 'Sweep complete', 1, 1, { runId });
    return result;
  };

  /* ---- 1. fetch every source, in parallel, isolated ---------------- */

  emit('fetch', 'Reading mail and calendars', 0, 0);

  const from = new Date(Date.now() - CALENDAR_BACK_DAYS * 86_400_000).toISOString();
  const to = new Date(Date.now() + CALENDAR_FORWARD_DAYS * 86_400_000).toISOString();

  /**
   * One loop, every source, whatever kind it is.
   *
   * This replaced two near-identical loops — one for mail, one for calendars —
   * that between them held every string a user reads when a fetch goes wrong.
   * The acceptance criterion for the replacement was that every one of those
   * strings comes out byte-identical, so they are quoted here rather than
   * rephrased: `label` falls through the same chain (`host` is undefined on a
   * calendar and `url` is undefined on a mail account, so each lands where it
   * always did — verified against both of the chains this replaced; a
   * calendar's address now lands as its site, see `siteOf`), and the
   * no-password sentence is the sentence, not a description of one.
   */
  const sourceTasks = enabledSources(config).map(async ({ connector, source }) => {
    const label = source.label || source.host || siteOf(source.url) || source.id;
    const nothing = { sink: connector.sink, rows: [], cursor: undefined, sourceId: source.id };
    const state = readSourceState(db, source.id);
    const startedMs = Date.now();

    const resting = restingFor(connector, state, startedMs);
    if (resting) {
      slog.debug(`source resting: ${label}`, { id: source.id, why: resting });
      return nothing;
    }

    /* The keyRef is used exactly as configured and is never synthesised here. A
       calendar saved before the Settings editor started minting
       `calendar.${id}` has none, and inventing one would make this loop look up
       a secret for a source that has never had one — a lookup that does not
       happen today. core/config.mjs mints the default where the entry is
       created, which is the only place that can know it is new. */
    // The AI key is read only for the AI's own address. A source configured
    // with a `model.` ref is refused, not handed the key to send somewhere else.
    if (isModelKeyRef(source.keyRef)) {
      sources.push({ kind: connector.family, id: source.id, label, ok: false, count: 0, error: `${label} is set to use the AI service's key. Give it its own password in Settings.` });
      return nothing;
    }
    let secret = null;
    try {
      secret = source.keyRef ? await getSecret(source.keyRef) : null;
    } catch (err) {
      sources.push({ kind: connector.family, id: source.id, label, ok: false, count: 0, error: storedError(err) });
      return nothing;
    }
    if (connector.credential?.required && !secret) {
      sources.push({
        kind: connector.family,
        id: source.id,
        label,
        ok: false,
        count: 0,
        error: `No password stored for ${label}. Add it in Settings — Zelos never writes it to disk in the clear.`,
      });
      return nothing;
    }

    const stillRefused = authResting(state, secret, startedMs);
    if (stillRefused) {
      /* Reported, unlike the rests above. A rate-limit rest is minutes and
         fixes itself; a refused credential rests for six hours and fixes
         nothing — it is waiting on the user. Silence here meant the sweep that
         hit the 401 pushed `ok: false` and the next eleven pushed nothing, and
         since the Now banner, /api/state and the run record read only
         `stats.sources` (no reader of `source.<id>.state` exists), a revoked
         token was red for one sweep and then a quiet day for the remaining
         five and a half hours of every block. The sentence is the one
         `authResting` already writes to the debug log, so the user reads what
         the log reads: not until when, and that a new credential lifts it. */
      slog.debug(`source resting: ${label}`, { id: source.id, why: stillRefused });
      sources.push({ kind: connector.family, id: source.id, label, ok: false, count: 0, error: storedError(stillRefused),
        attempted: false, retryAt: new Date(state.authBlockedUntil).toISOString() });
      return nothing;
    }

    const meter = createMeter(connector.limits, state, startedMs);
    const record = (patch) => {
      // Written only when something would read it back. The four connectors
      // that predate this interface declare no limits and return no cursor, so
      // they leave `kv` exactly as they found it.
      const next = { ...state, lastAt: startedMs, spent: meter.spent, windowStartedAt: meter.windowStartedAt, ...patch };
      if (keepsState(connector) || Object.keys(state).length || patch.authBlockedUntil || patch.notBefore) {
        writeSourceState(db, source.id, next);
      }
    };

    try {
      const result = await connector.collect({
        source,
        label,
        secret,
        cursor: readCursor(db, source.id),
        window: { from, to },
        timezone: tz,
        identityEmail,
        now,
        emit: (message, done = 0, total = 0) => emit(connector.family, message, done, total),
        signal,
        log: slog.child(`[${connector.type} ${source.id}]`),
        http: createHttp({
          origins: originsFor(connector, source),
          limits: connector.limits,
          credential: connector.credential,
          graphql: connector.graphql === true,
          secret,
          signal,
          meter,
          log: slog,
        }),
        /* The sweep's own injected deps, and ONLY the four that already exist.
           `fetchMail` and `fetchEvents` are here because imap, ics, caldav and
           file are older than this interface and the suite injects through
           them; a new connector reaches the network through `ctx.http` and has
           no business knowing this field is here. */
        deps: { fetchMail, fetchEvents },
      });

      const rows = [];
      let snapshotComplete = connector.sink === 'events' && result?.snapshotComplete === true;
      // Only an opted-in task connector may describe a complete selection.
      // The selection key records filter changes without storing their text.
      const taskSnapshot = connector.taskPrefix && typeof result?.taskSnapshot?.selection === 'string' && result.taskSnapshot.selection
        ? { prefix: connector.taskPrefix, selection: secretHash(result.taskSnapshot.selection),
          complete: result.taskSnapshot.complete === true && Array.isArray(result.parts) && result.parts.length > 0 }
        : null;
      const maxRows = Number.isInteger(connector.limits.maxRows) ? connector.limits.maxRows : null;
      for (const part of result?.parts || []) {
        const at = part.label ? `${label} / ${part.label}` : label;
        if (part.error) {
          snapshotComplete = false;
          if (taskSnapshot) taskSnapshot.complete = false;
          slog.warn(`${connector.family} source failed: ${at}`, { error: storedError(part.error) });
          sources.push({ kind: connector.family, id: source.id, label: at, ok: false, count: 0, error: storedError(part.error) });
          continue;
        }
        let kept = Array.isArray(part.rows) ? part.rows : [];
        let note = part.note ?? null;
        if (maxRows !== null && kept.length > maxRows) {
          // The same shape a truncated calendar reports: a non-zero count with
          // `ok: false`, because "I read the first 200 and dropped the rest" is
          // neither a success nor a failure.
          note = note || `This source returned ${kept.length.toLocaleString('en-US')} entries and Zelos keeps ${maxRows.toLocaleString('en-US')}, so the rest were dropped.`;
          kept = kept.slice(0, maxRows);
        }
        if (note || !Array.isArray(part.rows)) snapshotComplete = false;
        if (taskSnapshot && (note || !Array.isArray(part.rows))) taskSnapshot.complete = false;
        rows.push(...kept.map(stampFor(connector, source)));
        sources.push({
          kind: connector.family,
          id: source.id,
          label: at,
          ok: !note,
          count: kept.length,
          error: note ? storedError(note) : null,
        });
      }

      /* A source is "read" when something was. Every part failing is not that:
         recording it as read cleared a credential's rest and claimed a success
         for a mailbox that was refused, which is how a revoked sign-in went on
         being retried every sweep. */
      const parts = result?.parts || [];
      const read = parts.length === 0 || parts.some((part) => !part.error);
      record(read ? { lastOkAt: startedMs, notBefore: 0, authBlockedUntil: 0, secretHash: null } : {});
      return { sink: connector.sink, rows, cursor: result?.cursor, sourceId: source.id, snapshotComplete, taskSnapshot };
    } catch (err) {
      slog.warn(`${connector.family} source failed: ${label}`, { error: storedError(err) });
      sources.push({ kind: connector.family, id: source.id, label, ok: false, count: 0, error: storedError(err) });
      /* The only two failures Zelos reacts to rather than merely reports.
         Everything else is "try again next sweep", which is today's behaviour
         and is right: an unreachable host is the case this product is built
         around. A refused credential and a stated rate limit are different —
         retrying either costs the user something and buys nothing. */
      if (err instanceof AuthError) {
        /* Hashed as it is now, not as it was read at the start: an OAuth mail
           account refreshes its token during the sweep and saves the new grant
           under the same ref, and a rest keyed to the old one lifted itself on
           the very next sweep. */
        let current = secret;
        try { current = source.keyRef ? await getSecret(source.keyRef) : secret; } catch { /* keep the one we read */ }
        record({ authBlockedUntil: startedMs + AUTH_BLOCK_MS, secretHash: secretHash(current) });
      } else if (err instanceof RateLimitError) {
        record({ notBefore: startedMs + (err.retryAfterMs || 0) });
      } else {
        record({});
      }
      return nothing;
    }
  });

  const results = await Promise.all(sourceTasks);
  const fetchedMessages = [];
  const fetchedEvents = [];
  for (const r of results) {
    if (r.sink === 'events') fetchedEvents.push(...r.rows);
    else fetchedMessages.push(...r.rows);
  }

  stats.sourcesOk = sources.filter((s) => s.ok).length;
  stats.sourcesFailed = sources.length - stats.sourcesOk;

  if (abort()) return finish(false, 'Sweep cancelled');

  /* ---- 2. persist ------------------------------------------------- */

  emit('persist', `Storing ${fetchedMessages.length} messages and ${fetchedEvents.length} events`,
    0, fetchedMessages.length + fetchedEvents.length);
  try {
    const m = upsertMessages(db, fetchedMessages, { now });
    stats.messages = m.ids.length;
    stats.newMessages = m.inserted;
    stats.changedMessages = m.changed;
    // Each sink commits separately. Preserve work from this successful write
    // before a later sink can fail, or its retry sees only unchanged rows.
    bumpPendingNew(db, m.inserted + m.changed);
    for (const result of results) {
      if (!result.taskSnapshot) continue;
      const changed = reconcileTaskActivity(db, { sourceId: result.sourceId, ...result.taskSnapshot, rows: result.rows, now });
      stats.taskActivityChanges += changed;
      bumpPendingNew(db, changed);
    }
    const e = upsertEvents(db, fetchedEvents, { now });
    stats.events = e.ids.length;
    stats.newEvents = e.inserted;
    stats.changedEvents = e.changed;
    bumpPendingNew(db, e.inserted + e.changed);
    for (const result of results) {
      if (!result.snapshotComplete) continue;
      const removed = reconcileEvents(db, { calendarId: result.sourceId, events: result.rows, from, to, timezone: tz });
      stats.removedEvents += removed;
      bumpPendingNew(db, removed);
    }
  } catch (err) {
    slog.error('could not store fetched sources', { error: storedError(err) });
    return finish(false, storedMessage(`Could not store what was fetched: ${errorText(err)}`));
  }

  /* ROWS FIRST, CURSORS SECOND, and the order is the guarantee.
     A cursor advanced before the upsert loses rows forever if the process dies
     between the two — the connector would come back next sweep asking for
     everything AFTER a page it never stored. This way round the crash costs one
     repeated fetch and nothing else, because every sink is an upsert on a
     deterministic id (core/db.mjs:270) and the COALESCE at core/db.mjs:369
     already means a cheaper re-fetch never blanks a richer earlier one.
     core/db.mjs:20-24 states that re-fetching is the normal case; this inherits
     that claim rather than reinventing it.

     Deliberately NOT one transaction with the rows. Design work on this
     considered folding both into a single COMMIT and it needs per-source
     persist plus a re-entrancy guard, because `withTransaction` cannot nest —
     `upsertMessages` opens its own and SQLite answers "cannot start a
     transaction within a transaction" (measured on Node 26.3.0). Both of those
     are behaviour changes wearing a refactor's clothes. */
  for (const r of results) {
    if (r.cursor === undefined) continue;
    writeCursor(db, r.sourceId, r.cursor);
  }

  /* ---- 3. light or full ------------------------------------------- */

  let full = wantFull;
  const sourceChanges = stats.newMessages + stats.newEvents + stats.changedMessages + stats.changedEvents + stats.removedEvents + stats.taskActivityChanges;
  if (!full && mode === 'auto' && sourceChanges > 0) {
    // This fetch itself brought in information the model has never seen. Waiting a
    // whole interval to think about it is exactly the delay the product exists
    // to remove.
    full = true;
    stats.kind = 'full';
    setRunKind(db, runId, 'full');
    slog.debug('upgraded a light run to full', { runId, sourceChanges });
  }

  if (!full) {
    const derived = recomputeDerived(db, { now });
    stats.items = derived.open;
    stats.now = derived.counts.now;
    return finish(true, null, { counts: derived.counts, modelCalls: 0 });
  }

  /* ---- 4. think --------------------------------------------------- */

  const promptInput = gatherPromptInput(db, config, now);
  const prompt = buildSweepPrompt({
    identity: config.identity ?? {},
    now,
    messages: promptInput.messages,
    events: promptInput.events,
    captures: promptInput.captures,
    priorItems: promptInput.priorItems,
    resolvedItems: promptInput.resolvedItems,
    privacy: config.privacy ?? {},
  });

  emit('think', `Asking ${config?.model?.label || 'the model'} to read ${promptInput.messages.length} messages`,
    0, 1, { approxChars: prompt.budget.approxChars });

  let apiKey = null;
  try {
    apiKey = await readModelKey(config?.model?.baseUrl, modelKeyDeps(getSecret, config));
  } catch (err) {
    slog.debug('no API key available', { error: errorText(err) });
  }

  let answer;
  try {
    answer = await complete({
      protocol: config?.model?.protocol,
      baseUrl: config?.model?.baseUrl,
      model: config?.model?.model,
      apiKey,
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: config?.model?.maxTokens,
      temperature: config?.model?.temperature,
      json: true,
      signal,
    });
  } catch (err) {
    slog.error('model call failed', { error: storedError(err) });
    return finish(false, storedError(err));
  }

  stats.tokensIn = Number(answer?.usage?.input) || 0;
  stats.tokensOut = Number(answer?.usage?.output) || 0;

  const parsed = extractJSON(answer?.text ?? '');
  // extractJSON is deliberately forgiving, and one thing it forgives is a reply
  // that was cut off mid-board: the first *balanced* object inside a truncated
  // answer is usually some inner fragment — a single item, a stray
  // {"answer": …} — not the board. An object carrying none of the sweep's own
  // top-level keys is that fragment, and letting it through to the merge would
  // record a successful run that produced nothing. It is a failed parse, and is
  // reported as one.
  const looksLikeBoard =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    ('items' in parsed || 'first' in parsed || 'notes' in parsed);
  if (!looksLikeBoard) {
    const sample = modelSample(answer?.text);
    if (answer?.stopReason === 'length') {
      // The reply was cut off at the token ceiling, so no model swap will fix
      // it — the same model with more room will.
      return finish(
        false,
        storedMessage(`The model's reply was cut off at its token limit before the board was complete${sample ? ` — it began "${sample}"` : ''}. Raise model.maxTokens in Settings and sweep again.`),
      );
    }
    return finish(
      false,
      parsed
        ? 'The model replied with JSON, but not with a board — none of items, first or notes were in it. Try a larger model, or one that follows a format instruction.'
        : storedMessage(`The model replied but not with JSON${sample ? ` — it began "${sample}"` : ''}. Try a larger model, or one that follows a format instruction.`),
    );
  }

  /* ---- 5. merge --------------------------------------------------- */

  emit('merge', 'Building the board', 0, 1);
  let merged;
  try {
    merged = mergeSweep(db, parsed, { runId, now });
  } catch (err) {
    slog.error('could not merge the sweep', { error: storedError(err) });
    return finish(false, storedMessage(`Could not store the board: ${errorText(err)}`));
  }

  // ok:false from the merge means the reply was not usable as a sweep result at
  // all — repairs are normal and keep ok:true, this is the reply that had no
  // usable items in it. Recording that as success would be worse than the
  // failure itself: the captures below would be consumed untriaged and
  // pendingNew zeroed, so the mail that prompted this run would never be
  // re-thought. The run fails, nothing is consumed, and the next run tries again.
  if (!merged.ok) {
    slog.error('model reply was not a usable board', {
      runId,
      first: merged.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`),
    });
    const why = merged.errors.slice(0, 2)
      .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
      .join('; ') || 'the reply was not a usable board';
    if (answer?.stopReason === 'length') {
      return finish(
        false,
        storedMessage(`The model's reply was cut off at its token limit before the board was usable (${why}). Raise model.maxTokens in Settings and sweep again.`),
      );
    }
    return finish(
      false,
      storedMessage(`The model's reply was not a usable board (${why}). Try a larger model, or one that follows a format instruction.`),
    );
  }

  // Only the captures that actually reached the model are marked processed —
  // one the budget dropped has not been triaged and must come back next run.
  for (const capture of promptInput.captures.slice(0, prompt.budget.shown.captures)) {
    markCaptureProcessed(db, capture.id, { now });
  }
  setKV(db, SWEEP_KV.pendingNew, '0');

  const derived = recomputeDerived(db, { now });
  stats.items = merged.stats.items;
  // The board's count, not the reply's: this run's four `now` items may have
  // arrived on a board that was already holding four of somebody else's, and the
  // number reported has to be the one the user will see.
  stats.now = derived.counts.now;

  if (merged.errors.length) {
    slog.info(`board accepted with ${merged.errors.length} repair(s)`, {
      runId,
      first: merged.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`),
    });
  }

  return finish(true, null, {
    counts: derived.counts,
    first: merged.first,
    notes: merged.notes,
    repairs: merged.errors,
    modelCalls: 1,
  });
}

/**
 * `runs.kind` is written once by db.startRun, and the light/full decision can
 * legitimately change after the fetch. It reaches past a db.mjs helper because
 * the run's recorded kind must match what the run actually did — shouldRunFull
 * reads it back on the next sweep, and a light-labelled run that thought would
 * make the next decision on a false premise.
 */
function setRunKind(db, runId, kind) {
  db.prepare('UPDATE runs SET kind = ? WHERE id = ?').run(String(kind), String(runId));
}

/**
 * The keys of things the user has already finished, most recently closed first.
 *
 * `listBoard` cannot express this: it ranks by bucket and severity, which is the
 * reading order of live work and says nothing about when a decision was made, so
 * on a board that has been running for months its limit would return the oldest
 * closed items and hide exactly the recent ones that matter. `state_at` is when
 * the user decided, and both sides of the comparison go through datetime() for
 * the same reason listBoard's snooze wake does — the stored timestamps carry the
 * user's offset while `since` is UTC, and comparing those as strings would be
 * wrong by the difference.
 *
 * The ordering goes through datetime() for exactly the same reason, and this is
 * not decoration: the filter and the sort choose the rows together, so a WHERE
 * that reads instants feeding an ORDER BY that reads characters means the LIMIT
 * keeps whichever rows happen to sort well as text. Two items closed a minute
 * apart either side of a timezone change would come back in the wrong order, and
 * the one that fell off the end would be the most recent decision the user made.
 */
const RECENTLY_RESOLVED_SQL = `
SELECT id, bucket, headline, state, state_at, payload_json FROM items
WHERE state IN ('done', 'dismissed') AND state_at IS NOT NULL
  AND datetime(state_at) >= datetime(:since)
ORDER BY datetime(state_at) DESC
LIMIT :limit`;

function recentlyResolved(db, now) {
  const nowMs = instant(now) ?? Date.now();
  const since = new Date(nowMs - PROMPT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = db.prepare(RECENTLY_RESOLVED_SQL).all({ since, limit: RESOLVED_LIMIT });
  const out = [];
  for (const row of rows) {
    let key = '';
    try {
      key = String(JSON.parse(row.payload_json || '{}')?.key ?? '');
    } catch {
      // A row whose payload will not parse has no key to reuse, so it has
      // nothing to contribute here and is simply left out.
      key = '';
    }
    if (!key) continue;
    out.push({ key, headline: row.headline, state: row.state, resolvedAt: row.state_at });
  }
  return out;
}

/**
 * Today's model spend, written where the UI can read it without walking the runs
 * table. `runs` counts every successful sweep and `modelRuns` only the ones that
 * actually thought, because a light run costs nothing and folding it into the
 * same counter would quietly halve what a thinking run appears to cost.
 *
 * The token totals and the run counts answer different questions, so a failed
 * run moves one and not the other: `ok: false` still adds whatever the model
 * charged for the reply that could not be used, and adds nothing to the count of
 * sweeps that happened, because no sweep did.
 *
 * The day rolls over on the user's own day key rather than on UTC — "today" has
 * to mean the day they are having, or the number resets mid-evening.
 *
 * Nothing in here may fail a sweep. This is a display counter: both the read of
 * the old totals and the write of the new ones are caught, because a `kv` table
 * that will not take a write is a reason to lose a number, never a reason to
 * throw away a board the user waited for.
 *
 * `sweep: false` is how a spender that is NOT a sweep books its tokens. The
 * counter used to have exactly one caller — `finish` below — so every token the
 * Ask panel spent was invisible: measured with a mock upstream, twenty
 * `POST /api/ask` calls reporting 100,000 tokens over SSE left `sweep.tokens`
 * null and `/api/state` carrying no `tokens` at all, while the line the user
 * reads ("82k tokens in · 18k out") went on describing sweeps only. Ask is
 * spend, so it moves `tokensIn`/`tokensOut`; it is not a sweep and produced no
 * board, so it must move neither `runs` nor `modelRuns` — those two are what
 * "Zelos asked the model N times today" is counted from, and a question typed
 * into a panel is not a sweep that happened. Exported for the same reason it
 * takes the flag: core/server.mjs's /api/ask handler is the second writer.
 */
export function recordTokens(db, {
  tokensIn = 0,
  tokensOut = 0,
  thought = false,
  ok = true,
  sweep = true,
  now = nowISO(),
} = {}) {
  const today = dayKey(now) || '';
  let stored = null;
  try {
    const raw = getKV(db, SWEEP_KV.tokens);
    if (raw) stored = JSON.parse(raw);
  } catch {
    // Unreadable totals are a display detail, never a reason to fail a run that
    // otherwise worked. Counting starts again from this sweep.
    stored = null;
  }
  if (!stored || typeof stored !== 'object') stored = {};
  const lifetime = stored.lifetime && typeof stored.lifetime === 'object' ? stored.lifetime : {};
  const carried = stored.day === today ? stored : {};
  const num = (v) => Number(v) || 0;

  const ranAsSweep = sweep && ok ? 1 : 0;
  const ranAsModelSweep = sweep && ok && thought ? 1 : 0;

  const totals = {
    day: today,
    tokensIn: num(carried.tokensIn) + num(tokensIn),
    tokensOut: num(carried.tokensOut) + num(tokensOut),
    runs: num(carried.runs) + ranAsSweep,
    modelRuns: num(carried.modelRuns) + ranAsModelSweep,
    lifetime: {
      tokensIn: num(lifetime.tokensIn) + num(tokensIn),
      tokensOut: num(lifetime.tokensOut) + num(tokensOut),
      runs: num(lifetime.runs) + ranAsSweep,
      modelRuns: num(lifetime.modelRuns) + ranAsModelSweep,
    },
    at: now,
  };
  try {
    setKV(db, SWEEP_KV.tokens, JSON.stringify(totals));
  } catch (err) {
    slog.warn('could not record the token counter', { error: errorText(err) });
  }
  return totals;
}

/** What the prompt gets to look at. Read from the database, not from this fetch,
 *  so a run whose IMAP host was down still reasons over the mail it already has. */
function gatherPromptInput(db, config, now) {
  const nowMs = instant(now) ?? Date.now();
  const sinceISO = new Date(nowMs - PROMPT_LOOKBACK_DAYS * 86_400_000).toISOString();
  // Day-key bounds rather than full timestamps: the stored ISO strings carry
  // their own offsets and all-day events are bare dates, so a plain YYYY-MM-DD
  // compares sanely against both shapes where a `...Z` timestamp does not.
  const today = dayKey(now);
  // The demo week lives in the same tables as real mail — that is the point of
  // it — but it must never reach the model: a sweep that reasons over Quillon
  // Row spends real tokens on fiction and can mint board items about people who
  // do not exist. Sample rows are recognisable by the source ids the seed wrote
  // them under, so they are dropped here rather than at the query, which keeps
  // the demo visible in every view while making it invisible to the prompt.
  const messages = listMessages(db, { sinceISO, limit: PROMPT_MESSAGE_LIMIT })
    .filter((m) => m.source_id !== SAMPLE_SOURCE_ID);
  const events = listEvents(db, {
    from: addDaysToKey(today, -2),
    to: addDaysToKey(today, CALENDAR_FORWARD_DAYS + 1),
    limit: 400,
  }).filter((e) => e.calendar_id !== SAMPLE_CALENDAR_ID);
  return {
    messages,
    events,
    // Captures get the same treatment as mail and events: the seed writes one
    // demo capture, marked the way every sample row is marked, and a real
    // sweep must not spend the model's attention triaging it.
    captures: listCaptures(db, { includeProcessed: false, limit: 50 })
      .filter((c) => !String(c.text || '').startsWith(SAMPLE_MARK)),
    priorItems: listBoard(db, { states: ['open', 'snoozed'], limit: 120 }),
    // A finished item's key is otherwise never shown again, and a key the model
    // cannot see is a key it cannot reuse: it rewords the same obligation, mints
    // a fresh key, and work the user already did comes back as new. Naming them
    // is a prompt-side fix — nothing about how state merges changes.
    resolvedItems: recentlyResolved(db, now),
  };
}

/**
 * Hold the four-item `now` bar on the board itself.
 *
 * core/safety.mjs clamps each model reply to four, which is only a guarantee
 * about one exchange. Two runs whose replies use different keys each contribute
 * their own four, nothing demotes what was already there, and the board the user
 * opens carries eight — so the loudest promise the product makes was true of the
 * model and false of the product. It is enforced here instead, on every run,
 * light or full, because the number that matters is the one on the screen.
 *
 * The four that keep their place are the four the board's own reading order puts
 * first: `listBoard` asked for one bucket, so severity, then what is due soonest,
 * then longest-carried, exactly as the rail and the page already rank them. There
 * is one ranking in this product and this is not a second opinion on it.
 *
 * Nothing is ever deleted and no state is touched. An item that loses its place
 * moves to `today`, where it is still the user's work, still carried with its
 * first_seen intact, and still theirs to finish. Only open rows are considered:
 * a snoozed or finished item is a decision the user made, and demoting it would
 * be this pass overruling them to make room for the model.
 *
 * Exported because a sweep is not the only thing that can add to `now`: reading
 * the board wakes a snooze that has come due, and a fifth `now` item can arrive
 * that way with no sweep anywhere near it. core/server.mjs holds the bar on that
 * path with this same function, so there is one demotion rule and not two.
 */
export function capNowBucket(db, { now = nowISO() } = {}) {
  const inNow = listBoard(db, { states: ['open'], buckets: ['now'], limit: 500, now });
  if (inNow.length <= NOW_BOARD_LIMIT) return 0;

  // Demo rows give way first. The seeded week parks two severity-3 items in
  // `now`, and ranked as-is they held their slots while a person's real work
  // was demoted to make room for people who do not exist. Real items keep the
  // board's own order among themselves; the demo only ever fills what they
  // leave over.
  const ranked = [
    ...inNow.filter((i) => i.payload?.sample !== true),
    ...inNow.filter((i) => i.payload?.sample === true),
  ];
  const overflow = ranked.slice(NOW_BOARD_LIMIT);
  withTransaction(db, () => {
    for (const item of overflow) setItemBucket(db, item.id, 'today', { now });
  });
  slog.info(`board held ${inNow.length} now items; demoted ${overflow.length} to today`, {
    demoted: overflow.map((i) => i.id),
  });
  return overflow.length;
}

/**
 * What a light run recomputes: the four-item bar on the persisted board, the
 * counts the rail shows, and whether the item the board opens with is still one
 * the user cares about. If they marked the hero done, the next-best open item
 * takes its place — no model call needed to know that.
 *
 * The demotion runs first, and has to: the counts must describe the board as it
 * will be read, and the `first` pointer must not be handed a `now` item that is
 * about to stop being one.
 */
function recomputeDerived(db, { now = nowISO() } = {}) {
  const demoted = capNowBucket(db, { now });
  const counts = bucketCounts(db, { states: ['open'] });
  const open = Object.values(counts).reduce((n, v) => n + v, 0);

  const firstId = getKV(db, SWEEP_KV.first);
  const current = firstId ? getItem(db, firstId) : null;
  if (!current || current.state !== 'open' || current.sourceInactive) {
    const board = listBoard(db, { states: ['open'], limit: 1 });
    setKV(db, SWEEP_KV.first, board.length ? board[0].id : '');
  }
  setKV(db, SWEEP_KV.counts, JSON.stringify({ counts, open, at: now }));
  return { counts, open, demoted };
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

/**
 * Why a *scheduled* sweep should stand down, or null when it may run.
 *
 * The rule is the one core/server.mjs `modelIsConfigured` applies before it
 * lets /api/ask through: an address and a model name, and either a local
 * runtime (keyless is normal there) or a stored key. It is asked here, on the
 * timer's path only, because `shouldRunFull` says "think" whenever no full run
 * has ever succeeded — which on a home with no model is forever — so a default
 * install that skipped setup otherwise ran a full sweep every interval, reached
 * `requireKey`, and wrote a failed run row each time with nothing to sweep and
 * nothing to ask. A hand-started sweep is deliberately not gated: a person who
 * asked gets the real error.
 *
 * The key is read through the `getSecret` seam rather than the secret store's
 * ref list so the check is injectable — the Scheduler tests never open a
 * keychain — and so a key pasted after launch is seen on the very next tick.
 */
async function modelNotReadyReason(config, getSecret) {
  const model = config?.model;
  // Both sentences name the Settings tab by the label it wears ("AI") and
  // neither names the base URL: this reason reaches the board's banner, and
  // an address the person never typed reads there as the program having gone
  // somewhere on its own. Same words as core/llm.mjs's empty-model error.
  if (!model?.baseUrl || !model?.model) return 'No AI has been chosen yet — open Settings → AI and pick one';
  if (isLocalAddress(model.baseUrl)) return null;
  let key = null;
  try {
    key = await readModelKey(model.baseUrl, modelKeyDeps(getSecret, config));
  } catch (err) {
    slog.debug('no API key available', { error: errorText(err) });
  }
  if (typeof key === 'string' && key.trim()) return null;
  return 'No key has been saved for the AI you chose — open Settings → AI and paste one';
}

/** Whether two configs would aim the timer identically — what reconfigure asks. */
function sameSchedule(a, b) {
  return intervalMinutesOf(a) === intervalMinutesOf(b)
    && activeHoursOf(a).join() === activeHoursOf(b).join()
    && timezoneOf(a) === timezoneOf(b);
}

/**
 * In-process sweep timer.
 *
 * Drift-free by construction: the next run time is an absolute instant computed
 * from the *previous target*, not from when the previous run happened to finish.
 * A sweep that takes four minutes does not push the whole day four minutes late,
 * and a laptop that slept through six slots runs once on wake rather than six
 * times in a row.
 */
export class Scheduler {
  #timer = null;
  #generation = 0;
  #running = false;
  #busy = false;
  #preflights = 0;
  #targetMs = null;
  #controller = null;
  #runs = 0;
  #lastRunAt = null;
  #lastResult = null;
  #skipLogged = null;

  constructor({
    db,
    config = loadConfig(),
    run,
    onProgress,
    onRun,
    deps,
    now = () => Date.now(),
  } = {}) {
    if (!db) throw new TypeError('Scheduler: a database handle is required');
    this.db = db;
    this.config = config;
    this.onProgress = onProgress;
    this.onRun = onRun;
    this.deps = deps;
    this.now = now;
    this.run = typeof run === 'function' ? run : runSweep;
  }

  /** Idempotent. Starting an already-started scheduler does nothing. */
  start() {
    if (this.#running) return this.status();
    this.#generation += 1;
    this.#running = true;
    this.#targetMs = this.#firstTarget();
    this.#arm();
    slog.info('sweep scheduler started', {
      everyMinutes: intervalMinutesOf(this.config),
      activeHours: activeHoursOf(this.config),
      nextRunAt: this.status().nextRunAt,
    });
    return this.status();
  }

  /** Stops the timer and cancels a sweep that is in flight. */
  stop() {
    this.#generation += 1;
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#controller?.abort();
    this.#controller = null;
    return this.status();
  }

  status() {
    return {
      running: this.#running,
      // A key read can repair credential files. Maintenance must wait for it
      // even when stop() has already retired the tick that requested it.
      busy: this.#busy || this.#preflights > 0,
      auto: this.config?.sweep?.auto !== false,
      intervalMinutes: intervalMinutesOf(this.config),
      activeHours: activeHoursOf(this.config),
      timezone: timezoneOf(this.config),
      nextRunAt:
        this.#running && this.#targetMs !== null
          ? toZonedISO(new Date(this.#targetMs), timezoneOf(this.config))
          : null,
      lastRunAt: this.#lastRunAt,
      lastResult: this.#lastResult,
      runs: this.#runs,
    };
  }

  /**
   * Replace the configuration without losing the loop. The timer is re-aimed
   * only when the save actually touched the schedule: PUT /api/config hands
   * every save here, and re-anchoring from "now" on all of them meant any
   * Settings change — the accent colour included — pushed the next sweep a
   * whole interval out, which at intervalMinutes 1440 was most of a day.
   */
  reconfigure(config) {
    const before = this.config;
    this.config = config;
    if (this.#running && !sameSchedule(before, config)) {
      this.#generation += 1;
      this.#targetMs = this.#firstTarget();
      this.#arm();
    }
    return this.status();
  }

  #firstTarget() {
    const tz = timezoneOf(this.config);
    const target = instant(nextRunAt(this.config, toZonedISO(new Date(this.now()), tz)));
    return target ?? this.now() + intervalMinutesOf(this.config) * 60_000;
  }

  /** Sweep right now, outside the schedule. Used by the UI's "Sweep now". */
  async runNow(mode = 'auto') {
    return this.#execute(mode);
  }

  #arm() {
    if (this.#timer) clearTimeout(this.#timer);
    if (!this.#running || this.#targetMs === null) return;
    const delay = Math.max(0, this.#targetMs - this.now());
    this.#timer = setTimeout(() => this.#tick(), delay);
    // The scheduler must not be the reason a process refuses to exit; the server
    // owns the event loop.
    this.#timer.unref?.();
  }

  async #tick() {
    this.#timer = null;
    if (!this.#running) return;
    const generation = this.#generation;

    if (this.config?.sweep?.auto === false) {
      this.#advance();
      this.#arm();
      return;
    }

    // No run row, no onRun relay, no source fetch: nothing happened, and the
    // board must not paint "the last sweep failed" over a home that is merely
    // not set up. status() — and so /api/health — carries the reason instead.
    // Logged once per distinct reason, not every tick: the operator's own home
    // had a line like this every half hour for as long as the app lived.
    const { getSecret } = { ...DEFAULT_DEPS, ...this.deps };
    let reason;
    this.#preflights += 1;
    try { reason = await modelNotReadyReason(this.config, getSecret); }
    finally { this.#preflights -= 1; }
    // Keychain access can outlive stop(), a restart or a schedule change.
    // A retired tick must never start writing after maintenance closes SQLite,
    // or replace the timer installed by the newer schedule.
    if (!this.#running || generation !== this.#generation) return;
    if (this.config?.sweep?.auto === false) {
      this.#advance();
      this.#arm();
      return;
    }
    if (reason) {
      this.#lastResult = { ok: false, skipped: true, reason };
      if (this.#skipLogged !== reason) {
        this.#skipLogged = reason;
        slog.info('scheduled sweep skipped', { reason });
      }
      this.#advance();
      this.#arm();
      return;
    }
    this.#skipLogged = null;

    await this.#execute('auto');
    if (!this.#running || generation !== this.#generation) return;
    this.#advance();
    this.#arm();
  }

  /**
   * Step the absolute target forward by whole intervals until it is in the
   * future, then push it inside the active hours. Whole-interval stepping is
   * what keeps the cadence anchored to the original phase; slots missed while a
   * run was long or a laptop was asleep are skipped, never queued up.
   */
  #advance() {
    const step = intervalMinutesOf(this.config) * 60_000;
    const now = this.now();
    let next = (this.#targetMs ?? now) + step;
    while (next <= now) next += step;

    const tz = timezoneOf(this.config);
    const [startHour, endHour] = activeHoursOf(this.config);
    const hour = wallClock(toZonedISO(new Date(next), tz))?.hour ?? startHour;
    if (hour < startHour) next = atHourInZone(next, startHour, tz);
    else if (hour >= endHour) next = atHourInZone(next, startHour, tz, 1);

    this.#targetMs = next;
  }

  async #execute(mode) {
    if (this.#busy) return { ok: false, busy: true, error: 'A sweep is already running' };
    this.#busy = true;
    this.#controller = new AbortController();
    try {
      const result = await this.run({
        db: this.db,
        config: this.config,
        mode,
        onProgress: this.onProgress,
        signal: this.#controller.signal,
        deps: this.deps,
      });
      this.#runs += 1;
      this.#lastRunAt = nowISO(timezoneOf(this.config));
      this.#lastResult = result;
      if (typeof this.onRun === 'function') {
        try {
          this.onRun(result);
        } catch (err) {
          slog.debug('onRun listener threw', { error: err.message });
        }
      }
      return result;
    } catch (err) {
      slog.error('scheduled sweep threw', { error: storedError(err) });
      this.#lastResult = { ok: false, error: storedError(err) };
      return this.#lastResult;
    } finally {
      this.#busy = false;
      this.#controller = null;
    }
  }
}
