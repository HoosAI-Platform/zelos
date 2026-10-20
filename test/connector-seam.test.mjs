/**
 * test/connector-seam.test.mjs — is the registry a seam, or decoration?
 *
 * test/connectors.test.mjs proved the SWEEP dispatches through
 * core/connectors/index.mjs, by putting a source type the run loop was written
 * before — `rss` — on the board with no branch anywhere naming it. Three
 * surfaces were left holding their own lists after that: the calendar-probe
 * endpoint in core/server.mjs, the kind picker in ui/views/settings.js (which
 * had no surface at all for `config.sources`), and `zelos doctor`, which
 * branched on `calendar.kind` and could not see `config.sources` at all.
 *
 * This file is the proof they no longer do, and it is deliberately not a grep.
 * A test that asserts a file MENTIONS the registry passes just as happily when
 * the import sits above a hardcoded array — that shape has shipped here before.
 * So a connector is REGISTERED at runtime, from this file, and then:
 *
 *   1. it turns up in the Settings picker, in a form built by the real
 *      `sourceForm` against a real (stubbed) DOM, with the fields and the
 *      credential prompt the manifest declared;
 *   2. `validateConfig` accepts a `sources[]` entry naming it, and the registry
 *      stops calling that entry unknown;
 *   3. `zelos doctor` counts it, runs the `check()` it declared, and refuses to
 *      let that check contact an address the user never configured;
 *   4. the server hands it to the UI over /api/connectors, and the calendar
 *      probe accepts a calendar kind that did not exist when it was written.
 *
 * And no file outside core/connectors/ names it — asserted at the bottom,
 * because that sentence is the whole claim.
 *
 * Nothing here touches the real home or the real keychain, and every socket it
 * opens is to 127.0.0.1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ZELOS_LOG_LEVEL = 'silent';
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-seam-'));
process.env.ZELOS_HOME = path.join(SCRATCH, 'home');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');
const fileUrl = (...parts) => pathToFileURL(path.join(...parts)).href;

const registry = await import('../core/connectors/index.mjs');
const { register, describe: describeAll, enabledSources, unknownSources } = registry;
const { validateConfig } = await import('../core/config.mjs');
const { diagnose } = await import('../core/doctor.mjs');
const { todayKey } = await import('../core/time.mjs');

test.after(() => {
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    // Windows can hold a handle on a temp directory for a moment. Litter, not
    // a test result.
    if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
  }
});

/* ------------------------------------------------------------------ *
 * The throwaway connector
 * ------------------------------------------------------------------ */

/**
 * A source type that exists nowhere in the product.
 *
 * "quarry" is chosen for one property: `grep -r quarry core/ ui/` finds nothing,
 * which is what the last test in this file asserts. Rename it and that test
 * still holds, because it reads the name from the constant below.
 */
const KIND = 'quarry';
const CALENDAR_KIND = 'quarrycal';

const throwaway = (over = {}) => ({
  type: KIND,
  family: KIND,
  label: 'Quarry',
  option: 'A quarry board (registered by a test and by nothing else)',
  configKey: 'sources',
  sink: 'messages',
  credential: {
    label: 'Access token',
    help: 'Mint one in your own quarry account; Zelos never creates one for you.',
    url: 'https://quarry.example/settings/tokens',
    required: true,
  },
  origins: [],
  fields: [
    { name: 'url', type: 'url', label: 'Board address', required: true, hint: 'The board you want read.' },
    { name: 'rows', type: 'int', label: 'Rows to keep', default: 25, min: 1, max: 100 },
  ],
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: 100 },
  async collect() { return { parts: [] }; },
  ...over,
});

/** The manifest as the UI receives it: over HTTP, so through JSON. */
const overTheWire = () => JSON.parse(JSON.stringify(describeAll()));

const quarrySource = (over = {}) => ({
  id: 's_quarry',
  enabled: true,
  label: 'The quarry',
  type: KIND,
  keyRef: `${KIND}.s_quarry`,
  settings: { url: 'http://127.0.0.1:1/board', rows: 25 },
  ...over,
});

