import { el, button, replace } from './dom.js';

/** How often the board asks the shell whether an update is waiting. Local IPC only. */
const POLL_MS = 30_000;
const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * "Zelos 1.9.2 is ready to install", across the top of the board, once an
 * update has been downloaded and verified. Three ways out, and the banner
 * goes in every one of them:
 *
 *   - Restart to update: the same restart as Settings → About.
 *   - Remind me later: back the next time Zelos is opened, not before.
 *   - Skip this version: not again for this version; a newer one still shows.
 *
 * Whether to show it is the shell's decision (`state.banner`), so a reload of
 * the board does not bring back a banner that was put off, and choosing Skip
 * is remembered across launches. Outside the desktop app there is no updater,
 * and this returns a slot that stays empty.
 */
export function updateBanner({ onError = () => {} } = {}) {
  const slot = el('div', { class: 'update-banner-slot' });
  const bridge = typeof window !== 'undefined' ? window.zelos?.updates : null;
  if (!bridge || typeof bridge.state !== 'function' || typeof bridge.snooze !== 'function') return slot;

  let shown = '';
  let busy = false;
  let poll = null;

  const show = (version) => {
    if (version === shown) return;
    shown = version;
    if (!version) {
      replace(slot, []);
      return;
    }
    const choose = (fn) => async () => {
      if (busy) return;
      busy = true;
      show(''); // gone whichever way out is chosen
      try {
        const answer = await fn();
        if (answer && answer.ok === false && answer.error) onError(answer.error);
      } catch {
        onError('Zelos could not reach its updater. Please try again from Settings → About.');
      } finally {
        busy = false;
      }
    };
    replace(slot, [el('div', { class: 'banner update-banner', role: 'region', 'aria-label': 'Update ready' }, [
      el('p', { class: 'banner-title', role: 'status', text: `Zelos ${version} is ready to install.` }),
      el('p', { class: 'banner-detail', text: 'Restarting saves your drafts first. You can also install it later from Settings → About.' }),
      el('div', { class: 'banner-actions row-inline' }, [
        button('Restart to update', {
          class: 'btn solid',
          // Put off first: if the restart does not go ahead (drafts would not
          // save, a backup is running), the banner waits for the next launch
          // rather than coming straight back.
          onClick: choose(async () => { await bridge.snooze(); return bridge.restart(); }),
        }),
        button('Remind me later', { class: 'btn quiet', onClick: choose(() => bridge.snooze()) }),
        button('Skip this version', { class: 'btn quiet', onClick: choose(() => bridge.skip()) }),
      ]),
    ])]);
  };

  async function refresh() {
    try {
      const answer = await bridge.state();
      const version = answer?.ok && typeof answer.state?.banner === 'string' && VERSION.test(answer.state.banner) ? answer.state.banner : '';
      if (!busy) show(version);
    } catch { /* the next poll tries again */ }
    clearTimeout(poll);
    poll = setTimeout(refresh, POLL_MS);
    poll?.unref?.(); // only under Node, in the tests; a browser timer is a number
  }

  refresh();
  return slot;
}
