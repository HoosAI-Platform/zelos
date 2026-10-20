/**
 * core/home-lock.mjs — the exclusion on the data home.
 *
 * Electron's `requestSingleInstanceLock` only stops a second *Electron* app.
 * It knows nothing about `zelos` run from a terminal, and that is the pairing
 * people actually end up in: the shell in the tray, a CLI in a window, both
 * pointed at `~/.zelos`. Two schedulers then sweep one WAL database on their
 * own clocks — the same mail fetched twice, the same model calls paid for
 * twice, the same drafts written twice, and two boards each convinced its
 * `sweeps` supervisor is the only one running. Nothing crashes, which is what
 * makes it expensive.
 *
 * So the exclusion is on the thing that is actually shared: the home directory.
 * A `zelos.lock` file there carries the pid, what kind of Zelos it is, and the
 * port once one is bound, and it is created with link(2) against a unique temp
 * file — the one filesystem operation that both fails when the target exists
 * and publishes the whole record at once, so a reader never sees half of it.
 *
 * **Why this lives in `core/` and not beside the Electron shell.** It was
 * written for the shell and lived in `desktop/runtime.js`, which made the whole
 * feature dead in the published package: `package.json`'s `files` list ships
 * `core/`, `ui/`, `assets/` and `zelos.mjs`, and deliberately does not ship
 * `desktop/` — the Electron shell is a separate artefact and `test/cli.test.mjs`
 * asserts the tarball is free of it. So `zelos.mjs`'s `await import('./desktop/
 * runtime.js')` threw ERR_MODULE_NOT_FOUND into a bare catch on every installed
 * copy, and the exclusion existed only for people running from a git checkout.
 * Measured on the packed tarball: no `zelos.lock` was ever written, and a second
 * process against a home a live one already held started a second scheduler
 * with no warning at all. This module imports nothing but node builtins, so
 * there was never a reason for it to sit on the Electron side of the line.
 *
 * A lock that outlives its owner would be worse than no lock, because the way
 * out of it is a file the user has never heard of. So a lock whose holder is
 * gone is not a lock: it is reclaimed, silently, on the next start. Staleness
 * has to be *decidable*, though, and `kill(pid, 0)` on its own cannot decide
 * it — a recycled pid now belonging to a root daemon answers `EPERM`, which
 * read as "alive" is a refusal no reboot and no amount of quitting will ever
 * clear. So the record carries what it takes to tell:
 *
 *   - `startedAt`. A lock written before this machine last booted cannot be
 *     held by anything, whatever the pid now answers. `os.uptime()` is where
 *     the boot instant comes from, with slack for a clock that moved.
 *   - `uid`. A process this user started is always signallable by this user, so
 *     `EPERM` against a record written by this same uid is proof of pid reuse
 *     rather than of life. Only a record naming a *different* uid — a Zelos run
 *     under sudo, say — is allowed to be alive-but-unsignallable.
 *   - An age ceiling on that last case, because it is the one branch left that
 *     no other evidence can settle, and a month-old lock nobody can probe is a
 *     lockout rather than a lock.
 *
 * And whatever it decides, the refusal names the file, so there is always a way
 * out that does not require knowing any of this.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_NAME = 'zelos.lock';

/**
 * How far `startedAt` may sit before the boot instant and still be believed.
 * `os.uptime()` and the wall clock drift apart across suspends and NTP steps,
 * and being slow to reclaim is cheap where reclaiming a live lock is not.
 */
const BOOT_SLACK_MS = 5 * 60_000;
/** How long a lock held by another user, that this user cannot probe, stands. */
const FOREIGN_LOCK_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** setPort's replace: the codes Windows answers while another handle has the
 *  lock open, and a bounded wait (about 2.75 s in all) for it to let go. */
const PORT_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const PORT_RETRIES = 10;
const PORT_RETRY_MS = 50;

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

/** 'alive' | 'gone' | 'denied' — denied being `EPERM`, which decides nothing. */
function signalProcess(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    return err.code === 'EPERM' ? 'denied' : 'gone';
  }
}

