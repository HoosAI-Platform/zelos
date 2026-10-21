import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-item-history-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_LOG_LEVEL = 'silent';
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
const dbm = await import('../core/db.mjs');
const handles = [];
test.after(() => {
  for (const db of handles) dbm.close(db);
  fs.rmSync(home, { recursive: true, force: true });
});
const NOW = '2026-09-11T10:00:00Z';
const LATER = '2026-09-11T11:00:00Z';
const ITEM = { key: 'invoice', bucket: 'today', headline: 'Check the invoice', why: 'The supplier asked.', severity: 1, dueAt: '2026-09-12', sourceRefs: [] };
function fresh() { const db = dbm.open(':memory:'); dbm.migrate(db); handles.push(db); return db; }
function entries(db, id, opts) { return dbm.listItemHistory(db, id, opts).entries; }

test('schema 4 preserves v3 user data without inventing earlier item history', () => {
  const db = fresh();
  const { id } = dbm.upsertItem(db, ITEM, { now: NOW });
  dbm.setItemState(db, id, 'snoozed', { now: NOW, snoozedUntil: LATER });
  dbm.insertCapture(db, 'Preserve my note', { now: NOW });
  dbm.upsertDraft(db, { itemId: id, body: 'Preserve my draft' });
  dbm.setKV(db, 'user-preference', JSON.stringify({ keep: true }));
  dbm.indexDoc(db, { ref: `item:${id}`, kind: 'item', title: ITEM.headline });
  db.exec('DROP TABLE IF EXISTS item_history; PRAGMA user_version = 3');
  dbm.deleteKV(db, 'itemHistory.startedAt');
  const tables = ['items', 'drafts', 'captures', 'search', 'task_activity'];
  const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  assert.deepEqual(dbm.migrate(db), { version: 4, applied: 1 });
  assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), before);
  assert.deepEqual(JSON.parse(dbm.getKV(db, 'user-preference')), { keep: true });
  assert.deepEqual(entries(db, id), []);
  dbm.upsertItem(db, { ...ITEM, why: 'The supplier asked again.' }, { now: LATER, origin: 'source' });
  assert.equal(entries(db, id)[0].kind, 'changed');
  assert.equal(entries(db, id)[0].changes[0].before, ITEM.why);
});

test('content revisions group meaningful changes, excluding repeat sweeps and arbitrary payloads', () => {
  const db = fresh();
  const { id } = dbm.upsertItem(db, ITEM, { runId: 'run_one', now: NOW });
  assert.equal(entries(db, id)[0].kind, 'created');
  dbm.upsertItem(db, { ...ITEM, payload: { password: 'private-payload' }, link: 'https://example.com/?token=private-link' }, { runId: 'run_two', now: LATER });
  assert.equal(entries(db, id).length, 1, 'metadata-only fetches do not create changes');
  dbm.upsertItem(db, { ...ITEM, bucket: 'now', severity: 3, dueAt: '2026-09-11', why: 'Needed today.' }, { runId: 'run_three', now: LATER });
  const history = entries(db, id);
  assert.equal(history.length, 2);
  assert.equal(history[0].origin, 'model');
  assert.deepEqual(history[0].changes.map((change) => change.field).sort(), ['bucket', 'due_at', 'severity', 'why']);
  assert.ok(!JSON.stringify(history).includes('private-'));
});

test('real triage merges retain the user decision and do not repeat identical model history', async () => {
  const { mergeSweep } = await import('../core/triage.mjs');
  const db = fresh();
  const reply = { first: ITEM.key, items: [{ ...ITEM, person: '', personEmail: '', link: null }], notes: [] };
  mergeSweep(db, reply, { runId: 'run_first', now: NOW });
  const item = dbm.getItemByKey(db, ITEM.key);
  assert.ok(item);
  dbm.setItemState(db, item.id, 'done', { now: NOW });
  mergeSweep(db, reply, { runId: 'run_repeat', now: LATER });
  assert.equal(entries(db, item.id).length, 2);
  assert.equal(dbm.getItem(db, item.id).state, 'done');
  mergeSweep(db, { ...reply, items: [{ ...reply.items[0], dueAt: '2026-09-14' }] }, { runId: 'run_changed', now: LATER });
  assert.deepEqual(entries(db, item.id)[0].changes, [{ field: 'due_at', before: ITEM.dueAt, after: '2026-09-14' }]);
});

