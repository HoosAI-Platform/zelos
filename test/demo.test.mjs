import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe } from '../core/connectors/index.mjs';
import { installDom, text, findButton, walk, settle } from './helpers/ui-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function adapter(t, prepare = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-demo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = JSON.parse(fs.readFileSync(path.join(root, 'website/demo-data.json'), 'utf8'));
  prepare(data);
  // Use the release views with only the same adapter overlay as the website.
  fs.cpSync(path.join(root, 'ui'), dir, { recursive: true });
  fs.copyFileSync(path.join(root, 'website/demo/lib/api.js'), path.join(dir, 'lib/api.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'lib/demo-data.js'), `export default ${JSON.stringify(data)};`);
  fs.writeFileSync(path.join(dir, 'lib/connectors.js'), `export default ${JSON.stringify(describe())};`);
  const realTimer = setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, _ms, ...args) => realTimer(fn, 0, ...args));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('The demo must never contact a server'); });
  const importUi = file => import(pathToFileURL(path.join(dir, file)).href);
  return { ...await importUi('lib/api.js'), data, importUi };
}

test('demo board matches the hydrated release UI and exposes known sample connection health', async t => {
  const { api, data } = await adapter(t);
  const oldWindow = globalThis.window;
  globalThis.window = { location: { href: 'http://127.0.0.1/' } };
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  const real = await import('../ui/lib/api.js');
  assert.deepEqual(Object.keys(api).sort(), Object.keys(real.api).sort(), 'every release UI API method needs a demo equivalent');
  const { PRESETS } = await import('../core/llm.mjs');
  assert.deepEqual(await api.presets(), PRESETS.filter(preset => !preset.local), 'guided setup needs the same provider key-page links and defaults');
  const board = await api.state();
  assert.ok(board.items.every(item => Array.isArray(item.sourceRefs) && typeof item.sourceInactive === 'boolean'));
  assert.ok(board.events.every(event => Array.isArray(event.attendees)));
  assert.deepEqual(board.finished, []);
  assert.equal(board.sourceStatus.length, data.config.mail.length + data.config.calendars.length + data.config.sources.length);
  assert.ok(board.sourceStatus.every(row => row.ok === true && row.lastSuccessAt && row.configKey));
  await api.saveConfig({ sources: [...data.config.sources, { id: 'new-source', type: 'todoist', label: 'New sample connection', enabled: true }] });
  const fresh = (await api.state()).sourceStatus.find(row => row.id === 'new-source');
  assert.equal(fresh.ok, null);
  assert.equal(fresh.lastSuccessAt, null);
});

test('demo done, restore and timed snooze preserve the actual item action contract', async t => {
  const { api } = await adapter(t);
  const id = (await api.state()).items[0].id;
  await api.setItemState(id, 'done');
  assert.ok((await api.state()).finished.some(item => item.id === id));
  await api.setItemState(id, 'open');
  assert.ok((await api.state()).items.some(item => item.id === id));
  const until = new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000).toISOString();
  await api.setItemState(id, 'snoozed', { until });
  const snoozed = (await api.state()).items.find(item => item.id === id);
  assert.equal(Date.parse(snoozed.snoozed_until), Date.parse(until));
  const later = Date.parse(until) + 1;
  t.mock.method(Date, 'now', () => later);
  const awake = (await api.state()).items.find(item => item.id === id);
  assert.equal(awake.state, 'open');
  assert.equal(awake.snoozed_until, null);
  await assert.rejects(api.setItemState(id, 'snoozed', { until: 'bad date' }), { status: 400 });
});

