import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-secrets-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const secrets = await import('../core/secrets.mjs');
const {
  backend, setSecret, getSecret, deleteSecret, listRefs,
  describeCommand, ensureNamespace, resetBackendCache, chooseBackend, SERVICE,
  TIMEOUTS_MS, ATTEMPTS, setTimeoutsForTest,
} = secrets;

const mode = (p) => fs.statSync(p).mode & 0o777;

/**
 * POSIX modes are the whole at-rest story on macOS and Linux, and Windows does
 * not implement them: fs.chmod there sets little more than the read-only flag,
 * and fs.stat reports a synthesised 0666 no matter what Zelos asked for. A
 * `0600` assertion on Windows would therefore succeed or fail for reasons that
 * have nothing to do with the guarantee it exists to protect, so the mode
 * claims are split out and skipped there by name rather than being weakened for
 * every platform to accommodate one. docs/SECURITY.md §5 and §7 say the same
 * thing to the user: on Windows the protection of the fallback store is its
 * encryption, not its mode.
 *
 * node:test prints this string as the reason, so a reader of the Windows run
 * learns why the gap is there instead of finding a silent hole.
 */
const WINDOWS_NO_POSIX_MODES = process.platform === 'win32'
  ? 'POSIX modes are not implemented on Windows: chmod sets little more than the read-only flag, so this could not assert what it claims (docs/SECURITY.md §5)'
  : false;

function useHome(name) {
  process.env.ZELOS_HOME = path.join(HOME_ROOT, name);
  resetBackendCache();
}

function forceFallback(name) {
  useHome(name);
  process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
  resetBackendCache();
}

function unforce() {
  delete process.env.ZELOS_SECRETS_BACKEND;
  resetBackendCache();
}

