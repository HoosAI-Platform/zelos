import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { open, close, migrate, upsertMessage, upsertItem, upsertDraft, insertCapture, setKV, getKV, indexDoc, search } from '../core/db.mjs';
import { DEFAULTS } from '../core/config.mjs';
import { setSecret, getSecret, resetBackendCache } from '../core/secrets.mjs';
import { createBackup, stageBackup, applyRestore, recoverRestore, recoveryDestination, BACKUP_MAGIC, BACKUP_LIMITS } from '../core/backup.mjs';
import { acquireMaintenance, registerDataConnection, MAINTENANCE_FILE } from '../core/data-lease.mjs';
import { startCore, requestBarrier } from '../desktop/runtime.js';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { diagnose } from '../core/doctor.mjs';
import { recordAccess } from '../core/mcp.mjs';

let dir;
let priorHome;
let priorBackend;
const live = new Set();
const version = '1.8.0';
function fixture(name, text = name) {
  const home = path.join(dir, name); fs.mkdirSync(home, { mode: 0o700 });
  const db = open(path.join(home, 'zelos.db')); live.add(db); migrate(db);
  const config = structuredClone(DEFAULTS); config.identity.name = text; config.sweep.auto = false;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  upsertMessage(db, { sourceId: 'mail_1', uid: 1, messageId: '<one>', subject: text, body: `${text} private archive`, sentAt: '2026-09-01T12:00:00Z' });
  upsertItem(db, { key: 'followup', headline: text, bucket: 'now', kind: 'reply', sourceRefs: [] });
  const item = db.prepare('SELECT id FROM items').get();
  upsertDraft(db, { id: 'draft_1', itemId: item.id, to: 'a@example.test', subject: text, body: `${text} unsent draft` });
  insertCapture(db, `${text} note`);
  setKV(db, 'private.history', text);
  indexDoc(db, { ref: 'capture:test', kind: 'capture', title: text, body: 'searchable uniquephrase' });
  return { home, db };
}
function shut(db) { close(db); live.delete(db); }
function save(fx, filename = `${path.basename(fx.home)}.zelos-backup`) {
  const file = path.join(dir, filename);
  const manifest = createBackup({ ...fx, destination: file, appVersion: version, now: new Date('2026-09-10T12:00:00Z') });
  return { file, manifest };
}
function restorePreparation(target, archive) {
  const staged = stageBackup({ home: target.home, source: archive });
  const recoveryFile = recoveryDestination(target.home);
  createBackup({ ...target, destination: recoveryFile, appVersion: version });
  shut(target.db);
  return { home: target.home, staged, recoveryFile };
}
function rewriteArchive(file, change) {
  const bytes = fs.readFileSync(file);
  const offset = BACKUP_MAGIC.length + 4;
  const size = bytes.readUInt32BE(BACKUP_MAGIC.length);
  const manifest = JSON.parse(bytes.subarray(offset, offset + size).toString());
  const payload = bytes.subarray(offset + size);
  change(manifest, payload);
  const header = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  fs.writeFileSync(file, Buffer.concat([BACKUP_MAGIC, length, header, payload]));
}
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-backup-')));
  priorHome = process.env.ZELOS_HOME; priorBackend = process.env.ZELOS_SECRETS_BACKEND;
  process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file'; resetBackendCache();
});
afterEach(() => {
  for (const db of live) close(db); live.clear();
  if (priorHome === undefined) delete process.env.ZELOS_HOME; else process.env.ZELOS_HOME = priorHome;
  if (priorBackend === undefined) delete process.env.ZELOS_SECRETS_BACKEND; else process.env.ZELOS_SECRETS_BACKEND = priorBackend;
  resetBackendCache(); fs.rmSync(dir, { recursive: true, force: true });
});

