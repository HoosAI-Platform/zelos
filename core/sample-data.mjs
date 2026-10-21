/**
 * core/sample-data.mjs — one believable week, entirely invented, easy to undo.
 *
 * The first run problem: a board with nothing on it teaches nobody anything, and
 * the only way to fill it is to hand over a mailbox password to software you have
 * not seen work yet. So this seeds a demo week into the *current* home — the same
 * database, the same views, no second profile to get lost in — and then removes
 * exactly what it put there.
 *
 * Two properties carry the whole thing:
 *
 *  1. **Marked.** Every row it writes starts with `SAMPLE_MARK`. There is no view
 *     in the app where sample data reads as real, because the mark is in the text
 *     the view renders, not in a flag the view might forget to check.
 *
 *  2. **Exactly reversible.** Seeding writes a manifest into `kv` listing the row
 *     ids it actually inserted — and it only records the ones where the insert was
 *     genuinely new, skipping anything that already existed. Clearing deletes that
 *     list, plus any item a later sweep minted whose source refs point at nothing
 *     but manifest rows — the model's echoes of the fiction — and nothing else,
 *     which is why `rowCounts()` before and after a plain seed-and-clear is
 *     identical rather than approximately identical. `test/sample-data.test.mjs`
 *     asserts precisely that.
 *
 * The cast is fiction. Every person, firm and address below was made up for this
 * file, and every domain is under `.example`, the TLD RFC 2606 reserves so that it
 * can never resolve to anyone.
 */

import {
  withTransaction,
  messageRowId, eventRowId, itemRowId,
  upsertMessage, upsertEvent, upsertItem, upsertDraft, insertCapture,
  getMessage, getEvent, getItem, getDraft,
  startRun, finishRun,
  getKV, setKV, deleteKV,
  indexDoc, removeDoc,
} from './db.mjs';
import {
  localTimezone, nowISO, dayKey, addDaysToKey, offsetFor, toZonedISO, instant,
} from './time.mjs';
import { log } from './log.mjs';

export const SAMPLE_VERSION = 1;

/** Prefixes every headline, subject, title and note this module writes. */
export const SAMPLE_MARK = 'Sample · ';

/** The kv key holding the removal manifest. Its presence *is* "installed". */
export const MANIFEST_KEY = 'sample.manifest';

export const SAMPLE_SOURCE_ID = 's_sample';
export const SAMPLE_CALENDAR_ID = 'c_sample';

/* ------------------------------------------------------------------ *
 * The cast — invented, and deliberately not resembling anyone
 * ------------------------------------------------------------------ */

const YOU = { name: 'You', email: 'you@quillonrow.example' };

export const CAST = Object.freeze({
  firm: Object.freeze({
    name: 'Quillon Row',
    what: 'a six-person design-build studio — the imaginary firm this week belongs to',
  }),
  people: Object.freeze([
    Object.freeze({
      name: 'Teodora Blancsand',
      email: 'teodora@quillonrow.example',
      role: 'studio manager at Quillon Row — she is the one who notices the clash',
    }),
    Object.freeze({
      name: 'Rafe Ondrik',
      email: 'rafe@thistlebank.example',
      role: 'the client, Thistlebank Provisions — waiting on marked-up drawings',
    }),
    Object.freeze({
      name: 'Nadia Vesk',
      email: 'nadia@veskbooks.example',
      role: 'bookkeeper at Vesk Books — chasing an invoice three weeks out',
    }),
    Object.freeze({
      name: 'Oren Harrowmere',
      email: 'oren@harrowmeretimber.example',
      role: 'supplier, Harrowmere Timber — moved a delivery on top of a meeting',
    }),
    Object.freeze({
      name: 'Sunny Auberon',
      email: 'sunny.auberon@postbox.example',
      role: 'a candidate who has been waiting a week for an answer',
    }),
    Object.freeze({
      name: 'Delphine Sallow',
      email: 'delphine@sallowstudio.example',
      role: 'another studio owner, passing on a referral',
    }),
  ]),
});

export const SAMPLE_SUMMARY = 'A made-up week at Quillon Row, a six-person studio: eight messages, '
  + 'seven meetings — two of them overlap for half an hour this afternoon — a client waiting on drawings, '
  + 'an invoice three weeks out, and two drafts already written. Nobody in it is real.';

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