function baseConfig(over = {}) {
  return {
    version: 1,
    identity: { name: 'Nemo Hale', email: 'nemo@example.com', timezone: 'UTC' },
    model: {
      protocol: 'openai',
      label: 'Test model',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'test-model',
      keyRef: 'model.default',
      maxTokens: 4096,
      temperature: 0,
    },
    mail: [],
    calendars: [],
    sources: [],
    sweep: { intervalMinutes: 30, activeHours: [0, 23], auto: true },
    ui: { accent: '#5b8cff' },
    privacy: { maxItemsPerSweep: 150, sendBodies: true, bodyChars: 4000 },
    ...over,
  };
}

/** Anything network-shaped throws, so a test that reaches one says so loudly. */
const SILENT_DEPS = {
  backend: async () => ({ name: 'macos-keychain', writable: true, note: 'Stored in your login keychain.' }),
  getSecret: async () => null,
  listModels: async () => [{ id: 'test-model', label: 'Test model' }],
  testImap: async () => { throw new Error('testImap should not have been called'); },
  testCalDav: async () => { throw new Error('testCalDav should not have been called'); },
  fetchImpl: async () => { throw new Error('fetch should not have been called'); },
};

const byId = (report, id) => report.checks.find((c) => c.id === id);

async function localServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, port };
}

/* ------------------------------------------------------------------ *
 * Enough DOM to render the real form
 * ------------------------------------------------------------------ */

/**
 * ui/views/settings.js builds nodes through ui/lib/dom.js, which is fifty lines
 * of `createElement` and `textContent` and has no innerHTML path — so "enough
 * DOM" here is genuinely small, and what it renders is the real function rather
 * than a description of it.
 *
 * This is why the picker assertion below is a behaviour test and not a source
 * scan. test/ui.test.mjs's `stubBrowserGlobals` deliberately throws from
 * `createElement` ("these tests must not build DOM") because everything it
 * checks is a pure function; the claim here is about what ends up in a `<select>`
 * and cannot be made any other way.
 */
class StubNode {
  constructor(tag) {
    this.tag = tag;
    this.attributes = {};
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.checked = false;
    this.style = { setProperty() {}, height: '' };
    this.classList = { add() {}, remove() {}, toggle() {} };
  }

  setAttribute(key, value) { this.attributes[key] = String(value); }

  getAttribute(key) { return this.attributes[key] ?? null; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener() {}

  appendChild(child) { this.children.push(child); return child; }

  replaceChildren(...kids) { this.children = kids; }

  remove() {}

  focus() {}

  scrollIntoView() {}

  querySelectorAll() { return []; }

  /** Fire a listener the way a browser would when the user changes a control. */
  fire(type) {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this });
  }
}

function stubDom() {
  if (!globalThis.window) {
    globalThis.window = {
      location: { href: 'http://127.0.0.1:7777/' },
      history: { replaceState() {} },
      addEventListener() {},
    };
  }
  if (!globalThis.sessionStorage) globalThis.sessionStorage = { getItem: () => '', setItem() {}, removeItem() {} };
  if (!globalThis.localStorage) globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  if (!globalThis.Node) globalThis.Node = StubNode;
  if (!globalThis.document) {
    globalThis.document = {
      documentElement: { style: { setProperty() {} } },
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      createElement: (tag) => new StubNode(tag),
      createTextNode: (text) => {
        const node = new StubNode('#text');
        node.textContent = String(text);
        return node;
      },
      body: new StubNode('body'),
    };
  }
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = () => 0;
}

const walk = (node, out = []) => {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
};

/** Every `<option>` in a rendered tree, as {value, label}. */
const optionsIn = (root) => walk(root)
  .filter((n) => n.tag === 'option')
  .map((n) => ({ value: n.attributes.value ?? '', label: n.textContent }));

/** Every visible string in a rendered tree, joined. */
const textIn = (root) => walk(root).map((n) => n.textContent).filter(Boolean).join(' | ');