describe('portable backup and restore', () => {
  it('flushes copied files through writable handles without truncating backup or rollback data', (t) => {
    const source = fixture('source', 'Original'); const target = fixture('target', 'Current');
    const handles = new Map(); const copied = new Set(); const synced = new Set();
    const { openSync, closeSync, copyFileSync, fsyncSync } = fs;
    t.mock.method(fs, 'openSync', function (file, flags, ...args) {
      const fd = openSync.call(fs, file, flags, ...args); handles.set(fd, { file, flags }); return fd;
    });
    t.mock.method(fs, 'closeSync', function (fd) { try { return closeSync.call(fs, fd); } finally { handles.delete(fd); } });
    t.mock.method(fs, 'copyFileSync', function (from, to, ...args) { const result = copyFileSync.call(fs, from, to, ...args); copied.add(to); return result; });
    t.mock.method(fs, 'fsyncSync', function (fd) {
      const opened = handles.get(fd);
      if (opened && fs.fstatSync(fd).isFile()) {
        const writable = typeof opened.flags === 'number'
          ? Boolean(opened.flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR))
          : /[wa+]/.test(opened.flags);
        // Windows FlushFileBuffers rejects read-only regular-file handles.
        // Model that OS contract on every host, but perform the real flush.
        if (!writable) throw Object.assign(new Error('EPERM: read-only handle cannot be flushed'), { code: 'EPERM', syscall: 'fsync' });
        synced.add(opened.file);
      }
      return fsyncSync.call(fs, fd);
    });
    const prepared = restorePreparation(target, save(source).file);
    applyRestore(prepared);
    assert.ok(copied.size > 0);
    for (const file of copied) assert.ok(synced.has(file), 'every copied file must reach a real flush');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.home, 'config.json'))).identity.name, 'Original');
    const restored = open(path.join(target.home, 'zelos.db')); live.add(restored);
    assert.equal(getKV(restored, 'private.history'), 'Original');
    const old = stageBackup({ home: source.home, source: prepared.recoveryFile });
    assert.equal(JSON.parse(fs.readFileSync(path.join(old.directory, 'new', 'config.json'))).identity.name, 'Current'); old.cleanup();
  });

  it('round-trips all SQLite data, FTS, settings, and encrypted credentials with a private recovery copy', async () => {
    const source = fixture('source', 'Original');
    process.env.ZELOS_HOME = source.home;
    await setSecret('model.default', 'fixture-only-secret');
    recordAccess(source.db, { tool: 'zelos_board', rows: 1, detail: 'fixture access history' });
    fs.mkdirSync(path.join(source.home, 'logs'), { recursive: true }); fs.writeFileSync(path.join(source.home, 'logs', 'private.log'), 'not portable');
    fs.mkdirSync(path.join(source.home, 'cache'), { recursive: true }); fs.writeFileSync(path.join(source.home, 'cache', 'temporary'), 'not portable');
    const before = source.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
      .map(({ name }) => [name, source.db.prepare(`SELECT * FROM \"${name}\"`).all()]);
    const { file, manifest } = save(source);
    assert.equal(manifest.credentials, 'encrypted-file-included');
    assert.equal(manifest.counts.messages, 1); assert.equal(manifest.counts.drafts, 1);
    assert.equal(manifest.counts.item_history, 1);
    assert.ok(!manifest.files.some((f) => /^(logs|cache)\//.test(f.path)));
    assert.ok(!JSON.stringify(manifest).includes('fixture-only-secret'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const target = fixture('target', 'Current');
    const prepared = restorePreparation(target, file);
    applyRestore(prepared);
    assert.ok(fs.existsSync(prepared.recoveryFile));
    assert.equal(fs.existsSync(path.join(target.home, '.restore-journal.json')), false);
    const restored = open(path.join(target.home, 'zelos.db')); live.add(restored);
    for (const [name, rows] of before) assert.deepEqual(restored.prepare(`SELECT * FROM \"${name}\"`).all(), rows, name);
    assert.equal(getKV(restored, 'private.history'), 'Original');
    assert.equal(search(restored, 'uniquephrase').length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.home, 'config.json'))).identity.name, 'Original');
    process.env.ZELOS_HOME = target.home; resetBackendCache();
    assert.equal(await getSecret('model.default'), 'fixture-only-secret');
    // The retained automatic copy is itself valid and contains the old data.
    const rollback = stageBackup({ home: source.home, source: prepared.recoveryFile });
    assert.equal(JSON.parse(fs.readFileSync(path.join(rollback.directory, 'new', 'config.json'))).identity.name, 'Current');
    rollback.cleanup();
  });

  it('snapshots committed WAL content without copying a live WAL or SHM', () => {
    const fx = fixture('wal');
    fx.db.exec('PRAGMA wal_autocheckpoint=0');
    setKV(fx.db, 'last-keystroke', 'committed in WAL');
    assert.ok(fs.statSync(path.join(fx.home, 'zelos.db-wal')).size > 0);
    const { file, manifest } = save(fx);
    assert.ok(!manifest.files.some((f) => /-(wal|shm)$/.test(f.path)));
    const stage = stageBackup({ home: fx.home, source: file });
    const copy = open(path.join(stage.directory, 'new', 'zelos.db')); live.add(copy);
    assert.equal(getKV(copy, 'last-keystroke'), 'committed in WAL');
    shut(copy); stage.cleanup();
  });

  it('rejects tampering, truncation, invalid paths, duplicates, size bombs and foreign schemas before changing current data', () => {
    const source = fixture('source'); const target = fixture('target');
    const original = save(source).file;
    const variants = [
      (f) => { const b = fs.readFileSync(f); b[b.length - 1] ^= 1; fs.writeFileSync(f, b); },
      (f) => fs.truncateSync(f, fs.statSync(f).size - 1),
      (f) => rewriteArchive(f, (m) => { m.files[0].path = '../config.json'; }),
      (f) => rewriteArchive(f, (m) => { m.files[0].path = '/tmp/config.json'; }),
      (f) => rewriteArchive(f, (m) => { m.files[0].path = 'secrets.migrated/../../outside'; }),
      (f) => rewriteArchive(f, (m) => { m.files.push(m.files[0]); }),
      (f) => rewriteArchive(f, (m) => { m.files[0].size = BACKUP_LIMITS.total + 1; }),
      (f) => rewriteArchive(f, (m) => { m.schemaVersion += 1; }),
      (f) => rewriteArchive(f, (m) => { m.counts.messages += 1; }),
    ];
    for (let i = 0; i < variants.length; i++) {
      const file = path.join(dir, `bad-${i}.zelos-backup`); fs.copyFileSync(original, file); variants[i](file);
      assert.throws(() => stageBackup({ home: target.home, source: file }), /Backup:/, `variant ${i}`);
      assert.equal(getKV(target.db, 'private.history'), 'target');
      assert.deepEqual(fs.readdirSync(target.home).filter((name) => name.startsWith('.restore-')), []);
    }
  });

  it('refuses extra SQL objects even when the attacker recomputes file hashes', () => {
    const source = fixture('source'); const { file } = save(source);
    const stage = stageBackup({ home: source.home, source: file });
    const copyPath = path.join(stage.directory, 'new', 'zelos.db');
    const copy = open(copyPath); copy.exec('CREATE VIEW malicious AS SELECT 1'); shut(copy);
    const replacement = fs.readFileSync(copyPath);
    const original = fs.readFileSync(file); const offset = BACKUP_MAGIC.length + 4;
    const size = original.readUInt32BE(BACKUP_MAGIC.length);
    const manifest = JSON.parse(original.subarray(offset, offset + size));
    let p = offset + size;
    const payloads = manifest.files.map((f) => { const b = original.subarray(p, p + f.size); p += f.size; if (f.path !== 'zelos.db') return b; f.size = replacement.length; f.sha256 = crypto.createHash('sha256').update(replacement).digest('hex'); return replacement; });
    const header = Buffer.from(JSON.stringify(manifest)); const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    fs.writeFileSync(file, Buffer.concat([BACKUP_MAGIC, length, header, ...payloads])); stage.cleanup();
    assert.throws(() => stageBackup({ home: source.home, source: file }), /structure is not a recognized/);
  });

  it('rejects symlink input, output, portable data, and credential directories', { skip: process.platform === 'win32' }, () => {
    const fx = fixture('source'); const { file } = save(fx);
    const linked = path.join(dir, 'linked'); fs.symlinkSync(file, linked);
    assert.throws(() => stageBackup({ home: fx.home, source: linked }), /link/);
    assert.throws(() => createBackup({ ...fx, destination: linked, appVersion: version }), /link/);
    fs.symlinkSync(path.join(fx.home, 'config.json'), path.join(fx.home, '.seed'));
    assert.throws(() => save(fx, 'second.zelos-backup'), /link/);
    fs.unlinkSync(path.join(fx.home, '.seed'));
    fs.symlinkSync(dir, path.join(fx.home, 'secrets.migrated'));
    assert.throws(() => save(fx, 'third.zelos-backup'), /link/);
  });

  it('refuses overwriting active data and retains a previous output on failure', () => {
    const fx = fixture('source'); const before = fs.readFileSync(path.join(fx.home, 'config.json'));
    assert.throws(() => createBackup({ ...fx, destination: path.join(fx.home, 'config.json'), appVersion: version }), /outside the active/);
    assert.deepEqual(fs.readFileSync(path.join(fx.home, 'config.json')), before);
    const destination = path.join(dir, 'existing.zelos-backup'); fs.writeFileSync(destination, 'keep me');
    fs.writeFileSync(path.join(fx.home, 'secrets.enc'), '{}');
    assert.throws(() => createBackup({ ...fx, destination, appVersion: version }), /credential/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'keep me');
  });

  it('automatically rolls back a mid-replacement failure and leaves the recovery archive', () => {
    const source = fixture('source'); const target = fixture('target');
    const prepared = restorePreparation(target, save(source).file);
    assert.throws(() => applyRestore({ ...prepared, onStep: (step) => { if (step === 'installed:zelos.db') throw new Error('fixture disk failure'); } }), /fixture disk failure/);
    const current = open(path.join(target.home, 'zelos.db')); live.add(current);
    assert.equal(getKV(current, 'private.history'), 'target');
    assert.ok(fs.existsSync(prepared.recoveryFile));
    assert.equal(fs.existsSync(path.join(target.home, '.restore-journal.json')), false);
  });

  it('rechecks staged bytes immediately before replacement', () => {
    const source = fixture('source'); const target = fixture('target');
    const prepared = restorePreparation(target, save(source).file);
    const file = path.join(prepared.staged.directory, 'new', 'config.json');
    const config = JSON.parse(fs.readFileSync(file)); config.identity.name = 'Changed after preview'; fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => applyRestore(prepared), /integrity check/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target.home, 'config.json'))).identity.name, 'target');
    assert.equal(fs.existsSync(path.join(target.home, '.restore-journal.json')), false);
    assert.ok(fs.existsSync(prepared.recoveryFile));
  });

  for (const checkpoint of ['journal', 'installed:zelos.db', 'committed']) {
    it(`recovers after a hard process exit at ${checkpoint}`, () => {
      const source = fixture('source'); const target = fixture('target');
      const prepared = restorePreparation(target, save(source).file);
      const moduleURL = pathToFileURL(path.resolve('core/backup.mjs')).href;
      const script = `const {applyRestore}=await import(${JSON.stringify(moduleURL)}); applyRestore({...${JSON.stringify(prepared)},onStep:(step)=>{if(step===${JSON.stringify(checkpoint)})process.exit(73)}});`;
      assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' }), (err) => err.status === 73);
      assert.ok(fs.existsSync(path.join(target.home, '.restore-journal.json')));
      assert.throws(() => open(path.join(target.home, 'zelos.db')), /restore needs recovery/);
      const lease = acquireMaintenance({ home: target.home, recovering: true });
      try { assert.equal(recoverRestore({ home: target.home }).recovered, checkpoint !== 'committed'); } finally { lease.release(); }
      const current = open(path.join(target.home, 'zelos.db')); live.add(current);
      assert.equal(getKV(current, 'private.history'), checkpoint === 'committed' ? 'source' : 'target');
      assert.ok(fs.existsSync(prepared.recoveryFile));
      assert.deepEqual(recoverRestore({ home: target.home }), { recovered: false });
    });
  }

  it('keeps the journal and archive intact when rollback bytes are damaged', () => {
    const source = fixture('source'); const target = fixture('target');
    const prepared = restorePreparation(target, save(source).file);
    const moduleURL = pathToFileURL(path.resolve('core/backup.mjs')).href;
    const script = `const {applyRestore}=await import(${JSON.stringify(moduleURL)}); applyRestore({...${JSON.stringify(prepared)},onStep:(step)=>{if(step==='journal')process.exit(73)}});`;
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' }), (err) => err.status === 73);
    fs.writeFileSync(path.join(prepared.staged.directory, 'old', 'config.json'), '{}');
    const current = fs.readFileSync(path.join(target.home, 'zelos.db'));
    assert.throws(() => recoverRestore({ home: target.home }), /integrity check/);
    assert.deepEqual(fs.readFileSync(path.join(target.home, 'zelos.db')), current);
    assert.ok(fs.existsSync(path.join(target.home, '.restore-journal.json')));
    assert.ok(fs.existsSync(prepared.recoveryFile));
  });
});

