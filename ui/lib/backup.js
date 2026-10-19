import { el, button, focusQuietly } from './dom.js';

export function canUseBackups() {
  return typeof window !== 'undefined' && window.zelos?.desktop === true
    && typeof window.zelos.createBackup === 'function' && typeof window.zelos.restoreBackup === 'function';
}

/** File selection and restore confirmation belong to the trusted native window. */
export function backupPanel() {
  if (!canUseBackups()) return null;
  const status = el('p', { class: 'quiet-note', role: 'status', 'aria-live': 'polite' });
  let busy = false;
  const save = button('Create backup', { class: 'btn solid', onClick: () => run('createBackup') });
  const restore = button('Restore a backup…', { class: 'btn quiet', onClick: () => run('restoreBackup') });
  async function run(action) {
    if (busy) return;
    busy = true;
    save.disabled = restore.disabled = true;
    status.textContent = action === 'createBackup'
      ? 'Choose a private place for your backup. Zelos will pause checks while it saves.'
      : 'Choose a backup to review. Nothing is replaced until you confirm in the next window.';
    try {
      const result = await window.zelos[action]();
      if (result?.cancelled) status.textContent = 'Cancelled. Your data is unchanged.';
      else if (!result?.ok) status.textContent = result?.error || 'The backup operation could not finish. Try again.';
      else status.textContent = action === 'createBackup'
        ? 'Backup saved. Keep it private: it contains your archive and may include account credentials.'
        : 'Backup restored. Zelos will restart with the restored data.';
    } catch {
      status.textContent = 'The backup operation could not finish. Try again.';
    } finally {
      busy = false;
      save.disabled = restore.disabled = false;
      const trigger = action === 'createBackup' ? save : restore;
      if (trigger.isConnected) focusQuietly(trigger);
    }
  }
  return el('div', { class: 'stack backup-panel' }, [
    el('h2', { class: 'panel-heading', text: 'Back up and restore' }),
    el('p', { class: 'quiet-note', text: 'Save your archive, captures, drafts, item history, settings and portable credentials in one backup file. Treat this file like your private data folder; it is not password protected.' }),
    el('div', { class: 'row-inline' }, [save, restore]),
    el('p', { class: 'quiet-note', text: 'Restore checks the file before you confirm, saves a recovery copy of your current data, then restarts Zelos. Close other Zelos sessions and connected AI clients first. Passwords held by your computer’s password storage may need reconnecting on another computer.' }),
    status,
  ]);
}