test.after(() => {
  delete process.env.ZELOS_SECRETS_BACKEND;
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ------------------------------------------------------- argv containment */

test('no command line can carry a secret — describeCommand never receives one', () => {
  // A scoped address needs the home's credential identity, which only a save
  // creates; describeCommand itself never writes one.
  ensureNamespace();
  // The structural guarantee: the only function that builds argv takes a
  // backend, an action and a ref. There is no parameter a value could ride in.
  assert.equal(describeCommand.length, 1);
  const arg = describeCommand.toString().match(/\(\s*\{([^}]*)\}/)[1];
  assert.match(arg, /name/);
  assert.match(arg, /action/);
  assert.match(arg, /ref/);
  assert.ok(!/value|password|secret/i.test(arg), `describeCommand takes no value: ${arg}`);

  for (const name of ['macos-keychain', 'windows-dpapi', 'libsecret', 'encrypted-file']) {
    for (const action of ['set', 'get', 'has', 'delete']) {
      const desc = describeCommand({ name, action, ref: 'mail.m_9f3a1c' });
      if (!desc) continue;
      for (const a of desc.args) {
        assert.equal(typeof a, 'string');
        assert.ok(!/hunter2/.test(a));
      }
      assert.ok(desc.args.some((arg) => /^[0-9a-f]{32}\.mail\.m_9f3a1c$/.test(arg)) || name === 'windows-dpapi');
    }
  }
});

test('macOS argv matches the spec, and the value is written to stdin twice', () => {
  ensureNamespace();
  const set = describeCommand({ name: 'macos-keychain', action: 'set', ref: 'model.default' });
  assert.equal(set.file, '/usr/bin/security');
  const account = set.args[set.args.indexOf('-a') + 1];
  assert.match(account, /^[0-9a-f]{32}\.model\.default$/);
  assert.deepEqual(set.args, ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w']);
  assert.equal(set.args.at(-1), '-w', 'nothing may follow -w');
  // security prompts "password data" AND "retype password"; one write leaves an
  // empty password stored with exit code 0.
  assert.equal(set.stdinWrites, 2);

  const get = describeCommand({ name: 'macos-keychain', action: 'get', ref: 'model.default' });
  assert.deepEqual(get.args, ['find-generic-password', '-g', '-s', SERVICE, '-a', account]);
  assert.equal(get.stdinWrites, 0);
  assert.equal(get.stderrSafe, false, '-g prints the password on stderr; it must never be logged');

  assert.equal(describeCommand({ name: 'macos-keychain', action: 'delete', ref: 'model.default' }).args[0], 'delete-generic-password');
  assert.throws(() => describeCommand({ name: 'macos-keychain', action: 'exfiltrate', ref: 'model.default' }), TypeError);
  assert.throws(() => describeCommand({ name: 'macos-keychain', action: 'get', ref: '../../etc/passwd' }), TypeError);
});

test('Windows DPAPI passes an encoded script and the path by env, never the value', () => {
  ensureNamespace();
  const set = describeCommand({ name: 'windows-dpapi', action: 'set', ref: 'mail.m_1' });
  assert.equal(set.file, 'powershell.exe');
  assert.ok(set.args.includes('-NoProfile') && set.args.includes('-NonInteractive'));
  const script = Buffer.from(set.args[set.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  // The value arrives on stdin, and the script decodes those bytes as UTF-8
  // itself. Reading through [Console]::In instead would decode with whatever
  // code page the machine's locale sets, which round-trips by accident on a
  // single-byte locale and corrupts non-ASCII on a Japanese or Chinese one.
  assert.match(script, /OpenStandardInput\(\)/, 'the value arrives on stdin');
  assert.match(script, /UTF8\.GetString/, 'and is decoded as UTF-8 rather than by locale');
  assert.ok(!/\[Console\]::In\b/.test(script), 'Console.In would inherit the console code page');
  assert.match(script, /ConvertFrom-SecureString/);
  assert.ok(!/-Key\b/.test(script), 'CurrentUser DPAPI scope, not a hardcoded key');
  assert.match(set.env.ZELOS_SECRET_FILE, /Zelos[\\/]secrets[\\/][0-9a-f]{32}[\\/]mail\.m_1\.dpapi$/);
  assert.equal(set.stdinWrites, 1);

  const get = describeCommand({ name: 'windows-dpapi', action: 'get', ref: 'mail.m_1' });
  const getScript = Buffer.from(get.args.at(-1), 'base64').toString('utf16le');
  assert.match(getScript, /SecureStringToBSTR/);
  // Same argument in the other direction: the value leaves as UTF-8 bytes.
  assert.match(getScript, /UTF8\.GetBytes/, 'the value is encoded as UTF-8 on the way out');
  assert.ok(!/\[Console\]::Out\b/.test(getScript), 'Console.Out would use the console code page');
  assert.equal(describeCommand({ name: 'windows-dpapi', action: 'delete', ref: 'mail.m_1' }), null);
});

test('libsecret argv matches secret-tool, value on stdin', () => {
  ensureNamespace();
  const set = describeCommand({ name: 'libsecret', action: 'set', ref: 'mail.m_2' });
  const account = set.args.at(-1);
  assert.match(account, /^[0-9a-f]{32}\.mail\.m_2$/);
  assert.deepEqual(set.args, ['store', '--label=Zelos', 'service', SERVICE, 'account', account]);
  assert.equal(set.stdinWrites, 1);
  assert.deepEqual(describeCommand({ name: 'libsecret', action: 'get', ref: 'mail.m_2' }).args,
    ['lookup', 'service', SERVICE, 'account', account]);
  assert.deepEqual(describeCommand({ name: 'libsecret', action: 'delete', ref: 'mail.m_2' }).args,
    ['clear', 'service', SERVICE, 'account', account]);
});

test('the module exposes no way to enumerate values', () => {
  const exported = Object.keys(secrets).sort();
  for (const forbidden of ['listSecrets', 'getAllSecrets', 'dumpSecrets', 'exportSecrets', 'allSecrets']) {
    assert.ok(!exported.includes(forbidden), `${forbidden} must not exist`);
  }
  assert.ok(exported.includes('listRefs'));
});

/* ------------------------------------------------ encrypted-file fallback */

test('encrypted-file fallback: honest note, real round-trip', async () => {
  forceFallback('fallback');
  const home = process.env.ZELOS_HOME;

  const b = await backend();
  assert.equal(b.name, 'encrypted-file');
  assert.equal(b.writable, true);
  assert.match(b.note, /AES-256-GCM/);
  assert.match(b.note, /does NOT protect against a process already running as this user/);

  const value = 'sk-ant-api03-Ω-"quoted"-\\slash-hunter2';
  await setSecret('model.default', value);
  assert.equal(await getSecret('model.default'), value);

  const store = path.join(home, 'secrets.enc');
  const seed = path.join(home, '.seed');
  assert.match(fs.readFileSync(seed, 'utf8').trim(), /^[0-9a-f]{64}$/);

  const raw = fs.readFileSync(store, 'utf8');
  assert.ok(!raw.includes('hunter2'), 'plaintext must not appear in the store');
  assert.ok(!raw.includes('sk-ant'), 'plaintext must not appear in the store');
  const env = JSON.parse(raw);
  assert.equal(env.kdf.name, 'scrypt');
  assert.equal(env.kdf.N, 32768);
  assert.match(env.kdf.salt, /^[0-9a-f]{32}$/);
  assert.match(env.iv, /^[0-9a-f]{24}$/);
  assert.match(env.tag, /^[0-9a-f]{32}$/);

  await setSecret('mail.m_9f3a1c', 'imap-password');
  assert.deepEqual(await listRefs(), ['mail.m_9f3a1c', 'model.default']);
  assert.equal(await getSecret('model.default'), value, 'a second secret does not disturb the first');

  await setSecret('model.default', 'replaced');
  assert.equal(await getSecret('model.default'), 'replaced');

  assert.deepEqual(await deleteSecret('model.default'), { ok: true, deleted: true });
  assert.equal(await getSecret('model.default'), null);
  assert.deepEqual(await listRefs(), ['mail.m_9f3a1c']);
  assert.deepEqual(await deleteSecret('model.default'), { ok: true, deleted: false });
});

test('encrypted-file fallback: the store and the seed are 0600', { skip: WINDOWS_NO_POSIX_MODES }, async () => {
  // The seed matters as much as the store: it is the key, it sits beside the
  // ciphertext, and a mode that let another account read it would give away
  // everything the encryption was protecting.
  forceFallback('fallback-modes');
  const home = process.env.ZELOS_HOME;
  await setSecret('model.default', 'sk-ant-api03-mode-check');

  assert.equal(mode(path.join(home, 'secrets.enc')), 0o600);
  assert.equal(mode(path.join(home, '.seed')), 0o600);
});

test('encrypted-file fallback: a tampered ciphertext fails closed', async () => {
  forceFallback('tampered');
  const home = process.env.ZELOS_HOME;
  await setSecret('model.default', 'original-value');

  const file = path.join(home, 'secrets.enc');
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ct = Buffer.from(env.ct, 'base64');
  ct[0] ^= 0xff; // flip a bit: GCM must reject it, not hand back garbage
  fs.writeFileSync(file, JSON.stringify({ ...env, ct: ct.toString('base64') }));

  assert.equal(await getSecret('model.default'), null);
  const aside = fs.readdirSync(home).filter((f) => f.startsWith('secrets.enc.unreadable-'));
  assert.equal(aside.length, 1, 'the unreadable ciphertext is preserved, not deleted');

  // The user can carry on: a fresh store is written on the next set.
  await setSecret('model.default', 'new-value');
  assert.equal(await getSecret('model.default'), 'new-value');
});

test('encrypted-file fallback: a lost seed cannot be brute-forced from the file', async () => {
  forceFallback('seedless');
  await setSecret('model.default', 'value-behind-the-seed');
  const home = process.env.ZELOS_HOME;
  const before = fs.readFileSync(path.join(home, 'secrets.enc'), 'utf8');

  fs.rmSync(path.join(home, '.seed'));
  assert.equal(await getSecret('model.default'), null, 'no seed, no plaintext');
  const aside = fs.readdirSync(home).find((f) => f.startsWith('secrets.enc.unreadable-'));
  assert.equal(fs.readFileSync(path.join(home, aside), 'utf8'), before, 'the old ciphertext is kept as-is');
});

/**
 * The trap this catches: minting a seed was a side effect of reading one.
 * `machineSeed()` wrote a replacement over a `.seed` it could not parse, and it
 * ran from inside `readEncryptedStore()` — so a plain `getSecret()` destroyed
 * the key, and the ciphertext was then filed away under the comment "if the
 * seed turns up, it is still recoverable". The seed was never turning up again.
 *
 * Nothing deliberate is needed to get there. This test uses a sync client's
 * conflict append, which leaves all 64 hex characters intact on the first line;
 * a stray leading byte, an appended NUL or a duplicated line do the same. And
 * the callers are the worst possible ones: the background sweep reads a
 * credential every cycle, and so does `zelos doctor` — the thing a user runs
 * when they suspect something is wrong.
 */
test('encrypted-file fallback: a damaged .seed is set aside, never written over', async () => {
  forceFallback('damaged-seed');
  const home = process.env.ZELOS_HOME;
  const value = 'value-behind-a-damaged-seed';
  await setSecret('model.default', value);

  const seedPath = path.join(home, '.seed');
  const storePath = path.join(home, 'secrets.enc');
  const originalSeed = fs.readFileSync(seedPath, 'utf8');
  const originalStore = fs.readFileSync(storePath, 'utf8');

  fs.writeFileSync(seedPath, `${originalSeed}<<<<<<< conflicted copy\n${'f'.repeat(64)}\n`);

  // One ordinary read. This is a sweep, or a doctor run, not a user decision.
  assert.equal(await getSecret('model.default'), null, 'a seed that cannot be parsed cannot decrypt anything');

  const asideSeed = fs.readdirSync(home).filter((f) => f.startsWith('.seed.unreadable-'));
  assert.equal(asideSeed.length, 1,
    'the damaged .seed must be kept — the 64 hex characters in it are the only key the ciphertext beside it has');
  assert.equal(fs.readFileSync(path.join(home, asideSeed[0]), 'utf8').split('\n')[0], originalSeed.trim(),
    'and kept byte for byte, so the real seed can be picked out of it');
  assert.equal(fs.existsSync(seedPath), false, 'reading must not mint a replacement seed');

  const asideStore = fs.readdirSync(home).filter((f) => f.startsWith('secrets.enc.unreadable-'));
  assert.equal(asideStore.length, 1);
  assert.equal(fs.readFileSync(path.join(home, asideStore[0]), 'utf8'), originalStore);
  assert.equal(asideSeed[0].slice('.seed'.length), asideStore[0].slice('secrets.enc'.length),
    'the two carry one timestamp, so whoever has to recover them can see they are a pair');

  // The proof that nothing was lost: salvage the hex, put the ciphertext back,
  // and the secret reads. This is the recovery the old code made impossible.
  fs.writeFileSync(seedPath, originalSeed);
  fs.renameSync(path.join(home, asideStore[0]), storePath);
  assert.equal(await getSecret('model.default'), value);
});

/**
 * #25: detection is a probe, and a probe is a guess about this instant. Before
 * the record, one wrong guess sent every credential written for the rest of the
 * process into `secrets.enc`, the next launch guessed right, and the keychain
 * item it read was the OLD one — a rotated password ignored with nothing on
 * screen to explain it.
 *
 * `chooseBackend` is exercised directly because `detect()` cannot be: an
 * unforced probe on this machine is the operator's own login keychain, which
 * the gate further down exists to keep the suite away from. The decision is
 * pure and takes its platform as an argument, so every combination is reachable
 * from any OS without going near a real store.
 */
test('encrypted-file fallback: the store a home committed to is recorded, and a probe cannot move it', async () => {
  forceFallback('backend-record');
  const home = process.env.ZELOS_HOME;
  await setSecret('model.default', 'sk-ant-api03-committed');

  const recordFile = path.join(home, 'secrets.backend.json');
  const text = fs.readFileSync(recordFile, 'utf8');
  assert.deepEqual(JSON.parse(text), { backend: 'encrypted-file' }, 'the first successful write commits the home to a store');
  assert.ok(!text.includes('sk-ant'), 'the record holds a backend name and nothing else');

  assert.equal(chooseBackend({ probed: 'encrypted-file', recorded: null, platform: 'darwin' }), 'encrypted-file',
    'a home with no history follows the probe');
  assert.equal(chooseBackend({ probed: 'macos-keychain', recorded: 'macos-keychain', platform: 'darwin' }), 'macos-keychain');

  // The downgrade: `security` times out once, or a sandbox refuses the spawn.
  assert.equal(chooseBackend({ probed: 'encrypted-file', recorded: 'macos-keychain', platform: 'darwin' }), 'macos-keychain',
    'a probe that failed for a moment must not start a second store in secrets.enc');
  // The same defect pointing the other way, and the worse of the two: a home
  // whose secrets are in secrets.enc must not silently start reading a keychain
  // it has never written to, where a stale item would answer in their place.
  assert.equal(chooseBackend({ probed: 'macos-keychain', recorded: 'encrypted-file', platform: 'darwin' }), 'encrypted-file');
  assert.equal(chooseBackend({ probed: 'libsecret', recorded: 'encrypted-file', platform: 'linux' }), 'encrypted-file');

  // A record naming a store this platform does not have is a home that moved
  // machines — a migration, not a flaky probe.
  assert.equal(chooseBackend({ probed: 'libsecret', recorded: 'macos-keychain', platform: 'linux' }), 'libsecret');
  assert.equal(chooseBackend({ probed: 'encrypted-file', recorded: 'windows-dpapi', platform: 'darwin' }), 'encrypted-file');
  // encrypted-file exists everywhere, so it is never discarded as foreign.
  assert.equal(chooseBackend({ probed: 'macos-keychain', recorded: 'encrypted-file', platform: 'win32' }), 'encrypted-file');
});

/**
 * The other half of #25, and the half nothing was holding down: `chooseBackend`
 * is pure and thoroughly checked above, and `detect()` is what has to CALL it.
 * Removing the record lookup from `detect()` — `return probed`, three lines
 * gone — left all 1025 tests green on every platform, because every test that
 * exercises the reconciliation goes in through `chooseBackend` directly and no
 * test ever plants a record that disagrees with a probe.
 *
 * There are three shapes below and not one, because the expression has two
 * halves and a test that pins only "the record wins" pins only one of them.
 * Measured on this suite: `const chosen = probed` fails the first assertion,
 * and `const chosen = recorded ?? probed` — the record winning even where it
 * cannot possibly be right — passed all 21 tests until the third was added. A
 * home carried from a Mac to a Linux box records `macos-keychain`, and under
 * that mutation every credential read on the new machine spawns
 * /usr/bin/security, which is not there.
 *
 * `detect()` cannot be reached in-process, and that is not an accident: an
 * unforced probe on this machine is the operator's own login keychain, which
 * the guard in test/repo.test.mjs exists to keep the suite away from. So the
 * probe runs in a child, where three things can be arranged that cannot be
 * arranged here:
 *
 *   - `process.platform` is pinned to 'linux' before core/secrets.mjs is
 *     loaded, so `probeBackend` takes the secret-tool branch on every host.
 *     /usr/bin/security and powershell.exe are unreachable from that branch,
 *     which is what makes this safe to run on a developer's Mac.
 *   - PATH is a directory with nothing in it, so `secret-tool` is not found and
 *     the probe lands on 'encrypted-file' for a reason this test chose.
 *   - the environment is BUILT without ZELOS_SECRETS_BACKEND rather than having
 *     it deleted, so no process that could reach a real store is ever unforced.
 *
 * What is left is exactly the disagreement: a home that says one thing and a
 * probe that says another.
 */
const SECRETS_URL = new URL('../core/secrets.mjs', import.meta.url).href;

/**
 * Run `script` in a child that believes it is Linux, with `pathDir` as its
 * whole PATH, and hand back whatever JSON it printed.
 *
 * Split out of `detectInChild` below rather than duplicated, because the
 * timeout tests further down need the same three arrangements and a second
 * copy of them is a second place for the ZELOS_SECRETS_BACKEND scrub to be
 * forgotten. `detectInChild` keeps its exact signature and answer.
 */
function askTheChild({ home, pathDir, body, env: extra = {} }) {
  const script = [
    "Object.defineProperty(process, 'platform', { value: 'linux' });",
    `const secrets = await import(${JSON.stringify(SECRETS_URL)});`,
    body,
  ].join('\n');

  const { ZELOS_SECRETS_BACKEND: _, ...inherited } = process.env;
  const env = {
    ...inherited, ZELOS_HOME: home, ZELOS_LOG_LEVEL: 'silent', ...extra,
  };
  // Windows keeps this variable under the name `Path`, and writing a second
  // one called `PATH` into a child's block is asking for trouble. It does not
  // need scrubbing there anyway: `secret-tool` is a Linux binary and the child
  // only pretends to be Linux.
  if (process.platform !== 'win32') env.PATH = pathDir;

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, `the probe child failed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

function detectInChild({ home, pathDir }) {
  return askTheChild({
    home,
    pathDir,
    body: 'process.stdout.write(JSON.stringify(await secrets.backend()));',
  }).name;
}

test('detect() honours the store a home is committed to, even when the probe disagrees', async (t) => {
  const nowhere = path.join(HOME_ROOT, 'nothing-on-path');
  fs.mkdirSync(nowhere, { recursive: true });

  const committed = path.join(HOME_ROOT, 'reconcile-keyring');
  fs.mkdirSync(committed, { recursive: true });
  fs.writeFileSync(path.join(committed, 'secrets.backend.json'), JSON.stringify({ backend: 'libsecret' }));

  assert.equal(detectInChild({ home: committed, pathDir: nowhere }), 'libsecret',
    'the probe found no keyring and the record says the secrets are in one; starting a second store in '
    + 'secrets.enc is how a password typed this afternoon disappears behind the one typed last month');

  // The same disagreement pointing the other way, which is the worse of the
  // two: a home whose secrets are in secrets.enc must not begin reading a
  // keyring it has never written to, where a stale item answers in their place.
  // This one needs a probe that SUCCEEDS, so a stub stands in for secret-tool.
  await t.test('and a probe that succeeds does not move a home off its file store', { skip: NEEDS_A_SHELL_STUB }, () => {
    const binDir = path.join(HOME_ROOT, 'reconcile-stub-bin');
    installSecretToolStub(binDir);
    const home = path.join(HOME_ROOT, 'reconcile-file');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'secrets.backend.json'), JSON.stringify({ backend: 'encrypted-file' }));

    // Proof the stub is what the child will find, before anything is concluded
    // from the answer: without this, "encrypted-file" would also be what a
    // child that found no secret-tool at all would say.
    assert.equal(detectInChild({ home: path.join(HOME_ROOT, 'reconcile-probe-only'), pathDir: binDir }), 'libsecret',
      'the stub was not on the child\'s PATH, so the assertion below would prove nothing');

    assert.equal(detectInChild({ home, pathDir: binDir }), 'encrypted-file');
  });

  // The third shape, and the one that says `detect()` consults the whole of
  // `chooseBackend` rather than just "a record beats a probe": a record naming a
  // store this platform does not have is a home that moved machines. The child
  // is pinned to Linux, so a `macos-keychain` record is unreachable from it, and
  // honouring it would send every read of every credential to a
  // /usr/bin/security that is not on this machine — a dead app, where following
  // the probe costs one re-entered password.
  const migrated = path.join(HOME_ROOT, 'reconcile-migrated');
  fs.mkdirSync(migrated, { recursive: true });
  fs.writeFileSync(path.join(migrated, 'secrets.backend.json'), JSON.stringify({ backend: 'macos-keychain' }));

  assert.equal(detectInChild({ home: migrated, pathDir: nowhere }), 'encrypted-file',
    'a record naming a store that cannot exist on this platform is a migration, not a flaky probe — '
    + 'pinning the home to it makes every credential read spawn a binary that is not there');
});

test('refs and values are validated before anything is spawned', async () => {
  forceFallback('validation');
  await assert.rejects(() => setSecret('../etc/passwd', 'x'), TypeError);
  await assert.rejects(() => setSecret('has space', 'x'), TypeError);
  await assert.rejects(() => setSecret('model.default', ''), TypeError);
  await assert.rejects(() => setSecret('model.default', 42), TypeError);
  await assert.rejects(() => setSecret('model.default', 'has\0nul'), TypeError);
  await assert.rejects(() => getSecret('nope!'), TypeError);
  await assert.rejects(() => deleteSecret('nope!'), TypeError);
});

/* ------------------------------------------ a keyring that will not answer */

/**
 * libsecret is the one external backend a test can drive without touching
 * anything real: `secret-tool` is resolved through PATH, so a stub in front of
 * it answers every call, and forcing the backend means detection never runs
 * either. macOS and Linux both execute a `#!/bin/sh` script; Windows does not,
 * and would not find an extensionless file on PATH to begin with.
 */
const NEEDS_A_SHELL_STUB = process.platform === 'win32'
  ? 'this test puts a #!/bin/sh stub for secret-tool on PATH, which Windows cannot execute'
  : false;

/**
 * Two modes and a log were added for the timeout tests below, and both are
 * additive: with ZELOS_STUB_LOG and ZELOS_STUB_ONCE unset the script behaves
 * exactly as it did, so the test above is unchanged.
 *
 *  - `hang` never answers, which is the only way to reach `run()`'s timer with
 *    a real subprocess. `sleep 5` rather than something longer because a
 *    SIGKILL to the shell leaves the sleep behind as an orphan, and a suite
 *    should not litter a machine with half-minute processes.
 *  - `hang-once` hangs the FIRST time and then behaves as ZELOS_STUB_AFTER,
 *    which is what makes "the retry" something the stub can distinguish. The
 *    marker file is the only state a `#!/bin/sh` stub can keep between spawns.
 *  - ZELOS_STUB_LOG collects one line per invocation, so a test can count
 *    attempts instead of trusting that a retry happened.
 *
 * The `--zelos-stub` self-identification stays ahead of the log, so the proof
 * that the stub is what PATH resolves to does not appear in the count.
 */
function installSecretToolStub(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'secret-tool');
  fs.writeFileSync(file, `${[
    '#!/bin/sh',
    '# Stands in for secret-tool. ZELOS_STUB_MODE picks what the keyring says.',
    'if [ "$1" = "--zelos-stub" ]; then echo zelos-stub; exit 0; fi',
    'if [ -n "$ZELOS_STUB_LOG" ]; then echo "$*" >> "$ZELOS_STUB_LOG"; fi',
    'mode="${ZELOS_STUB_MODE:-found}"',
    'if [ "$mode" = "hang-once" ]; then',
    '  if [ -f "$ZELOS_STUB_ONCE" ]; then mode="${ZELOS_STUB_AFTER:-found}"; else : > "$ZELOS_STUB_ONCE"; mode=hang; fi',
    'fi',
    'case "$mode" in',
    '  found)   echo found-a-value; exit 0 ;;',
    '  missing) exit 1 ;;',
    '  dbus)    echo "Cannot autolaunch D-Bus without X11" >&2; exit 1 ;;',
    '  crash)   echo boom >&2; exit 3 ;;',
    /* Two things this one line has to get right, both measured here.
       `/bin/sleep` by absolute path, because the probe children below run with
       a stripped PATH holding this stub and nothing else: a bare `sleep` is not
       found, the case falls straight through, and the stub answers exit 0 —
       a healthy keyring, reported by the stub written to be an unhealthy one.
       And `exec`, so the shell BECOMES the sleep: without it, run()'s SIGKILL
       kills the shell and leaves the sleep holding the stdio pipes it
       inherited, which keeps the calling process alive until the sleep ends.
       Measured: a 250 ms timeout took 5,832 ms to be observed. If exec fails
       the shell exits 126/127, which no branch of core/secrets.mjs reads as
       anything good. */
    '  hang)    exec /bin/sleep 5 ;;',
    'esac',
  ].join('\n')}\n`, { mode: 0o755 });
  return file;
}

/** How many times the stub was actually spawned. */
function stubCalls(logFile) {
  if (!fs.existsSync(logFile)) return 0;
  return fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim()).length;
}

/**
 * Prove the stub is what `secret-tool` resolves to, and warm it while we are
 * here. Both halves matter and the second one is not a micro-optimisation.
 *
 * The stub writes its log line after the shell has started, and a `hang` spawn
 * is racing a SIGKILL from the caller's timeout — so a shell that is slow to
 * reach its first statement is a spawn that happened and was never counted.
 * Measured on this machine: shell-start-to-first-write is 3–9 ms warm, even
 * under six busy cores, but 277 ms cold. Four copies of this file running at
 * once undercounted by exactly one spawn, four times out of four, against a
 * 250 ms budget. Which is the same cold-start effect the module's retry exists
 * for, arriving in the test that measures it.
 */
function proveAndWarmStub(file = 'secret-tool') {
  const proof = spawnSync(file, ['--zelos-stub'], { encoding: 'utf8' });
  assert.equal(proof.stdout?.trim(), 'zelos-stub',
    `${file} did not identify itself as the stub. Called by name, that means "secret-tool" resolves to `
    + 'something else and everything below would be talking to a real keyring; called by path, it means the '
    + 'stub is not runnable at all.');
}

/**
 * #24: `hasSecret` was a boolean, so "the keyring did not answer" and "the user
 * deleted it" were the same answer, and `listRefs()` wrote the shrunken list
 * back. One locked keyring, one unlock prompt answered slower than the 15s
 * timeout, one D-Bus hiccup, and `secrets.index.json` was emptied permanently.
 *
 * What made it so quiet is that nothing appeared to break: the values are still
 * in the keyring and mail keeps syncing, while Ask starts answering "no model
 * is configured yet" and Settings shows placeholders — until every password is
 * re-entered, for a reason nothing on screen ever gives.
 */
test('a keyring that will not answer must not erase the index', { skip: NEEDS_A_SHELL_STUB }, async () => {
  useHome('probe-unanswered');
  const home = process.env.ZELOS_HOME;
  const binDir = path.join(HOME_ROOT, 'stub-bin');
  const realPath = process.env.PATH;
  installSecretToolStub(binDir);
  process.env.PATH = `${binDir}${path.delimiter}${realPath}`;
  // Forced, so detection never runs and nothing here can reach this machine's
  // own store. Both halves are proved below before a single value is stored.
  process.env.ZELOS_SECRETS_BACKEND = 'libsecret';
  resetBackendCache();

  try {
    const proof = spawnSync('secret-tool', ['--zelos-stub'], { encoding: 'utf8' });
    assert.equal(proof.stdout?.trim(), 'zelos-stub',
      'the stub has to be what "secret-tool" resolves to — if it is not, everything below would be talking to a real keyring');
    assert.equal((await backend()).name, 'libsecret');

    process.env.ZELOS_STUB_MODE = 'found';
    await setSecret('model.default', 'stored-in-a-keyring');
    const indexFile = path.join(home, 'secrets.index.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')), { refs: ['model.default'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'secrets.backend.json'), 'utf8')), { backend: 'libsecret' },
      'the store that took the value is the one this home is now committed to');
    assert.deepEqual(await listRefs(), ['model.default']);

    for (const [mode, shape] of [
      ['dbus', 'exit 1 with a D-Bus complaint on stderr, which is how secret-tool reports a keyring it cannot reach'],
      ['crash', 'an exit code with no documented meaning'],
    ]) {
      process.env.ZELOS_STUB_MODE = mode;
      assert.deepEqual(await listRefs(), ['model.default'],
        `${shape}: a ref nobody has said is gone is still ours`);
      assert.deepEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')), { refs: ['model.default'] },
        `${shape}: the index is the only record that these keyring items are Zelos's, and nothing can rebuild it — so a probe that failed to ask must not prune it`);
    }

    // The other half of the contract, which the tri-state has to keep: a
    // straight not-found (exit 1, nothing on stderr) is a real answer, and a
    // ref deleted in seahorse or Keychain Access should not linger.
    process.env.ZELOS_STUB_MODE = 'missing';
    assert.deepEqual(await listRefs(), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')), { refs: [] });
  } finally {
    delete process.env.ZELOS_STUB_MODE;
    process.env.PATH = realPath;
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
    resetBackendCache();
  }
});

/* -------------------------------------------- a timeout that lost things
 *
 * The measurements these are all about, once, so the tests below can cite them
 * instead of restating them:
 *
 *   (1) A GitHub Actions windows-latest runner — fast, idle — failed a release
 *       build with `powershell.exe timed out after 15000ms`, on a test whose
 *       wall clock was 18136ms. Re-running it passed.
 *   (2) `listRefs()` returned `[]` after 15_020 ms: the probe's own 15_000 plus
 *       change, a fallback to encrypted-file, and an empty store reporting that
 *       this home has no credentials at all.
 *
 * The suite reaches a real `run()` timeout with the `hang` stub, but it does
 * not sit through the product's 60-second budget to do it: `setTimeoutsForTest`
 * shrinks the numbers, because what is under test is the retry and the
 * classification, and neither depends on the size of the number. The numbers
 * themselves are pinned separately, immediately below.
 */

test('the probe budget and the credential budget are different numbers, and both are derived', () => {
  const { probe, access } = TIMEOUTS_MS;

  // The defect in one line: one constant, 15_000, for a liveness check and for
  // a password write. Neither may be that number again.
  assert.notEqual(probe, 15_000);
  assert.notEqual(access, 15_000);
  assert.ok(probe < access,
    `a liveness check must not be given the budget of a write that can lose a credential (${probe} vs ${access})`);

  // Measurement (1) says everything up to and including a cold `powershell.exe`
  // fitted inside 18_136 − 15_000 = 3_136 ms on the reference runner, and that
  // figure contains the test's own setup, so it is an upper bound. The probe
  // gets twice it: room for a machine twice as slow, on the cold attempt.
  assert.equal(probe, (18_136 - 15_000) * 2);

  // And the whole probe, retry included, is still less wall clock than the one
  // 15_000 ms budget it replaces. This is the claim that makes "the probe can
  // afford to be short" true rather than hopeful.
  assert.ok(probe * ATTEMPTS <= 15_000,
    `${ATTEMPTS} probe attempts at ${probe}ms is ${probe * ATTEMPTS}ms, which is more than the 15000ms it replaced`);

  // 15_000 is not a measurement of what an access needs — it is what one was
  // allowed before it was killed with work left, on the fastest machine in the
  // fleet. So the access budget is a multiple of a known-too-small floor.
  assert.equal(access, 15_000 * 4);
  assert.ok(access > 15_000);
});

/**
 * Measurement (2), reproduced end to end and then fixed.
 *
 * Every probe used to answer `false` for any failure whatsoever, and
 * `probeBackend` reads `false` as "this store is not on this machine". So a
 * PowerShell that was merely slow moved a Windows home to the encrypted file,
 * and `listRefs()` answered `[]` — not "I could not ask", but "you have no
 * credentials".
 *
 * The home here has refs in its index and no `secrets.backend.json`, and that
 * combination is deliberate: it is the one state the backend record cannot
 * protect, because there is nothing recorded for a bad probe to lose to.
 * `recordBackend` treats a failed record write as a warning rather than a
 * failed save — losing the record costs the protection, not the secret — so
 * this is a state the module reaches on purpose, and it is also every home in
 * the window between the first `rememberRef` and the first record.
 *
 * The child is the same arrangement `detect()`'s other test uses and for the
 * same reason — pinned to Linux so the probe takes the secret-tool branch on
 * every host, with a stub for its whole PATH — so no real credential store is
 * anywhere near it.
 */
test('a probe that could not answer must not report the store as missing', { skip: NEEDS_A_SHELL_STUB }, () => {
  const binDir = path.join(HOME_ROOT, 'hang-bin');
  proveAndWarmStub(installSecretToolStub(binDir));
  const home = path.join(HOME_ROOT, 'probe-timeout');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'secrets.index.json'), JSON.stringify({ refs: ['mail.m_9f3a1c'] }));
  const log = path.join(HOME_ROOT, 'hang-log.txt');

  const answer = askTheChild({
    home,
    pathDir: binDir,
    env: { ZELOS_STUB_MODE: 'hang', ZELOS_STUB_LOG: log },
    body: [
      'secrets.setTimeoutsForTest({ probe: 400, access: 400 });',
      'const b = await secrets.backend();',
      'process.stdout.write(JSON.stringify({ backend: b.name, refs: await secrets.listRefs() }));',
    ].join('\n'),
  });

  assert.equal(answer.backend, 'libsecret',
    'the spawn SUCCEEDED and the tool did not finish, which is the one thing that cannot mean the tool is '
    + 'absent — falling back here puts the first credential this home ever stores into secrets.enc while '
    + 'the UI note and docs/SECURITY.md both say the desktop keyring is holding it');
  assert.deepEqual(answer.refs, ['mail.m_9f3a1c'],
    'this is the measured defect verbatim: listRefs() answered [] after 15,020 ms, and an empty list is '
    + 'what Settings and Ask read as "nothing was ever configured"');

  // Nothing here ever answers, so every spawn burns its whole budget: the probe
  // is tried ATTEMPTS times, and then listRefs asks about the one ref ATTEMPTS
  // times. A probe that gives up after a single cold spawn is the failure this
  // whole section is about, and it shows up here as half the count.
  assert.equal(stubCalls(log), ATTEMPTS * 2,
    `expected ${ATTEMPTS} probe attempts and ${ATTEMPTS} attempts at the one ref`);
});