/** Every href a rendered tree would navigate to. */
const hrefsIn = (root) => walk(root).filter((n) => n.tag === 'a').map((n) => n.attributes.href);

stubDom();
const settings = await import(fileUrl(UI, 'views/settings.js'));
const store = await import(fileUrl(UI, 'lib/store.js'));

/* ================================================================== *
 * 1. The Settings picker
 * ================================================================== */

test('a connector registered at runtime appears in the Settings sources picker, with its own fields and credential', (t) => {
  const off = register(throwaway());
  t.after(off);
  store.state.config = baseConfig();
  store.state.secretRefs = [];

  const form = settings.sourceForm(
    { id: 's_new', enabled: true, label: '', type: '', keyRef: null, settings: {} },
    { manifests: overTheWire(), onSaved() {}, onCancel() {} },
  );

  const picker = optionsIn(form);
  assert.ok(
    picker.some((o) => o.value === KIND),
    `the picker offers ${JSON.stringify(picker.map((o) => o.value))} and not ${KIND} — Settings is reading a list of its own`,
  );
  // The sentence the connector wrote for exactly this control, not one this
  // file's author guessed at.
  assert.ok(picker.some((o) => o.label === throwaway().option), `the picker labels are ${JSON.stringify(picker.map((o) => o.label))}`);
  // `rss` is still there: adding a connector must not replace the list.
  assert.ok(picker.some((o) => o.value === 'rss'));

  /* The rest of the form is the manifest too, and it follows the picker: choose
     the type and `fields[]` becomes controls, `credential.label` becomes the
     prompt, `credential.help` the sentence under it, and `credential.url` a link
     to where a token is minted — none of which any file outside
     core/connectors/ knows about. The form opens on `rss`, whose fields are
     different, so this is a change of body rather than a body that happened to
     be right. */
  const typeSelect = walk(form).find((n) => n.tag === 'select');
  assert.match(textIn(form), /Feed address/, 'the form did not open on the first connector in the picker');
  typeSelect.value = KIND;
  typeSelect.fire('change');

  const shown = textIn(form);
  assert.ok(!/Feed address/.test(shown), 'the previous connector’s fields survived the change of kind');
  assert.match(shown, /Board address/, 'the declared field has no control');
  assert.match(shown, /Rows to keep/);
  assert.match(shown, /Access token/, 'the credential is not asked for by the name the connector gave it');
  assert.match(shown, /Mint one in your own quarry account/);
  assert.deepEqual(hrefsIn(form), ['https://quarry.example/settings/tokens']);
});

test('the Sources panel is reachable, not merely defined', () => {
  /* `config.sources` had a validator, a normaliser, a registry and a run loop
     before it had a screen — so the only way to add one was to hand-edit
     config.json. A panel function that renderSettings never builds is the same
     thing again, one tab strip further on. */
  store.state.config = baseConfig();
  store.state.configErrors = [];
  const view = settings.renderSettings({ sub: 'sources', navigate() {}, rerender() {} });
  const tabs = walk(view).filter((n) => n.attributes.role === 'tab').map((n) => n.textContent);
  // The tab is labelled in words now — "Other things it can read (optional)" —
  // and its route is still `sources`; the label may be reworded again, the
  // panel id below is what the route has to keep.
  assert.ok(tabs.some((t) => /other things it can read/i.test(t)), `the tab strip offers ${tabs.join(', ')}`);

  const panel = walk(view).find((n) => n.attributes.role === 'tabpanel');
  assert.ok(panel, 'the selected tab controls nothing');
  assert.equal(panel.attributes.id, 'settings-panel-sources');
  assert.match(textIn(panel), /Add a source/, 'the Sources tab renders somebody else’s panel');
});

