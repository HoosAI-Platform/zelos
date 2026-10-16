import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Quiet the shared logger before core/log.mjs is evaluated, and make absolutely
// sure nothing in this file can reach the real ~/.zelos.
process.env.ZELOS_LOG_LEVEL = 'silent';
const HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-config-'));
process.env.ZELOS_HOME = path.join(HOME_ROOT, 'home');

const { DEFAULTS, MAIL_ACCOUNT_DEFAULTS, CALENDAR_DEFAULTS, paths, loadConfig, saveConfig, validateConfig, newId, isValidRef } =
  await import('../core/config.mjs');
const { modelKeyRef } = await import('../core/model-key.mjs');

const mode = (p) => fs.statSync(p).mode & 0o777;

/**
 * POSIX modes are the whole at-rest story on macOS and Linux, and Windows does
 * not implement them: fs.chmod there sets little more than the read-only flag,
 * and fs.stat reports a synthesised 0777/0666 no matter what Zelos asked for.
 * A `0700` assertion on Windows would therefore succeed or fail for reasons
 * that have nothing to do with the guarantee it exists to protect, so the mode
 * claims are split out and skipped there by name rather than being weakened
 * for every platform to accommodate one. docs/SECURITY.md §5 tells the user the
 * same thing: on Windows the real access control is the NTFS ACL the user
 * profile already carries, which Zelos does not currently set.
 *
 * node:test prints this string as the reason, so a reader of the Windows run
 * learns why the gap is there instead of finding a silent hole.
 */
const WINDOWS_NO_POSIX_MODES = process.platform === 'win32'
  ? 'POSIX modes are not implemented on Windows: chmod sets little more than the read-only flag, so this could not assert what it claims (docs/SECURITY.md §5)'
  : false;

function freshHome(name) {
  const home = path.join(HOME_ROOT, name);
  process.env.ZELOS_HOME = home;
  return home;
}

/**
 * Point the platform's idea of "the user's home" at a sandbox. os.homedir()
 * reads $HOME on macOS and Linux and %USERPROFILE% on Windows, so a test that
 * only sets HOME leaves Windows resolving the fallback home to the real
 * profile — and paths() would then create a live ~/.zelos on the CI runner.
 * Both are set, and both are restored to *absence* rather than to the string
 * "undefined", which is what assigning an undefined value to process.env does.
 */
