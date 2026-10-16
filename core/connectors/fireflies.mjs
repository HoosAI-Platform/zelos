/**
 * core/connectors/fireflies.mjs — meeting recaps from Fireflies.ai.
 *
 * The one notetaker with a free, self-serve API: the user mints an API key in
 * their own account and pastes it in. There is no OAuth app, no client id, no
 * secret of ours, and no inbound port — which is the only kind of integration
 * this product is allowed to have.
 *
 * Three things in here are not style, and each of them has already cost
 * somebody something.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 1. THE FREE TIER IS FIFTY REQUESTS A DAY, SO THE DOCUMENT IS THE DESIGN.
 *
 * The obvious way to write this connector is the wrong one:
 *
 *     transcripts { id }                       -> 1 request
 *     transcript(id: $id) { summary { … } }    -> one request PER MEETING
 *
 * That is 1 + N. An hourly poll on a day with four meetings is 24 + 96 = 120
 * requests against an allowance of 50, so the connector would stop working
 * before lunch on the first busy day and the user would be told "rate limited"
 * about a source they poll once an hour. GraphQL exists precisely so that does
 * not have to happen: `transcripts` returns whole `Transcript` objects, so the
 * nested `summary` — the overview and the action items, the entire reason this
 * row is worth having — comes back inside the SAME response as the list.
 *
 * So MEETINGS_QUERY below asks for everything in one round trip, and `collect`
 * makes exactly ONE `postJson` call. Twenty-four polls a day cost twenty-four
 * requests, which fits in fifty with room for `zelos doctor`. There is
 * deliberately no pagination loop: a second page is a second request out of
 * fifty, and an hour of a person's life does not contain fifty meetings.
 *
 * The document names three arguments — `fromDate`, `toDate`, `limit` — and no
 * more, on purpose. Every extra argument and every extra selected field is a
 * name that has to exist in the vendor's schema, and a GraphQL server rejects
 * the WHOLE document over one unknown field. A filter that would be nice to
 * have is not worth a connector that returns nothing for everyone the week the
 * vendor renames something.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 2. A 200 WITH AN `errors` ARRAY IS A FAILURE. THIS REPO HAS BEEN BITTEN.
 *
 * GraphQL states failures in the body, not in the status line: a bad key, a
 * spent allowance and a mistyped field all arrive as HTTP 200. `ctx.http` can
 * only see the status, so it hands that body back as a success, and the naive
 * reader does `json.data.transcripts ?? []` and returns an empty array — which
 * reads as "you had no meetings" for a source that is in fact broken.
 *
 * core/llm.mjs:906-956 is the same defect, already paid for: OpenRouter answers
 * a billing problem with 200 and "402: insufficient credits" in the envelope,
 * it was read as a success that is an empty string, Settings painted the broken
 * endpoint green, and the sweep then told the user their model was too small
 * and to buy a bigger one — for a topped-out account. The comment there ends
 * "which half you happened to call must not decide whether you are told."
 *
 * `parseGraphql` below is the answer for this half. Any non-empty `errors`
 * array throws, whether or not `data` also came back populated, and a body with
 * neither meetings nor an error throws too — because that third shape is the
 * same lie wearing a different hat.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 3. AN AUTH FAILURE THAT ARRIVES AS 200 HAS TO BE PROMOTED HERE.
 *
 * core/sweep.mjs:402-409 rests a source for six hours on an `AuthError` and
 * says why: "Retrying a 401 against a host that allows fifty calls a day burns
 * forty-eight of them before lunch." That is this host, and that is this
 * allowance — but core/connectors/http.mjs only raises `AuthError` on a 401 or
 * 403, and Fireflies rejects a bad key with 200 and a message in `errors`. The
 * transport can never see it. So `graphqlError` classifies the body and raises
 * `AuthError` and `RateLimitError` itself; without that, a key the user revoked
 * would cost twenty-four wasted requests a day, every day, silently.
 */

import { AuthError, RateLimitError } from './http.mjs';
import { parseDate } from '../sources/mime.mjs';

/** The single endpoint. Fireflies has one; that is the whole of its surface. */
export const API_URL = 'https://api.fireflies.ai/graphql';

/** Where the user mints the key. Printed by `zelos doctor` and by Settings. */
const KEY_URL = 'https://app.fireflies.ai/integrations/custom/fireflies';