test('the calendar kind picker is the registry too, and a kindless connector is offered no password', (t) => {
  const off = register(throwaway({
    type: CALENDAR_KIND,
    family: 'calendar',
    label: 'Calendar',
    option: 'A quarry calendar (registered by a test and by nothing else)',
    configKey: 'calendars',
    sink: 'events',
    credential: null,
    fields: [],
  }));
  t.after(off);
  store.state.config = baseConfig();
  store.state.secretRefs = [];

  const form = settings.calendarForm(
    { id: 'c_new', enabled: true, label: '', kind: '', url: '', user: '', keyRef: null },
    { manifests: overTheWire(), onSaved() {}, onCancel() {} },
  );

  // The kind picker's own options: the form has a second select now — the
  // password picker in the sign-in block (TT-3425) — whose three choices are
  // not calendar kinds. Found by what it offers, not by where it sits.
  const picker = optionsIn(walk(form).find((n) => n.tag === 'select'
    && optionsIn(n).some((o) => o.value === 'caldav')));
  assert.deepEqual(
    picker.map((o) => o.value),
    ['ics', 'caldav', 'file', CALENDAR_KIND],
    'the calendar picker is not the registry’s calendars list',
  );

  /* And the credential half of the form follows the manifest as well. The
     picker opens on `ics`, which declares a password; switching to a connector
     with `credential: null` must remove the username AND the password rather
     than merely mark them optional — core/connectors/file.mjs is the case that
     makes this matter, and this form used to ask for a username and a password
     to read a path on the user's own disk. */
  assert.match(textIn(form), /Username/);
  const kindSelect = walk(form).find((n) => n.tag === 'select');
  kindSelect.value = CALENDAR_KIND;
  kindSelect.fire('change');
  const after = textIn(form);
  assert.ok(!/Username/.test(after), `a connector with no credential is still being asked for one: ${after}`);
  assert.match(after, /needs no username and no password/);
});

/* ================================================================== *
 * 2. Config validation, and what the registry claims
 * ================================================================== */

test('config accepts a source naming a connector it has never heard of, and the registry stops calling it unknown', (t) => {
  const config = baseConfig({ sources: [quarrySource()] });

  /* Before registration the entry is valid — core/config.mjs validates the
     envelope and leaves the payload to the registry, deliberately, because it
     cannot import the registry without a cycle — and the registry reports it as
     naming nothing. */
  assert.deepEqual(validateConfig(config), { ok: true, errors: [] });
  assert.deepEqual(unknownSources(config).map((u) => [u.at, u.id, u.type]), [['sources', 's_quarry', KIND]]);
  assert.deepEqual(enabledSources(config).map(({ source }) => source.id), []);

  const off = register(throwaway());
  t.after(off);

  // After it, the same entry is a source the sweep will read, and nothing calls
  // it unknown. No file was edited between these two assertions.
  assert.deepEqual(validateConfig(config), { ok: true, errors: [] });
  assert.deepEqual(unknownSources(config), []);
  assert.deepEqual(
    enabledSources(config).map(({ connector, source }) => [connector.type, source.id]),
    [[KIND, 's_quarry']],
  );
});

/* ================================================================== *
 * 3. zelos doctor
 * ================================================================== */

test('doctor counts a runtime-registered source, runs the check it declared, and reports what came back', async (t) => {
  const off = register(throwaway({
    async check(source, ctx) {
      const res = await ctx.http.get(source.settings.url);
      return { status: 'pass', detail: `the quarry answered ${res.status}` };
    },
  }));
  t.after(off);

  const board = await localServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"rows":[]}');
  });

  const report = await diagnose({
    config: baseConfig({ sources: [quarrySource({ settings: { url: `${board.origin}/board`, rows: 25 } })] }),
    deps: { ...SILENT_DEPS, getSecret: async () => 'a-quarry-token', fetchImpl: (...args) => globalThis.fetch(...args) },
  });

  const line = byId(report, 'source.s_quarry');
  assert.ok(line, `doctor reported no line for this source: ${report.checks.map((c) => c.id).join(', ')}`);
  assert.equal(line.status, 'pass', line.detail);
  assert.equal(line.label, 'Quarry · The quarry', 'the line is titled from the manifest');
  assert.match(line.detail, /the quarry answered 200/, 'doctor did not run the connector’s own check');

  /* And the count `ready` is built from. It used to be `mail` plus `calendars`,
     written before `sources` existed — so an install whose only source is a feed
     was told it was not ready and sent to look at ! lines about mail it had
     deliberately never connected. */
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status === 'fail'), null, 2));
  assert.equal(report.ready, true, 'a model and one source are configured, and the source answered');
});

