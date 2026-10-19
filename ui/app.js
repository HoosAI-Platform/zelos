/**
 * ui/app.js — the shell: chrome, routing, and the one render loop.
 *
 * Two decisions here are worth knowing about.
 *
 * 1. **The main view re-renders on `state.rev`, not on every store event.** A
 *    sweep emits progress several times a second; rebuilding the view on each
 *    one would wipe out a draft someone is halfway through typing. The chrome
 *    (counts, sweep line) is cheap and repaints on every event — but the quick
 *    capture panel inside it DOES hold input, so the chrome is updated in
 *    place around a panel that is built exactly once and never rebuilt. And
 *    because "the data changed" can arrive while a cursor is inside a form in
 *    the view too, a board-driven re-render is deferred until that field blurs.
 *
 * 2. **Nothing is ever assembled from a string.** Every node below comes from
 *    ui/lib/dom.js, which has no innerHTML path at all — a subject line is text,
 *    whatever it contains.
 */

import { el, button, meander, replace, focusQuietly } from './lib/dom.js';
import {
  state, subscribe, refresh, watchSweeps, watchBoard, startSweep, railCounts, timezone,
  needsOnboarding, onboardingDone, applyAccent, currentAccent, notify, dismissToast, nowMark, checkAgainLine,
} from './lib/store.js';
import { api, hasToken } from './lib/api.js';
import { BUCKET_LABEL, sweepSummary, sweepDetail, tokenLine } from './lib/format.js';
import { humanDelta, formatDay } from './lib/time.js';
import { createCommandMenu, commandShortcut } from './lib/commands.js';
import { parseConnectionTarget } from './lib/source-status.js';
import { updateBanner } from './lib/update-banner.js';
import { updatesPanel } from './lib/updates.js';
import { isEditing } from './lib/editing.js';

import { renderNow } from './views/now.js';
import { renderToday } from './views/today.js';
import { renderOwed } from './views/owed.js';
import { renderCalendar, tickNowLine } from './views/calendar.js';
import { renderSearch } from './views/search.js';
import { renderAsk } from './views/ask.js';
import { renderSettings, forgetOutcomes } from './views/settings.js';
import { renderOnboarding } from './views/onboarding.js';

// Search carries no count. Every other number in the rail is a claim about work
// that is waiting; "how many things could you find" is not one, and a badge
// there would read as one.
const VIEWS = [
  { id: 'now', label: 'Now', render: renderNow, countKey: 'now' },
  { id: 'today', label: 'Today', render: renderToday, countKey: 'today' },
  // "Promises", not "Owed": owed what, by whom? was the audit's question. The
  // view holds what you promised and what was promised to you.
  { id: 'owed', label: 'Promises', render: renderOwed, countKey: 'drafts' },
  { id: 'calendar', label: 'Calendar', render: renderCalendar, countKey: 'events' },
  { id: 'search', label: 'Search', render: renderSearch, countKey: null },
  { id: 'ask', label: 'Ask', render: renderAsk, countKey: null },
  { id: 'settings', label: 'Settings', render: renderSettings, countKey: null },
];

/** Which view owns each bucket, so a count in the rail is also a way in. */
const BUCKET_ROUTE = {
  now: '#/now',
  today: '#/today',
  soon: '#/today',
  money: '#/today',
  waiting: '#/owed',
  promised: '#/owed',
  note: '#/now',
};

const root = document.getElementById('app');

let route = { view: 'now', sub: null };
/** The hash `route` came from, to put back when setup turns a hash away. */
let routeHash = '#/now';
let lastRenderKey = '';
let setupActive = false;

// A model save changes whether setup is needed, but does not finish a setup
// already on screen. Keep that flow until its own Finish/Skip action marks it
// complete. This is set only after boot, so existing configured homes bypass it.
function showOnboarding(r = route) {
  return r.view === 'welcome' || (setupActive && !onboardingDone()) || needsOnboarding();
}

