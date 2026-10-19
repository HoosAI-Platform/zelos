/**
 * ui/views/onboarding.js — first run.
 *
 * Five named steps — Welcome, AI, Email, Calendar, Done — with the names on
 * screen from the first one, and a "Step 2 of 5" line so the person knows how
 * long this is. The first screen is two buttons: set Zelos up, or look around
 * with made-up data first. Nothing on it probes anything; the sentence about
 * four ports that did not answer used to be the first thing a person read,
 * and it read as an error.
 *
 * *Honest*: nothing here claims a thing is set up when it is not. The sample
 * data says out loud that it is invented and can be removed in one click; the
 * last step says plainly when it has nothing to read, and which earlier step
 * would give it something.
 *
 * The later steps are not a funnel, they are a menu. Each mounts the same
 * panel Settings uses, so there is exactly one implementation of "connect an
 * email account", and every one of them can be walked past.
 *
 * The words are for someone who has never heard of a protocol. "The AI that
 * reads your mail" is the model; "your email account" is the IMAP source;
 * "check" is the sweep. The code keeps the engine's names — `step === 'model'`,
 * `startSweep` — because those are the routes and the calls; the screen does
 * not. test/ui.test.mjs renders these screens and reads what is on them, and
 * fails on any word from the first list.
 */

import { el, button, meander } from '../lib/dom.js';
import { modelPanel, mailPanel, calendarPanel, askClaude, forgetOutcomes } from './settings.js';
import {
  state, subscribe, startSweep, markOnboarded, refresh, notify,
} from '../lib/store.js';
import { request, ApiError } from '../lib/api.js';
import { sweepSummary } from '../lib/format.js';

const STEPS = ['start', 'model', 'mail', 'calendar', 'sweep'];
const STEP_LABELS = {
  start: 'Welcome',
  model: 'AI',
  mail: 'Email',
  calendar: 'Calendar',
  sweep: 'Done',
};

let step = 'start';

/**
 * A per-session fact, not a per-render one. Caching it here keeps a rerender
 * from re-asking the server whether it knows about sample data every time
 * somebody clicks.
 */
let sampleState = null;     // null = not asked yet | {supported:false} | {supported:true, ...status}
let sampleError = '';

function go(stepId, rerender) {
  step = stepId;
  // Each step mounts a Settings panel, which keeps what it last said about a
  // save across a redraw. A step is a new screen: the AI step's "Working."
  // must not greet someone who comes back to it from Email (TT-3448).
  forgetOutcomes();
  rerender();
}

function next(rerender) {
  const i = STEPS.indexOf(step);
  go(STEPS[Math.min(STEPS.length - 1, i + 1)], rerender);
}

function finish(navigate) {
  markOnboarded(true);
  step = 'start';
  navigate('#/now');
}

function progressRail(rerender) {
  return el('ol', { class: 'ob-rail', 'aria-label': 'Setup steps, all optional' }, STEPS.map((id, i) => {
    const done = STEPS.indexOf(step) > i;
    return el('li', { class: `ob-step${id === step ? ' is-current' : ''}${done ? ' is-done' : ''}` },
      el('button', {
        type: 'button',
        class: 'ob-step-btn',
        'aria-current': id === step ? 'step' : null,
        onclick: () => go(id, rerender),
      }, [
        el('span', { class: 'ob-step-num mono', text: String(i + 1) }),
        el('span', { class: 'ob-step-label', text: STEP_LABELS[id] }),
      ]));
  }));
}

/** "Step 2 of 5 · AI" — said in words, because the rail's labels hide on a narrow screen. */
export function stepLine(current = step) {
  const i = Math.max(0, STEPS.indexOf(current));
  return `Step ${i + 1} of ${STEPS.length} · ${STEP_LABELS[STEPS[i]]}`;
}

/**
 * `actions` overrides the default row wholesale — the welcome screen swaps its
 * own in once the sample-data probe lands, because whether the second button
 * loads the made-up week or clears it depends on what came back.
 *
 * `help` names the screen for the "Stuck? Ask Claude" line under the
 * actions — 'general' on Welcome, 'first-check' on Done. The three middle
 * steps pass nothing: each mounts a Settings panel, and the panel carries
 * its own line, about the provider once it knows one.
 */