function withSandboxedUserHome(dir, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  fs.mkdirSync(dir, { recursive: true });
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test.after(() => {
  fs.rmSync(HOME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('paths() creates the home where it says and never touches the real one', () => {
  const home = freshHome('paths');
  const p = paths();

  assert.equal(p.home, home);
  assert.equal(p.configFile, path.join(home, 'config.json'));
  assert.equal(p.db, path.join(home, 'zelos.db'));
  assert.equal(p.logsDir, path.join(home, 'logs'));
  assert.equal(p.cacheDir, path.join(home, 'cache'));

  // That the three directories are created at all is the half that matters on
  // every platform, and it used to be asserted only as a side effect of asking
  // for their mode — which left nothing checking it where modes are a fiction.
  for (const dir of [p.home, p.logsDir, p.cacheDir]) {
    assert.ok(fs.statSync(dir).isDirectory(), `${dir} must exist as a directory`);
  }
  assert.ok(!p.home.includes(os.homedir() + path.sep + '.zelos'));
});

test('paths() creates the home, logs and cache at 0700', { skip: WINDOWS_NO_POSIX_MODES }, () => {
  freshHome('paths-mode');
  const p = paths();
  assert.equal(mode(p.home), 0o700);
  assert.equal(mode(p.logsDir), 0o700);
  assert.equal(mode(p.cacheDir), 0o700);
});

test('paths() treats ZELOS_HOME=undefined as no override, not a directory name', () => {
  // A launcher that interpolates an unset variable produces the literal
  // string "undefined" — the old code resolved it to <cwd>/undefined and put
  // a real data directory there. The user's home is sandboxed so the fallback
  // lands inside HOME_ROOT instead of the real ~/.zelos on any platform.
  const fakeHome = path.join(HOME_ROOT, 'fake-user');
  try {
    withSandboxedUserHome(fakeHome, () => {
      for (const junk of ['undefined', 'null', ' Undefined ', 'NULL']) {
        process.env.ZELOS_HOME = junk;
        const p = paths();
        assert.equal(p.home, path.join(fakeHome, '.zelos'), JSON.stringify(junk));
        assert.ok(!fs.existsSync(path.resolve(process.cwd(), junk.trim())), JSON.stringify(junk));
      }
    });
  } finally {
    freshHome('after-junk');
  }
});

test('paths() tightens a home somebody left world-readable', { skip: WINDOWS_NO_POSIX_MODES }, () => {
  const home = freshHome('loose');
  fs.mkdirSync(home, { recursive: true, mode: 0o755 });
  fs.chmodSync(home, 0o755);
  assert.equal(mode(home), 0o755);

  paths();
  assert.equal(mode(home), 0o700);
});

/**
 * The Windows-meaningful half of the test above. Tightening cannot be observed
 * there, but the code path that would do the tightening still runs on every
 * launch — ensureDir() stats an existing directory, sees the 0777 Windows
 * synthesises, and calls chmod on it. If that ever threw, Zelos would refuse to
 * start on Windows for a directory that was perfectly fine.
 */
test('paths() adopts a home that already exists instead of failing on it', () => {
  const home = freshHome('pre-existing');
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });

  const p = paths();
  assert.equal(p.home, home);
  assert.ok(fs.statSync(p.cacheDir).isDirectory(), 'the missing sibling is filled in');
  assert.equal(paths().home, home, 'and a second call is a no-op, not an error');
});

test('loadConfig() returns the full default shape with a resolved timezone', () => {
  freshHome('load-defaults');
  const cfg = loadConfig();

  assert.equal(cfg.version, 1);
  assert.equal(cfg.model.protocol, 'anthropic');
  // The model's keyRef is derived from its address (core/model-key.mjs).
  assert.equal(cfg.model.keyRef, modelKeyRef('https://api.anthropic.com'));
  assert.deepEqual(cfg.mail, []);
  assert.deepEqual(cfg.calendars, []);
  assert.deepEqual(cfg.sweep, { intervalMinutes: 30, activeHours: [6, 23], auto: true });
  assert.equal(cfg.privacy.sendBodies, true);
  assert.ok(cfg.identity.timezone.length > 0, 'timezone is filled from Intl when blank');

  // Mutating the result must not poison the next caller.
  cfg.model.maxTokens = 1;
  assert.equal(loadConfig().model.maxTokens, 8192);
  assert.equal(DEFAULTS.model.maxTokens, 8192);
  assert.ok(Object.isFrozen(DEFAULTS));
});

test('saveConfig() deep-merges and leaves untouched keys alone', () => {
  const home = freshHome('save');
  saveConfig({ identity: { name: 'Nemo' }, model: { model: 'claude-x', maxTokens: 4096 } });
  const after = saveConfig({ model: { temperature: 0.4 } });

  assert.equal(after.identity.name, 'Nemo');
  assert.equal(after.model.model, 'claude-x');
  assert.equal(after.model.maxTokens, 4096, 'second save must not reset the first');
  assert.equal(after.model.temperature, 0.4);

  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(onDisk.model.model, 'claude-x');
  assert.equal(onDisk.identity.timezone, '', 'a timezone resolved at runtime is not frozen into the file');
});

test('saveConfig() writes config.json 0600', { skip: WINDOWS_NO_POSIX_MODES }, () => {
  const home = freshHome('save-mode');
  saveConfig({ identity: { name: 'Nemo' } });
  assert.equal(mode(path.join(home, 'config.json')), 0o600);
});

test('saveConfig() replaces arrays wholesale so an account can be removed', () => {
  freshHome('arrays');
  const two = saveConfig({
    mail: [
      { id: 'm_aaa', host: 'a.example', user: 'a@example.com' },
      { id: 'm_bbb', host: 'b.example', user: 'b@example.com' },
    ],
  });
  assert.equal(two.mail.length, 2);
  assert.equal(two.mail[0].port, 993, 'account defaults are filled in');
  assert.equal(two.mail[0].keyRef, 'mail.m_aaa', 'keyRef derives from the account id');
  assert.deepEqual(two.mail[0].mailboxes, ['INBOX']);

  const one = saveConfig({ mail: [{ id: 'm_bbb', host: 'b.example', user: 'b@example.com' }] });
  assert.equal(one.mail.length, 1);
  assert.equal(one.mail[0].id, 'm_bbb');
});

test('accounts without an id get one, and it is stable across loads', () => {
  freshHome('ids');
  const saved = saveConfig({ mail: [{ host: 'imap.example', user: 'x@example.com' }] });
  const id = saved.mail[0].id;
  assert.match(id, /^m_[0-9a-f]{6}$/);
  assert.equal(loadConfig().mail[0].id, id);
});

test('a secret handed to saveConfig() never reaches the disk', () => {
  const home = freshHome('secrets');
  const cfg = saveConfig({
    model: { apiKey: 'sk-ant-should-never-persist', keyRef: 'model.default' },
    mail: [{ id: 'm_ccc', host: 'imap.example', user: 'u@example.com', pass: 'hunter2', keyRef: 'mail.m_ccc' }],
  });

  assert.equal(cfg.model.apiKey, undefined);
  assert.equal(cfg.mail[0].pass, undefined);
  assert.equal(cfg.mail[0].keyRef, 'mail.m_ccc');

  const text = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('sk-ant-should-never-persist'));
  assert.ok(!/"pass"|"apiKey"/.test(text));
});

test('a write that dies before the rename leaves the old config intact', () => {
  const home = freshHome('atomic');
  const file = path.join(home, 'config.json');
  saveConfig({ identity: { name: 'Original' }, model: { model: 'first' } });
  const before = fs.readFileSync(file, 'utf8');

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated crash between write and rename'); };
  try {
    assert.throws(() => saveConfig({ identity: { name: 'Replacement' } }), /simulated crash/);
  } finally {
    fs.renameSync = realRename;
  }

  // Old contents byte-for-byte, still parseable, and no debris left behind.
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(JSON.parse(before).identity.name, 'Original');
  assert.equal(loadConfig().identity.name, 'Original');
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);

  // And the next save still works.
  assert.equal(saveConfig({ identity: { name: 'Replacement' } }).identity.name, 'Replacement');
});