/**
 * The vendor's own ceiling on `limit`, and ours.
 *
 * `maxRows` is deliberately larger than `MAX_MEETINGS`: this connector can never
 * ask for more than fifty, so the sweep's row cap only fires when the server
 * ignored the `limit` it was given — which is the case it is there for.
 */
const MAX_MEETINGS = 50;
const MAX_ROWS = 100;

/** The board's line, and the body it can open. Matches core/connectors/rss.mjs. */
const SNIPPET_CHARS = 400;
const BODY_CHARS = 20_000;

/**
 * A meeting title, a name, an address — settable by anyone who invites the
 * user to a meeting, which is the same threat posture as the error text above:
 * a stranger's string, so bound it. The subject cap is linear.mjs's 200; a
 * name or address stops at linear.mjs's 120.
 */
const SUBJECT_CHARS = 200;
const NAME_CHARS = 120;

/**
 * The people in the room, bounded. `to_json` is a row column, and the bare
 * `participants` list arrives inside an 8 MiB response with nothing else
 * holding it down; past a hundred it is a webinar, not a meeting the board
 * needs every address of.
 */
const MAX_ATTENDEES = 100;

/**
 * How much of a stranger's error text survives.
 *
 * core/sweep.mjs caps what it STORES (`ERROR_CHARS = 500`), but `zelos doctor`
 * does not: core/doctor.mjs:80's `errorText` is `err?.message` with no ceiling,
 * and a `check` verdict's `detail` is printed whole. So the cap has to be here
 * for the diagnostic path, and the newlines have to go with it — a multi-line
 * GraphQL error rendered into a one-line doctor row is unreadable.
 */
const ERROR_CHARS = 400;

/**
 * How far back a poll re-reads, on top of where the cursor left off.
 *
 * A Fireflies transcript exists the moment the meeting ends; the SUMMARY is
 * generated afterwards and lands minutes later. A poll that catches a meeting
 * in that gap gets a row with a title and no overview and no action items —
 * which is the archive entry, not the "what do I owe" item.
 *
 * Six hours of overlap costs nothing: it is the same one request either way,
 * only with an earlier `fromDate`. And `upsertMessage` (core/db.mjs:369-370)
 * writes `body = COALESCE(NULLIF(excluded.body, ''), messages.body)`, so the
 * later, richer read replaces the thin one and a thin re-read can never blank a
 * body that is already there. Re-reading is the cheap direction.
 */
const RESUMMARY_OVERLAP_MS = 6 * 60 * 60 * 1000;

/**
 * How long a stated rate limit rests this source.
 *
 * The free allowance is a DAY and nothing tells us when the day rolls over, so
 * there is no correct number here — only a trade. Resting the full 24 hours
 * throws away a whole day of meetings if the reset was ten minutes away;
 * resting an hour is no rest at all, because `minIntervalMs` is already an
 * hour. Three hours gives up at most three polls and recovers inside an eighth
 * of the window.
 */
const RATE_LIMIT_REST_MS = 3 * 60 * 60 * 1000;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const collapse = (s) => str(s).replace(/\s+/g, ' ').trim();
const cap = (s, n) => (str(s).length > n ? `${str(s).slice(0, n - 1)}…` : str(s));

/** A stranger's sentence, made fit for one line of a doctor row. */
const oneLine = (s) => cap(collapse(s), ERROR_CHARS);

/**
 * THE ONE REQUEST. Everything a recap row needs, in a single round trip.
 *
 * `date` and `dateString` are both asked for because they are the same instant
 * in two encodings — epoch milliseconds and ISO — and which one is populated
 * has not been stable across the vendor's own examples. Asking for both costs
 * nothing in a document that is already going out.
 *
 * `participants` (a list of addresses) and `meeting_attendees` (objects with
 * names) are likewise both here: the second is what a person wants to read on
 * the board, and the first is what is there when the second is empty.
 */
export const MEETINGS_QUERY = `query ZelosMeetings($from: DateTime, $to: DateTime, $limit: Int) {
  transcripts(fromDate: $from, toDate: $to, limit: $limit) {
    id
    title
    date
    dateString
    duration
    transcript_url
    host_email
    organizer_email
    participants
    meeting_attendees { displayName name email }
    summary { overview short_summary gist action_items }
  }
}`;

