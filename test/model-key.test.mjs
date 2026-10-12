/**
 * test/model-key.test.mjs — a model key belongs to the address it was saved for.
 *
 * TT-3417: one slot, `model.default`, held the key for whichever AI service was
 * chosen, so a Claude key went to OpenAI the moment OpenAI was picked. These
 * pin the two halves of the fix: the ref is derived from the destination, and a
 * pre-upgrade key is moved to the configured address — once, lazily, and never
 * to an address it plainly is not for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ZELOS_LOG_LEVEL = 'silent';
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file'; // never the real keychain
process.env.ZELOS_HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-model-key-')), 'home');

const { modelKeyRef, modelKeyDestination, readModelKey, isModelKeyRef, LEGACY_MODEL_REF } = await import('../core/model-key.mjs');
const { isValidRef } = await import('../core/config.mjs');
const { runSweep } = await import('../core/sweep.mjs');
const db = await import('../core/db.mjs');

/** An in-memory secret store with the three calls readModelKey uses. */
function memoryStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getSecret: async (ref) => values.get(ref) ?? null,
    setSecret: async (ref, value) => { values.set(ref, value); return { ok: true }; },
    deleteSecret: async (ref) => ({ deleted: values.delete(ref) }),
  };
}

test('the same destination, however it is spelled, has one ref', () => {
  const same = [
    ['https://api.anthropic.com', 'https://API.Anthropic.com/', 'https://api.anthropic.com:443', ' https://api.anthropic.com// ', 'https://user:pw@api.anthropic.com'],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1/', 'http://0x7f.1:11434/v1'],
    ['https://bücher.example/v1', 'https://xn--bcher-kva.example/v1'],
  ];
  for (const group of same) {
    const refs = new Set(group.map(modelKeyRef));
    assert.equal(refs.size, 1, `${group.join(' · ')} should share a ref`);
  }
});

test('different destinations never share a ref', () => {
  const addresses = [
    'https://api.anthropic.com',
    'https://api.openai.com/v1',
    'http://api.anthropic.com', // the scheme counts: no key in the clear
    'https://api.anthropic.com:8443',
    'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic', // gateways route by path
    'https://gateway.ai.cloudflare.com/v1/acct/gw/openai',
    'https://proxy:8443',
    'https://proxy_8443',
    'http://[::1]:8080/v1',
    'http://--1:8080/v1',
  ];
  const refs = addresses.map(modelKeyRef);
  assert.equal(new Set(refs).size, addresses.length);
  for (const ref of refs) {
    assert.match(ref, /^model\.o_[0-9a-f]{32}$/);
    assert.ok(isValidRef(ref), ref);
    assert.ok(isModelKeyRef(ref));
  }
});

