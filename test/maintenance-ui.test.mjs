import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';
import { backupPanel } from '../ui/lib/backup.js';

test('native backup controls select no renderer paths, prevent overlap and recover from cancellation/failure', async t => {
  const document = installDom(t);
  assert.equal(backupPanel(), null, 'browser UI cannot request filesystem access');
  let finish; const calls = [];
  window.zelos = { desktop: true,
    createBackup: (...args) => { calls.push(['create', args]); return new Promise(resolve => { finish = resolve; }); },
    restoreBackup: async (...args) => { calls.push(['restore', args]); return { ok: false, error: 'Close the connected AI client first.' }; },
  };
  const panel = backupPanel();
  document.body.appendChild(panel);
  assert.equal(calls.length, 0);
  const create = findButton(panel, 'Create backup'); const restore = findButton(panel, 'Restore a backup…');
  create.click(); restore.click(); create.click();
  assert.deepEqual(calls, [['create', []]]);
  assert.equal(create.disabled, true); assert.equal(restore.disabled, true);
  finish({ ok: false, cancelled: true }); await settle();
  assert.match(text(panel), /Cancelled\. Your data is unchanged/);
  assert.equal(create.disabled, false); assert.equal(restore.disabled, false);
  assert.equal(document.activeElement, create, 'native cancellation returns keyboard focus');
  restore.click(); await settle();
  assert.deepEqual(calls.at(-1), ['restore', []]);
  assert.match(text(panel), /Close the connected AI client first/);
  create.click(); finish({ ok: true }); await settle();
  assert.match(text(panel), /Backup saved/);
  assert.match(text(panel), /not password protected/);
});

test('manual update UI does not fetch on render, renders notes as text and retries after failure', async t => {
  const document = installDom(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  const calls = []; let complete;
  globalThis.fetch = (...args) => { calls.push(args); return new Promise(resolve => { complete = resolve; }); };
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel(); const check = findButton(panel, 'Check for updates');
  document.body.appendChild(panel); check.focus();
  assert.equal(calls.length, 0);
  check.click(); check.click(); assert.equal(calls.length, 1);
  document.body.focus(); // Chromium drops focus when the focused button is disabled.
  assert.equal(calls[0][0], '/api/updates/check');
  assert.equal(calls[0][1].method, 'POST'); assert.equal(calls[0][1].body, '{}');
  complete(new Response(JSON.stringify({ error: 'GitHub is temporarily unavailable.' }), { status: 502 })); await settle();
  assert.match(text(panel), /Could not check for updates/);
  assert.doesNotMatch(text(panel), /latest release:/);
  assert.equal(check.disabled, false);
  assert.equal(document.activeElement, check, 'the failed check leaves a keyboard-reachable retry');
  check.click();
  complete(new Response(JSON.stringify({ currentVersion: '1.7.1', latestVersion: '1.8.0', updateAvailable: true,
    releaseUrl: 'https://github.com/HoosAI-Platform/zelos/releases/tag/v1.8.0', notes: '<img src=x onerror=alert(1)>' })));
  await settle();
  assert.match(text(panel), /1\.8\.0 is available/);
  assert.equal(panel.querySelector('img'), null);
  assert.equal(panel.querySelector('pre').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(panel.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(check.disabled, false);
});

test('the update UI rejects an unexpected download destination', async t => {
  installDom(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ currentVersion: '1.7.1', latestVersion: '1.8.0', updateAvailable: true, releaseUrl: 'https://untrusted.example/installer' }));
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel(); findButton(panel, 'Check for updates').click(); await settle();
  assert.equal(panel.querySelector('a'), null);
  assert.match(text(panel), /release link could not be verified/);
});

test('demo update checks explain their limit without claiming an installed version is current', async t => {
  installDom(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ demo: true }));
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel(); const check = findButton(panel, 'Check for updates');
  check.click(); await settle();
  assert.match(text(panel), /website demo cannot check an installed copy/);
  assert.doesNotMatch(text(panel), /latest release:/);
  assert.equal(panel.querySelector('a'), null);
  assert.equal(check.disabled, false);
});

/** The desktop shell's updater, as the preload exposes it, answering from a script. */
function fakeUpdaterBridge(initial) {
  const calls = [];
  let state = { supported: true, reason: '', auto: true, status: 'idle', currentVersion: '1.8.1', latestVersion: '', releaseUrl: '', notes: '', progress: null, error: '', ...initial };
  const answer = (patch = {}) => { state = { ...state, ...patch }; return Promise.resolve({ ok: true, state }); };
  return {
    calls,
    set: (patch) => { state = { ...state, ...patch }; },
    bridge: {
      state: (...args) => { calls.push(['state', args]); return answer(); },
      check: (...args) => { calls.push(['check', args]); return answer({ status: 'checking' }); },
      download: (...args) => { calls.push(['download', args]); return answer({ status: 'downloading', progress: 0 }); },
      setAuto: (...args) => { calls.push(['setAuto', args]); return answer({ auto: args[0] }); },
      restart: (...args) => { calls.push(['restart', args]); return Promise.resolve({ ok: false, error: 'Zelos stayed open so your draft edits are not lost.' }); },
    },
  };
}