/**
 * The other side of the same rule, and without it the fix above is a new bug:
 * "a timeout means the store is there" must not become "a timeout means the
 * store is there and nothing may say otherwise". A machine with secret-tool
 * installed and no keyring daemon has to keep falling back — that is what the
 * D-Bus branch in `probeSecretTool` is for — and on a slow machine the first
 * spawn is exactly the one that might not get far enough to say so.
 *
 * So the stub hangs once and then complains about D-Bus, which is a real
 * answer. Honouring it is the difference between one re-entered password and a
 * home pinned forever to a keyring that cannot hold anything.
 */
test('a probe that answers on the retry is believed, timeout or not', { skip: NEEDS_A_SHELL_STUB }, () => {
  const binDir = path.join(HOME_ROOT, 'hang-once-bin');
  proveAndWarmStub(installSecretToolStub(binDir));
  const home = path.join(HOME_ROOT, 'probe-retry');
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(HOME_ROOT, 'hang-once-log.txt');

  const answer = askTheChild({
    home,
    pathDir: binDir,
    env: {
      ZELOS_STUB_MODE: 'hang-once',
      ZELOS_STUB_AFTER: 'dbus',
      ZELOS_STUB_ONCE: path.join(HOME_ROOT, 'hang-once-marker'),
      ZELOS_STUB_LOG: log,
    },
    body: [
      'secrets.setTimeoutsForTest({ probe: 400, access: 400 });',
      'const b = await secrets.backend();',
      'process.stdout.write(JSON.stringify({ backend: b.name }));',
    ].join('\n'),
  });

  assert.equal(stubCalls(log), ATTEMPTS,
    'a timed-out probe has to be retried; without the second attempt the D-Bus complaint below is never heard');
  assert.equal(answer.backend, 'encrypted-file',
    'the retry said the keyring daemon is not reachable, and that is an answer — treating every timeout as '
    + '"the store is present" would pin this machine to a keyring that will refuse every write');
});

