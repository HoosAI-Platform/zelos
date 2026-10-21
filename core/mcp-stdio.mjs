/**
 * core/mcp-stdio.mjs — the stdio MCP server, as the desktop app's AI clients
 * start it.
 *
 * The "Ready to paste" block in Settings runs the app's own binary with
 * ELECTRON_RUN_AS_NODE=1 and this file. Started as the Electron app instead,
 * `Zelos mcp` put a bare \r\n on stdout before any of Zelos's code ran — on
 * Windows, with or without a console, measured in CI with a bare Electron app
 * that did nothing but write `{}` — and stdout is the JSON-RPC channel. In
 * Node mode Electron's start-up never runs, and stdout carries nothing but
 * replies (QA, 2026-10-10, TT-3507).
 *
 * So this file is plain Node and imports only from core/: nothing from
 * `electron`, nothing from desktop/. The build copies core/ beside the app
 * (extraResources), so it ships in every installer, and the npm package
 * carries it too. It does what `zelos.mjs mcp` does, in the same order:
 * refuse a runtime without FTS5, refuse a home in the middle of a backup or
 * restore, hold the data lease, warn on stderr when AI access is off, serve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How an AI client should start the stdio server for the copy of Zelos at
 * `root` (the folder holding core/), run by `execPath`. This is what Settings
 * prints and what scripts/check-mcp-stdio.mjs runs, so the check proves the
 * block people paste.
 *
 * Inside Electron, packaged or a dev shell, it is the app's own binary in Node
 * mode on this file, on every platform: one shape to test, and none of
 * Electron's start-up output. Under plain Node (the CLI) it is unchanged:
 * `node zelos.mjs mcp`. `moveFirst` marks a Mac app macOS is running from a
 * translocated copy or from a read-only volume (the disk image), whose path
 * stops existing once it quits. An app installed on a writable external drive
 * under /Volumes/ is where it lives, and is not flagged.
 */
export function stdioLaunch({ electron = Boolean(process.versions.electron), execPath = process.execPath, root, canWrite = writable }) {
  if (!electron) return { command: execPath, args: [path.join(root, 'zelos.mjs'), 'mcp'], env: {}, moveFirst: false };
  const app = execPath.includes('.app/') ? execPath.slice(0, execPath.indexOf('.app/') + 4) : execPath;
  return {
    command: execPath,
    args: [path.join(root, 'core', 'mcp-stdio.mjs')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    moveFirst: execPath.includes('/AppTranslocation/') || (execPath.startsWith('/Volumes/') && !canWrite(path.dirname(app))),
  };
}

/** Whether this account can write to `dir`, as desktop/updater.js macReplaceCheck asks. */
function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** `--home <dir>` or `--home=<dir>`, and nothing else. */
export function parseMcpArgs(argv) {
  let home = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--home') {
      home = argv[++i];
      if (!home) throw new Error('--home needs a value');
    } else if (arg.startsWith('--home=')) {
      home = arg.slice('--home='.length);
      if (!home) throw new Error('--home needs a value');
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { home };
}

/**
 * Serve until the client closes stdin. Writes nothing to stdout of its own:
 * every word for a person goes to stderr. Resolves the exit code.
 */
export async function runMcpStdio(argv = process.argv.slice(2), io = {}) {
  // Node mode belongs to this process. Anything it starts — the keychain or
  // DPAPI helpers in core/secrets.mjs — must not inherit it.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const stderr = io.stderr ?? process.stderr;

  let flags;
  try {
    flags = parseMcpArgs(argv);
  } catch (err) {
    stderr.write(`zelos mcp: ${err.message}\n`);
    return 2;
  }
  // Before any module resolves the home.
  if (flags.home) process.env.ZELOS_HOME = path.resolve(flags.home);

  const { assertRuntimeSupported, fatalText } = await import('./db.mjs');
  let lease = null;
  try {
    // Before paths() makes the home, so the refusal changes nothing.
    assertRuntimeSupported();
    const { paths, loadConfig } = await import('./config.mjs');
    const { assertNoMaintenance, registerDataConnection } = await import('./data-lease.mjs');
    // Before loadConfig can repair a file a restore is replacing.
    assertNoMaintenance(paths().home);
    lease = registerDataConnection(paths().db);

    const { log } = await import('./log.mjs');
    const { serveStdio } = await import('./mcp.mjs');
    if (loadConfig()?.ai?.enabled !== true) {
      log.warn('zelos mcp: AI access is switched off in Settings, so nothing is exposed yet');
    }
    await serveStdio({ logger: log, ...io });
    return 0;
  } catch (err) {
    const known = typeof err?.code === 'string' && err.code.startsWith('ZELOS_') && err.code !== 'ZELOS_NO_FTS5';
    stderr.write(known ? `zelos mcp: ${err.message}\n` : fatalText('zelos mcp', err));
    return 1;
  } finally {
    lease?.release();
  }
}

/** Whether this file is the program being run, through a symlink or not. */
function invokedDirectly() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const here = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(here);
  } catch {
    return path.resolve(argv1) === here;
  }
}

if (invokedDirectly()) {
  runMcpStdio().then((code) => {
    process.exitCode = code;
    // The replies are written; flush stdout, then leave rather than wait on a
    // keep-alive socket a credential helper may have left behind.
    process.stdout.write('', () => setTimeout(() => process.exit(code), 250).unref());
  });
}