test('demo search supplies excerpts and keeps inactive task history opt-in', async t => {
  const { api, data } = await adapter(t, data => {
    data.items[0].sourceInactive = true;
    data.items[0].headline = 'HistoricalTaskExample';
    data.items[0].why = 'Retained history, absent from the current selection.';
  });
  assert.equal((await api.state()).items.some(item => item.id === data.items[0].id), false);
  assert.deepEqual((await api.search('HistoricalTaskExample')).results, []);
  const hit = (await api.search('HistoricalTaskExample', { includeHistory: true })).results[0];
  assert.equal(hit.sourceInactive, true);
  assert.equal(hit.excerpt, data.items[0].why);
  assert.equal(hit.ref, `item:${data.items[0].id}`);
  const draft = (await api.state()).drafts[0];
  await api.updateDraft(draft.id, { body: 'Revised demo reply', state: 'edited' });
  assert.equal((await api.state()).drafts.find(row => row.id === draft.id).body, 'Revised demo reply');
  // Even an object that refuses to be read is accepted: only the ref is kept.
  await api.setSecret('demo-no-value', { toString() { throw new Error('secret was read'); } });
  assert.ok((await api.config()).secretRefs.includes('demo-no-value'));
});

test('demo history starts empty, records actual actions and pages without duplicates as new changes arrive', async t => {
  const { api, request } = await adapter(t);
  const [item, other] = (await api.state()).items;
  const history = query => request(`/api/items/${item.id}/history${query || ''}`);
  const first = await history();
  assert.deepEqual(first.entries, [], 'sample items must not acquire invented older history');
  assert.equal(first.nextBefore, null);
  assert.ok(Number.isFinite(Date.parse(first.recordedSince)));
  await api.setItemState(item.id, 'done');
  await api.setItemState(item.id, 'done');
  const done = await history();
  assert.equal(done.entries.length, 1, 'unchanged state and board reads are not changes');
  assert.equal(done.entries[0].origin, 'user');
  assert.equal(done.entries[0].kind, 'changed');
  assert.deepEqual(done.entries[0].changes, [{ field: 'state', before: 'open', after: 'done' }]);
  await api.setItemState(item.id, 'open');
  await api.setItemState(item.id, 'dismissed');
  const page = await history('?limit=2');
  assert.equal(page.entries.length, 2);
  assert.equal(page.nextBefore, page.entries.at(-1).id);
  await api.setItemState(item.id, 'open');
  const older = await history(`?limit=2&before=${page.nextBefore}`);
  assert.deepEqual(older.entries.map(row => row.id), [done.entries[0].id]);
  assert.equal(older.nextBefore, null);
  page.entries[0].changes[0].after = 'tampered';
  assert.equal((await history()).entries.some(row => row.changes.some(change => change.after === 'tampered')), false);
  assert.deepEqual((await request(`/api/items/${other.id}/history`)).entries, [], 'history belongs to one item');
  for (const query of ['?limit=0', '?limit=51', '?limit=1.5', '?limit=2&limit=2', '?before=0', '?before=no']) {
    await assert.rejects(history(query), { status: 400 });
  }
  await assert.rejects(request('/api/items/missing/history'), { status: 404 });
});

test('demo timed wake-ups and simulated arrivals produce truthful new history', async t => {
  const { api, request, openStream, data } = await adapter(t);
  const id = (await api.state()).items[0].id;
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await api.setItemState(id, 'snoozed', { until });
  t.mock.method(Date, 'now', () => Date.parse(until) + 1);
  await api.state(); await api.state();
  const history = await request(`/api/items/${id}/history`);
  assert.equal(history.entries.length, 2);
  assert.equal(history.entries[0].origin, 'automatic');
  assert.deepEqual(history.entries[0].changes.find(change => change.field === 'state'), { field: 'state', before: 'snoozed', after: 'open' });
  const controller = new AbortController();
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const stream = openStream('/api/sweep/stream', { signal: controller.signal, onEvent: (event, result) => {
    if (event === 'done' || event === 'failed') finish({ event, result });
  } });
  await api.sweep('auto');
  assert.equal((await finished).event, 'done');
  controller.abort(); await stream;
  const arrival = data.sweepArrivals[0].item;
  const added = await request(`/api/items/${arrival.id}/history`);
  assert.equal(added.entries.length, 1);
  assert.equal(added.entries[0].origin, 'sample');
  assert.equal(added.entries[0].kind, 'created');
  assert.ok(added.entries[0].changes.some(change => change.field === 'headline' && change.before === null && change.after === arrival.headline));
});