/**
 * The headline consequence of measurement (1). The CI run that failed was a
 * WRITE: it went through `setSecret`, PowerShell was slow once, and the release
 * build went red. For a user the same spawn is the moment they press Save on a
 * mail password, and the old code turned one slow subprocess into "Zelos could
 * not store your password".
 *
 * The stub hangs once and then succeeds, which is what the CI runner did when
 * the job was re-run — and what a cold PowerShell does on its second spawn,
 * with the CLR and its assemblies now in the page cache.
 */
test('a credential write that times out once is not a lost credential', { skip: NEEDS_A_SHELL_STUB }, async () => {
  useHome('write-retry');
  const home = process.env.ZELOS_HOME;
  const binDir = path.join(HOME_ROOT, 'write-retry-bin');
  const log = path.join(HOME_ROOT, 'write-retry-log.txt');
  const realPath = process.env.PATH;
  installSecretToolStub(binDir);
  process.env.PATH = `${binDir}${path.delimiter}${realPath}`;
  // Forced, so detection never runs and nothing here can reach this machine's
  // own store. Proved below before a single value is stored.
  process.env.ZELOS_SECRETS_BACKEND = 'libsecret';
  resetBackendCache();
  const restore = setTimeoutsForTest({ access: 300 });

  try {
    proveAndWarmStub();

    process.env.ZELOS_STUB_MODE = 'hang-once';
    process.env.ZELOS_STUB_AFTER = 'found';
    process.env.ZELOS_STUB_ONCE = path.join(HOME_ROOT, 'write-retry-marker');
    process.env.ZELOS_STUB_LOG = log;

    assert.deepEqual(await setSecret('model.default', 'a-password-worth-keeping'), { ok: true, backend: 'libsecret' });
    assert.equal(stubCalls(log), ATTEMPTS, 'the write was retried exactly once after the timeout');

    // The write really completed, rather than being reported as done: the ref
    // is indexed and the home is committed to the store that took it.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'secrets.index.json'), 'utf8')), { refs: ['model.default'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'secrets.backend.json'), 'utf8')), { backend: 'libsecret' });
  } finally {
    restore();
    for (const v of ['ZELOS_STUB_MODE', 'ZELOS_STUB_AFTER', 'ZELOS_STUB_ONCE', 'ZELOS_STUB_LOG']) delete process.env[v];
    process.env.PATH = realPath;
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
    resetBackendCache();
  }
});