/**
 * Whether a lock record is still held, and why.
 *
 * Exported, and every input it cannot compute for itself injectable, because
 * the cases worth testing are the ones nobody can stage: a pid reused across a
 * reboot, a holder owned by root, a clock that moved.
 */
export function lockHolderState(record, probe = {}) {
  const now = probe.now ?? Date.now();
  const bootedAt = probe.bootedAt ?? now - os.uptime() * 1000;
  const uid = probe.uid === undefined ? currentUid() : probe.uid;
  const signal = probe.signal ?? signalProcess;

  const pid = record?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { held: false, why: 'the lock names no process' };

  const startedAt = Date.parse(record?.startedAt ?? '');
  const age = Number.isFinite(startedAt) ? now - startedAt : null;
  // The boot rule comes first, and it applies to our own pid as much as to
  // anyone's: after a reboot the kernel hands pids out again from the start,
  // and a lock left behind by an unclean exit can name the number this very
  // process is now running under. Claiming "this process holds it" there would
  // be a permanent refusal justified by a coincidence.
  if (age !== null && startedAt < bootedAt - BOOT_SLACK_MS) {
    return { held: false, why: 'it was taken before this machine booted' };
  }
  if (pid === process.pid) return { held: true, why: 'this process holds it' };

  const state = signal(pid);
  if (state === 'gone') return { held: false, why: 'the process that took it is gone' };
  if (state === 'alive') return { held: true, why: 'the process that took it is still running' };

  // EPERM. Whether that is life or a recycled pid depends on who wrote it.
  const holderUid = Number.isInteger(record?.uid) ? record.uid : null;
  if (holderUid === null || (uid !== null && holderUid === uid)) {
    return { held: false, why: 'that pid now belongs to someone else' };
  }
  // A foreign holder we can never probe is held only while its age says it
  // could plausibly still be running. A record with no readable startedAt can
  // never age out, so it is not allowed to hold at all — an unreadable date is
  // a broken lock, and a broken lock must not outrank a user trying to start.
  if (age === null) return { held: false, why: 'the lock does not say when it was taken' };
  if (age > FOREIGN_LOCK_MAX_AGE_MS) {
    return { held: false, why: 'nothing has been able to probe it for a month' };
  }
  return { held: true, why: 'another user is running it' };
}

/** The lock record, or null when there is no readable one — which counts as none. */
export function readHomeLock(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, LOCK_NAME), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch {
    // Missing, or truncated by a hard power-off. Both mean "nobody holds this".
    return null;
  }
}

/**
 * Publish the record, or say why not: `taken` when somebody already holds the
 * file, `unsupported` when this filesystem will not do the operation at all.
 *
 * link(2) is the first choice because it both fails on an existing target and
 * publishes the whole record in one step, so a reader never sees half of one.
 * Not every filesystem has it: a home on FAT32 — an external drive, a USB
 * stick, a Windows share — answers `ENOTSUP`, and older network mounts answer
 * `EPERM` or `ENOSYS`. `O_EXCL` is the fallback, which is exclusive everywhere
 * that matters but writes in a second step, so there is a sliver in which a
 * reader sees an empty file and reads it as no lock at all. That is the correct
 * trade: the sliver is microseconds on a single-user desktop, and the thing it
 * buys is a lock on filesystems that would otherwise have none.
 */
function publishLock(file, record) {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
  } catch (err) {
    return { ok: false, unsupported: err };
  }
  try {
    fs.linkSync(tmp, file);
    return { ok: true };
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: false, taken: true };
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true };
    } catch (fallback) {
      if (fallback.code === 'EEXIST') return { ok: false, taken: true };
      return { ok: false, unsupported: fallback };
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* the link, if it was made, holds the data */ }
  }
}

/**
 * What to tell someone whose home appears to be in use already. It names the
 * holder, what the overlap actually costs, and — because the whole reason this
 * is a warning rather than a refusal is that the diagnosis can be wrong — how
 * to make it go away when it is.
 */