function shell(rerender, navigate, { title, lede, body, primary = null, skip = 'Do this later', actions = null, help = null }) {
  return el('div', { class: 'view view-onboarding' }, [
    el('header', { class: 'ob-head' }, [
      el('p', { class: 'ob-mark', title: 'Zelos, in Greek', text: 'ΖΗΛΟΣ' }),
      progressRail(rerender),
      el('p', { class: 'quiet-note ob-count', text: stepLine() }),
    ]),
    meander({ class: 'ob-rule' }),
    el('h1', { class: 'ob-title', text: title }),
    lede ? el('p', { class: 'ob-lede', text: lede }) : null,
    el('div', { class: 'ob-body' }, body),
    actions || el('div', { class: 'ob-actions' }, [
      primary,
      step === 'sweep'
        ? button('Go to the board', { class: 'btn quiet', onClick: () => finish(navigate) })
        : skip && button(skip, { class: 'btn quiet', onClick: () => next(rerender) }),
      button('Skip the rest', { class: 'link', onClick: () => finish(navigate) }),
    ]),
    help ? askClaude({ step: help }) : null,
  ]);
}

/** When something is wrong, the answer is a command, not a shrug — said once, and plainly. */
function doctorNote(reason) {
  return el('p', { class: 'quiet-note' }, [
    `${reason} If you started Zelos from a terminal, `,
    el('span', { class: 'code mono', text: 'zelos doctor' }),
    ' there checks everything and says what is wrong in plain English.',
  ]);
}

/* ------------------------------------------------------------- sample data */

/**
 * The sample dataset is served by the local API, so the button only exists when
 * the running build actually offers it — a 404 here means this copy of Zelos has
 * no sample route, and an offer that cannot be honoured is worse than no offer.
 *
 *   GET    /api/sample-data  -> {installed, seededAt, counts, summary}
 *   POST   /api/sample-data  -> seeds the demo week into the current home
 *   DELETE /api/sample-data  -> removes exactly what it added
 */
const sampleApi = {
  status: () => request('/api/sample-data'),
  load: () => request('/api/sample-data', { method: 'POST' }),
  clear: () => request('/api/sample-data', { method: 'DELETE' }),
};

async function readSampleState() {
  if (sampleState) return sampleState;
  try {
    const status = await sampleApi.status();
    sampleState = { supported: true, ...status };
  } catch (err) {
    const missing = err instanceof ApiError && (err.status === 404 || err.status === 405);
    sampleState = missing ? { supported: false } : { supported: false, error: err.message };
  }
  return sampleState;
}

async function loadSample(rerender, navigate) {
  sampleError = '';
  try {
    await sampleApi.load();
    sampleState = null;
    await refresh({ silent: true });
    notify('The made-up week is loaded. Every row is marked, and one click removes it.', { tone: 'info' });
    finish(navigate);
  } catch (err) {
    sampleError = `Could not load the made-up data: ${err.message}`;
    rerender();
  }
}

async function clearSample(rerender) {
  sampleError = '';
  try {
    await sampleApi.clear();
    sampleState = null;
    await refresh({ silent: true });
    notify('The made-up data is gone. Nothing else was touched.', { tone: 'info' });
  } catch (err) {
    sampleError = `Could not clear the made-up data: ${err.message}`;
  }
  rerender();
}

/* ------------------------------------------------------------ welcome screen */