/**
 * The dangerous half, stated as a rule: a read that could not be answered must
 * never be handed to a caller as "there is no such secret". Two ways in, and
 * the module used to take both.
 *
 *  - the tool never finished. That has always thrown, and now it is retried
 *    first — the same cold-start argument as the write above, and the same
 *    consequence if it is not: `core/sweep.mjs:636` turns a thrown getSecret
 *    into a per-source error the user can see, which is right, but it turns a
 *    NULL into "No password stored for <account>. Add it in Settings" — an
 *    instruction to re-type a password that is sitting in the keyring.
 *  - secret-tool exited 1 and complained. It spends exit 1 on both "no such
 *    item" and "the keyring did not answer"; `hasSecret` has always read stderr
 *    to tell them apart and this read did not, so a keyring that was down
 *    answered "there is no password for this account" in as many words.
 */
test('a read that could not be answered is an error, never "no such secret"', { skip: NEEDS_A_SHELL_STUB }, async () => {
  useHome('read-timeout');
  // A home with no identity has saved nothing scoped and answers null without
  // asking the keyring; this test is about a keyring that is asked.
  ensureNamespace();
  const binDir = path.join(HOME_ROOT, 'read-timeout-bin');
  const log = path.join(HOME_ROOT, 'read-timeout-log.txt');
  const realPath = process.env.PATH;
  installSecretToolStub(binDir);
  process.env.PATH = `${binDir}${path.delimiter}${realPath}`;
  // Forced, so detection never runs and nothing here can reach this machine's
  // own store.
  process.env.ZELOS_SECRETS_BACKEND = 'libsecret';
  resetBackendCache();
  const restore = setTimeoutsForTest({ access: 300 });

  try {
    proveAndWarmStub();

    process.env.ZELOS_STUB_MODE = 'hang';
    process.env.ZELOS_STUB_LOG = log;
    // Taken as a value rather than through two `assert.rejects` calls, so the
    // whole budget is spent once and so "it did not resolve" is stated outright
    // — `assert.rejects` alone would also be satisfied by a different error.
    const failed = await getSecret('model.default').then((v) => ({ resolved: v }), (err) => err);
    assert.ok(failed instanceof Error,
      `a read that never came back resolved to ${JSON.stringify(failed.resolved)}; null here is a password `
      + 'sitting in the keyring that the user is told to type again');
    assert.match(failed.message, /timed out after 300ms/);
    // The message also has to say WHICH of the module's spawns died. The CI
    // failure that started this said only `powershell.exe timed out after
    // 15000ms`, and which of that test's PowerShell calls it was had to be
    // reconstructed from a wall clock. A ref is an opaque id, so it leaks
    // nothing to name one.
    assert.match(failed.message, /libsecret get model\.default/);
    assert.equal(stubCalls(log), ATTEMPTS, 'and it must be retried once before it becomes an error');

    fs.rmSync(log, { force: true });
    process.env.ZELOS_STUB_MODE = 'dbus';
    await assert.rejects(() => getSecret('model.default'), /could not read model\.default from libsecret/,
      'exit 1 with a D-Bus complaint on stderr is how secret-tool reports a keyring it cannot reach, and it '
      + 'used to be read as an empty keyring');

    // The other half of the same branch, which the tri-state has to keep: a
    // straight not-found is exit 1 with NOTHING on stderr, and that really is
    // "no such secret".
    process.env.ZELOS_STUB_MODE = 'missing';
    assert.equal(await getSecret('model.default'), null);
  } finally {
    restore();
    for (const v of ['ZELOS_STUB_MODE', 'ZELOS_STUB_LOG']) delete process.env[v];
    process.env.PATH = realPath;
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
    resetBackendCache();
  }
});