test('doctor hands a check the user\'s zone, and a now read in it', async (t) => {
  /* `checkContext` handed over neither, so the two checks that count "overdue"
     (Linear, Todoist) fell back to the machine's clock in the machine's zone —
     the one-day error their sweep paths exist to prevent, printed in the one
     command a stuck person runs. The sweep builds `ctx.now` with `nowISO(tz)`
     from `identity.timezone`; this pins doctor to the same pair. Niue has no
     DST, so its offset is −11:00 on every day this can run. */
  const NIUE = 'Pacific/Niue';
  const seen = [];
  const off = register(throwaway({
    async check(source, ctx) {
      seen.push({ now: ctx.now, timezone: ctx.timezone });
      return { status: 'pass', detail: 'recorded' };
    },
  }));
  t.after(off);

  await diagnose({
    config: baseConfig({
      identity: { name: 'Nemo Hale', email: 'nemo@example.com', timezone: NIUE },
      sources: [quarrySource()],
    }),
    deps: { ...SILENT_DEPS, getSecret: async () => 'a-quarry-token' },
  });

  assert.equal(seen.length, 1, 'doctor did not run the check');
  assert.equal(seen[0].timezone, NIUE, 'identity.timezone never reached the check');
  assert.match(String(seen[0].now), /-11:00$/, `\`now\` is not read in ${NIUE}: ${seen[0].now}`);
  assert.equal(String(seen[0].now).slice(0, 10), todayKey(NIUE), 'the day `now` names is not the day in that zone');
});