/**
 * An event time on `dayOffset` days from today, at a wall clock, carrying the
 * zone's real offset for that day. Composed as a string rather than round-tripped
 * through Date, because that is the rule the rest of the app reads by (SPEC §5).
 *
 * The offset is resolved from a probe instant at the same wall clock treated as
 * UTC, which is correct everywhere except inside a DST transition hour — where
 * the string is still valid and self-consistent, just an hour off the "true"
 * offset. A demo is allowed that; a real calendar feed is not, and does not use
 * this path.
 */
function eventTime(todayKeyStr, dayOffset, hour, minute, tz) {
  const key = addDaysToKey(todayKeyStr, dayOffset);
  const offset = offsetFor(tz, new Date(`${key}T${pad(hour)}:${pad(minute)}:00Z`));
  return `${key}T${pad(hour)}:${pad(minute)}:00${offset}`;
}

/** A message time, expressed backwards from now so it is always in the past. */
function hoursAgo(nowMs, hours, tz) {
  return toZonedISO(new Date(nowMs - hours * 3_600_000), tz);
}

/* ------------------------------------------------------------------ *
 * The week itself
 * ------------------------------------------------------------------ */

/**
 * Pure: build the whole dataset without touching a database. Exported so the
 * shape can be inspected — and asserted on — without seeding anything.
 */