/**
 * `listRefs` is the one caller that multiplies a timeout, and it is on a path a
 * UI request waits on: `core/server.mjs:768` and `:1053`. Two things keep that
 * bounded, and both are measured here rather than reasoned about.
 *
 *  - `hasSecret` draws on the SHORT budget, not the credential one. Its "I
 *    could not tell" already keeps the ref, so a longer wait buys only the
 *    chance to prune, and pruning is tidiness that self-corrects. The two
 *    budgets are set far apart below and the clock says which one was used.
 *  - once one ref has gone unanswered, the rest are not asked. The index is
 *    already un-prunable for this pass and a ref nobody has said is gone stays
 *    in the list either way, so every further spawn is time spent on an outcome
 *    that is settled.
 *
 * The clock is asserted as well as the spawn count, because a count can be
 * right while the work is not — and because the count is what a refactor would
 * preserve while the wait is what a user would feel.
 */
test('a store that stops answering is asked once, on the short budget', { skip: NEEDS_A_SHELL_STUB }, async () => {
  useHome('list-timeout');
  const home = process.env.ZELOS_HOME;
  const binDir = path.join(HOME_ROOT, 'list-timeout-bin');
  const log = path.join(HOME_ROOT, 'list-timeout-log.txt');
  const realPath = process.env.PATH;
  installSecretToolStub(binDir);
  process.env.PATH = `${binDir}${path.delimiter}${realPath}`;
  // Forced, so detection never runs and nothing here can reach this machine's
  // own store.
  process.env.ZELOS_SECRETS_BACKEND = 'libsecret';
  resetBackendCache();
  // Far apart on purpose: `access` is what `hasSecret` must NOT be using, and
  // it is kept small enough that a regression fails in about eight seconds
  // instead of hanging the suite for the two minutes the real number would.
  const budget = 400;
  const restore = setTimeoutsForTest({ probe: budget, access: 4_000 });

  try {
    proveAndWarmStub();

    const indexFile = path.join(home, 'secrets.index.json');
    const refs = ['mail.m_a1', 'mail.m_b2', 'model.default'];
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify({ refs }));

    process.env.ZELOS_STUB_MODE = 'hang';
    process.env.ZELOS_STUB_LOG = log;
    const started = Date.now();
    assert.deepEqual(await listRefs(), refs, 'a ref nobody has said is gone is still ours');
    const elapsed = Date.now() - started;

    assert.deepEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')), { refs },
      'the index is the only record that these keyring items are Zelos\'s, and nothing can rebuild it');
    assert.equal(stubCalls(log), ATTEMPTS,
      `one ref asked, retried once, and then it stops: ${refs.length} refs at ${ATTEMPTS} attempts each would be `
      + `${refs.length * ATTEMPTS} spawns for an answer that was settled after the first`);
    /* The passing case is two short budgets plus two shell spawns: about
       800 ms. The two ways this can go wrong are 2,400 ms (asking every ref)
       and 8,000 ms (asking on the credential budget). The bound is set at
       double the expectation so a loaded runner has room, and it is still well
       under either failure — a wall-clock assertion is only worth having if it
       cannot fail for being on a busy machine or pass for the wrong reason. */
    assert.ok(elapsed < budget * ATTEMPTS * 2,
      `listRefs took ${elapsed}ms. It should be about ${budget * ATTEMPTS}ms: asking every ref would be about `
      + `${budget * ATTEMPTS * refs.length}ms, and asking on the credential budget would be about 8000ms — a `
      + 'health check must not sit on a stalled keyring for the time a password write is allowed');
  } finally {
    restore();
    for (const v of ['ZELOS_STUB_MODE', 'ZELOS_STUB_LOG']) delete process.env[v];
    process.env.PATH = realPath;
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
    resetBackendCache();
  }
});

/* --------------------------------------------- the backend this machine uses */

/**
 * These two let detection run, which means they use the REAL credential store
 * of whatever machine they are on — the operator's login keychain on macOS,
 * their keyring on Linux, their DPAPI profile on Windows. They write an item
 * and delete it, under a ref of their own, so nothing of the user's is touched.
 * It is still their keychain, and running a project's tests should not put
 * anything in it.
 *
 * So they are held to the same gate as the live DPAPI round-trip below: a
 * throwaway CI runner, or not at all. On a developer's own machine the
 * encrypted-file fallback tests above cover the same store-read-delete contract
 * without leaving the repository.
 *
 * test/repo.test.mjs has a guard for this, but it is textual — it checks that a
 * file mentions ZELOS_SECRETS_BACKEND, which this file does, so it passed while
 * these two tests quietly opted back out. The guard now looks for the opt-out
 * as well; this comment exists so the next person to add an `unforce()` knows
 * why it is watched.
 */
const REAL_STORE_ONLY_ON_CI = process.env.CI
  ? false
  : "this test uses the machine's real credential store, so it runs only on a throwaway CI runner "
    + '(set CI=1 if you genuinely want it to touch your keychain)';

test('this machine\'s real backend round-trips a hostile-looking value', { skip: REAL_STORE_ONLY_ON_CI }, async (t) => {
  useHome('native');
  unforce();
  const b = await backend();

  if (b.name === 'encrypted-file') {
    t.diagnostic('no system keychain on this machine; the fallback is covered above');
    return;
  }
  assert.equal(b.name, { darwin: 'macos-keychain', win32: 'windows-dpapi', linux: 'libsecret' }[process.platform]);
  assert.ok(b.note.length > 40);

  // A ref of our own so a real "model.default" is never touched, and the
  // keychain is left exactly as we found it.
  const ref = `test.zelos-${crypto.randomBytes(6).toString('hex')}`;
  const value = 'p@ss "word" with spaces & $tuff \\ and ünïcode ✓';
  try {
    await setSecret(ref, value);
    assert.equal(await getSecret(ref), value, `${b.name} must round-trip the value byte for byte`);

    const refs = await listRefs();
    assert.ok(refs.includes(ref));
    for (const r of refs) {
      assert.equal(typeof r, 'string');
      assert.notEqual(r, value, 'listRefs returns refs, never values');
    }

    await setSecret(ref, 'second-value');
    assert.equal(await getSecret(ref), 'second-value', 'set must overwrite, not duplicate');

    assert.equal(await getSecret(`${ref}-absent`), null);
  } finally {
    await deleteSecret(ref).catch(() => {});
  }
  assert.equal(await getSecret(ref), null, 'delete really removes it');
  assert.ok(!(await listRefs()).includes(ref));
});