test("doctor's check runs on the transport, so it cannot contact an address the user never configured", async (t) => {
  const elsewhere = [];
  const other = await localServer(t, (req, res) => { elsewhere.push(req.url); res.writeHead(200); res.end('{}'); });
  const off = register(throwaway({
    async check(source, ctx) {
      // The address a payload named, rather than the one the user typed.
      const res = await ctx.http.get(`${other.origin}/exfiltrate`);
      return { status: 'pass', detail: `contacted ${res.status}` };
    },
  }));
  t.after(off);

  const report = await diagnose({
    config: baseConfig({ sources: [quarrySource({ settings: { url: 'http://127.0.0.1:1/board', rows: 25 } })] }),
    deps: { ...SILENT_DEPS, getSecret: async () => 'a-quarry-token', fetchImpl: (...args) => globalThis.fetch(...args) },
  });

  const line = byId(report, 'source.s_quarry');
  assert.equal(line.status, 'fail', line.detail);
  assert.match(line.detail, /not one of this source's addresses/);
  assert.ok(line.action, 'a failure with nothing to do is not a diagnosis');
  assert.deepEqual(elsewhere, [], 'doctor opened a connection to a host the user never typed');
});

test('doctor asks for the credential the connector named, and for the settings it declared required', async (t) => {
  const off = register(throwaway());
  t.after(off);

  const noToken = await diagnose({
    config: baseConfig({ sources: [quarrySource()] }),
    deps: SILENT_DEPS,
  });
  const missingSecret = byId(noToken, 'source.s_quarry');
  assert.equal(missingSecret.status, 'fail', missingSecret.detail);
  assert.match(missingSecret.detail, /access token/i, 'the credential is not named in the words the connector used');
  assert.match(missingSecret.action, /Mint one in your own quarry account/);
  assert.match(missingSecret.action, /quarry\.example/, 'the place a token is minted is the one thing the user needs');

  const noUrl = await diagnose({
    config: baseConfig({ sources: [quarrySource({ settings: { rows: 25 } })] }),
    deps: { ...SILENT_DEPS, getSecret: async () => 'a-quarry-token' },
  });
  const missingField = byId(noUrl, 'source.s_quarry');
  assert.equal(missingField.status, 'fail', missingField.detail);
  assert.match(missingField.detail, /board address/i, 'the required field is not named');
  assert.ok(missingField.action.includes('Board address'));
});

test('REGRESSION: doctor sends a GitHub Enterprise user to their own server to mint a token', async () => {
  /* credential.url is github.com's. A user whose API address is their own
     server minted a token there that their server had never heard of. */
  const report = await diagnose({
    config: baseConfig({ sources: [{
      id: 's_ghe', enabled: true, label: 'Work GitHub', type: 'github', keyRef: 'github.s_ghe',
      settings: { apiBase: 'https://ghe.corp.example/api/v3' },
    }] }),
    deps: SILENT_DEPS,
  });
  const line = byId(report, 'source.s_ghe');
  assert.equal(line.status, 'fail', line.detail);
  assert.match(line.action, /https:\/\/ghe\.corp\.example\/settings\/tokens/);
  assert.doesNotMatch(line.action, /https:\/\/github\.com/);
});

test('doctor asks a calendar connector for its own probe instead of branching on the kind', async (t) => {
  const off = register(throwaway({
    type: CALENDAR_KIND,
    family: 'calendar',
    label: 'Calendar',
    option: 'A quarry calendar (registered by a test and by nothing else)',
    configKey: 'calendars',
    sink: 'events',
    credential: null,
    fields: [],
    async check(source) {
      return { status: 'warn', detail: `the quarry calendar answered about ${source.url}`, action: 'Nothing, this is a test.' };
    },
  }));
  t.after(off);

  /* `fetchImpl` throws, so the old `if (kind === 'file') … if (kind === 'caldav')
     … else fetch the .ics` would land here as "fetch should not have been
     called" rather than as this connector's own verdict. */
  const report = await diagnose({
    config: baseConfig({
      calendars: [{ id: 'c_q', enabled: true, label: 'Blasting', kind: CALENDAR_KIND, url: 'https://cal.example/q.ics', user: '', keyRef: null }],
    }),
    deps: SILENT_DEPS,
  });

  const line = byId(report, 'calendar.c_q');
  assert.ok(line, `doctor reported no line for this calendar: ${report.checks.map((c) => c.id).join(', ')}`);
  assert.equal(line.status, 'warn', line.detail);
  assert.match(line.detail, /the quarry calendar answered about/, 'doctor did not run the connector’s own check');
  assert.equal(line.action, 'Nothing, this is a test.');
});

test('doctor names an entry no connector claims, which is why one could be invisible before', async () => {
  const orphan = await diagnose({
    config: baseConfig({ sources: [quarrySource({ label: 'The quarry', type: 'runes' })] }),
    deps: SILENT_DEPS,
  });
  const line = byId(orphan, 'sources.unknown');
  assert.ok(line, `nothing reported the orphan: ${orphan.checks.map((c) => c.id).join(', ')}`);
  assert.equal(line.status, 'fail', line.detail);
  assert.match(line.detail, /The quarry/, 'the entry is not named');
  assert.match(line.detail, /runes/, 'the type nobody claims is not named');
  assert.match(line.detail, /s_quarry/, 'the id is what a person edits config.json by');
  assert.ok(line.action);
  assert.equal(orphan.ok, false, 'a source that will never be read is broken, not merely worth knowing');

  // Switched off is not broken: a source deliberately parked must not nag.
  const parked = await diagnose({
    config: baseConfig({ sources: [quarrySource({ type: 'runes', enabled: false })] }),
    deps: SILENT_DEPS,
  });
  assert.equal(byId(parked, 'sources.unknown'), undefined);
});

/* ================================================================== *
 * 4. The server
 * ================================================================== */

test('the server hands the UI every connector this build has, and the calendar probe accepts a kind it never heard of', async (t) => {
  const off = register(throwaway({
    type: CALENDAR_KIND,
    family: 'calendar',
    label: 'Calendar',
    option: 'A quarry calendar (registered by a test and by nothing else)',
    configKey: 'calendars',
    sink: 'events',
    credential: null,
    fields: [],
  }));
  t.after(off);

  const { createServer, listen } = await import('../core/server.mjs');
  const db = await import('../core/db.mjs');
  const { loadConfig } = await import('../core/config.mjs');

  const handle = db.open(':memory:');
  db.migrate(handle);
  const server = createServer({ db: handle, config: loadConfig() });
  const { port } = await listen(server, { port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close(handle);
  });
  const call = (method, route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'X-Zelos-Token': server.sessionToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));

  // The manifest reaches the UI. `ui/` cannot import core/, so this route is the
  // only way the Settings picker can know a connector exists at all.
  const listed = await call('GET', '/api/connectors');
  assert.equal(listed.status, 200);
  const mine = listed.json.connectors.find((c) => c.type === CALENDAR_KIND);
  assert.ok(mine, `the route offered ${listed.json.connectors.map((c) => c.type).join(', ')}`);
  assert.equal(mine.configKey, 'calendars');
  assert.equal(mine.credential, null);
  // No functions survive the wire, which is what makes this renderable at all.
  for (const value of Object.values(mine)) assert.notEqual(typeof value, 'function');

  const ics = await localServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Quarry',
      'BEGIN:VEVENT', 'UID:1@zelos', 'DTSTART:20260811T180000Z', 'DTEND:20260811T190000Z',
      'SUMMARY:Blast', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n'));
  });

  /* The endpoint used to test `['ics', 'caldav', 'file'].includes(kind)`, so a
     calendar connector added to core/connectors/ was unreachable from the only
     button that tests one until somebody edited an HTTP handler. */
  const probed = await call('POST', '/api/calendar/test', { kind: CALENDAR_KIND, url: `${ics.origin}/quarry.ics` });
  assert.equal(probed.status, 200, `the probe refused a registered calendar kind: ${JSON.stringify(probed.json)}`);
  assert.equal(probed.json.ok, true, probed.json.error);
  assert.equal(probed.json.events, 1);

  // A kind nothing claims is still refused, and the refusal names the real list.
  const refused = await call('POST', '/api/calendar/test', { kind: 'runes', url: `${ics.origin}/quarry.ics` });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, new RegExp(`ics, caldav, file or ${CALENDAR_KIND}`));
});