/**
 * The `check` document: the smallest thing that names whose key this is.
 *
 * `users` rather than `user(id:)` because a probe that has to be told an
 * account id before it can confirm an account id is not a probe. It is one
 * request out of fifty, which is why doctor is the only thing that sends it.
 */
export const WHOAMI_QUERY = 'query ZelosWhoAmI { users { user_id name email } }';

/**
 * The error a 200 can be hiding, as a thrown-shaped object — or null.
 *
 * Returns an `AuthError`, a `RateLimitError` or a plain `Error`, never a
 * boolean, because the CLASS is the decision: core/sweep.mjs reacts to exactly
 * two failures (rest the credential, rest the clock) and reports everything
 * else. Getting the class wrong here is the difference between "twenty-four
 * wasted calls a day forever" and "one, then a rest".
 *
 * The message is matched as well as the extension code. Codes are the vendor's
 * to rename and the prose has been more stable than the codes; a false positive
 * on the auth branch costs a six-hour rest that lifts the instant the stored
 * credential changes (core/sweep.mjs:429-434 hashes the secret for exactly
 * that), and a false negative costs the whole allowance. The asymmetry decides
 * which way to lean.
 */
export function graphqlError(json) {
  const list = Array.isArray(json?.errors) ? json.errors : [];
  if (!list.length) return null;

  const messages = list
    .map((e) => str(e?.message) || str(e?.extensions?.code) || 'no message given')
    .filter(Boolean);
  const codes = list.map((e) => str(e?.extensions?.code).toLowerCase());
  const detail = oneLine(messages.join('; ') || 'no message given');
  const codeText = codes.join(' ');

  /* `require_elevated_privilege` is the STEM, and the singular is not a typo
     being carried forward — it is the only spelling that matches both. This
     read `require_elevated_privileges` (plural), and a substring test for the
     plural does not match the singular, so exactly one of the two spellings a
     vendor might ship was classified. The cost of missing it is not "a worse
     error message": an unclassified error is a plain Error, core/sweep.mjs:745
     answers that with `record({})` — no rest — and the source retries every
     hour forever, 24 requests a day out of fifty, for a key that will never
     gain the privilege it is missing. Matching the stem matches both, and
     nothing else in a code string contains it. */
  if (/unauthenticated|unauthorized|forbidden|invalid_api_key|require_elevated_privilege/.test(codeText)
    || /api key|not authenticated|unauthori[sz]ed|invalid token|expired token/i.test(detail)) {
    return new AuthError(
      `Fireflies rejected the API key: ${detail} Check it in Settings — Zelos will not keep trying with the one it has.`,
      { status: 401 },
    );
  }

  if (/too_many_requests|rate_limit/.test(codeText) || /too many requests|rate limit/i.test(detail)) {
    return new RateLimitError(`Fireflies is rate limiting this source: ${detail}`, {
      retryAfterMs: RATE_LIMIT_REST_MS,
    });
  }

  return new Error(`Fireflies answered 200 with an error body: ${detail}`);
}

/**
 * The `data` half of a GraphQL response, or a throw. Never an empty result.
 *
 * `field` is the one key the caller needs, and its absence is a failure rather
 * than an empty read. That is the third shape of the same trap: a body with no
 * `errors` and no data is indistinguishable from "nothing happened" to a reader
 * that only looks at `?? []`, and it is not the same thing at all.
 */
export function parseGraphql(text, field) {
  let json;
  try {
    json = JSON.parse(str(text) || 'null');
  } catch {
    throw new Error(`Fireflies answered with something that is not JSON: ${oneLine(str(text).slice(0, ERROR_CHARS))}`);
  }

  const failed = graphqlError(json);
  if (failed) throw failed;

  const value = json?.data?.[field];
  if (!Array.isArray(value)) {
    throw new Error(`Fireflies answered 200 with neither ${field} nor an error — Zelos will not read that as "nothing happened".`);
  }
  return value;
}

/**
 * ISO for a Fireflies instant, from whichever of the two encodings arrived —
 * or null when NEITHER did.
 *
 * The null is the honest answer to "when was this meeting", and `rowFrom` must
 * not put it in a row. See the paragraph on `date` there for what a null
 * `sent_at` costs. The cursor, by contrast, wants exactly this null: a meeting
 * with no readable instant must not move a high-water mark.
 */