test('a truncated temp file from an earlier crash is ignored', () => {
  const home = freshHome('debris');
  saveConfig({ identity: { name: 'Survivor' } });
  fs.writeFileSync(path.join(home, '.config.json.4242.deadbeef.tmp'), '{"identity":{"name":"Half-writ');

  assert.equal(loadConfig().identity.name, 'Survivor');
  assert.equal(saveConfig({ model: { model: 'still-fine' } }).identity.name, 'Survivor');
});

test('an unparseable config is moved aside rather than silently obeyed', () => {
  const home = freshHome('corrupt');
  const file = path.join(home, 'config.json');
  saveConfig({ identity: { name: 'Before' } });
  fs.writeFileSync(file, '{"identity": {"name": "trunc');

  const cfg = loadConfig();
  assert.equal(cfg.identity.name, '', 'falls back to defaults');
  const aside = fs.readdirSync(home).filter((f) => f.startsWith('config.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.match(fs.readFileSync(path.join(home, aside[0]), 'utf8'), /trunc/);
});

/**
 * REGRESSION. `saveConfig` wrote first and asked whether the result loaded
 * second — its own `loadConfig()` on the last line. `PUT /api/config` with
 * `{"identity": null}` therefore returned 500 having already put `"identity":
 * null` in config.json, the running process went on serving its in-memory
 * snapshot as if nothing had happened, and the next launch died on
 * `cfg.identity.timezone` with a raw stack trace.
 *
 * All four of these do it and all four are checked: `null` dies on the
 * dereference, and `5`, `"Nemo"` and `false` die on the assignment, because a
 * property write to a primitive throws under strict mode. `deepMerge` lets a
 * scalar replace an object on purpose (a patch has to be able to set a `keyRef`
 * to null), so nothing upstream stops any of them.
 */
const NOT_OBJECTS = [null, 5, 'Nemo', false];
const SECTIONS = ['identity', 'model', 'sweep', 'ui', 'privacy'];

test('a save that could not be loaded back is refused before it touches the disk', () => {
  const home = freshHome('unloadable-save');
  const file = path.join(home, 'config.json');
  saveConfig({ identity: { name: 'Nemo' }, model: { model: 'claude-x' } });
  const before = fs.readFileSync(file, 'utf8');

  for (const section of SECTIONS) {
    for (const junk of NOT_OBJECTS) {
      const where = `${section} = ${JSON.stringify(junk)}`;
      assert.throws(() => saveConfig({ [section]: junk }), new RegExp(`${section} must be an object`), where);
      assert.equal(fs.readFileSync(file, 'utf8'), before, `${where}: config.json must be untouched`);
      assert.equal(loadConfig().identity.name, 'Nemo', `${where}: the old config still loads`);
      assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), [], where);
    }
  }

  // The patch itself has to be an object too: an array or a scalar merged
  // straight over the whole config and then threw somewhere further in.
  for (const junk of [null, 5, 'Nemo', false, []]) {
    assert.throws(() => saveConfig(junk), /patch must be an object/, JSON.stringify(junk));
    assert.equal(fs.readFileSync(file, 'utf8'), before, JSON.stringify(junk));
  }

  // And a good save still goes through afterwards.
  assert.equal(saveConfig({ identity: { name: 'Still works' } }).identity.name, 'Still works');
});