test('user status and snooze edits are distinct from automatic wakes and no-op decisions', () => {
  const db = fresh();
  const { id } = dbm.upsertItem(db, ITEM, { now: NOW });
  dbm.setItemState(db, id, 'snoozed', { now: NOW, snoozedUntil: LATER });
  dbm.setItemState(db, id, 'snoozed', { now: NOW, snoozedUntil: LATER });
  assert.equal(entries(db, id).length, 2);
  assert.equal(entries(db, id)[0].origin, 'user');
  dbm.listBoard(db, { now: LATER });
  dbm.listBoard(db, { now: LATER });
  const wake = entries(db, id)[0];
  assert.equal(entries(db, id).length, 3);
  assert.equal(wake.origin, 'automatic');
  assert.deepEqual(wake.changes.find((change) => change.field === 'state'), { field: 'state', before: 'snoozed', after: 'open' });
  dbm.setItemState(db, id, 'done', { now: LATER });
  dbm.upsertItem(db, { ...ITEM, state: 'open', headline: 'Updated invoice wording' }, { runId: 'run_next', now: LATER });
  assert.equal(dbm.getItem(db, id).state, 'done');
  assert.ok(!entries(db, id)[0].changes.some((change) => change.field === 'state'));
});

test('an item edit rolls back if history fails, including edits inside a caller transaction', () => {
  const db = fresh();
  const { id } = dbm.upsertItem(db, ITEM, { now: NOW });
  db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON item_history BEGIN SELECT RAISE(ABORT, 'controlled history failure'); END");
  assert.throws(() => dbm.upsertItem(db, { ...ITEM, headline: 'Must roll back' }, { now: LATER }), /controlled history failure/);
  assert.equal(dbm.getItem(db, id).headline, ITEM.headline);
  assert.throws(() => dbm.withTransaction(db, () => {
    dbm.setKV(db, 'must-rollback', true);
    dbm.setItemState(db, id, 'done', { now: LATER });
  }), /controlled history failure/);
  assert.equal(dbm.getKV(db, 'must-rollback'), null);
  assert.equal(dbm.getItem(db, id).state, 'open');
});

test('history stores only bounded allowlisted text and redacts recognizable credentials', () => {
  const db = fresh();
  const secret = 'sk-' + 'a'.repeat(30);
  const { id } = dbm.upsertItem(db, { ...ITEM, headline: `Key ${secret}`, why: `password=never-store-this ${'x'.repeat(10000)}`, payload: { raw: 'never-store-payload' } });
  const history = JSON.stringify(entries(db, id));
  assert.ok(!history.includes(secret));
  assert.ok(!history.includes('never-store-this'));
  assert.ok(!history.includes('never-store-payload'));
  assert.ok(history.length < 12000);
  assert.ok(entries(db, id)[0].changes.some((change) => change.truncated));
});

test('history pagination is stable when a newer change arrives and rejects unsafe bounds', () => {
  const db = fresh();
  const { id } = dbm.upsertItem(db, ITEM);
  for (let n = 0; n < 5; n++) dbm.upsertItem(db, { ...ITEM, headline: `Revision ${n}` });
  const page = dbm.listItemHistory(db, id, { limit: 2 });
  dbm.upsertItem(db, { ...ITEM, headline: 'Arrived after page one' });
  const rest = dbm.listItemHistory(db, id, { limit: 50, before: page.nextBefore });
  assert.equal(rest.entries.length, 4);
  assert.ok(rest.entries.every((entry) => entry.id < page.nextBefore));
  assert.equal(rest.nextBefore, null);
  for (const limit of [0, -1, 51, 1.5, Infinity, NaN]) assert.throws(() => dbm.listItemHistory(db, id, { limit }), /limit/);
  for (const before of [0, -1, 1.5, Infinity, 'no']) assert.throws(() => dbm.listItemHistory(db, id, { before }), /before/);
});

