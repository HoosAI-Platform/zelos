import { el, button, replace, focusQuietly } from './dom.js';
import { request } from './api.js';

const OFFICIAL_RELEASE = (version) => `https://github.com/HoosAI-Platform/zelos/releases/tag/v${version}`;
const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Settings → Updates. Inside the desktop app, whose shell can update itself,
 * this is the automatic updater's panel; everywhere else — a browser tab on
 * `zelos`, the website demo, or a desktop build that is not signed — it is the
 * manual check, which contacts GitHub only when its button is pressed.
 */
export function updatesPanel() {
  const bridge = typeof window !== 'undefined' ? window.zelos?.updates : null;
  if (bridge && typeof bridge.state === 'function') return desktopUpdatesPanel(bridge);
  return manualUpdatesPanel();
}

/** A user-initiated check; merely opening Settings makes no GitHub request. */
function manualUpdatesPanel({ reason = '' } = {}) {
  const result = el('div', { class: 'stack' });
  const status = el('p', { class: 'quiet-note', role: 'status', 'aria-live': 'polite' });
  const check = button('Check for updates', {
    class: 'btn quiet',
    onClick: async () => {
      if (check.disabled) return;
      const hadFocus = document.activeElement === check;
      check.disabled = true;
      status.textContent = 'Checking the official Zelos releases…';
      replace(result, []);
      try {
        const release = await request('/api/updates/check', { method: 'POST', body: {} });
        if (release?.demo === true) {
          status.textContent = 'This website demo cannot check an installed copy of Zelos. Visit the download page for released installers.';
          return;
        }
        status.textContent = release.updateAvailable
          ? `Zelos ${release.latestVersion} is available. You have ${release.currentVersion}.`
          : release.ahead ? `You have ${release.currentVersion}, newer than the latest public release (${release.latestVersion}).`
            : `You have the latest release: Zelos ${release.currentVersion}.`;
        const official = OFFICIAL_RELEASE(release.latestVersion);
        if (!VERSION.test(release.latestVersion) || release.releaseUrl !== official) throw new Error('The release link could not be verified.');
        const notes = typeof release.notes === 'string' ? release.notes : '';
        replace(result, [
          el('a', { class: 'btn quiet', href: official, target: '_blank', rel: 'noopener noreferrer', text: 'Release notes and downloads ↗' }),
          release.updateAvailable ? el('p', { class: 'quiet-note', text: 'Back up your data, then quit Zelos before replacing the app. Your existing data folder stays in place.' }) : null,
          notes ? el('details', {}, [el('summary', { text: 'What is in this release' }), el('pre', { class: 'code', style: { 'white-space': 'pre-wrap' }, text: notes })]) : null,
        ]);
      } catch (err) {
        status.textContent = `Could not check for updates. ${err.message}`;
      } finally {
        check.disabled = false;
        if (hadFocus && check.isConnected && [document.body, check].includes(document.activeElement)) focusQuietly(check);
      }
    },
  });
  return el('div', { class: 'stack update-panel' }, [
    el('h3', { text: 'Updates' }),
    reason ? el('p', { class: 'quiet-note', text: reason }) : null,
    el('p', { class: 'quiet-note', text: 'Checks GitHub only when you press the button. Your email, calendar and AI keys are not included.' }),
    el('div', { class: 'row-inline' }, check), status, result,
  ]);
}

/** How often the open panel asks the shell for the updater's state. Local IPC only. */
const POLL_MS = 1_500;

function describeState(state) {
  const latest = VERSION.test(state.latestVersion || '') ? state.latestVersion : '';
  switch (state.status) {
    case 'checking': return 'Checking the official Zelos releases…';
    case 'current': return `You have the latest release: Zelos ${state.currentVersion}.`;
    case 'available': return `Zelos ${latest} is available. You have ${state.currentVersion}.`;
    case 'downloading': return Number.isFinite(state.progress)
      ? `Downloading Zelos ${latest}… ${Math.round(state.progress * 100)}%`
      : `Downloading Zelos ${latest}…`;
    case 'ready': return `Zelos ${latest} is ready to install. Restart Zelos to finish updating; your drafts are saved first.`;
    case 'installing': return 'Restarting to install the update…';
    case 'error': return `Could not update. ${state.error || 'Please try again later.'}`;
    default: return state.auto
      ? `You have Zelos ${state.currentVersion}. Zelos checks for updates periodically.`
      : `You have Zelos ${state.currentVersion}. Automatic updates are off.`;
  }
}

/**
 * The desktop updater's controls. Rendering asks the shell for its state over
 * local IPC and makes no network request; only Check for updates, the shell's
 * own schedule, or a download the person chose reach GitHub.
 */