/**
 * REGRESSION. `normalizeAccounts` turns a non-array `mail`, `calendars` or
 * `sources` into an empty one, and SECTIONS left those three out of the
 * refuse-on-save rule because of it. So `saveConfig({ mail: 'nope' })` — or
 * null, or `{}`, or a list with a string in it — merged, normalised to `[]`
 * and was written: every configured account gone, with a return value that
 * read as success. The repair is right for the FILE (the end of this test)
 * and wrong for the PATCH, exactly as it is for the object sections above.
 */
test('a patch whose accounts are not a list of objects is refused, and the accounts it would have wiped survive', () => {
  const home = freshHome('account-lists');
  const file = path.join(home, 'config.json');
  saveConfig({
    mail: [{ id: 'm_keep', host: 'imap.example', user: 'keep@example.com' }],
    calendars: [{ id: 'c_keep', kind: 'ics', url: 'https://cal.example/x.ics' }],
    sources: [{ id: 's_keep', type: 'rss', settings: { url: 'https://feed.example/' } }],
  });
  const before = fs.readFileSync(file, 'utf8');

  for (const key of ['mail', 'calendars', 'sources']) {
    for (const junk of ['nope', null, {}, 5, true, [{ id: 'x_ok' }, 'garbage'], [null], [[]]]) {
      const where = `${key} = ${JSON.stringify(junk)}`;
      assert.throws(() => saveConfig({ [key]: junk }), new RegExp(`${key} must be an array of objects`), where);
      assert.equal(fs.readFileSync(file, 'utf8'), before, `${where}: config.json must be untouched`);
    }
  }
  const still = loadConfig();
  assert.equal(still.mail[0].id, 'm_keep');
  assert.equal(still.calendars[0].id, 'c_keep');
  assert.equal(still.sources[0].id, 's_keep');

  // An empty list is still how an account is removed — that has not changed.
  assert.deepEqual(saveConfig({ mail: [] }).mail, []);

  // ...and a FILE carrying the same nonsense still loads, as empty lists:
  // doctor tells people to edit it by hand, and a typo must not brick the app.
  fs.writeFileSync(file, '{\n  "version": 1,\n  "mail": "nope",\n  "calendars": null,\n  "sources": {}\n}\n');
  const repaired = loadConfig();
  assert.deepEqual([repaired.mail, repaired.calendars, repaired.sources], [[], [], []]);
});

test('a config hand-edited into nonsense loads with defaults instead of killing the launch', () => {
  const home = freshHome('unloadable-file');
  const file = path.join(home, 'config.json');
  paths(); // the directory itself, which nothing has had reason to create yet

  for (const section of SECTIONS) {
    for (const junk of NOT_OBJECTS) {
      const where = `${section} = ${JSON.stringify(junk)}`;
      // Written past saveConfig, the way `zelos doctor` tells the user to:
      // "edit <configFile> directly".
      fs.writeFileSync(file, `${JSON.stringify({ version: 1, [section]: junk }, null, 2)}\n`);

      const cfg = loadConfig();
      assert.deepEqual(malformed(cfg), [], where);
      assert.ok(cfg.identity.timezone.length > 0, `${where}: the timezone still resolves`);
      assert.equal(cfg.model.protocol, 'anthropic', where);
      assert.equal(cfg.ui.accent, DEFAULTS.ui.accent, where);
      assert.equal(cfg.privacy.sendBodies, true, where);
      assert.deepEqual(cfg.sweep, DEFAULTS.sweep, where);

      // The next save repairs the file rather than being blocked by it — the
      // user's way out is the Settings panel, which is a save.
      const saved = saveConfig({ identity: { name: 'Rescued' } });
      assert.equal(saved.identity.name, 'Rescued', where);
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(malformed(onDisk), [], `${where}: the section is repaired on disk`);
      assert.equal(validateConfig(saved).ok, true, `${where}: ${JSON.stringify(validateConfig(saved).errors)}`);
    }
  }
});