function parseHash() {
  const raw = (window.location.hash || '#/now').replace(/^#\/?/, '');
  const [view, sub, target] = raw.split('/');
  if (view === 'welcome') return { view: 'welcome', sub: null };
  const known = VIEWS.find((v) => v.id === view);
  return { view: known ? known.id : 'now', sub: sub || null,
    connectionId: view === 'settings' ? parseConnectionTarget(target) : null };
}

function navigate(hash) {
  if (window.location.hash === hash) {
    // Activating the sub-tab you are already on moves no route, so hashchange
    // never fires and onRoute never runs — but render() still rebuilds the
    // view and detaches the button that was pressed. Focus has to be put back
    // here too, or the one case that changes nothing is the one that loses it.
    render({ force: true });
    if (!focusConnectionTarget()) refocusSelectedTab();
    return;
  }
  window.location.hash = hash;
}

/* ------------------------------------------------------------------ chrome */

/**
 * Say something in a live region, in the one way that actually reaches a screen
 * reader: as a MUTATION of a region that is already in the document.
 *
 * Text baked into a node before it is inserted is never announced, and neither
 * is text carried in on a node that replaces the old one — which is exactly how
 * the sweep line and every toast in this app came to be silent. Both were built
 * complete and then swapped in. So the regions below are created empty, kept
 * for the life of the page where they can be, and filled a frame later.
 * ui/views/ai-access.js does the same thing for the same reason.
 */
const announced = new WeakMap();

function announce(node, text) {
  const value = text || '';
  if (announced.get(node) === value) return;
  announced.set(node, value);
  requestAnimationFrame(() => {
    // A newer announcement may have overtaken this one between frames.
    if (announced.get(node) === value) node.textContent = value;
  });
}

/**
 * The sweep line: one node, built once, repainted in place. Its text is the
 * live region above, so this line is where "Checking your mail…", "Finished
 * checking" and a check's failure are spoken as well as shown.
 *
 * What it says is "Last checked 20 minutes ago · 214 emails · 28
 * appointments". The run's duration and the day's token spend — "41.8s",
 * "9.8k tokens in · 135 out" — were the most prominent numbers on the screen
 * and the least explicable ones (bus tokens? is this costing me money?), so
 * they moved behind the line's hover title, and the spend is stated in full
 * under Settings → About as "AI usage this session".
 */
function buildSweepLine() {
  const textNode = el('p', { class: 'sweepline-text mono', 'aria-live': 'polite' });
  const fillNode = el('div', { class: 'sweepbar-fill', style: { width: '0%' } });
  const barNode = el('div', { class: 'sweepbar' }, fillNode);
  return {
    node: el('div', { class: 'sweepline' }, [textNode, barNode]),
    textNode,
    barNode,
    fillNode,
  };
}

/** "Last checked 20 minutes ago · 3 emails", or the state of the check under way. */
export function sweepLineText(s, last, scheduler = null) {
  if (s.running) return s.message || 'Checking your mail…';
  // One paint after a check ends: what it found, before the line settles back
  // to "Last checked…". paintSweepLine clears it once it has been shown.
  if (s.finished) return s.finished;
  if (s.error) return s.error;
  const again = checkAgainLine(scheduler);
  const withAgain = (line) => (again ? `${line} · ${again}` : line);
  if (!last) return withAgain('Not checked yet');
  // The STORED run, so a failure survives a reload: the in-memory error above
  // dies with the tab, and "Last checked 2h ago" over a failed run is a lie.
  if (last.ok === false) return withAgain('The last check failed — details on Now');
  const summary = sweepSummary(last);
  // A light run reads far less than a full one; say so, in plain words.
  const quick = last.kind === 'light' ? ' · quick look' : '';
  return withAgain(`Last checked ${humanDelta(last.ended_at || last.started_at)}${quick}${summary ? ` · ${summary}` : ''}`);
}

/** The hover title: duration and spend, the two numbers that left the line. */
export function sweepLineTitle(last, tokens, todayKeyStr) {
  return [sweepDetail(last), tokenLine(tokens, todayKeyStr)].filter(Boolean).join(' · ');
}

function paintSweepLine(parts) {
  const s = state.sweep;
  const last = state.board.runs?.last;
  const text = sweepLineText(s, last, state.health?.scheduler);

  const pct = s.running && s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : null;

  // Bad styling for a live error AND for a stored failure: the second is what
  // a reload leaves behind, and it must not repaint as an ordinary line.
  const bad = Boolean(s.error) || (!s.running && !s.finished && last?.ok === false);
  parts.node.className = `sweepline${s.running ? ' is-running' : ''}${bad ? ' is-bad' : ''}`;
  parts.textNode.setAttribute('aria-busy', s.running ? 'true' : 'false');
  announce(parts.textNode, text);
  // The title is set on the node the pointer rests on, outside the live
  // region's text: a tooltip is a fact to glance at, not an announcement.
  const title = sweepLineTitle(last, state.board.tokens, nowMark().key);
  if (title) parts.node.setAttribute('title', title);
  else parts.node.removeAttribute('title');
  parts.barNode.className = `sweepbar${pct === null && s.running ? ' is-indeterminate' : ''}`;
  parts.fillNode.style.width = s.running ? `${pct ?? 100}%` : '0%';
  // The finished note lasts exactly one paint: it has been shown (and queued
  // for the live region above), so the next repaint — the minute tick, a
  // click, any store emit — settles back to "Last checked…".
  if (!s.running && s.finished) state.sweep = { ...s, finished: null };
}

/** Quick capture. It is a reminder to yourself; the next check reads it. */
function capturePanel() {
  const box = el('textarea', {
    class: 'capture-field',
    rows: '2',
    'aria-label': 'A reminder for yourself',
    placeholder: 'Remind me to chase the survey invoice…',
  });
  const status = el('span', { class: 'status', role: 'status' });
  const panel = el('form', { class: 'capture', hidden: true }, [
    box,
    el('div', { class: 'row-inline' }, [
      el('button', { type: 'submit', class: 'btn solid', text: 'Save' }),
      status,
    ]),
  ]);
  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    status.textContent = 'Saving…';
    try {
      await api.capture(text);
      box.value = '';
      status.textContent = 'Saved. Zelos reads it the next time it checks.';
    } catch (err) {
      status.textContent = err.message;
    }
  });

  // "Add a reminder", because "Note" did not say what the box was for.
  const toggle = button('Add a reminder', {
    class: 'btn quiet',
    'aria-expanded': 'false',
    onClick: (e) => {
      const btn = e.currentTarget;
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
      if (!open) focusQuietly(box);
    },
  });

  return { toggle, panel, box };
}