function startScreen(rerender, navigate) {
  const sampleNote = el('div', { class: 'ob-outcome' });
  const actions = el('div', { class: 'ob-actions' },
    button('Set up Zelos', { class: 'btn solid', onClick: () => go('model', rerender) }));

  /**
   * The action row, painted from whatever the sample probe has answered so far.
   *
   * This ran behind `if (!actions.isConnected) return;`, which was never true
   * when it mattered. The synchronous call below happens before `shell()`
   * puts `actions` in a tree, so the first pass always bailed, and the
   * `.finally` that made up for it is gated on the module-level cache — so on
   * the SECOND build of this screen, with the probe already answered, it did
   * not run and the row kept its placeholder. Sample data has no other way in
   * anywhere in the app, and `watchBoard` rebuilds this screen every three
   * minutes and on every tab-visibility change, so the row emptied itself
   * while nobody touched it.
   *
   * There is nothing here that needs a live node — `replaceChildren` on a
   * detached element is perfectly ordinary — so there is no guard.
   */
  const paintActions = () => {
    const sample = sampleState?.supported ? sampleState : null;

    // Two buttons. The first is setup; the second is the way to see the
    // board before connecting anything — with the made-up week when this
    // build ships one, and bare when it does not.
    const row = [button('Set up Zelos', { class: 'btn solid', onClick: () => go('model', rerender) })];
    if (sample && !sample.installed) {
      row.push(button('Look around with made-up data first', {
        class: 'btn quiet',
        onClick: async (e) => { e.currentTarget.disabled = true; await loadSample(rerender, navigate); },
      }));
    } else if (sample && sample.installed) {
      row.push(button('Look around', { class: 'btn quiet', onClick: () => finish(navigate) }));
      row.push(button('Clear the made-up data', { class: 'link', onClick: () => clearSample(rerender) }));
    } else {
      row.push(button('Look around first', { class: 'btn quiet', onClick: () => finish(navigate) }));
      if (sampleState?.error) {
        row.push(button('Retry sample data', {
          class: 'btn quiet',
          onClick: async (e) => {
            e.currentTarget.disabled = true;
            sampleState = null;
            await readSampleState();
            paintActions();
          },
        }));
      }
    }
    actions.replaceChildren(...row);

    if (sample) {
      sampleNote.replaceChildren(el('p', {
        class: 'quiet-note',
        text: sample.installed
          ? 'The made-up week is loaded. Every row of it starts with “Sample ·”, and clearing it removes exactly those rows and nothing of yours.'
          : 'The made-up data is a week at a small studio, so the board has something on it before you connect anything. Every row is marked, and one click takes it back out.',
      }));
    } else if (sampleState && sampleState.error) {
      sampleNote.replaceChildren(el('p', { class: 'quiet-note', text: `The made-up data is not available: ${sampleState.error}` }));
    } else {
      sampleNote.replaceChildren();
    }
    if (sampleError) sampleNote.appendChild(el('p', { class: 'quiet-note is-bad', role: 'alert', text: sampleError }));
  };

  paintActions();

  if (!sampleState) {
    readSampleState().finally(paintActions);
  }

  return shell(rerender, navigate, {
    title: 'Zelos reads your email and calendar, and tells you what needs you.',
    lede: 'It never sends, moves or deletes your mail. Your archive is stored on this computer.',
    body: el('div', { class: 'stack' }, [
      sampleNote,
      el('ul', { class: 'ob-points' }, [
        el('li', { text: 'Zelos only looks at your mail. It never marks anything read, never moves anything, never deletes anything.' }),
        el('li', { text: 'The thinking is done by an AI you choose. Choose one running on this computer to process what Zelos reads here.' }),
        el('li', { text: 'Zelos never sends mail. It writes replies for you; you press send, in your own email program.' }),
      ]),
    ]),
    actions,
    help: 'general',
  });
}

/* -------------------------------------------------------------- done step */

