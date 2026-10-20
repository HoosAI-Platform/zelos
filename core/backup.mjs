/**
 * Portable, private backups. No secret is returned to a caller: credential files
 * travel as opaque bytes in an owner-only archive selected by the native shell.
 *
 * Format 1: ASCII magic, uint32-BE manifest length, UTF-8 JSON manifest, then
 * each file's raw bytes in manifest order. No compression, archive executable,
 * dependency, absolute path, or memory-sized database string is involved.
 * SHA-256 detects damage; it is not a signature. Only restore your own backups.
 *
 * Callers must hold the home's maintenance lease and stop all writers before
 * snapshot/replacement. Restore stages and verifies first, then journals a
 * replacement whose rollback files remain intact until commit. Startup must
 * recover an unfinished journal before opening SQLite or loading configuration.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, migrate } from './db.mjs';
import { DEFAULTS, isValidRef, writeFileAtomic } from './config.mjs';
import { listAccessLog } from './mcp.mjs';

export const BACKUP_MAGIC = Buffer.from('ZELOS-BACKUP\r\n\x1a\n');
export const BACKUP_LIMITS = Object.freeze({ manifest: 1024 * 1024, files: 10_000, metadata: 16 * 1024 * 1024, total: 64 * 1024 ** 3 });
const ROOT_FILES = new Set(['zelos.db', 'config.json', 'secrets.backend.json', 'secrets.index.json', 'secrets.namespace.json', '.seed', 'secrets.enc']);
const JOURNAL = '.restore-journal.json';
const CHUNK = 256 * 1024;
const BACKENDS = new Set(['encrypted-file', 'macos-keychain', 'windows-dpapi', 'libsecret']);
const COUNTS = ['messages', 'events', 'items', 'drafts', 'captures', 'runs', 'item_history'];
const failure = (message) => new Error(`Backup: ${message}`);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function portable(name) {
  return typeof name === 'string' && (ROOT_FILES.has(name)
    || /^(?:\.seed|secrets\.enc)\.unreadable-[0-9]+$/.test(name)
    || /^secrets\.migrated\/[a-f0-9]{32}\.[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name));
}

function rootEntry(name) { return name === 'secrets.migrated' || (portable(name) && !name.includes('/')); }
function exists(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function regular(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw failure('a file is a link or is not a regular file. Nothing was replaced.');
  return st;
}
function directory(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw failure('a data directory is a link or is not a directory.');
  return fs.realpathSync(dir);
}
function dataHome(home) {
  // The configured root may be an intentional alias to another drive. Resolve
  // that one boundary once; portable entries and all internal directories are
  // still checked with lstat and may never redirect outside the resolved home.
  if (!fs.statSync(home).isDirectory()) throw failure('the data home is not a directory.');
  return fs.realpathSync(home);
}
function privateDir(dir) { fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o700); return dir; }
function syncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (err) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(err.code)) throw err; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function copyPrivate(from, to) {
  regular(from);
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, 0o600);
  // Windows FlushFileBuffers requires write access. Reopen without truncating
  // the bytes copyFileSync just wrote; a read-only handle fails with EPERM.
  const fd = fs.openSync(to, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJSON(file) {
  if (regular(file).size > BACKUP_LIMITS.metadata) throw failure('a settings or credential file is too large.');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw failure('a settings or credential file is not valid JSON.'); }
}

function filesIn(home) {
  directory(home);
  const files = [];
  for (const name of fs.readdirSync(home).sort()) {
    if (name === 'secrets.migrated') {
      directory(path.join(home, name));
      for (const child of fs.readdirSync(path.join(home, name)).sort()) {
        const rel = `${name}/${child}`;
        if (!portable(rel)) throw failure('an unrecognized credential migration file cannot be backed up safely.');
        regular(path.join(home, rel));
        files.push(rel);
      }
    } else if (portable(name)) {
      regular(path.join(home, name));
      files.push(name);
    }
  }
  return files.sort();
}

function digestFile(file) {
  const before = regular(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const hash = crypto.createHash('sha256');
  const bytes = Buffer.allocUnsafe(CHUNK);
  let size = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, bytes, 0, bytes.length, null);
      if (!n) break;
      size += n;
      if (size > BACKUP_LIMITS.total) throw failure('the backup exceeds the supported 64 GB size.');
      hash.update(bytes.subarray(0, n));
    }
    const after = fs.fstatSync(fd);
    if (size !== before.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw failure('a file changed during backup. Please try again.');
  } finally { fs.closeSync(fd); }
  return { size, sha256: hash.digest('hex') };
}

let expectedSchemas;
function schema(db) {
  return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all()
    .map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, ' ').trim() ?? null }));
}
function inspectDatabase(file) {
  regular(file);
  const db = new DatabaseSync(file, { readOnly: true, enableDoubleQuotedStringLiterals: false });
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== SCHEMA_VERSION) throw failure('this database uses a different schema. Restore with the Zelos version that created this backup.');
    if (!expectedSchemas) {
      const reference = new DatabaseSync(':memory:');
      try {
        migrate(reference);
        expectedSchemas = new Set([JSON.stringify(schema(reference))]);
        // MCP creates its audit table lazily outside migrations. Preserve that
        // history while accepting only the exact schema its own code creates.
        listAccessLog(reference);
        expectedSchemas.add(JSON.stringify(schema(reference)));
      } finally { reference.close(); }
    }
    if (!expectedSchemas.has(JSON.stringify(schema(db)))) throw failure('the database structure is not a recognized Zelos schema.');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw failure('the database failed its integrity check.');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw failure('the database has broken references.');
    const counts = Object.fromEntries(COUNTS.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
    return { schemaVersion: version, counts };
  } finally { db.close(); }
}

function inspectData(home) {
  const cfg = readJSON(path.join(home, 'config.json'));
  if (!plain(cfg) || (cfg.version !== undefined && cfg.version !== 1)) throw failure('the settings format is not supported.');
  for (const key of ['identity', 'model', 'sweep', 'ui', 'privacy', 'ai', 'oauth']) {
    if (cfg[key] !== undefined && !plain(cfg[key])) throw failure('the settings contain a malformed section.');
  }
  for (const key of ['mail', 'calendars', 'sources']) {
    if (cfg[key] !== undefined && (!Array.isArray(cfg[key]) || !cfg[key].every(plain))) throw failure('the account settings are malformed.');
  }
  const checkKeys = (value, depth = 0) => {
    if (depth > 40) throw failure('the settings are nested too deeply.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw failure('the settings contain an unsafe key.');
      checkKeys(child, depth + 1);
    }
  };
  checkKeys(cfg);
  const optional = (name) => exists(path.join(home, name)) ? readJSON(path.join(home, name)) : null;
  const backend = optional('secrets.backend.json');
  if (backend && (!plain(backend) || !BACKENDS.has(backend.backend))) throw failure('the credential backend record is malformed.');
  const index = optional('secrets.index.json');
  if (index && (!Array.isArray(index.refs) || !index.refs.every(isValidRef))) throw failure('the credential index is malformed.');
  const namespace = optional('secrets.namespace.json');
  if (namespace && (namespace.version !== 1 || !/^[a-f0-9]{32}$/.test(namespace.id) || !Array.isArray(namespace.legacyRefs) || !namespace.legacyRefs.every(isValidRef))) throw failure('the credential namespace is malformed.');
  const encrypted = optional('secrets.enc');
  if (encrypted) {
    const seedFile = path.join(home, '.seed');
    if (!exists(seedFile) || regular(seedFile).size > 128 || !/^[a-f0-9]{64}$/i.test(fs.readFileSync(seedFile, 'utf8').trim())) throw failure('the encrypted credential store has no usable seed.');
    const kdf = encrypted.kdf;
    if (encrypted.v !== 1 || kdf?.name !== 'scrypt' || kdf.N !== 32768 || kdf.r !== 8 || kdf.p !== 1 || kdf.len !== 32
        || !/^[a-f0-9]{32}$/i.test(kdf.salt) || !/^[a-f0-9]{24}$/i.test(encrypted.iv) || !/^[a-f0-9]{32}$/i.test(encrypted.tag)
        || typeof encrypted.ct !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encrypted.ct)) throw failure('the encrypted credential format is not supported.');
    try {
      const seed = Buffer.from(fs.readFileSync(seedFile, 'utf8').trim(), 'hex');
      const key = crypto.scryptSync(seed, Buffer.from(kdf.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'hex'));
      decipher.setAAD(Buffer.from('zelos.secrets.v1'));
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
      const text = Buffer.concat([decipher.update(Buffer.from(encrypted.ct, 'base64')), decipher.final()]);
      try {
        const secrets = JSON.parse(text.toString('utf8'));
        if (!plain(secrets) || !Object.entries(secrets).every(([ref, value]) => isValidRef(ref) && typeof value === 'string')) throw new Error('bad store');
      } finally { text.fill(0); key.fill(0); seed.fill(0); }
    } catch { throw failure('the encrypted credentials failed their integrity check.'); }
  }
  return { ...inspectDatabase(path.join(home, 'zelos.db')), credentials: encrypted ? 'encrypted-file-included' : 'reconnect-may-be-needed' };
}

function manifestValid(manifest) {
  if (!plain(manifest) || manifest.format !== 1 || !Array.isArray(manifest.files) || manifest.files.length > BACKUP_LIMITS.files
      || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
      || typeof manifest.appVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.appVersion)
      || manifest.schemaVersion !== SCHEMA_VERSION || !plain(manifest.counts)) throw failure('the archive header is unsupported or damaged.');
  let size = 0;
  const seen = new Set();
  for (const file of manifest.files) {
    if (!plain(file) || !portable(file.path) || seen.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0
        || !/^[a-f0-9]{64}$/.test(file.sha256) || (file.path !== 'zelos.db' && file.size > BACKUP_LIMITS.metadata)) throw failure('the archive contains an invalid, duplicate, or oversized file.');
    seen.add(file.path.toLowerCase());
    size += file.size;
    if (size > BACKUP_LIMITS.total) throw failure('the archive exceeds the supported 64 GB size.');
  }
  if (!seen.has('zelos.db') || !seen.has('config.json')) throw failure('the archive is missing its database or settings.');
  return size;
}

function verifyFiles(home, files) {
  const names = filesIn(home);
  if (JSON.stringify(names) !== JSON.stringify(files.map((file) => file.path).sort())) throw failure('the staged or recovery file list changed.');
  for (const file of files) {
    const actual = digestFile(path.join(home, file.path));
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw failure('a staged or recovery file failed its integrity check.');
  }
}

/** Caller has paused writers. The SQLite snapshot includes committed WAL data. */
export function createBackup({ home, db, destination, appVersion, config = DEFAULTS, now = new Date() }) {
  home = dataHome(home);
  // A folder that is not there threw a bare ENOENT, which the desktop could only
  // answer with its generic "close other Zelos and AI clients" advice
  // (QA, 2026-10-10, TT-3506).
  if (!exists(path.dirname(path.resolve(destination)))) throw failure('the folder you chose does not exist. Choose another folder and try again.');
  const parent = directory(path.dirname(path.resolve(destination)));
  destination = path.join(parent, path.basename(destination));
  const prior = exists(destination);
  if (prior) regular(destination);
  // Never permit a dialog-selected filename to overwrite live Zelos state.
  const relative = path.relative(home, destination).split(path.sep).join('/');
  if (relative && !relative.startsWith('../') && !path.isAbsolute(relative) && !relative.startsWith('backups/')) throw failure('choose a backup location outside the active data files.');
  const stage = privateDir(path.join(home, `.backup-${crypto.randomUUID()}`));
  const output = path.join(parent, `.zelos-backup-${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    const portableFiles = filesIn(home);
    const snapshot = path.join(stage, 'zelos.db');
    db.prepare('VACUUM INTO ?').run(snapshot);
    fs.chmodSync(snapshot, 0o600);
    for (const name of portableFiles) {
      if (name === 'zelos.db') continue;
      if (name.startsWith('secrets.migrated/') && !exists(path.join(stage, 'secrets.migrated'))) privateDir(path.join(stage, 'secrets.migrated'));
      copyPrivate(path.join(home, name), path.join(stage, name));
    }
    if (!exists(path.join(stage, 'config.json'))) writeFileAtomic(path.join(stage, 'config.json'), `${JSON.stringify(config)}\n`);
    const info = inspectData(stage);
    const manifest = { format: 1, createdAt: new Date(now).toISOString(), appVersion, ...info,
      files: filesIn(stage).map((name) => ({ path: name, ...digestFile(path.join(stage, name)) })) };
    manifestValid(manifest);
    const header = Buffer.from(JSON.stringify(manifest));
    if (header.length > BACKUP_LIMITS.manifest) throw failure('the archive header is too large.');
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    fd = fs.openSync(output, 'wx', 0o600);
    fs.chmodSync(output, 0o600);
    for (const bytes of [BACKUP_MAGIC, length, header]) fs.writeFileSync(fd, bytes);
    const bytes = Buffer.allocUnsafe(CHUNK);
    for (const file of manifest.files) {
      const input = fs.openSync(path.join(stage, file.path), 'r');
      try {
        for (;;) { const n = fs.readSync(input, bytes, 0, bytes.length, null); if (!n) break; fs.writeFileSync(fd, bytes.subarray(0, n)); }
      } finally { fs.closeSync(input); }
    }
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (exists(destination)) regular(destination);
    fs.renameSync(output, destination);
    syncDir(parent);
    return manifest;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(output, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Validate the entire archive before showing a restore confirmation. */
export function stageBackup({ home, source }) {
  home = dataHome(home);
  regular(source);
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const id = crypto.randomUUID();
  const transaction = privateDir(path.join(home, `.restore-${id}`));
  const data = privateDir(path.join(transaction, 'new'));
  const readExact = (bytes) => {
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(input, bytes, offset, bytes.length - offset, null);
      if (!n) throw failure('the archive is truncated.');
      offset += n;
    }
  };
  try {
    const magic = Buffer.alloc(BACKUP_MAGIC.length); readExact(magic);
    if (!magic.equals(BACKUP_MAGIC)) throw failure('this is not a Zelos backup.');
    const length = Buffer.alloc(4); readExact(length);
    const size = length.readUInt32BE();
    if (!size || size > BACKUP_LIMITS.manifest) throw failure('the archive header is too large or damaged.');
    const header = Buffer.alloc(size); readExact(header);
    let manifest;
    try { manifest = JSON.parse(header.toString('utf8')); } catch { throw failure('the archive header is damaged.'); }
    const total = manifestValid(manifest);
    if (fs.fstatSync(input).size !== BACKUP_MAGIC.length + 4 + size + total) throw failure('the archive length does not match its header.');
    const bytes = Buffer.allocUnsafe(CHUNK);
    for (const file of manifest.files) {
      if (file.path.startsWith('secrets.migrated/') && !exists(path.join(data, 'secrets.migrated'))) privateDir(path.join(data, 'secrets.migrated'));
      const output = fs.openSync(path.join(data, file.path), 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      try {
        let remaining = file.size;
        while (remaining) {
          const chunk = bytes.subarray(0, Math.min(bytes.length, remaining)); readExact(chunk);
          hash.update(chunk); fs.writeFileSync(output, chunk); remaining -= chunk.length;
        }
        fs.fsyncSync(output);
      } finally { fs.closeSync(output); }
      if (hash.digest('hex') !== file.sha256) throw failure('a file failed its SHA-256 integrity check.');
    }
    const actual = inspectData(data);
    if (JSON.stringify(actual.counts) !== JSON.stringify(manifest.counts) || actual.credentials !== manifest.credentials) throw failure('the archive preview does not match its contents.');
    return { id, directory: transaction, manifest, cleanup: () => fs.rmSync(transaction, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(transaction, { recursive: true, force: true }); throw err;
  } finally { fs.closeSync(input); }
}

function copyEntry(from, to, name) {
  if (name === 'secrets.migrated') {
    directory(path.join(from, name)); privateDir(path.join(to, name));
    for (const leaf of fs.readdirSync(path.join(from, name))) {
      if (!portable(`${name}/${leaf}`)) throw failure('a credential migration path is invalid.');
      copyPrivate(path.join(from, name, leaf), path.join(to, name, leaf));
    }
    syncDir(path.join(to, name));
  } else { copyPrivate(path.join(from, name), path.join(to, name)); }
}

function readJournal(home) {
  const record = readJSON(path.join(home, JOURNAL));
  if (record?.format !== 1 || !/^[a-f0-9-]{36}$/.test(record.id) || !['replacing', 'committed'].includes(record.phase)
      || !Array.isArray(record.old) || !Array.isArray(record.incoming) || !Array.isArray(record.oldFiles)
      || record.old.length > BACKUP_LIMITS.files || record.incoming.length > BACKUP_LIMITS.files || record.oldFiles.length > BACKUP_LIMITS.files
      || !record.old.includes('zelos.db') || !record.old.includes('config.json') || !record.incoming.includes('zelos.db') || !record.incoming.includes('config.json')
      || [...record.old, ...record.incoming].some((name) => !rootEntry(name))
      || record.oldFiles.some((file) => !plain(file) || !portable(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > BACKUP_LIMITS.total || !/^[a-f0-9]{64}$/.test(file.sha256))
      || new Set(record.old).size !== record.old.length || new Set(record.incoming).size !== record.incoming.length
      || typeof record.recoveryFile !== 'string' || !/^Before-restore-[a-f0-9-]{36}\.zelos-backup$/.test(record.recoveryFile)) throw failure('the restore journal is damaged. Keep this folder intact and recover from its backups folder.');
  directory(path.join(home, `.restore-${record.id}`));
  if (JSON.stringify([...new Set(record.oldFiles.map((file) => file.path.split('/')[0]))].sort()) !== JSON.stringify([...record.old].sort())) throw failure('the recovery file list is damaged.');
  return record;
}

/** Called with no open database, under the maintenance lease, including startup. */
export function recoverRestore({ home }) {
  home = dataHome(home);
  if (!exists(path.join(home, JOURNAL))) return { recovered: false };
  const journal = readJournal(home);
  const transaction = path.join(home, `.restore-${journal.id}`);
  if (journal.phase === 'replacing') {
    const old = directory(path.join(transaction, 'old'));
    // Verify the complete rollback before removing any installed data. Copies
    // remain here throughout recovery, so a second interruption is retryable.
    verifyFiles(old, journal.oldFiles);
    inspectData(old);
    for (const name of new Set([...journal.incoming, ...journal.old])) {
      const target = path.join(home, name);
      const st = exists(target);
      if (st?.isSymbolicLink() || (st && !st.isFile() && !st.isDirectory())) throw failure('a restore target became a link; recovery stopped safely.');
      if (st) fs.rmSync(target, { recursive: st.isDirectory(), force: true });
      if (journal.old.includes(name)) copyEntry(old, home, name);
    }
    syncDir(home);
  }
  fs.unlinkSync(path.join(home, JOURNAL)); syncDir(home);
  fs.rmSync(transaction, { recursive: true, force: true });
  return { recovered: journal.phase === 'replacing', recoveryFile: path.join(home, 'backups', journal.recoveryFile) };
}

/** The recovery archive MUST already exist, and all SQLite handles be closed. */
export function applyRestore({ home, staged, recoveryFile, onStep = () => {} }) {
  home = dataHome(home);
  if (exists(path.join(home, JOURNAL))) throw failure('an earlier restore must be recovered first.');
  const transaction = path.join(home, `.restore-${staged.id}`);
  if (directory(staged.directory) !== directory(transaction)) throw failure('the staged backup is outside this data home.');
  const recoveryName = path.basename(recoveryFile);
  if (path.resolve(recoveryFile) !== path.join(home, 'backups', recoveryName) || !/^Before-restore-[a-f0-9-]{36}\.zelos-backup$/.test(recoveryName)) throw failure('the automatic recovery copy is missing.');
  regular(recoveryFile);
  const data = directory(path.join(transaction, 'new'));
  manifestValid(staged.manifest);
  verifyFiles(data, staged.manifest.files);
  inspectData(data);
  // A closed SQLite connection checkpoints and removes WAL/SHM. A remaining
  // WAL may belong to another process or an unfinished stop: never ignore it.
  for (const name of ['zelos.db-wal', 'zelos.db-shm', 'zelos.db-journal']) if (exists(path.join(home, name))) throw failure('the database is still in use. Close other Zelos and AI clients, then try again.');
  const old = privateDir(path.join(transaction, 'old'));
  const oldNames = [...new Set(filesIn(home).map((name) => name.split('/')[0]))];
  const incoming = [...new Set(filesIn(data).map((name) => name.split('/')[0]))];
  for (const name of oldNames) copyEntry(home, old, name);
  if (!oldNames.includes('config.json')) { writeFileAtomic(path.join(old, 'config.json'), `${JSON.stringify(DEFAULTS)}\n`); oldNames.push('config.json'); }
  inspectData(old); syncDir(old); syncDir(transaction);
  const oldFiles = filesIn(old).map((name) => ({ path: name, ...digestFile(path.join(old, name)) }));
  const journal = { format: 1, id: staged.id, phase: 'replacing', old: oldNames, oldFiles, incoming, recoveryFile: recoveryName };
  writeFileAtomic(path.join(home, JOURNAL), JSON.stringify(journal));
  try {
    onStep('journal');
    for (const name of new Set([...oldNames, ...incoming])) {
      const target = path.join(home, name);
      if (exists(target)) fs.rmSync(target, { recursive: name === 'secrets.migrated', force: true });
      if (incoming.includes(name)) fs.renameSync(path.join(data, name), target);
      syncDir(home); onStep(`installed:${name}`);
    }
    inspectData(home);
    journal.phase = 'committed'; writeFileAtomic(path.join(home, JOURNAL), JSON.stringify(journal));
    onStep('committed');
    recoverRestore({ home });
    return { ok: true, recoveryFile };
  } catch (err) {
    // Leave the journal and rollback files intact if recovery itself fails.
    try { recoverRestore({ home }); } catch { throw failure('restore stopped and automatic recovery could not finish. Keep the data folder intact; the recovery copy is in backups.'); }
    throw err;
  }
}

export function recoveryDestination(home) {
  home = dataHome(home);
  const backups = path.join(home, 'backups');
  if (!exists(backups)) privateDir(backups); else directory(backups);
  fs.chmodSync(backups, 0o700);
  return path.join(backups, `Before-restore-${crypto.randomUUID()}.zelos-backup`);
}
