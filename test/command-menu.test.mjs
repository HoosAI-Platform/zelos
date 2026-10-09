import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createCommandMenu, filterCommands, commandShortcut } from '../ui/lib/commands.js';
import { el, button, focusQuietly } from '../ui/lib/dom.js';
import { installDom, text, findButton, settle } from './helpers/ui-dom.mjs';

test('command filtering matches all words across labels and keywords without running actions', () => {
  const commands = [{ id: 'a', label: 'Add a reminder', keywords: 'capture note', run() { throw Error('must not run'); } },
    { id: 'b', label: 'Go to Promises', keywords: 'drafts replies' }];
  assert.deepEqual(filterCommands(commands, ' NOTE reminder ').map(item => item.id), ['a']);
  assert.deepEqual(filterCommands(commands, 'draft').map(item => item.id), ['b']);
  assert.deepEqual(filterCommands(commands, '<img>'), []);
});

test('the command shortcut requires Cmd/Ctrl+Shift+P and ignores composition/repeats', () => {
  for (const modifier of ['metaKey', 'ctrlKey']) {
    const event = { key: 'P', [modifier]: true, shiftKey: true };
    assert.equal(commandShortcut(event), true);
    for (const extra of [{ isComposing: true }, { repeat: true }, { altKey: true }, { shiftKey: false }, { key: 'k' }]) assert.equal(commandShortcut({ ...event, ...extra }), false);
  }
});

test('menu focuses search, skips disabled actions with arrows, activates Enter once and returns focus', async t => {
  const document = installDom(t);
  const trigger = document.body.appendChild(document.createElement('button')); trigger.focus();
  const calls = [];
  const menu = createCommandMenu({ fallbackFocus: () => trigger, getCommands: () => [
    { id: 'now', label: 'Go to Now', run: () => calls.push('now') },
    { id: 'check', label: 'Check now', disabled: true, reason: 'Already checking', run: () => calls.push('check') },
    { id: 'note', label: 'Add a reminder', run: () => calls.push('note') },
  ] });
  menu.open();
  const input = menu.node.querySelector('input');
  assert.equal(menu.node.modal, true);
  assert.equal(document.activeElement, input);
  assert.equal(input.getAttribute('aria-activedescendant'), 'command-option-0');
  input.fire('keydown', { key: 'ArrowDown' });
  assert.equal(input.getAttribute('aria-activedescendant'), 'command-option-2');
  input.fire('keydown', { key: 'Enter' }); await settle();
  assert.deepEqual(calls, ['note']);
  assert.equal(menu.isOpen, false);
  assert.equal(document.activeElement, trigger);
});

test('filtering, Escape, no-result Enter and Tab stay within the menu without running commands', async t => {
  const document = installDom(t);
  const trigger = document.body.appendChild(document.createElement('button')); trigger.focus();
  let ran = 0;
  const menu = createCommandMenu({ fallbackFocus: () => trigger, getCommands: () => [{ id: 'now', label: 'Go to Now', run: () => ran++ }] });
  menu.open(); const input = menu.node.querySelector('input'); const close = findButton(menu.node, 'Close');
  input.fire('keydown', { key: 'Tab' }); assert.equal(document.activeElement, close);
  close.fire('keydown', { key: 'Tab', shiftKey: true }); assert.equal(document.activeElement, input);
  input.value = 'nothing matches'; input.fire('input');
  assert.match(text(menu.node), /No matching commands/);
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  input.fire('keydown', { key: 'Enter' }); await settle(); assert.equal(ran, 0);
  assert.equal(input.fire('keydown', { key: 'Escape' }).stopped, true);
  assert.equal(document.activeElement, trigger);
});

test('activation rechecks action availability and a removed trigger uses the fallback', async t => {
  const document = installDom(t);
  const trigger = document.body.appendChild(document.createElement('button'));
  const fallback = document.body.appendChild(document.createElement('button')); trigger.focus();
  let running = false, ran = 0;
  const menu = createCommandMenu({ fallbackFocus: () => fallback, getCommands: () => [{ id: 'check', label: 'Check now', disabled: running, run: () => ran++ }] });
  menu.open(); running = true;
  menu.node.querySelector('[role="option"]').click(); await settle();
  assert.equal(ran, 0); assert.equal(menu.isOpen, true);
  trigger.remove(); findButton(menu.node, 'Close').click(); assert.equal(document.activeElement, fallback);
});

test('the real shell menu reuses capture, navigation and explicit check actions without erasing a reminder', async t => {
  const document = installDom(t);
  const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const capture = source.match(/function capturePanel\(\) \{[\s\S]*?\n\}/)[0];
  const chrome = source.match(/function buildChrome\(\) \{[\s\S]*?\n\}/)[0];
  const calls = [];
  const state = { sweep: { running: false } };
  const context = vm.createContext({ el, button, focusQuietly, createCommandMenu, updateBanner: () => el('div'), window: globalThis.window,
    state, route: { view: 'now' }, VIEWS: [{ id: 'now', label: 'Now' }, { id: 'search', label: 'Search' }],
    api: { capture: async text => calls.push(['capture', text]) },
    navigate: hash => calls.push(['navigate', hash]), startSweep: mode => calls.push(['check', mode]), notify() {},
    buildSweepLine: () => ({ node: el('div') }), rail: () => el('nav'), tabbar: () => el('nav'),
  });
  const built = vm.runInContext(`${capture}\n${chrome}\nbuildChrome()`, context);
  document.body.appendChild(built.topbarNode);
  built.capture.box.value = 'Keep my unfinished reminder';
  const run = async query => {
    findButton(built.topbarNode, 'Commands').click();
    const field = built.commands.node.querySelector('input');
    field.value = query; field.fire('input'); field.fire('keydown', { key: 'Enter' }); await settle();
  };
  assert.deepEqual(calls, [], 'building the shell must not start work');
  await run('reminder');
  assert.equal(built.capture.panel.hidden, false);
  assert.equal(built.capture.box.value, 'Keep my unfinished reminder');
  assert.equal(document.activeElement, built.capture.box);
  await run('reminder'); assert.equal(built.capture.panel.hidden, false);
  await run('search'); await run('check');
  assert.deepEqual(calls, [['navigate', '#/search'], ['check', 'auto']]);
  state.sweep.running = true; await run('check');
  assert.equal(calls.length, 2); built.commands.close();
});

test('command failures are reported after closing and releasing modal focus', async t => {
  const document = installDom(t);
  const trigger = document.body.appendChild(document.createElement('button')); trigger.focus();
  const errors = [];
  const menu = createCommandMenu({ fallbackFocus: () => trigger, onError: err => errors.push(err.message),
    getCommands: () => [{ id: 'broken', label: 'Try an action', run: async () => { throw Error('Could not save'); } }] });
  menu.open(); menu.node.querySelector('input').fire('keydown', { key: 'Enter' }); await settle();
  assert.deepEqual(errors, ['Could not save']); assert.equal(menu.isOpen, false);
  assert.equal(document.activeElement, trigger);
});