/** The last step's live progress. Subscribes itself; detaches when removed. */
function sweepProgress() {
  const line = el('p', { class: 'ob-progress-line', 'aria-live': 'polite' });
  const bar = el('div', { class: 'ob-bar' }, el('div', { class: 'ob-bar-fill' }));
  const fill = bar.firstChild;
  const outcome = el('div', { class: 'ob-outcome' });

  const paint = () => {
    const s = state.sweep;
    if (s.running) {
      line.textContent = s.message || 'Working…';
      const pct = s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : null;
      bar.classList.toggle('is-indeterminate', pct === null);
      fill.style.width = pct === null ? '100%' : `${pct}%`;
      outcome.replaceChildren();
      return;
    }
    if (s.error) {
      line.textContent = 'The check stopped.';
      bar.classList.remove('is-indeterminate');
      fill.style.width = '0%';
      outcome.replaceChildren(
        el('p', { class: 'status is-bad', text: s.error }),
        doctorNote('That is usually an email account or an AI that cannot be reached.'),
      );
      return;
    }
    if (s.lastResult) {
      line.textContent = 'Done.';
      bar.classList.remove('is-indeterminate');
      fill.style.width = '100%';
      outcome.replaceChildren(el('p', { class: 'status is-good', text: sweepSummary({ stats: s.lastResult.stats }) || 'The board is up to date.' }));
      return;
    }
    line.textContent = 'Not started.';
    fill.style.width = '0%';
  };

  const unsubscribe = subscribe(() => {
    if (!line.isConnected) {
      unsubscribe();
      return;
    }
    paint();
  });
  paint();

  return el('div', { class: 'ob-progress' }, [line, bar, outcome]);
}

/**
 * What the last step still needs, said by step number so the person knows
 * where to go back to. Exported so the sentence is tested rather than read.
 */
export function notReadyLine({ model = false, sources = false } = {}) {
  if (model && sources) return 'Zelos can’t read anything yet — it still needs an AI (step 2) and an email account (step 3).';
  if (model) return 'Zelos can’t read anything yet — it still needs an AI (step 2).';
  if (sources) return 'Zelos can’t read anything yet — it still needs an email account (step 3).';
  return '';
}

/* ------------------------------------------------------------------ render */

export function renderOnboarding(ctx) {
  const { rerender, navigate } = ctx;

  if (step === 'start') return startScreen(rerender, navigate);

  if (step === 'model') {
    return shell(rerender, navigate, {
      title: 'Pick the AI that reads your mail.',
      lede: null,
      body: modelPanel({ compact: true, onDone: () => next(rerender) }),
      primary: button('Next', { class: 'btn solid', onClick: () => next(rerender) }),
    });
  }

  if (step === 'mail') {
    return shell(rerender, navigate, {
      title: 'Connect your email.',
      lede: 'Type your email address and Zelos will show you the next step.',
      body: mailPanel({ compact: true, rerender, onDone: () => rerender() }),
      primary: button('Next', { class: 'btn solid', onClick: () => next(rerender) }),
    });
  }

  if (step === 'calendar') {
    return shell(rerender, navigate, {
      title: 'Add your calendar.',
      lede: 'Pick the one you use. Google Calendar goes with a Gmail address; iCloud is the calendar on an iPhone or Mac.',
      body: calendarPanel({ compact: true, rerender, onDone: () => rerender() }),
      primary: button('Next', { class: 'btn solid', onClick: () => next(rerender) }),
    });
  }

  const missingModel = !state.health?.model?.configured;
  // Mail, calendars, AND the connector sources under Settings → Other things
  // it can read — the same rule now.js's missingSetup() applies: a home
  // reading only GitHub is a home with something to read.
  const missingSources = ((state.config?.mail?.length || 0) + (state.config?.calendars?.length || 0)
    + (state.config?.sources?.length || 0)) === 0;
  const ready = !missingModel && !missingSources;

  return shell(rerender, navigate, {
    title: 'Read my mail for the first time.',
    lede: ready
      ? 'Zelos fetches your recent mail and calendar, then asks the AI to read through it once. It takes as long as it takes; the progress below is real.'
      : notReadyLine({ model: missingModel, sources: missingSources }),
    body: el('div', { class: 'stack' }, [
      sweepProgress(),
      !ready ? el('p', { class: 'quiet-note', text: 'You can go back to either step, or go to the board — everything still works, there is just nothing to read yet.' }) : null,
    ]),
    primary: button(state.sweep.running ? 'Reading…' : 'Read my mail now', {
      class: 'btn solid',
      disabled: !ready || state.sweep.running,
      title: ready ? null : notReadyLine({ model: missingModel, sources: missingSources }),
      onClick: async () => {
        await startSweep('full');
        await refresh({ silent: true });
      },
    }),
    help: 'first-check',
  });
}
