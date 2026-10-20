/**
 * ui/views/now.js — the page you open first.
 *
 * The whole discipline of this view is subtraction. One hero, at most four
 * others, and everything else folded away. core/triage.mjs already clamps `now`
 * to four in code; this view is what that clamp is for.
 *
 * A word on words. The code says "sweep" and "model" because those are the
 * names the engine uses; the screen says "check" and "AI" because those are
 * the names a person uses, and the audit's reader heard a broom in the first
 * and a model car in the second. Nothing on this screen names an address the
 * person did not type: a failure on a fresh install says no AI has been chosen,
 * not the URL of the provider it would have asked.
 */

import { el, button, meander, section } from '../lib/dom.js';
import { itemHero, itemRow, emptyState } from '../lib/items.js';
// The one control this view borrows from Settings: the "Stuck? Ask Claude"
// line under the empty state of a home with no AI, about the AI step.
import { askClaude } from './settings.js';
import { byUrgency, sweepSummary, plural } from '../lib/format.js';
import { state, startSweep, itemsInBucket, snoozedItems, finishedItems, boardNotes } from '../lib/store.js';
import { humanDelta, instant } from '../lib/time.js';
import { readingStatus } from '../lib/source-status.js';

const MAX_NOW_ROWS = 4;

/**
 * What a sweep on this home is missing before it can succeed at all — 'model',
 * 'sources' — or null. One rule, read by the empty state and by the failure
 * banner, so the two cannot disagree about whether "Check again" is advice.
 */
function missingSetup() {
  if (!state.health?.model?.configured) return 'model';
  // Mail, calendars, and the connector sources in Settings → Other things it
  // can read: a home reading only GitHub is a home with something to read, and
  // under a whole failure the banner must offer "Check again", not "Connect an
  // email account".
  const hasSources = (state.config?.mail?.length || 0) + (state.config?.calendars?.length || 0)
    + (state.config?.sources?.length || 0) > 0;
  return hasSources ? null : 'sources';
}

/** The one sentence for a home with no AI, shared by the empty state and the banner. */
const NO_AI_YET = 'Zelos can’t read anything yet because no AI has been chosen.';

/**
 * Why the board is empty is a different screen every time, and each one has to
 * say what to do next. "Nothing here" with no explanation is the failure mode
 * this function exists to avoid.
 */
function emptyForContext(navigate) {
  const missing = missingSetup();
  const last = state.board.runs?.last;

  if (missing === 'model') {
    return emptyState({
      title: 'No AI chosen yet',
      detail: `${NO_AI_YET} Zelos reads your mail and calendar and thinks about them with an AI you choose — including one running on this computer.`,
      // A plain wrapper, not a .stack: that one is a column flex and would
      // stretch the button across the card, where it has always sat inline.
      action: el('div', {}, [
        button('Choose an AI', { class: 'btn solid', onClick: () => navigate('#/settings/model') }),
        askClaude({ step: 'ai' }),
      ]),
    });
  }
  if (missing === 'sources') {
    return emptyState({
      title: 'Nothing to read yet',
      detail: 'Connect an email account or a calendar and Zelos will have something to think about. Both stay on this computer.',
      action: button('Connect an email account', { class: 'btn solid', onClick: () => navigate('#/settings/mail') }),
    });
  }
  if (!last) {
    return emptyState({
      title: 'Ready for the first check',
      detail: 'Zelos will fetch your recent mail and calendar, then ask the AI what actually needs you.',
      action: button('Check now', { class: 'btn solid', onClick: () => startSweep('full') }),
    });
  }
  if (last.ok === false) {
    return emptyState({
      title: 'The last check did not finish',
      detail: last.error || 'It failed without saying why. Run from a terminal, the reason is in that terminal — Zelos keeps no log file of its own. In the desktop app it is in desktop.log, under Board → Show logs.',
      action: button('Try again', { class: 'btn solid', onClick: () => startSweep('full') }),
    });
  }
  return emptyState({
    title: 'Nothing needs you.',
    detail: `Last checked ${humanDelta(last.ended_at || last.started_at)}. ${sweepSummary(last)}`.trim(),
  });
}

/**
 * Which of the two sweep failures the board is living with — 'whole', 'partial'
 * or neither.
 *
 * A run that lost ONE source comes back `ok: true`. A revoked app password, a
 * 404'd `.ics`, a Sent folder that is not called Sent: the sweep shrugs, writes
 * `stats.sourcesFailed`, and the board just gets quieter — while this view said
 * "Nothing needs you." and named the failure nowhere. `sourcesFailed` and
 * `sources[]` are written by every sweep and, until this function existed, were
 * read by nothing in the app; the CLI printed the list, the screen people
 * actually look at did not.
 *
 * `sources[]` is the better signal because it carries the reason, but a run
 * that died before the count was taken has one and not the other, so both are
 * consulted and the larger wins.
 */