export function meetingDate(transcript) {
  const iso = parseDate(str(transcript?.dateString));
  if (iso) return iso;
  const ms = Number(transcript?.date);
  if (Number.isFinite(ms) && ms > 0) {
    const at = new Date(ms);
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }
  return null;
}

/**
 * The people in the room, as `{name, email}` — the shape core/db.mjs stores.
 *
 * `meeting_attendees` is preferred because it carries display names; the bare
 * `participants` address list is the fallback for a meeting the vendor has no
 * names for. Duplicates are folded on the lowercased address, because the same
 * person turns up in both lists on most meetings.
 */
export function attendeesOf(transcript) {
  const out = [];
  const seen = new Set();
  const add = (name, email) => {
    if (out.length >= MAX_ATTENDEES) return;
    const address = collapse(email).toLowerCase();
    const key = address || collapse(name).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name: collapse(name).slice(0, NAME_CHARS), email: collapse(email).slice(0, NAME_CHARS) });
  };
  for (const a of Array.isArray(transcript?.meeting_attendees) ? transcript.meeting_attendees : []) {
    if (!a || typeof a !== 'object') continue;
    add(a.displayName || a.name || '', a.email || '');
  }
  for (const p of Array.isArray(transcript?.participants) ? transcript.participants : []) {
    if (typeof p === 'string') add('', p);
  }
  return out;
}

/**
 * The action items, as lines.
 *
 * `action_items` has come back as a newline-delimited String and as a list of
 * strings, depending on which meeting and which release. Both are handled
 * because guessing wrong drops the single most valuable field on the row — and
 * drops it SILENTLY, as an empty list, which is the failure mode this whole
 * file is written against. The `**Name**` speaker headings Fireflies puts in
 * the string form are kept: who owes the thing is half of what it means.
 */
export function actionItems(summary) {
  const raw = summary?.action_items;
  const lines = Array.isArray(raw) ? raw.map(str) : str(raw).split('\n');
  // A lone `*` is a bullet; `**` opens a speaker heading and stays whole.
  return lines.map((l) => l.replace(/^\s*(?:[-•]|\*(?!\*))\s*/, '').trim()).filter(Boolean);
}

/** The recap prose, in the order of how much of a meeting it explains. */
const overviewOf = (summary) => str(summary?.overview).trim()
  || str(summary?.short_summary).trim()
  || str(summary?.gist).trim();

/**
 * One transcript -> one `messages` row.
 *
 * THE ACTION ITEMS COME FIRST IN THE BODY, and that is a measurement rather
 * than a preference. core/triage.mjs:816 shrinks the per-message body budget to
 * `floor(room / entries)` when the prompt does not fit, and `clean()` at :482
 * caps from the TAIL — so on a busy day the bottom of every body is what the
 * model never sees. An overview runs to thousands of characters and the action
 * items run to a few hundred; putting the overview first would mean the one
 * part that makes this a thing you owe is the first part cut. They are in the
 * snippet for the same reason: core/triage.mjs:544 renders the snippet at every
 * level except `bare`, and the board shows it directly.
 *
 * `date` FALLS BACK TO THE READ INSTANT, AND OMITTING IT IS NOT AN OPTION.
 * `meetingDate` returns null when neither `dateString` nor `date` came back in a
 * shape that parses — a vendor release that populates only one of them, an empty
 * string, an epoch of 0 — and a null lands in `messages.sent_at` as NULL.
 * core/db.mjs:441 filters the prompt with `sent_at >= ?` and SQLite evaluates
 * `NULL >= '2026-07-21…'` to NULL, which is not true, so the row is dropped from
 * `gatherPromptInput` (core/sweep.mjs:1115) — the only read that reaches the
 * model and the board. Measured against a real database: two rows upserted, two
 * rows stored, ONE row returned to the prompt. The poll still says "1 meeting",
 * `stats.newMessages` still counts it, `zelos doctor` still passes, and the
 * meeting is invisible. That is the worst failure this connector has, because
 * nothing anywhere says it happened.
 *
 * core/connectors/linear.mjs:55-57 already names the rule — "Omitting `date`
 * entirely is not an option either — `sent_at` would be NULL and `NULL >= ?` is
 * NULL, so the row is dropped from the prompt just as silently" — and
 * core/connectors/folder.mjs:439-445 already implements the other half of it, by
 * falling back to the file's mtime rather than to nothing. So the fallback here
 * is the read instant: it buys INCLUSION in the window, which is the whole of
 * what is at stake. It does not pretend to be the meeting time — the transcript
 * link in the body is one click from the real one — and `collect` deliberately
 * does NOT let it move the cursor.
 *
 * THERE IS NO `uid` KEY HERE AND THERE MUST NEVER BE ONE. core/db.mjs:384 reads
 * `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` becomes 0
 * while an OMITTED uid stays null — two different `messageRowId`s for the same
 * meeting (58ac70ac2a9131aa against 36c5d228c13041e4, measured in
 * core/sweep.mjs:411-422). A release that flipped between them would re-insert
 * every recap it has ever seen, on every sweep, forever: `stats.newMessages`
 * would never settle, `shouldRunFull` would force a full run each time, and the
 * user would be billed for a model call every thirty minutes. A meeting has no
 * integer identity, so this connector never mentions the field.
 */
