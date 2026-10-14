/**
 * desktop/runtime.js — the Zelos core, running inside the Electron main process.
 *
 * There is no second Node process. `zelos.mjs` and this file do the same six
 * things — load the config, open and migrate the database, build the server,
 * arm the scheduler, bind 127.0.0.1, hand back the URL — and forking a child
 * would only buy a second copy of sqlite fighting over the same WAL, plus a pipe
 * to marshal shutdown across. Electron's main process *is* Node; the core is
 * imported into it directly.
 *
 * Nothing here imports Electron, and the core is reached through `root` rather
 * than a static specifier, because that path moves when the app is packaged:
 * in development the core sits next to this file at `../core`, and in a build it
 * is unpacked into `Contents/Resources`. One argument, one place to be wrong.
 *
 * The lock on the data home used to live in this file, and that is why it did
 * not exist in the published npm package: `desktop/` is deliberately not in
 * `package.json`'s `files`, so `zelos.mjs`'s import of it threw into a catch on
 * every installed copy. It now lives in `core/home-lock.mjs`, which both entry
 * points can actually reach. `../core/home-lock.mjs` is the one static core
 * specifier in this file, and it is safe for the same reason `root` is correct:
 * the shell computes `ROOT` as `resourcesPath` when packaged and as this
 * directory's parent otherwise, and those are the same directory — the app's
 * own files are unpacked to `Contents/Resources/app/`, one level under the
 * `Contents/Resources/core/` the extraResources rule writes. The module also
 * imports nothing but node builtins and holds no state, so there is nothing a
 * second copy of it could get wrong even if some caller passed a different root.
 */

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { acquireHomeLock } from '../core/home-lock.mjs';
import { acquireMaintenance, registerDataConnection, releaseDataConnection } from '../core/data-lease.mjs';

/** How long a shutdown waits for the socket before leaving anyway. */
const CLOSE_GRACE_MS = 3_000;
/** And how long it waits for an aborted sweep to put the database down. */
const SWEEP_GRACE_MS = 2_000;

/**
 * A sweep is aborted, not killed: the run still has to unwind past whatever
 * await it was sitting on. Closing the database out from under it turns that
 * unwind into "database is not open" on a write that was already doomed — so
 * wait for it, briefly, and carry on regardless if it will not let go.
 */
async function waitForSweepToSettle(server, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (server.zelos.sweeps.status().running && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 25).unref?.(); });
  }
}

async function loadCore(root) {
  const load = (rel) => import(pathToFileURL(path.join(root, 'core', rel)).href);
  const [config, db, server, sweep, logmod, backup] = await Promise.all([
    load('config.mjs'),
    load('db.mjs'),
    load('server.mjs'),
    load('sweep.mjs').catch(() => null), // optional: a broken sweep engine must not stop the board
    load('log.mjs'),
    load('backup.mjs'),
  ]);
  return { config, db, server, sweep, log: logmod, backup };
}

/** Track handler promises, including the time after a response/socket closes.
 * An aborted socket is not a completed write.
 *
 * Pausing does NOT refuse requests here. It asks the server to, via
 * `server.zelos.setUnavailable`, so the 503 is sent after the Host, Origin and
 * session-token checks and with the security headers, not in front of them.
 * The requests it refuses are still tracked here, but they are done in a tick.
 */
export function requestBarrier(server) {
  // Fail at startup, not halfway into quiesce with the maintenance lease held.
  if (typeof server.zelos?.setUnavailable !== 'function') {
    throw new TypeError('requestBarrier needs a server from createServer (server.zelos.setUnavailable)');
  }
  const handlers = server.listeners('request');
  const pending = new Set();
  for (const handler of handlers) server.removeListener('request', handler);
  server.on('request', (req, res) => {
    for (const handler of handlers) {
      const work = Promise.resolve().then(() => handler(req, res));
      pending.add(work);
      work.finally(() => pending.delete(work)).catch(() => { if (!res.writableEnded) res.destroy(); });
    }
  });
  return {
    pause: () => { server.zelos.setUnavailable(true); },
    resume: () => { server.zelos.setUnavailable(false); },
    idle: () => pending.size === 0,
  };
}