test('the index file records refs and nothing else', { skip: REAL_STORE_ONLY_ON_CI }, async (t) => {
  useHome('index');
  unforce();
  const b = await backend();
  if (b.name === 'encrypted-file') return; // no index file in that mode

  const ref = `test.zelos-${crypto.randomBytes(6).toString('hex')}`;
  const indexFile = path.join(process.env.ZELOS_HOME, 'secrets.index.json');
  try {
    await setSecret(ref, 'a-value-that-must-not-be-indexed');
    const text = fs.readFileSync(indexFile, 'utf8');
    assert.ok(!text.includes('a-value-that-must-not-be-indexed'));
    assert.deepEqual(JSON.parse(text), { refs: [ref] });

    // The contents above are the claim that holds everywhere. The mode is the
    // POSIX half, and it is a subtest so that it can skip by name on Windows
    // without taking the contents check with it.
    await t.test('and the index is written 0600', { skip: WINDOWS_NO_POSIX_MODES }, () => {
      assert.equal(mode(indexFile), 0o600);
    });
  } finally {
    await deleteSecret(ref).catch(() => {});
  }
});

/* ---------------------------------------- the live Windows DPAPI backend */

/**
 * Why this one test is allowed to let detection run.
 *
 * docs/SECURITY.md tells a Windows user that their keys are held by DPAPI at
 * CurrentUser scope. Until this test, nothing proved it. `describeCommand` is
 * checked above, but that only asserts the *shape* of an argv; the store and
 * read path in `secrets.mjs` runs solely when `detect()` actually returns
 * 'windows-dpapi'.
 *
 * The two "native backend" tests above do let detection run — but both of them
 * return quietly when it lands on 'encrypted-file', so a green Windows leg is
 * equally consistent with DPAPI working and with Windows never having reached
 * DPAPI at all. That is the gap: a documented security property whose evidence
 * cannot distinguish "it works" from "it was skipped".
 *
 * So this test asserts the detected backend rather than tolerating it, and then
 * puts a real secret through PowerShell. Letting detection run is the deliberate
 * exception to the force-the-file-backend rule that test/repo.test.mjs enforces,
 * and it is only safe because of the gate below: `win32` AND `CI` together mean
 * a throwaway GitHub runner whose profile is destroyed with the job. A
 * developer's own Windows box has neither, so their DPAPI store is never written
 * to. If you are tempted to relax this gate, the thing you would be relaxing is
 * "Zelos's test suite does not write into your credential store".
 */
const DPAPI_LIVE_ONLY = process.platform === 'win32' && process.env.CI
  ? false
  : 'the live DPAPI round-trip runs only on Windows CI, because letting the backend '
    + `auto-detect writes into the running account's real DPAPI store (platform=${process.platform}, `
    + `CI=${process.env.CI ? 'set' : 'unset'})`;

/**
 * A ref no real installation could ever produce. Zelos's own refs are
 * "model.default" and "mail.m_<hex>"; nothing generates this shape, so a blob
 * left behind by a crashed run is identifiable as litter at a glance, and a
 * cleanup that misfires cannot take a real secret with it.
 */
const DPAPI_REF = `zelos-ci-throwaway.dpapi-live.${crypto.randomBytes(6).toString('hex')}`;

/**
 * Everything a naive implementation gets wrong, in one string: both kinds of
 * quote, the two characters PowerShell expands inside a double-quoted string
 * (`$` and a backtick), a backslash, an embedded newline, Latin-1 accents, a
 * character that exists in no single-byte code page, and several kilobytes of
 * tail so the value could not have fitted in a command line even if someone
 * tried to put it there.
 *
 * It deliberately does NOT end in a newline. The value reaches PowerShell on
 * stdin newline-terminated, so the script has to strip that terminator, and it
 * does so with `-replace '\r?\n$',''` — which in .NET removes the whole trailing
 * run of line breaks, not just the one Zelos added. A value that genuinely ends
 * in a newline therefore cannot survive this backend. That is a defect in the
 * backend rather than in this test, and asserting it here would be writing the
 * bug down as correct behaviour.
 */
const DPAPI_VALUE = [
  'sk-ant-api03-"double" and \'single\' quotes',
  'a $variable, a `backtick`, a \\backslash\\ and a 100% percent',
  'accents: ü é ñ, and a check mark outside every single-byte page: ✓',
  `long tail: ${'zelos-'.repeat(600)}end`,
].join('\n');

/**
 * Node's own diff truncates a multi-kilobyte string, and the failure this test
 * is most likely to catch is an encoding one — where the strings look identical
 * in a terminal and differ by a code point. So report the first divergence by
 * number, with a little context either side.
 */
function firstDifference(expected, actual) {
  if (typeof actual !== 'string') return `got ${typeof actual} (${JSON.stringify(actual)}) instead of a string`;
  const codes = (s, at) => [...s.slice(Math.max(0, at - 8), at + 8)]
    .map((ch) => `${JSON.stringify(ch)}=U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ');
  for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
    if (expected[i] === actual[i]) continue;
    return `first difference at index ${i} of ${expected.length}\n`
      + `  expected: ${codes(expected, i)}\n`
      + `  actual:   ${codes(actual, i)}`;
  }
  return `lengths differ: expected ${expected.length}, got ${actual.length}`;
}

test('Windows CI: DPAPI is the detected backend and really round-trips a secret', { skip: DPAPI_LIVE_ONLY }, async (t) => {
  useHome('dpapi-live');
  unforce();

  // Registered before anything is written, so it still runs when an assertion
  // below throws. A DPAPI blob lives in %LOCALAPPDATA%, outside the temp home
  // that test.after removes, so nothing else would ever clear it.
  t.after(async () => { await deleteSecret(DPAPI_REF).catch(() => {}); });

  const b = await backend();
  assert.equal(b.name, 'windows-dpapi',
    `Windows detection chose ${b.name}. If powershell.exe cannot be probed on this machine, Zelos silently `
    + 'stores keys in the encrypted file while docs/SECURITY.md and the note in the UI both tell the user '
    + 'their operating system is holding them. That mismatch is the defect, not this assertion.');
  assert.match(b.note, /DPAPI/);

  // The module's own idea of where the blob goes, rather than a second copy of
  // that path logic here — a test that guessed the path could pass against a
  // backend that had written somewhere else entirely. The home needs its
  // identity first, as setSecret would give it, to have an address at all.
  ensureNamespace();
  const blob = describeCommand({ name: 'windows-dpapi', action: 'set', ref: DPAPI_REF }).env.ZELOS_SECRET_FILE;

  await setSecret(DPAPI_REF, DPAPI_VALUE);

  assert.ok(fs.existsSync(blob), `setSecret reported success but wrote no blob at ${blob}`);
  // WriteAllText emits no BOM on .NET Framework, but strip one anyway: a BOM
  // would fail the hex check below for a reason that has nothing to do with
  // whether the secret survived.
  const onDisk = fs.readFileSync(blob, 'utf8').replace(/^\uFEFF/, '').trim();
  assert.match(onDisk, /^[0-9A-Fa-f]+$/, 'ConvertFrom-SecureString should leave a hex DPAPI blob, nothing else');
  for (const fragment of ['sk-ant-api03', 'backslash', 'check mark']) {
    assert.ok(!onDisk.includes(fragment), `the DPAPI blob contains plaintext (${fragment}) — it was not encrypted`);
  }

  const got = await getSecret(DPAPI_REF);
  assert.equal(got, DPAPI_VALUE,
    `DPAPI did not hand back what it was given.\n${firstDifference(DPAPI_VALUE, got)}\n`
    + 'The usual cause is console encoding: the value crosses stdin and stdout as bytes, and PowerShell '
    + 'decodes them with the console code page rather than UTF-8 unless the script sets both '
    + '[Console]::InputEncoding and [Console]::OutputEncoding to UTF8.');

  const refs = await listRefs();
  assert.ok(refs.includes(DPAPI_REF), 'a stored ref must appear in listRefs');
  for (const r of refs) assert.notEqual(r, DPAPI_VALUE, 'listRefs returns refs, never values');

  assert.deepEqual(await deleteSecret(DPAPI_REF), { ok: true, deleted: true });
  assert.equal(fs.existsSync(blob), false, 'delete must remove the DPAPI blob, not just forget the ref');
  assert.equal(await getSecret(DPAPI_REF), null, 'a deleted secret must read back as absent');
  assert.ok(!(await listRefs()).includes(DPAPI_REF), 'a deleted ref must leave the index');
  assert.deepEqual(await deleteSecret(DPAPI_REF), { ok: true, deleted: false }, 'deleting twice is not an error');
});

/**
 * The PowerShell in this module is written inside JavaScript template literals,
 * which means two escaping systems sit on top of each other and neither one
 * complains when you use the wrong one. That is not hypothetical: a newline
 * strip shipped here as `EndsWith("\r\n")`, which in PowerShell is four literal
 * characters and matches nothing, so every stored secret kept its terminator.
 * It looked right, it passed every check that could be run on this machine, and
 * it failed only on a real Windows runner.
 *
 * These assertions are cheap, they run everywhere, and they would have caught
 * it: PowerShell escapes with a backtick, so a backslash escape in these
 * scripts is always a mistake.
 */
test('the PowerShell scripts use PowerShell escaping, not JavaScript escaping', () => {
  ensureNamespace();
  for (const action of ['set', 'get']) {
    const cmd = describeCommand({ name: 'windows-dpapi', action, ref: 'mail.m_1' });
    const script = Buffer.from(cmd.args[cmd.args.indexOf('-EncodedCommand') + 1], 'base64')
      .toString('utf16le');

    // \r \n \t inside a PowerShell string are literal characters, never escapes.
    const backslashEscape = /\\[rnt]/.exec(script);
    assert.equal(backslashEscape, null,
      `${action}: ${backslashEscape?.[0]} is a JavaScript escape; PowerShell would read it literally`);

    // A backtick cannot survive a template literal, so seeing one means the
    // script was assembled some other way and this guard no longer covers it.
    assert.ok(!script.includes('`'), `${action}: a backtick reached the script`);

    // The value must never be interpolated into the script text itself.
    assert.ok(!/\$\{/.test(script), `${action}: the script interpolates at build time`);
  }
});