/**
 * The chrome, built ONCE and updated in place ever after.
 *
 * The old shape — rebuild the whole topbar on every store emit — destroyed the
 * capture panel each time a sweep ticked or the minute clock fired, taking a
 * half-typed note (and the "Kept." status, and keyboard focus) with it. So the
 * nodes that hold or frame user input are created here exactly once and kept;
 * everything around them (date, sweep line, rail counts, tab bar, toast) is
 * either a plain text update or an input-free node that is swapped wholesale.
 */
let chrome = null;

function buildChrome() {
  const capture = capturePanel();
  const dateNode = el('p', { class: 'topbar-date mono' });
  const sweepBtn = button('Check now', {
    class: 'btn solid',
    onClick: () => startSweep('auto'),
  });
  const sweep = buildSweepLine();
  const commandsButton = button('Commands', {
    class: 'btn quiet', 'aria-haspopup': 'dialog',
    'aria-keyshortcuts': 'Control+Shift+P Meta+Shift+P',
    title: 'Commands (⌘/Ctrl+Shift+P)',
    onClick: () => commands.open(),
  });
  const commands = createCommandMenu({
    fallbackFocus: () => commandsButton,
    onError: err => notify(`Could not run that command: ${err.message}`, { tone: 'warn' }),
    getCommands: () => [
      ...VIEWS.map((view, index) => ({
        id: `view-${view.id}`, label: `Go to ${view.label}`,
        keywords: view.id === 'owed' ? 'drafts replies waiting' : 'navigate',
        shortcut: window.zelos?.desktop ? (view.id === 'search' ? '⌘/Ctrl+F' : `⌘/Ctrl+${index + 1}`) : null,
        run: () => navigate(`#/${view.id}`),
      })),
      { id: 'capture', label: 'Add a reminder', keywords: 'capture note', run: () => {
        capture.panel.hidden = false;
        capture.toggle.setAttribute('aria-expanded', 'true');
        focusQuietly(capture.box);
      } },
      { id: 'check', label: 'Check now', keywords: 'refresh read connections',
        disabled: state.sweep.running, reason: 'A check is already running', run: () => startSweep('auto') },
    ],
  });
  const topbarNode = el('header', { class: 'topbar' }, [
    el('div', { class: 'topbar-row' }, [
      el('a', { class: 'wordmark', href: '#/now' }, [
        el('span', { class: 'wordmark-name', text: 'Zelos' }),
        // The tooltip answers "is that a logo glitch?" — it is the name, in Greek.
        el('span', { class: 'wordmark-greek', 'aria-hidden': 'true', title: 'Zelos, in Greek', text: 'ΖΗΛΟΣ' }),
      ]),
      dateNode,
      el('div', { class: 'topbar-actions' }, [commandsButton, capture.toggle, sweepBtn]),
    ]),
    capture.panel,
    sweep.node,
    // The one banner, shared with setup's skeleton.
    sharedBanner(),
  ]);
  return {
    topbarNode,
    dateNode,
    sweepBtn,
    sweep,
    capture,
    commands,
    railNode: rail(route.view),
    tabbarNode: tabbar(route.view),
  };
}

function railLink(view, counts, current) {
  const count = view.countKey ? counts[view.countKey] || 0 : 0;
  return el('a', {
    class: `nav-link${view.id === current ? ' is-current' : ''}`,
    href: `#/${view.id}`,
    'aria-current': view.id === current ? 'page' : null,
  }, [
    el('span', { class: 'nav-label', text: view.label }),
    view.countKey ? el('span', { class: `nav-count mono${count ? ' has-some' : ''}`, text: String(count) }) : null,
    el('span', { class: 'nav-marker', 'aria-hidden': 'true' }),
  ]);
}

function rail(current) {
  const counts = railCounts();
  return el('nav', { class: 'rail', 'aria-label': 'Sections' }, [
    el('div', { class: 'nav' }, VIEWS.map((v) => railLink(v, counts, current))),
    meander({ class: 'rail-rule' }),
    el('div', { class: 'rail-buckets' }, [
      el('h2', { class: 'rail-heading', text: 'The board' }),
      el('ul', { class: 'bucket-list' }, Object.keys(BUCKET_LABEL).map((bucket) => el('li', {},
        el('a', { class: `bucket-line${counts[bucket] ? '' : ' is-zero'}`, href: BUCKET_ROUTE[bucket] }, [
          el('span', { class: 'bucket-name', text: BUCKET_LABEL[bucket] }),
          el('span', { class: 'bucket-count mono', text: String(counts[bucket] || 0) }),
        ])))),
    ]),
    // `label` has a default ("Claude"), so it is not evidence of anything —
    // only `configured` is. Naming a model the app cannot call would be a lie
    // told in the calmest possible typeface.
    el('p', { class: 'rail-foot mono', text: state.health?.model?.configured
      ? `${state.health.model.label}${state.health.model.local ? ' · on this computer' : ''}`
      : 'no AI chosen yet' }),
  ]);
}