/** The sections whose value is not an object — the ones nothing can read through. */
function malformed(cfg) {
  return SECTIONS.filter((s) => cfg[s] === null || typeof cfg[s] !== 'object' || Array.isArray(cfg[s]));
}

test('validateConfig() passes a real config and names every bad field', () => {
  freshHome('validate');
  const good = saveConfig({
    identity: { name: 'Nemo', email: 'nemo@example.com', timezone: 'America/Indianapolis' },
    model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3', keyRef: 'model.default' },
    mail: [{ id: 'm_ddd', host: 'imap.example.com', user: 'nemo@example.com', keyRef: 'mail.m_ddd' }],
    calendars: [{ id: 'c_eee', kind: 'ics', url: 'https://cal.example.com/x.ics' }],
  });
  assert.deepEqual(validateConfig(good), { ok: true, errors: [] });

  const bad = validateConfig({
    ...good,
    version: 0,
    identity: { name: 'Nemo', email: 'not-an-email', timezone: 'Mars/Olympus_Mons' },
    model: { ...good.model, protocol: 'telepathy', baseUrl: 'ftp://nope', maxTokens: 0, temperature: 9, keyRef: 'bad ref!' },
    mail: [{ ...good.mail[0], port: 99999, lookbackDays: 0, mailboxes: [] }],
    calendars: [{ ...good.calendars[0], kind: 'runes', url: 'javascript:alert(1)' }],
    sweep: { intervalMinutes: 1, activeHours: [23, 6], auto: 'yes' },
    ui: { accent: 'neon' },
    privacy: { maxItemsPerSweep: 0, sendBodies: 1, bodyChars: 5 },
  });

  assert.equal(bad.ok, false);
  const at = bad.errors.map((e) => e.path);
  for (const p of [
    'version', 'identity.email', 'identity.timezone',
    'model.protocol', 'model.baseUrl', 'model.maxTokens', 'model.temperature', 'model.keyRef',
    'mail[0].port', 'mail[0].lookbackDays', 'mail[0].mailboxes',
    'calendars[0].kind', 'sweep.intervalMinutes', 'sweep.activeHours', 'sweep.auto',
    'ui.accent', 'privacy.maxItemsPerSweep', 'privacy.sendBodies', 'privacy.bodyChars',
  ]) {
    assert.ok(at.includes(p), `expected an error at ${p}, got ${at.join(', ')}`);
  }
  for (const e of bad.errors) assert.equal(typeof e.message, 'string');
});

test('validateConfig() rejects a config carrying a credential', () => {
  freshHome('validate-secret');
  const cfg = loadConfig();
  cfg.mail = [{ ...MAIL_ACCOUNT_DEFAULTS, id: 'm_fff', host: 'h', user: 'u', keyRef: 'mail.m_fff', password: 'hunter2' }];
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path === 'mail[0].password' && /secret store/.test(e.message)));
});

test('validateConfig() rejects non-objects and duplicate ids', () => {
  freshHome('validate-shape');
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig('nope').errors[0].path, '');

  const cfg = saveConfig({ mail: [{ id: 'm_dup', host: 'a', user: 'a' }] });
  cfg.mail.push({ ...cfg.mail[0] });
  assert.ok(validateConfig(cfg).errors.some((e) => /duplicate account id/.test(e.message)));
});

/**
 * REGRESSION. `validateConfig` checked the sections it knew and nothing else,
 * so a top-level key it had never heard of — `sweeps` beside `sweep`, or
 * `privacy ` with a trailing space — was merged, written, echoed back by
 * GET /api/config and called valid by doctor. The setting the user thought
 * they had changed did nothing, and nothing said so. It is named now, and
 * nothing more: the file still loads and still saves, because refusing it
 * would block the very save that removes it.
 */