test('task snapshots record actual selection visibility changes, never guessed completion or partial absence', () => {
  const db = fresh();
  const row = { sourceId: 'tasks', messageId: 'todoist:one', subject: 'Task one', date: NOW };
  const message = dbm.upsertMessage(db, row);
  const { id } = dbm.upsertItem(db, { ...ITEM, sourceRefs: [`msg:${message.id}`] }, { now: NOW });
  const snapshot = { sourceId: 'tasks', prefix: 'todoist:', selection: 'inbox', now: LATER };
  dbm.reconcileTaskActivity(db, { ...snapshot, complete: true, rows: [row] });
  dbm.reconcileTaskActivity(db, { ...snapshot, complete: false, rows: [] });
  assert.equal(entries(db, id).length, 1);
  dbm.reconcileTaskActivity(db, { ...snapshot, complete: true, rows: [] });
  dbm.reconcileTaskActivity(db, { ...snapshot, complete: true, rows: [] });
  assert.equal(entries(db, id).length, 2);
  assert.equal(entries(db, id)[0].origin, 'source');
  assert.deepEqual(entries(db, id)[0].changes, [{ field: 'sourceInactive', before: false, after: true }]);
  assert.equal(dbm.getItem(db, id).state, 'open');
  dbm.reconcileTaskActivity(db, { ...snapshot, complete: false, rows: [row] });
  assert.deepEqual(entries(db, id)[0].changes, [{ field: 'sourceInactive', before: true, after: false }]);
});

test('calendar reconciliation preserves item state and history until the item itself is reassessed', () => {
  const db = fresh();
  const event = dbm.upsertEvent(db, { calendarId: 'cal', uid: 'one', startsAt: '2026-09-11T14:00:00Z', endsAt: '2026-09-11T15:00:00Z' });
  const { id } = dbm.upsertItem(db, { ...ITEM, sourceRefs: [`evt:${event.id}`] }, { now: NOW });
  dbm.reconcileEvents(db, { calendarId: 'cal', events: [], from: '2026-09-11T00:00:00Z', to: '2026-09-12T00:00:00Z', timezone: 'UTC' });
  assert.equal(entries(db, id).length, 1);
  assert.equal(dbm.getItem(db, id).state, 'open');
  dbm.upsertItem(db, { ...ITEM, headline: 'Confirm the changed appointment', sourceRefs: [] }, { now: LATER, runId: 'run_reassessed' });
  assert.equal(entries(db, id)[0].origin, 'model');
});

test('automatic board demotion records a real change once and deleting an item clears its history', async () => {
  const { capNowBucket } = await import('../core/sweep.mjs');
  const db = fresh();
  for (let n = 0; n < 5; n++) dbm.upsertItem(db, { ...ITEM, key: `item-${n}`, bucket: 'now' }, { now: NOW });
  assert.equal(capNowBucket(db, { now: LATER }), 1);
  const demoted = dbm.listBoard(db, { buckets: ['today'], now: LATER })[0];
  assert.equal(entries(db, demoted.id)[0].origin, 'automatic');
  assert.deepEqual(entries(db, demoted.id)[0].changes, [{ field: 'bucket', before: 'now', after: 'today' }]);
  assert.equal(capNowBucket(db, { now: LATER }), 0);
  assert.equal(entries(db, demoted.id).length, 2);
  db.prepare('DELETE FROM items WHERE id = ?').run(demoted.id);
  assert.deepEqual(entries(db, demoted.id), []);
});

test('selection history compares final mixed evidence and rolls back membership if recording fails', () => {
  const db = fresh();
  const rows = ['one', 'two'].map((name) => ({ sourceId: 'tasks', messageId: `todoist:${name}`, subject: name, date: NOW }));
  const refs = rows.map((row) => `msg:${dbm.upsertMessage(db, row).id}`);
  const { id } = dbm.upsertItem(db, { ...ITEM, sourceRefs: refs });
  const snapshot = { sourceId: 'tasks', prefix: 'todoist:', selection: 'inbox', complete: true, now: LATER };
  dbm.reconcileTaskActivity(db, { ...snapshot, rows: [rows[0]] });
  dbm.reconcileTaskActivity(db, { ...snapshot, rows: [rows[1]] });
  assert.equal(entries(db, id).length, 1, 'the obligation stayed active across both final selections');
  db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON item_history BEGIN SELECT RAISE(ABORT, 'controlled source history failure'); END");
  assert.throws(() => dbm.reconcileTaskActivity(db, { ...snapshot, rows: [] }), /controlled source history failure/);
  assert.equal(dbm.getItem(db, id).sourceInactive, false);
});