function tabbar(current) {
  const counts = railCounts();
  return el('nav', { class: 'tabbar', 'aria-label': 'Sections' }, VIEWS.map((v) => {
    const count = v.countKey ? counts[v.countKey] || 0 : 0;
    return el('a', {
      class: `tab${v.id === current ? ' is-current' : ''}`,
      href: `#/${v.id}`,
      'aria-current': v.id === current ? 'page' : null,
    }, [
      el('span', { class: 'tab-label', text: v.label }),
      // Always present, even when empty: an absent count row makes that tab's
      // label sit a line lower than its neighbours'.
      el('span', { class: 'tab-count mono', text: v.countKey && count ? String(count) : ' ' }),
      el('span', { class: 'tab-marker', 'aria-hidden': 'true' }),
    ]);
  }));
}

/**
 * The toast, as {node, text}. Its message node is left EMPTY here and filled by
 * announce() once the toast is in the document — a live-region element that
 * arrives with its text already written is read by nobody, which meant every
 * failed save and every Undo offer in this app was silent.
 */
function toastBar() {
  if (!state.toast) return null;
  const action = state.toast.action;
  const text = el('p');
  // A failure interrupts; anything else waits for a pause in speech.
  const role = state.toast.tone === 'warn' ? 'alert' : 'status';
  const node = el('div', { class: `toast toast-${state.toast.tone}`, role }, [
    text,
    action ? button(action.label, {
      class: 'link',
      onClick: () => {
        // Clear first: the action usually re-renders, and a toast describing an
        // undone thing must not outlive the undo it offered. Only a success
        // carries an action today, so nothing waits behind it to come forward
        // here; a failure that one day offers "Retry" would need to drop the
        // waiting toast instead.
        const run = action.run;
        dismissToast();
        run();
      },
    }) : null,
    button('Dismiss', { class: 'link', onClick: () => dismissToast() }),
  ]);
  return { node, text };
}

/* ------------------------------------------------------------- whole screens */

/* The three whole-page screens are <main>, not a div: they are the page, and
   with no landmark at all their content sat outside every region axe and a
   screen reader's landmark list know about (QA, 2026-10-10, TT-3512). */
function bootScreen() {
  return el('main', { class: 'screen' }, [
    el('p', { class: 'screen-mark', text: 'ΖΗΛΟΣ' }),
    meander(),
    el('p', { class: 'screen-line', text: 'Opening the board…' }),
  ]);
}

function fatalScreen() {
  const f = state.fatal;
  return el('main', { class: 'screen' }, [
    el('p', { class: 'screen-mark', text: 'ΖΗΛΟΣ' }),
    meander(),
    el('h1', { class: 'screen-title', text: f.title }),
    el('p', { class: 'screen-line', text: f.detail }),
    el('div', { class: 'row-inline' }, [
      button('Try again', { class: 'btn solid', onClick: () => refresh() }),
    ]),
  ]);
}

function noTokenScreen() {
  // Plain words: this is a state a non-expert genuinely reaches — a
  // bookmarked board after a restart, mostly — and the way back differs by
  // shell. The desktop app has a menu and no terminal (window.zelos is the
  // mark its preload leaves); a browser tab has the address the terminal
  // printed, which is what carries the key a bookmark strips.
  return el('main', { class: 'screen' }, [
    el('p', { class: 'screen-mark', text: 'ΖΗΛΟΣ' }),
    meander(),
    el('h1', { class: 'screen-title', text: 'This page has no session key' }),
    el('p', { class: 'screen-line', text: window.zelos
      ? 'Zelos gives each window a one-time key when it starts, and this page opened without one — so it is refused, which is the point: the key keeps anything else on this computer away from your board. Choose Board → Reload board and the app opens it again with a fresh key.'
      : 'Zelos gives each window a one-time key when it starts, and this page opened without one — so it is refused, which is the point: the key keeps other pages in your browser away from your board. Open the address printed in the terminal that started Zelos; a bookmark of this page does not carry the key.' }),
  ]);
}

/* ------------------------------------------------------------------- render */

function renderKey() {
  return [
    route.view,
    route.sub || '',
    route.connectionId || '',
    state.phase,
    state.rev,
    state.fatal ? '1' : '0',
    showOnboarding() ? 'ob' : '-',
    // Deliberately not the toast: it has its own slot, painted on every
    // event, so putting it here would rebuild the view — and a draft someone
    // is typing — every time a save failed.
  ].join('|');
}