test('release history and update views work against the demo without contacting a server or offering native backups', async t => {
  installDom(t);
  const { api, request, importUi } = await adapter(t);
  const { state } = await importUi('lib/store.js');
  state.board = await api.state(); state.config = (await api.config()).config; state.health = await api.health();
  const { itemHistory } = await importUi('lib/item-history.js');
  const item = state.board.items[0]; await api.setItemState(item.id, 'done');
  const history = itemHistory(item);
  await history.toggle.listeners.get('click')[0].call(history.toggle);
  assert.match(text(history.panel), /You.*Changed/);
  assert.match(text(history.panel), /Status: Open → Done/);
  const info = await request('/api/updates/check', { method: 'POST', body: {} });
  assert.equal(info.demo, true); assert.match(info.message, /demo/);
  assert.equal(info.updateAvailable, undefined); assert.equal(info.latestVersion, undefined);
  const { updatesPanel } = await importUi('lib/updates.js');
  const updates = updatesPanel();
  await findButton(updates, 'Check for updates').listeners.get('click')[0]();
  assert.match(text(updates), /demo cannot check an installed copy/i);
  assert.doesNotMatch(text(updates), /You have the latest|undefined|Could not check/);
  const { backupPanel, canUseBackups } = await importUi('lib/backup.js');
  assert.equal(canUseBackups(), false); assert.equal(backupPanel(), null);
});

test('demo setup status and exact-account recovery reflect configuration without inventing a successful read', async t => {
  installDom(t);
  const { api, importUi, data } = await adapter(t);
  const id = 'new/mail % #';
  await api.saveConfig({ mail: [...data.config.mail, { id, label: 'New demo mailbox', user: 'new@example.invalid', enabled: true }] });
  const { state } = await importUi('lib/store.js');
  state.config = (await api.config()).config; state.health = await api.health(); state.board = await api.state();
  const { setupStatus, parseConnectionTarget } = await importUi('lib/source-status.js');
  const paths = [];
  const setup = setupStatus(route => paths.push(route));
  assert.match(text(setup), /New demo mailbox: configured; no successful read recorded/);
  assert.match(text(setup), /AI chosen.*test it/);
  walk(setup).find(node => node.getAttribute('aria-label') === 'Review New demo mailbox').click();
  assert.deepEqual(paths, [`#/settings/mail/${encodeURIComponent(id)}`]);
  const { mailPanel } = await importUi('views/settings.js');
  const panel = mailPanel({ connectionId: parseConnectionTarget(paths[0].split('/')[3]) });
  const target = panel.querySelector('[data-connection-target]');
  assert.match(text(target), /New demo mailbox/);
  assert.ok(findButton(target, 'Check all connections'));
  findButton(target, 'Edit').click(); await settle();
  assert.ok(walk(panel).some(node => node.tag === 'input' && node.value === 'new@example.invalid'));
  assert.equal((await api.state()).runs.last.id, state.board.runs.last.id, 'opening recovery and Edit must not start a check');
  await api.saveConfig({ model: { baseUrl: 'https://model.example.invalid/v1', model: 'sample-model' } });
  state.health = await api.health();
  assert.equal(state.health.model.local, false); assert.equal(state.health.model.configured, false);
  assert.match(text(setupStatus(() => {})), /Choose an AI/);
  await api.setModelKey('https://model.example.invalid/v1', 'unused demo field');
  assert.equal((await api.health()).model.configured, true, 'a saved field is configuration, never a verified result');
  await api.saveConfig({ model: { model: '' } });
  assert.equal((await api.health()).model.configured, false);
});
