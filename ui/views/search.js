/**
 * ui/views/search.js — the index, asked directly.
 *
 * Everything a sweep has ever read is in one FTS5 table: mail, calendar events,
 * the items the model raised and the notes you typed. GET /api/search has been
 * answering questions about it since the first version; until now nothing in
 * the app could ask one, so the only way to find a message from March was to
 * remember which day it landed on.
 *
 * Three things shape this view.
 *
 *  1. **A result is a reference, not a record.** The server returns
 *     `{ref, kind, title, excerpt, score}` — `msg:…`, `evt:…`, `item:…`,
 *     `cap:…` — and refuses to hand back bodies. So a hit shows enough to
 *     recognise, and where the board can actually open the thing behind it, it
 *     offers the way there and not otherwise. A button that navigates nowhere
 *     is worse than no button.
 *  2. **The last word wins.** Each keystroke supersedes the query before it, so
 *     a request in flight is aborted rather than left to land late and overwrite
 *     newer results with older ones.
 *  3. **The view owns a persistent root.** A sweep finishing must not wipe a
 *     query someone typed, so this module keeps its nodes between renders — the
 *     same arrangement ui/views/ask.js makes for the same reason.
 */

import { el, button, meander, replace, focusQuietly } from '../lib/dom.js';
import { emptyState } from '../lib/items.js';
import { api, isMissingRoute } from '../lib/api.js';
import { state } from '../lib/store.js';
import { dayKey, formatDay } from '../lib/time.js';
import { BUCKET_TAG, eventTimeLabel, plural } from '../lib/format.js';

/**
 * Long enough that typing a word is one query rather than five, short enough
 * that the results feel like they are following the keyboard. The index is on
 * this machine; there is no network to be polite to.
 */
const DEBOUNCE_MS = 220;

/** The server clamps at 50. Thirty is a page you can read to the end of. */
const LIMIT = 30;

/**
 * The same vocabulary the Ask view uses for its sources. The database calls
 * them `message` and `capture`; nobody else does.
 */
const KIND_LABEL = { message: 'mail', event: 'calendar', item: 'board', capture: 'note' };

/** Board first, then the raw material, so the summary line reads in that order. */
const KIND_ORDER = ['item', 'message', 'event', 'capture'];

/**
 * Which view owns each bucket. app.js keeps the same map for the rail; this one
 * is not imported from there because the shell is another module's to own, and
 * a search result knowing where the board keeps its buckets is a small enough
 * fact to state twice.
 */
const BUCKET_HASH = {
  now: '#/now',
  today: '#/today',
  soon: '#/today',
  money: '#/today',
  waiting: '#/owed',
  promised: '#/owed',
  note: '#/now',
};

export function hashForBucket(bucket) {
  return BUCKET_HASH[bucket] || '#/now';
}

// Snoozing preserves the item's bucket, but moves its visible row to Now.
function hashForItem(item) {
  return item.state === 'snoozed' ? '#/now/snoozed' : hashForBucket(item.bucket);
}

export function kindLabel(kind) {
  if (KIND_LABEL[kind]) return KIND_LABEL[kind];
  return typeof kind === 'string' && kind ? kind : 'result';
}

/** `msg:abc` -> `{prefix: 'msg', id: 'abc'}`, and null for anything else. */
export function refParts(ref) {
  const m = /^(msg|evt|item|cap):(.+)$/.exec(typeof ref === 'string' ? ref : '');
  return m ? { prefix: m[1], id: m[2] } : null;
}