function desktopUpdatesPanel(bridge) {
  const id = `update-auto-${Math.random().toString(36).slice(2, 8)}`;
  const box = el('input', { class: 'checkbox', type: 'checkbox', id, dataset: { control: 'auto' } });
  // One status node for the panel's life: a live region that is replaced on
  // every change is one screen readers stop announcing.
  const status = el('p', { class: 'quiet-note', role: 'status', 'aria-live': 'polite', tabindex: '-1', text: 'Reading the update status…' });
  // An update the last restart did not land, said for the rest of the session.
  const problemNote = el('p', { class: 'quiet-note', hidden: true });
  const controls = el('div', { class: 'stack' });
  // The release link and notes live apart from the buttons, so a status change
  // during a check or download never snaps shut notes someone is reading.
  const release = el('div', { class: 'stack' });
  let shownRelease = '';
  const field = el('div', { class: 'field field-check', hidden: true }, [
    el('div', { class: 'check-row' }, [box, el('label', { class: 'check-label', for: id, text: 'Install updates automatically' })]),
    el('p', { class: 'field-hint', text: 'Zelos periodically checks for updates and gets them ready in the background. Nothing is installed until you choose Restart to update. Your email, calendar and AI keys are never shared.' }),
  ]);
  const panel = el('div', { class: 'stack update-panel' }, [el('h3', { text: 'Updates' }), field, problemNote, status, controls, release]);
  let state = null;
  let problem = '';
  let shown = '';
  let poll = null;
  let acting = false;
  let failures = 0;

  // Polling continues while the panel is on the page and stops for good once
  // Settings is left; it is local IPC, never a network request. A failed read
  // is retried, more slowly each time.
  const schedulePoll = () => {
    clearTimeout(poll);
    poll = setTimeout(() => {
      poll = null;
      if (panel.isConnected) refresh();
    }, POLL_MS * Math.min(2 ** failures, 16));
    poll?.unref?.(); // only under Node, in the tests; a browser timer is a number
  };

  const apply = (answer) => {
    if (answer?.ok && answer.state && typeof answer.state === 'object') {
      state = answer.state;
      problem = '';
      failures = 0;
    } else {
      problem = answer?.error || 'Zelos could not reach its updater. Please try again.';
      failures += 1;
    }
    render();
  };

  async function refresh() {
    apply(await bridge.state());
    if (!state || state.supported === true) schedulePoll();
  }

  box.addEventListener('change', async () => {
    const want = box.checked; // read before render() puts the stored value back
    if (acting) return;
    acting = true;
    render();
    try { apply(await bridge.setAuto(want)); } finally { acting = false; render(); }
  });

  const act = (fn) => async () => {
    if (acting) return;
    acting = true;
    render();
    try { apply(await fn()); } finally { acting = false; render(); }
  };

  function render() {
    if (state && state.supported !== true) {
      // A build that cannot update itself still gets the manual check, plus
      // the reason it cannot do more.
      clearTimeout(poll);
      poll = null;
      if (shown !== 'manual') replace(panel, [manualUpdatesPanel({ reason: state.reason || '' })]);
      shown = 'manual';
      return;
    }
    const text = problem || (state ? describeState(state) : 'Reading the update status…');
    if (status.textContent !== text) status.textContent = text;
    if (!state) return;
    field.hidden = false;
    const installProblem = typeof state.installProblem === 'string' ? state.installProblem : '';
    if (problemNote.textContent !== installProblem) problemNote.textContent = installProblem;
    problemNote.hidden = !installProblem;
    box.checked = state.auto === true;
    box.disabled = acting;

    renderRelease();
    // The buttons are rebuilt only when something they show changed, so a
    // poll never moves keyboard focus off a control the person is on.
    const key = JSON.stringify([state.status, acting]);
    if (key === shown) return;
    shown = key;
    const focused = controls.contains(document.activeElement) ? document.activeElement.dataset?.control : null;

    const busy = acting || ['checking', 'downloading', 'installing'].includes(state.status);
    const control = (label, name, solid, disabled, fn) => {
      const node = button(label, { class: solid ? 'btn solid' : 'btn quiet', dataset: { control: name }, onClick: act(fn) });
      node.disabled = disabled;
      return node;
    };
    const buttons = [];
    if (state.status === 'ready') buttons.push(control('Restart to update', 'restart', true, acting, () => bridge.restart()));
    else if (state.status === 'available') buttons.push(control('Download update', 'download', true, busy, () => bridge.download()));
    if (!['ready', 'installing', 'downloading'].includes(state.status)) {
      buttons.push(control('Check for updates', 'check', false, busy, () => bridge.check()));
    }
    replace(controls, [el('div', { class: 'row-inline' }, buttons)]);
    if (!focused) return;
    // Back to the same control when it is still usable; otherwise to the
    // status line, which says what is happening, rather than to the page.
    const again = [...controls.querySelectorAll('button')].find((node) => node.dataset?.control === focused);
    focusQuietly(again && !again.disabled ? again : status);
  }

  function renderRelease() {
    const latest = VERSION.test(state.latestVersion || '') ? state.latestVersion : '';
    const verified = latest && state.releaseUrl === OFFICIAL_RELEASE(latest);
    const notes = verified && state.status !== 'current' && typeof state.notes === 'string' ? state.notes : '';
    const key = JSON.stringify([verified ? latest : '', notes]);
    if (key === shownRelease) return;
    shownRelease = key;
    replace(release, verified ? [
      el('a', { class: 'btn quiet', href: OFFICIAL_RELEASE(latest), target: '_blank', rel: 'noopener noreferrer', text: 'Release notes and downloads ↗' }),
      notes ? el('details', {}, [el('summary', { text: 'What is in this release' }), el('pre', { class: 'code', style: { 'white-space': 'pre-wrap' }, text: notes })]) : null,
    ] : []);
  }

  refresh();
  return panel;
}