function contestMessage(holder, home, file) {
  const who = holder?.kind === 'cli' ? 'a `zelos` started from a terminal' : 'another copy of the Zelos app';
  const where = Number.isInteger(holder?.port) && holder.port > 0 ? ` on http://127.0.0.1:${holder.port}/` : '';
  const pid = Number.isInteger(holder?.pid) && holder.pid > 0 ? ` (process ${holder.pid})` : '';
  return `${home} looks like it is already in use by ${who}${pid}${where}. `
    + 'Running two copies means the same mail is fetched twice and the same model calls are paid for twice. '
    + `Quit the other one, or point this one somewhere else with --home. If nothing is actually running, delete ${file} — that is all this warning is reading.`;
}

/**
 * The handle handed back when the lock could not be taken for a reason that is
 * not "somebody else has it".
 *
 * A lock is a nicety and running is the product, so a filesystem that cannot do
 * the operation degrades to no lock rather than to no Zelos. The handle keeps
 * the same shape so no caller has to know, and carries `degraded` so the one
 * caller that should say something out loud — `startCore`, once it has a
 * logger — can.
 */
function unlockedHandle(file, record, err) {
  return {
    file,
    degraded: { code: err?.code ?? null, message: err?.message ?? String(err) },
    get record() { return { ...record }; },
    setPort(bound) {
      if (Number.isInteger(bound) && bound > 0) record.port = bound;
    },
    release() {},
  };
}

/**
 * Take the lock, and never refuse to start over it.
 *
 * This began as an exclusion — a live holder threw, and the caller stopped —
 * and every hazard it then grew was of one kind: some condition the staleness
 * rules read wrong, and a user who could not start their own app because of a
 * file they had never heard of. A stale pid across a reboot. A pid recycled
 * onto a root daemon. A home on a filesystem with no link(2). Each was fixable,
 * and the next one was always going to be findable, because the failure mode of
 * "refuse" is unbounded: every bug in it costs the user the product.
 *
 * So the lock ADVISES. A contested home comes back as a handle with `contested`
 * set, naming who appears to hold it, and the caller decides what to do about
 * it — the desktop shell asks the person, the launcher prints a warning and
 * carries on. The worst a wrong answer can now do is show a warning that was
 * not needed, which is a cost the user can see and dismiss. What it protects
 * against is real but survivable: two schedulers sweeping one database, paying
 * for the same model calls twice. Telling someone that is happening gets almost
 * all of the value; refusing to run gets the rest of it and risks everything.
 *
 * The returned handle has `setPort`, called once the server has bound, so the
 * warning the *next* process shows can name a URL rather than only a pid.
 * `release()` unlinks only a lock this process still owns: a reclaim race would
 * otherwise let a departing instance take the live one's lock away with it.
 * A filesystem that cannot do an exclusive create comes back `degraded`.
 */