test('the desktop update panel reads local state on render and never fetches', async t => {
  const document = installDom(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  const fetched = [];
  globalThis.fetch = (...args) => { fetched.push(args); return new Promise(() => {}); };
  const fake = fakeUpdaterBridge();
  window.zelos = { desktop: true, updates: fake.bridge };
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel();
  document.body.appendChild(panel);
  await settle();
  assert.deepEqual(fake.calls, [['state', []]]);
  assert.equal(fetched.length, 0);
  assert.match(text(panel), /Install updates automatically/);
  assert.match(text(panel), /looks for updates when it opens and every few hours/);
  assert.equal(panel.querySelector('input').checked, true);

  panel.querySelector('input').checked = false;
  panel.querySelector('input').fire('change');
  await settle();
  assert.deepEqual(fake.calls.at(-1), ['setAuto', [false]]);
  assert.match(text(panel), /Automatic updates are off/);

  findButton(panel, 'Check for updates').click();
  await settle();
  assert.deepEqual(fake.calls.at(-1), ['check', []]);
  assert.match(text(panel), /Checking the official Zelos releases/);
  assert.equal(findButton(panel, 'Check for updates').disabled, true, 'no second check while one runs');
  fake.set({ status: 'error', error: 'GitHub is limiting update checks.' });
  findButton(panel, 'Check for updates').focus();
  await new Promise((resolve) => setTimeout(resolve, 1_600)); // one poll
  assert.match(text(panel), /Could not update\. GitHub is limiting update checks\./);
  assert.equal(findButton(panel, 'Check for updates').disabled, false);
  assert.equal(fetched.length, 0, 'the shell does the checking, not the page');
});

test('the desktop update panel offers the restart once an update is verified, and reports a refusal', async t => {
  const document = installDom(t);
  const official = 'https://github.com/HoosAI-Platform/zelos/releases/tag/v1.9.0';
  const fake = fakeUpdaterBridge({ status: 'ready', latestVersion: '1.9.0', releaseUrl: official, notes: '<img src=x onerror=alert(1)>' });
  window.zelos = { desktop: true, updates: fake.bridge };
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel();
  document.body.appendChild(panel);
  await settle();
  assert.match(text(panel), /Zelos 1\.9\.0 is ready to install/);
  assert.equal(findButton(panel, 'Check for updates'), undefined, 'a ready update is restarted into, not re-checked');
  assert.equal(panel.querySelector('a').getAttribute('href'), official);
  assert.equal(panel.querySelector('img'), null);
  assert.equal(panel.querySelector('pre').textContent, '<img src=x onerror=alert(1)>');
  findButton(panel, 'Restart to update').click();
  await settle();
  assert.deepEqual(fake.calls.at(-1), ['restart', []]);
  assert.match(text(panel), /draft edits are not lost/);
});

test('the desktop update panel shows no link for an unverified release address', async t => {
  const document = installDom(t);
  const fake = fakeUpdaterBridge({ status: 'available', latestVersion: '1.9.0', releaseUrl: 'https://untrusted.example/release' });
  window.zelos = { desktop: true, updates: fake.bridge };
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel();
  document.body.appendChild(panel);
  await settle();
  assert.equal(panel.querySelector('a'), null);
  findButton(panel, 'Download update').click();
  await settle();
  assert.deepEqual(fake.calls.at(-1), ['download', []]);
  assert.match(text(panel), /Downloading Zelos 1\.9\.0… 0%/);
});

test('a desktop build without the update key keeps the manual check and says why it cannot update itself', async t => {
  const document = installDom(t);
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  const fetched = [];
  globalThis.fetch = (...args) => { fetched.push(args); return new Promise(() => {}); };
  const fake = fakeUpdaterBridge({ supported: false, reason: 'This build has no Zelos update key, so it cannot install updates by itself.' });
  window.zelos = { desktop: true, updates: fake.bridge };
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel();
  document.body.appendChild(panel);
  await settle();
  assert.match(text(panel), /no Zelos update key/);
  assert.equal(panel.querySelector('input'), null, 'no switch for something this build cannot do');
  assert.equal(fetched.length, 0);
  findButton(panel, 'Check for updates').click();
  assert.equal(fetched[0][0], '/api/updates/check', 'the manual check is the one the browser uses');
});

test('the desktop update panel keeps saying when the last update did not install', async t => {
  const document = installDom(t);
  const fake = fakeUpdaterBridge({ installProblem: 'Zelos 1.9.0 was not installed, so you are still on 1.8.1.' });
  window.zelos = { desktop: true, updates: fake.bridge };
  const { updatesPanel } = await import('../ui/lib/updates.js');
  const panel = updatesPanel();
  document.body.appendChild(panel);
  await settle();
  assert.match(text(panel), /1\.9\.0 was not installed/);
  fake.set({ status: 'current' });
  findButton(panel, 'Check for updates').click();
  await settle();
  assert.match(text(panel), /1\.9\.0 was not installed/, 'a later check does not hide it');
});