function currentView() {
  const ctx = {
    tz: timezone(),
    navigate,
    sub: route.sub,
    connectionId: route.connectionId,
    rerender: () => render({ force: true }),
  };
  if (showOnboarding()) return renderOnboarding(ctx);
  const view = VIEWS.find((v) => v.id === route.view) || VIEWS[0];
  const node = view.render(ctx);
  /* Every view gets a level-one heading: its name, for a screen reader's
     heading list, where the rail's "The board" h2 (hidden on a phone) was the
     only outline there was (QA, 2026-10-10, TT-3530). Settings draws its own,
     visible; the others get one that is read but not shown. It goes BESIDE
     the view in <main>, never into the view's own root: Search and Ask hand
     back the same root on every render, so a heading put inside it piled up
     one per redraw, and Today's and Promises' wide layouts key on their
     first child. */
  return view.id === 'settings' ? node : [el('h1', { class: 'visually-hidden', text: view.label }), node];
}

let main = null;
let chromeWrap = null;
/** 'chrome' | 'bare' | null — which skeleton is currently in the root. */
let layout = null;
/** The toast object last painted into its slot. Reference identity is the
 *  change signal, because notify() always mints a fresh object. */
let paintedToast = null;

/**
 * The toast's one home, in both skeletons. It used to live inside the chrome,
 * so first-run setup — which has no chrome — dropped every toast raised
 * during it: "The made-up data is gone" reached neither the page nor a screen
 * reader. Built once and moved between skeletons, never rebuilt. It sits just
 * before <main>, so an Undo is reached before the view, as it always was.
 * The slot is display:contents, so it is not a grid item and the shell's named
 * areas are undisturbed; showing and clearing a toast never moves a sibling.
 */
const toastSlot = el('div', { class: 'toast-slot' });

/** Leaving every skeleton: the next one must build and announce the toast
 *  afresh, not re-insert a node whose text was already read. */
function emptyToastSlot() {
  replace(toastSlot, null);
  paintedToast = null;
}

/**
 * "Zelos 1.9.5 is ready to install", in whichever skeleton is up: the board's
 * topbar, or setup's own bar. One node for the page's life, because each
 * updateBanner() starts a poller that never stops.
 */
let banner = null;
let bannerShown = false;
function sharedBanner() {
  if (!banner) {
    banner = updateBanner({
      onError: (message) => notify(message, { tone: 'warn' }),
      onChange: (shown) => { bannerShown = shown; paintSetupBar(); },
    });
  }
  return banner;
}

/**
 * Setup's stand-in for Settings → About. The desktop menu's "Check for
 * updates" sends the window to #/settings/about, which setup used to swallow:
 * the check ran, and nothing on screen said so. Setup keeps the window, so the
 * Updates panel opens here instead, beside the step, not over it.
 */
const updatesSlot = el('div', { class: 'setup-updates' });
/** Setup's bar, while setup's skeleton is up. */
let setupBar = null;
/** Where focus was when the panel opened, for Close to put it back. */
let updatesReturnFocus = null;

function isUpdatesRoute(r) {
  return r.view === 'settings' && r.sub === 'about';
}

/**
 * Put the address back to the step's, with replaceState: an assignment would
 * fire hashchange, re-render the step and wipe whatever was half typed, and
 * leave a second menu click with no change to report. A previous address that
 * was itself About (a reload there) has only the board's to fall back on.
 */
function restoreSetupHash() {
  const back = isUpdatesRoute(route) ? '#/now' : routeHash;
  window.history.replaceState(null, '', back);
  routeHash = back;
  route = parseHash();
}

/** An empty labelled landmark is still announced, so the bar hides while empty. */
function paintSetupBar() {
  if (setupBar) setupBar.hidden = !bannerShown && !updatesSlot.firstChild;
}

function openSetupUpdates() {
  // Already open: keep it, and whatever focus is inside it. It is still polling.
  if (updatesSlot.firstChild) {
    updatesSlot.scrollIntoView?.({ block: 'nearest' });
    return;
  }
  // Focus stays where the person is — the status line inside the panel is a
  // live region, and moving focus out of <main> would flush a queued render
  // over a half-typed step. Close takes them back to where they were.
  updatesReturnFocus = document.activeElement;
  // A fresh panel on each opening: a closed one stopped polling.
  replace(updatesSlot, [
    updatesPanel(),
    el('div', { class: 'row-inline' }, button('Close', { class: 'btn quiet', onClick: closeSetupUpdates })),
  ]);
  paintSetupBar();
  updatesSlot.scrollIntoView?.({ block: 'nearest' });
}

function closeSetupUpdates() {
  replace(updatesSlot, null);
  paintSetupBar();
  const back = updatesReturnFocus;
  updatesReturnFocus = null;
  // The step may have been rebuilt while the panel was open, taking the node
  // that had focus with it.
  focusQuietly(back && back !== document.body && root.contains(back) ? back : main);
}

/**
 * A board refresh that lands while the cursor is inside a form field would
 * rebuild the view under the user's hands: the Owed draft they are typing, a
 * settings field half-filled, every open disclosure snapped shut. So a render
 * caused by data (a background sweep finishing, mostly) is QUEUED while a text
 * field inside <main> has focus — or while focus sits anywhere inside an open
 * editor, because Tab rests it on "Save account" between two fields — and runs
 * when focus settles outside both. A forced
 * render — the user's own navigation — is never deferred: they asked for it.
 */