test('the DPAPI scripts state their own encoding rather than inheriting it', () => {
  ensureNamespace();
  // The console code page differs by locale, and on a double-byte locale it is
  // not a reversible byte mapping — so a non-ASCII password would be corrupted
  // silently. Both directions must name UTF-8 explicitly.
  const set = describeCommand({ name: 'windows-dpapi', action: 'set', ref: 'mail.m_1' });
  const setScript = Buffer.from(set.args[set.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(setScript, /UTF8\.GetString/);
  assert.ok(!/\[Console\]::In\b/.test(setScript));

  const get = describeCommand({ name: 'windows-dpapi', action: 'get', ref: 'mail.m_1' });
  const getScript = Buffer.from(get.args.at(-1), 'base64').toString('utf16le');
  assert.match(getScript, /UTF8\.GetBytes/);
  assert.ok(!/\[Console\]::Out\b/.test(getScript));
});

/* --------------------------------------- the live Linux libsecret backend */

/**
 * The Linux counterpart of the DPAPI gate above, and it exists for the same
 * reason: until now, no leg of CI had ever executed the libsecret backend.
 *
 * `ubuntu-latest` ships neither `libsecret-tools` nor a keyring daemon, so
 * detection there lands on 'encrypted-file', the two "real backend" tests see
 * that and return quietly, and a green Ubuntu run was equally consistent with
 * libsecret working and with libsecret never having been reached. The argv
 * shape is checked at the top of this file, but a shape is not a conversation:
 * what stays unverified without a real binary is whether `secret-tool` ACCEPTS
 * that argv, whether a missing item really is exit 1 rather than some other
 * code, and whether the value survives the newline `getSecret` strips off it.
 *
 * The gate is `linux` AND `CI` AND `ZELOS_LIBSECRET_LIVE`, and the third is
 * what the .github/workflows/ci.yml `libsecret` job sets. `CI` alone would turn
 * every existing Ubuntu leg red for want of a keyring that is not installed
 * there; the extra variable names the one leg that installs one and runs under
 * `dbus-run-session`. Letting detection run is the deliberate exception to the
 * force-the-file-backend rule that test/repo.test.mjs enforces, and it is safe
 * only because of that gate: a throwaway runner whose keyring dies with the
 * job. test/repo.test.mjs asserts the workflow and this constant still name
 * each other, so the gate cannot quietly become permanently-off.
 */
const LIBSECRET_LIVE_ONLY = process.platform === 'linux' && process.env.CI && process.env.ZELOS_LIBSECRET_LIVE
  ? false
  : 'the live libsecret round-trip runs only on the CI leg that installs a real Secret Service, because '
    + "letting the backend auto-detect writes into the running account's keyring "
    + `(platform=${process.platform}, CI=${process.env.CI ? 'set' : 'unset'}, `
    + `ZELOS_LIBSECRET_LIVE=${process.env.ZELOS_LIBSECRET_LIVE ? 'set' : 'unset'})`;

/** The same throwaway shape the DPAPI ref uses: litter, identifiable at a glance. */
const LIBSECRET_REF = `zelos-ci-throwaway.libsecret-live.${crypto.randomBytes(6).toString('hex')}`;

/**
 * Everything a naive implementation gets wrong that this backend is allowed to
 * carry, on ONE line — and one line is not a shortcut, it is the contract.
 * `assertValue` in core/secrets.mjs refuses a line break outright for
 * libsecret, because the tool reads the value as a line from stdin and a
 * newline would truncate it. The rejection is asserted below rather than worked
 * around, since this is the only place a real `secret-tool` ever runs.
 *
 * The tail is several kilobytes so the value could not have fitted on a command
 * line even if someone tried to put it there, and it ends in a printable
 * character: `getSecret` strips ONE trailing newline, which is the one
 * secret-tool adds, so a value that genuinely ended in a newline could not
 * round-trip. That is a limit of the backend and asserting it would be writing
 * it down as correct.
 */
const LIBSECRET_VALUE = 'sk-ant-api03-"double" and \'single\' quotes, a $variable, a --lookalike-flag, '
  + 'a \\backslash\\ and a 100% percent, accents ü é ñ, a check mark outside every single-byte page ✓, '
  + `and a long tail: ${'zelos-'.repeat(600)}end`;

test('Linux CI: libsecret is the detected backend and really round-trips a secret', { skip: LIBSECRET_LIVE_ONLY }, async (t) => {
  useHome('libsecret-live');
  unforce();

  // Registered before anything is written: a keyring item outlives the temp
  // home that test.after removes, so nothing else would ever clear it.
  t.after(async () => { await deleteSecret(LIBSECRET_REF).catch(() => {}); });

  const b = await backend();
  assert.equal(b.name, 'libsecret',
    `Linux detection chose ${b.name}. If secret-tool cannot be reached on this machine, Zelos silently `
    + 'stores keys in the encrypted file while the UI note says the desktop keyring is holding them. '
    + 'That mismatch is the defect, not this assertion — and this leg installs the keyring precisely so '
    + 'that "it fell back" cannot be the answer.');
  assert.match(b.note, /keyring/i);

  await setSecret(LIBSECRET_REF, LIBSECRET_VALUE);

  // The whole point of a keyring is that the value is not in the Zelos home.
  const home = process.env.ZELOS_HOME;
  assert.equal(fs.existsSync(path.join(home, 'secrets.enc')), false,
    'a keyring backend must not also be writing the encrypted file');
  for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // paths() makes logs/ and cache/ beside them
    const body = fs.readFileSync(path.join(home, entry.name), 'utf8');
    assert.ok(!body.includes('sk-ant-api03'), `${entry.name} in the Zelos home holds the secret in the clear`);
  }

  assert.equal(await getSecret(LIBSECRET_REF), LIBSECRET_VALUE,
    'secret-tool did not hand back what it was given — the usual causes are the trailing-newline strip '
    + 'taking more than the one newline it added, and a value being split across argv rather than stdin');

  // The documented limit, against the real tool: a line break is refused before
  // anything is spawned, because secret-tool reads one line from stdin and the
  // rest of the password would be silently dropped.
  await assert.rejects(() => setSecret(LIBSECRET_REF, 'first line\nsecond line'), TypeError);
  assert.equal(await getSecret(LIBSECRET_REF), LIBSECRET_VALUE, 'the refused write disturbed the stored value');

  // The convention `getSecret` depends on: not-found is exit 1, and exit 1 is
  // not an error. If secret-tool ever changed this, every missing password
  // would start reading as a failure instead of "nothing stored yet".
  assert.equal(await getSecret(`${LIBSECRET_REF}-absent`), null);

  await setSecret(LIBSECRET_REF, 'second-value');
  assert.equal(await getSecret(LIBSECRET_REF), 'second-value', 'store must overwrite, not duplicate');

  const refs = await listRefs();
  assert.ok(refs.includes(LIBSECRET_REF));
  for (const r of refs) assert.notEqual(r, LIBSECRET_VALUE, 'listRefs returns refs, never values');

  assert.deepEqual(await deleteSecret(LIBSECRET_REF), { ok: true, deleted: true });
  assert.equal(await getSecret(LIBSECRET_REF), null, 'a deleted secret must read back as absent');
  assert.ok(!(await listRefs()).includes(LIBSECRET_REF), 'a deleted ref must leave the index');

  // `secret-tool clear` is not documented to distinguish "removed one" from
  // "there was nothing to remove", and core/secrets.mjs reads either exit as a
  // success. Which of the two it reports on a second delete is therefore not a
  // claim this test should pin down — what has to hold under both conventions
  // is that deleting twice is not an error and the ref stays gone.
  const second = await deleteSecret(LIBSECRET_REF);
  assert.equal(second.ok, true, 'deleting twice must not be an error');
  assert.equal(await getSecret(LIBSECRET_REF), null);
});
