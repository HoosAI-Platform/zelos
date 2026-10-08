import { el, button, replace, focusQuietly } from './dom.js';
import { request } from './api.js';

/** A user-initiated check; merely opening Settings makes no GitHub request. */
export function updatesPanel() {
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
        const official = `https://github.com/HoosAI-Platform/zelos/releases/tag/v${release.latestVersion}`;
        if (!/^\d+\.\d+\.\d+$/.test(release.latestVersion) || release.releaseUrl !== official) throw new Error('The release link could not be verified.');
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
    el('p', { class: 'quiet-note', text: 'Checks GitHub only when you press the button. Your email, calendar and AI keys are not included.' }),
    el('div', { class: 'row-inline' }, check), status, result,
  ]);
}