let renderQueued = false;

/** Whether the outcomes Settings keeps were said on the setup screens or on the board. */
let outcomesOnboarding = null;

function editingInMain() {
  // The rule itself lives in ui/lib/editing.js so the test suite can name the
  // selector it checks. A button inside an open editor still counts: Tabbing
  // from a text field to "Save account" lands focus on the button, and
  // flushing in that moment rebuilds the view — the open form and everything
  // typed into it gone before the button can be pressed, the result of "Test
  // the connection" written into detached nodes. The same is true of Save on
  // You, AI, Schedule and Privacy, which sit in plain panels rather than
  // editors: a check finishing while a name was half-typed queued a redraw,
  // Tab to Save flushed it, and the panel came back from the stored settings
  // with the typing gone, so Enter saved nothing (QA, 2026-10-10, TT-3465).
  // Those panels now carry `data-editing-region`. Focus anywhere else in the
  // view — an item row's tick, a button on Your data — still flushes, because
  // those hold no half-finished typing to protect.
  return isEditing(document.activeElement, main);
}

/**
 * When the queued render is allowed to run. Two things must both be over: the
 * editing (no text field in <main> holds focus) and the CLICK THAT ENDED IT.
 * A click on a button blurs the field at pointerdown, and flushing right then
 * would replace that button before pointerup — the click the user is mid-way
 * through would land on nothing. So while the pointer is down the flush waits,
 * and the pointerup handler re-schedules it for after the click has dispatched.
 */
let pointerHeld = false;

function flushQueuedRender() {
  if (renderQueued && !pointerHeld && !editingInMain()) {
    renderQueued = false;
    render({ force: true });
  }
}

document.addEventListener('pointerdown', () => { pointerHeld = true; });
document.addEventListener('pointerup', () => {
  pointerHeld = false;
  // setTimeout from inside pointerup runs after the click event dispatches,
  // so the button the user pressed is still the button they release on.
  if (renderQueued) setTimeout(flushQueuedRender, 0);
});
document.addEventListener('pointercancel', () => {
  pointerHeld = false;
  if (renderQueued) setTimeout(flushQueuedRender, 0);
});

document.addEventListener('focusout', () => {
  if (!renderQueued) return;
  // Focus may be mid-flight to the next field of the same form; let it land
  // before deciding, or tabbing between draft fields would flush the render.
  setTimeout(flushQueuedRender, 0);
});

function render({ force = false } = {}) {
  const key = renderKey();
  if (!force && key === lastRenderKey && main) {
    paintChrome();
    paintToast();
    return;
  }
  // Both skeletons: the bare one is onboarding, whose email step holds a
  // half-typed address exactly as a settings form does.
  if (!force && (layout === 'chrome' || layout === 'bare') && state.phase === 'ready' && editingInMain()) {
    renderQueued = true;
    paintChrome();
    paintToast();
    return;
  }
  renderQueued = false;
  lastRenderKey = key;

  if (!hasToken()) {
    replace(root, noTokenScreen());
    main = null;
    chromeWrap = null;
    layout = null;
    emptyToastSlot();
    return;
  }
  if (state.phase === 'boot') {
    replace(root, bootScreen());
    main = null;
    chromeWrap = null;
    layout = null;
    emptyToastSlot();
    return;
  }
  if (state.phase === 'down' && state.fatal) {
    replace(root, fatalScreen());
    main = null;
    chromeWrap = null;
    layout = null;
    emptyToastSlot();
    return;
  }

  const onboarding = showOnboarding();
  // Setup starting or finishing is a move to another screen, as a change of
  // route is: what a Settings panel last said about a save is not carried
  // into it (TT-3448; onRoute() has the reason).
  if (onboarding !== outcomesOnboarding) {
    outcomesOnboarding = onboarding;
    forgetOutcomes();
  }
  if (onboarding) {
    setupActive = true;
    // The flow gets the whole window: no rail, no tab bar, nothing to click past.
    // Like the chrome skeleton, this one survives re-renders: rebuilding it
    // would re-parent the toast slot each time, detaching an Undo mid-press.
    if (layout !== 'bare') {
      main = el('main', { class: 'main', id: 'main', tabindex: '-1' });
      chromeWrap = null;
      layout = 'bare';
      replace(updatesSlot, null);
      updatesReturnFocus = null;
      // After <main>, so the step's heading comes first; a labelled landmark,
      // so the banner and the panel are inside a region like everything else.
      setupBar = el('aside', { class: 'setup-bar', 'aria-label': 'Zelos updates' }, [sharedBanner(), updatesSlot]);
      paintSetupBar();
      replace(root, el('div', { class: 'shell shell-bare' }, [toastSlot, main, setupBar]));
      // A menu click that landed while the board was still loading, or a
      // reload at About: setup shows either way, so the address says so too,
      // and the panel the click asked for opens beside the step.
      if (isUpdatesRoute(route)) {
        restoreSetupHash();
        openSetupUpdates();
      }
    }
    replace(main, currentView());
    paintToast();
    return;
  }
  setupActive = false;

  // The skeleton survives re-renders. Rebuilding it would re-parent the topbar
  // — and re-parenting a focused textarea blurs it, which is the note-wipe bug
  // in a different coat. Only the view's own content is replaced.
  if (layout !== 'chrome') {
    main = el('main', { class: 'main', id: 'main', tabindex: '-1' });
    chromeWrap = el('div', { class: 'chrome' });
    layout = 'chrome';
    replace(root, el('div', { class: 'shell' }, [
      el('a', {
        class: 'skip-link', href: '#main', text: 'Skip to content',
        onclick(e) {
          e.preventDefault();
          main.focus();
        },
      }),
      chromeWrap,
      toastSlot,
      main,
    ]));
    // Arriving at the board from a different skeleton — onboarding, mostly —
    // is a navigation in everything but the hash, and it inherits whatever
    // scroll depth the last screen was read at. onRoute() cannot see this
    // transition (the view name is 'now' on both sides), so the top-of-page
    // rule is applied here, where the skeleton itself changes hands.
    window.scrollTo(0, 0);
  }
  replace(main, currentView());
  paintChrome();
  paintToast();
  const connectionKey = route.view === 'settings' && route.connectionId ? `${route.sub}/${route.connectionId}` : null;
  if (connectionKey && connectionKey !== focusedConnection) focusConnectionTarget();
  focusedConnection = connectionKey;
}