async function serverFor(t, options = {}) {
  const { createServer, listen } = await import('../core/server.mjs');
  const { DEFAULTS } = await import('../core/config.mjs');
  const db = fresh();
  const server = createServer({ db, config: structuredClone(DEFAULTS), ...options });
  const { port } = await listen(server, { port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const call = (route, { token = server.sessionToken, method = 'GET', body, headers = {} } = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(token ? { 'X-Zelos-Token': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { db, call };
}

test('item history HTTP route uses the session gate, strict bounds, stable pages, and missing-item status', async (t) => {
  const { db, call } = await serverFor(t);
  const { id } = dbm.upsertItem(db, ITEM);
  dbm.setItemState(db, id, 'done');
  const route = `/api/items/${id}/history`;
  assert.equal((await call(route, { token: null })).status, 401);
  assert.equal((await call(route, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await call(route, { method: 'POST', body: {} })).status, 405);
  for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=1e1', 'limit=', 'limit=2&limit=3', 'before=-1', 'before=Infinity', 'before=9007199254740992']) {
    assert.equal((await call(`${route}?${query}`)).status, 400, query);
  }
  const first = await (await call(`${route}?limit=1`)).json();
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].origin, 'user');
  assert.ok(first.recordedSince);
  const second = await (await call(`${route}?limit=1&before=${first.nextBefore}`)).json();
  assert.equal(second.entries[0].kind, 'created');
  assert.equal(second.nextBefore, null);
  assert.equal((await call('/api/items/missing/history')).status, 404);
});

test('manual update route never runs at startup or GET and refuses unauthenticated/settings payloads', async (t) => {
  let calls = 0;
  const result = { currentVersion: '1.7.1', latestVersion: '1.7.2', updateAvailable: true };
  const { call } = await serverFor(t, { releaseChecker: async () => { calls++; return result; } });
  assert.equal(calls, 0);
  assert.equal((await call('/api/updates/check')).status, 405);
  assert.equal((await call('/api/updates/check', { method: 'POST', body: {}, token: null })).status, 401);
  assert.equal((await call('/api/updates/check', { method: 'POST', body: { token: 'do-not-send' } })).status, 400);
  assert.equal(calls, 0);
  const response = await call('/api/updates/check', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(calls, 1);
});

test('manual update failure does not return upstream credentials or stack traces', async (t) => {
  const { call } = await serverFor(t, { releaseChecker: async () => { throw new Error('token=private-provider-secret'); } });
  const response = await call('/api/updates/check', { method: 'POST', body: {} });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.ok(!text.includes('private-provider-secret'));
  assert.match(text, /Try again later/);
});

class PlainNode {
  constructor(tag = '') {
    this.tag = tag; this.children = []; this.attributes = {}; this.handlers = {};
    this.dataset = {}; this.style = { setProperty() {} }; this.hidden = false;
  }
  setAttribute(name, value) { this.attributes[name] = value; if (name === 'hidden') this.hidden = true; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; this.text = ''; }
  set textContent(text) { this.replaceChildren(); this.text = String(text); }
  get textContent() { return (this.text ?? '') + this.children.map((child) => child.textContent).join(''); }
  async click() { return this.handlers.click?.call(this); }
}
function walk(node) { return [node, ...node.children.flatMap(walk)]; }
function buttonNamed(node, label) { return walk(node).find((child) => child.tag === 'button' && child.textContent === label); }
async function historyUI(t) {
  const old = { Node: globalThis.Node, document: globalThis.document, window: globalThis.window };
  globalThis.Node = PlainNode;
  globalThis.document = {
    createElement: (tag) => new PlainNode(tag),
    createTextNode: (text) => { const node = new PlainNode(); node.textContent = text; return node; },
  };
  globalThis.window = { location: { href: 'http://localhost/', host: 'localhost' } };
  t.after(() => Object.assign(globalThis, old));
  const store = await import('../ui/lib/store.js');
  store.state.config = { identity: { timezone: 'UTC' } };
  return import('../ui/lib/item-history.js');
}

test('history disclosure loads on demand, paginates on request, and renders source text without HTML', async (t) => {
  const { itemHistory } = await historyUI(t);
  const calls = [];
  const unsafe = '<img src=x onerror=alert(1)>';
  const control = itemHistory({ id: 'item-one', headline: 'Invoice' }, { fetchHistory: async (url) => {
    calls.push(url);
    return { entries: [{ id: calls.length === 1 ? 2 : 1, recorded_at: NOW, origin: calls.length === 1 ? 'source' : 'user', kind: 'changed', changes: [
      calls.length === 1 ? { field: 'headline', before: 'Old wording', after: unsafe } : { field: 'state', before: 'open', after: 'done' },
    ] }], nextBefore: calls.length === 1 ? 2 : null };
  } });
  assert.equal(calls.length, 0);
  await control.toggle.click();
  assert.equal(control.panel.hidden, false);
  assert.equal(calls.length, 1);
  assert.match(control.panel.textContent, /Old wording → <img/);
  assert.ok(!walk(control.panel).some((node) => node.tag === 'img'));
  assert.match(control.panel.textContent, /Source refresh/);
  await buttonNamed(control.panel, 'Older changes').click();
  assert.match(calls[1], /before=2$/);
  assert.match(control.panel.textContent, /Status: Open → Done/);
  assert.equal(buttonNamed(control.panel, 'Older changes'), undefined);
  await control.toggle.click();
  await control.toggle.click();
  assert.equal(calls.length, 2, 'folding a loaded timeline does not fetch it again');
});

test('history read failures keep a useful retry and empty history never fabricates prior changes', async (t) => {
  const { itemHistory } = await historyUI(t);
  let calls = 0;
  const control = itemHistory({ id: 'one' }, { fetchHistory: async () => {
    if (!calls++) throw new Error('private source error');
    return { entries: [], nextBefore: null };
  } });
  await control.toggle.click();
  assert.match(control.panel.textContent, /could not be loaded/);
  assert.ok(!control.panel.textContent.includes('private source error'));
  await buttonNamed(control.panel, 'Try again').click();
  assert.match(control.panel.textContent, /No changes recorded yet/);
  assert.match(control.panel.textContent, /Earlier changes.*not available/);
});

test('rows and hero expose history, while inactive rows keep only history controls', async (t) => {
  await historyUI(t);
  const { itemRow, itemHero } = await import('../ui/lib/items.js');
  const item = { id: 'one', headline: 'A task', state: 'open', bucket: 'today', severity: 1 };
  for (const node of [itemRow(item, { tz: 'UTC' }), itemHero(item, { tz: 'UTC' })]) {
    assert.ok(buttonNamed(node, 'What changed?'));
    assert.ok(walk(node).find((child) => child.attributes.title === 'More'));
  }
  const inactive = itemRow({ ...item, state: 'done', sourceInactive: true }, { tz: 'UTC' });
  assert.ok(buttonNamed(inactive, 'What changed?'));
  for (const label of ['Snooze', 'Wake', 'Not a thing', 'Restore', 'Reopen']) assert.equal(buttonNamed(inactive, label), undefined);
  // Still open, it is listed under Finished to be settled: dismissing is the
  // one extra control (TT-3519).
  const left = itemRow({ ...item, sourceInactive: true }, { tz: 'UTC' });
  assert.ok(buttonNamed(left, 'What changed?'));
  assert.ok(buttonNamed(left, 'Not a thing'));
  for (const label of ['Snooze', 'Wake', 'Restore', 'Reopen']) assert.equal(buttonNamed(left, label), undefined);
});

test('history deadlines preserve the source wall clock and day-only dates like the item card', async (t) => {
  const { historyChangeText } = await historyUI(t);
  const text = historyChangeText({ field: 'due_at', before: '2026-09-12', after: '2026-09-11T14:00:00-04:00' });
  assert.match(text, /2026-09-12 → 2026-09-11 · 2 PM/);
});
