/**
 * core/connectors/whatsapp.mjs — a WhatsApp conversation the user exported
 * themselves.
 *
 * ========================================================================
 * WHY THIS IS A FILE READER AND NOT AN INTEGRATION
 * ========================================================================
 *
 * Every other connector in this directory polls something. This one does not,
 * and the reason is not that nobody got round to it. There are exactly three
 * ways to get at a personal WhatsApp account's messages, and two of them are
 * not available to this product at any price:
 *
 *  1. THE WHATSAPP BUSINESS CLOUD API. It is business-to-customer messaging and
 *     it HAS NO READ ENDPOINT AT ALL — there is no "list my conversations", no
 *     "fetch messages since"; inbound messages arrive only as webhooks to a
 *     public HTTPS URL you operate, which is the server Zelos deliberately does
 *     not have (non-negotiable #3, and core/server.mjs binds 127.0.0.1). And the
 *     cost of trying is not a rate limit: REGISTERING A PHONE NUMBER ON THE
 *     CLOUD API DELETES THAT NUMBER'S PERSONAL WHATSAPP ACCOUNT. A user who
 *     followed a setup wizard to "connect WhatsApp" would lose the chat history
 *     they were trying to read. There is no version of that which is worth
 *     shipping.
 *
 *  2. THE UNOFFICIAL WEB/MULTI-DEVICE LIBRARIES. They do read personal chats,
 *     and they are out on two independent grounds. FIRST, they cannot ship
 *     here: the browser-automation ones carry Puppeteer, which is a Chromium
 *     download, and the protocol ones carry a native Rust addon — either is a
 *     `node_modules` directory, and CI asserts one does not exist. That is
 *     non-negotiable #1 and it is the product's central claim, not a
 *     preference. SECOND, and this would still be disqualifying if they were
 *     pure JavaScript: they drive an unauthorised client against WhatsApp's own
 *     servers, and the documented consequence is termination of the account.
 *     The account in question is the one holding somebody's family, their
 *     children's school group and their bank's one-time codes. A second brain
 *     is not worth a phone number.
 *
 *  3. EXPORT CHAT. First-party, free, unconditional, no developer account, no
 *     token, no review, and no risk to the account: it is a button inside the
 *     app that hands the user a `_chat.txt` — on its own, or zipped, and
 *     optionally with the media alongside it. That is what this file reads.
 *
 * ========================================================================
 * SO SAY WHAT IT IS. AN ARCHIVE THE USER BRINGS.
 * ========================================================================
 *
 * This connector does not update. It reads a file, and that file holds whatever
 * the conversation contained at the instant the user tapped Export. Nothing new
 * appears until they export again — not in an hour, not tomorrow, not ever.
 *
 * That sentence is in `option`, it is in the `path` field's hint, and `check()`
 * repeats it with the export's own date attached, because the difference
 * between "Zelos reads my WhatsApp" and "Zelos read a file I gave it" is the
 * difference between a product that works and a product that quietly stops
 * telling you about the message that mattered. A user who believes the first
 * one will not export again, and the board will go on showing a conversation
 * that ended weeks ago as though it were current. Framing this accurately is
 * the largest part of the work in this file; the parser is the second largest.
 *
 * `credential: null` and `origins: []` are literal truths and not defaults, the
 * same way they are in folder.mjs: there is nothing to authenticate — the
 * authorisation is the file's own mode on the user's own disk — and `ctx.http`
 * is never touched. Nothing here opens a socket.
 *
 * NOTHING IS EVER WRITTEN, MOVED OR DELETED, including the export itself and
 * including the `.zip`, which is read a few kilobytes at a time through its own
 * central directory rather than unpacked. A media export can be two gigabytes;
 * only the `_chat.txt` inside it is read, and never more than about 8 MB of its
 * text is held, however large it is (see readChatFromZip).
 *
 * ========================================================================
 * THE FORMAT, WHICH IS NOT A FORMAT
 * ========================================================================
 *
 * "The WhatsApp export format" does not exist. WhatsApp renders each line with
 * the PHONE's date and time formatter, so the file's shape is a product of the
 * exporting platform and the exporting phone's locale:
 *
 *   [2/8/26, 9:14:02 AM] Kit Alder: on my way          iOS, US
 *   [11/08/2026, 09:14:02] Kit Alder: on my way        iOS, UK, 24-hour
 *   2/8/26, 9:14 AM - Kit Alder: on my way             Android, US, no seconds
 *   11.08.26, 09:14 - Kit Alder: on my way             Android, de-DE
 *   2026. 8. 11. 오전 9:14 - Kit Alder: 가는 중          Android, ko-KR
 *
 * iOS brackets the timestamp; Android separates it from the body with " - ".
 * The date order is d/m/y in most of the world and m/d/y in the United States,
 * so `2/8/26` is two different days depending on a fact the line does not
 * carry. Times are 12- or 24-hour, the meridiem may be `AM`, `am`, `a.m.`,
 * `a. m.` or a CJK/Korean marker that comes BEFORE the digits, and Arabic
 * locales write the digits themselves in Arabic-Indic numerals with bidi
 * control characters threaded through the line.
 *
 * On top of that: a message wraps, so one message is any number of lines and
 * only the first carries a timestamp; and a great many lines are not messages
 * at all — the end-to-end-encryption notice, "X created group Y", "X added Y",
 * a missed call, "image omitted".
 *
 * Two structural facts do all the heavy lifting, and both are locale-blind:
 *
 *  - A LINE THAT DOES NOT BEGIN WITH A TIMESTAMP IS A CONTINUATION. That is the
 *    whole of the wrapping problem, and it is why parsing is line-oriented
 *    rather than message-oriented.
 *  - A SYSTEM NOTICE HAS NO "Sender: " PREFIX. Nobody sent it, so WhatsApp has
 *    no name to print. Translating a list of English phrases would have been
 *    the obvious approach and it would be wrong for every user outside the
 *    English-speaking world; the absent sender is true in every language.
 *
 * And one more, which is the trick that makes iOS attachments detectable
 * without a phrase list: iOS puts U+200E (LEFT-TO-RIGHT MARK) in front of any
 * content the user did not type — before the whole line for a system notice,
 * and before the sender AND the placeholder for an attachment. So a leading
 * mark says "not typed text", and whether a `Sender: ` prefix survives says
 * which kind. See `classifyBody`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import { offsetFor } from '../time.mjs';

/* ------------------------------------------------------------------ *
 * Ceilings
 * ------------------------------------------------------------------ */

/**
 * How much chat text is read from one export.
 *
 * A decade of a busy family group is genuinely tens of megabytes. Past this
 * ceiling the file is read FROM THE END rather than refused — a chat log is
 * append-only, so the tail is the recent part, and the recent part is what a
 * board about today wants. `parseExport` drops everything before the first
 * timestamped line, which also disposes of the half-character the tail read
 * begins in the middle of.
 */
const MAX_TEXT_BYTES = 8_000_000;