test('validateConfig() names a top-level key Zelos does not know, and the file still loads and saves', () => {
  const home = freshHome('unknown-keys');
  const file = path.join(home, 'config.json');
  paths(); // the directory, which nothing has had reason to create yet
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    identity: { name: 'Nemo' },
    sweeps: { auto: false },
    'privacy ': { sendBodies: false },
  }, null, 2)}\n`);

  const cfg = loadConfig();
  assert.equal(cfg.identity.name, 'Nemo', 'the file loads');
  assert.equal(cfg.sweep.auto, true, 'the typo never reached the real setting — which is the whole complaint');
  assert.deepEqual(cfg.sweeps, { auto: false }, 'and it is not dropped on the way in');

  const { ok, errors } = validateConfig(cfg);
  assert.equal(ok, false);
  const unknown = errors.filter((e) => /not a setting Zelos knows/.test(e.message));
  assert.deepEqual(unknown.map((e) => e.path).sort(), ['privacy ', 'sweeps']);

  // Still saves, and the key survives the save: reported, never dropped.
  const saved = saveConfig({ identity: { name: 'Still Nemo' } });
  assert.equal(saved.identity.name, 'Still Nemo');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sweeps, { auto: false });

  // The keys other modules own are not unknown: `ai` (core/ai-access.mjs) and
  // `oauth` (core/sources/oauth.mjs) have no block in validateConfig and must
  // not trip this either.
  const theirs = validateConfig({ ...loadConfig(), ai: { enabled: false }, oauth: { google: { clientId: '' } } });
  assert.ok(!theirs.errors.some((e) => e.path === 'ai' || e.path === 'oauth'), JSON.stringify(theirs.errors));
});

test('newId() and isValidRef()', () => {
  assert.match(newId('m'), /^m_[0-9a-f]{6}$/);
  assert.notEqual(newId('c'), newId('c'));
  assert.throws(() => newId('M'), TypeError);
  assert.throws(() => newId('mail account'), TypeError);
  assert.throws(() => newId(''), TypeError);

  assert.ok(isValidRef('model.default'));
  assert.ok(isValidRef('mail.m_9f3a1c'));
  assert.ok(!isValidRef('../escape'));
  assert.ok(!isValidRef('has space'));
  assert.ok(!isValidRef(''));
  assert.ok(!isValidRef('a'.repeat(65)));
});

/**
 * REGRESSION. A mail account with `secure: false` upgraded to TLS only if the
 * server said it could, so a capability list with STARTTLS stripped out of it
 * got the password in the clear and nobody was told. `requireTls` is the
 * standing instruction about that, and it has to survive a config written
 * before it existed — which is every config there is.
 */
test('requireTls defaults to "decide from the host" and is never pinned on the way in', () => {
  freshHome('require-tls');
  assert.equal(MAIL_ACCOUNT_DEFAULTS.requireTls, null);

  const saved = saveConfig({ mail: [{ host: 'imap.example.com', user: 'nemo@example.com' }] });
  assert.equal(saved.mail[0].requireTls, null,
    'an account written before the option existed must not be frozen to a boolean');
  assert.equal(validateConfig(saved).ok, true, JSON.stringify(validateConfig(saved).errors));

  // The account is later pointed at a local bridge and told to allow cleartext.
  const off = saveConfig({ mail: [{ ...saved.mail[0], host: '127.0.0.1', port: 1143, secure: false, requireTls: false }] });
  assert.equal(off.mail[0].requireTls, false, 'an explicit permission has to round-trip through a save');
  assert.equal(validateConfig(off).ok, true);

  const on = saveConfig({ mail: [{ ...off.mail[0], requireTls: true }] });
  assert.equal(on.mail[0].requireTls, true);
  assert.equal(validateConfig(on).ok, true);
});

test('requireTls accepts only true, false and null', () => {
  freshHome('require-tls-validate');
  const base = saveConfig({ mail: [{ host: 'imap.example.com', user: 'nemo@example.com' }] });
  for (const junk of ['yes', 'false', 0, 1, {}, []]) {
    const cfg = structuredClone(base);
    cfg.mail[0].requireTls = junk;
    const result = validateConfig(cfg);
    assert.equal(result.ok, false, JSON.stringify(junk));
    assert.ok(result.errors.some((e) => e.path === 'mail[0].requireTls'), JSON.stringify(junk));
  }
});

/**
 * QA, 2026-10-10, TT-3425. Calendars had no `requireTls` at all, so a CalDAV
 * account or a protected .ics link typed as http:// sent its password in the
 * clear. They get mail's three values, mail's default, and mail's rule that
 * the default is stored as null rather than resolved on the way in.
 */
test('a calendar’s requireTls defaults to "decide from the host", fills in for old calendars, and round-trips', () => {
  const home = freshHome('calendar-require-tls');
  assert.equal(CALENDAR_DEFAULTS.requireTls, null);

  // A calendar written before the field existed: no key at all.
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    calendars: [{ id: 'c_old', enabled: true, label: 'Old', kind: 'caldav', url: 'https://dav.example.test/', user: 'nemo', keyRef: 'calendar.c_old' }],
  }));
  const loaded = loadConfig();
  assert.equal(loaded.calendars[0].requireTls, null, 'normalizeAccounts has to give an old calendar the full shape');
  assert.equal(validateConfig(loaded).ok, true, JSON.stringify(validateConfig(loaded).errors));

  for (const value of [false, true, null]) {
    const saved = saveConfig({ calendars: [{ ...loaded.calendars[0], requireTls: value }] });
    assert.equal(saved.calendars[0].requireTls, value, `${value} did not survive a save`);
    assert.equal(loadConfig().calendars[0].requireTls, value, `${value} did not survive a reload`);
    assert.equal(validateConfig(saved).ok, true);
  }
});

test('a calendar’s requireTls accepts only true, false and null', () => {
  freshHome('calendar-require-tls-validate');
  const base = saveConfig({ calendars: [{ id: 'c_1', kind: 'ics', url: 'https://cal.example.test/feed.ics' }] });
  assert.equal(validateConfig(base).ok, true, JSON.stringify(validateConfig(base).errors));
  for (const junk of ['yes', 'false', 0, 1, {}, []]) {
    const cfg = structuredClone(base);
    cfg.calendars[0].requireTls = junk;
    const result = validateConfig(cfg);
    assert.equal(result.ok, false, JSON.stringify(junk));
    assert.ok(result.errors.some((e) => e.path === 'calendars[0].requireTls'), JSON.stringify(junk));
  }
});

/* ------------------------------------------------------------------ *
 * Sign in with Google: the account's `oauth.provider` and the operator's
 * `oauth.clients`
 * ------------------------------------------------------------------ */

const GOOGLE_CLIENT_ID = '4242-zelos-test.apps.googleusercontent.com';
const ENTRA_CLIENT_ID = '11111111-2222-3333-4444-555555555555';

/** An enabled xoauth2 account with every required field, and the given oauth block. */
function oauthAccount(oauth, patch = {}) {
  return {
    id: 'm_1', enabled: true, label: 'Mailbox', host: 'imap.gmail.com', user: 'nemo@gmail.com',
    port: 993, secure: true, requireTls: null, auth: 'xoauth2', oauth, keyRef: 'mail.m_1',
    mailboxes: ['INBOX'], sentMailbox: 'Sent', lookbackDays: 14, maxMessages: 400,
    ...patch,
  };
}

test('a mail account says which browser sign-in it holds, and one from before the field existed is Microsoft', () => {
  freshHome('oauth-provider');
  const base = loadConfig();
  const check = (oauth, patch) => validateConfig({ ...base, mail: [oauthAccount(oauth, patch)] });
  const pathsOf = (result) => result.errors.map((e) => e.path);

  assert.equal(check({ provider: 'google', clientId: GOOGLE_CLIENT_ID }).ok, true);
  assert.equal(check({ provider: 'microsoft', clientId: ENTRA_CLIENT_ID, tenantId: 'common' }).ok, true);
  // No provider: the block is read the way it was written, as Microsoft's.
  assert.equal(check({ clientId: ENTRA_CLIENT_ID, tenantId: 'consumers' }).ok, true);
  assert.deepEqual(pathsOf(check({ clientId: GOOGLE_CLIENT_ID })), ['mail[0].oauth.clientId'],
    'with no provider a Google-shaped id is still a paste that went wrong, because the block is Microsoft\'s');

  // A Google block needs a Google client id — and not a GUID.
  assert.deepEqual(pathsOf(check({ provider: 'google' })), ['mail[0].oauth.clientId']);
  assert.deepEqual(pathsOf(check({ provider: 'google', clientId: '' })), ['mail[0].oauth.clientId']);
  assert.deepEqual(pathsOf(check({ provider: 'google', clientId: 'has a space' })), ['mail[0].oauth.clientId']);
  assert.equal(check({ provider: 'google', clientId: ENTRA_CLIENT_ID }).ok, true, 'the shape is not pinned to Google\'s suffix');
  assert.deepEqual(pathsOf(check({ provider: 'google', clientId: GOOGLE_CLIENT_ID, tenantId: 42 })), ['mail[0].oauth.tenantId']);
  assert.equal(check({ provider: 'google', clientId: GOOGLE_CLIENT_ID, tenantId: 'anything' }).ok, true, 'a tenant means nothing to Google and is not checked as one');

  // A parked Google account keeps the save unblocked, like a parked Microsoft one.
  assert.equal(check({ provider: 'google' }, { enabled: false }).ok, true);

  // The provider is a closed set.
  for (const bad of ['gmail', 'Google', 'yahoo', 42, {}]) {
    assert.deepEqual(pathsOf(check({ provider: bad, clientId: GOOGLE_CLIENT_ID })), ['mail[0].oauth.provider'], JSON.stringify(bad));
  }
});

test('oauth.clients is the operator\'s own registrations, checked by shape, and the secret itself never lands there', () => {
  const home = freshHome('oauth-clients');
  const base = loadConfig();
  const withClients = (clients) => validateConfig({ ...base, oauth: { clients } });
  const pathsOf = (result) => result.errors.map((e) => e.path);

  assert.equal(withClients({ google: { clientId: GOOGLE_CLIENT_ID }, microsoft: { clientId: ENTRA_CLIENT_ID, tenantId: 'consumers' } }).ok, true);
  assert.equal(withClients({}).ok, true);
  assert.equal(withClients({ google: { clientId: '' } }).ok, true, 'blank means "the shipped default"');
  assert.equal(withClients({ google: { clientId: GOOGLE_CLIENT_ID, clientSecretRef: 'oauth.google.mine' } }).ok, true);
  assert.equal(validateConfig({ ...base, oauth: {} }).ok, true);
  assert.equal(validateConfig({ ...base, oauth: { google: { clientId: '', enabled: false } } }).ok, true,
    'the calendar module\'s own block under oauth is still nobody\'s business here');

  assert.deepEqual(pathsOf(validateConfig({ ...base, oauth: 'nope' })), ['oauth']);
  assert.deepEqual(pathsOf(validateConfig({ ...base, oauth: { clients: [] } })), ['oauth.clients']);
  assert.deepEqual(pathsOf(withClients({ yahoo: { clientId: 'x' } })), ['oauth.clients.yahoo']);
  assert.deepEqual(pathsOf(withClients({ google: 'x' })), ['oauth.clients.google']);
  assert.deepEqual(pathsOf(withClients({ google: { clientId: 42 } })), ['oauth.clients.google.clientId']);
  assert.deepEqual(pathsOf(withClients({ google: { clientId: 'has space' } })), ['oauth.clients.google.clientId']);
  assert.deepEqual(pathsOf(withClients({ microsoft: { clientId: 'not-a-guid' } })), ['oauth.clients.microsoft.clientId']);
  assert.deepEqual(pathsOf(withClients({ microsoft: { clientId: ENTRA_CLIENT_ID, tenantId: '..' } })), ['oauth.clients.microsoft.tenantId']);
  assert.deepEqual(pathsOf(withClients({ google: { clientId: GOOGLE_CLIENT_ID, clientSecretRef: '../escape' } })), ['oauth.clients.google.clientSecretRef']);

  // The value of a secret pasted into the block is dropped on save, at any
  // depth, and nothing under the home carries it.
  const saved = saveConfig({ oauth: { clients: { google: { clientId: GOOGLE_CLIENT_ID, clientSecret: 'GOCSPX-never-on-disk' } } } });
  assert.equal(saved.oauth.clients.google.clientId, GOOGLE_CLIENT_ID);
  assert.equal(saved.oauth.clients.google.clientSecret, undefined);
  const onDisk = fs.readdirSync(home, { recursive: true })
    .map((name) => path.join(home, String(name)))
    .filter((file) => fs.statSync(file).isFile())
    .map((file) => fs.readFileSync(file, 'latin1'));
  assert.ok(onDisk.length > 0, 'the save wrote something');
  assert.ok(onDisk.every((text) => !text.includes('GOCSPX-never-on-disk')), 'the secret reached the disk');
});