function sweepTrouble() {
  const last = state.board.runs?.last;
  if (state.sweep.error || (last && last.ok === false)) return 'whole';
  const named = (last?.stats?.sources || []).filter((s) => s && s.ok === false).length;
  const counted = Number(last?.stats?.sourcesFailed) || 0;
  return Math.max(named, counted) > 0 ? 'partial' : null;
}

/**
 * The failed-sweep banner. Persistent, specific, and it names the source.
 *
 * Two failures, two tones, two sentences. "The last check failed" over a run
 * that read four sources out of five is a lie in the alarming direction, and it
 * would send the reader looking for a broken app instead of a dead password.
 */
function failureBanner(trouble, navigate) {
  const last = state.board.runs?.last;
  const live = state.sweep.error;
  // Under a whole failure on a home with no model or nothing to read,
  // "Check again" is the failure again: the one action on the screen ran the
  // same run that wrote the banner. What is missing is a setting, so the
  // action opens it — and the sentence is about the setting, never about the
  // address the engine would have called.
  const missing = trouble === 'whole' ? missingSetup() : null;
  const failedSources = (last?.stats?.sources || []).filter((s) => s && s.ok === false);
  const counted = Math.max(failedSources.length, Number(last?.stats?.sourcesFailed) || 0);
  const whole = trouble === 'whole';
  const message = whole
    ? (missing === 'model' ? NO_AI_YET : (live || last?.error || 'The last check failed.'))
    : `${counted === 1 ? 'One account or calendar' : `${counted} accounts or calendars`} could not be read. Everything else on the board is from this check — whatever those hold is not.`;

  return el('div', { class: `banner ${whole ? 'banner-bad' : 'banner-warn'}`, role: 'status' }, [
    el('h2', {
      class: 'banner-title',
      text: whole ? 'The last check failed' : 'The last check could not read everything',
    }),
    el('p', { class: 'banner-detail', text: message }),
    failedSources.length
      ? el('ul', { class: 'banner-list' }, failedSources.map((s) =>
        el('li', { text: `${s.label}: ${s.error}` })))
      : null,
    el('div', { class: 'banner-actions' }, [
      missing === 'model'
        ? button('Choose an AI', { class: 'btn solid', onClick: () => navigate('#/settings/model') })
        : missing === 'sources'
          ? button('Connect an email account', { class: 'btn solid', onClick: () => navigate('#/settings/mail') })
          : button('Check again', { class: 'btn solid', onClick: () => startSweep('full') }),
    ]),
  ]);
}

/* Whether the Finished fold is open, across redraws. Every tick, Undo or
   dismissal in it bumps the board and rebuilds this view, and the fold used to
   snap shut under the person working through it (QA, 2026-10-10, TT-3519). */
let finishedOpen = false;