/** "board 2 · mail 9 · calendar 1" — what the hits are made of, in one line. */
export function summariseKinds(results) {
  const counts = new Map();
  for (const result of results || []) {
    const kind = result?.kind;
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  const seen = [...counts.keys()];
  const ordered = [
    ...KIND_ORDER.filter((k) => counts.has(k)),
    ...seen.filter((k) => !KIND_ORDER.includes(k)),
  ];
  return ordered.map((kind) => `${kindLabel(kind)} ${counts.get(kind)}`).join(' · ');
}

/**
 * Where this hit can be opened, or null when nowhere can.
 *
 * The board shows items and the calendar shows events, and that is the whole
 * list of things this app can put on screen — there is no message reader here
 * and there is deliberately not going to be one. But a message or a note that
 * a sweep turned into an item is reachable at the level the user actually
 * thinks in: the item it raised. So a `msg:`/`cap:` hit is matched against the
 * `sourceRefs` of every item on the board, and offers that item when one cites
 * it.
 *
 * A done, dismissed or otherwise off-board item is not in `items` at all, so it
 * yields null and the hit is shown without a way in — which is true, and better
 * than a button that lands on a page the thing is not on.
 */
export function destinationFor(ref, { items = [], events = [] } = {}) {
  const parts = refParts(ref);
  if (!parts) return null;

  if (parts.prefix === 'evt') {
    const event = events.find((e) => e && e.id === parts.id);
    if (!event) return null;
    // The day rides in the hash rather than in a call into the calendar module.
    // Two views reaching into each other's state is how a router stops being
    // the description of where you are, and `#/calendar/2026-08-11` is a link
    // anybody can hold on to.
    const day = dayKey(event.starts_at);
    return { where: 'calendar', hash: day ? `#/calendar/${day}` : '#/calendar', event, day };
  }

  if (parts.prefix === 'item') {
    const item = items.find((i) => i && i.id === parts.id);
    if (!item) return null;
    return { where: 'board', hash: hashForItem(item), item, raised: false };
  }

  const source = items.find((i) => Array.isArray(i?.sourceRefs) && i.sourceRefs.includes(ref));
  if (!source) return null;
  return { where: 'board', hash: hashForItem(source), item: source, raised: true };
}

/* --------------------------------------------------------------- the view */

let root = null;
let field = null;
let statusNode = null;
let resultsSlot = null;
let navigateTo = null;
let timer = null;
let inFlight = null;
let includeHistory = false;

/**
 * What the results region is currently showing. `query` is the query the
 * results belong to, which is not the same as what is in the field — the field
 * is a keystroke ahead for as long as the debounce lasts.
 */
let found = { status: 'idle', query: '', results: [], error: '' };

function metaLine(dest) {
  if (!dest) return null;
  if (dest.where === 'calendar') {
    const when = [formatDay(dest.event.starts_at), eventTimeLabel(dest.event)].filter(Boolean).join(' · ');
    return when ? el('p', { class: 'hit-meta mono', text: when }) : null;
  }
  const bits = [];
  const bucket = BUCKET_TAG[dest.item.bucket] || dest.item.bucket || '';
  if (bucket) bits.push(bucket);
  // A message is not the item it produced, so the line says which item that is
  // rather than letting the button imply the hit and the destination are one
  // and the same thing.
  if (dest.raised) bits.push(`raised: ${dest.item.headline || 'an item'}`);
  return bits.length ? el('p', { class: 'hit-meta mono', text: bits.join(' · ') }) : null;
}

function openControl(dest) {
  if (dest.where === 'calendar') {
    return button('Show in the calendar', {
      class: 'btn quiet',
      onClick: () => navigateTo(dest.hash),
    });
  }
  return button(dest.raised ? 'Open what it raised' : 'Open on the board', {
    class: 'btn quiet',
    onClick: () => navigateTo(dest.hash),
  });
}

function hitRow(result, board) {
  const dest = result.sourceInactive ? null : destinationFor(result.ref, board);
  const title = String(result.title || '').trim();
  return el('article', { class: 'hit' }, [
    el('div', { class: 'hit-head' }, [
      el('span', { class: 'hit-kind mono', text: kindLabel(result.kind) }),
      el('h2', { class: 'hit-title', text: title || '(no title)' }),
    ]),
    result.excerpt ? el('p', { class: 'hit-excerpt', text: String(result.excerpt) }) : null,
    result.sourceInactive ? el('p', { class: 'hit-meta mono', text: 'No longer in task selection' }) : null,
    metaLine(dest),
    dest ? el('div', { class: 'hit-tools' }, openControl(dest)) : null,
  ]);
}

/**
 * The four states this region has, and each one says something different: what
 * search is for, that it is working, that a real query matched nothing, or what
 * went wrong. "No results" is not the same sentence as "not searched yet", and
 * showing one for the other is how a working search reads as broken.
 */
function resultsRegion() {
  if (found.status === 'error') {
    return emptyState({
      title: 'The search did not run',
      detail: found.error,
      action: button('Try again', { class: 'btn solid', onClick: () => run(found.query) }),
    });
  }
  if (found.status === 'idle') {
    return emptyState({
      title: 'Nothing searched yet',
      detail: 'A name, a subject line, an invoice number, a word you half remember. Everything Zelos has read is in here — mail, calendar, the things it flagged and the notes you kept.',
    });
  }
  // The results of the query before this one stay on screen while the next one
  // runs. They are a moment out of date and about to be replaced; a page that
  // empties itself between every two keystrokes is harder to read than one that
  // is briefly behind.
  if (found.status === 'searching' && !found.results.length) {
    return el('p', { class: 'quiet-note', text: 'Looking…' });
  }
  if (!found.results.length) {
    return emptyState({
      title: `Nothing matched “${found.query}”`,
      detail: 'Zelos can only find what it has read. A word from the subject line, or a name, usually finds more than a whole phrase does.',
    });
  }
  const board = { items: state.board.items || [], events: state.board.events || [] };
  return el('div', { class: 'stack' }, found.results.map((result) => hitRow(result, board)));
}

function statusText() {
  if (found.status === 'searching') return { text: 'Searching…', tone: 'is-working' };
  if (found.status === 'error') return { text: found.error, tone: 'is-bad' };
  if (found.status === 'done') {
    if (!found.results.length) return { text: 'nothing matched', tone: '' };
    const summary = summariseKinds(found.results);
    return { text: `${plural(found.results.length, 'hit')}${summary ? ` · ${summary}` : ''}`, tone: '' };
  }
  return { text: '', tone: '' };
}

/**
 * What the status region last said. A live region announces a WRITE, not a
 * change, so writing "4 hits · mail 4" back into it word for word makes a screen
 * reader say it again — and `paint()` runs on every board render, which since
 * the board grew a heartbeat means every few minutes, forever. So the text is
 * only written when it is actually different. ui/app.js keeps the same guard for
 * the sweep line and the toast, for the same reason; it is mirrored here rather
 * than imported because a view importing the shell is a cycle.
 */
let announced = null;

function announce(node, text) {
  const value = text || '';
  if (announced === value) return;
  announced = value;
  requestAnimationFrame(() => {
    // A newer announcement may have overtaken this one between frames.
    if (announced === value) node.textContent = value;
  });
}

function paint() {
  const { text, tone } = statusText();
  announce(statusNode, text);
  statusNode.setAttribute('class', `status search-status mono${tone ? ` ${tone}` : ''}`);
  replace(resultsSlot, resultsRegion());
}

/**
 * Run a query, now.
 *
 * The controller is compared by identity before anything is written back: an
 * answer that arrives after the query it belongs to has been superseded is
 * dropped rather than painted, which is the difference between search that
 * follows your typing and search that flickers between two answers.
 */
async function run(text) {
  clearTimeout(timer);
  const q = String(text || '').trim();
  if (inFlight) {
    inFlight.abort();
    inFlight = null;
  }
  if (!q) {
    found = { status: 'idle', query: '', results: [], error: '' };
    paint();
    return;
  }

  const mine = new AbortController();
  inFlight = mine;
  found = { status: 'searching', query: q, results: found.results, error: '' };
  paint();

  try {
    const res = await api.search(q, { limit: LIMIT, signal: mine.signal, includeHistory });
    if (inFlight !== mine) return;
    found = {
      status: 'done',
      query: q,
      results: Array.isArray(res?.results) ? res.results : [],
      error: '',
    };
  } catch (err) {
    if (err?.name === 'AbortError' || inFlight !== mine) return;
    found = {
      status: 'error',
      query: q,
      results: [],
      error: isMissingRoute(err)
        ? 'This build of Zelos has no search route. Everything else still works.'
        : err.message,
    };
  } finally {
    if (inFlight === mine) inFlight = null;
  }
  paint();
}

function build() {
  field = el('input', {
    class: 'input search-field',
    type: 'search',
    name: 'q',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    placeholder: 'survey invoice, Marcus, the thing about Thursday…',
    'aria-label': 'Search your mail, calendar, board and notes',
  });

  field.addEventListener('input', () => {
    clearTimeout(timer);
    const text = field.value;
    // An emptied field goes back to the opening state at once: waiting a fifth
    // of a second to show nothing is a fifth of a second of stale results.
    if (!text.trim()) {
      run('');
      return;
    }
    timer = setTimeout(() => run(text), DEBOUNCE_MS);
  });

  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Escape empties the field rather than leaving the view: the results below
    // came from what is in it, and clearing one without the other leaves the
    // page describing a query that is no longer there.
    if (!field.value) return;
    field.value = '';
    run('');
  });

  const form = el('form', { class: 'search-form', role: 'search' }, [
    field,
    el('label', { class: 'check-row' }, [
      el('input', {
        class: 'checkbox', type: 'checkbox',
        onchange() { includeHistory = this.checked; run(field.value); },
      }),
      el('span', { class: 'check-label', text: 'Include task history' }),
    ]),
    el('div', { class: 'search-actions' }, [
      el('button', { type: 'submit', class: 'btn solid', text: 'Search' }),
      el('span', { class: 'search-hint mono', text: 'esc clears' }),
    ]),
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(field.value);
  });

  statusNode = el('p', { class: 'status search-status mono', role: 'status' });
  resultsSlot = el('div', { class: 'search-results' });

  root = el('div', { class: 'view view-search' }, [
    el('p', { class: 'search-lede', text: 'One index, everything read: mail, calendar, the board and your own notes. It never leaves this machine.' }),
    form,
    statusNode,
    meander(),
    resultsSlot,
  ]);
}

export function renderSearch(ctx) {
  // Whether the view was on screen a moment ago. The shell builds the new view
  // before swapping it in, so the old root is still in the document during a
  // same-view re-render and gone after a navigation away — which is exactly the
  // difference between "do not touch the focus" and "this is a fresh arrival,
  // put the cursor in the field".
  const arriving = !root || !root.isConnected;
  if (!root) build();
  navigateTo = ctx.navigate;
  paint();
  if (arriving) requestAnimationFrame(() => focusQuietly(field));
  return root;
}
