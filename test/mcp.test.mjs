/**
 * test/mcp.test.mjs — the promises the MCP surface makes.
 *
 * Three of these are the product rather than a feature, and they are written to
 * fail loudly rather than to pass easily:
 *
 *  - A scope that is off must hide its tools from `tools/list` AND refuse them
 *    from `tools/call`. Both are checked, separately, because a client that
 *    hardcodes a tool name it saw once must still be stopped.
 *  - With `mail.bodies` off, no response from any tool may contain body text.
 *    That is asserted by putting a known phrase in a body and looking for it in
 *    the SERIALISED response of every tool — not by trusting that the field
 *    mapping omitted it. The same phrase is then found with the scope on, so
 *    the test cannot pass by looking at nothing.
 *  - Nothing here writes. Checked against the module's own source, not by
 *    hoping.
 *
 * No network, no real ~/.zelos: ZELOS_HOME is a temp dir and every database is
 * a file inside it.
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mcp-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SOURCE = fs.readFileSync(path.join(ROOT, 'core', 'mcp.mjs'), 'utf8');

const dbm = await import('../core/db.mjs');
/* Imported for its export list, not to run a sweep: the read-only guard below
   asks what core/mcp.mjs names from HERE as well as from db.mjs, because the one
   function that can change a row lives on this side. */
const sweepm = await import('../core/sweep.mjs');
const mcp = await import('../core/mcp.mjs');
const {
  SCOPES, SCOPE_INFO, TOOLS, AI_DEFAULTS, ERROR_CODES,
  PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS,
  aiConfig, toolsFor, handle, createStdioServer, serveStdio,
  recordAccess, listAccessLog,
} = mcp;

after(() => {
  for (const db of OPEN_DBS) { try { dbm.close(db); } catch { /* already closed */ } }
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ================================================================== *
 * Fixtures
 * ================================================================== */

/**
 * The phrase that must never escape with `mail.bodies` off. It lives deep in a
 * message body, well past the snippet, and its words are indexed — so a search
 * for it MATCHES the message even when the text may not be returned.
 */
const BODY_CANARY = 'CANARY-BODY-7f3a4c-must-never-escape';
const BODY_CANARY_2 = 'Wire the balance to account 0042-9981';
const SNIPPET = 'The retainage invoice has not cleared';
/* A word from the SUBJECT line ('Invoice 4471 is past due'), which stays
   searchable with only mail.metadata. 'retainage' would NOT do — it lives in
   the snippet and the body, which is precisely what is no longer searchable. */
const SUBJECT_WORD = 'Invoice';

let seq = 0;
const OPEN_DBS = [];

function freshDb() {
  const file = path.join(HOME_ROOT, `t${seq++}.db`);
  const db = dbm.open(file);
  dbm.migrate(db);
  OPEN_DBS.push(db);
  return db;
}

function message(over = {}) {
  return {
    sourceId: 'm_work',
    uid: 1041,
    messageId: '<invoice-4471@riverstone.example>',
    threadKey: 'thread-invoice',
    folder: 'INBOX',
    direction: 'in',
    from: { name: 'Marcus Reyes', email: 'marcus@riverstone.example' },
    to: [{ name: 'Nemo Hale', email: 'nemo@example.com' }],
    cc: [],
    subject: 'Invoice 4471 is past due',
    date: '2026-08-05T09:12:00-04:00',
    snippet: SNIPPET,
    text: `${SNIPPET}.\n\n${BODY_CANARY_2}. ${BODY_CANARY}.`,
    hasAttachments: true,
    flags: ['\\Seen'],
    ...over,
  };
}

/** A populated database plus the ids the tests need to address it. */
function seeded() {
  const db = freshDb();

  const msgId = dbm.upsertMessage(db, message()).id;
  dbm.upsertMessage(db, message({
    uid: 1042,
    messageId: '<invoice-4471-reply@example.com>',
    direction: 'out',
    from: { name: 'Nemo Hale', email: 'nemo@example.com' },
    to: [{ name: 'Marcus Reyes', email: 'marcus@riverstone.example' }],
    subject: 'Re: Invoice 4471 is past due',
    date: '2026-08-06T08:00:00-04:00',
    snippet: 'Chasing accounting today',
    text: `Chasing accounting today. ${BODY_CANARY}.`,
  }));

  dbm.upsertEvent(db, {
    calendarId: 'c_work',
    uid: 'evt-9001',
    title: 'Pre-con with Alder & Vance',
    description: `Walk the slab schedule. ${BODY_CANARY}.`,
    location: 'Site trailer',
    startsAt: '2026-08-11T14:00:00-04:00',
    endsAt: '2026-08-11T15:00:00-04:00',
    allDay: false,
    organizer: { name: 'Alder', email: 'pm@aldervance.example' },
    attendees: [{ name: 'Nemo Hale', email: 'nemo@example.com', rsvp: 'ACCEPTED' }],
    rsvp: 'ACCEPTED',
    status: 'CONFIRMED',
  });

  const itemId = dbm.upsertItem(db, {
    key: 'invoice-4471-past-due',
    kind: 'money',
    bucket: 'now',
    headline: 'Chase invoice 4471 — 21 days past due',
    why: 'Marcus asked twice and the bank is asking about the retainage.',
    person: 'Marcus Reyes',
    personEmail: 'marcus@riverstone.example',
    dueAt: '2026-08-12T17:00:00-04:00',
    severity: 3,
    sourceRefs: [`msg:${msgId}`, 'evt:missing-on-purpose'],
    // Raw model output. It never goes out, so a body quoted into it cannot leak.
    payload: { rawModelNote: `verbatim quote: ${BODY_CANARY}` },
  }, { runId: 'run_1' }).id;

  dbm.upsertDraft(db, {
    itemId,
    to: 'marcus@riverstone.example',
    subject: 'Re: Invoice 4471',
    body: 'Marcus — accounting is releasing 4471 today and I will send the remittance.',
  });

  dbm.insertCapture(db, 'Ask the bank about the retainage release date');

  return { db, msgId, itemId };
}

const ALL_ON = Object.freeze({
  board: true, calendar: true, 'mail.metadata': true, 'mail.bodies': true, drafts: true, people: true,
});
const ALL_ON_NO_BODIES = Object.freeze({ ...ALL_ON, 'mail.bodies': false });

function cfg(scopes = ALL_ON, over = {}) {
  return {
    identity: { name: 'Nemo Hale', email: 'nemo@example.com', timezone: 'America/New_York' },
    ai: { enabled: true, scopes: { ...scopes }, tokens: [], maxRows: 50, ...over },
  };
}

test('direct historical item reads label inactive task evidence without widening body access', async () => {
  const db = freshDb();
  const raw = message({ sourceId: 'tasks', uid: undefined, messageId: 'todoist:task:one', subject: 'Historical obligation' });
  const task = dbm.upsertMessage(db, raw);
  const item = dbm.upsertItem(db, { key: 'historical-task', bucket: 'today', headline: 'Historical obligation', sourceRefs: [`msg:${task.id}`] });
  dbm.reconcileTaskActivity(db, { sourceId: 'tasks', prefix: 'todoist:task:', selection: 'current', rows: [], complete: true, now: '2026-09-09T14:00:00Z' });
  const ctx = { db, config: cfg(ALL_ON_NO_BODIES) };
  const board = await call(ctx, 'zelos_board');
  assert.equal(board.result.structuredContent.items.length, 0);
  const result = await call(ctx, 'zelos_item', { id: item.id });
  const content = result.result.structuredContent;
  assert.equal(content.item.state, 'open', 'the original user state is retained');
  assert.equal(content.item.sourceInactive, true);
  assert.equal(content.sources[0].message.taskActivity, 'inactive');
  assert.equal(content.sources[0].message.taskObservedAt, '2026-09-09T14:00:00Z');
  assert.equal(content.sources[0].message.taskInactiveReason, 'not_in_current_selection');
  assert.ok(!JSON.stringify(result).includes(BODY_CANARY));
  dbm.reconcileTaskActivity(db, { sourceId: 'tasks', prefix: 'todoist:task:', selection: 'current', rows: [raw], complete: true });
  const reopened = await call(ctx, 'zelos_item', { id: item.id });
  assert.equal(reopened.result.structuredContent.item.sourceInactive, false);
  assert.equal(reopened.result.structuredContent.sources[0].message.taskActivity, 'active');
});

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

async function call(ctx, name, args = {}, id = 1) {
  return handle(rpc('tools/call', { name, arguments: args }, id), ctx);
}

/** Every tool, with arguments that actually return something for the fixture. */
function everyCall({ itemId, msgId }) {
  return [
    ['zelos_board', {}],
    ['zelos_board', { bucket: 'now', limit: 50 }],
    ['zelos_item', { id: itemId }],
    ['zelos_calendar', { from: '2026-08-01', to: '2026-09-01' }],
    ['zelos_search', { query: 'invoice' }],
    ['zelos_search', { query: 'retainage' }],
    // The canary's own words: FTS matches them inside the body, which is
    // exactly the case where a careless implementation hands the body back.
    // (The query itself is deliberately a fragment — echoing a caller's own
    // words back is not a leak, and the assertion could not tell the two apart.)
    ['zelos_search', { query: 'canary' }],
    ['zelos_search', { query: 'balance account' }],
    ['zelos_thread', { thread: 'thread-invoice' }],
    ['zelos_thread', { messageId: msgId }],
    ['zelos_drafts', {}],
    ['zelos_people', {}],
  ];
}

/* ================================================================== *
 * The closed set of scopes
 * ================================================================== */

describe('scopes', () => {
  test('SCOPES is the closed set from the spec, and SCOPE_INFO describes each one', () => {
    assert.deepEqual([...SCOPES].sort(), ['board', 'calendar', 'drafts', 'mail.bodies', 'mail.metadata', 'people']);
    assert.ok(Object.isFrozen(SCOPES));
    for (const id of SCOPES) {
      const info = SCOPE_INFO[id];
      assert.ok(info, `SCOPE_INFO is missing ${id}`);
      assert.equal(info.id, id);
      assert.ok(info.label && info.label.length > 1, `${id} needs a label`);
      assert.ok(info.summary && info.summary.length > 20, `${id} needs an honest one-liner, got ${info.summary}`);
      assert.ok(Array.isArray(info.tools));
    }
    assert.equal(SCOPE_INFO['mail.bodies'].sensitive, true, 'mail.bodies must be marked as the exposing one');
    assert.deepEqual([...SCOPE_INFO['mail.bodies'].implies], ['mail.metadata']);
  });

  test('every tool belongs to a scope in the set', () => {
    for (const tool of TOOLS) {
      assert.ok(SCOPES.includes(tool.scope), `${tool.name} claims unknown scope ${tool.scope}`);
    }
  });

  test('the shipped defaults are off, with mail closed', () => {
    assert.equal(AI_DEFAULTS.enabled, false, 'AI access must start off');
    assert.equal(AI_DEFAULTS.scopes['mail.metadata'], false);
    assert.equal(AI_DEFAULTS.scopes['mail.bodies'], false, 'mail.bodies must never default on');
    assert.equal(AI_DEFAULTS.scopes.drafts, false);
    assert.equal(AI_DEFAULTS.scopes.people, false);
  });

  test('aiConfig fills in a config that has no ai block at all', () => {
    const ai = aiConfig({ identity: {} });
    assert.equal(ai.enabled, false);
    assert.deepEqual(ai.scopes, { ...AI_DEFAULTS.scopes });
    assert.equal(ai.maxRows, 50);
    assert.deepEqual(ai.tokens, []);
    assert.deepEqual(aiConfig(null).scopes, { ...AI_DEFAULTS.scopes });
  });

  test('aiConfig only counts a literal true, and clamps maxRows', () => {
    const ai = aiConfig({ ai: { enabled: 'yes', scopes: { 'mail.bodies': 'true', board: 1, calendar: true }, maxRows: 99999 } });
    assert.equal(ai.enabled, false, 'anything but true is off');
    assert.equal(ai.scopes['mail.bodies'], false, '"true" the string must not open the most exposing scope');
    assert.equal(ai.scopes.board, false);
    assert.equal(ai.scopes.calendar, true);
    assert.equal(ai.maxRows, 500);
    assert.equal(aiConfig({ ai: { maxRows: -4 } }).maxRows, 1);
  });

  test('a config cannot invent a scope', () => {
    const ai = aiConfig({ ai: { enabled: true, scopes: { 'mail.everything': true, admin: true } } });
    assert.equal(Object.hasOwn(ai.scopes, 'mail.everything'), false);
    assert.deepEqual(toolsFor({ 'mail.everything': true, admin: true }), []);
  });
});

/* ================================================================== *
 * Enforcement point one: tools/list
 * ================================================================== */

describe('toolsFor — a disabled scope has no tools to show', () => {
  const names = (scopes) => toolsFor(scopes).map((t) => t.name).sort();

  test('the master switch alone empties the list', () => {
    assert.deepEqual(toolsFor({ enabled: false, scopes: ALL_ON }), []);
    assert.deepEqual(toolsFor(cfg(ALL_ON, { enabled: false })), []);
    assert.ok(toolsFor(cfg(ALL_ON)).length >= 7);
  });

  /**
   * `zelos_search` is the one tool more than one scope can produce, because it
   * is the one tool that reads more than one kind and filters each kind against
   * its own scope inside itself. Every other tool belongs to exactly one.
   */
  test('each scope contributes exactly its own tools', () => {
    assert.deepEqual(names({ board: true }), ['zelos_board', 'zelos_item', 'zelos_search']);
    assert.deepEqual(names({ calendar: true }), ['zelos_calendar', 'zelos_search']);
    assert.deepEqual(names({ 'mail.metadata': true }), ['zelos_search', 'zelos_thread']);
    assert.deepEqual(names({ drafts: true }), ['zelos_drafts']);
    assert.deepEqual(names({ people: true }), ['zelos_people']);
    assert.deepEqual(names({}), []);
  });

  test('turning on the calendar turns on nothing else', () => {
    assert.deepEqual(names({ calendar: true }), ['zelos_calendar', 'zelos_search']);
    // Search over the calendar is not search over the mail: the mail tools stay
    // away, and so does every other scope's tool.
    assert.equal(names({ calendar: true }).includes('zelos_thread'), false);
    assert.equal(names({ calendar: true }).includes('zelos_board'), false);
    assert.equal(names({ calendar: true }).includes('zelos_people'), false);
    assert.equal(names({ calendar: true }).includes('zelos_drafts'), false);
  });

  test('a scope with nothing searchable brings no search', () => {
    // drafts and people own no searchable kind, so search is not theirs to give.
    assert.deepEqual(names({ drafts: true, people: true }), ['zelos_drafts', 'zelos_people']);
  });

  test('mail.bodies implies mail.metadata but adds no tool of its own', () => {
    assert.deepEqual(names({ 'mail.bodies': true }), ['zelos_search', 'zelos_thread']);
    assert.deepEqual(names({ 'mail.metadata': true }), names({ 'mail.bodies': true }));
  });

  test('it accepts a list, a map, an ai block or a whole config', () => {
    const board = ['zelos_board', 'zelos_item', 'zelos_search'];
    assert.deepEqual(names(['board']), board);
    assert.deepEqual(names({ board: true }), board);
    assert.deepEqual(names({ enabled: true, scopes: { board: true } }), board);
    assert.deepEqual(names(cfg({ board: true })), board);
    assert.deepEqual(toolsFor(undefined), []);
    assert.deepEqual(toolsFor('board'), []);
  });

  test('the descriptors are MCP-shaped and cannot be mutated back into the registry', () => {
    const first = toolsFor({ board: true })[0];
    assert.equal(typeof first.description, 'string');
    assert.equal(first.inputSchema.type, 'object');
    first.name = 'zelos_send_mail';
    first.inputSchema.properties = {};
    assert.equal(toolsFor({ board: true })[0].name, 'zelos_board', 'the registry handed out a live reference');
    assert.ok(Object.keys(toolsFor({ board: true })[0].inputSchema.properties).length > 0);
  });

  test('tools/list shows only what the scopes allow', async () => {
    const { db } = seeded();
    const listed = async (scopes) => {
      const res = await handle(rpc('tools/list'), { db, config: cfg(scopes) });
      return res.result.tools.map((t) => t.name).sort();
    };
    assert.deepEqual(await listed({ board: true, calendar: true }),
      ['zelos_board', 'zelos_calendar', 'zelos_item', 'zelos_search']);
    assert.deepEqual(await listed(ALL_ON_NO_BODIES), [
      'zelos_board', 'zelos_calendar', 'zelos_drafts', 'zelos_item', 'zelos_people', 'zelos_search', 'zelos_thread',
    ]);

    const off = await handle(rpc('tools/list'), { db, config: cfg(ALL_ON, { enabled: false }) });
    assert.deepEqual(off.result.tools, [], 'the master switch off must expose nothing');
  });
});

/* ================================================================== *
 * Enforcement point two: tools/call
 * ================================================================== */

describe('tools/call — a disabled scope is refused even when the name is known', () => {
  test('every tool is refused when its own scope is off', async () => {
    const { db, itemId, msgId } = seeded();
    for (const [name, args] of everyCall({ itemId, msgId })) {
      const tool = TOOLS.find((t) => t.name === name);
      const scope = tool.scope;
      // Every scope that could produce this tool, closed. Only zelos_search has
      // more than one, and a tool more than one scope can grant is refused only
      // when all of them are off — closing one of three would prove nothing.
      const scopes = { ...ALL_ON };
      for (const id of tool.scopes) scopes[id] = false;
      // mail.bodies implies mail.metadata, so closing metadata means closing both.
      if (tool.scopes.includes('mail.metadata')) scopes['mail.bodies'] = false;
      const ctx = { db, config: cfg(scopes) };

      const listed = (await handle(rpc('tools/list'), ctx)).result.tools.map((t) => t.name);
      assert.equal(listed.includes(name), false, `${name} is still advertised with ${scope} off`);

      const res = await call(ctx, name, args);
      assert.equal(res.result, undefined, `${name} answered with ${scope} off`);
      assert.equal(res.error.code, ERROR_CODES.SCOPE_DENIED);
      assert.match(res.error.message, new RegExp(scope.replace('.', '\\.')));
    }
  });

  test('the master switch off refuses every tool by name', async () => {
    const { db, itemId, msgId } = seeded();
    const ctx = { db, config: cfg(ALL_ON, { enabled: false }) };
    for (const [name, args] of everyCall({ itemId, msgId })) {
      const res = await call(ctx, name, args);
      assert.equal(res.error.code, ERROR_CODES.AI_DISABLED, `${name} ran with AI access switched off`);
      assert.match(res.error.message, /switched off/i);
    }
  });

  test('a tool name that does not exist is a clean error, not a crash', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg() }, 'zelos_send_mail', { to: 'x@y.example' });
    assert.equal(res.error.code, ERROR_CODES.INVALID_PARAMS);
    assert.match(res.error.message, /unknown tool/);
  });

  test('refusal does not depend on tools/list having been called first', async () => {
    const { db } = seeded();
    // A fresh context that has never listed anything, calling a remembered name.
    const res = await call({ db, config: cfg({ board: true }) }, 'zelos_thread', { thread: 'thread-invoice' });
    assert.equal(res.error.code, ERROR_CODES.SCOPE_DENIED);
  });

  test('an item hands back nothing from a scope that is off', async () => {
    const { db, itemId } = seeded();
    const boardOnly = await call({ db, config: cfg({ board: true }) }, 'zelos_item', { id: itemId });
    const payload = boardOnly.result.structuredContent;
    assert.equal(payload.found, true);
    assert.deepEqual(payload.sources, [], 'the mail behind an item is mail — it needs the mail scope');
    assert.deepEqual(payload.drafts, [], 'a draft is a draft — it needs the drafts scope');

    const withMail = (await call({ db, config: cfg({ board: true, 'mail.metadata': true, drafts: true }) }, 'zelos_item', { id: itemId }))
      .result.structuredContent;
    assert.equal(withMail.sources.length, 1, 'the one resolvable source should come back');
    assert.equal(withMail.sources[0].kind, 'message');
    assert.equal(withMail.drafts.length, 1);
  });
});