test('anything that is not an http address has no key slot', () => {
  for (const value of [undefined, null, '', '   ', 42, 'localhost:1234', 'api.anthropic.com', 'file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'https://']) {
    assert.equal(modelKeyRef(value), null, String(value));
    assert.equal(modelKeyDestination(value), null, String(value));
  }
});

test('only the model namespace counts as a model ref', () => {
  for (const ref of ['model', 'model.default', 'model.o_abc']) assert.equal(isModelKeyRef(ref), true, ref);
  for (const ref of ['mail.m_1', 'calendar.c_1', 'models.x', 'modelx', '', null, undefined]) assert.equal(isModelKeyRef(ref), false, String(ref));
});

test('a key is read only for the address it was saved for', async () => {
  const anthropic = 'https://api.anthropic.com';
  const store = memoryStore({ [modelKeyRef(anthropic)]: 'sk-ant-saved' });
  const deps = { ...store, configuredBaseUrl: 'https://api.openai.com/v1' };
  assert.equal(await readModelKey(anthropic, deps), 'sk-ant-saved');
  assert.equal(await readModelKey('https://api.openai.com/v1', deps), null);
  assert.equal(await readModelKey('http://api.anthropic.com', deps), null);
  assert.equal(await readModelKey('not an address', deps), null);
});

test('a pre-upgrade key moves to the configured address, and only on a read of it', async () => {
  const configured = 'https://llm.example.com/v1';
  const store = memoryStore({ [LEGACY_MODEL_REF]: 'sk-custom' });
  const deps = { ...store, configuredBaseUrl: configured };

  // A read of some other address neither moves nor returns it.
  assert.equal(await readModelKey('https://api.openai.com/v1', deps), null);
  assert.equal(store.values.get(LEGACY_MODEL_REF), 'sk-custom');

  assert.equal(await readModelKey(`${configured}/`, deps), 'sk-custom');
  assert.equal(store.values.get(modelKeyRef(configured)), 'sk-custom');
  assert.equal(store.values.has(LEGACY_MODEL_REF), false, 'the old slot must be emptied, or it follows the next service chosen');

  // Choosing another service afterwards finds nothing to borrow.
  assert.equal(await readModelKey('https://api.openai.com/v1', { ...store, configuredBaseUrl: 'https://api.openai.com/v1' }), null);
});

test('a pre-upgrade key on a LAN address that needs one is kept for it', async () => {
  const configured = 'http://192.168.1.5:4000/v1';
  const store = memoryStore({ [LEGACY_MODEL_REF]: 'sk-litellm' });
  assert.equal(await readModelKey(configured, { ...store, configuredBaseUrl: configured }), 'sk-litellm');
  assert.equal(store.values.get(modelKeyRef(configured)), 'sk-litellm');
});

test('a key this bug already sent to the wrong service goes back to the one it belongs to', async () => {
  // A Claude key with OpenAI chosen: kept for Anthropic, not filed as OpenAI's.
  const openai = 'https://api.openai.com/v1';
  const store = memoryStore({ [LEGACY_MODEL_REF]: 'sk-ant-api03-claude' });
  assert.equal(await readModelKey(openai, { ...store, configuredBaseUrl: openai }), null);
  assert.equal(store.values.get(modelKeyRef('https://api.anthropic.com')), 'sk-ant-api03-claude');
  assert.equal(store.values.has(modelKeyRef(openai)), false);
  assert.equal(store.values.has(LEGACY_MODEL_REF), false);

  // A gateway in front of Anthropic is given a Claude key on purpose; it keeps it.
  const gateway = 'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic';
  const viaGateway = memoryStore({ [LEGACY_MODEL_REF]: 'sk-ant-api03-claude' });
  assert.equal(await readModelKey(gateway, { ...viaGateway, configuredBaseUrl: gateway }), 'sk-ant-api03-claude');

  // OpenAI's `sk-` prefix is shared too widely to say anything.
  const deepseek = 'https://api.deepseek.com/v1';
  const shared = memoryStore({ [LEGACY_MODEL_REF]: 'sk-proj-something' });
  assert.equal(await readModelKey(deepseek, { ...shared, configuredBaseUrl: deepseek }), 'sk-proj-something');
});

test('a move that copied and then failed to delete is finished on the next read', async () => {
  const configured = 'https://api.anthropic.com';
  const store = memoryStore({ [LEGACY_MODEL_REF]: 'sk-ant-k', [modelKeyRef(configured)]: 'sk-ant-k' });
  assert.equal(await readModelKey(configured, { ...store, configuredBaseUrl: configured }), 'sk-ant-k');
  assert.equal(store.values.has(LEGACY_MODEL_REF), false);
});

test('a different key already saved for the address wins, and the old one is left, not thrown away', async () => {
  const anthropic = 'https://api.anthropic.com';
  const openai = 'https://api.openai.com/v1';
  const store = memoryStore({ [LEGACY_MODEL_REF]: 'sk-ant-old', [modelKeyRef(anthropic)]: 'sk-ant-new' });
  assert.equal(await readModelKey(openai, { ...store, configuredBaseUrl: openai }), null);
  assert.equal(store.values.get(modelKeyRef(anthropic)), 'sk-ant-new');
  assert.equal(store.values.get(LEGACY_MODEL_REF), 'sk-ant-old');
});

test('without write access to the store, a pre-upgrade key is neither moved nor returned', async () => {
  const configured = 'https://llm.example.com/v1';
  const store = memoryStore({ [LEGACY_MODEL_REF]: 'sk-custom' });
  assert.equal(await readModelKey(configured, { getSecret: store.getSecret, configuredBaseUrl: configured }), null);
  assert.equal(store.values.get(LEGACY_MODEL_REF), 'sk-custom');
});

test('a sweep sends the key saved for its address, and no other', async () => {
  const handle = db.open(':memory:');
  db.migrate(handle);
  const saved = 'https://api.anthropic.com';
  const store = memoryStore({ [modelKeyRef(saved)]: 'sk-ant-saved', [LEGACY_MODEL_REF]: 'sk-ant-legacy' });
  const seen = [];
  const config = {
    identity: { name: 'T', email: 't@example.com', timezone: 'UTC' },
    model: { protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', label: 'OpenAI', maxTokens: 100, temperature: 0, keyRef: 'model.default' },
    mail: [], calendars: [], sources: [],
    sweep: { intervalMinutes: 30, activeHours: [0, 24], auto: false },
    privacy: { maxItemsPerSweep: 10, sendBodies: false, bodyChars: 100 },
  };
  await runSweep({
    db: handle, config, mode: 'full',
    deps: { getSecret: store.getSecret, complete: async (request) => { seen.push(request.apiKey); throw new Error('stop'); } },
  }).catch(() => {});
  // OpenAI is configured and only an Anthropic key is saved: the model is
  // asked with no key at all (and refuses), never with Anthropic's.
  assert.deepEqual(seen, [null], 'a sweep sent another service\'s key');
  handle.close();
});

test('a source configured with a model ref is refused, not handed the key', async () => {
  const handle = db.open(':memory:');
  db.migrate(handle);
  const store = memoryStore({ 'model.default': 'sk-ant-legacy' });
  const asked = [];
  const result = await runSweep({
    db: handle,
    config: {
      identity: { name: 'T', email: 't@example.com', timezone: 'UTC' },
      model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', label: 'Local', maxTokens: 100, temperature: 0 },
      mail: [],
      calendars: [{ id: 'c_borrow', kind: 'ics', label: 'Borrower', url: 'https://calendar.example.invalid/x.ics', user: 'x', keyRef: 'model.default', enabled: true }],
      sources: [],
      sweep: { intervalMinutes: 30, activeHours: [0, 24], auto: false },
      privacy: { maxItemsPerSweep: 10, sendBodies: false, bodyChars: 100 },
    },
    mode: 'refresh',
    deps: {
      getSecret: async (ref) => { asked.push(ref); return store.getSecret(ref); },
      fetchEvents: async ({ pass }) => { assert.notEqual(pass, 'sk-ant-legacy', 'the calendar was handed the AI key'); return []; },
    },
  });
  assert.ok(!asked.includes('model.default'), 'the sweep read the AI key for a calendar');
  const row = result.stats.sources.find((s) => s.id === 'c_borrow');
  assert.ok(row && row.ok === false && /AI service's key/.test(row.error), JSON.stringify(row));
  handle.close();
});

test('no code reads a secret through config.model.keyRef', () => {
  // Every model key read goes through readModelKey(), for the address about to
  // be contacted. `model.keyRef` is written down for older versions only; a
  // read through it is how one service's key reached another.
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const files = ['zelos.mjs', ...fs.readdirSync(path.join(root, 'core'), { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => path.join('core', f)),
    ...fs.readdirSync(path.join(root, 'desktop')).filter((f) => f.endsWith('.js')).map((f) => path.join('desktop', f))];
  const offenders = files.filter((file) => /(?:getSecret|secretFor)\([^)]*model\??\.keyRef/.test(fs.readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(offenders, []);
});