/**
 * Chrome repaints on every store event — but only around the capture panel,
 * never through it. The panel and its toggle are the same nodes for the life of
 * the page; the date, the sweep button and the whole sweep line are text and
 * attribute updates on nodes that also persist (the sweep line has to persist —
 * its text is a live region, and a region that is replaced rather than mutated
 * announces nothing); the rail and tab bar hold no input, so they are
 * rebuilt and swapped in place with replaceWith, which cannot touch anything a
 * person is typing into.
 */
function paintChrome() {
  if (!chromeWrap) return;
  if (!chrome) chrome = buildChrome();
  if (chrome.topbarNode.parentNode !== chromeWrap) {
    replace(chromeWrap, [chrome.topbarNode, chrome.railNode, chrome.tabbarNode]);
    // Setup borrows the banner; take it back, still last in the topbar.
    if (sharedBanner().parentNode !== chrome.topbarNode) chrome.topbarNode.appendChild(sharedBanner());
  }

  // The date comes from the ROLLED key, not from the board's `now` string: a
  // window open past midnight has a stale string and a correct key, and the
  // header must say the day the reader is living in.
  const nm = nowMark();
  chrome.dateNode.textContent = nm.key ? formatDay(nm.key) : '';
  chrome.sweepBtn.textContent = state.sweep.running ? 'Checking…' : 'Check now';
  chrome.sweepBtn.disabled = state.sweep.running;
  if (chrome.commands.isOpen) chrome.commands.refresh();

  paintSweepLine(chrome.sweep);

  const freshRail = rail(route.view);
  chrome.railNode.replaceWith(freshRail);
  chrome.railNode = freshRail;

  const freshTabs = tabbar(route.view);
  chrome.tabbarNode.replaceWith(freshTabs);
  chrome.tabbarNode = freshTabs;

  measureTopbar();
}

/**
 * The toast, in whichever skeleton is up. It is rebuilt only when the toast
 * itself changed: this runs on every emit — sweep progress arrives several
 * times a second — and rebuilding an action toast that often would replace its
 * Undo button under a hovering cursor, mid-press.
 */
function paintToast() {
  if (!layout) return;
  if (paintedToast !== state.toast) {
    paintedToast = state.toast;
    const built = toastBar();
    replace(toastSlot, built && built.node);
    if (built) announce(built.text, state.toast.message);
  }
}

/**
 * Shared document shortcuts: the command menu and capture Escape use one
 * listener, so Escape never closes both surfaces at once.
 */
document.addEventListener('keydown', (e) => {
  if (commandShortcut(e) && chrome?.topbarNode.isConnected) {
    e.preventDefault();
    chrome.commands.open();
    return;
  }
  if (chrome?.commands.isOpen) return;
  if (e.key !== 'Escape') return;
  if (!chrome || chrome.capture.panel.hidden || !chrome.capture.panel.isConnected) return;
  chrome.capture.panel.hidden = true;
  chrome.capture.toggle.setAttribute('aria-expanded', 'false');
  focusQuietly(chrome.capture.toggle);
});

/**
 * The rail sticks below the header, and the header's height is not a constant:
 * a wrapped sweep error makes it two lines taller, and narrowing the window
 * re-wraps the header row.
 *
 * Measuring only after a paint is not enough — nothing repaints on a resize, so
 * the rail would keep a stale offset and either slide under the header or hang
 * a gap below it until the next store event. An observer on the bar itself
 * catches every cause of a height change: reflow, resize, and a font landing.
 */