/* ================================================================== *
 * mail.bodies — the one that matters
 * ================================================================== */

describe('mail.bodies', () => {
  test('with it OFF, no serialised response from any tool contains body text', async () => {
    const { db, itemId, msgId } = seeded();
    const ctx = { db, config: cfg(ALL_ON_NO_BODIES) };

    for (const [name, args] of everyCall({ itemId, msgId })) {
      const res = await call(ctx, name, args);
      assert.ok(res.result, `${name} failed: ${JSON.stringify(res.error)}`);
      const wire = JSON.stringify(res);
      assert.equal(wire.includes(BODY_CANARY), false, `${name} leaked the body canary:\n${wire}`);
      assert.equal(wire.includes(BODY_CANARY_2), false, `${name} leaked body text:\n${wire}`);
      assert.equal(wire.includes('verbatim quote'), false, `${name} leaked the raw model payload:\n${wire}`);
    }
  });

  test('the index really does hold the body — so the test above is not looking at nothing', async () => {
    /*
     * This test used to prove non-vacuity by showing that a body-only word STILL
     * matched with mail.bodies off — the body is indexed, the search finds it,
     * and only the text is withheld. That was true, and it was the bug: a hit on
     * a word that exists nowhere but a body answers "is this word in your mail?"
     * for anything the caller can guess. The scope now confines the MATCH to the
     * title column, so bodies are unsearchable, not merely unreadable.
     *
     * Non-vacuity is therefore proved the other way round, which is stronger:
     * the SAME query finds the SAME message once the scope is on. If the index
     * did not hold the body, neither half would work.
     */
    const { db, msgId } = seeded();

    const off = await call({ db, config: cfg(ALL_ON_NO_BODIES) }, 'zelos_search', { query: 'canary' });
    const offHit = off.result.structuredContent.results
      .find((h) => h.kind === 'message' && h.message.id === msgId);
    assert.equal(offHit, undefined,
      'a word living only in the body must not match while mail.bodies is off');

    const on = await call({ db, config: cfg(ALL_ON) }, 'zelos_search', { query: 'canary' });
    const onHit = on.result.structuredContent.results
      .find((h) => h.kind === 'message' && h.message.id === msgId);
    assert.ok(onHit, 'the body IS indexed: the same query finds it once the scope is on');

    // A message reachable by its SUBJECT still comes back with the scope off,
    // and still hands over no body text and no FTS excerpt.
    const bySubject = await call({ db, config: cfg(ALL_ON_NO_BODIES) }, 'zelos_search', { query: SUBJECT_WORD });
    const subjHit = bySubject.result.structuredContent.results
      .find((h) => h.kind === 'message' && h.message.id === msgId);
    assert.ok(subjHit, 'metadata search must keep working — the subject is still indexed');
    assert.equal(subjHit.message.snippet, SNIPPET);
    assert.equal(Object.hasOwn(subjHit.message, 'body'), false, 'there must not even be a body key');
    assert.equal(Object.hasOwn(subjHit, 'excerpt'), false, 'the FTS excerpt is cut from the body — it must not go out');
    assert.equal(JSON.stringify(subjHit).includes(BODY_CANARY), false);
  });

  test('with it ON, the same phrase comes back', async () => {
    const { db, msgId } = seeded();
    const ctx = { db, config: cfg(ALL_ON) };
    for (const [name, args] of [
      ['zelos_search', { query: 'canary' }],
      ['zelos_thread', { thread: 'thread-invoice' }],
      ['zelos_thread', { messageId: msgId }],
    ]) {
      const wire = JSON.stringify(await call(ctx, name, args));
      assert.ok(wire.includes(BODY_CANARY), `${name} should return the body when mail.bodies is on`);
    }
  });

  test('mail.bodies on its own opens the mail tools, and carries the body', async () => {
    const { db } = seeded();
    const ctx = { db, config: cfg({ 'mail.bodies': true }) };
    const listed = (await handle(rpc('tools/list'), ctx)).result.tools.map((t) => t.name).sort();
    assert.deepEqual(listed, ['zelos_search', 'zelos_thread']);
    const wire = JSON.stringify(await call(ctx, 'zelos_thread', { thread: 'thread-invoice' }));
    assert.ok(wire.includes(BODY_CANARY));
  });

  test('a body longer than the cap is truncated and says so', async () => {
    const db = freshDb();
    dbm.upsertMessage(db, message({ text: `${'x'.repeat(60_000)} ${BODY_CANARY}` }));
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_thread', { thread: 'thread-invoice' });
    const msg = res.result.structuredContent.messages[0];
    assert.equal(msg.bodyTruncated, true);
    assert.ok(msg.body.length <= 40_000);
  });

  test('board items never carry the raw model payload', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_board', {});
    const item = res.result.structuredContent.items[0];
    assert.equal(Object.hasOwn(item, 'payload'), false);
    assert.ok(item.headline && item.why, 'the triage text itself is the point of the board scope');
  });

  test('calendar hands over time and place, not the event description', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_calendar', { from: '2026-08-01', to: '2026-09-01' });
    const ev = res.result.structuredContent.events[0];
    assert.equal(ev.title, 'Pre-con with Alder & Vance');
    assert.equal(ev.location, 'Site trailer');
    assert.equal(ev.attendees[0].email, 'nemo@example.com');
    assert.equal(Object.hasOwn(ev, 'description'), false, 'the scope promises title, time, location and attendees');
  });
});