export function renderNow(ctx) {
  const { tz, navigate } = ctx;
  const nowItems = itemsInBucket('now').sort(byUrgency);
  const firstId = state.board.first;
  const hero = nowItems.find((i) => i.id === firstId)
    || state.board.items.find((i) => i.id === firstId && i.state === 'open')
    || nowItems[0]
    || null;
  const rest = nowItems.filter((i) => i.id !== hero?.id).slice(0, MAX_NOW_ROWS);
  // Through the store, not off state.board directly: the rail's "Worth
  // knowing" row counts the same list, and the two filtering it separately is
  // how they came to print different numbers side by side.
  const notes = boardNotes();
  const noteItems = itemsInBucket('note');

  const body = el('div', { class: 'view view-now' });
  const trouble = sweepTrouble();
  const banner = trouble ? failureBanner(trouble, navigate) : null;
  if (banner) body.appendChild(banner);

  if (!hero) {
    // When the banner is up it has already said what failed and offered the
    // retry. Repeating both in the empty state — same fact, two boxes, two
    // buttons — reads like the app panicking, so under a banner the empty
    // state is just the plain shell. After a PARTIAL failure the sweep did
    // finish, so "the board fills in when a check finishes" would be the
    // reassurance this whole banner exists to withdraw.
    //
    // The title has to carry that too, not only the detail. Branching the
    // detail alone still left "Nothing on the board yet." as the largest text
    // on an empty screen, and "yet" is the whole reassurance: it says the board
    // is between sweeps and will fill in. After a partial failure the board is
    // as full as it is ever going to get from this run, and the part nobody has
    // seen is the part that could not be read. Two titles, because they are two
    // different states of the world.
    //
    // The one case the plain shell gets wrong: a WHOLE failure on a home with
    // no model, or nothing to read. "The board fills in when a check finishes"
    // is a promise about a check that cannot, and the context-aware empty
    // state — the only place "Choose an AI" lives — went missing the moment
    // the first scheduled run failed, which on such a home is thirty minutes
    // in. So there it comes back under the banner, which has already swapped
    // its own action to match.
    if (trouble === 'whole' && missingSetup()) {
      body.appendChild(emptyForContext(navigate));
    } else {
      body.appendChild(banner
        ? emptyState(trouble === 'partial'
          ? {
            title: 'Nothing on the board — and not everything was read',
            detail: 'Nothing Zelos could read needs you. The accounts named above went unread, '
              + 'and whatever they hold is not on this board.',
          }
          : {
            title: 'Nothing on the board yet.',
            detail: 'The board fills in when a check finishes.',
          })
        : emptyForContext(navigate));
    }
  } else {
    body.appendChild(itemHero(hero, { tz }));
    if (rest.length) {
      body.appendChild(section('Then these', { count: rest.length }, [
        el('div', { class: 'stack' }, rest.map((item) => itemRow(item, { tz, showBucket: false }))),
      ]));
    }
  }

  if (notes.length || noteItems.length) {
    const panel = el('div', { class: 'worth-body', hidden: true }, [
      notes.length
        ? el('ul', { class: 'notes' }, notes.map((n) => el('li', { text: n })))
        : null,
      noteItems.length
        ? el('div', { class: 'stack' }, noteItems.map((item) => itemRow(item, { tz, showBucket: false })))
        : null,
    ]);
    const toggle = el('button', {
      type: 'button',
      class: 'worth-toggle',
      'aria-expanded': 'false',
      onclick() {
        const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', open ? 'false' : 'true');
        panel.hidden = open;
      },
    }, [
      el('span', { text: 'Worth knowing' }),
      el('span', { class: 'mono worth-count', text: String(notes.length + noteItems.length) }),
    ]);

    body.appendChild(el('section', { class: 'section worth' }, [toggle, meander(), panel]));
  }

  const todayCount = state.board.counts.today || 0;
  if (todayCount) {
    body.appendChild(el('p', { class: 'handoff' }, [
      el('span', { text: `${plural(todayCount, 'other thing')} for today. ` }),
      button('Open Today', { class: 'link', onClick: () => navigate('#/today') }),
    ]));
  }

  const connections = readingStatus(navigate);
  if (connections) body.appendChild(connections);

  // The snoozed, folded and dimmed at the very bottom: off the board but never
  // off the record. Each row says when it comes back, and Wake lives in the
  // row's own disclosure. Soonest return first.
  const snoozed = snoozedItems().sort((a, b) =>
    (instant(a.snoozed_until) ?? Infinity) - (instant(b.snoozed_until) ?? Infinity));
  if (snoozed.length) {
    const reveal = ctx.sub === 'snoozed';
    const panel = el('div', { class: 'worth-body', hidden: !reveal },
      el('div', { class: 'stack' }, snoozed.map((item) => itemRow(item, { tz, showBucket: false }))));
    const toggle = el('button', {
      type: 'button',
      class: 'worth-toggle',
      'aria-expanded': reveal ? 'true' : 'false',
      onclick() {
        const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', open ? 'false' : 'true');
        panel.hidden = open;
      },
    }, [
      el('span', { text: 'Snoozed' }),
      el('span', { class: 'mono worth-count', text: String(snoozed.length) }),
    ]);
    body.appendChild(el('section', { class: 'section worth' }, [toggle, meander(), panel]));
  }

  // What you finished, folded last of all: recent done and dismissed rows,
  // newest first as the server sends them — off the board but never off the
  // record. The tick on a done row is already the way back: clicking it
  // reopens the item, so a slipped click yesterday is one click to reverse.
  //
  // Above them, the open items whose tasks all left the task selection — a
  // task ticked off in Todoist, most often. They are off the board because
  // absence is not proof of done, and they used to be nowhere at all; here
  // each one is a tick (done) away from settled, or "Not a thing" if it never
  // was work (QA, 2026-10-10, TT-3519). Settled, such a row's tick stays
  // locked — reopened, it would only leave the board again — so the way back
  // is the Undo in the toast, or the task returning to the selection.
  // The fold counts the two groups apart: the open ones are not finished.
  const finished = finishedItems();
  if (finished.length) {
    const left = finished.filter((item) => item.sourceInactive === true && item.state === 'open');
    const decided = finished.filter((item) => !left.includes(item));
    const rows = (list) => el('div', { class: 'stack' }, list.map((item) => itemRow(item, { tz, showBucket: false })));
    const panel = el('div', { class: 'worth-body', hidden: !finishedOpen }, [
      left.length ? el('p', { class: 'quiet-note', text: 'No longer in task selection' }) : null,
      left.length ? rows(left) : null,
      decided.length ? rows(decided) : null,
    ]);
    const toggle = el('button', {
      type: 'button',
      class: 'worth-toggle',
      'aria-expanded': finishedOpen ? 'true' : 'false',
      onclick() {
        const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', open ? 'false' : 'true');
        panel.hidden = open;
        finishedOpen = !open;
      },
    }, [
      el('span', { text: 'Finished recently' }),
      el('span', { class: 'mono worth-count', text: String(decided.length) }),
      left.length ? el('span', { class: 'mono worth-count', text: `· ${left.length} no longer in task selection` }) : null,
    ]);
    body.appendChild(el('section', { class: 'section worth is-finished' }, [toggle, meander(), panel]));
  }

  return body;
}