const topbarWatcher = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
    const height = entries[entries.length - 1]?.target.getBoundingClientRect().height;
    if (height) document.documentElement.style.setProperty('--topbar-h', `${Math.round(height)}px`);
  })
  : null;

function measureTopbar() {
  const bar = chromeWrap?.querySelector('.topbar');
  if (!bar) return;
  document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  // The topbar node persists now, but re-observing is cheap and keeps this
  // correct if the shell was ever rebuilt around it.
  topbarWatcher?.disconnect();
  topbarWatcher?.observe(bar);
}

/**
 * Where focus lands after a sub-route move.
 *
 * A view change starts at the top of the content — that is what <main
 * tabindex="-1"> is for. A SUB-route change is a different animal: the control
 * that caused it lives inside the view, and `replace(main, currentView())` has
 * just detached it, so focus falls to <body>. Every Settings panel did that on
 * every switch: `aria-selected` was written onto a freshly built button
 * nobody was focused on, so the change was announced to no one, and the next
 * Tab restarted from whatever fallback the browser happened to keep.
 *
 * The rebuilt TAB is where focus goes back to, and that is now a choice rather
 * than the only option: settings.js finished the tablist, so the panel it
 * builds carries `role="tabpanel"`, `aria-labelledby` and `tabindex="-1"`, and
 * the selected tab carries `aria-controls` (ui/views/settings.js:1172-1199).
 * Either node can be focused. The tab is still right for two reasons:
 *
 *  - It is what the ARIA tabs pattern says, and it is what the reader is owed.
 *    Landing on the button reads "Privacy, tab, selected" — the selection that
 *    just happened. Landing on the panel reads its label and says nothing about
 *    which of the nine tabs is now on.
 *  - The strip uses a roving tabindex — the selected tab is `tabindex="0"` and
 *    the other eight are `-1` — so the strip is a single Tab stop. Focus on the
 *    tab leaves the rest of the panel ahead of the reader; focus on the panel
 *    would put the whole strip behind them, reachable only by Shift+Tab.
 *
 * The selector is `[role="tab"][aria-selected="true"]`, so those roles are
 * load-bearing in both files; settings.js says so on its side too.
 *
 * Two sub-routes are deliberately left where they are, both by the same `if`:
 * one with no tablist behind it (`#/calendar/2026-08-11`), where yanking focus
 * on a date change would be this bug pointed the other way, and a Settings hash
 * naming a panel that does not exist (`#/settings/bogus`), where no tab is
 * selected and there is nothing truthful to move to.
 */
function refocusSelectedTab() {
  const selected = main?.querySelector('[role="tab"][aria-selected="true"]');
  if (selected) focusQuietly(selected);
  return Boolean(selected);
}

let focusedConnection = null;
function focusConnectionTarget() {
  if (route.view !== 'settings' || !route.connectionId) return false;
  const target = main?.querySelector('[data-connection-target]');
  if (!target) return false;
  focusQuietly(target);
  target.scrollIntoView({ block: 'center' });
  return true;
}

function onRoute() {
  const next = parseHash();
  // Judged against the NEW route: About is turned away only while setup is up
  // and would stay up. Once setup is done it is an ordinary address.
  if (layout === 'bare' && isUpdatesRoute(next) && showOnboarding(next)) {
    restoreSetupHash();
    openSetupUpdates();
    return;
  }
  const before = route.view;
  const beforeSub = route.sub;
  route = next;
  routeHash = window.location.hash || '#/now';
  // A Settings panel keeps what it last said about a save across the redraw
  // the save causes (ui/views/settings.js, statusLine). That is for the
  // person still looking at it: one who went to another view or tab and came
  // back finds the panel as it is, not "Saved." from a visit ago (TT-3448).
  if (before !== route.view || beforeSub !== route.sub) forgetOutcomes();
  render({ force: true });
  if (before !== route.view) {
    // A new view starts at its top. Same-view re-renders (a deferred board
    // refresh, a settings save) deliberately do NOT pass through here, so they
    // never yank the scroll position out from under the reader.
    window.scrollTo(0, 0);
    if (main) focusQuietly(main);
  } else if (beforeSub !== route.sub) {
    refocusSelectedTab();
  }
  if (route.connectionId) focusConnectionTarget();
}

/* --------------------------------------------------------------------- boot */

applyAccent(currentAccent());
route = parseHash();
routeHash = window.location.hash || '#/now';
render();

window.addEventListener('hashchange', onRoute);
subscribe(() => {
  applyAccent(currentAccent());
  render();
});

// Keep "3h ago", the header date and the calendar's now-line honest without a
// data refetch. paintChrome is safe on a timer now: it updates text around the
// capture panel instead of rebuilding the topbar, so a half-typed note never
// notices the minute passing.
setInterval(() => {
  paintChrome();
  tickNowLine();
}, 60_000);

refresh().then(() => {
  watchSweeps();
  // ...and a slow heartbeat under it, so a window left open overnight wakes up
  // on the right day instead of holding yesterday's board until someone
  // reloads. It refetches through the store, so it defers around a half-typed
  // draft exactly as a finished sweep does.
  watchBoard();
});