export function rowFrom(transcript, { folder, now = new Date().toISOString() }) {
  const summary = transcript?.summary && typeof transcript.summary === 'object' ? transcript.summary : {};
  const attendees = attendeesOf(transcript);
  const hostEmail = collapse(transcript?.host_email) || collapse(transcript?.organizer_email);
  const hostKey = hostEmail.toLowerCase();
  const host = hostKey ? attendees.find((a) => a.email.toLowerCase() === hostKey) : null;

  const items = actionItems(summary);
  const overview = overviewOf(summary);
  const link = collapse(transcript?.transcript_url);
  const minutes = Number(transcript?.duration);

  const body = [
    items.length ? `Action items\n${items.map((i) => `- ${i}`).join('\n')}` : '',
    overview,
    [
      link,
      Number.isFinite(minutes) && minutes > 0 ? `${Math.round(minutes)} min` : '',
      attendees.length ? `${attendees.length} attendee${attendees.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' · '),
  ].filter(Boolean).join('\n\n').slice(0, BODY_CHARS);

  const snippet = items.length
    ? `Action items: ${items.join('; ')}`
    : overview;

  /* The vendor's own permanent id, namespaced. `messageRowId(sourceId, uid,
     messageId)` already folds the source in, so a collision with a feed's
     `<guid>` or a mail `Message-ID` is impossible either way — the prefix is
     there so a person reading the `messages` table can tell at a glance where a
     row came from. What matters is that it never changes: a messageId that
     drifts between releases re-inserts every row. */
  const messageId = `fireflies:${collapse(transcript?.id)}`;

  return {
    messageId,
    threadKey: messageId,
    folder,
    direction: 'in',
    from: { name: host?.name || hostEmail || 'Fireflies', email: hostEmail },
    to: hostKey ? attendees.filter((a) => a.email.toLowerCase() !== hostKey) : attendees,
    cc: [],
    subject: collapse(transcript?.title).slice(0, SUBJECT_CHARS) || '(untitled meeting)',
    date: meetingDate(transcript) || str(now),
    snippet: collapse(snippet).slice(0, SNIPPET_CHARS),
    text: body,
    hasAttachments: false,
    flags: [],
  };
}

export default {
  type: 'fireflies',
  family: 'fireflies',
  label: 'Fireflies',
  option: 'Fireflies.ai meeting recaps',
  configKey: 'sources',
  sink: 'messages',

  /* A recap is a message that arrived from a meeting: a subject, a body, the
     people who were there, and a time. `sink: 'events'` would be the wrong
     record — the meeting is over, and what is left is a thing you owe. */

  /* The POST is what makes GraphQL possible at all, and core/connectors/
     http.mjs refuses `postJson` unless this is here — a line `zelos doctor` can
     read out loud. It is still read-only: the only document ever sent is one of
     the two `query` constants above. */
  graphql: true,

  credential: {
    label: 'API key',
    help: 'Fireflies calls it an API key. You mint it in your own account — Zelos ships no client id, no secret and no app to approve.',
    url: KEY_URL,
    required: true,
    /* Header, never query. There is no `as: 'query'` in the interface, and this
       is why: core/log.mjs redacts `authorization` by name and `Bearer …` by
       shape, and can do neither for `?api_key=…` in a URL — which lands in the
       vendor's access log, in every proxy's, and in ours. */
    send: { as: 'header', name: 'authorization', prefix: 'Bearer ' },
  },

  /* One origin, written out rather than derived from API_URL, because
     `assertShape` wants a bare origin and a derivation that silently produced
     the wrong string would be a manifest that refuses its own endpoint at run
     time. test/connector-fireflies.test.mjs asserts the two agree. */
  origins: ['https://api.fireflies.ai'],

  fields: [
    {
      name: 'meetings',
      type: 'int',
      label: 'Meetings to read',
      default: 25,
      min: 1,
      max: MAX_MEETINGS,
      hint: 'How many recent recaps one poll asks for. Fireflies caps this at 50.',
    },
  ],

  /**
   * The numbers that make a fifty-a-day allowance survive a laptop.
   *
   * `minIntervalMs` is an hour because the sweep's own default is thirty
   * minutes: at that cadence this source would spend 48 requests a day before
   * `zelos doctor` had asked for one, and the last polls of the day would fail.
   * An hour is 24, which fits.
   *
   * `budget.calls` is 40 rather than 50, and the missing ten are not slack.
   * core/doctor.mjs:748 builds its `check` transport WITHOUT the persisted
   * meter, so every `zelos doctor` run spends a real Fireflies request that
   * this budget never sees. Ten a day of headroom is the difference between "a
   * diagnostic run at four o'clock breaks the evening poll" and "it does not".
   * The budget is persisted per source in `kv` (core/connectors/http.mjs:116-135
   * says why: an in-memory bucket refills on process start, and a laptop that
   * sleeps and wakes ten times a day would burn five hundred calls against a
   * fifty-a-day allowance without ever exceeding it as far as it knew).
   *
   * `minGapMs` is zero and stays zero. `collect` makes exactly one request, so
   * there is no second request for a gap to sit between; a comfortable-looking
   * number here would be a number that is never exercised, which is worse than
   * a zero that is honest.
   */
  limits: {
    minIntervalMs: 60 * 60 * 1000,
    minGapMs: 0,
    budget: { calls: 40, perMs: 24 * 60 * 60 * 1000 },
    maxRows: MAX_ROWS,
  },

  async collect(ctx) {
    const settings = ctx.source?.settings ?? {};
    const limit = Math.max(1, Math.min(Number(settings.meetings) || 25, MAX_MEETINGS));

    /* The cursor is opaque to the host and is the newest meeting we have seen,
       rolled back by the re-summarise overlap. It only ever NARROWS the window
       the sweep hands over: `window.from` is a floor, so a cursor that has gone
       stale (a laptop shut for a month) cannot make this ask for a year of
       meetings, and a fresh source with no cursor at all still gets the sweep's
       seven days. */
    const cursor = ctx.cursor && typeof ctx.cursor === 'object' ? ctx.cursor : {};
    const seenAt = Date.parse(str(cursor.newestAt));
    const floor = Date.parse(str(ctx.window?.from)) || 0;
    const fromMs = Number.isFinite(seenAt)
      ? Math.max(floor, seenAt - RESUMMARY_OVERLAP_MS)
      : floor;

    /* `window.to` is now + 60 days — the calendar's forward horizon, which is
       right for a calendar and meaningless here. A meeting that has not
       happened has no recap, so the ceiling is the present. */
    const nowMs = Date.parse(str(ctx.now)) || Date.now();
    const toMs = Math.min(Date.parse(str(ctx.window?.to)) || nowMs, nowMs);

    const variables = {
      from: new Date(fromMs).toISOString(),
      to: new Date(Math.max(toMs, fromMs)).toISOString(),
      limit,
    };

    ctx.log?.debug('reading meetings', { from: variables.from, to: variables.to, limit });

    // ONE request. See the head of this file for why there is no second one.
    const res = await ctx.http.postJson(API_URL, { query: MEETINGS_QUERY, variables }, {
      accept: 'application/json',
    });

    const transcripts = parseGraphql(res.text, 'transcripts');
    const folder = ctx.label || 'Fireflies';
    const readAt = new Date(nowMs).toISOString();

    const rows = [];
    /* The high-water mark is carried as a NUMBER and re-emitted in one
       canonical form. Comparing two ISO strings lexically is wrong the moment
       they disagree about spelling: `2026-08-10T09:00:00-04:00` and
       `2026-08-10T13:00:00+00:00` are the same instant and the second sorts
       higher, and `…:00+00:00` against `…:00.000Z` differs at the '+' versus
       the '.' — so a mixed batch would move the cursor backwards and re-read
       the same meetings forever, or forwards and skip a day. `meetingDate`
       preserves whatever offset the vendor sent, which is exactly the
       condition that makes a string compare unsafe. */
    let newestMs = Date.parse(str(cursor.newestAt));
    if (!Number.isFinite(newestMs)) newestMs = 0;
    for (const transcript of transcripts) {
      if (!transcript || typeof transcript !== 'object') continue;
      // A transcript with no id has no stable identity, and a row whose
      // `messageId` is `fireflies:` would collide with the next one like it and
      // overwrite it. Dropping it is the only honest option.
      if (!collapse(transcript.id)) continue;
      rows.push(rowFrom(transcript, { folder, now: readAt }));
      /* THE CURSOR MOVES ON THE VENDOR'S INSTANT, NEVER ON THE ROW'S.
         `row.date` falls back to `readAt` when the vendor sent no readable
         time (see `rowFrom`), and reading the high-water mark off the row
         would let one such meeting shove the cursor to NOW — after which the
         next poll asks from now − 6h and every meeting older than that is
         skipped for good. `meetingDate` returns null there instead, which is
         the answer this loop wants: a meeting Zelos cannot place in time is
         not evidence about how far it has read. */
      const at = Date.parse(str(meetingDate(transcript)));
      if (Number.isFinite(at) && at > newestMs) newestMs = at;
    }

    ctx.emit(`${ctx.label}: ${rows.length} meeting${rows.length === 1 ? '' : 's'}`, rows.length, rows.length);

    /* A poll that found nothing new hands the same high-water mark straight
       back, so the next one still asks from where this one left off. `null` —
       which CLEARS the stored cursor — is reached only when nothing has ever
       been seen, where there is genuinely nothing to remember. */
    return {
      parts: [{ label: '', rows, error: null, note: null }],
      cursor: newestMs > 0 ? { newestAt: new Date(newestMs).toISOString() } : null,
    };
  },

  /**
   * `zelos doctor`: whose key is this?
   *
   * It answers the question a user actually has — "is the thing I pasted the
   * thing I think it is" — by naming the account, which no status code can do.
   * It reaches the network through `ctx.http`, so it can contact exactly the one
   * origin this manifest declares and nothing else, and doctor's whole suite can
   * hold it still through `deps.fetchImpl`.
   *
   * A thrown `AuthError` from `graphqlError` is caught rather than allowed to
   * escape: doctor is where a bad key should be EXPLAINED, and the sentence the
   * sweep needs ("Zelos will not keep trying") is the wrong sentence for a
   * person who is standing in front of the diagnostic that told them to look.
   */
  async check(source, ctx) {
    try {
      const res = await ctx.http.postJson(API_URL, { query: WHOAMI_QUERY }, { accept: 'application/json' });
      const users = parseGraphql(res.text, 'users');
      if (!users.length) {
        return {
          status: 'warn',
          detail: 'Fireflies accepted the key but named no account for it.',
          action: `Check that the key is still listed at ${KEY_URL}. A key for a workspace you have left answers exactly like this.`,
        };
      }
      const named = users
        .slice(0, 3)
        .map((u) => {
          const name = collapse(u?.name);
          const email = collapse(u?.email);
          return name && email ? `${name} <${email}>` : email || name || collapse(u?.user_id) || '(unnamed)';
        })
        .join(', ');
      const more = users.length > 3 ? ` and ${users.length - 3} more` : '';
      return { status: 'pass', detail: `api.fireflies.ai · ${named}${more}` };
    } catch (err) {
      return {
        status: 'fail',
        detail: `${source?.label || 'Fireflies'}: ${oneLine(err?.message || String(err ?? 'unknown error'))}`,
        action: `Open Settings → Sources and paste the API key again. You mint one at ${KEY_URL}; Zelos never creates one for you.`,
      };
    }
  },
};