/* ================================================================== *
 * 5. The claim itself
 * ================================================================== */

const sourceFiles = (dir) => {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist']);
  const walkDir = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
    }
  };
  walkDir(dir);
  return out;
};

test('no file outside core/connectors/ names the connector these tests registered', () => {
  const offenders = [];
  for (const file of [...sourceFiles(path.join(ROOT, 'core')), ...sourceFiles(UI)]) {
    if (file.startsWith(path.join(ROOT, 'core', 'connectors'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const name of [KIND, CALENDAR_KIND]) {
      if (src.includes(name)) offenders.push(`${path.relative(ROOT, file)} names "${name}"`);
    }
  }
  assert.deepEqual(offenders, [], `everything above passed because a production file knows this type:\n  ${offenders.join('\n  ')}`);
});

test('nothing in production registers a connector at runtime', () => {
  /* `register()` is the hinge this whole file turns on, and it is also the one
     way the static import list in core/connectors/index.mjs could be quietly
     escaped — a computed registration is invisible to test/repo.test.mjs's
     import scanner, which is the guard behind the zero-dependency claim. */
  const offenders = [];
  for (const file of [...sourceFiles(path.join(ROOT, 'core')), ...sourceFiles(UI)]) {
    if (file === path.join(ROOT, 'core', 'connectors', 'index.mjs')) continue;
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/\bregister\s*\(/.test(src)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `these call register() outside the registry:\n  ${offenders.join('\n  ')}`);
});
