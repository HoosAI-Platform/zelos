import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-secret-homes-'));
process.env.ZELOS_HOME = path.join(scratch, 'initial');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
const { describeCommand, setSecret, getSecret, deleteSecret, listRefs, resetBackendCache } = await import('../core/secrets.mjs');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function useHome(name) {
  process.env.ZELOS_HOME = path.join(scratch, name);
  fs.mkdirSync(process.env.ZELOS_HOME, { recursive: true });
  resetBackendCache();
  return process.env.ZELOS_HOME;
}

function addresses() {
  return ['macos-keychain', 'libsecret', 'windows-dpapi'].map((name) => {
    const command = describeCommand({ name, action: 'get', ref: 'model.default' });
    return name === 'windows-dpapi' ? command.env.ZELOS_SECRET_FILE : command.args.at(-1);
  });
}

test('independent homes have distinct OS credential identities which survive moving a home', (t) => {
  const priorLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(scratch, 'os-store');
  t.after(() => { if (priorLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = priorLocal; });
  const first = useHome('identity-personal');
  const personal = addresses();
  useHome('identity-work');
  const work = addresses();
  for (let i = 0; i < personal.length; i++) assert.notEqual(personal[i], work[i]);
  useHome('identity-personal');
  assert.deepEqual(addresses(), personal, 'restarting must keep the same identities');
  const moved = path.join(scratch, 'identity-moved');
  fs.renameSync(first, moved);
  process.env.ZELOS_HOME = moved;
  resetBackendCache();
  assert.deepEqual(addresses(), personal, 'moving the existing home must retain access');
});

test('a damaged credential namespace is reported without replacing it', () => {
  const home = useHome('damaged-namespace');
  const file = path.join(home, 'secrets.namespace.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => addresses(), /namespace/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

const needsExecutableStub = process.platform === 'win32'
  ? 'the fake secret-tool is a POSIX executable; backend address separation is tested on every OS'
  : false;

function fakeKeyring(t, name, { gateLegacy = false } = {}) {
  const directory = path.join(scratch, name);
  fs.mkdirSync(directory);
  const database = path.join(directory, 'keyring.json');
  const file = path.join(directory, 'secret-tool');
  fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--audit-stub') { console.log('isolated-keyring'); process.exit(0); }
const file = ${JSON.stringify(database)};
const gate = ${JSON.stringify(gateLegacy)};
const started = ${JSON.stringify(path.join(directory, 'legacy-read-started'))};
const released = ${JSON.stringify(path.join(directory, 'legacy-read-released'))};
const mutation = ${JSON.stringify(path.join(directory, 'mutation-started'))};
let entries = {}; try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const key = args[args.indexOf('service') + 1] + '|' + args[args.indexOf('account') + 1];
if (args[0] === 'store') {
  entries[key] = fs.readFileSync(0, 'utf8').replace(/\\n$/, '');
  fs.writeFileSync(file, JSON.stringify(entries));
  if (entries[key] === 'replacement-test-key') fs.writeFileSync(mutation, 'set');
} else if (args[0] === 'lookup') {
  if (!(key in entries)) process.exit(1);
  if (gate && key === 'com.zelos.app|model.default') {
    fs.writeFileSync(started, 'reading');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(released) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (!fs.existsSync(released)) process.exit(2);
  }
  console.log(entries[key]);
} else if (args[0] === 'clear') {
  fs.writeFileSync(mutation, 'delete');
  if (!(key in entries)) process.exit(1);
  delete entries[key]; fs.writeFileSync(file, JSON.stringify(entries));
} else process.exit(2);
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = directory + path.delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file'; resetBackendCache(); });
  assert.equal(spawnSync('secret-tool', ['--audit-stub'], { encoding: 'utf8' }).stdout.trim(), 'isolated-keyring',
    'prove the fake binary is selected before allowing any credential operation');
  process.env.ZELOS_SECRETS_BACKEND = 'libsecret';
  resetBackendCache();
  return database;
}

test('saving and deleting the same ref in a new home never reads or changes another home', { skip: needsExecutableStub }, async (t) => {
  fakeKeyring(t, 'separate-keyring');
  useHome('personal');
  await setSecret('model.default', 'personal-test-key');
  useHome('work');
  assert.equal(await getSecret('model.default'), null);
  assert.deepEqual(await deleteSecret('model.default'), { ok: true, deleted: false });
  await setSecret('model.default', 'work-test-key');
  useHome('personal');
  assert.equal(await getSecret('model.default'), 'personal-test-key');
  useHome('work');
  await deleteSecret('model.default');
  assert.deepEqual(await listRefs(), []);
  useHome('personal');
  assert.equal(await getSecret('model.default'), 'personal-test-key');
  assert.deepEqual(await listRefs(), ['model.default']);
});

test('legacy indexed credentials remain readable until an explicit scoped save, without changing another legacy home', { skip: needsExecutableStub }, async (t) => {
  const database = fakeKeyring(t, 'legacy-keyring');
  fs.writeFileSync(database, JSON.stringify({ 'com.zelos.app|model.default': 'legacy-test-key' }));
  for (const name of ['legacy-personal', 'legacy-work']) {
    const home = useHome(name);
    fs.writeFileSync(path.join(home, 'secrets.index.json'), JSON.stringify({ refs: ['model.default'] }));
  }
  useHome('legacy-personal');
  assert.deepEqual(await listRefs(), ['model.default']);
  assert.equal(await getSecret('model.default'), 'legacy-test-key');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(database, 'utf8'))), ['com.zelos.app|model.default'],
    'legacy compatibility reads must not write a scoped replacement');
  await setSecret('model.default', 'personal-replacement');
  useHome('legacy-work');
  assert.equal(await getSecret('model.default'), 'legacy-test-key');
  await deleteSecret('model.default');
  assert.equal(await getSecret('model.default'), null, 'a deletion must not resurrect the legacy ref');
  useHome('legacy-personal');
  assert.equal(await getSecret('model.default'), 'personal-replacement');
  assert.equal(JSON.parse(fs.readFileSync(database, 'utf8'))['com.zelos.app|model.default'], 'legacy-test-key');
  useHome('unrelated-new-home');
  assert.equal(await getSecret('model.default'), null, 'new homes never inherit legacy credentials');
});

test('a damaged legacy index cannot create an empty migration record, and restoring it recovers access', { skip: needsExecutableStub }, async (t) => {
  const database = fakeKeyring(t, 'damaged-index-keyring');
  const home = useHome('damaged-index-home');
  const index = path.join(home, 'secrets.index.json');
  const namespace = path.join(home, 'secrets.namespace.json');
  fs.writeFileSync(database, JSON.stringify({ 'com.zelos.app|model.default': 'legacy-test-key' }));
  fs.writeFileSync(index, '{corrupt');
  await assert.rejects(getSecret('model.default'), /index/i);
  assert.equal(fs.existsSync(namespace), false, 'do not permanently record an empty legacy ref list');
  assert.equal(fs.readFileSync(index, 'utf8'), '{corrupt', 'leave the damaged index available for recovery');
  fs.writeFileSync(index, JSON.stringify({ refs: ['model.default'] }));
  assert.equal(await getSecret('model.default'), 'legacy-test-key');
  assert.deepEqual(await listRefs(), ['model.default']);
});

for (const action of ['set', 'delete']) {
  test(`a ${action} queued during a legacy read preserves the newest credential state`, { skip: needsExecutableStub }, async (t) => {
    const database = fakeKeyring(t, `race-${action}-keyring`, { gateLegacy: true });
    const home = useHome(`race-${action}-home`);
    fs.writeFileSync(database, JSON.stringify({ 'com.zelos.app|model.default': 'legacy-test-key' }));
    fs.writeFileSync(path.join(home, 'secrets.index.json'), JSON.stringify({ refs: ['model.default'] }));
    const directory = path.dirname(database);
    const released = path.join(directory, 'legacy-read-released');
    const waitFor = async (file, milliseconds) => {
      const deadline = Date.now() + milliseconds;
      while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      return fs.existsSync(file);
    };
    const read = getSecret('model.default');
    assert.equal(await waitFor(path.join(directory, 'legacy-read-started'), 3000), true);
    const change = action === 'set'
      ? setSecret('model.default', 'replacement-test-key')
      : deleteSecret('model.default');
    // Without serialization the mutation reaches the backend while the old
    // value is held above. With serialization it queues, so release after the
    // bounded wait and let the queued mutation follow the read.
    await waitFor(path.join(directory, 'mutation-started'), 1000);
    fs.writeFileSync(released, 'continue');
    await Promise.all([read, change]);
    assert.equal(await getSecret('model.default'), action === 'set' ? 'replacement-test-key' : null);
  });

  test(`a ${action} in another process is not overwritten by an older legacy read`, { skip: needsExecutableStub }, async (t) => {
    const database = fakeKeyring(t, `process-race-${action}-keyring`, { gateLegacy: true });
    const home = useHome(`process-race-${action}-home`);
    fs.writeFileSync(database, JSON.stringify({ 'com.zelos.app|model.default': 'legacy-test-key' }));
    fs.writeFileSync(path.join(home, 'secrets.index.json'), JSON.stringify({ refs: ['model.default'] }));
    const directory = path.dirname(database);
    const started = path.join(directory, 'legacy-read-started');
    const released = path.join(directory, 'legacy-read-released');
    const read = getSecret('model.default');
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(fs.existsSync(started), true, 'hold the old read before the other process changes the key');
    let change;
    try {
      const script = `
        const { setSecret, deleteSecret } = await import(${JSON.stringify(new URL('../core/secrets.mjs', import.meta.url).href)});
        ${action === 'set' ? "await setSecret('model.default', 'replacement-test-key');" : "await deleteSecret('model.default');"}
      `;
      change = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
    } finally {
      fs.writeFileSync(released, 'continue');
    }
    await read;
    assert.equal(change.status, 0, change.stderr || change.error?.message);
    assert.equal(await getSecret('model.default'), action === 'set' ? 'replacement-test-key' : null);
    assert.equal(JSON.parse(fs.readFileSync(database, 'utf8'))['com.zelos.app|model.default'], 'legacy-test-key',
      'other legacy homes keep their shared key');
  });
}

/* A home restored onto another computer (TT-3438). DPAPI needs no binary to
   answer "is it saved?" — that is a file check — so these force the backend
   and point %LOCALAPPDATA% at a scratch folder instead of the real profile. */
function fakeDpapi(t, name, { local = 'empty', refs = ['model.default'], legacyRefs = [] } = {}) {
  const priorLocal = process.env.LOCALAPPDATA;
  t.after(() => {
    if (priorLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = priorLocal;
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
    resetBackendCache();
  });
  const localAppData = path.join(scratch, `${name}-localappdata`);
  if (local === 'unset') delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = localAppData;
  if (local === 'empty') fs.mkdirSync(localAppData);
  process.env.ZELOS_SECRETS_BACKEND = 'windows-dpapi';
  const home = useHome(name);
  // The namespace is written before the index so that it records exactly the
  // legacy refs each case asks for, not every indexed ref.
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(home, 'secrets.namespace.json'), JSON.stringify({ version: 1, id, legacyRefs }));
  const index = path.join(home, 'secrets.index.json');
  fs.writeFileSync(index, JSON.stringify({ refs }));
  return { home, id, index, localAppData, indexText: fs.readFileSync(index, 'utf8') };
}

test('a DPAPI home restored onto another computer lists none of the keys it cannot read, and keeps them indexed', async (t) => {
  const { index, indexText } = fakeDpapi(t, 'dpapi-restored');
  assert.deepEqual(await listRefs(), [], 'a key this computer has never stored must not show as saved');
  assert.equal(fs.readFileSync(index, 'utf8'), indexText,
    'hidden, not forgotten: pointing %LOCALAPPDATA% back at the right profile must find the keys again');
});

for (const local of ['unset', 'missing']) {
  test(`a DPAPI home whose %LOCALAPPDATA% is ${local} still lists its keys, because that is the wrong address, not an empty store`, async (t) => {
    const { index, indexText } = fakeDpapi(t, `dpapi-local-${local}`, { local });
    assert.deepEqual(await listRefs(), ['model.default']);
    assert.equal(fs.readFileSync(index, 'utf8'), indexText);
  });
}

test('a restored DPAPI home still lists a key it can read from the older unscoped store', async (t) => {
  const { localAppData } = fakeDpapi(t, 'dpapi-restored-legacy', { legacyRefs: ['model.default'] });
  fs.mkdirSync(path.join(localAppData, 'Zelos', 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(localAppData, 'Zelos', 'secrets', 'model.default.dpapi'), '00');
  assert.deepEqual(await listRefs(), ['model.default']);
});

test('a DPAPI home with blobs in its own fallback folder keeps listing them once %LOCALAPPDATA% is set', async (t) => {
  // Saved on a launch without %LOCALAPPDATA%: those keys belong to this
  // account, so their absence from the real profile is not "on another computer".
  const { home, id, index, indexText } = fakeDpapi(t, 'dpapi-fallback-folder');
  fs.mkdirSync(path.join(home, 'dpapi', 'Zelos', 'secrets', id), { recursive: true });
  assert.deepEqual(await listRefs(), ['model.default']);
  assert.equal(fs.readFileSync(index, 'utf8'), indexText);
});

test('a restored DPAPI home keeps an older key indexed when another home has stored keys on this computer', async (t) => {
  // <LOCALAPPDATA>\Zelos\secrets exists because some other home saved there,
  // so the older unscoped store answers "not here" for model.default. That is
  // not proof the key was deleted: this home has never stored anything on this
  // computer, so its key is as absent-here as any other.
  const { localAppData, index, indexText } = fakeDpapi(t, 'dpapi-restored-shared', { legacyRefs: ['model.default'] });
  fs.mkdirSync(path.join(localAppData, 'Zelos', 'secrets', crypto.randomBytes(16).toString('hex')), { recursive: true });
  assert.deepEqual(await listRefs(), []);
  assert.equal(fs.readFileSync(index, 'utf8'), indexText, 'a key this pass never saw deleted must stay indexed');
});

test('a key missing on this computer does not stop listRefs asking about the keys after it', async (t) => {
  // mail.m_1 has no blob anywhere here; model.default comes after it and is
  // readable from the older unscoped store. An unanswered probe would leave
  // model.default listed anyway, so the proof is that its blob was looked for.
  const { localAppData } = fakeDpapi(t, 'dpapi-order', {
    refs: ['mail.m_1', 'model.default'], legacyRefs: ['model.default'],
  });
  const legacyBlob = path.join(localAppData, 'Zelos', 'secrets', 'model.default.dpapi');
  fs.mkdirSync(path.dirname(legacyBlob), { recursive: true });
  fs.writeFileSync(legacyBlob, '00');
  // Listed either way — a probed 'yes' and an unprobed 'unknown' look the
  // same from outside — so prove the legacy blob was actually looked for.
  const exists = t.mock.method(fs, 'existsSync');
  assert.deepEqual(await listRefs(), ['model.default']);
  assert.ok(exists.mock.calls.some((call) => call.arguments[0] === legacyBlob),
    'model.default was listed without being asked about');
});

test('reading a DPAPI key with no blob answers null without starting PowerShell', { skip: needsExecutableStub }, async (t) => {
  fakeDpapi(t, 'dpapi-no-spawn');
  const directory = path.join(scratch, 'dpapi-no-spawn-bin');
  fs.mkdirSync(directory);
  const spawned = path.join(directory, 'spawned');
  fs.writeFileSync(path.join(directory, 'powershell.exe'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(spawned)}, 'ran');\nprocess.exit(44);\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = directory + path.delimiter + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  assert.equal(await getSecret('model.default'), null);
  assert.equal(fs.existsSync(spawned), false, 'a missing file is already the answer');
});