/**
 * How much a zipped `_chat.txt` may inflate to before Zelos stops reading it.
 *
 * A deflated member cannot be read from the end — deflate is a stream, and
 * the last eight megabytes only exist once everything before them has been
 * inflated — so it is inflated in chunks and only the last MAX_TEXT_BYTES are
 * kept. Memory stays at about that; this caps the WORK, so an archive built to
 * inflate a thousand-fold cannot keep a sweep busy for minutes. Half a
 * gigabyte of chat text is several decades of the busiest group anyone has.
 * A stored member is simply read from the end, like a .txt, and needs no cap.
 */
const MAX_INFLATED_BYTES = 512_000_000;

/** Compressed bytes read from the archive per step of that inflation. */
const INFLATE_CHUNK = 1_048_576;

/** Messages kept from one chat, newest first. `limits.maxRows` restates it. */
const MAX_MESSAGES = 2_000;

/** Export files read from a watched folder in one sweep. */
const MAX_CHATS = 20;

/** How far into a directory listing this walks at all. See folder.mjs's note. */
const MAX_DIR_ENTRIES = 5_000;

/** File digests the cursor carries. 40 x ~12 chars sits far under sweep's 4,096. */
const MAX_REMEMBERED = 40;

/** 40 bits, as in folder.mjs: a collision means one export is not re-read. */
const SIG_HEX = 10;

/**
 * The longest thing that may be a sender name.
 *
 * WhatsApp's own profile name caps at 25 characters, but the name in an export
 * is the one from the exporter's address book, which can be considerably
 * longer. This is a backstop against a system notice that happens to contain
 * ": " being read as a message from somebody with a sentence for a name.
 */
const SENDER_MAX = 64;

/** Matches rss.mjs and folder.mjs: the same board renders all three. */
const SNIPPET_CHARS = 400;
const BODY_CHARS = 20_000;
const SUBJECT_CHARS = 120;

/** `sources[].error` is capped at 500 by core/sweep.mjs:463. Stay under it. */
const NOTE_CHARS = 480;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Bidirectional control characters.
 *
 * U+200E/U+200F are the marks, U+202A–U+202E the deprecated embeddings and
 * U+2066–U+2069 the isolates; U+061C is the Arabic letter mark. They are
 * layout instructions, not content. WhatsApp emits them on iOS to keep a
 * left-to-right timestamp readable inside a right-to-left message, and on iOS
 * it ALSO uses U+200E as a semantic flag — see `classifyBody`, which is why
 * this is only ever stripped after that flag has been read off.
 */
const BIDI_SET = '\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\u061c';
const BIDI_ALL = new RegExp(`[${BIDI_SET}]`, 'g');
const BIDI_LEAD = new RegExp(`^[${BIDI_SET}]`);
const BIDI_HEAD = new RegExp(`^[${BIDI_SET}]+`);

export const stripBidi = (s) => String(s ?? '').replace(BIDI_ALL, '');

/**
 * Arabic-Indic and Extended Arabic-Indic digits -> ASCII.
 *
 * An export from a phone set to Arabic or Persian writes `[١١‏/٨‏/٢٠٢٦، ٩:١٤:٠٢ ص]`.
 * Every regex below counts on `\d`, and `\d` does not match U+0661. Three lines
 * here is the difference between reading those exports and reading none of
 * them; the alternative is a parser that works in Latin scripts only, which is
 * the failure mode this file is written against.
 */
export function normalizeDigits(input) {
  return String(input ?? '').replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.codePointAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * A name reduced to what two spellings of it have in common.
 *
 * Letters and numbers of ANY script, lowercased, everything else gone: so
 * "Kit  Alder" , "kit alder" and "Kit-Alder" fold together, and a Korean or
 * Arabic name survives intact rather than being emptied by an ASCII filter.
 */
export const foldName = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '');