export function sampleWeek({ now = null, timezone = null } = {}) {
  const tz = timezone || localTimezone();
  const nowIso = now || nowISO(tz);
  const today = dayKey(nowIso) || dayKey(nowISO(tz));
  const nowMs = instant(nowIso) ?? Date.now();

  const ev = (dayOffset, h, m) => eventTime(today, dayOffset, h, m, tz);
  const ago = (h) => hoursAgo(nowMs, h, tz);

  const person = Object.fromEntries(CAST.people.map((p) => [p.email, p]));
  const teodora = person['teodora@quillonrow.example'];
  const rafe = person['rafe@thistlebank.example'];
  const nadia = person['nadia@veskbooks.example'];
  const oren = person['oren@harrowmeretimber.example'];
  const sunny = person['sunny.auberon@postbox.example'];
  const delphine = person['delphine@sallowstudio.example'];

  /* ---------------------------------------------------------- messages */

  let uid = 9001;
  const msg = (hours, from, to, subject, snippet, text, { direction = 'in', threadKey = null } = {}) => {
    const id = uid;
    uid += 1;
    return {
      sourceId: SAMPLE_SOURCE_ID,
      uid: id,
      messageId: `<sample-${id}@quillonrow.example>`,
      threadKey: threadKey || `sample-thread-${id}`,
      folder: direction === 'out' ? 'Sent' : 'INBOX',
      direction,
      from,
      to: [to],
      cc: [],
      subject: `${SAMPLE_MARK}${subject}`,
      date: ago(hours),
      snippet,
      text,
      hasAttachments: false,
      flags: direction === 'out' ? ['\\Seen'] : [],
    };
  };

  const messages = [
    msg(74, rafe, YOU, 'Shop drawings — are we still good for the 12th?',
      'The joiner wants the marked-up set before he cuts anything.',
      'Morning — the joiner wants the marked-up set before he cuts anything, so I need to know if the 12th still holds. If it slips, say so now and I will move the fit-out crew rather than pay them to stand around.',
      { threadKey: 'sample-thread-drawings' }),

    msg(66, oren, YOU, 'Delivery window — we can only make 2:30',
      'The 9am slot is gone; 2:30 is what is left this week.',
      'The 9am slot went to another yard. What I have left this week is 2:30, and someone needs to be on site to sign for it — the driver will not leave it against a fence.'),

    msg(65, YOU, rafe, 'Re: Shop drawings — are we still good for the 12th?',
      'You said the marked-up set would be back within two days.',
      'The 12th holds. I will have the marked-up set back to you within two days — the only open question is the sill detail on the north elevation, and I would rather answer that with a drawing than a paragraph.',
      { direction: 'out', threadKey: 'sample-thread-drawings' }),

    msg(30, nadia, YOU, 'Invoice 2214 — 21 days out',
      'Thistlebank has not paid 2214 and it is now three weeks.',
      'Invoice 2214 is 21 days out. I have sent the usual reminder twice and had nothing back. It is not a large number, but it is the oldest one on the ledger and it is starting to make the month look worse than it is.',
      { threadKey: 'sample-thread-2214' }),

    msg(26, sunny, YOU, 'Following up',
      'Sunny has been waiting a week for an answer on the role.',
      'Hello — following up on our conversation last week. I do not want to be a nuisance, but I have another offer with a decision date on Friday, and I would rather come to you. Any sense of timing would help.'),

    msg(21, delphine, YOU, 'Referral — small clinic fit-out',
      'A referral she wants a yes or no on before she passes it along.',
      'I have a small clinic fit-out that is too small for us and about right for you. They are decent people and they pay. Tell me yes or no by the end of the week and I will pass it along either way.'),

    msg(6, teodora, YOU, 'A half-hour overlap this afternoon',
      'Teodora flagged the clash before anyone drove anywhere.',
      'Your shop-drawing review runs from 2 to 3 this afternoon, but the timber delivery window is 2:30 to 3:30. They overlap for half an hour, and the delivery needs a person on site. Tell me which one you are doing and I will move the other.'),

    msg(5, YOU, nadia, 'Re: Invoice 2214 — 21 days out',
      'You said you would chase Thistlebank yourself.',
      'Leave 2214 with me — I am talking to them about drawings anyway and I would rather ask about the invoice in the same breath than have it arrive as a letter.',
      { direction: 'out', threadKey: 'sample-thread-2214' }),
  ];

  /* ------------------------------------------------------------ events */

  let evUid = 5001;
  const event = (dayOffset, startH, startM, endH, endM, title, location, attendees, description = '') => {
    const id = evUid;
    evUid += 1;
    return {
      calendarId: SAMPLE_CALENDAR_ID,
      uid: `sample-evt-${id}`,
      recurrenceId: '',
      title: `${SAMPLE_MARK}${title}`,
      description,
      location,
      startsAt: ev(dayOffset, startH, startM),
      endsAt: ev(dayOffset, endH, endM),
      allDay: false,
      organizer: attendees[0] ?? YOU,
      attendees: attendees.map((a) => ({ name: a.name, email: a.email, rsvp: 'ACCEPTED' })),
      rsvp: 'ACCEPTED',
      status: 'CONFIRMED',
      url: null,
    };
  };

  const events = [
    event(-2, 9, 0, 9, 30, 'Studio stand-up', 'The long table', [teodora, YOU]),
    event(-1, 11, 0, 12, 0, 'Thistlebank site walk', 'Unit 4, the old dairy', [rafe, YOU]),
    event(0, 9, 30, 10, 0, 'Studio stand-up', 'The long table', [teodora, YOU]),
    // The clash. Both real, both today, both wanting the same body in two places.
    event(0, 14, 0, 15, 0, 'Thistlebank shop-drawing review', 'Studio', [rafe, YOU],
      'Marked-up set, sill detail on the north elevation.'),
    event(0, 14, 30, 15, 30, 'Timber delivery window — site', 'Unit 4, the old dairy', [oren, YOU],
      'Someone has to be on site to sign for it.'),
    event(1, 15, 30, 16, 15, 'Interview — Sunny Auberon', 'Studio', [sunny, YOU]),
    event(2, 16, 0, 16, 30, 'Invoice run', 'Call', [nadia, YOU]),
  ];

  const clashAt = events[3].startsAt;

  /* ------------------------------------------------------------- items */

  const items = [
    {
      key: 'sample-double-booked-two-pm',
      kind: 'conflict',
      bucket: 'now',
      headline: `${SAMPLE_MARK}Your afternoon appointments overlap — pick one and move the other`,
      why: 'The 2–3pm shop-drawing review overlaps the 2:30–3:30pm timber delivery by half an hour, and the delivery needs someone on site to sign for it.',
      person: teodora.name,
      personEmail: teodora.email,
      dueAt: clashAt,
      severity: 3,
      link: null,
      sourceRefs: [],
      payload: { sample: true },
    },
    {
      key: 'sample-marked-up-drawings',
      kind: 'promise',
      bucket: 'now',
      headline: `${SAMPLE_MARK}Send Rafe Ondrik the marked-up shop drawings`,
      why: 'You told him two days ago they would be back within two days, and his joiner is waiting to cut.',
      person: rafe.name,
      personEmail: rafe.email,
      dueAt: ev(0, 17, 0),
      severity: 3,
      link: null,
      sourceRefs: [],
      payload: { sample: true },
    },
    {
      key: 'sample-answer-sunny',
      kind: 'reply',
      bucket: 'today',
      headline: `${SAMPLE_MARK}Give Sunny Auberon a yes or a no`,
      why: 'A week of silence, another offer with a Friday decision date, and an interview already on the calendar for tomorrow.',
      person: sunny.name,
      personEmail: sunny.email,
      dueAt: ev(1, 12, 0),
      severity: 2,
      link: null,
      sourceRefs: [],
      payload: { sample: true },
    },
    {
      key: 'sample-confirm-timber-window',
      kind: 'reply',
      bucket: 'today',
      headline: `${SAMPLE_MARK}Tell Oren Harrowmere who is meeting the timber lorry`,
      why: 'The driver will not leave the load unsigned, and 2:30 is the only slot left this week.',
      person: oren.name,
      personEmail: oren.email,
      dueAt: ev(0, 13, 0),
      severity: 2,
      link: null,
      sourceRefs: [],
      payload: { sample: true },
    },
    {
      key: 'sample-invoice-2214',
      kind: 'money',
      bucket: 'money',
      headline: `${SAMPLE_MARK}Invoice 2214 is 21 days out — ask while you have them`,
      why: 'Two reminders from Nadia Vesk, no reply. You are speaking to Thistlebank about drawings anyway.',
      person: nadia.name,
      personEmail: nadia.email,
      dueAt: null,
      severity: 2,
      link: null,
      sourceRefs: [],
      payload: { sample: true },
    },
    // Delphine asked and you have not answered, so the debt is yours: a reply
    // due later this week, not "They owe you", which is what `waiting` means
    // (QA, 2026-10-09, TT-3529).
    {
      key: 'sample-delphine-referral',
      kind: 'reply',
      bucket: 'soon',
      headline: `${SAMPLE_MARK}Give Delphine Sallow a yes or no about the clinic`,
      why: 'She said end of the week and that she will pass it along either way.',
      person: delphine.name,
      personEmail: delphine.email,
      dueAt: ev(2, 17, 0),
      severity: 1,
      link: null,
      sourceRefs: [],
      payload: { sample: true },
    },
    {
      key: 'sample-promised-sill-detail',
      kind: 'promise',
      bucket: 'promised',
      headline: `${SAMPLE_MARK}You promised to answer the sill detail with a drawing`,
      why: 'Your own words in the thread with Rafe Ondrik — the one open question on the north elevation.',
      person: rafe.name,
      personEmail: rafe.email,
      dueAt: null,
      severity: 1,
      link: null,
      sourceRefs: [],
      payload: { sample: true },
    },
    {
      key: 'sample-what-this-is',
      kind: 'note',
      bucket: 'note',
      headline: `${SAMPLE_MARK}This board is demo data — clear it whenever you like`,
      why: 'Quillon Row and everyone in it were invented for this walkthrough. One click in Settings removes every row it added and leaves anything of yours alone.',
      person: '',
      personEmail: '',
      dueAt: null,
      severity: 0,
      link: null,
      sourceRefs: [],
      payload: { sample: true },
    },
  ];

  /* ------------------------------------------------------------ drafts */

  // No bracketed placeholders anywhere: a draft with a `[name]` in it is not a
  // draft, and core/triage.mjs rejects one. A demo must not ship what the engine
  // would refuse.
  const drafts = [
    {
      id: 'sample_draft_drawings',
      itemId: itemRowId('sample-marked-up-drawings'),
      to: rafe.email,
      subject: `${SAMPLE_MARK}Re: Shop drawings — are we still good for the 12th?`,
      body: 'Rafe — the marked-up set goes over tonight. The 12th holds.\n\n'
        + 'The only change worth flagging is the sill detail on the north elevation: I have drawn it rather than described it, '
        + 'so tell your joiner to work from the section and not from the earlier note.\n\nIf anything on it reads wrong, ring me before he cuts.',
      state: 'pending',
    },
    {
      id: 'sample_draft_timber',
      itemId: itemRowId('sample-confirm-timber-window'),
      to: oren.email,
      subject: `${SAMPLE_MARK}Re: Delivery window — we can only make 2:30`,
      body: 'Oren — 2:30 works. Teodora will be on site to sign for it and she has the gate code.\n\n'
        + 'Ask the driver to come round the back of the old dairy rather than the front; the front is still full of scaffold.',
      state: 'pending',
    },
  ];

  /* ---------------------------------------------------------- captures */

  const captures = [
    `${SAMPLE_MARK}Ask Thistlebank about 2214 while you have them on the drawings call.`,
  ];

  return {
    version: SAMPLE_VERSION,
    timezone: tz,
    now: nowIso,
    messages,
    events,
    items,
    drafts,
    captures,
    conflictAt: clashAt,
  };
}