/* ================================================================== *
 * The row cap
 * ================================================================== */

describe('config.ai.maxRows caps every result set', () => {
  function busy() {
    const db = freshDb();
    for (let i = 0; i < 12; i += 1) {
      dbm.upsertMessage(db, message({
        uid: 2000 + i,
        messageId: `<bulk-${i}@example.com>`,
        from: { name: `Person ${i}`, email: `person${i}@example.com` },
        subject: `Invoice ${i} is past due`,
        date: `2026-08-0${(i % 8) + 1}T09:0${i % 6}:00-04:00`,
      }));
      dbm.upsertItem(db, {
        key: `bulk-${i}`, kind: 'money', bucket: 'today', headline: `Invoice ${i}`, why: 'past due',
      }, { runId: 'run_1' });
      dbm.upsertEvent(db, {
        calendarId: 'c_work', uid: `bulk-${i}`, title: `Standup ${i}`,
        startsAt: `2026-08-1${i % 8}T09:00:00-04:00`, endsAt: `2026-08-1${i % 8}T09:30:00-04:00`,
      });
      dbm.upsertDraft(db, { itemId: `bulk-${i}`, to: `person${i}@example.com`, subject: 'Re', body: 'Sending today.' });
    }
    return db;
  }

  test('no tool returns more rows than the cap, however large the caller asks for', async () => {
    const db = busy();
    const ctx = { db, config: cfg(ALL_ON, { maxRows: 3 }) };
    const counts = {
      zelos_board: (p) => p.items.length,
      zelos_calendar: (p) => p.events.length,
      zelos_search: (p) => p.results.length,
      zelos_thread: (p) => p.messages.length,
      zelos_drafts: (p) => p.drafts.length,
      zelos_people: (p) => p.people.length,
    };
    const args = {
      zelos_board: { limit: 500 },
      zelos_calendar: { from: '2026-08-01', to: '2026-09-01', limit: 500 },
      zelos_search: { query: 'invoice', limit: 500 },
      zelos_thread: { thread: 'thread-invoice', limit: 500 },
      zelos_drafts: { limit: 500 },
      zelos_people: { limit: 500 },
    };
    for (const [name, count] of Object.entries(counts)) {
      const res = await call(ctx, name, args[name]);
      assert.ok(res.result, `${name}: ${JSON.stringify(res.error)}`);
      assert.equal(count(res.result.structuredContent), 3, `${name} returned more than maxRows`);
    }
  });

  test('a smaller limit than the cap is still honoured', async () => {
    const db = busy();
    const res = await call({ db, config: cfg(ALL_ON, { maxRows: 10 }) }, 'zelos_board', { limit: 2 });
    assert.equal(res.result.structuredContent.items.length, 2);
  });

  test('calendar limits apply to the requested window, not preceding events', async () => {
    const db = freshDb();
    for (let i = 0; i < 4; i += 1) {
      dbm.upsertEvent(db, {
        calendarId: 'c_work', uid: `yesterday-${i}`, title: 'Yesterday',
        startsAt: '2026-09-06T18:00:00-04:00', endsAt: '2026-09-06T19:00:00-04:00',
      });
    }
    dbm.upsertEvent(db, {
      calendarId: 'c_work', uid: 'today', title: 'Actual appointment',
      startsAt: '2026-09-07T09:00:00-04:00', endsAt: '2026-09-07T10:00:00-04:00',
    });
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_calendar', {
      from: '2026-09-07T00:00:00-04:00', to: '2026-09-07T23:59:59-04:00', limit: 1,
    });
    assert.deepEqual(res.result.structuredContent.events.map((event) => event.title), ['Actual appointment']);
  });

  test('calendar returns the earliest actual instant across offsets and keeps overlaps', async () => {
    const db = freshDb();
    for (const event of [
      { uid: 'later', title: 'Later', startsAt: '2026-09-06T23:30:00-04:00', endsAt: '2026-09-07T00:30:00-04:00' },
      { uid: 'overlap', title: 'Overlapping', startsAt: '2026-09-07T02:00:00Z', endsAt: '2026-09-07T03:00:00Z' },
      { uid: 'old-no-end', title: 'Old without end', startsAt: '2026-09-06T12:00:00Z' },
    ]) dbm.upsertEvent(db, { calendarId: 'c_work', ...event });
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_calendar', {
      from: '2026-09-07T02:30:00Z', to: '2026-09-07T05:00:00Z', limit: 1,
    });
    assert.deepEqual(res.result.structuredContent.events.map((event) => event.title), ['Overlapping']);
  });

  test('a nonsense limit is a clean invalid-params error', async () => {
    const db = busy();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_board', { limit: 'lots' });
    assert.equal(res.error.code, ERROR_CODES.INVALID_PARAMS);
  });
});

/* ================================================================== *
 * The audit log
 * ================================================================== */