async function bounded(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Zelos is still finishing a request. Nothing was replaced; try again after it finishes.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function backupWork(root, operation, args) {
  return new Promise((resolve, reject) => {
    // This is a file worker even when a packaged smoke/embedding host was
    // launched with --input-type=module -e. That flag is invalid for files.
    const worker = new Worker(pathToFileURL(path.join(root, 'core', 'backup-worker.mjs')), { workerData: { operation, args }, execArgv: [] });
    let answered = false;
    worker.once('message', (message) => {
      answered = true;
      if (message.ok) resolve(message.result);
      else reject(Object.assign(new Error(message.error), { code: message.code }));
    });
    worker.once('error', reject);
    worker.once('exit', () => { if (!answered) reject(new Error('The backup worker stopped before finishing.')); });
  });
}

/**
 * Start everything and bind the port.
 *
 * `home` and `port` come from the shell's own flags; both are optional and both
 * default to what the core would have chosen on its own. A `port` of 0 means
 * "any free port", which is what the tests use so they never collide with a
 * Zelos the user is actually running.
 *
 * Resolves a handle carrying the URL to open (token included — it is the only
 * way in), the pieces the shell needs to drive, and a `stop()` that is safe to
 * call twice.
 */
export async function startCore({ root, home = null, port = null } = {}) {
  if (!root) throw new TypeError('startCore needs the directory the core lives in');
  // Before anything resolves where Zelos keeps its data.
  if (home) process.env.ZELOS_HOME = path.resolve(home);

  const core = await loadCore(root);

  const where = core.config.paths();
  if (fs.existsSync(path.join(where.home, '.restore-journal.json'))) {
    const maintenance = acquireMaintenance({ home: where.home, recovering: true });
    try { core.backup.recoverRestore({ home: where.home }); } finally { maintenance.release(); }
  }
  const startup = registerDataConnection(where.db);
  try { return await bootCore({ root, core, where, port }); } finally { startup.release(); }
}

async function bootCore({ root, core, where, port }) {
  const config = core.config.loadConfig();

  // Before the database is opened, not after: if this home is already being
  // swept the person should hear about it before a second scheduler is armed
  // against it. It never refuses — `lock.contested` is a warning the shell
  // surfaces, carrying the name of whatever appears to hold the home.
  const lock = acquireHomeLock({ home: where.home, kind: 'desktop' });

  // A packaged app has no terminal, so the log file is the only place a
  // diagnosis can come from. core/log.mjs redacts on the way in.
  const logger = core.log.createLogger({
    dir: where.logsDir,
    level: process.env.ZELOS_LOG_LEVEL || 'info',
    name: 'desktop',
  });

  // The lock is taken before the logger exists, so a home on a filesystem that
  // cannot hold one is reported here instead. It is a warning and not an error:
  // nothing is broken, the guarantee is simply weaker than usual, and the only
  // person who can act on it is one reading the log after two Zelos ran at once.
  if (lock.degraded) {
    logger.warn('desktop: this filesystem cannot hold the home lock; running without it', {
      home: where.home,
      error: lock.degraded.message,
    });
  }
  if (lock.contested) logger.warn(`desktop: ${lock.contested.message}`);

  let db;
  let server;
  let scheduler = null;
  let bound;
  let barrier;
  try {
    db = core.db.open(where.db);
    core.db.migrate(db);

    /* `logFile` is what a 500 tells the user to go and read. Without it the
       handler falls back to "the reason was written to the terminal Zelos is
       running in — Zelos keeps no log file of its own", which in a packaged app
       names nobody: there is no terminal, and the log file it denies having is
       the one this very function opened, three statements up. */
    server = core.server.createServer({
      db,
      config,
      logger,
      logFile: path.join(where.logsDir, 'desktop.log'),
    });
    barrier = requestBarrier(server);

    // Same ordering as the CLI launcher: the server exists first so the
    // scheduler's progress has somewhere to be reported, then the scheduler is
    // adopted, then both start.
    // Built whatever `sweep.auto` says: gating the CONSTRUCTION on the setting
    // left `handleConfigPut` with no scheduler to reconfigure, so turning the
    // schedule on in Settings did nothing until the next launch. `#tick` holds
    // the off switch itself — it advances and re-arms without sweeping while
    // `auto` is false — so an idle scheduler is what makes the setting live.
    if (!core.sweep?.Scheduler) {
      logger.error('desktop: the sweep engine did not load, so nothing will sweep on a schedule');
    } else {
      try {
        scheduler = new core.sweep.Scheduler({
          db,
          config,
          onProgress: (progress) => server.zelos.sweeps.relay('progress', progress),
          onRun: (result) => server.zelos.sweeps.relay(result?.ok === false ? 'failed' : 'done', result),
        });
        server.zelos.useScheduler(scheduler);
      } catch (err) {
        scheduler = null;
        logger.error('desktop: the sweep scheduler could not start; sweeps must be run by hand', { error: err.message });
      }
    }

    bound = await core.server.listen(server, { port: port === null ? undefined : port });
    scheduler?.start();
  } catch (err) {
    // A start that got as far as the lock and no further must not leave it
    // behind: the next launch would find a lock held by a pid that is still
    // alive — this one — and refuse for a reason that no longer exists.
    lock.release();
    throw err;
  }

  lock.setPort(bound.port);

  let stopping = null;
  let maintaining = false;
  let closed = false;

  async function quiesce({ timeoutMs = 15_000 } = {}) {
    if (maintaining || stopping || closed || lock.contested || lock.degraded) throw new Error('Close other Zelos and AI clients before backing up or restoring this data.');
    const lease = acquireMaintenance({ home: where.home, connection: db });
    maintaining = true;
    barrier.pause();
    scheduler?.stop();
    server.zelos.sweeps.abort();
    const resume = () => {
      maintaining = false;
      lease.release();
      if (!closed) { barrier.resume(); scheduler?.start(); }
    };
    let cancelled = false;
    try {
      // Cancel flows already running, then again after begin handlers settle:
      // an accepted handler may still be saving its client secret at first.
      const first = server.zelos.cancelSignInsAndWait();
      await bounded((async () => {
        while (!barrier.idle() || server.zelos.sweeps.status().running) {
          if (cancelled) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await first;
        if (cancelled) return;
        await server.zelos.cancelSignInsAndWait();
      })(), timeoutMs);
      return resume;
    } catch (err) { cancelled = true; resume(); throw err; }
  }

  const handle = {
    root,
    config,
    paths: where,
    db,
    server,
    scheduler,
    logger,
    lock,
    /* Lifted off the lock so the shell does not have to know the lock exists to
       ask the one question it cares about: does somebody else appear to be
       sweeping this home? Null when nothing suggests it. */
    contested: lock.contested ?? null,
    port: bound.port,
    url: bound.url,
    tokenUrl: bound.tokenUrl,
    token: server.sessionToken,

    /**
     * Run a sweep now. This goes straight to the supervisor rather than through
     * the HTTP API: the tray is inside the process that owns it, so there is no
     * socket, no token and no round trip to get wrong. Progress still reaches
     * the open board, because every listener on /api/sweep/stream is attached to
     * this same supervisor.
     */
    async sweepNow(mode = 'auto') {
      if (maintaining || closed) return { started: false, reason: 'Zelos is backing up or restoring data.' };
      try {
        return await server.zelos.sweeps.start(mode);
      } catch (err) {
        // A 409 from the supervisor means one is already running — which, for a
        // menu item, is the answer rather than a failure.
        logger.info('desktop: sweep not started', { reason: err.message });
        return { started: false, reason: err.message };
      }
    },

    sweepStatus() {
      return server.zelos.sweeps.status();
    },

    /**
     * Watch the sweep supervisor. Every sweep passes through it — the ones the
     * Scheduler starts on the clock as well as the ones a person asked for —
     * so this is the one place that sees a run end no matter who began it.
     * Returns the unsubscribe function.
     */
    onSweep(listener) {
      return server.zelos.sweeps.subscribe(listener);
    },

    /**
     * How many items are asking for something right now. This is the `now`
     * bucket of the open board and nothing else: a badge that counted every
     * open item would be a number in the hundreds that nobody reads, and the
     * board already has one meaning for "now".
     */
    attentionCount() {
      try {
        return core.db.bucketCounts(db, { states: ['open'] }).now ?? 0;
      } catch {
        // The database is closing, or gone. A badge is not worth an exception.
        return 0;
      }
    },

    /** Native-only paths, selected by trusted file dialogs. */
    async createBackup(destination, { appVersion, timeoutMs } = {}) {
      const resume = await quiesce({ timeoutMs });
      try { return await backupWork(root, 'create', { home: where.home, destination, appVersion, config: server.zelos.config }); }
      finally { resume(); }
    },

    async stageBackup(source) {
      const staged = await backupWork(root, 'stage', { home: where.home, source });
      return { ...staged, cleanup: () => fs.rmSync(staged.directory, { recursive: true, force: true }) };
    },

    async restoreBackup(staged, { appVersion }) {
      const resume = await quiesce();
      try {
        const recoveryFile = core.backup.recoveryDestination(where.home);
        await backupWork(root, 'create', { home: where.home, destination: recoveryFile, appVersion, config: server.zelos.config });
        // No handlers or background writes remain. Close SQLite before any
        // replacement, retaining our home and maintenance locks through it.
        await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
        db.close(); closed = true; releaseDataConnection(db);
        const { id, directory, manifest } = staged;
        const result = await backupWork(root, 'apply', { home: where.home, staged: { id, directory, manifest }, recoveryFile });
        return result;
      } finally { resume(); }
    },

    get closed() { return closed; },

    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        try { scheduler?.stop(); } catch { /* it was already stopping */ }
        server.zelos.sweeps.abort();
        await waitForSweepToSettle(server, SWEEP_GRACE_MS);
        await new Promise((resolve) => {
          const done = setTimeout(resolve, CLOSE_GRACE_MS);
          done.unref?.();
          // An open SSE stream holds its socket for as long as the board is
          // open, which is forever as far as server.close() is concerned.
          server.closeAllConnections?.();
          server.close(() => {
            clearTimeout(done);
            resolve();
          });
        });
        if (!closed) try { core.db.close(db); closed = true; } catch (err) { logger.warn('desktop: the database did not close cleanly', { error: err.message }); }
        // Last, after the database is shut: while the lock is there, this home
        // is ours, and it stops being ours only once nothing is holding it.
        lock.release();
        logger.close?.();
      })();
      return stopping;
    },
  };

  logger.info('desktop: the core is up', { port: bound.port, home: where.home, root });
  return handle;
}