const daysInMonth = (year, month) => [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
  31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

/* ------------------------------------------------------------------ *
 * The line header
 * ------------------------------------------------------------------ */

/* Date: three numbers with `/`, `.` or `-` between them, optionally spaced —
   ko-KR writes "2026. 8. 11." and de-DE writes "11.08.26". The trailing dot is
   part of the Korean form and is consumed here rather than left to confuse the
   comma that follows. */
const DATE = String.raw`(\d{1,4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,4})\.?`;

const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?`;

/* The meridiem, on the side of the clock each locale puts it. CJK and Korean
   put the marker FIRST (오전 9:14); Latin locales put it last, spelled `AM`,
   `am`, `a.m.` or `a. m.` — Spanish and Portuguese use the spaced form, and
   the space is sometimes U+202F, which is not `\s` in every engine's mood, so
   it is named explicitly alongside NBSP. */
const SPACE = String.raw`[\s\u00a0\u202f]`;
const AM_PRE = String.raw`(?:(上午|下午|午前|午後|오전|오후)${SPACE}*)?`;
const AM_POST = String.raw`(?:${SPACE}*([AaPp])${SPACE}*\.?${SPACE}*[Mm]\.?)?`;

/** `[2/8/26, 9:14:02 AM] rest` — iOS. */
const IOS_RE = new RegExp(`^\\[${SPACE}*${DATE}${SPACE}*,?${SPACE}*${AM_PRE}${TIME}${AM_POST}${SPACE}*\\]${SPACE}?([\\s\\S]*)$`);

/** `2/8/26, 9:14 AM - rest` — Android. */
const ANDROID_RE = new RegExp(`^${SPACE}*${DATE}${SPACE}*,?${SPACE}*${AM_PRE}${TIME}${AM_POST}${SPACE}*[-–—]${SPACE}([\\s\\S]*)$`);

const PM_MARKERS = new Set(['p', 'P', '下午', '午後', '오후']);
const AM_MARKERS = new Set(['a', 'A', '上午', '午前', '오전']);

/**
 * One line -> its timestamp header, or null if it is a continuation.
 *
 * -> {raw, a, b, c, ymd, hour, minute, second, meridiem, body} | null
 *
 * `raw` is the timestamp EXACTLY AS WRITTEN, and it is not decoration: it is
 * what `rowFor` hashes into the row identity. See the note there.
 *
 * The three date numbers come back unassigned — `a`, `b`, `c`, not day, month,
 * year — because at this point nobody can know which is which. `2/8/26` is two
 * different days and the line does not say. `resolveDateOrder` decides for the
 * whole file at once, which is the only place the evidence exists.
 */
export function parseHeader(line) {
  if (typeof line !== 'string' || !line) return null;
  const text = normalizeDigits(line).replace(BIDI_HEAD, '');
  const m = IOS_RE.exec(text) || ANDROID_RE.exec(text);
  if (!m) return null;

  const [, a, b, c, marker, hh, mm, ss, ap, body] = m;
  const meridiem = marker || ap || '';

  let hour = Number(hh);
  const minute = Number(mm);
  const second = ss === undefined ? 0 : Number(ss);
  if (minute > 59 || second > 59) return null;

  if (meridiem) {
    // A 12-hour clock reading 13:00 is not a 12-hour clock; the line is
    // something else that happened to look like one.
    if (hour < 1 || hour > 12) return null;
    if (PM_MARKERS.has(meridiem) && hour < 12) hour += 12;
    else if (AM_MARKERS.has(meridiem) && hour === 12) hour = 0;
  } else if (hour > 23) return null;

  /* The raw timestamp is everything the match consumed before the body. Sliced
     off the normalized text rather than reassembled from the captures, so it
     stays byte-stable for a file whose lines never change. */
  const raw = text.slice(0, text.length - body.length).trim();

  return {
    raw,
    a: Number(a),
    b: Number(b),
    c: Number(c),
    // A component of three or more digits is a year, which makes the line
    // unambiguous on its own: `2026-08-11` and `11/08/2026` need no inference.
    ymd: a.length >= 3,
    fourDigitYear: c.length >= 3,
    hour,
    minute,
    second,
    body,
  };
}

/* ------------------------------------------------------------------ *
 * Which number is the day
 * ------------------------------------------------------------------ */

/**
 * This machine's own date order, from Intl. 'dmy' | 'mdy' | 'ymd'.
 *
 * The last-resort default, and a much better one than picking a side: an export
 * made on a phone is overwhelmingly likely to have been made by the person
 * sitting at this computer, whose OS is set to the same region as their phone.
 * Intl is a built-in, so this costs nothing and is right for every locale
 * rather than for whichever one the author lives in.
 */
export function localeDateOrder() {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date(Date.UTC(2026, 0, 2)));
    const order = parts
      .filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year')
      .map((p) => p.type[0])
      .join('');
    if (order === 'mdy' || order === 'ymd') return order;
    return 'dmy';
  } catch {
    return 'dmy';
  }
}

/**
 * Read the whole file's date order off the whole file.
 *
 * -> {order, source: 'setting'|'export'|'locale', conflict}
 *
 * A single line cannot answer this and the corpus usually can: a first number
 * above 12 can only be a day, a second number above 12 can only be a day, and
 * one such line settles every other line in the file. Lines that already carry
 * a four-digit year first are skipped — they are not evidence about the
 * ambiguous form, and a file mixing `2026-08-11` into a d/m/y export would
 * otherwise vote in a poll it is not part of.
 *
 * A chat that ran only between the 1st and the 12th of some month leaves no
 * evidence at all. That is the case the `dateOrder` field exists for, and the
 * case `collect` says out loud rather than silently guessing — being wrong here
 * moves messages by up to eleven months, which on a board sorted by time is not
 * a subtle failure.
 */
export function resolveDateOrder(headers, override) {
  const forced = override === 'dmy' || override === 'mdy' ? override : null;
  let dmy = 0;
  let mdy = 0;
  for (const h of headers) {
    if (!h || h.ymd) continue;
    if (h.a > 12) dmy += 1;
    else if (h.b > 12) mdy += 1;
  }
  const conflict = dmy > 0 && mdy > 0;
  if (forced) return { order: forced, source: 'setting', conflict };
  if (dmy > mdy) return { order: 'dmy', source: 'export', conflict };
  if (mdy > dmy) return { order: 'mdy', source: 'export', conflict };
  const locale = localeDateOrder();
  return { order: locale === 'ymd' ? 'dmy' : locale, source: 'locale', conflict };
}

/**
 * A header plus an order -> calendar fields, or null if that reading is not a
 * date that exists.
 *
 * Two-digit years are read as 20xx unconditionally. core/sources/mime.mjs uses
 * a 50-year pivot because RFC 5322 dates really do reach back into the 1990s;
 * WhatsApp shipped in 2009, so `26` is 2026 and there is no year this format
 * can express that belongs in the 1900s.
 */
export function toWall(header, order) {
  if (!header) return null;
  let year;
  let month;
  let day;
  if (header.ymd) {
    year = header.a; month = header.b; day = header.c;
  } else if (order === 'mdy') {
    month = header.a; day = header.b; year = header.c;
  } else {
    day = header.a; month = header.b; year = header.c;
  }
  if (year < 100) year += 2000;
  if (year < 2009 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day, hour: header.hour, minute: header.minute, second: header.second };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * A wall clock in `tz` -> an ISO string carrying that zone's offset.
 *
 * An export states a wall clock and never an offset, because a phone shows you
 * the time you read off your wall. The offset in force depends on the instant
 * and the instant depends on the offset, so this is the same two-step
 * core/server.mjs:1010 uses: guess by reading the nominal as UTC, then re-ask
 * at the candidate instant. That gets DST right on every day except the two
 * hours a year that are a fold or a gap, which is the accuracy a chat message
 * needs — core/sources/ics.mjs converges properly because a calendar event's
 * duration depends on it, and a message has no duration.
 */
export function wallToISO(wall, tz) {
  const nominal = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`
    + `T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
  const zone = tz || 'UTC';
  let offset = offsetFor(zone, new Date(`${nominal}Z`));
  offset = offsetFor(zone, new Date(`${nominal}${offset}`));
  return `${nominal}${offset}`;
}

/* ------------------------------------------------------------------ *
 * Message, notice, or attachment
 * ------------------------------------------------------------------ */

/**
 * The English placeholders, and what they are for.
 *
 * NOT the mechanism — the mechanism is `classifyBody`'s structural tests, which
 * work in every language. These are a supplement for Android, which has no
 * U+200E flag to read, and they are checked last. A German export's
 * `<Medien ausgeschlossen>` is caught by the angle brackets rather than by
 * being listed here, which is the point of preferring shape to vocabulary.
 */
const MEDIA_HINTS = [
  /^<[^<>]{1,80}>$/,                                   // <Media omitted>, <Medien ausgeschlossen>
  /\(file attached\)\s*$/i,                            // Android, media included
  /^(IMG|VID|AUD|PTT|STK|DOC)-\d{8}-WA\d{4}\b/i,       // Android's own file names
  /\b(image|video|audio|sticker|GIF|document|Contact card|voice message) omitted\b/i,
];

/**
 * Words that only appear in a system notice, and only in English.
 *
 * The Android case this exists for: `2/8/26, 9:14 - Kit changed the group
 * description to: hello`. It is a notice, it has no sender, and it contains
 * ": " — so the structural test reads "Kit changed the group description to" as
 * a name. Four or more words AND one of these verbs is not a name anybody has.
 *
 * It is English-only and therefore leaks in other languages; the consequence is
 * one extra row that reads exactly like the notice it is, which is the right
 * direction to fail in. Dropping a real message to catch a notice would not be.
 */
const SYSTEM_VERBS = /\b(added|removed|left|joined|created|changed|deleted|turned|pinned|blocked|invited|reset)\b/i;

/**
 * The part of a line after the timestamp -> what kind of thing it is.
 *
 * -> {kind: 'message', sender, text, attached} | {kind: 'system', text}
 *
 * THE STRUCTURAL RULE: a notice has no sender, because nobody sent it. This is
 * true in every language WhatsApp ships, and it is the whole of the test.
 *
 * THE iOS FLAG: iOS prefixes U+200E to anything the user did not type. On a
 * notice that mark leads the line; on an attachment it leads both the sender
 * and the placeholder. So a leading mark means "not typed", and whether a
 * `Sender: ` prefix survives says which of the two kinds of not-typed it is.
 * That is why the mark is read here and stripped afterwards rather than
 * cleaned off at the door.
 */
export function classifyBody(body) {
  const raw = String(body ?? '');
  const flagged = BIDI_LEAD.test(raw);
  const rest = raw.replace(BIDI_HEAD, '');

  /* Non-greedy up to the FIRST ": ", so a message that itself contains a colon
     ("Kit: 9:30 works for me") splits in the right place. The sender may not
     span a line — a continuation line is never a sender — and may not be longer
     than a name plausibly is. */
  const m = new RegExp(`^([^\\n]{1,${SENDER_MAX}}?): ([\\s\\S]*)$`).exec(rest);
  if (!m) return { kind: 'system', text: stripBidi(rest).trim() };

  const sender = stripBidi(m[1]).trim();
  if (!sender) return { kind: 'system', text: stripBidi(rest).trim() };
  if (sender.split(/\s+/).length >= 4 && SYSTEM_VERBS.test(sender)) {
    return { kind: 'system', text: stripBidi(rest).trim() };
  }

  const tail = m[2];
  const textFlagged = BIDI_LEAD.test(tail);
  const text = stripBidi(tail).trim();
  if (!text) return { kind: 'system', text: sender };

  const attached = flagged || textFlagged || MEDIA_HINTS.some((re) => re.test(text));
  return { kind: 'message', sender, text, attached };
}

/* ------------------------------------------------------------------ *
 * The export
 * ------------------------------------------------------------------ */

/**
 * The whole file -> messages, notices and the reading it settled on.
 *
 * -> {messages, systemCount, skipped, order, orderSource, orderConflict, senders}
 *
 * TWO PASSES OVER THE SAME LINES, and the first one is not wasted work: the
 * date order is a property of the corpus and not of any line, so every header
 * has to be in hand before the first one can be turned into a date. Pass one
 * finds the headers, `resolveDateOrder` reads the evidence, pass two builds
 * messages. A one-pass parser would have to pick an order from the first line
 * it saw, which is the parser that files eleven months of a British family
 * group under the wrong days.
 *
 * A line that is not a header belongs to the message above it. A line that is
 * not a header and has no message above it is prologue — a partial first line
 * from a tail read, or a stray blank — and is counted, not guessed at.
 */
export function parseExport(input, { timezone = 'UTC', order: override = 'auto' } = {}) {
  const lines = String(input ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/);

  const headers = new Array(lines.length);
  for (let i = 0; i < lines.length; i += 1) headers[i] = parseHeader(lines[i]);

  const { order, source: orderSource, conflict: orderConflict } = resolveDateOrder(headers, override);

  const messages = [];
  const senders = new Map();
  let systemCount = 0;
  let skipped = 0;
  let open = null;

  const close = () => {
    if (!open) return;
    const verdict = classifyBody(open.body);
    if (verdict.kind !== 'message') { systemCount += 1; open = null; return; }
    const wall = toWall(open.header, order);
    if (!wall) { skipped += 1; open = null; return; }
    messages.push({
      raw: open.header.raw,
      iso: wallToISO(wall, timezone),
      sender: verdict.sender,
      text: verdict.text,
      attached: verdict.attached,
    });
    senders.set(foldName(verdict.sender), verdict.sender);
    open = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const header = headers[i];
    if (header) {
      close();
      open = { header, body: header.body };
      continue;
    }
    if (open) open.body += `\n${lines[i]}`;
    else if (lines[i].trim()) skipped += 1;
  }
  close();

  return { messages, systemCount, skipped, order, orderSource, orderConflict, senders: [...senders.values()] };
}

/* ------------------------------------------------------------------ *
 * Which of these people is the user
 * ------------------------------------------------------------------ */

/**
 * -> {name, how} — how is 'setting' | 'filename' | 'email' | 'unknown'
 *
 * THIS IS THE HONEST ANSWER TO A QUESTION THAT HAS NO CERTAIN ONE, and it is
 * spelled out rather than guessed at silently because `direction` is what the
 * board uses to tell "somebody is waiting on you" from "you are waiting on
 * somebody", and getting it backwards inverts the meaning of every row.
 *
 * An export carries DISPLAY NAMES AND NOTHING ELSE. No addresses, no phone
 * numbers, no marker on the user's own lines — every message reads
 * `Name: text`, the user's included. `ctx.identityEmail` is an email address,
 * and there is no derivation from an email address to a WhatsApp display name
 * that is true in general: nemo@example.com may appear as "Nemo Hale", as
 * "Nemo", as "Dad", or as a phone number.
 *
 * So there are three kinds of evidence, taken strongest first:
 *
 *  1. THE SETTING. The user typed their own name into the source. This is not a
 *     fallback for a failed heuristic, it is the mechanism; the heuristics
 *     below exist so that the common cases work without it.
 *
 *  2. THE FILE NAME, in a two-person chat only. WhatsApp names the export after
 *     the OTHER party — "WhatsApp Chat with Kit Alder.txt" — in every locale,
 *     with only the surrounding words translated. So if exactly two people
 *     speak in the file and exactly one of their names appears in its name, the
 *     other one is the user. This is structural rather than linguistic, which
 *     is why it is trusted above the email. It is restricted to two-person
 *     chats deliberately: a group export is named after the group, and a group
 *     called "Alder family" would otherwise nominate Kit Alder as the user.
 *
 *  3. THE EMAIL'S LOCAL PART, matched against a name. nemo@example.com against
 *     a sender called "Nemo Hale" is real evidence; it is the weakest of the
 *     three and is required to match exactly one person.
 *
 * If none of them lands, EVERYTHING IS FILED AS RECEIVED and `collect` says so
 * in a sentence that names the candidates. A coin-flip dressed as a result —
 * "the most frequent sender is probably you" — would be wrong about half the
 * time, invisibly, and would make the board confidently misleading rather than
 * plainly incomplete.
 */
export function resolveOwner({ configured = '', identityEmail = '', senders = [], fileName = '' } = {}) {
  const list = senders.filter((s) => s);

  /** The unique sender a candidate string names, or null. */
  const match = (candidate) => {
    const want = foldName(candidate);
    if (want.length < 2) return null;
    const hits = list.filter((s) => {
      const folded = foldName(s);
      if (folded === want) return true;
      const first = foldName(String(s).trim().split(/\s+/)[0]);
      if (first && first === want) return true;
      // "Nemo" for "Nemo Hale": a prefix, but only a substantial one.
      return want.length >= 3 && folded.startsWith(want);
    });
    return hits.length === 1 ? hits[0] : null;
  };

  const typed = String(configured).trim();
  if (typed) {
    const hit = match(typed);
    if (hit) return { name: hit, how: 'setting' };
    return { name: null, how: 'unknown', typed };
  }

  if (list.length === 2) {
    const stem = foldName(String(fileName).replace(/\.[a-z0-9]{1,5}$/i, ''));
    // Names shorter than three folded characters ("Jo", "Al") match too much of
    // any file name to be evidence of anything.
    const named = list.filter((s) => foldName(s).length >= 3 && stem.includes(foldName(s)));
    if (named.length === 1) {
      const other = list.find((s) => s !== named[0]);
      if (other) return { name: other, how: 'filename' };
    }
  }

  const local = String(identityEmail).split('@')[0].split('+')[0];
  if (local) {
    const hit = match(local);
    if (hit) return { name: hit, how: 'email' };
  }

  return { name: null, how: 'unknown' };
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/**
 * One parsed message -> one `messages` row (SPEC §4 / core/db.mjs:380).
 *
 * THERE IS NO `uid` KEY AND THERE MUST NEVER BE ONE. core/db.mjs:384 reads
 * `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null` becomes 0
 * while an omitted uid stays null, and the two hash to different row ids — a
 * release that flipped between them would re-insert every message in every
 * export, forever. A line in a text file has no integer identity.
 *
 * `messageId` HASHES THE TIMESTAMP AS WRITTEN, NOT THE RESOLVED ISO, and that
 * is the load-bearing decision in this function. The ISO depends on
 * `resolveDateOrder`, which depends on the whole corpus — so a longer export
 * containing its first day-past-the-12th flips `2/8/26` from February to
 * August, every ISO in the file moves, and every row id with it. The board
 * would fill with a duplicate of the entire conversation. The raw string
 * `[2/8/26, 9:14:02 AM]` is a fact about the bytes and never changes, so
 * re-exporting a chat re-derives exactly the ids it derived last time and every
 * unchanged message upserts in place.
 *
 * The cost, stated plainly: the same person sending the same text in the same
 * minute twice folds into one row. That is a fair trade against re-inserting an
 * archive, and it is the same content-addressed identity folder.mjs uses.
 */
export function rowFor(message, { chatKey, chatName, ownerName }) {
  const messageId = `whatsapp:sha256:${sha256(`${chatKey}${message.raw}${message.sender}${message.text}`).slice(0, 32)}`;
  const body = message.text.slice(0, BODY_CHARS);
  const flat = collapse(body);

  return {
    messageId,
    /* One export is one conversation, so every row in it shares a thread and
       the board can show it as the exchange it is. */
    threadKey: `whatsapp:${sha256(chatKey).slice(0, 32)}`,
    folder: chatName,
    direction: ownerName && foldName(message.sender) === foldName(ownerName) ? 'out' : 'in',
    /* `from_email` is never validated as an address by core/db.mjs, but a
       display name must not land in it: everything downstream treats that
       column as something you could reply to, and a WhatsApp name is not. */
    from: { name: message.sender, email: '' },
    to: [],
    cc: [],
    // A chat message has no subject. The board needs one line, so it gets the
    // message — the same reading rss.mjs applies to an untitled entry.
    subject: flat.slice(0, SUBJECT_CHARS) || '(no text)',
    date: message.iso,
    snippet: flat.slice(0, SNIPPET_CHARS),
    text: body,
    hasAttachments: message.attached === true,
    flags: [],
  };
}

/* ------------------------------------------------------------------ *
 * Getting the text out of what the user pointed at
 * ------------------------------------------------------------------ */

/**
 * The file or folder this source reads.
 *
 * `~` is expanded here rather than left to the shell, because nothing here goes
 * through a shell — the user types this into a box in a browser. There is no
 * default: an export can be anywhere, and a `path` field with a default the
 * user has not looked at is a source that reads the wrong thing in silence.
 */
export function resolveTarget(settings) {
  const raw = String(settings?.path ?? '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  const tilde = /^~[\\/](.*)$/s.exec(raw);
  if (tilde) return path.join(os.homedir(), tilde[1]);
  return path.resolve(raw);
}

/**
 * Bytes -> text.
 *
 * WhatsApp writes UTF-8. A UTF-8 BOM is stripped because it is a quoting device
 * and left in place it becomes the first character of the first timestamp,
 * which stops the first line parsing. UTF-16LE is decoded because a user who
 * opened the export in Notepad and saved it has one, and refusing that file
 * would be refusing it for a reason nobody could see.
 */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  return buf.toString('utf8');
}

/** `handle.read` may come back short; this is the loop that means it did not. */
async function readFully(handle, buf, position) {
  let total = 0;
  while (total < buf.length) {
    const { bytesRead } = await handle.read(buf, total, buf.length - total, position + total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return total;
}

/* ZIP structure, by signature. A .zip is read through its central directory
   rather than scanned: the directory says where each member starts, so the two
   megabytes of photos in a media export are never touched. */
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

class ExportError extends Error {}

/**
 * The `_chat.txt` inside a WhatsApp .zip, as bytes.
 *
 * iOS's "Export Chat → Attach Media" hands the user a .zip, and it is the most
 * common thing to arrive here, so refusing it and telling people to unzip first
 * would be refusing the default. `node:zlib` is a built-in and a ZIP member is
 * a raw deflate stream, so this costs no dependency at all — non-negotiable #1
 * is not bent here, it simply does not apply.
 *
 * Only what is needed is read: the end-of-central-directory record from the
 * tail, the central directory, and then one member's local header and
 * compressed bytes. A 2 GB archive of holiday photos costs a few kilobytes.
 *
 * The compressed size is taken from the CENTRAL directory and not from the
 * local header, which matters: an archive written by a streaming writer sets
 * the "data descriptor" flag and leaves the local header's sizes as zero, with
 * the true values in the directory and in a trailer after the data. Reading the
 * local header's zero would produce an empty file and a confusing "no messages"
 * rather than an error.
 */
async function readChatFromZip(handle, size, label) {
  const want = Math.min(size, 22 + 65_535);
  const tail = Buffer.alloc(want);
  await readFully(handle, tail, size - want);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ExportError(`${label} is not a readable .zip (no end-of-archive record).`);

  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdAt = tail.readUInt32LE(eocd + 16);
  /* ZIP64 replaces these fields with sentinels and puts the real ones in a
     second record. Detected and refused by name rather than mis-read: an
     archive this large is not a chat export that went slightly over, it is a
     decade of video, and the user is better served by a sentence than by Zelos
     seeking to offset 4,294,967,295. */
  if (count === 0xffff || cdSize === 0xffffffff || cdAt === 0xffffffff) {
    throw new ExportError(`${label} is a ZIP64 archive, which Zelos does not read. `
      + 'Unzip it and point this source at the _chat.txt inside.');
  }
  if (cdSize > 8_000_000 || cdAt + cdSize > size) throw new ExportError(`${label} has a damaged directory.`);

  const cd = Buffer.alloc(cdSize);
  await readFully(handle, cd, cdAt);

  let chosen = null;
  let at = 0;
  for (let i = 0; i < count && at + 46 <= cd.length; i += 1) {
    if (cd.readUInt32LE(at) !== SIG_CENTRAL) break;
    const flags = cd.readUInt16LE(at + 8);
    const method = cd.readUInt16LE(at + 10);
    const compSize = cd.readUInt32LE(at + 20);
    const nameLen = cd.readUInt16LE(at + 28);
    const extraLen = cd.readUInt16LE(at + 30);
    const commentLen = cd.readUInt16LE(at + 32);
    const localAt = cd.readUInt32LE(at + 42);
    const name = cd.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    const base = name.split('/').pop() || '';
    // `__MACOSX/` holds resource forks that Finder's own compressor adds; they
    // are named after the real files and are not them.
    if (name.startsWith('__MACOSX/') || base.startsWith('.')) continue;
    if (!base.toLowerCase().endsWith('.txt')) continue;
    const preferred = base.toLowerCase() === '_chat.txt';
    if (chosen && !preferred) continue;
    chosen = { name, base, flags, method, compSize, localAt };
    if (preferred) break;
  }

  if (!chosen) throw new ExportError(`${label} holds no .txt file, so it is not a WhatsApp chat export.`);
  if (chosen.flags & 0x0001) {
    throw new ExportError(`${label} is password-protected. Unzip it yourself and point this source at the _chat.txt.`);
  }
  if (chosen.method !== 0 && chosen.method !== 8) {
    throw new ExportError(`${label} uses compression method ${chosen.method}, which Zelos does not read.`);
  }
  const local = Buffer.alloc(30);
  await readFully(handle, local, chosen.localAt);
  if (local.readUInt32LE(0) !== SIG_LOCAL) throw new ExportError(`${label} has a damaged entry for ${chosen.base}.`);
  const dataAt = chosen.localAt + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (dataAt + chosen.compSize > size) throw new ExportError(`${label} has a damaged entry for ${chosen.base}.`);

  /* Past the ceiling the chat is read FROM THE END, exactly as a .txt is: a
     long chat used to be refused outright — a stored one by a cap on its size,
     a deflated one as "could not be decompressed" once it inflated past eight
     megabytes — so the longest chats, the ones most worth reading, gave
     nothing at all (QA, 2026-10-10, TT-3441). */
  if (chosen.method === 0) {
    const take = Math.min(chosen.compSize, MAX_TEXT_BYTES);
    const bytes = Buffer.alloc(take);
    await readFully(handle, bytes, dataAt + chosen.compSize - take);
    return { bytes, truncated: take < chosen.compSize };
  }
  return inflateTail(handle, dataAt, chosen.compSize, label);
}

/**
 * Inflate a deflated member in chunks, keeping only its last MAX_TEXT_BYTES.
 * Stops — with a sentence — past MAX_INFLATED_BYTES of output.
 */
async function inflateTail(handle, at, compSize, label) {
  const kept = [];
  let keptBytes = 0;
  let total = 0;
  try {
    await pipeline(
      async function* compressed() {
        for (let pos = 0; pos < compSize; pos += INFLATE_CHUNK) {
          const chunk = Buffer.alloc(Math.min(INFLATE_CHUNK, compSize - pos));
          await readFully(handle, chunk, at + pos);
          yield chunk;
        }
      },
      zlib.createInflateRaw(),
      async function tail(inflated) {
        for await (const chunk of inflated) {
          total += chunk.length;
          if (total > MAX_INFLATED_BYTES) throw new ExportError(`${label} holds more than `
            + `${MAX_INFLATED_BYTES.toLocaleString('en-US')} bytes of chat text, which Zelos does not read. `
            + 'Unzip it and point this source at the _chat.txt inside.');
          kept.push(chunk);
          keptBytes += chunk.length;
          while (keptBytes - kept[0].length >= MAX_TEXT_BYTES) keptBytes -= kept.shift().length;
        }
      },
    );
  } catch (err) {
    if (err instanceof ExportError) throw err;
    throw new ExportError(`${label} could not be decompressed (${collapse(err?.message).slice(0, 80)}).`);
  }
  const all = Buffer.concat(kept, keptBytes);
  return { bytes: all.length > MAX_TEXT_BYTES ? all.subarray(all.length - MAX_TEXT_BYTES) : all, truncated: total > MAX_TEXT_BYTES };
}

/**
 * The stat an export's signature is made from, without reading a byte of it.
 * `lstat`, so a symlink is never followed here either: it is not a file, so it
 * goes on to readExport, which refuses it as it always has. Null if it vanished.
 */
async function statExport(file) {
  try {
    return await fs.lstat(file);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * One export file -> its text and the name of the chat it holds.
 *
 * A file over the ceiling is read FROM THE END. A chat log only ever grows at
 * the bottom, so the last eight megabytes are the recent eight megabytes, and
 * `parseExport` discards everything before the first timestamped line — which
 * disposes both of the half-message the window opens inside and of the partial
 * UTF-8 sequence its first byte lands in.
 */
async function readExport(file) {
  const label = path.basename(file);
  let handle;
  try {
    handle = await fs.open(file, FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ExportError(`${label} is not a regular file.`);

    if (label.toLowerCase().endsWith('.zip')) {
      const { bytes, truncated } = await readChatFromZip(handle, stat.size, label);
      return { text: decodeText(bytes), name: chatNameFor(file, true), mtimeMs: stat.mtimeMs, stat, truncated };
    }

    const take = Math.min(stat.size, MAX_TEXT_BYTES);
    const buf = Buffer.alloc(take);
    await readFully(handle, buf, stat.size - take);
    const text = decodeText(buf);
    if (text.includes('\u0000')) throw new ExportError(`${label} is not text (it contains NUL bytes).`);
    return { text, name: chatNameFor(file, false), mtimeMs: stat.mtimeMs, stat, truncated: take < stat.size };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * What to call this conversation on the board.
 *
 * The file's own name, because WhatsApp puts the other party or the group in
 * it — "WhatsApp Chat with Kit Alder", "WhatsApp Chat - Alder family" — and
 * that is exactly the thing a person would call the conversation. The words
 * around the name are translated per locale, so they are LEFT IN rather than
 * stripped: a list of prefixes to remove would be an English list, and a name
 * with a mysterious chunk missing is worse than a slightly long one.
 *
 * `_chat.txt` is the exception, since it names nothing. iOS uses it inside the
 * zip and it survives an unzip, so the containing folder is asked instead.
 */
export function chatNameFor(file, fromZip) {
  const base = path.basename(file);
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  if (!fromZip && stem.toLowerCase() === '_chat') {
    const parent = path.basename(path.dirname(file));
    if (parent && parent !== '.' && parent !== path.sep) return parent;
  }
  return stem || base;
}

/** `name\0mtimeMs\0size` -> the cursor's memory of one export. */
const signature = (name, stat) => crypto.createHash('sha256')
  .update(`${name}${stat.mtimeMs}${stat.size}`)
  .digest('hex').slice(0, SIG_HEX);

const READABLE = new Set(['.txt', '.zip']);

/**
 * Everything this source should read: one file, or every export in a folder.
 *
 * Symlinks are refused rather than followed, for the reason folder.mjs sets out
 * at length: a link named `_chat.txt` pointing at `~/.ssh/id_rsa` turns a
 * watched folder into a pump, and the contents do not merely land in SQLite —
 * they land in the prompt that leaves the machine.
 */
async function listExports(target) {
  const stat = await fs.stat(target);
  if (stat.isFile()) return { files: [target], folder: false };
  if (!stat.isDirectory()) throw new ExportError(`${target} is neither a file nor a folder.`);

  const found = [];
  let entries = 0;
  const dir = await fs.opendir(target);
  for await (const dirent of dir) {
    if (entries >= MAX_DIR_ENTRIES) break;
    entries += 1;
    if (dirent.name.startsWith('.')) continue;
    if (dirent.isSymbolicLink() || !dirent.isFile()) continue;
    if (!READABLE.has(path.extname(dirent.name).toLowerCase())) continue;
    const full = path.join(target, dirent.name);
    let st;
    try { st = await fs.lstat(full); } catch { continue; }
    if (!st.isFile()) continue;
    found.push({ full, mtimeMs: st.mtimeMs });
  }
  // Newest export first: if a folder holds more than one sweep's worth, the
  // chats somebody exported today are the ones they want to see today.
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { files: found.slice(0, MAX_CHATS).map((f) => f.full), folder: true, total: found.length };
}

/** Several sentences, joined and capped so `sources[].error` never truncates one. */
function noteFrom(parts) {
  const text = parts.filter(Boolean).join(' ');
  if (!text) return null;
  return text.length <= NOTE_CHARS ? text : `${text.slice(0, NOTE_CHARS - 1)}…`;
}

/** "Kit Alder, Nemo Hale" — for a sentence that has to name the candidates. */
const nameList = (names) => names.slice(0, 4).map((n) => `“${collapse(n).slice(0, 30)}”`).join(', ')
  + (names.length > 4 ? `, and ${names.length - 4} more` : '');

export default {
  type: 'whatsapp',
  family: 'whatsapp',
  label: 'WhatsApp export',

  /* THE SENTENCE SOMEBODY PICKS IN SETTINGS, and the first place the truth has
     to be told. It does not say "WhatsApp" on its own, because a person reading
     a list of sources would take that to mean their WhatsApp is connected.
     There is no live connection to a personal WhatsApp account that does not
     either need a server Zelos will not run or risk the account itself; what
     there is, is a file the user makes. */
  option: 'A WhatsApp chat you exported yourself — a file, not a connection: it shows nothing new until you export again',

  configKey: 'sources',
  sink: 'messages',

  /* Null and not `{required: false}`: there is no password to be missing, so
     the sweep must never write "No password stored for …" about it and doctor
     must never offer a box to paste one into. What authorises this read is the
     file's own mode on the user's own disk. */
  credential: null,

  /* Empty, and it can never be otherwise — this file does not touch `ctx.http`
     and holds no address to contact. A link inside a message is stored as text
     and is never followed. */
  origins: [],

  fields: [
    {
      name: 'path',
      type: 'path',
      label: 'Exported chat',
      required: true,
      hint: 'In WhatsApp: open the chat → the contact or group name → Export chat → Without media. '
        + 'Point this at the .txt or .zip it gives you, or at a folder you drop exports into. '
        + 'It is an archive, not a connection: Zelos shows nothing that happened after you exported, '
        + 'until you export the chat again. Nothing is ever written, moved or deleted.',
    },
    {
      name: 'yourName',
      type: 'text',
      label: 'Your name in this chat',
      hint: 'Exactly as it appears in the export — “Nemo Hale”, not your email address. '
        + 'An export has display names and no addresses, so this is the only thing that reliably tells Zelos '
        + 'which messages are yours. Leave it blank and Zelos will try to work it out from the file name and '
        + 'your identity, and file everything as received rather than guess.',
    },
    {
      name: 'dateOrder',
      type: 'choice',
      label: 'Date order',
      default: 'auto',
      choices: [
        { value: 'auto', label: 'Work it out from the export' },
        { value: 'dmy', label: 'Day/month/year — 2/8/26 is 2 August' },
        { value: 'mdy', label: 'Month/day/year — 2/8/26 is 8 February' },
      ],
      hint: 'WhatsApp writes dates the way the exporting phone does, and the file never says which way that was. '
        + 'Auto settles it from any date past the 12th in the export, and falls back to this computer’s own setting '
        + 'for a chat that never reached one.',
    },
  ],

  /* Local disk. Nothing to be gentle with, nothing to rate limit, no budget to
     spend. `maxRows` restates this file's own per-chat cap rather than
     inventing a second one, so the host's truncation never fires and the note
     the user reads is the one written here. Both intervals at zero also means
     `keepsState()` in core/sweep.mjs:369 is false, so this source writes no
     `kv` state row at all; the cursor is the only thing it remembers. */
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: MAX_MESSAGES },

  async collect(ctx) {
    const settings = ctx?.source?.settings ?? {};
    const target = resolveTarget(settings);
    if (!target) throw new Error('this source has no export file yet — add the path in Settings');

    let listing;
    try {
      listing = await listExports(target);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new Error(`${target} is not there. Export the chat from WhatsApp again and save it to that path — `
          + 'Zelos only ever reads it, so nothing it did could have removed it.');
      }
      if (err instanceof ExportError) throw new Error(err.message);
      throw new Error(`${target} could not be read: ${err?.message || String(err)}`);
    }

    const previous = Array.isArray(ctx?.cursor?.seen) ? ctx.cursor.seen.filter((s) => typeof s === 'string') : [];
    const seen = new Set(previous);
    const kept = [];
    const parts = [];
    let total = 0;
    let fresh = 0;

    for (const file of listing.files) {
      if (ctx?.signal?.aborted) break;
      const base = path.basename(file);

      /* AN UNCHANGED EXPORT IS NOT RE-READ, and this is where the connector's
         honesty about itself is enforced rather than merely stated: an archive
         that has not changed has nothing new in it, so the source reports a
         successful read of nothing instead of re-reading the same file every
         thirty minutes. The check is made from a stat, BEFORE the read: it
         used to come after readExport, so every unchanged export was read in
         full, and every .zip inflated, on every sweep (QA, 2026-10-10,
         TT-3443). */
      let read;
      try {
        const stat = await statExport(file);
        // Vanished between the listing and the stat. Next sweep, or never.
        if (!stat) continue;
        const sig = signature(base, stat);
        if (stat.isFile() && seen.has(sig)) {
          kept.push({ sig, mtimeMs: stat.mtimeMs });
          continue;
        }
        read = await readExport(file);
      } catch (err) {
        if (err instanceof ExportError) {
          parts.push({ label: base, rows: [], error: err.message, note: null });
        } else {
          parts.push({ label: base, rows: [], error: `${base} could not be read: ${err?.message || String(err)}`, note: null });
        }
        continue;
      }
      // Vanished between the listing and the open. Next sweep, or never.
      if (!read) continue;

      // Signed from the stat taken with the read, so a file that changed
      // between the two is remembered as what was actually parsed.
      const sig = signature(base, read.stat);
      kept.push({ sig, mtimeMs: read.mtimeMs });
      if (seen.has(sig)) continue;
      fresh += 1;

      const parsed = parseExport(read.text, { timezone: ctx?.timezone, order: settings.dateOrder });
      const owner = resolveOwner({
        configured: settings.yourName,
        identityEmail: ctx?.identityEmail,
        senders: parsed.senders,
        fileName: base,
      });

      // Newest first for the cap, then back into reading order for the board.
      const chronological = parsed.messages.slice().sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso));
      const dropped = Math.max(0, chronological.length - MAX_MESSAGES);
      const window = dropped ? chronological.slice(dropped) : chronological;

      const chatKey = foldName(read.name) || read.name;
      const rows = window.map((m) => rowFor(m, { chatKey, chatName: read.name, ownerName: owner.name }));

      total += rows.length;
      parts.push({
        label: base,
        rows,
        error: null,
        note: noteFrom([
          dropped
            ? `This export holds ${chronological.length.toLocaleString('en-US')} messages and Zelos keeps the most recent `
              + `${MAX_MESSAGES.toLocaleString('en-US')}.`
            : null,
          read.truncated
            ? `Only the last ${MAX_TEXT_BYTES.toLocaleString('en-US')} bytes of this file were read.`
            : null,
          /* Said once, when a new or changed export arrives — not every sweep,
             because an unchanged file is skipped above. A user who fills the
             box in stops hearing about it; a user who does not gets a board
             that is plainly incomplete rather than quietly inverted. */
          owner.how === 'unknown' && parsed.senders.length
            ? (owner.typed
              ? `Nobody in this export is called “${collapse(owner.typed).slice(0, 30)}”. The names in it are `
                + `${nameList(parsed.senders)}, and until one of them is yours every message is filed as received.`
              : `Zelos cannot tell which of ${nameList(parsed.senders)} is you, so every message is filed as received. `
                + 'Put your own name in this source’s “Your name in this chat” box.')
            : null,
          parsed.orderSource === 'locale' && parsed.messages.length
            ? `No date in this export is past the 12th, so day/month and month/day cannot be told apart; Zelos read them `
              + `as ${parsed.order === 'dmy' ? 'day/month' : 'month/day'}, from this computer’s own setting.`
            : null,
          parsed.orderConflict
            ? 'This export mixes two date formats, which should not happen — check the dates on the board.'
            : null,
        ]),
      });
    }

    if (!parts.length) {
      parts.push({
        label: '',
        rows: [],
        error: null,
        note: listing.folder ? `No .txt or .zip export is waiting in ${target}.` : null,
      });
    }

    ctx.emit(`${ctx.label}: ${total} message${total === 1 ? '' : 's'} from ${fresh} export${fresh === 1 ? '' : 's'}`,
      total, total);

    /* Rebuilt from what is on disk right now, newest first and capped, so an
       export the user deletes drops out of the cursor on its own and a folder
       larger than the cursor forgets its oldest entries rather than blowing
       through core/sweep.mjs:111's 4,096-character ceiling — which is dropped
       silently, and would mean every export re-read on every sweep forever. */
    const next = kept.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_REMEMBERED).map((k) => k.sig);
    return { parts, cursor: { v: 1, seen: next } };
  },

  /**
   * What `zelos doctor` asks: is the export there, does it look like one, and —
   * the question only doctor can usefully ask — HOW OLD IS IT.
   *
   * That last one is the reason this check exists at all. A source that is
   * working perfectly and reading a four-month-old file is the failure this
   * connector is most likely to produce, and it produces no error: the sweep is
   * green, the rows are real, and the conversation stopped in April. The sweep
   * cannot say so every thirty minutes without teaching people to ignore a red
   * source, so doctor says it, once, when somebody asks.
   *
   * `ctx` is unused, as in folder.mjs: nothing is contacted, so there is no
   * transport to honour and no byte ceiling to respect.
   */
  async check(source) {
    const target = resolveTarget(source?.settings);
    if (!target) {
      return {
        status: 'fail',
        detail: 'No exported chat file is set for this source.',
        action: 'In WhatsApp, open the chat → the name at the top → Export chat → Without media, save the file, '
          + 'and put its path in Settings → Sources.',
      };
    }

    let stat;
    try {
      stat = await fs.stat(target);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return {
          status: 'fail',
          detail: `${target} does not exist.`,
          action: 'Export the chat from WhatsApp again and save it there. Zelos only reads this file — '
            + 'it has never written to it, moved it or deleted it.',
        };
      }
      return {
        status: 'fail',
        detail: `${target}: ${err?.message || String(err)}`,
        action: 'Check the path in Settings → Sources. It must be a file or folder on this machine that your user can read.',
      };
    }

    /* Whole days, floored, from the file's mtime. An export is written once and
       never touched, so its mtime IS the moment the user tapped Export — the
       one fact that answers "is what I am looking at current". */
    const ageDays = Math.max(0, Math.floor((Date.now() - stat.mtimeMs) / 86_400_000));
    const aged = ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} days ago`;

    if (stat.isDirectory()) {
      let listing;
      try {
        listing = await listExports(target);
      } catch (err) {
        return {
          status: 'fail',
          detail: `${target} cannot be listed: ${err?.message || String(err)}`,
          action: `The folder is there but your user cannot read it. chmod u+rx "${target}" usually settles it.`,
        };
      }
      const n = listing.total ?? listing.files.length;
      if (!n) {
        return {
          status: 'warn',
          detail: `${target} holds no .txt or .zip export.`,
          action: 'Export a chat from WhatsApp — the chat → its name → Export chat → Without media — and save it in there.',
        };
      }
      return {
        status: 'pass',
        detail: `${target} · ${n} export${n === 1 ? '' : 's'} · these are archives: nothing that happened after each `
          + 'one was made is in Zelos until you export that chat again.',
      };
    }

    const ext = path.extname(target).toLowerCase();
    if (!READABLE.has(ext)) {
      return {
        status: 'fail',
        detail: `${target} is not a .txt or .zip.`,
        action: 'Point this at the file WhatsApp’s “Export chat” produced — a _chat.txt, a "WhatsApp Chat with ….txt", '
          + 'or the .zip that holds one.',
      };
    }

    /* The first lines are parsed rather than trusted. "It is a .txt" says
       nothing: the commonest wrong answer to this box is some other text file,
       and finding that out at 07:00 from an empty board is worse than finding
       it out here. Only the head is read, and only for .txt — opening a media
       .zip to prove a point is not worth the seconds. */
    if (ext === '.txt') {
      let handle;
      try {
        handle = await fs.open(target, FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
        const buf = Buffer.alloc(Math.min(stat.size, 64_000));
        await readFully(handle, buf, 0);
        const parsed = parseExport(decodeText(buf), { timezone: 'UTC' });
        if (!parsed.messages.length && !parsed.systemCount) {
          return {
            status: 'fail',
            detail: `${target} has no WhatsApp-shaped lines in it.`,
            action: 'A WhatsApp export begins each message with a timestamp, like “[2/8/26, 9:14:02 AM] Name: text”. '
              + 'This file does not, so it is probably not the export.',
          };
        }
        const who = parsed.senders.length ? ` · ${nameList(parsed.senders)}` : '';
        return {
          status: 'pass',
          detail: `${path.basename(target)}${who} · exported ${aged} · an archive: nothing said in this chat since then `
            + 'is in Zelos, and nothing will be until you export it again.',
        };
      } catch (err) {
        return {
          status: 'fail',
          detail: `${target} could not be read: ${err?.message || String(err)}`,
          action: 'Check that your user can read the file, and that it is not a symbolic link — Zelos refuses those.',
        };
      } finally {
        await handle?.close?.().catch(() => {});
      }
    }

    return {
      status: 'pass',
      detail: `${path.basename(target)} · exported ${aged} · an archive: nothing said in this chat since then is in `
        + 'Zelos, and nothing will be until you export it again.',
    };
  },
};