describe('the access log', () => {
  test('every call leaves a row with the tool, the scope, the count and the time', async () => {
    const { db, itemId } = seeded();
    const ctx = { db, config: cfg(ALL_ON_NO_BODIES), transport: 'stdio', client: 'Claude Desktop' };
    assert.deepEqual(listAccessLog(db), []);

    await call(ctx, 'zelos_board', {});
    await call(ctx, 'zelos_item', { id: itemId });
    await call(ctx, 'zelos_search', { query: 'invoice' });

    const rows = listAccessLog(db);
    assert.equal(rows.length, 3, 'one row per call');
    assert.deepEqual(rows.map((r) => r.tool), ['zelos_search', 'zelos_item', 'zelos_board'], 'newest first');
    const board = rows.find((r) => r.tool === 'zelos_board');
    assert.equal(board.scope, 'board');
    assert.equal(board.rows, 1);
    assert.equal(board.ok, true);
    assert.equal(board.transport, 'stdio');
    assert.equal(board.client, 'Claude Desktop');
    assert.match(board.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('it records what the AI was refused, not only what it read', async () => {
    const { db } = seeded();
    const ctx = { db, config: cfg({ board: true }) };
    await call(ctx, 'zelos_thread', { thread: 'thread-invoice' });
    await call(ctx, 'zelos_not_a_tool', {});
    await call({ db, config: cfg(ALL_ON, { enabled: false }) }, 'zelos_board', {});

    const rows = listAccessLog(db);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.ok), [false, false, false]);
    assert.equal(rows.find((r) => r.tool === 'zelos_thread').detail, 'scope is off');
    assert.equal(rows.find((r) => r.tool === 'zelos_not_a_tool').detail, 'no such tool');
    assert.equal(rows.find((r) => r.tool === 'zelos_board').detail, 'AI access is off');
  });

  test('it says when a read included message bodies', async () => {
    const { db } = seeded();
    await call({ db, config: cfg(ALL_ON) }, 'zelos_thread', { thread: 'thread-invoice' });
    await call({ db, config: cfg(ALL_ON_NO_BODIES) }, 'zelos_thread', { thread: 'thread-invoice' });
    const [withoutBodies, withBodies] = listAccessLog(db);
    assert.equal(withBodies.detail, 'message bodies included');
    assert.equal(withoutBodies.detail, null);
  });

  test('the log survives a reopen and holds no message text', async () => {
    const { db, msgId } = seeded();
    await call({ db, config: cfg(ALL_ON) }, 'zelos_thread', { messageId: msgId });
    const wire = JSON.stringify(listAccessLog(db));
    assert.equal(wire.includes(BODY_CANARY), false, 'the audit log records that a read happened, not what was read');
    assert.equal(wire.includes(SNIPPET), false);

    recordAccess(db, { tool: 'zelos_board', scope: 'board', rows: 4, transport: 'http', tokenId: 't_x' });
    const top = listAccessLog(db, { limit: 1 })[0];
    assert.equal(top.tokenId, 't_x');
    assert.equal(top.transport, 'http');
    assert.equal(top.rows, 4);
    assert.deepEqual(listAccessLog(db, { tool: 'zelos_board' }).map((r) => r.tool), ['zelos_board']);
  });

  /**
   * "How many rows came back" is the only number the panel ever shows about a
   * call, and it was written from the count the tool FOUND rather than the count
   * that left. `fitPayload` drops rows off the end of an oversized answer, and
   * that is reachable at the defaults: MAX_BODY_CHARS against MAX_RESULT_CHARS
   * means about twenty-five full bodies fill one response, `maxRows` defaults to
   * fifty, and nothing caps stored body text at ingestion.
   *
   * The truncation IS recorded — in `detail` — but ui/views/ai-access.js renders
   * tool, scope, rows, caller and time and nothing else, so the note never
   * reaches the screen and the row simply over-reports what an AI read.
   */
  function bigThread(count = 40, chars = 45_000) {
    const db = freshDb();
    for (let i = 0; i < count; i += 1) {
      dbm.upsertMessage(db, message({
        uid: 9_000 + i,
        messageId: `<bulk-${i}@example.test>`,
        threadKey: 'thread-bulk',
        subject: `Bulk ${i}`,
        snippet: 'a long one',
        text: 'z'.repeat(chars),
      }));
    }
    return db;
  }

  test('REGRESSION: a truncated answer is logged as the rows the client received', async () => {
    const db = bigThread();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_thread', { thread: 'thread-bulk', limit: 50 });
    const payload = res.result.structuredContent;

    assert.equal(payload.truncated, true, 'the fixture has to actually overflow MAX_RESULT_CHARS');
    assert.ok(payload.messages.length < 40, 'rows must have been dropped for this test to mean anything');
    assert.equal(payload.returned, payload.messages.length, 'the payload already corrected itself');

    const row = listAccessLog(db, { limit: 1 })[0];
    assert.equal(row.rows, payload.messages.length,
      'the log reported rows the client never received');
    assert.match(row.detail, /response truncated to fit/);
  });

  test('REGRESSION: the same holds for the tool with no returned field to read back', async () => {
    /* zelos_item counts 1 + sources + drafts and puts no `returned` on the wire,
       so correcting the payload's own count would have left this one wrong. The
       count is taken from how many rows fitPayload dropped, which every tool
       has. */
    const db = bigThread(30);
    const refs = db.prepare('SELECT id FROM messages ORDER BY uid').all().map((r) => `msg:${r.id}`);
    const itemId = dbm.upsertItem(db, {
      key: 'bulk-item',
      kind: 'money',
      bucket: 'now',
      headline: 'An item with a great many sources',
      why: 'the fixture needs one',
      severity: 3,
      sourceRefs: refs,
    }, { runId: 'run_1' }).id;

    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_item', { id: itemId });
    const payload = res.result.structuredContent;
    assert.equal(payload.truncated, true, 'the fixture has to actually overflow');
    assert.ok(payload.sources.length < refs.length);

    const row = listAccessLog(db, { limit: 1 })[0];
    assert.equal(row.rows, 1 + payload.sources.length + payload.drafts.length,
      'the log counted sources that were dropped before the answer went out');
  });

  /**
   * `zelos_search` reaches a path where it reads no table at all: every kind
   * asked for belongs to a scope that is off. It used to report no scopes, and
   * the fallback then wrote whichever grants happened to be on — so a
   * board+calendar client asking for `message` got a row reading
   * `calendar+board`, naming two scopes the call never spent.
   */
  test('REGRESSION: a search that spent nothing is not logged as spending the grants that were on', async () => {
    const { db } = fourKinds();
    const ctx = { db, config: cfg({ board: true, calendar: true }) };

    const res = await call(ctx, 'zelos_search', { query: ONLY.message, kinds: ['message'] });
    assert.deepEqual(res.result.structuredContent.kinds, [], 'the one kind asked for belongs to a scope that is off');
    assert.equal(res.result.structuredContent.returned, 0);

    const row = listAccessLog(db, { limit: 1 })[0];
    assert.equal(row.ok, true);
    assert.equal(row.rows, 0);
    assert.equal(row.scope, null, 'the row named scopes the call never touched; the panel renders null as "no scope"');

    // And a search that really did look still says what it looked at, so the
    // two zero-row rows are no longer the same row.
    await call(ctx, 'zelos_search', { query: 'nothingonthisboardmatchesthisword' });
    assert.equal(listAccessLog(db, { limit: 1 })[0].scope, 'calendar+board');
  });

  test('a log that cannot be written does not fail the read', async () => {
    const { db, itemId } = seeded();
    const broken = {
      exec() { throw new Error('disk is gone'); },
      prepare() { throw new Error('disk is gone'); },
    };
    assert.equal(recordAccess(broken, { tool: 'zelos_board' }), null);
    assert.deepEqual(listAccessLog(broken), []);
    // And through the real path: a call still answers.
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_item', { id: itemId });
    assert.ok(res.result);
  });
});

/* ================================================================== *
 * JSON-RPC
 * ================================================================== */

describe('JSON-RPC 2.0', () => {
  const ctx = () => ({ db: seeded().db, config: cfg(ALL_ON) });

  test('initialize answers with a protocol version, capabilities and honest instructions', async () => {
    const res = await handle(rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Claude Desktop', version: '1.0' },
    }), ctx());
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, '2024-11-05', 'a supported version the client asked for is echoed');
    // A direct call (the HTTP path) cannot speak first, so it does not say it will.
    assert.equal(res.result.capabilities.tools.listChanged, false);
    assert.equal(res.result.serverInfo.name, 'zelos');
    assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+/);
    assert.match(res.result.instructions, /read-only/i);
  });

  test('an unsupported protocol version gets ours back rather than a crash', async () => {
    const res = await handle(rpc('initialize', { protocolVersion: '1999-01-01' }), ctx());
    assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
    assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(PROTOCOL_VERSION));
    const bare = await handle(rpc('initialize'), ctx());
    assert.equal(bare.result.protocolVersion, PROTOCOL_VERSION);
  });

  test('the instructions say plainly what is shared', async () => {
    const off = await handle(rpc('initialize'), { db: null, config: cfg(ALL_ON, { enabled: false }) });
    assert.match(off.result.instructions, /switched OFF/i);
    // And it names the tab that exists (TT-3431).
    assert.ok(off.result.instructions.includes(mcp.SHARE_SETTINGS), off.result.instructions);
    const noBodies = await handle(rpc('initialize'), { db: null, config: cfg(ALL_ON_NO_BODIES) });
    assert.match(noBodies.result.instructions, /bodies are NOT shared/i);
    const bodies = await handle(rpc('initialize'), { db: null, config: cfg(ALL_ON) });
    assert.match(bodies.result.instructions, /Full message bodies are shared/i);
  });

  /**
   * The instructions are the first thing a connected model reads, and they used
   * to open with "Everything here is read-only — there is no tool that sends,
   * writes, deletes or changes a setting." The second half is true. The first
   * half was not: reading the board wakes a snooze that has come due and holds
   * the four-item `now` bar, which is the app's own rule but is still a write.
   *
   * Derived from the annotations rather than written out twice, so the two
   * cannot drift: whichever tools do not claim `readOnlyHint` are the tools the
   * instructions have to name.
   */
  test('REGRESSION: the instructions do not claim the whole surface is read-only', async () => {
    const said = (await handle(rpc('initialize'), { db: null, config: cfg(ALL_ON) })).result.instructions;

    assert.equal(/everything here is read-only/i.test(said), false,
      'a blanket read-only claim is false while zelos_board holds the now bar');
    assert.match(said, /sends, deletes, or changes a setting/i, 'the part that IS true still has to be said');

    const changes = TOOLS.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name);
    assert.ok(changes.length > 0, 'if nothing changes a row, this test and the annotations both need revisiting');
    for (const name of changes) {
      assert.ok(said.includes(name), `${name} is not annotated read-only, so the instructions must name it`);
    }
  });

  test('ping is an empty result', async () => {
    const res = await handle(rpc('ping', undefined, 'abc'), ctx());
    assert.deepEqual(res, { jsonrpc: '2.0', id: 'abc', result: {} });
  });

  test('an unknown method is a -32601 error object, never a throw', async () => {
    for (const method of ['frobnicate', 'resources/list', 'prompts/list', 'tools/write']) {
      const res = await handle(rpc(method), ctx());
      assert.equal(res.error.code, ERROR_CODES.METHOD_NOT_FOUND, method);
      assert.equal(res.result, undefined);
      assert.equal(res.id, 1);
    }
  });

  test('malformed requests get the right JSON-RPC errors', async () => {
    const c = ctx();
    assert.equal((await handle(null, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle('tools/list', c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle(42, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle({ jsonrpc: '1.0', id: 1, method: 'ping' }, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle({ id: 1, method: 'ping' }, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle({ jsonrpc: '2.0', id: 1 }, c)).error.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal((await handle({ jsonrpc: '2.0', id: {}, method: 'ping' }, c)).error.code, ERROR_CODES.INVALID_REQUEST);
  });

  test('bad tools/call params are invalid-params, not internal errors', async () => {
    const c = ctx();
    assert.equal((await handle(rpc('tools/call', { arguments: {} }), c)).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await handle(rpc('tools/call', 'zelos_board'), c)).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await handle(rpc('tools/call', { name: 'zelos_board', arguments: [] }), c)).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_item', {})).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_search', { query: 123 })).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_board', { bucket: 'urgent!' })).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_calendar', { from: 'next tuesday' })).error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal((await call(c, 'zelos_thread', {})).error.code, ERROR_CODES.INVALID_PARAMS);
  });

  test('a notification gets no response at all', async () => {
    const c = ctx();
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, c), null);
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }, c), null);
    assert.equal(await handle({ jsonrpc: '2.0', method: 'nonsense' }, c), null);
  });

  test('a batch is answered as a batch, and an empty one is an error', async () => {
    const c = ctx();
    const res = await handle([rpc('ping', undefined, 1), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list', undefined, 2)], c);
    assert.equal(res.length, 2, 'the notification gets no reply');
    assert.deepEqual(res.map((r) => r.id), [1, 2]);
    assert.equal((await handle([], c)).error.code, ERROR_CODES.INVALID_REQUEST);
  });

  test('a missing database is an error object rather than a stack trace', async () => {
    const res = await call({ db: null, config: cfg(ALL_ON) }, 'zelos_board', {});
    assert.equal(res.error.code, ERROR_CODES.NO_DATABASE);
    // tools/list still works: a client can be told what exists before anything is open.
    const listed = await handle(rpc('tools/list'), { db: null, config: cfg(ALL_ON) });
    assert.ok(listed.result.tools.length >= 7);
  });

  test('an internal fault is reported without leaking its message', async () => {
    const exploding = {
      prepare() { throw new Error(`the secret was ${BODY_CANARY}`); },
      exec() { throw new Error(`the secret was ${BODY_CANARY}`); },
    };
    const res = await call({ db: exploding, config: cfg(ALL_ON) }, 'zelos_board', {});
    assert.equal(res.error.code, ERROR_CODES.INTERNAL_ERROR);
    assert.equal(JSON.stringify(res).includes(BODY_CANARY), false);
  });

  test('config may be a function, so a scope turned off takes effect on the next call', async () => {
    const { db } = seeded();
    const scopes = { ...ALL_ON };
    const ctxLive = { db, config: () => cfg(scopes) };
    assert.ok((await call(ctxLive, 'zelos_thread', { thread: 'thread-invoice' })).result);
    scopes['mail.metadata'] = false;
    scopes['mail.bodies'] = false;
    const after_ = await call(ctxLive, 'zelos_thread', { thread: 'thread-invoice' });
    assert.equal(after_.error.code, ERROR_CODES.SCOPE_DENIED, 'revoking a scope must bite immediately');
  });

  test('handle never throws, whatever it is handed', async () => {
    const c = ctx();
    const junk = [
      undefined, true, [], [[]], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: null },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: {}, arguments: 5 } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zelos_search', arguments: { query: 'x'.repeat(5_000) } } },
      { jsonrpc: '2.0', id: null, method: 'ping' },
    ];
    for (const request of junk) {
      const res = await handle(request, c);
      assert.ok(res === null || (typeof res === 'object'), `handle threw or returned junk for ${JSON.stringify(request)}`);
    }
  });
});

/* ================================================================== *
 * Read-only, structurally
 * ================================================================== */