describe('maintenance leases', () => {
  it('blocks another open connection, then blocks new opens until maintenance ends', () => {
    const fx = fixture('source');
    const other = open(path.join(fx.home, 'zelos.db')); live.add(other);
    assert.throws(() => acquireMaintenance({ home: fx.home, connection: fx.db }), /another Zelos/);
    shut(other);
    const lease = acquireMaintenance({ home: fx.home, connection: fx.db });
    assert.throws(() => open(path.join(fx.home, 'zelos.db')), /backing up or restoring/);
    assert.throws(() => registerDataConnection(path.join(fx.home, 'other.db')), /backing up or restoring/);
    lease.release();
    const reopened = open(path.join(fx.home, 'zelos.db')); shut(reopened);
  });

  it('reclaims a provably dead lease but refuses unreadable metadata', () => {
    const fx = fixture('source');
    const leases = path.join(fx.home, '.data-connections');
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(leases, `${id}.json`), JSON.stringify({ id, pid: process.pid, startedAt: '2000-01-01T00:00:00Z', uid: process.getuid?.() ?? null }));
    const held = acquireMaintenance({ home: fx.home, connection: fx.db }); held.release();
    assert.equal(fs.existsSync(path.join(leases, `${id}.json`)), false);
    fs.writeFileSync(path.join(fx.home, MAINTENANCE_FILE, `${crypto.randomUUID()}.json`), '{');
    assert.throws(() => acquireMaintenance({ home: fx.home, connection: fx.db }), /another Zelos/);
  });

  it('cannot grant two owners when stale-marker cleanup interleaves with another acquisition', (t) => {
    const fx = fixture('race'); shut(fx.db);
    const markers = path.join(fx.home, MAINTENANCE_FILE); fs.mkdirSync(markers);
    const id = crypto.randomUUID();
    const staleFile = path.join(markers, `${id}.json`);
    fs.writeFileSync(staleFile, JSON.stringify({ id, pid: process.pid, startedAt: '2000-01-01T00:00:00Z', uid: process.getuid?.() ?? null }));
    const read = fs.readFileSync;
    let reads = 0; let competing; let refused;
    t.mock.method(fs, 'readFileSync', function (file, ...args) {
      const result = read.call(fs, file, ...args);
      if (file === staleFile && ++reads === 2) {
        // The older singleton implementation unlinked a newly published owner
        // after this read returned stale bytes. Immutable UUID paths cannot.
        try { competing = acquireMaintenance({ home: fx.home }); } catch (err) { refused = err; }
      }
      return result;
    });
    const owner = acquireMaintenance({ home: fx.home });
    assert.equal(competing, undefined); assert.equal(refused?.code, 'ZELOS_DATA_BUSY');
    assert.equal(fs.readdirSync(markers).length, 1);
    owner.release(); assert.equal(fs.readdirSync(markers).length, 0);
  });

  it('keeps normal database access through an explicitly chosen data-home symlink', { skip: process.platform === 'win32' }, () => {
    const fx = fixture('physical');
    const alias = path.join(dir, 'alias'); fs.symlinkSync(fx.home, alias);
    const other = open(path.join(alias, 'zelos.db')); live.add(other);
    assert.equal(getKV(other, 'private.history'), 'physical');
    assert.throws(() => acquireMaintenance({ home: fx.home, connection: fx.db }), /another Zelos/);
    shut(other);
    const maintenance = acquireMaintenance({ home: alias, connection: fx.db }); maintenance.release();
    const archive = path.join(dir, 'alias.zelos-backup');
    createBackup({ home: alias, db: fx.db, destination: archive, appVersion: version });
    const staged = stageBackup({ home: alias, source: archive });
    assert.equal(staged.manifest.counts.messages, 1); staged.cleanup();
  });

  it('does not require hard-link support for normal data access or maintenance', (t) => {
    t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('linkless filesystem'), { code: 'ENOTSUP' }); });
    const fx = fixture('linkless');
    const lease = acquireMaintenance({ home: fx.home, connection: fx.db });
    assert.throws(() => open(path.join(fx.home, 'zelos.db')), /backing up or restoring/);
    lease.release();
    assert.equal(getKV(fx.db, 'private.history'), 'linkless');
  });

  it('protects the complete doctor lifetime, including delayed credential checks', async () => {
    const fx = fixture('doctor'); shut(fx.db); process.env.ZELOS_HOME = fx.home;
    let entered; let release;
    const began = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const diagnosis = diagnose({ config: structuredClone(DEFAULTS), deps: {
      backend: async () => { entered(); await waiting; return { name: 'encrypted-file', writable: true }; },
      getSecret: async () => null,
    } });
    await began;
    assert.throws(() => acquireMaintenance({ home: fx.home }), /another Zelos/);
    release(); await diagnosis;
    const lease = acquireMaintenance({ home: fx.home });
    try {
      await assert.rejects(diagnose({ deps: { backend: async () => { throw new Error('must not reach credentials'); } } }), /backing up or restoring/);
      fs.writeFileSync(path.join(fx.home, 'config.json'), '{');
      assert.throws(() => execFileSync(process.execPath, [path.resolve('zelos.mjs'), '--home', fx.home, 'doctor', '--json'], { stdio: 'pipe', env: { ...process.env, ZELOS_SECRETS_BACKEND: 'encrypted-file' } }), (err) => err.status !== 0 && /backing up or restoring/.test(err.stderr.toString()));
      assert.equal(fs.readFileSync(path.join(fx.home, 'config.json'), 'utf8'), '{', 'CLI must not repair settings during restore');
    } finally { lease.release(); }
  });
});