/* ------------------------------------------------------------------ *
 * Row counts — the proof, as an export
 * ------------------------------------------------------------------ */

export const COUNTED_TABLES = Object.freeze([
  'messages', 'events', 'items', 'drafts', 'captures', 'runs', 'kv', 'search',
]);

/** `{messages: 0, events: 0, …}` — what a clear has to restore, exactly. */
export function rowCounts(db) {
  const out = {};
  for (const table of COUNTED_TABLES) {
    // The list is a frozen constant in this file, never a caller's string.
    out[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) || 0;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

function emptyManifest() {
  return { messages: [], events: [], items: [], drafts: [], captures: [], runs: [], refs: [] };
}

function readManifest(db) {
  const raw = getKV(db, MANIFEST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const ids = { ...emptyManifest(), ...(parsed.ids && typeof parsed.ids === 'object' ? parsed.ids : {}) };
    for (const key of Object.keys(emptyManifest())) {
      ids[key] = Array.isArray(ids[key]) ? ids[key].filter((v) => typeof v === 'string') : [];
    }
    return { version: Number(parsed.version) || 0, seededAt: String(parsed.seededAt || ''), ids };
  } catch {
    log.warn('sample-data: the manifest could not be parsed; nothing will be removed automatically');
    return null;
  }
}

export function isInstalled(db) {
  return readManifest(db) !== null;
}

/** What Settings and onboarding show: installed or not, and how much. */
export function sampleStatus(db) {
  const manifest = readManifest(db);
  if (!manifest) {
    return { installed: false, version: SAMPLE_VERSION, seededAt: null, counts: null, summary: SAMPLE_SUMMARY };
  }
  return {
    installed: true,
    version: manifest.version,
    seededAt: manifest.seededAt,
    counts: {
      messages: manifest.ids.messages.length,
      events: manifest.ids.events.length,
      items: manifest.ids.items.length,
      drafts: manifest.ids.drafts.length,
      captures: manifest.ids.captures.length,
      runs: manifest.ids.runs.length,
    },
    summary: SAMPLE_SUMMARY,
  };
}

/* ------------------------------------------------------------------ *
 * Seed
 * ------------------------------------------------------------------ */

/**
 * Write the week. Idempotent: a second call with the sample already installed is
 * a no-op that says so, rather than a second copy.
 *
 * Nothing is ever overwritten. If a row with a sample id somehow already exists —
 * it cannot in practice, the ids are hashed from a namespaced source id — it is
 * left exactly as it is and left out of the manifest, so the clear cannot delete
 * something that was not ours.
 */
export function seedSampleData(db, { now = null, timezone = null } = {}) {
  if (!db) throw new TypeError('sample-data: seedSampleData needs an open database');
  const existing = readManifest(db);
  if (existing) {
    return { installed: true, alreadyInstalled: true, added: existing.ids, seededAt: existing.seededAt };
  }

  const tz = timezone || localTimezone();
  const seededAt = now || nowISO(tz);
  const week = sampleWeek({ now: seededAt, timezone: tz });
  const ids = emptyManifest();

  withTransaction(db, () => {
    for (const m of week.messages) {
      const id = messageRowId(m.sourceId, m.uid, m.messageId);
      if (getMessage(db, id)) continue;
      upsertMessage(db, m, { now: seededAt });
      ids.messages.push(id);
      ids.refs.push(`msg:${id}`);
    }

    for (const e of week.events) {
      const id = eventRowId(e.calendarId, e.uid, e.recurrenceId);
      if (getEvent(db, id)) continue;
      upsertEvent(db, e, { now: seededAt });
      ids.events.push(id);
      ids.refs.push(`evt:${id}`);
    }

    const runId = startRun(db, { kind: 'sample', model: '', now: seededAt });
    ids.runs.push(runId);

    for (const item of week.items) {
      const id = itemRowId(item.key);
      if (getItem(db, id)) continue;
      upsertItem(db, item, { runId, now: seededAt });
      // upsertItem does not index — reindex() is what normally puts items in
      // FTS — so the sample indexes its own, and takes them out again on clear.
      indexDoc(db, {
        ref: `item:${id}`,
        kind: 'item',
        title: item.headline,
        body: `${item.why}\n${item.person}\n${item.personEmail}`.trim(),
      });
      ids.items.push(id);
      ids.refs.push(`item:${id}`);
    }

    for (const draft of week.drafts) {
      if (getDraft(db, draft.id)) continue;
      upsertDraft(db, draft, { now: seededAt });
      ids.drafts.push(draft.id);
    }

    for (const text of week.captures) {
      const capture = insertCapture(db, text, { now: seededAt });
      ids.captures.push(capture.id);
      ids.refs.push(`cap:${capture.id}`);
    }

    finishRun(db, runId, {
      ok: true,
      tokensIn: 0,
      tokensOut: 0,
      now: seededAt,
      stats: {
        kind: 'sample',
        messages: ids.messages.length,
        events: ids.events.length,
        items: ids.items.length,
        now: week.items.filter((i) => i.bucket === 'now').length,
        sample: true,
      },
    });

    setKV(db, MANIFEST_KEY, JSON.stringify({ version: SAMPLE_VERSION, seededAt, ids }));
  });

  log.info('sample-data: seeded the demo week', {
    messages: ids.messages.length,
    events: ids.events.length,
    items: ids.items.length,
  });

  return { installed: true, alreadyInstalled: false, added: ids, seededAt, conflictAt: week.conflictAt };
}

/* ------------------------------------------------------------------ *
 * Clear
 * ------------------------------------------------------------------ */

const DELETE_BY_ID = Object.freeze({
  messages: 'DELETE FROM messages WHERE id = ?',
  events: 'DELETE FROM events WHERE id = ?',
  items: 'DELETE FROM items WHERE id = ?',
  drafts: 'DELETE FROM drafts WHERE id = ?',
  captures: 'DELETE FROM captures WHERE id = ?',
  runs: 'DELETE FROM runs WHERE id = ?',
});

/**
 * Remove exactly the rows the manifest names, then the manifest. Anything the
 * user did in the meantime — a real message, an item they marked done — is
 * untouched, because this never deletes by pattern, only by recorded id.
 *
 * With one earned exception: a sweep that ran while the demo was installed may
 * have minted its own items about the fictional cast. Those are model output,
 * so their ids are not in the manifest — but they are still recognisable,
 * because their source refs resolve to nothing except rows the manifest does
 * name. An item citing only sample rows is about people who do not exist and
 * goes with them; an item holding even one real ref is evidence of real work
 * and stays, whatever else it cites.
 */
export function clearSampleData(db) {
  if (!db) throw new TypeError('sample-data: clearSampleData needs an open database');
  const manifest = readManifest(db);
  if (!manifest) {
    return { installed: false, cleared: false, removed: { messages: 0, events: 0, items: 0, drafts: 0, captures: 0, runs: 0, refs: 0 } };
  }

  const removed = { messages: 0, events: 0, items: 0, drafts: 0, captures: 0, runs: 0, refs: 0 };

  const sampleRefs = new Set([
    ...manifest.ids.messages.map((id) => `msg:${id}`),
    ...manifest.ids.events.map((id) => `evt:${id}`),
    ...manifest.ids.captures.map((id) => `cap:${id}`),
  ]);

  withTransaction(db, () => {
    for (const [table, sql] of Object.entries(DELETE_BY_ID)) {
      const stmt = db.prepare(sql);
      for (const id of manifest.ids[table] || []) {
        removed[table] += stmt.run(id).changes;
      }
    }
    for (const ref of manifest.ids.refs || []) {
      if (removeDoc(db, ref)) removed.refs += 1;
    }

    // The echo pass. The manifest's own items are already gone, so what is
    // left is either the user's or a sweep's; only an item whose every ref
    // names a sample row — and that has refs at all, because an unreferenced
    // item proves nothing about its origin — is removed, along with its drafts
    // and its search entry.
    for (const row of db.prepare('SELECT id, source_refs_json FROM items').all()) {
      let refs;
      try {
        refs = JSON.parse(row.source_refs_json);
      } catch {
        refs = null;
      }
      if (!Array.isArray(refs) || refs.length === 0) continue;
      if (!refs.every((ref) => sampleRefs.has(ref))) continue;
      removed.items += db.prepare('DELETE FROM items WHERE id = ?').run(row.id).changes;
      removed.drafts += db.prepare('DELETE FROM drafts WHERE item_id = ?').run(row.id).changes;
      if (removeDoc(db, `item:${row.id}`)) removed.refs += 1;
    }

    deleteKV(db, MANIFEST_KEY);
  });

  log.info('sample-data: cleared the demo week', removed);
  return { installed: false, cleared: true, removed };
}
