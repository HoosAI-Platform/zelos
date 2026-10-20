/**
 * ui/views/owed.js — three rosters: drafts, what you owe, what you are owed.
 *
 * Drafts are the one place in Zelos where the model wrote something you might
 * put your name on, so the affordances are deliberate: the body is an editable
 * textarea that grows to fit, edits persist through PUT /api/drafts, and there
 * is no send button anywhere — Zelos never sends mail, by design. Copy, paste,
 * click send yourself.
 */

import { el, button, section, autogrow, copyText } from '../lib/dom.js';
import { itemRow, foldedList, emptyState } from '../lib/items.js';
import { byUrgency } from '../lib/format.js';
import { state, itemsInBucket, openDrafts, refreshBoard, notify, dropDraft } from '../lib/store.js';
import { api } from '../lib/api.js';

const SAVE_DEBOUNCE_MS = 900;
const SAVE_TIMEOUT_MS = 8_000;

// A card can be rebuilt while its previous instance is still saving. Keep the
// write order and discard gate with the draft, so an old autosave cannot undo
// a Discard made from the new card.
const draftWriters = new Map();
function writerFor(id) {
  if (!draftWriters.has(id)) draftWriters.set(id, { tail: Promise.resolve(), discarding: false, heldSaves: new Set(), pendingSaves: new Set(), revision: 0 });
  return draftWriters.get(id);
}
function writeDraft(id, writer, patch) {
  const pending = writer.tail.then(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);
    try {
      return await api.updateDraft(id, patch, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new Error('Saving took too long. Your text is still here; try again.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
  writer.tail = pending.catch(() => {});
  return pending;
}

function rememberDraftBody(id, body) {
  state.board = {
    ...state.board,
    drafts: state.board.drafts.map(d => d.id === id ? { ...d, body, state: 'edited' } : d),
  };
}

/** The desktop shell waits here before quitting or replacing the page. A
 * failure keeps the renderer and its unsaved text alive for copying or retry.
 * Recheck after awaits: another edit may arrive while an earlier write runs.
 */
export async function flushDrafts() {
  do {
    for (const writer of draftWriters.values()) {
      await writer.tail;
      if (writer.discarding) continue;
      const saved = await Promise.all([...writer.pendingSaves].map(save => save()));
      if (saved.some(ok => !ok)) throw new Error('Some draft edits could not be saved.');
    }
  } while ([...draftWriters.values()].some(writer => !writer.discarding && writer.pendingSaves.size));
  return true;
}

// The shell asks only this fixed callback. A page that has not loaded its
// draft editor cannot hold edits, so it needs no module load before exiting.
globalThis.__zelosFlushDrafts = flushDrafts;

/**
 * Where a mailto address stops being honoured. Real email programs cut the
 * whole thing off somewhere shortly past two thousand characters, and the
 * failure is silent — the compose window opens with most of the reply gone.
 * Under the limit the body rides along whole; past it, the longest clean
 * start that fits, and the card says so.
 */
const MAILTO_LIMIT = 1900;

/**
 * The "Open in your email program" address: recipient, subject and body,
 * with the body's line breaks as CRLF the way RFC 6068 spells them. Returns
 * `{href, truncated}` — truncated when only the start of the body fits.
 */
export function mailtoDraft(to, subject, body) {
  const head = `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject || '')}&body=`;
  const crlf = String(body || '').replace(/\r?\n/g, '\r\n');
  const whole = head + encodeURIComponent(crlf);
  if (whole.length <= MAILTO_LIMIT) return { href: whole, truncated: false };
  // Binary search for the longest start that fits once encoded — the encoded
  // length is not proportional to the raw one, so no arithmetic shortcut.
  const fit = (n) => {
    let cut = crlf.slice(0, n);
    // Never end on half of a two-part character: encodeURIComponent refuses it.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return cut;
  };
  let lo = 0;
  let hi = crlf.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((head + encodeURIComponent(fit(mid))).length <= MAILTO_LIMIT) lo = mid;
    else hi = mid - 1;
  }
  return { href: head + encodeURIComponent(fit(lo)), truncated: true };
}

/**
 * One draft. Local edit state lives on the node, not in the store — re-rendering
 * the whole view under someone's cursor because a sweep finished would be worse
 * than a stale count.
 */
function draftCard(draft, itemsById) {
  const writer = writerFor(draft.id);
  const item = itemsById.get(draft.item_id) || null;
  const status = el('span', { class: 'draft-status mono', role: 'status', text: writer.pendingSaves.size ? 'Unsaved edits' : 'Saved' });
  const area = el('textarea', {
    class: 'draft-body',
    spellcheck: 'true',
    'aria-label': `Draft to ${draft.to_email || 'unknown recipient'}`,
  });
  // A refresh may return an older server copy after saving failed. Keep the
  // latest local words visible, including to Copy, until a write succeeds.
  area.value = writer.pendingSaves.size ? writer.pendingBody : draft.body || '';
  autogrow(area, { min: 120 });

  // The mailto is rebuilt from the LIVE textarea at the moment it is used, so
  // the words that travel are the words on screen — not the body as fetched.
  const mailto = () => mailtoDraft(draft.to_email, draft.subject, area.value);
  const note = el('p', {
    class: 'quiet-note draft-note',
    text: 'Only the start of the reply fits in a new email — Copy the text and paste the whole thing.',
  });
  const syncNote = () => { note.hidden = !(draft.to_email && mailto().truncated); };
  syncNote();

  let timer = null;
  let inFlight = null;
  let dirty = false;
  let revision = writer.revision;

  async function save() {
    clearTimeout(timer);
    if (writer.discarding) { writer.heldSaves.add(save); return true; }
    // A detached card may retain a failed save. Once a newer card has been
    // edited, retrying the old textarea would overwrite the newer words.
    if (revision < writer.revision) {
      dirty = false;
      writer.pendingSaves.delete(save);
      return true;
    }
    if (inFlight) {
      const ok = await inFlight;
      return ok && dirty ? save() : ok;
    }
    if (!dirty) return true;
    dirty = false;
    const body = area.value;
    const savingRevision = revision;
    // The board's copy is patched before the request goes out: a deferred
    // re-render can flush the moment this textarea blurs, and a rebuilt card
    // reads `state.board.drafts` — which still held the body fetched before
    // the edit, so the user watched their own words revert while the server
    // was saving them.
    rememberDraftBody(draft.id, body);
    status.textContent = 'Saving…';
    status.classList.remove('is-bad');
    inFlight = writeDraft(draft.id, writer, { body, state: 'edited' }).then(() => {
      // A board fetch may have returned the old body while this write was in
      // flight. Refresh the visible copy on acknowledgement, but never replace
      // words typed in a newer card with this older response.
      if (savingRevision === writer.revision) rememberDraftBody(draft.id, body);
      status.textContent = 'Saved';
      return true;
    }, (err) => {
      dirty = true;
      status.textContent = err.message;
      status.classList.add('is-bad');
      return false;
    }).finally(() => { inFlight = null; });
    const ok = await inFlight;
    if (ok && dirty) return save();
    if (ok) writer.pendingSaves.delete(save);
    return ok;
  }

  area.addEventListener('input', () => {
    dirty = true;
    revision = ++writer.revision;
    writer.pendingBody = area.value;
    writer.pendingSaves.add(save);
    status.textContent = 'Editing…';
    status.classList.remove('is-bad');
    syncNote();
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  });
  area.addEventListener('blur', () => {
    if (status.textContent === 'Editing…') {
      clearTimeout(timer);
      save();
    }
  });

  return el('article', { class: 'draft' }, [
    el('div', { class: 'draft-head' }, [
      el('div', { class: 'draft-to' }, [
        el('span', { class: 'draft-label mono', text: 'To' }),
        el('span', { class: 'draft-addr', text: draft.to_email || '(no address)' }),
      ]),
      status,
    ]),
    el('h3', { class: 'draft-subject', text: draft.subject || '(no subject)' }),
    item ? el('p', { class: 'draft-because', text: item.headline }) : null,
    area,
    el('div', { class: 'draft-actions' }, [
      button('Copy the text', {
        class: 'btn solid',
        onClick: async (e) => {
          const ok = await copyText(area.value);
          const btn = e.currentTarget;
          btn.textContent = ok ? 'Copied' : 'Copy failed';
          setTimeout(() => { btn.textContent = 'Copy the text'; }, 1_600);
        },
      }),
      draft.to_email
        ? el('a', {
          class: 'btn quiet',
          href: mailto().href,
          text: 'Open in your email program',
          // At CLICK time, so edits ride along: navigation reads the href
          // after the handler runs, and the handler has just rewritten it.
          onclick() {
            this.setAttribute('href', mailto().href);
            syncNote();
          },
        })
        : null,
      button('Discard', {
        class: 'btn quiet',
        onClick: async (e) => {
          if (writer.discarding) return;
          writer.discarding = true;
          const wasEditing = status.textContent === 'Editing…' || dirty;
          clearTimeout(timer);
          dirty = false;
          const discardButton = e.currentTarget;
          discardButton.disabled = true;
          area.disabled = true;
          try {
            await writeDraft(draft.id, writer, { state: 'discarded' });
          } catch (err) {
            writer.discarding = false;
            discardButton.disabled = false;
            area.disabled = false;
            // Restore the autosave cancelled above before notify can repaint
            // the card; the words still on screen must remain recoverable.
            for (const resume of writer.heldSaves) resume();
            writer.heldSaves.clear();
            if (wasEditing) { dirty = true; save(); }
            notify(`Could not discard that draft: ${err.message}`, { tone: 'warn' });
            return;
          }
          writer.heldSaves.clear();
          writer.pendingSaves.clear();
          // Off the page at once, with a redraw (dropDraft). A failed refetch
          // still leaves the successful discard in place — refreshBoard says
          // so itself. The writer is KEPT, discarding: a stale board fetch
          // must never hand a revived card an open gate that would autosave
          // the discarded draft back to life.
          dropDraft(draft.id);
          await refreshBoard();
        },
      }),
    ]),
    note,
  ]);
}

export function renderOwed(ctx) {
  const { tz } = ctx;
  const drafts = openDrafts();
  const promised = itemsInBucket('promised').sort(byUrgency);
  const waiting = itemsInBucket('waiting').sort(byUrgency);
  const itemsById = new Map(state.board.items.map((i) => [i.id, i]));

  const body = el('div', { class: 'view view-owed' });

  if (!drafts.length && !promised.length && !waiting.length) {
    body.appendChild(emptyState({
      title: 'Nobody is waiting on anybody',
      detail: 'When a check finds a reply you owe, a promise you made, or a question of yours that went unanswered, it lands here — with a reply already written where one helps.',
    }));
    return body;
  }

  // "Ready to send" and "never sends mail" in one breath was the audit's
  // complaint; the heading now says whose words these are and the note says
  // where the sending happens.
  body.appendChild(section('Replies it wrote for you', {
    count: drafts.length,
    note: 'Open one in your email program, check it, and press send there. Zelos never sends anything itself.',
  }, drafts.length
    ? el('div', { class: 'stack' }, drafts.map((d) => draftCard(d, itemsById)))
    : el('p', { class: 'quiet-note', text: 'No drafts waiting.' })));

  body.appendChild(section('You owe them', { count: promised.length },
    promised.length
      ? foldedList(promised, (item) => itemRow(item, { tz, showBucket: false }), { visible: 8 })
      : el('p', { class: 'quiet-note', text: 'Nothing outstanding from you.' })));

  body.appendChild(section('They owe you', { count: waiting.length },
    waiting.length
      ? foldedList(waiting, (item) => itemRow(item, { tz, showBucket: false }), { visible: 8 })
      : el('p', { class: 'quiet-note', text: 'Nothing outstanding to you.' })));

  return body;
}