describe('native runtime maintenance', () => {
  it('runs backup workers when the native runtime is launched through a module-evaluation harness', () => {
    const fx = fixture('eval-runtime'); shut(fx.db);
    const destination = path.join(dir, 'eval-runtime.zelos-backup');
    const runtimeURL = pathToFileURL(path.resolve('desktop/runtime.js')).href;
    const script = `const {startCore}=await import(${JSON.stringify(runtimeURL)}); const core=await startCore(${JSON.stringify({ root: path.resolve('.'), home: fx.home, port: 0 })}); try {await core.createBackup(${JSON.stringify(destination)}, {appVersion:'1.8.0'}); console.log('worker-backup-passed');} finally {await core.stop();}`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ZELOS_LOG_LEVEL: 'silent', ZELOS_SECRETS_BACKEND: 'encrypted-file' } });
    assert.match(result, /worker-backup-passed/);
    assert.ok(fs.statSync(destination).size > 0);
  });

  it('tracks work after a response is closed and hands the pause to the server to enforce', async () => {
    const server = new EventEmitter();
    let unavailable = false;
    server.zelos = { setUnavailable: (next) => { unavailable = next; } };
    let finish;
    let calls = 0;
    server.on('request', async () => { calls++; await new Promise((resolve) => { finish = resolve; }); });
    const barrier = requestBarrier(server);
    server.emit('request', {}, {});
    await Promise.resolve();
    barrier.pause();
    assert.equal(unavailable, true);
    assert.equal(barrier.idle(), false);
    finish(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(barrier.idle(), true);
    barrier.resume();
    assert.equal(unavailable, false);
  });

  it('keeps the Host, Origin and token checks, and the security headers, while a backup holds the board', async () => {
    /* The pause used to answer 503 in front of the whole pipeline, so during a
       backup a rebound Host or a foreign Origin got a 503 with no
       X-Frame-Options instead of the 403 a running board gives them. Hold a
       real backup at its quiesce step and ask. */
    const fx = fixture('paused'); shut(fx.db);
    const core = await startCore({ root: path.resolve('.'), home: fx.home, port: 0 });
    // Quiesce asks twice; one gate holds both, so releasing it lets the backup run.
    let finish;
    let markHeld;
    const held = new Promise((resolve) => { markHeld = resolve; });
    const gate = new Promise((resolve) => { finish = resolve; });
    const original = core.server.zelos.cancelSignInsAndWait;
    core.server.zelos.cancelSignInsAndWait = () => { markHeld(); return gate; };
    const ask = (pathname, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: core.port, path: pathname, headers }, (res) => {
        res.resume(); res.on('end', () => resolve(res));
      });
      req.on('error', reject); req.end();
    });
    const own = `127.0.0.1:${core.port}`;
    let backup;
    try {
      backup = core.createBackup(path.join(dir, 'paused.zelos-backup'), { appVersion: version, timeoutMs: 10_000 });
      // A backup that fails before it reaches quiesce fails the test here, not hangs it.
      await Promise.race([held, backup]);

      const rebound = await ask('/api/state', { host: `evil.example:${core.port}`, 'x-zelos-token': core.token });
      assert.equal(rebound.statusCode, 403, 'a rebound Host is refused, paused or not');
      assert.equal(rebound.headers['x-frame-options'], 'DENY');
      const foreign = await ask('/api/state', { host: own, origin: 'http://evil.example', 'x-zelos-token': core.token });
      assert.equal(foreign.statusCode, 403, 'a foreign Origin is refused, paused or not');
      assert.equal(foreign.headers['x-frame-options'], 'DENY');
      const tokenless = await ask('/api/state', { host: own });
      assert.equal(tokenless.statusCode, 401, 'an API caller without the token learns nothing about the pause');

      const api = await ask('/api/state', { host: own, 'x-zelos-token': core.token });
      assert.equal(api.statusCode, 503);
      assert.equal(api.headers['retry-after'], '2');
      assert.equal(api.headers['x-frame-options'], 'DENY');
      assert.match(api.headers['content-security-policy'], /default-src 'self'/);
      for (const pathname of ['/', '/api/mcp']) {
        const page = await ask(pathname, { host: own });
        assert.equal(page.statusCode, 503, `${pathname} waits for the backup too`);
        assert.equal(page.headers['x-frame-options'], 'DENY');
      }

      finish();
      await backup;
      const after = await ask('/api/state', { host: own, 'x-zelos-token': core.token });
      assert.equal(after.statusCode, 200, 'the board answers again once the backup is done');
    } finally {
      finish();
      await backup?.catch(() => {});
      core.server.zelos.cancelSignInsAndWait = original;
      await core.stop();
    }
  });

  it('exports through a quiescent live core, resumes its API, restores and reopens with the saved data', async () => {
    const fx = fixture('runtime', 'Saved runtime'); shut(fx.db);
    const root = path.resolve('.');
    let core = await startCore({ root, home: fx.home, port: 0 });
    try {
      const archive = path.join(dir, 'runtime.zelos-backup');
      await core.createBackup(archive, { appVersion: version });
      const state = await fetch(new URL('api/state', core.url), { headers: { 'X-Zelos-Token': core.token } });
      assert.equal(state.status, 200);
      setKV(core.db, 'private.history', 'Changed since backup');
      const staged = await core.stageBackup(archive);
      await core.restoreBackup(staged, { appVersion: version });
      assert.equal(core.closed, true);
      await core.stop();
      core = await startCore({ root, home: fx.home, port: 0 });
      assert.equal(getKV(core.db, 'private.history'), 'Saved runtime');
      assert.equal(fs.readdirSync(path.join(fx.home, 'backups')).length, 1);
    } finally { await core.stop(); }
  });

  it('refuses maintenance while another client is open, leaving its API and data usable', async () => {
    const fx = fixture('runtime'); shut(fx.db);
    const core = await startCore({ root: path.resolve('.'), home: fx.home, port: 0 });
    const client = open(path.join(fx.home, 'zelos.db')); live.add(client);
    try {
      await assert.rejects(core.createBackup(path.join(dir, 'refused.zelos-backup'), { appVersion: version }), /another Zelos/);
      assert.equal(getKV(core.db, 'private.history'), 'runtime');
      const response = await fetch(new URL('api/state', core.url), { headers: { 'X-Zelos-Token': core.token } });
      assert.equal(response.status, 200);
    } finally { shut(client); await core.stop(); }
  });

  it('times out an unfinished credential write without closing SQLite or leaving the board paused', async () => {
    const fx = fixture('runtime'); shut(fx.db);
    const core = await startCore({ root: path.resolve('.'), home: fx.home, port: 0 });
    let finish;
    const original = core.server.zelos.cancelSignInsAndWait;
    core.server.zelos.cancelSignInsAndWait = () => new Promise((resolve) => { finish = resolve; });
    try {
      await assert.rejects(core.createBackup(path.join(dir, 'refused.zelos-backup'), { appVersion: version, timeoutMs: 40 }), /still finishing/);
      assert.equal(core.closed, false);
      assert.equal(getKV(core.db, 'private.history'), 'runtime');
      const response = await fetch(new URL('api/state', core.url), { headers: { 'X-Zelos-Token': core.token } });
      assert.equal(response.status, 200);
      assert.equal(fs.readdirSync(path.join(fx.home, MAINTENANCE_FILE)).length, 0);
      finish(); await new Promise((resolve) => setImmediate(resolve));
    } finally { core.server.zelos.cancelSignInsAndWait = original; await core.stop(); }
  });
});