describe('nothing here writes, except the one thing that says it does', () => {
  /**
   * An ALLOWLIST, not a blocklist, and the difference is the whole repair.
   *
   * This was a hand-written list of core/db.mjs write helpers, and it passed
   * while `zelos_board` rewrote the board on every call — because the write it
   * reaches for is `capNowBucket`, which lives in core/sweep.mjs, and a list of
   * db.mjs names cannot see a sweep.mjs name however carefully it is maintained.
   * Inverted, the question answers itself: every name core/mcp.mjs mentions from
   * EITHER module has to be on this list, so a helper added to db.mjs tomorrow —
   * or a second function pulled out of the sweep — fails here without anyone
   * remembering to add it anywhere.
   *
   * Exactly one entry can change a row, and it is called out for that reason.
   */
  const MAY_NAME = new Set([
    // Constants.
    'BUCKETS', 'DRAFT_STATES', 'ITEM_STATES',
    // Readers, and the two lifecycle calls the stdio server needs.
    'close', 'migrate', 'open',
    'getItem', 'getMessage', 'listBoard', 'listDrafts', 'listEvents', 'listMessages',
    'messagesInThread', 'resolveRef', 'search',
    // The one exception: the four-item `now` bar, the same rule core/server.mjs
    // holds on /api/state. `zelos_board` is annotated accordingly — see below.
    'capNowBucket',
  ]);
  const WRITERS_IT_MAY_NAME = ['capNowBucket'];

  test('core/mcp.mjs names nothing from db.mjs or sweep.mjs beyond its allowlist', () => {
    const exported = [...new Set([...Object.keys(dbm), ...Object.keys(sweepm)])].sort();
    assert.ok(exported.length > 40, 'the export scan came back too thin to be believed');
    const named = exported.filter((name) => new RegExp(`\\b${name}\\b`).test(MCP_SOURCE));
    const unexpected = named.filter((name) => !MAY_NAME.has(name));
    assert.deepEqual(unexpected, [],
      `core/mcp.mjs reaches into db.mjs or sweep.mjs for something new: ${unexpected.join(', ')}`);
    // The list must still be reaching the module it was written about: if the
    // read helpers stopped appearing, the scan is broken rather than clean.
    assert.ok(named.includes('listBoard') && named.includes('capNowBucket'),
      'the scan no longer finds names it certainly should — it must be broken');
  });

  test('the SQL in this file targets its own audit log, and the borrowed write records only item demotion history', () => {
    const targets = [...MCP_SOURCE.matchAll(/\b(insert\s+into|update|delete\s+from)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map((m) => m[2].toLowerCase());
    assert.ok(targets.length > 0, 'the scan found nothing — it must be broken');
    assert.deepEqual([...new Set(targets)], ['ai_access_log']);

    /* Half the question, and for a long time it was mistaken for all of it: the
       board repair is not this file's SQL, it is sweep.mjs's, run through the
       one helper the allowlist above permits. So the other half is asserted
       where the statement actually lives. The item demotion now records its
       matching history atomically; no DELETE may remove the item. */
    const sweepSource = fs.readFileSync(path.join(ROOT, 'core', 'sweep.mjs'), 'utf8');
    const borrowed = sweepSource.slice(sweepSource.indexOf('export function capNowBucket'));
    const body = borrowed.slice(0, borrowed.indexOf('\n}\n') + 2);
    assert.ok(body.includes('setItemBucket'), 'capNowBucket no longer uses the recorded demotion helper');
    const dbSource = fs.readFileSync(path.join(ROOT, 'core', 'db.mjs'), 'utf8');
    const helper = dbSource.slice(dbSource.indexOf('export function setItemBucket'));
    const demote = helper.slice(0, helper.indexOf('\n}\n') + 2);
    assert.match(demote, /UPDATE items SET bucket = \?, updated_at = \? WHERE id = \?/);
    assert.equal(/delete\s+from/i.test(demote), false, 'the demotion must never delete a row');
    assert.ok(demote.includes("origin: 'automatic'"));
    assert.ok(demote.includes('recordItemRevision'));
    const recorder = dbSource.slice(dbSource.indexOf('function recordItemRevision'));
    const recorderBody = recorder.slice(0, recorder.indexOf('\n}\n') + 2);
    const historyTargets = [...recorderBody.matchAll(/\b(insert\s+into|update|delete\s+from)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map((match) => match[2].toLowerCase());
    assert.deepEqual(historyTargets, ['item_history']);
  });

  test('no tool is write-shaped, and the annotation matches what the tool does', () => {
    const forbidden = /^(send|delete|remove|write|create|update|set|move|archive|reply|forward|mark|sync|fetch|run)$/i;
    for (const tool of TOOLS) {
      for (const word of tool.name.split('_')) {
        assert.equal(forbidden.test(word), false, `${tool.name} reads like it changes something`);
      }
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.annotations.openWorldHint, false);
    }
    /* `readOnlyHint` used to be asserted true for all seven, which is how the
       false one survived a suite that was looking straight at it. It is the
       field an MCP host reads to decide it may run a tool WITHOUT asking the
       owner, so it is now pinned per tool, by name, and the behavioural test
       below re-derives the same split from the database. */
    assert.deepEqual(
      TOOLS.filter((t) => t.annotations.readOnlyHint === true).map((t) => t.name).sort(),
      ['zelos_calendar', 'zelos_drafts', 'zelos_item', 'zelos_people', 'zelos_search', 'zelos_thread'],
    );
    assert.deepEqual(
      TOOLS.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name),
      ['zelos_board'],
      'zelos_board holds the four-item now bar, so it may not claim readOnlyHint',
    );
    assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
      'zelos_board', 'zelos_calendar', 'zelos_drafts', 'zelos_item', 'zelos_people', 'zelos_search', 'zelos_thread',
    ], 'the tool set changed — was a write added?');
  });

  test('it opens no socket of its own', () => {
    for (const re of [/\bfetch\s*\(/, /node:http\b/, /node:net\b/, /node:tls\b/, /\.connect\s*\(/]) {
      assert.equal(re.test(MCP_SOURCE), false, `core/mcp.mjs looks like it talks to the network: ${re}`);
    }
  });

  /**
   * The fixture this suite lacked.
   *
   * It used to be `seeded()`: one open `now` item, no snooze. `capNowBucket`
   * returns 0 below five, and `WAKE_DUE_SNOOZES` updates nothing when nothing is
   * asleep — so every table hash held still and the test reported "a read
   * changed nothing" about a tool that rewrites the board whenever there is
   * anything to rewrite. Five `now` items and one snooze past its wake-up time
   * is the smallest board on which both writes actually fire.
   */
  function boardTheRepairWillTouch() {
    const s = seeded();
    for (let i = 0; i < 4; i += 1) {
      dbm.upsertItem(s.db, {
        key: `filler-now-${i}`,
        kind: 'money',
        bucket: 'now',
        headline: `Filler now item ${i}`,
        why: 'it is already on the board',
        severity: 3,
        sourceRefs: [],
      }, { runId: 'run_1' });
    }
    const asleep = dbm.upsertItem(s.db, {
      key: 'asleep-and-due',
      kind: 'money',
      bucket: 'now',
      headline: 'The one that was asleep',
      why: 'it was snoozed until this morning',
      severity: 1,
      sourceRefs: [],
    }, { runId: 'run_1' }).id;
    dbm.setItemState(s.db, asleep, 'snoozed', { snoozedUntil: '2020-01-01T09:00:00-05:00' });
    return { ...s, asleep };
  }

  const TABLES = ['messages', 'events', 'drafts', 'captures', 'kv', 'runs'];
  const hashOf = (db, table) => JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all());

  test('running every tool touches items and nothing else, on a board the repair has work to do on', async () => {
    const { db, itemId, msgId, asleep } = boardTheRepairWillTouch();
    const before = Object.fromEntries(TABLES.map((t) => [t, hashOf(db, t)]));
    const searchBefore = JSON.stringify(db.prepare('SELECT ref, kind FROM search ORDER BY ref').all());
    const itemsBefore = db.prepare('SELECT * FROM items ORDER BY id').all();

    const ctx = { db, config: cfg(ALL_ON) };
    for (const [name, args] of everyCall({ itemId, msgId })) await call(ctx, name, args);

    for (const t of TABLES) {
      assert.equal(hashOf(db, t), before[t], `a read changed the ${t} table`);
    }
    assert.equal(JSON.stringify(db.prepare('SELECT ref, kind FROM search ORDER BY ref').all()), searchBefore,
      'a read reindexed something');

    // `items` did move, and this is the whole extent of it: the snoozed one is
    // awake, one of the five is a bucket down, nothing was deleted, nothing was
    // finished, and no text an item carries was rewritten.
    const itemsAfter = db.prepare('SELECT * FROM items ORDER BY id').all();
    assert.notEqual(JSON.stringify(itemsAfter), JSON.stringify(itemsBefore),
      'the fixture is back to being one the repair has nothing to do on — this test proves nothing again');
    assert.equal(itemsAfter.length, itemsBefore.length, 'a read deleted an item');
    const by = new Map(itemsBefore.map((r) => [r.id, r]));
    for (const after of itemsAfter) {
      const was = by.get(after.id);
      assert.ok(was, 'a read invented an item');
      for (const col of ['headline', 'why', 'person', 'person_email', 'due_at', 'severity',
        'kind', 'source_refs_json', 'payload_json', 'first_seen', 'link']) {
        assert.equal(after[col], was[col], `a read rewrote items.${col}`);
      }
      assert.ok(['open', 'snoozed'].includes(after.state), `a read moved an item to ${after.state}`);
      if (after.id !== asleep) assert.equal(after.bucket === was.bucket || after.bucket === 'today', true);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE state = 'open' AND bucket = 'now'").get().n, 4,
      'the bar the repair exists to hold');
    assert.equal(dbm.getItem(db, asleep).state, 'open', 'the due snooze woke, which is what makes a fifth appear');
  });

  /**
   * The invariant the annotation is FOR, measured rather than asserted about the
   * source: a host reads `readOnlyHint` to decide it need not ask the owner, so
   * the tools that move a row must be exactly the tools that do not claim it.
   *
   * This is the test that would have caught the original: with `zelos_board`
   * annotated `readOnlyHint: true`, it goes red on the first tool it tries.
   */
  test('the tools that change a row are exactly the tools not annotated read-only', async () => {
    const ARGS = {
      zelos_board: {},
      zelos_calendar: { from: '2026-08-01', to: '2026-09-01' },
      zelos_drafts: {},
      zelos_item: null, // filled per fixture
      zelos_people: {},
      zelos_search: { query: 'invoice' },
      zelos_thread: { thread: 'thread-invoice' },
    };

    for (const tool of TOOLS) {
      const { db, itemId } = boardTheRepairWillTouch();
      const before = JSON.stringify(db.prepare('SELECT * FROM items ORDER BY id').all());
      const res = await call({ db, config: cfg(ALL_ON) }, tool.name, ARGS[tool.name] ?? { id: itemId });
      assert.ok(res.result, `${tool.name} did not run: ${JSON.stringify(res.error)}`);
      const changed = JSON.stringify(db.prepare('SELECT * FROM items ORDER BY id').all()) !== before;
      assert.equal(changed, tool.annotations.readOnlyHint !== true,
        changed
          ? `${tool.name} changed a row while telling the host readOnlyHint — that is the field a client `
            + 'consults to skip asking the owner'
          : `${tool.name} does not claim readOnlyHint but changed nothing; say what is true`);
    }
  });
});

/* ================================================================== *
 * stdio transport
 * ================================================================== */

describe('the stdio transport', () => {
  function rig({ config = cfg(ALL_ON), db = seeded().db } = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk) => { text += chunk.toString('utf8'); });
    const server = createStdioServer({ db, config, input, output });
    return {
      db,
      input,
      server,
      async run(lines) {
        server.start();
        for (const line of lines) input.write(line);
        input.end();
        const summary = await server.done;
        return { summary, lines: text.trim() ? text.trim().split('\n') : [] };
      },
    };
  }

  test('newline-delimited JSON-RPC in, newline-delimited JSON-RPC out, in order', async () => {
    const r = rig();
    const { lines, summary } = await r.run([
      `${JSON.stringify(rpc('initialize', { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'Claude Desktop' } }, 1))}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      `${JSON.stringify(rpc('tools/list', undefined, 2))}\n`,
      `${JSON.stringify(rpc('tools/call', { name: 'zelos_board', arguments: {} }, 3))}\n`,
    ]);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((p) => p.id), [1, 2, 3], 'the notification got no reply, and order is preserved');
    for (const p of parsed) assert.equal(p.jsonrpc, '2.0');
    assert.equal(parsed[2].result.structuredContent.items.length, 1);
    assert.equal(summary.client, 'Claude Desktop');
    assert.equal(summary.handled, 4);
  });

  test('the client name from initialize lands in the access log', async () => {
    const r = rig();
    await r.run([
      `${JSON.stringify(rpc('initialize', { clientInfo: { name: 'Some Other AI' } }, 1))}\n`,
      `${JSON.stringify(rpc('tools/call', { name: 'zelos_board', arguments: {} }, 2))}\n`,
    ]);
    assert.equal(listAccessLog(r.db)[0].client, 'Some Other AI');
  });

  test('a line that is not JSON is a parse error, and the stream keeps going', async () => {
    const r = rig();
    const { lines } = await r.run([
      'this is not json\n',
      '\n',
      `${JSON.stringify(rpc('ping', undefined, 7))}\n`,
    ]);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].error.code, ERROR_CODES.PARSE_ERROR);
    assert.equal(parsed[0].id, null);
    assert.deepEqual(parsed[1], { jsonrpc: '2.0', id: 7, result: {} });
  });

  test('a message split across chunks — including mid-character — survives', async () => {
    const r = rig();
    const request = JSON.stringify(rpc('tools/call', { name: 'zelos_search', arguments: { query: 'café ☕' } }, 5));
    const bytes = Buffer.from(`${request}\n`, 'utf8');
    // Cut inside the multibyte é: a string-concatenating reader corrupts here.
    const eAcute = bytes.indexOf(Buffer.from('é', 'utf8'));
    assert.ok(eAcute > 0);
    const { lines } = await r.run([
      bytes.subarray(0, eAcute + 1),
      bytes.subarray(eAcute + 1, bytes.length - 10),
      bytes.subarray(bytes.length - 10),
    ]);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.id, 5);
    assert.equal(parsed.result.structuredContent.query, 'café ☕', 'the query came back mangled');
  });

  test('a final message with no trailing newline is still answered', async () => {
    const r = rig();
    const { lines } = await r.run([JSON.stringify(rpc('ping', undefined, 9))]);
    assert.equal(JSON.parse(lines[0]).id, 9);
  });

  test('every byte written to stdout is a JSON-RPC message', async () => {
    const r = rig({ db: null });
    const { lines } = await r.run([
      `${JSON.stringify(rpc('tools/call', { name: 'zelos_board', arguments: {} }, 1))}\n`,
      `${JSON.stringify(rpc('ping', undefined, 2))}\n`,
    ]);
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws if anything else reached stdout
      assert.equal(parsed.jsonrpc, '2.0');
    }
  });

  test('with the master switch off it runs, and refuses everything', async () => {
    const r = rig({ config: cfg(ALL_ON, { enabled: false }) });
    const { lines } = await r.run([
      `${JSON.stringify(rpc('initialize', {}, 1))}\n`,
      `${JSON.stringify(rpc('tools/list', undefined, 2))}\n`,
      `${JSON.stringify(rpc('tools/call', { name: 'zelos_search', arguments: { query: 'invoice' } }, 3))}\n`,
    ]);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.ok(parsed[0].result.instructions.includes('OFF'));
    assert.deepEqual(parsed[1].result.tools, []);
    assert.equal(parsed[2].error.code, ERROR_CODES.AI_DISABLED);
    assert.ok(parsed[2].error.message.includes(mcp.SHARE_SETTINGS), `the refusal names another place: ${parsed[2].error.message}`);
  });

  test('serveStdio runs until stdin closes', async () => {
    const { db } = seeded();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => { text += c.toString('utf8'); });

    const running = serveStdio({ db, config: cfg(ALL_ON), input, output });
    input.write(`${JSON.stringify(rpc('ping', undefined, 1))}\n`);
    input.write(`${JSON.stringify(rpc('tools/call', { name: 'zelos_people', arguments: {} }, 2))}\n`);
    input.end();

    const summary = await running;
    assert.equal(summary.handled, 2);
    const parsed = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((p) => p.id), [1, 2]);
    assert.equal(parsed[1].result.structuredContent.people[0].email, 'marcus@riverstone.example');
  });

  test('none of this ran against the real Zelos home', () => {
    assert.ok(fs.realpathSync(HOME_ROOT).startsWith(fs.realpathSync(os.tmpdir())), 'the suite must live in a temp dir');
    assert.ok(process.env.ZELOS_HOME.startsWith(HOME_ROOT), 'ZELOS_HOME escaped the temp dir');
    assert.notEqual(path.resolve(process.env.ZELOS_HOME), path.join(os.homedir(), '.zelos'));
  });
});

/* ================================================================== *
 * The data itself
 * ================================================================== */

describe('what the tools return', () => {
  test('the board carries what the scope promises', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_board', {});
    const item = res.result.structuredContent.items[0];
    assert.equal(item.bucket, 'now');
    assert.equal(item.headline, 'Chase invoice 4471 — 21 days past due');
    assert.equal(item.person, 'Marcus Reyes');
    assert.equal(item.personEmail, 'marcus@riverstone.example');
    assert.equal(item.dueAt, '2026-08-12T17:00:00-04:00');
    assert.equal(item.severity, 3);
    assert.equal(item.state, 'open');
    assert.ok(item.sourceRefs.includes(`msg:${db.prepare('SELECT id FROM messages ORDER BY uid LIMIT 1').get().id}`));
  });

  test('a bucket filter and a state filter both work', async () => {
    const { db } = seeded();
    const ctx = { db, config: cfg(ALL_ON) };
    assert.equal((await call(ctx, 'zelos_board', { bucket: 'now' })).result.structuredContent.items.length, 1);
    assert.equal((await call(ctx, 'zelos_board', { bucket: 'today' })).result.structuredContent.items.length, 0);
    assert.equal((await call(ctx, 'zelos_board', { state: 'done' })).result.structuredContent.items.length, 0);
  });

  test('an item that does not exist says so instead of erroring', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_item', { id: 'nope' });
    assert.equal(res.result.structuredContent.found, false);
    assert.equal(res.result.structuredContent.item, null);
    assert.equal(listAccessLog(db)[0].rows, 0);
  });

  test('a thread comes back oldest first, with both directions', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON_NO_BODIES) }, 'zelos_thread', { thread: 'thread-invoice' });
    const messages = res.result.structuredContent.messages;
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((m) => m.direction), ['in', 'out']);
    assert.equal(messages[0].from.email, 'marcus@riverstone.example');
    assert.equal(messages[0].subject, 'Invoice 4471 is past due');
    assert.equal(messages[0].date, '2026-08-05T09:12:00-04:00');
    assert.equal(messages[0].hasAttachments, true);
  });

  test('an unknown thread is empty rather than an error', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_thread', { thread: 'no-such-thread' });
    assert.equal(res.result.structuredContent.found, false);
    assert.deepEqual(res.result.structuredContent.messages, []);
  });

  /**
   * Search used to be mail's alone. A person who had granted only the calendar
   * had no search tool at all, and the only way to get one was to grant mail —
   * which is precisely the trade this app exists to avoid, given the filtering
   * that makes it safe was already inside the tool.
   */
  test('a client holding only the calendar can search its own calendar', async () => {
    const { db } = seeded();
    const ctx = { db, config: cfg({ calendar: true }) };

    const listed = (await handle(rpc('tools/list'), ctx)).result.tools.map((t) => t.name).sort();
    assert.deepEqual(listed, ['zelos_calendar', 'zelos_search']);

    const res = await call(ctx, 'zelos_search', { query: 'pre-con' });
    const found = res.result.structuredContent;
    assert.deepEqual(found.kinds, ['event'], 'only the kinds this scope owns are searched at all');
    assert.ok(found.results.length >= 1, 'and the event it was looking for comes back');
    for (const hit of found.results) assert.equal(hit.kind, 'event');

    // The grant did not widen: a query that only matches mail finds nothing,
    // and no message text is anywhere in the answer.
    const mail = await call(ctx, 'zelos_search', { query: 'retainage' });
    assert.deepEqual(mail.result.structuredContent.results, []);
    const wire = JSON.stringify([res, mail]);
    assert.equal(wire.includes(SNIPPET), false, 'a calendar grant must not return a mail snippet');
    assert.equal(wire.includes(BODY_CANARY), false);
  });

  test('a board-only client searches board items, and nothing else', async () => {
    const { db } = seeded();
    const ctx = { db, config: cfg({ board: true }) };
    const res = await call(ctx, 'zelos_search', { query: 'retainage' });
    const found = res.result.structuredContent;
    assert.deepEqual(found.kinds, ['item'], 'board owns items and only items');
    for (const hit of found.results) assert.equal(hit.kind, 'item');
    assert.equal(JSON.stringify(res).includes(SNIPPET), false);
  });

  test('with nothing searchable granted, search is not there to be called', async () => {
    const { db } = seeded();
    const ctx = { db, config: cfg({ drafts: true, people: true }) };
    const listed = (await handle(rpc('tools/list'), ctx)).result.tools.map((t) => t.name);
    assert.equal(listed.includes('zelos_search'), false);

    const res = await call(ctx, 'zelos_search', { query: 'retainage' });
    assert.equal(res.result, undefined);
    assert.equal(res.error.code, ERROR_CODES.SCOPE_DENIED);
    assert.match(res.error.message, /any one of/, 'the refusal names every scope that would have granted it');
    assert.deepEqual(res.error.data.scopes, ['mail.metadata', 'calendar', 'board']);
  });

  test('search restricts kinds to the scopes that are on', async () => {
    const { db } = seeded();
    const mailOnly = await call({ db, config: cfg({ 'mail.metadata': true }) }, 'zelos_search', { query: 'retainage' });
    assert.deepEqual(mailOnly.result.structuredContent.kinds, ['message']);
    for (const hit of mailOnly.result.structuredContent.results) assert.equal(hit.kind, 'message');

    const asked = await call({ db, config: cfg(ALL_ON) }, 'zelos_search', { query: 'invoice', kinds: ['message'] });
    assert.deepEqual(asked.result.structuredContent.kinds, ['message']);
    assert.ok(asked.result.structuredContent.results.length >= 1);

    // Asking for a kind whose scope is off yields nothing, not an error.
    const denied = await call({ db, config: cfg({ 'mail.metadata': true }) }, 'zelos_search', { query: 'retainage', kinds: ['item'] });
    assert.deepEqual(denied.result.structuredContent.results, []);
  });

  test('people counts both directions and leaves the owner out', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_people', {});
    const people = res.result.structuredContent.people;
    assert.deepEqual(people.map((p) => p.email), ['marcus@riverstone.example']);
    assert.equal(people[0].name, 'Marcus Reyes');
    assert.equal(people[0].messages, 2);
    assert.equal(people[0].received, 1);
    assert.equal(people[0].sent, 1);
    assert.equal(people[0].lastAt, '2026-08-06T08:00:00-04:00');
  });

  test('drafts come back with their text and their state, and nothing that sends them', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_drafts', {});
    const draft = res.result.structuredContent.drafts[0];
    assert.equal(draft.to, 'marcus@riverstone.example');
    assert.equal(draft.state, 'pending');
    assert.match(draft.body, /accounting is releasing 4471/);
    assert.equal((await call({ db, config: cfg(ALL_ON) }, 'zelos_drafts', { state: 'used' })).result.structuredContent.drafts.length, 0);
  });

  test('the calendar window defaults to the next two weeks and filters by instant', async () => {
    const db = freshDb();
    dbm.upsertEvent(db, { calendarId: 'c', uid: 'past', title: 'Long gone', startsAt: '2020-01-01T09:00:00-05:00', endsAt: '2020-01-01T10:00:00-05:00' });
    dbm.upsertEvent(db, { calendarId: 'c', uid: 'soon', title: 'In the window', startsAt: '2026-08-11T14:00:00-04:00', endsAt: '2026-08-11T15:00:00-04:00' });
    const ctx = { db, config: cfg(ALL_ON) };

    const window = (await call(ctx, 'zelos_calendar', { from: '2026-08-10T00:00:00-04:00', to: '2026-08-12T00:00:00-04:00' })).result.structuredContent;
    assert.deepEqual(window.events.map((e) => e.title), ['In the window']);

    const wide = (await call(ctx, 'zelos_calendar', { from: '2019-01-01', to: '2027-01-01' })).result.structuredContent;
    assert.equal(wide.events.length, 2);

    const defaulted = (await call(ctx, 'zelos_calendar', {})).result.structuredContent;
    assert.match(defaulted.from, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Date.parse(defaulted.to) - Date.parse(defaulted.from) > 13 * 86_400_000);
    assert.equal(defaulted.events.some((e) => e.title === 'Long gone'), false);
  });

  test('the text result and the structured result are the same thing', async () => {
    const { db } = seeded();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_board', {});
    assert.equal(res.result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(res.result.content[0].text), res.result.structuredContent);
  });
});

/* ================================================================== *
 * REGRESSION — a scope returns its own kind, and the audit says so
 *
 * Widening `zelos_search` so any scope that owns a searchable kind could reach
 * it was right; what shipped with it was not. `capture` was mapped to `board`,
 * so a client granted nothing but the board — "headline, why it matters, which
 * bucket, when it is due" — could search the notes the owner had typed into
 * Zelos themselves and get them back verbatim, including notes no board item
 * had ever referenced. A board grant is not a grant to read a diary.
 *
 * The second half is the audit log. Every row carried the tool's NOMINAL scope,
 * which for `zelos_search` is `mail.metadata`, so a board-only token searching
 * the board left a row reading `mail.metadata`. The log is the only place a
 * person can see what a connected AI actually read; a row naming a scope the
 * call never used is worse than no row at all.
 *
 * These tests use one canary word per kind, each living in exactly one place,
 * so a hit names the kind that answered rather than merely saying "something
 * came back".
 * ================================================================== */

const ONLY = Object.freeze({
  capture: 'PRIVATENOTECANARY',
  message: 'MESSAGESUBJECTCANARY',
  event: 'EVENTTITLECANARY',
  item: 'ITEMHEADLINECANARY',
});

/** One indexed row per kind, and nothing shared between them. */
function fourKinds() {
  const db = freshDb();

  const capture = dbm.insertCapture(db, `${ONLY.capture} — what the doctor said, and who not to tell`);

  const msgId = dbm.upsertMessage(db, message({
    uid: 7001,
    messageId: '<canary@example.test>',
    threadKey: 'thread-canary',
    subject: `${ONLY.message} quarterly numbers`,
    snippet: 'nothing notable in here',
    text: 'nothing notable in here',
  })).id;

  dbm.upsertEvent(db, {
    calendarId: 'c_work',
    uid: 'evt-canary',
    title: `${ONLY.event} pre-con`,
    description: 'nothing notable in here',
    location: 'Site trailer',
    startsAt: '2026-08-11T14:00:00-04:00',
    endsAt: '2026-08-11T15:00:00-04:00',
  });

  const itemId = dbm.upsertItem(db, {
    key: 'canary-item',
    kind: 'money',
    bucket: 'now',
    headline: `${ONLY.item} chase the invoice`,
    why: 'nothing notable in here',
    // The item cites the note it came from, which is how a capture reaches
    // zelos_item at all — the case the search fix must not leave open.
    sourceRefs: [`cap:${capture.id}`, `msg:${msgId}`],
  }, { runId: 'run_1' }).id;

  // Items are indexed by the sweep, not by the upsert, so index them here.
  dbm.reindex(db);
  return { db, captureId: capture.id, msgId, itemId };
}

describe('a scope reaches its own kind and no other', () => {
  const OWNS = [
    ['board', 'item'],
    ['calendar', 'event'],
    ['mail.metadata', 'message'],
  ];

  test('each scope searches exactly the kind it owns', async () => {
    const { db } = fourKinds();

    for (const [scope, owned] of OWNS) {
      const ctx = { db, config: cfg({ [scope]: true }) };

      const own = (await call(ctx, 'zelos_search', { query: ONLY[owned] })).result.structuredContent;
      assert.deepEqual(own.kinds, [owned], `${scope} must search ${owned} and nothing else`);
      assert.equal(own.results.length, 1, `${scope} must still find its own ${owned}`);
      assert.equal(own.results[0].kind, owned);

      // Every other kind's canary: not a hit, and not a word of it in the wire.
      for (const [kind, word] of Object.entries(ONLY)) {
        if (kind === owned) continue;
        const res = await call(ctx, 'zelos_search', { query: word });
        const found = res.result.structuredContent;
        assert.deepEqual(found.results, [], `${scope} returned a ${kind} it was never granted`);
        assert.equal(found.kinds.includes(kind), false, `${scope} searched ${kind} at all`);
      }
    }
  });

  test('a board-only client cannot read a capture, which is the whole finding', async () => {
    const { db } = fourKinds();
    const ctx = { db, config: cfg({ board: true }) };

    const res = await call(ctx, 'zelos_search', { query: ONLY.capture });
    const found = res.result.structuredContent;
    assert.deepEqual(found.kinds, ['item'], 'board owns items; captures belong to no scope');
    assert.deepEqual(found.results, []);
    assert.equal(JSON.stringify(res).includes('what the doctor said'), false,
      'the text of a private note reached a client that was granted the board');
  });

  test('no combination of scopes returns a capture', async () => {
    const { db } = fourKinds();
    let calls = 0;

    for (let mask = 0; mask < (1 << SCOPES.length); mask += 1) {
      const on = Object.fromEntries(SCOPES.map((s, i) => [s, Boolean(mask & (1 << i))]));
      const ctx = { db, config: cfg(on) };
      const res = await call(ctx, 'zelos_search', { query: ONLY.capture });
      calls += 1;
      const wire = JSON.stringify(res);
      // The query itself is echoed back — that is the caller's own word. A
      // `"ref"` or the note's text is not.
      assert.equal(wire.includes('"kind": "capture"'), false, `a capture came back with ${JSON.stringify(on)}`);
      assert.equal(wire.includes('what the doctor said'), false, `a note leaked with ${JSON.stringify(on)}`);
      assert.equal(wire.includes('cap:'), false, `a capture ref leaked with ${JSON.stringify(on)}`);
    }
    assert.equal(calls, 64, 'the sweep must cover every combination of the six scopes');
  });

  test('capture is not a kind the tool offers, so asking for it is refused', async () => {
    const { db } = fourKinds();
    const schema = TOOLS.find((t) => t.name === 'zelos_search').inputSchema;
    assert.deepEqual(schema.properties.kinds.items.enum, ['message', 'event', 'item'],
      'the schema must not advertise a kind no scope can authorise');

    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_search', { query: ONLY.capture, kinds: ['capture'] });
    assert.equal(res.result, undefined);
    assert.equal(res.error.code, ERROR_CODES.INVALID_PARAMS);
    assert.match(res.error.message, /message, event, item/);
  });

  test('zelos_item does not hand over the note the item was derived from', async () => {
    const { db, itemId, msgId } = fourKinds();
    const res = await call({ db, config: cfg(ALL_ON) }, 'zelos_item', { id: itemId });
    const payload = res.result.structuredContent;

    assert.deepEqual(payload.sources.map((s) => s.kind), ['message'],
      'the mail source belongs to mail; the capture belongs to nobody');
    assert.equal(payload.sources[0].ref, `msg:${msgId}`);
    assert.equal(JSON.stringify(res).includes(ONLY.capture), false);
    assert.equal(JSON.stringify(res).includes('what the doctor said'), false);
  });
});

/* ================================================================== *
 * Source ids
 *
 * The `sources` array was filtered scope by scope from the day it was written.
 * `itemView` was not: it emitted `row.sourceRefs` raw, and did not even receive
 * the runtime, so a client holding nothing but `board` got a correctly-empty
 * `sources` sitting beside `sourceRefs: ["cap:…", "msg:…"]`.
 *
 * No content escaped that way — those ids dereference under none of the 64
 * scope combinations. An id is still an answer: it says a private note exists,
 * how many there are, and it is a stable handle to diff across calls and watch
 * new mail arrive. That is the same existence oracle `searchColumns` exists to
 * close, one door down.
 * ================================================================== */

describe('a source id is as visible as the thing it points at', () => {
  test('REGRESSION: a board-only client gets no ids it was never granted', async () => {
    const { db, itemId, captureId, msgId } = fourKinds();
    const res = await call({ db, config: cfg({ board: true }) }, 'zelos_item', { id: itemId });
    const payload = res.result.structuredContent;

    assert.deepEqual(payload.sources, [], 'the mail source needs mail, and the capture belongs to nobody');
    assert.deepEqual(payload.item.sourceRefs, [],
      'sourceRefs went out raw beside a correctly-filtered sources array');
    const wire = JSON.stringify(res);
    assert.equal(wire.includes(captureId), false, 'a capture id reached a client granted only the board');
    assert.equal(wire.includes(msgId), false, 'a message id reached a client granted only the board');
  });

  test('the filter is a filter, not a blanket: mail buys the message ref and not the note', async () => {
    const { db, itemId, captureId, msgId } = fourKinds();
    const ctx = { db, config: cfg({ board: true, 'mail.metadata': true }) };

    for (const [name, args] of [['zelos_item', { id: itemId }], ['zelos_board', {}], ['zelos_search', { query: ONLY.item }]]) {
      const res = await call(ctx, name, args);
      const item = name === 'zelos_item'
        ? res.result.structuredContent.item
        : (res.result.structuredContent.items || res.result.structuredContent.results.map((r) => r.item))[0];
      assert.deepEqual(item.sourceRefs, [`msg:${msgId}`], `${name} did not return the granted ref`);
      assert.equal(JSON.stringify(res).includes(captureId), false, `${name}: mail does not buy the capture`);
    }
  });

  test('REGRESSION: no combination of scopes leaks a source id, through any tool that returns an item', async () => {
    const { db, itemId, captureId, msgId } = fourKinds();
    let answered = 0;

    for (let mask = 0; mask < (1 << SCOPES.length); mask += 1) {
      const on = Object.fromEntries(SCOPES.map((s, i) => [s, Boolean(mask & (1 << i))]));
      const ctx = { db, config: cfg(on) };
      for (const [name, args] of [
        ['zelos_item', { id: itemId }],
        ['zelos_board', {}],
        ['zelos_search', { query: ONLY.item }],
      ]) {
        const res = await call(ctx, name, args);
        if (!res.result) continue; // the scope is off; there was nothing to leak
        answered += 1;
        const wire = JSON.stringify(res);
        assert.equal(wire.includes(captureId), false,
          `${name} handed over a capture id with ${JSON.stringify(on)}`);
        // `mail.bodies` implies `mail.metadata` — the one implication in the set
        // — so a bodies grant legitimately buys the message ref too.
        if (!on['mail.metadata'] && !on['mail.bodies']) {
          assert.equal(wire.includes(msgId), false,
            `${name} handed over a message id with ${JSON.stringify(on)}`);
        }
      }
    }
    assert.ok(answered >= 64, `the sweep has to actually reach the tools; it answered ${answered} times`);
  });
});

describe('the audit log names the scope that actually authorised the call', () => {
  const newest = (db) => listAccessLog(db, { limit: 1 })[0];

  test('a board-only search is logged as a board read, not a mail read', async () => {
    const { db } = fourKinds();
    await call({ db, config: cfg({ board: true }) }, 'zelos_search', { query: ONLY.item });
    const row = newest(db);
    assert.equal(row.tool, 'zelos_search');
    assert.equal(row.scope, 'board', 'the log claimed a scope the call never used');
    assert.equal(row.ok, true);
    assert.equal(row.rows, 1);
  });

  test('the same call under the calendar is logged as a calendar read', async () => {
    const { db } = fourKinds();
    await call({ db, config: cfg({ calendar: true }) }, 'zelos_search', { query: ONLY.event });
    assert.equal(newest(db).scope, 'calendar');
  });

  test('a search across three grants says all three, and a narrowed one says what it spent', async () => {
    const { db } = fourKinds();
    const ctx = { db, config: cfg(ALL_ON) };

    await call(ctx, 'zelos_search', { query: ONLY.message });
    assert.equal(newest(db).scope, 'mail.metadata+mail.bodies+calendar+board',
      'a search over every kind spends every scope that owns one — and this one returned a message '
      + 'with its body, which is the bodies scope, not the metadata one');

    await call({ db, config: cfg(ALL_ON_NO_BODIES) }, 'zelos_search', { query: ONLY.message });
    assert.equal(newest(db).scope, 'mail.metadata+calendar+board',
      'the same search without the bodies scope reads subjects, and says only that');

    await call(ctx, 'zelos_search', { query: ONLY.event, kinds: ['event'] });
    assert.equal(newest(db).scope, 'calendar', 'a search narrowed to events spends the calendar alone');
    assert.equal(newest(db).detail, null, 'and it is not a mail read, so it is not noted as one');
  });

  test('a single-scope tool logs what it always did', async () => {
    const { db } = fourKinds();
    await call({ db, config: cfg({ board: true }) }, 'zelos_board', {});
    assert.equal(newest(db).scope, 'board');
    await call({ db, config: cfg({ calendar: true }) }, 'zelos_calendar', {});
    assert.equal(newest(db).scope, 'calendar');
  });

  test('a refusal names every scope that would have granted it', async () => {
    const { db } = fourKinds();
    const res = await call({ db, config: cfg({ drafts: true }) }, 'zelos_search', { query: ONLY.item });
    assert.equal(res.error.code, ERROR_CODES.SCOPE_DENIED);
    const row = newest(db);
    assert.equal(row.ok, false);
    assert.equal(row.scope, 'mail.metadata+calendar+board');

    // A tool with one grant still reads as one scope, so the panel's column is
    // unchanged for everything but search.
    await call({ db, config: cfg({ board: true }) }, 'zelos_people', {});
    assert.equal(newest(db).scope, 'people');
  });

  test('an item answered with a draft logs the mail scope the recipient rode in on', async () => {
    /* zelos_drafts reports this exact disclosure as drafts+mail.metadata: the
       recipient and subject are mail metadata that arrived by a different door
       (see draftView). An item whose draft carries them has to say so too, even
       when none of its own mail sources resolved — the address left the
       machine either way, and this row is the only place that says it did. */
    const db = freshDb();
    const itemId = dbm.upsertItem(db, {
      key: 'quarterly-numbers',
      kind: 'money',
      bucket: 'waiting',
      headline: 'Answer the Q3 numbers question',
      sourceRefs: [],
    }, { runId: 'run_1' }).id;
    dbm.upsertDraft(db, { itemId, to: 'boss@company.example', subject: 'Re: Q3 numbers', body: 'On it.' });

    const res = await call({ db, config: cfg({ board: true, drafts: true, 'mail.metadata': true }) },
      'zelos_item', { id: itemId });
    assert.equal(res.result.structuredContent.drafts[0].to, 'boss@company.example',
      'the fixture has to actually disclose a recipient');
    assert.equal(newest(db).scope, 'board+drafts+mail.metadata');

    // Without the mail grant nothing rode along, and the row must not claim it.
    await call({ db, config: cfg({ board: true, drafts: true }) }, 'zelos_item', { id: itemId });
    assert.equal(newest(db).scope, 'board+drafts');

    // A resolved mail source already spends mail.metadata; the draft beside it
    // must not make the row claim the same scope twice.
    const withSource = seeded();
    await call({ db: withSource.db, config: cfg(ALL_ON) }, 'zelos_item', { id: withSource.itemId });
    assert.equal(newest(withSource.db).scope, 'board+mail.metadata+mail.bodies+drafts');
  });

  test('the row is stamped in the configured zone, not the machine\'s', async () => {
    /* The same rule core/server.mjs's recordAskSpend spells out: `nowISO()`
       with no argument reads the MACHINE zone, and for the hours when that
       zone and the configured one sit on different dates, the panel files the
       read under the wrong day. Kiritimati (+14:00) is a zone no machine
       running this suite sits in, so this cannot pass by the two agreeing. */
    const { db } = fourKinds();
    const config = cfg({ board: true });
    config.identity.timezone = 'Pacific/Kiritimati';
    await call({ db, config }, 'zelos_board', {});
    assert.match(newest(db).at, /\+14:00$/, 'the audit row was stamped off the machine clock');
  });
});

/* ================================================================== *
 * The four-item `now` bar
 *
 * The board promises four items in `now`, and that promise is enforced on
 * reads as well as on sweeps: reading the board is what wakes a snooze that has
 * come due, so a fifth `now` item can appear with no sweep anywhere near it.
 * core/server.mjs holds the bar on /api/state for exactly that reason.
 *
 * `zelos_board` did not, and the same database therefore answered four to the
 * app and five to a connected AI. It is the same rule or it is not a rule, so
 * this tool now calls the same `capNowBucket` the server does.
 * ================================================================== */

describe('the board an AI reads is the board the app shows', () => {
  /** Four open `now` items, plus a fifth asleep past its wake-up time. */
  function boardWithADueSnooze() {
    const db = freshDb();
    for (let i = 0; i < 4; i += 1) {
      dbm.upsertItem(db, {
        key: `awake-${i}`,
        kind: 'money',
        bucket: 'now',
        headline: `Open now item ${i}`,
        why: 'it is already on the board',
        severity: 3,
        sourceRefs: [],
      }, { runId: 'run_1' });
    }
    // Lowest severity, so the board's own reading order puts it fifth and the
    // demotion is the one this test can name rather than whichever tied first.
    const fifth = dbm.upsertItem(db, {
      key: 'asleep',
      kind: 'money',
      bucket: 'now',
      headline: 'The one that was asleep',
      why: 'it was snoozed until this morning',
      severity: 1,
      sourceRefs: [],
    }, { runId: 'run_1' }).id;
    dbm.setItemState(db, fifth, 'snoozed', { snoozedUntil: '2020-01-01T09:00:00-05:00' });
    return { db, fifth };
  }

  const openNow = (db) => db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE state = 'open' AND bucket = 'now'").get().n;

  test('REGRESSION: a snooze waking on the read does not put a fifth item on the bar', async () => {
    const { db, fifth } = boardWithADueSnooze();
    assert.equal(openNow(db), 4, 'the fifth is asleep, so the bar starts intact');

    const res = await call({ db, config: cfg({ board: true }) }, 'zelos_board', {});
    const items = res.result.structuredContent.items;

    assert.equal(items.filter((i) => i.bucket === 'now').length, 4,
      'reading the board woke the fifth and handed it over — the app holds this bar on every read');
    assert.equal(openNow(db), 4, 'and the board itself is held, so the app and the AI cannot disagree');

    // Nothing is deleted and no decision of the user's is overruled: the woken
    // item is open, and still theirs to finish, one bucket down.
    const woken = dbm.getItem(db, fifth);
    assert.equal(woken.state, 'open');
    assert.equal(woken.bucket, 'today');
    assert.ok(items.some((i) => i.id === fifth && i.bucket === 'today'), 'and it came back, in its new bucket');
  });

  test('a board that is already inside the bar is left exactly as it was', async () => {
    const { db } = boardWithADueSnooze();
    dbm.setItemState(db, 'nothing-to-wake', 'open'); // no-op; the snoozed one stays asleep
    const before = JSON.stringify(db.prepare('SELECT * FROM items ORDER BY id').all());

    // Four open `now` items and one asleep: the read wakes it, the bar is held,
    // and a second read has nothing left to do.
    await call({ db, config: cfg({ board: true }) }, 'zelos_board', {});
    const settled = JSON.stringify(db.prepare('SELECT * FROM items ORDER BY id').all());
    assert.notEqual(settled, before, 'the first read had a wake and a demotion to do');

    await call({ db, config: cfg({ board: true }) }, 'zelos_board', {});
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM items ORDER BY id').all()), settled,
      'a read of a board already inside the bar must change nothing at all');
  });

  test('the bar is held whatever the caller filtered for', async () => {
    // A caller asking only for `today` still leaves the board held: the wake
    // happens on any read, so the repair cannot be conditional on the filter.
    const { db } = boardWithADueSnooze();
    await call({ db, config: cfg({ board: true }) }, 'zelos_board', { bucket: 'today' });
    assert.equal(openNow(db), 4);
  });

  test('the only thing it takes from the sweep is that one demotion rule', () => {
    const imported = [...MCP_SOURCE.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/sweep\.mjs'/g)]
      .map((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
    assert.deepEqual(imported, [['capNowBucket']],
      'core/mcp.mjs reached further into the sweep than the one rule it is allowed');
    assert.equal(/\bimport\s*\(/.test(MCP_SOURCE), false,
      'a dynamic import is a specifier decided at run time; this file may not have one');
  });
});

test('Zelos sends people to the Settings tab that exists (TT-3431)', async () => {
  /* QA, 2026-10-10: "Settings → AI access" was named to people and, through
     the MCP instructions, to the AI clients on this machine — no tab has that
     name; it is "Share with another AI (advanced)". */
  const { SHARE_SETTINGS } = mcp;
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'ui', 'views', 'settings.js'), 'utf8');
  const tab = /\{ id: 'ai', label: '([^']+)' \}/.exec(settingsSrc)?.[1];
  assert.ok(tab, 'the sharing tab could not be found in settings.js');
  assert.equal(SHARE_SETTINGS, `Settings → ${tab}`);
  // And nothing a person or an AI client reads still names the old one.
  for (const rel of [['core', 'mcp.mjs'], ['core', 'server.mjs']]) {
    const src = fs.readFileSync(path.join(ROOT, ...rel), 'utf8');
    assert.doesNotMatch(src, /Settings → AI access/, `${rel} still names "Settings → AI access"`);
  }
});


test('a client connected while sharing is off is told when it comes on, over stdio (TT-3496)', async () => {
  /* QA, 2026-10-10: the server declared tools.listChanged: false and sent no
     notification, so a client that cached its tool list at connect kept
     "AI access is currently switched OFF … no tools are available" for the
     whole session. A scope switched on later was the same. */
  let current = cfg(ALL_ON, { enabled: false });
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk.toString('utf8'); });
  const server = createStdioServer({ db: null, config: () => current, input, output, watchMs: 10 });
  server.start();
  const messages = () => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 200 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(pred(), `timed out waiting for ${what}`);
  };

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'T', version: '1' } } })}\n`);
  await waitFor(() => messages().some((m) => m.id === 1), 'the handshake');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const init = messages().find((m) => m.id === 1);
  assert.equal(init.result.capabilities.tools.listChanged, true, 'stdio can announce, and should say so');
  assert.match(init.result.instructions, /ask for the tool list again/);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(messages().filter((m) => m.method === 'notifications/tools/list_changed').length, 0, 'announced with nothing changed');

  current = cfg(ALL_ON); // the owner switches sharing on
  await waitFor(() => messages().some((m) => m.method === 'notifications/tools/list_changed'), 'the announcement');

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await waitFor(() => messages().some((m) => m.id === 2), 'the new list');
  assert.ok(messages().find((m) => m.id === 2).result.tools.length > 0, 'the tools are there once asked again');

  const announced = () => messages().filter((m) => m.method === 'notifications/tools/list_changed').length;
  // A change that alters no tool (bodies on/off) is not announced…
  const before = announced();
  current = cfg(ALL_ON_NO_BODIES);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(announced(), before, 'announced a change that alters no tool');
  // …and switching off is.
  current = cfg(ALL_ON, { enabled: false });
  await waitFor(() => announced() === before + 1, 'switching off announced');

  input.end();
  await server.done;
});


test('the config reader re-reads only on a change, and never misses a revocation (TT-3496)', () => {
  /* Idle polling must not re-read (loadConfig renames a half-saved file and
     repeats warnings), but the same reader decides what a request may do — so
     a save with the same size in the same mtime second must still be seen. */
  const { cachedConfigReader } = mcp;
  let clock = 0;
  let loads = 0;
  let st = { ino: 1, mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000, size: 120 };
  let value = { v: 'A' };
  const read = cachedConfigReader({ file: 'x', load: () => { loads += 1; return value; }, now: () => clock, stat: () => st });

  assert.equal(read().v, 'A');
  assert.equal(loads, 1);
  for (let i = 0; i < 20; i += 1) { clock += 2_000; read(); }
  assert.equal(loads, 1 + Math.floor(40_000 / 60_001), 'an idle, unchanged file was read again');

  // Same size, same whole-second mtime — only the inode differs, as an atomic save makes it.
  value = { v: 'B' };
  st = { ...st, ino: 2 };
  clock += 1_500;
  assert.equal(read().v, 'B', 'a same-size save in the same second was missed');

  // An edit in place changes ctime.
  value = { v: 'C' };
  st = { ...st, ctimeMs: st.ctimeMs + 1 };
  clock += 1_500;
  assert.equal(read().v, 'C');

  // And nothing is trusted for longer than a minute.
  value = { v: 'D' };
  clock += 61_000;
  assert.equal(read().v, 'D');
});