export function acquireHomeLock({ home, kind = 'desktop', port = null } = {}) {
  if (!home) throw new TypeError('acquireHomeLock needs the Zelos home directory');
  const file = path.join(home, LOCK_NAME);

  const record = {
    pid: process.pid,
    kind,
    port: Number.isInteger(port) && port > 0 ? port : null,
    startedAt: new Date().toISOString(),
    uid: currentUid(),
  };

  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch (err) {
    return unlockedHandle(file, record, err);
  }

  // Two attempts, not a loop: one to take a free lock, one more after a single
  // reclaim. Anything past that is another process winning the same race, and
  // that process is alive, so the home is genuinely contested.
  let contested = null;
  let held = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const published = publishLock(file, record);
    if (published.unsupported) return unlockedHandle(file, record, published.unsupported);
    if (published.ok) {
      // Read back before believing it. Two processes that both found the same
      // stale lock will both have unlinked and relinked; the one that does not
      // see its own pid did not get it.
      const mine = readHomeLock(home);
      if (mine && mine.pid === process.pid && mine.startedAt === record.startedAt) {
        held = true;
        break;
      }
      contested = mine ?? { pid: 0, kind: 'unknown', port: null };
      break;
    }
    const holder = readHomeLock(home);
    if (holder && lockHolderState(holder).held) { contested = holder; break; }
    // Whoever wrote this is gone. Take the file away and try once more.
    try { fs.unlinkSync(file); } catch { /* somebody else reclaimed it first */ }
    if (attempt === 1) contested = holder ?? { pid: 0, kind: 'unknown', port: null };
  }

  // Contested: the other instance keeps the file. Ours is a handle that owns
  // nothing, says who is there, and still lets the caller run.
  if (!held) {
    const handle = unlockedHandle(file, record, null);
    handle.degraded = null;
    handle.contested = { ...contested, home, lockFile: file, message: contestMessage(contested, home, file) };
    return handle;
  }

  return {
    file,
    degraded: null,
    contested: null,
    get record() { return { ...record }; },
    setPort(bound) {
      if (!held || !Number.isInteger(bound) || bound <= 0) return;
      record.port = bound;
      // We own the file, so a plain atomic replace is enough here.
      const tmp = `${file}.${process.pid}.port`;
      const write = (attempt) => {
        if (!held) return;
        // A retry runs later, when the file may no longer be ours: deleted by
        // someone following the warning's advice, or reclaimed by another
        // instance. Rewriting it then would resurrect or steal a lock.
        if (attempt > 0) {
          const current = readHomeLock(home);
          if (!current || current.pid !== process.pid || current.startedAt !== record.startedAt) return;
        }
        try {
          fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
          fs.renameSync(tmp, file);
        } catch (err) {
          // The port in the lock is a courtesy to the next process, not state
          // anything depends on. Failing to write it is not worth a shutdown.
          try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
          /* But one failed replace is not a reason to give up on it. Windows
             refuses to replace a file another process has open — a scanner
             reading the lock this process created a moment ago is the usual
             one — and gave up for good: about 7 shell launches in 136 left
             `port: null`, so the next warning could not name the board
             (QA, 2026-10-10, TT-3511). That refusal clears, so try again off
             the caller's path, as graceful-fs does for the same rename. */
          if (PORT_RETRY_CODES.has(err?.code) && attempt < PORT_RETRIES) {
            setTimeout(() => write(attempt + 1), PORT_RETRY_MS * (attempt + 1)).unref();
          }
        }
      };
      write(0);
    },
    release() {
      if (!held) return;
      held = false;
      const current = readHomeLock(home);
      if (current && current.pid !== process.pid) return;
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    },
  };
}

/**
 * The whole lock, for a launcher that has nothing but a home directory.
 *
 * `startCore` takes the lock itself, in the middle of a sequence it owns. A
 * plain launcher has no such sequence — it wants one line before it opens the
 * database and nothing to remember afterwards — so this adds the two things
 * that line would otherwise have to write out: the release is registered on
 * `exit`, which fires for a normal end and for an uncaught throw alike, and
 * both the degraded and the contested cases are reported through whatever
 * logger was passed rather than disappearing. It never throws over a contested
 * home — a launcher's job there is to say so and keep going.
 *
 *     const lock = holdHome({ home: paths().home, kind: 'cli', logger });
 *
 * and later, once the socket is bound, `lock.setPort(bound.port)`.
 *
 * Both CLI entry points call it: `main()` before it opens the database for the
 * server, and `commandSweep` before it opens the database for a one-shot sweep.
 * The sweep half matters more than it looks — a `zelos sweep` in a crontab is
 * the documented way to run this, and it is exactly the process that will meet
 * a desktop app already sweeping the same home on its own clock.
 */
export function holdHome({ home, kind = 'cli', port = null, logger = null } = {}) {
  const lock = acquireHomeLock({ home, kind, port });
  if (lock.degraded) {
    logger?.warn?.('zelos: this filesystem cannot hold the home lock; running without it', {
      home,
      error: lock.degraded.message,
    });
  }
  if (lock.contested) logger?.warn?.(lock.contested.message);
  process.once('exit', () => {
    try { lock.release(); } catch { /* the process is leaving either way */ }
  });
  return lock;
}
