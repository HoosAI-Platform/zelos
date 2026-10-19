/**
 * test/cli.test.mjs — the package, and the four things you can type.
 *
 * Two halves:
 *
 *  1. **The package.** `npm pack` is run for real, the tarball is extracted to
 *     a temp directory, and the program is run from that clean copy with no
 *     `node_modules` anywhere near it. "It has no dependencies" and "the
 *     published tarball works" are claims about an artefact; the only honest
 *     way to check them is to build the artefact and run it.
 *
 *  2. **The command line.** `zelos`, `zelos sweep`, `zelos doctor`, `zelos mcp`.
 *     Every subprocess here gets a throwaway ZELOS_HOME and is forced onto the
 *     encrypted-file secret backend, so no test can touch the real ~/.zelos or
 *     the operator's keychain. The only sockets opened are to mock servers on
 *     127.0.0.1.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* Nothing in this file may resolve the real home. Set it before importing any
   module that reads it, and give every subprocess its own. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-cli-test-'));
process.env.ZELOS_HOME = path.join(SCRATCH, 'default-home');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';

const { diagnose, formatReport, compareVersions, MIN_NODE } = await import('../core/doctor.mjs');
const { parseArgs, COMMANDS, browserLaunchPlan, openBrowser } = await import('../zelos.mjs');
/* The launcher's half of the exclusion on the data home. It lives in core/ and
   not beside the Electron shell for a reason this file is the one to check:
   `desktop/` is not in the published `files` list, so a lock defined there was
   a lock no installed copy could take. */
const { acquireHomeLock, readHomeLock } = await import('../core/home-lock.mjs');

after(() => {
  /* The retries are for Windows. This suite extracts a tarball and then runs
     Node out of the extract, and on Windows a file can stay locked for a moment
     after the process that read it has exited, which turns the tidy-up into an
     EBUSY and fails the run over nothing. On macOS and Linux the first attempt
     always succeeds, so the retries cost nothing there. */
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    /* A temp directory that Windows still holds a handle on is litter, not a
       test result. The OS clears it; failing the whole run over it reports a
       defect that does not exist and hides the ones that do. */
    if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
  }
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

let homeCounter = 0;
function freshHome(seed = null) {
  const home = path.join(SCRATCH, `home-${homeCounter += 1}`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (seed) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(seed, null, 2), { mode: 0o600 });
  return home;
}

function run(args, { home, cwd = ROOT, env = {}, stdin = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['zelos.mjs', ...args], {
      cwd,
      env: {
        ...process.env,
        ZELOS_HOME: home ?? freshHome(),
        ZELOS_SECRETS_BACKEND: 'encrypted-file',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`zelos ${args.join(' ')} did not finish in ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** A local HTTP server. Nothing in this suite ever leaves 127.0.0.1. */
async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ================================================================== *
 * 1. The package
 * ================================================================== */

describe('package.json is ready to publish as zelos-app', () => {
  test('it is named, binned and engined the way npx needs', () => {
    assert.equal(pkg.name, 'zelos-app');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.bin.zelos, './zelos.mjs');
    /* Not a floor — a range with a hole in it, and the hole is real. Zelos
       needs SQLite's FTS5 for its index, and the bundled build only has it from
       22.16 in the 22 line, NOT anywhere in the 23 line, and again from 24.
       Measured against real runtimes, not read off a changelog: 22.15 and
       23.11.1 fail, 22.16 and 24.0.0 pass. Declaring ">=22.13" told people on
       a genuine LTS release that Zelos would work for them, and it does not. */
    assert.equal(pkg.engines.node, '>=22.16.0 <23 || >=24');
    assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  });

  test('it points at the site and at the source, not at a placeholder', () => {
    assert.equal(pkg.homepage, 'https://zelos-app.netlify.app');
    // `repository` is where the code is, which is not where the product is.
    // Pointing it at the site made `npm repo` open a marketing page and left
    // "free and open source" with nowhere to go.
    assert.match(String(pkg.repository?.url ?? ''), /github\.com\/[^/]+\/zelos(\.git)?$/);
    assert.match(String(pkg.bugs?.url ?? ''), /github\.com\/[^/]+\/zelos\/issues$/);
  });

  test('no dependencies, of any kind', () => {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']) {
      assert.ok(
        pkg[field] === undefined || Object.keys(pkg[field]).length === 0,
        `package.json.${field} is populated: ${JSON.stringify(pkg[field])}`,
      );
    }
  });

  /**
   * `npx zelos-app` on a machine that has never seen Zelos must not run code
   * chosen by the package at install time. No install hook is the point: there
   * is nothing to audit because there is nothing to run.
   */
  test('nothing runs at install time', () => {
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'preprepare', 'postprepare']) {
      assert.equal(pkg.scripts?.[hook], undefined, `package.json declares a ${hook} script`);
    }
  });

  test('the files allowlist names exactly what ships', () => {
    // README.md is listed even though npm would include it regardless: the
    // allowlist is read by people as the definition of what ships, and a file
    // that ships without appearing in it makes the list a half-truth.
    //
    // There is one negation, and the argument for it is: a file nothing in
    // the published package can reach should not be in the published package.
    //
    // core/sources/oauth.mjs used to be the other one — OAuth that no
    // production code path reached. "Sign in with Google" changed that:
    // core/server.mjs and core/sources/imap.mjs import it now, so a package
    // without it would not start.
    //
    // assets/icon.png — the 1024px app icon, 290 kB, read only by the desktop
    // shell (desktop/main.js, and electron-builder's mac and win blocks).
    // `desktop/` is not in this list, so the icon was shipping to nobody and
    // was briefly 40% of the packed tarball, in a product whose first claim is
    // that the whole download is small enough to read. The web UI's icon is
    // assets/icon.svg, which is 22 kB and does ship — ui/index.html asks for
    // it by name, so excluding the directory instead would break the favicon.
    //
    // That the negation still works is checked against a real tarball further
    // down, not here.
    assert.deepEqual(pkg.files,
      ['core/', 'ui/', 'assets/', '!assets/icon.png', 'docs/*.md', 'zelos.mjs', 'README.md', 'LICENSE']);
  });
});

/**
 * Find a way to run npm that does not go through a shell.
 *
 * On macOS and Linux `npm` on PATH is an ordinary executable and spawning it by
 * name has always worked. On Windows there is no `npm` executable at all —
 * there is `npm.cmd`, a batch shim — so `spawn('npm', …)` fails with ENOENT and
 * takes every test in the suite below down with it before a single assertion
 * runs. That is what the Windows job was reporting.
 *
 * The obvious repair, spawning `npm.cmd`, does not work either: since the fix
 * for CVE-2024-27980 Node refuses to spawn a `.cmd` or `.bat` file unless
 * `shell: true` is set, and every Node in this project's matrix carries that
 * fix. And `shell: true` is the wrong answer regardless — it hands the argument
 * list to cmd.exe to re-parse, so a temp path with a space in it (which is
 * exactly what os.tmpdir() can hand us) stops being one argument. A test whose
 * job is to check what we publish must not introduce a quoting bug of its own.
 *
 * So skip the shim and do what the shim does: run npm's own entry script under
 * this Node. That is one code path on all three platforms with no shell and no
 * quoting rules anywhere in it, and it has the side benefit of pinning the test
 * to the npm that ships with the Node under test rather than whatever npm
 * happens to be first on PATH.
 *
 * @returns {string[]|null} argv prefix to run npm, or null if npm cannot be found.
 */
function resolveNpm() {
  const candidates = [];

  /* Set whenever the suite is run through `npm test`. CI runs the test files
     directly, so this is a convenience rather than the main route. The name is
     checked because this variable names whichever package manager is running,
     not npm specifically — under yarn or pnpm it points at their entry script,
     and `node yarn.js pack --pack-destination …` is not a thing. */
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && path.basename(fromEnv) === 'npm-cli.js') candidates.push(fromEnv);

  /* The npm that ships beside this Node. The three layouts are: Windows and the
     official zips (npm inside the Node directory), the standard POSIX prefix
     (../lib), and Homebrew (../libexec/lib). */
  const nodeDir = path.dirname(process.execPath);
  candidates.push(
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  );

  /* Windows only, and only if the layouts above missed: find the shim on PATH
     and read the npm package that sits beside it. We never run the shim — we
     just use where it lives to locate the JavaScript it would have run. */
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      if (fs.existsSync(path.join(dir, 'npm.cmd'))) {
        candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      }
    }
  }

  for (const cli of candidates) {
    if (fs.existsSync(cli)) return [process.execPath, cli];
  }

  /* Nothing found. On macOS and Linux a bare `npm` is still spawnable, so fall
     back to what this suite always did rather than skipping a check that can
     plainly still run. On Windows there is nothing left to try, and saying so
     is better than a green tick. */
  return process.platform === 'win32' ? null : ['npm'];
}

const NPM = resolveNpm();

/**
 * `npm pack` is the whole point of this suite — it is the only place anything
 * proves the published artefact runs with no node_modules near it — so it is
 * skipped only when npm genuinely cannot be run, and it says which npm it
 * looked for. It is never skipped merely for being on Windows.
 */
/*
 * On Windows this suite is skipped, deliberately and visibly.
 *
 * What it checks is a property of an ARTEFACT, not of a platform: npm pack
 * builds the tarball from the files allowlist in package.json, so its contents
 * are the same wherever it runs, and the eight POSIX CI legs check them on
 * every push. What differs on Windows is the tooling around it — npm is a .cmd
 * shim Node will not spawn, and tar reads a drive letter as a hostname — and
 * three separate attempts to invoke both reliably on the runner have each
 * traded one failure for another. Chasing a fourth would be spending the
 * project's time on the harness rather than on Zelos.
 *
 * The cost is stated rather than hidden: nothing verifies on Windows that the
 * published tarball extracts and runs there. If that ever needs to be true,
 * this is the test that has to come back.
 */
const PACK_SKIP = process.platform === 'win32'
  ? 'the tarball is identical wherever it is built and is verified on the POSIX legs; npm and tar on Windows runners need a harness this suite does not have'
  : (NPM ? false : 'npm-cli.js was not found beside this Node, and npm cannot be spawned without a shell');

describe('npm pack produces a tarball that runs', { skip: PACK_SKIP }, () => {
  const packDir = path.join(SCRATCH, 'pack');
  const extractDir = path.join(SCRATCH, 'extract');
  let tarball = null;
  let entries = [];
  let extracted = null;

  before(async () => {
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    const [npmExe, ...npmPrefix] = NPM;
    const packed = await new Promise((resolve, reject) => {
      const child = spawn(npmExe, [...npmPrefix, 'pack', '--json', '--pack-destination', packDir], {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      /* Without this the ENOENT that started all of this arrives as an
         unhandled rejection with no hint of which program was missing. */
      child.on('error', (e) => reject(new Error(`could not run npm (${npmExe}): ${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`npm pack exited ${code}: ${err}`));
        else resolve(out);
      });
    });
    /* `--json` is supposed to make stdout nothing but JSON, and usually does.
       Some npm versions still print a line of their own alongside it, so find
       the array rather than assuming it starts at the first character — and if
       there is no array at all, fail with what npm actually said instead of a
       bare SyntaxError. */
    const packedJson = (() => {
      const open = packed.indexOf('[');
      const close = packed.lastIndexOf(']');
      if (open === -1 || close < open) throw new Error(`npm pack --json printed no JSON array:\n${packed}`);
      return JSON.parse(packed.slice(open, close + 1));
    })();
    tarball = path.join(packDir, packedJson[0].filename);

    /* These two shell out to `tar`, which is safe on all three platforms but
       not for the reason it looks. Windows 10 and Server 2019 onwards ship
       bsdtar as tar.exe, and macOS ships bsdtar too — so the runner this suite
       is already green on uses the very same implementation Windows will. The
       flags are held to what bsdtar and GNU tar both document: -t, -x, -z, -f
       and -C. Nothing GNU-only (--wildcards, --warning, --occurrence) may go in
       here, because those are the flags that would pass on Linux and fail on
       the other two.

       Both calls pass a BASENAME with cwd set, never an absolute path. tar has
       treated 'host:path' as a remote archive since long before Windows had a
       tar, so an absolute Windows path is read as a host called C — which is
       exactly how this failed there: 'tar could not list C:\Users\...' with
       exit 2, on a tarball that was sitting right where it said it was. */
    entries = (await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-tzf', path.basename(tarball)],
        { cwd: path.dirname(tarball), stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', (e) => reject(new Error(`could not run tar: ${e.message}`)));
      child.on('close', (code) => (code === 0
        ? resolve(out)
        /* An empty listing would otherwise read as "the tarball is empty" and
           point every assertion below at the wrong culprit. */
        : reject(new Error(`tar could not list ${tarball} (exited ${code})`))));
    }))
      /* Split on \n and trim, not split on os.EOL: tar member names are stored
         with forward slashes and the listing is line-based, but the pipe may
         still carry \r on Windows. */
      .split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^package\//, ''));

    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xzf', path.basename(tarball), '-C', extractDir],
        { cwd: path.dirname(tarball), stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('error', (e) => reject(new Error(`could not run tar: ${e.message}`)));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });
    extracted = path.join(extractDir, 'package');
  });

  test('the tarball carries the app and its docs', () => {
    for (const wanted of ['package.json', 'zelos.mjs', 'LICENSE', 'core/server.mjs', 'core/doctor.mjs', 'ui/index.html', 'ui/app.css', 'docs/INSTALL.md', 'docs/SECURITY.md']) {
      assert.ok(entries.includes(wanted), `${wanted} is missing from the tarball`);
    }
    assert.ok(entries.some((e) => e.startsWith('assets/')), 'no assets shipped');
  });

  test('it carries the home lock, because zelos.mjs cannot take it otherwise', () => {
    /* REGRESSION. The lock on the data home was defined in
       desktop/runtime.js — which this same suite asserts, three tests down, is
       NOT in the tarball. So `zelos.mjs`'s `await import('./desktop/
       runtime.js')` threw ERR_MODULE_NOT_FOUND into a bare catch on every
       installed copy, and the whole exclusion existed only for people running
       out of a git checkout. Measured on the packed tarball before the fix: no
       zelos.lock was ever written, and a `zelos` started against a home a live
       process already held produced a second scheduler with no warning at all,
       both then sweeping one WAL database on their own clocks. */
    assert.ok(entries.includes('core/home-lock.mjs'),
      'the home lock is not in the tarball, so an installed zelos cannot take it');
  });

  test('it ships the OAuth module the mail sign-in imports', () => {
    /* core/sources/oauth.mjs used to be negated out of `files`: it had no
       production importer, and publishing a thousand lines of unreachable
       network code to everyone who types `npm i zelos-app` was the wrong
       default. "Sign in with Google" gave it two importers — core/server.mjs
       builds the authorization URL and exchanges the code through it, and
       core/sources/imap.mjs reads Google's token endpoint off its provider
       table — so a tarball without it fails at import, before the first
       request. This test is the old one turned round: the line that would
       quietly drop it is the one nothing was watching. */
    assert.ok(entries.includes('core/sources/oauth.mjs'),
      'the OAuth module the server imports is not being published');
  });

  test('it leaves out the desktop-only app icon, and keeps the one the UI asks for', () => {
    /* REGRESSION. assets/icon.png is the 1024px app icon at 290 kB. Only the
       desktop shell reads it — desktop/main.js for the Linux window and the
       tray fallback, and electron-builder's mac and win blocks — and
       `desktop/` is not in the package, so every byte of it was shipping to
       nobody. It was 40% of the packed tarball (721.8 kB with it, 432.3 kB
       without) in a product whose first claim is that the whole download is
       small enough to read in an afternoon.

       The second assertion is the one that matters: the fix must be a negation
       of the FILE, not of `assets/`. ui/index.html asks for /assets/icon.svg by
       name, so dropping the directory would ship an app with a broken favicon
       and nothing would notice until someone opened the board. */
    assert.ok(!entries.includes('assets/icon.png'),
      'the desktop-only app icon is being published to CLI users');
    assert.ok(entries.includes('assets/icon.svg'),
      'assets/icon.svg is missing — ui/index.html asks for it by name, so the board has no icon');
  });

  test('it does not carry the tests, the Electron shell, or the screenshots', () => {
    const strays = entries.filter((e) => /^(test|desktop)\//.test(e) || e.startsWith('docs/shots/'));
    assert.deepEqual(strays, [], `the tarball ships files it should not:\n  ${strays.join('\n  ')}`);
  });

  test('nothing outside the allowlist sneaks in', () => {
    const allowed = (e) => e === 'package.json' || e === 'zelos.mjs' || e === 'LICENSE'
      || e === 'README.md'
      || e.startsWith('core/') || e.startsWith('ui/') || e.startsWith('assets/')
      || /^docs\/[^/]+\.md$/.test(e);
    const strays = entries.filter((e) => !allowed(e));
    assert.deepEqual(strays, [], `unexpected files in the tarball:\n  ${strays.join('\n  ')}`);
  });

  test('the extract has no node_modules and no lockfile', () => {
    for (const name of ['node_modules', 'package-lock.json', 'npm-shrinkwrap.json']) {
      assert.ok(!fs.existsSync(path.join(extracted, name)), `${name} is present in the extract`);
    }
  });

  test('--version runs from the clean extract', async () => {
    const home = freshHome();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['zelos.mjs', '--version'], {
        cwd: extracted,
        env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg.version);
  });

  test('--help runs from the clean extract and names every command', async () => {
    const home = freshHome();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['zelos.mjs', '--help'], {
        cwd: extracted,
        env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    for (const command of ['zelos sweep', 'zelos doctor', 'zelos mcp']) {
      assert.ok(result.stdout.includes(command), `--help does not mention ${command}`);
    }
  });

  test('the installed `zelos` command actually runs, through npm\'s bin symlink', async () => {
    /* REGRESSION, and the reason "--version runs from the clean extract" above
       could not catch it: that test spawns `node zelos.mjs`, which is not how
       anybody who installs this ever invokes it.

       `npm install` writes node_modules/.bin/zelos as a SYMLINK to
       ../zelos-app/zelos.mjs on macOS and Linux. Node resolves the real path of
       the ESM main entry but hands `argv[1]` over exactly as the shell wrote
       it, so the launcher's `path.resolve(process.argv[1]) === fileURLToPath(
       import.meta.url)` compared the link against its target, never matched,
       and `main()` was simply never called. Measured on the packed tarball
       installed three ways — local, `-g` and `npx` — all three produced
       symlinks, and `zelos --version`, `--help`, `doctor` and `sweep` each
       printed nothing, exited 0, and never created $ZELOS_HOME.

       Exit 0 with no output is what makes it expensive rather than merely
       broken: docs/INSTALL.md recommends `zelos sweep` for a cron job
       precisely because "it exits non-zero if the sweep failed", so that cron
       job would have reported success every night while sweeping nothing.

       So this installs the real tarball and runs the real bin entry. Anything
       cheaper — a unit test of the comparison, a spawn of zelos.mjs by path —
       reproduces the shape of the bug without its cause, which is the symlink
       only npm creates. Windows never reaches here (this whole suite is
       skipped there) and could not fail this way anyway: npm writes a .cmd
       shim carrying a real path rather than a link. */
    const installDir = path.join(SCRATCH, 'installed');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, 'package.json'),
      JSON.stringify({ name: 'zelos-install-probe', version: '1.0.0', private: true }, null, 2));

    const [npmExe, ...npmPrefix] = NPM;
    await new Promise((resolve, reject) => {
      /* No scripts, no audit, no funding banner and no lockfile: the package
         has no dependencies, so none of it needs a network and none of it is
         what is being tested here. */
      const child = spawn(npmExe, [...npmPrefix, 'install', tarball,
        '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts'], {
        cwd: installDir,
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => reject(new Error(`could not run npm (${npmExe}): ${e.message}`)));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited ${code}: ${err}`))));
    });

    const bin = path.join(installDir, 'node_modules', '.bin', 'zelos');
    assert.ok(fs.existsSync(bin), 'npm did not install a zelos command at all');
    // If npm ever stops writing a link here the test still passes, but it
    // stops being the test it says it is — so say which case ran.
    const linked = fs.lstatSync(bin).isSymbolicLink();

    const home = freshHome();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(bin, ['--version'], {
        cwd: installDir,
        env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.stdout.trim(), pkg.version,
      `the installed bin printed nothing${linked ? ' through npm\'s symlink' : ''} — main() was never called${result.stderr ? `\nstderr: ${result.stderr}` : ''}`);
    assert.equal(result.code, 0, result.stderr);
  });

  test('a `zelos` installed from the tarball holds the data home', async () => {
    /* The behavioural half of the missing-lock regression above: the file
       being in the tarball is necessary and not sufficient, and the failure
       this replaces was precisely a feature that existed everywhere except
       where it ran. So start the real launcher out of the extract, against a
       home nothing else is using, and read the lock it should have written —
       the pid in it is the only proof that the writer (core/home-lock.mjs's
       publishLock) and the reader (zelos.mjs's holdHomeQuietly) met. */
    const home = freshHome();
    const child = spawn(process.execPath, ['zelos.mjs', '--no-open', '--port', '0'], {
      cwd: extracted,
      env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    try {
      // Wait for the banner rather than for a fixed delay: the lock is taken
      // before the database is opened, so by the time a URL is printed it has
      // either been written or it never will be.
      const deadline = Date.now() + 20_000;
      let port = null;
      while (port === null) {
        const m = /Open\s+(http:\/\/\S+)/.exec(stdout);
        if (m) port = Number(new URL(m[1]).port);
        else if (child.exitCode !== null) throw new Error(`zelos exited ${child.exitCode}:\n${stdout}\n${stderr}`);
        else if (Date.now() > deadline) throw new Error(`no URL was printed:\n${stdout}\n${stderr}`);
        else await new Promise((r) => setTimeout(r, 50));
      }

      const lockFile = path.join(home, 'zelos.lock');
      assert.ok(fs.existsSync(lockFile), `an installed zelos did not take the home lock:\n${stdout}${stderr}`);
      const record = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      assert.equal(record.pid, child.pid, 'the lock names a process that is not the one holding the home');
      assert.equal(record.kind, 'cli', 'a terminal Zelos has to say so, or the warning names the wrong thing to quit');
      // setPort runs after listen(), so this is also the proof that the record
      // is updated once the socket exists — the next process warns with a URL.
      assert.equal(record.port, port, 'the lock does not say where the board is');
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('the bin the tarball declares is the file the tarball contains', () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
    assert.equal(shipped.name, 'zelos-app');
    assert.ok(fs.existsSync(path.join(extracted, shipped.bin.zelos)), 'bin points at a file the tarball does not have');
  });
});

/* ================================================================== *
 * 2. Argument parsing
 * ================================================================== */

describe('parseArgs', () => {
  test('a bare invocation is still exactly what it was', () => {
    assert.deepEqual(parseArgs([]), {
      command: 'run', port: null, home: null, open: true, sweepNow: false,
      mode: null, json: false, version: false, help: false,
    });
    const flags = parseArgs(['--port=7788', '--home', '/tmp/z', '--no-open', '--sweep-now']);
    assert.equal(flags.command, 'run');
    assert.equal(flags.port, 7788);
    assert.equal(flags.home, '/tmp/z');
    assert.equal(flags.open, false);
    assert.equal(flags.sweepNow, true);
  });

  test('every command in the closed set parses', () => {
    for (const command of COMMANDS) {
      assert.equal(parseArgs([command]).command, command);
    }
  });

  test('help and version work as words as well as flags', () => {
    assert.equal(parseArgs(['help']).help, true);
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['version']).version, true);
    assert.equal(parseArgs(['-v']).version, true);
  });

  test('a flag that would do nothing is an error, not a shrug', () => {
    assert.throws(() => parseArgs(['doctor', '--port', '7777']), /--port does not apply/);
    assert.throws(() => parseArgs(['--mode', 'full']), /--mode does not apply/);
    assert.throws(() => parseArgs(['mcp', '--json']), /--json does not apply/);
    // …but they are fine where they belong.
    assert.equal(parseArgs(['sweep', '--mode', 'light']).mode, 'light');
    assert.equal(parseArgs(['doctor', '--json']).json, true);
  });

  test('nonsense is refused with something readable', () => {
    assert.throws(() => parseArgs(['frobnicate']), /unknown command frobnicate/);
    assert.throws(() => parseArgs(['--not-a-flag']), /unknown option/);
    assert.throws(() => parseArgs(['sweep', 'again']), /unexpected argument again/);
    assert.throws(() => parseArgs(['sweep', '--mode', 'sideways']), /--mode must be one of/);
    assert.throws(() => parseArgs(['--home']), /--home needs a value/);
  });

  test('a --home that came from an unset shell variable is refused, not resolved', () => {
    /* REGRESSION, both halves measured before the guard existed.
       `node zelos.mjs doctor --home=undefined` created a real, live data
       directory — drwx------ undefined/{cache,logs} — in the working directory
       and exited 0 with no warning; .gitignore still carries an `undefined/`
       line from the first time it happened. core/config.mjs's homeDir() does
       guard those literals, but it guards $ZELOS_HOME, and main() runs the flag
       through path.resolve on the way into that variable, so by the time the
       guard reads it the string is an absolute path it has no reason to
       suspect. The guard downstream can therefore never fire on this path.

       The empty value is worse, because nothing at all appears to go wrong:
       `--home=` parsed to "", which is falsy, so it was dropped and the command
       operated on the real ~/.zelos — the one outcome somebody keeping a work
       home apart from a personal one must never get. */
    for (const junk of ['undefined', 'null', 'UNDEFINED', ' undefined ']) {
      assert.throws(() => parseArgs(['doctor', `--home=${junk}`]), /literal string/,
        `--home=${junk} was accepted`);
      assert.throws(() => parseArgs(['doctor', '--home', junk]), /literal string/);
    }
    for (const empty of ['', '   ', '\t']) {
      assert.throws(() => parseArgs(['doctor', `--home=${empty}`]), /empty value/,
        `--home=${JSON.stringify(empty)} silently fell back to the real home`);
    }
    // And a directory that merely contains the word is still a directory.
    assert.equal(parseArgs(['doctor', '--home=/tmp/undefined-ish']).home, '/tmp/undefined-ish');
    assert.equal(parseArgs(['doctor', '--home=/tmp/z']).home, '/tmp/z');
  });
});

describe('--help describes the security posture it actually has', () => {
  test('it names /api/mcp as the exception to "a new token every launch"', async () => {
    /* The help said, without qualification, that every request to the API needs
       the session token printed in the launch URL and that the token is new on
       every launch. /api/mcp is routed out of the session gate deliberately and
       authenticates with the AI token minted in Settings, which is persisted —
       reproduced across a real restart: launch 1's session token 401s at launch
       2, while the same AI token still returns the board over /api/mcp. Nothing
       is weaker than advertised (loopback bind, Host and Origin checks, off by
       default, scope-gated, revocable, audit-logged); the sentence was simply
       absolute where the system is not, and it is the sentence somebody reads
       before deciding whether to switch AI access on. */
    const { code, stdout } = await run(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /\/api\/mcp/, '--help does not mention the one route the session gate skips');
    assert.match(stdout, /Settings/, 'and it has to say where that other token comes from');
    assert.match(stdout, /outlive a restart|survives? a restart|until you turn/,
      'the exception is only useful if it says the AI token is not per-launch');
  });
});

/* ================================================================== *
 * 3. doctor — the diagnosis
 * ================================================================== */

const SILENT_DEPS = {
  backend: async () => ({ name: 'macos-keychain', writable: true, note: 'Stored in your login keychain.' }),
  getSecret: async () => null,
  listModels: async () => { throw new Error('listModels should not have been called'); },
  testImap: async () => { throw new Error('testImap should not have been called'); },
  testCalDav: async () => { throw new Error('testCalDav should not have been called'); },
  fetchImpl: async () => { throw new Error('fetch should not have been called'); },
};

const byId = (report, id) => report.checks.find((c) => c.id === id);

describe('doctor', () => {
  test('compareVersions orders releases numerically, not alphabetically', () => {
    assert.equal(compareVersions('22.16.0', MIN_NODE), 0);
    assert.equal(compareVersions('9.0.0', '22.5.0'), -1); // "9" > "2" as text
    assert.equal(compareVersions('26.3.0', '22.5.0'), 1);
    assert.equal(compareVersions('22.4.9', '22.5.0'), -1);
    assert.equal(compareVersions('26.0.0-nightly', '26.0.0'), 0);
  });

  /* This one runs on Windows too, and deliberately so. The `home` check passing
     here does not depend on a mode: checkHome() reads the mode only on the
     platforms that have one, so on Windows a folder that exists and is writable
     is a pass on its own terms. Do not add a win32 skip — it would stop testing
     the path Windows users actually take. */
  test('a brand-new install is not broken, just unfinished', async () => {
    process.env.ZELOS_HOME = freshHome();
    const report = await diagnose({ deps: SILENT_DEPS });
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status === 'fail'), null, 2));
    assert.equal(report.ready, false, 'nothing is configured, so it cannot be ready');
    assert.equal(byId(report, 'node').status, 'pass');
    assert.equal(byId(report, 'home').status, 'pass');
    assert.equal(byId(report, 'mail').status, 'warn');
    assert.equal(byId(report, 'calendar').status, 'warn');
  });

  test('a settings file that will not load is a failure that names the setting', async () => {
    process.env.ZELOS_HOME = freshHome({ version: 1, sweep: { intervalMinutes: 2 }, ui: { accent: 'blue' } });
    const report = await diagnose({ deps: SILENT_DEPS });
    const config = byId(report, 'config');
    assert.equal(config.status, 'fail');
    assert.match(config.detail, /sweep\.intervalMinutes/);
    assert.match(config.detail, /ui\.accent/);
    assert.match(config.action, /config\.json/);
    assert.equal(report.ok, false);
  });

  /**
   * Skipped on Windows, and the skip is the honest answer rather than a way
   * round a red tick. Zelos's at-rest protection on macOS and Linux is the POSIX
   * mode — home 0700, files 0600 — and Windows does not implement those: chmod
   * there sets little beyond the read-only flag, so `chmodSync(home, 0o755)`
   * would not open the folder to anyone and the failure this test exists to
   * provoke cannot be provoked. checkHome() in core/doctor.mjs skips the mode
   * branch on win32 for the same reason, and docs/SECURITY.md already says so
   * rather than claiming a protection Windows does not give.
   *
   * Only the mode assertion is skipped. Everything else about the data folder —
   * that it exists, that it is a folder, that this account can write to it — is
   * checked on all three platforms by the tests around this one.
   */
  test('a home directory other accounts can read is a failure, and says how to close it', async (t) => {
    if (process.platform === 'win32') {
      return t.skip('Windows has no POSIX modes: chmod cannot open the folder to other accounts, so the condition under test cannot exist here (see docs/SECURITY.md)');
    }
    const home = freshHome();
    fs.chmodSync(home, 0o755);
    process.env.ZELOS_HOME = home;
    const report = await diagnose({ deps: SILENT_DEPS });
    const check = byId(report, 'home');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /readable\s+by\s+other\s+accounts/);
    assert.match(check.action, /chmod 700/);
  });

  test('a missing home is a note about the first launch, not an error', async () => {
    process.env.ZELOS_HOME = path.join(SCRATCH, 'never-created-home');
    const report = await diagnose({ deps: SILENT_DEPS });
    const check = byId(report, 'home');
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /does\s+not\s+exist\s+yet/);
    assert.equal(report.ok, true);
  });

  test('a secret store that cannot be written is a failure', async () => {
    process.env.ZELOS_HOME = freshHome();
    const report = await diagnose({
      deps: { ...SILENT_DEPS, backend: async () => ({ name: 'macos-keychain', writable: false, note: 'x' }) },
    });
    assert.equal(byId(report, 'secrets').status, 'fail');
    assert.equal(report.ok, false);
  });

  test('the encrypted-file fallback is surfaced with its own note, and is not a failure', async () => {
    process.env.ZELOS_HOME = freshHome();
    const note = 'This protects the file at rest but not against a process running as you.';
    const report = await diagnose({
      deps: { ...SILENT_DEPS, backend: async () => ({ name: 'encrypted-file', writable: true, note }) },
    });
    const check = byId(report, 'secrets');
    assert.equal(check.status, 'warn');
    assert.ok(check.detail.includes(note), 'the backend note must be repeated verbatim');
    assert.equal(report.ok, true);
  });

  test('a remote model with a chosen model and no stored key is a failure', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', keyRef: 'model.default' },
    });
    const report = await diagnose({ deps: SILENT_DEPS });
    const key = byId(report, 'model.key');
    assert.equal(key.status, 'fail');
    assert.match(key.action, /Settings/);
    // With no key there is nothing to reach the endpoint with, so it is not
    // probed — a second failure that only says "401" would teach nobody anything.
    assert.equal(byId(report, 'model').status, 'skip');
    assert.equal(report.ok, false);
  });

  test('a local model needs no key and is probed anyway', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: { ...SILENT_DEPS, listModels: async () => [{ id: 'llama3.2', label: 'llama3.2' }] },
    });
    assert.equal(byId(report, 'model.key').status, 'pass');
    assert.match(byId(report, 'model.key').detail, /no API key needed/i);
    assert.equal(byId(report, 'model').status, 'pass');
    assert.equal(report.ok, true);
  });

  test('a local model that is not running says how to start it', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        listModels: async () => { throw Object.assign(new Error('Could not reach the model at http://127.0.0.1:11434/v1 (ECONNREFUSED)'), { status: null }); },
      },
    });
    const model = byId(report, 'model');
    assert.equal(model.status, 'fail');
    assert.match(model.action, /ollama serve/);
    assert.equal(report.ok, false);
  });

  test('a key the provider refuses is reported as a key problem, not a network one', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'sk-stored-key',
        listModels: async () => { throw Object.assign(new Error('rejected'), { status: 401 }); },
      },
    });
    const model = byId(report, 'model');
    assert.equal(model.status, 'fail');
    assert.match(model.detail, /refused the stored key/);
    assert.match(model.action, /Settings → AI/);
    assert.ok(!/Settings → Model/.test(model.action), 'the tab is labelled "AI" now, and the doctor still sends people to "Model"');
  });

  test('the doctor talks about the AI service in plain words first, and keeps the address for the expert', async () => {
    // The audit's reader ran `zelos doctor` and met "model endpoint", "base
    // URL" and "provider" before any sentence told them what to do. Every
    // sentence about the AI now opens plain and keeps the address, the HTTP
    // status and the base URL behind "For experts:" — present, never first.
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'sk-stored-key',
        listModels: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { status: null }); },
      },
    });
    const model = byId(report, 'model');
    assert.equal(model.status, 'fail');
    assert.equal(model.label, 'AI', 'the report line is labelled the way the Settings tab is');
    assert.equal(byId(report, 'model.key').label, 'AI key');
    assert.match(model.action, /^Zelos could not reach the AI service\. Check this computer’s internet connection\. For experts: check the base URL in Settings → AI \(https:\/\/api\.anthropic\.com\)/);

    // A fresh install: the defaults point at Claude with nothing chosen and
    // no key, and these are the two lines it prints.
    process.env.ZELOS_HOME = freshHome({});
    const fresh = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(fresh, 'model.key').status, 'warn');
    assert.equal(byId(fresh, 'model.key').detail, 'No AI has been chosen yet, and no key has been saved for the AI service. For experts: the service is https://api.anthropic.com.');
    assert.match(byId(fresh, 'model.key').action, /^Open Settings → AI and paste the key your AI service gave you\./);
    assert.equal(byId(fresh, 'model').status, 'skip');
    assert.match(byId(fresh, 'model').detail, /^Not checked — this AI service needs a key first \(see above\)\. For experts: https:\/\/api\.anthropic\.com\.$/);

    // A key, a service that answers, and still no choice of which AI.
    process.env.ZELOS_HOME = freshHome({});
    const unchosen = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'sk-stored-key',
        listModels: async () => [{ id: 'claude-opus-5', label: 'claude-opus-5' }],
      },
    });
    assert.equal(byId(unchosen, 'model').status, 'warn');
    assert.match(byId(unchosen, 'model').detail, /^The AI service answers, but which of its AIs to use has not been chosen yet/);
    assert.equal(byId(unchosen, 'model').action, 'Open Settings → AI and pick one. This service offers: claude-opus-5.');

    // The words a person was never meant to meet first, across every AI line.
    for (const r of [report, fresh, unchosen]) {
      for (const c of r.checks.filter((x) => x.id === 'model' || x.id === 'model.key')) {
        for (const text of [c.detail, c.action || '']) {
          const plain = text.split('For experts:')[0];
          assert.doesNotMatch(plain, /endpoint|base URL|provider|model id|pulled|Settings → Model/i, `${c.id}: "${text}" leads with a word for the expert`);
        }
      }
    }
  });

  test('a model the endpoint does not offer is a warning that lists what it does', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'llama-4-typo', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: { ...SILENT_DEPS, listModels: async () => [{ id: 'qwen2.5', label: 'qwen2.5' }] },
    });
    const model = byId(report, 'model');
    assert.equal(model.status, 'warn');
    assert.match(model.detail, /does not list "llama-4-typo"/);
    assert.match(model.action, /qwen2\.5/);
    assert.equal(report.ok, true, 'a typo in a model name is not a broken machine');
  });

  test('an endpoint with no model list is still a reachable endpoint', async () => {
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local', keyRef: 'model.default' },
    });
    const report = await diagnose({
      deps: { ...SILENT_DEPS, listModels: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } },
    });
    assert.equal(byId(report, 'model').status, 'pass');
  });

  test('a mail account with no stored password says which password the provider wants', async () => {
    process.env.ZELOS_HOME = freshHome({
      mail: [{ id: 'm_1', enabled: true, label: 'Work', host: 'imap.gmail.com', port: 993, secure: true, user: 'someone@gmail.com', keyRef: 'mail.m_1' }],
    });
    const report = await diagnose({ deps: SILENT_DEPS });
    const check = byId(report, 'mail.m_1');
    assert.equal(check.status, 'fail');
    assert.match(check.action, /App Password/i);
    assert.equal(report.ok, false);
  });

  test('a mail sign-in that is refused explains why an ordinary password fails', async () => {
    process.env.ZELOS_HOME = freshHome({
      mail: [{ id: 'm_2', enabled: true, label: 'Work', host: 'imap.gmail.com', port: 993, secure: true, user: 'someone@gmail.com', keyRef: 'mail.m_2' }],
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'hunter2',
        testImap: async () => ({ ok: false, capabilities: [], mailboxes: [], error: '[AUTHENTICATIONFAILED] Invalid credentials' }),
      },
    });
    const check = byId(report, 'mail.m_2');
    assert.equal(check.status, 'fail');
    assert.match(check.action, /app password/i);
  });

  /**
   * REGRESSION. `requireTls` reached core/sources/imap.mjs from nowhere: not
   * from the sweep, not from the mail test, and not from here. A doctor that
   * signs in where the real run would refuse is not a diagnosis — it is a second,
   * more permissive client, reporting an account healthy on the morning its mail
   * quietly stops arriving.
   */
  test('doctor connects under the account\'s own TLS rule, and says what to do when it refuses', async () => {
    const seen = [];
    const testImap = async (opts) => {
      seen.push(opts);
      return { ok: false, capabilities: [], mailboxes: [], error: 'IMAP 127.0.0.1:1143 — this connection is still in the clear and the server never offered STARTTLS, so your password was not sent.' };
    };

    process.env.ZELOS_HOME = freshHome({
      mail: [
        { id: 'm_strict', enabled: true, label: 'Bridge', host: '127.0.0.1', port: 1143, secure: false, user: 'a@example.com', keyRef: 'mail.m_strict', requireTls: true },
        { id: 'm_quiet', enabled: true, label: 'Work', host: 'imap.fastmail.com', port: 993, secure: true, user: 'b@fastmail.com', keyRef: 'mail.m_quiet' },
        { id: 'm_open', enabled: true, label: 'Local', host: '127.0.0.1', port: 1144, secure: false, user: 'c@example.com', keyRef: 'mail.m_open', requireTls: false },
      ],
    });
    const report = await diagnose({ deps: { ...SILENT_DEPS, getSecret: async () => 'hunter2', testImap } });

    assert.deepEqual(seen.map((o) => o.requireTls), [true, null, false],
      'each account is tested under its own rule, and one that never said becomes null, not false');

    // The refusal must not be dressed up as a rejected credential: nothing was
    // rejected, because nothing was sent.
    const strict = byId(report, 'mail.m_strict');
    assert.equal(strict.status, 'fail');
    assert.match(strict.action, /requireTls/);
    assert.ok(!/App Password|app password/.test(strict.action),
      'a refusal to use cleartext is not a password problem and must not be described as one');
  });

  test('a certificate doctor cannot verify is called that, not a blocked server or a password', async () => {
    process.env.ZELOS_HOME = freshHome({
      mail: [{ id: 'm_cert', enabled: true, label: 'Home server', host: 'mail.home.example', port: 993, secure: true, user: 'a@home.example', keyRef: 'mail.m_cert' }],
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'hunter2',
        testImap: async () => ({ ok: false, capabilities: [], mailboxes: [], error: 'IMAP mail.home.example:993 — connection failed — self-signed certificate' }),
      },
    });
    const line = byId(report, 'mail.m_cert');
    assert.equal(line.status, 'fail');
    assert.match(line.action, /certificate/);
    assert.match(line.action, /Proton Bridge/);
    assert.doesNotMatch(line.action, /blocking IMAP|app password/i);
  });

  test('a mailbox the server does not have is a warning that lists the real ones', async () => {
    process.env.ZELOS_HOME = freshHome({
      mail: [{ id: 'm_3', enabled: true, label: 'Work', host: 'imap.fastmail.com', port: 993, secure: true, user: 'a@fastmail.com', keyRef: 'mail.m_3', mailboxes: ['INBOX', 'Projects'] }],
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => 'app-password',
        listModels: async () => [], // a key exists, so the endpoint does get probed
        testImap: async () => ({ ok: true, capabilities: [], mailboxes: [{ name: 'INBOX' }, { name: 'Archive' }], error: null }),
      },
    });
    const check = byId(report, 'mail.m_3');
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /Projects/);
    assert.match(check.action, /Archive/);
    assert.equal(report.ok, true);
  });

  test('a disabled account is not checked at all', async () => {
    process.env.ZELOS_HOME = freshHome({
      mail: [{ id: 'm_off', enabled: false, label: 'Old', host: 'imap.example.com', user: 'x@example.com', keyRef: 'mail.m_off' }],
    });
    // SILENT_DEPS throws if anything network-shaped is called.
    const report = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(report, 'mail.m_off'), undefined);
    assert.equal(byId(report, 'mail').status, 'warn');
  });

  test('a calendar link that answers 404 is a failure that says to re-copy it', async (t) => {
    const mock = await mockServer((req, res) => { res.writeHead(404); res.end('gone'); });
    t.after(() => mock.close());
    process.env.ZELOS_HOME = freshHome({
      calendars: [{ id: 'c_1', enabled: true, label: 'Team', kind: 'ics', url: `${mock.origin}/team.ics`, user: '', keyRef: null }],
    });
    const report = await diagnose({ deps: { ...SILENT_DEPS, fetchImpl: (...args) => globalThis.fetch(...args) } });
    const check = byId(report, 'calendar.c_1');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /404/);
    assert.match(check.action, /re-copy/i);
  });

  test('a calendar link that answers with a calendar passes', async (t) => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Team',
      'BEGIN:VEVENT', 'UID:1@zelos', 'DTSTART:20260811T180000Z', 'DTEND:20260811T190000Z',
      'SUMMARY:Standup', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    const mock = await mockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(ics);
    });
    t.after(() => mock.close());
    process.env.ZELOS_HOME = freshHome({
      calendars: [{ id: 'c_2', enabled: true, label: 'Team', kind: 'ics', url: `${mock.origin}/team.ics`, user: '', keyRef: null }],
    });
    const report = await diagnose({ deps: { ...SILENT_DEPS, fetchImpl: (...args) => globalThis.fetch(...args) } });
    const check = byId(report, 'calendar.c_2');
    assert.equal(check.status, 'pass', check.detail);
    assert.match(check.detail, /1 entry/);
  });

  test('a local .ics file calendar is read off disk', async () => {
    const home = freshHome();
    const file = path.join(home, 'mine.ics');
    fs.writeFileSync(file, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:2@zelos\r\nDTSTART:20260811T180000Z\r\nSUMMARY:Lunch\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      calendars: [{ id: 'c_3', enabled: true, label: 'Mine', kind: 'file', url: file, user: '', keyRef: null }],
    }));
    process.env.ZELOS_HOME = home;
    const report = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(report, 'calendar.c_3').status, 'pass');

    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      calendars: [{ id: 'c_4', enabled: true, label: 'Gone', kind: 'file', url: path.join(home, 'missing.ics'), user: '', keyRef: null }],
    }));
    const broken = await diagnose({ deps: SILENT_DEPS });
    assert.equal(byId(broken, 'calendar.c_4').status, 'fail');
  });

  test('every failure and every warning ends in something to do', async () => {
    process.env.ZELOS_HOME = freshHome({
      version: 1,
      sweep: { intervalMinutes: 1 },
      model: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', keyRef: 'model.default' },
      mail: [{ id: 'm_9', enabled: true, label: 'Work', host: '', port: 993, secure: true, user: 'me@gmail.com', keyRef: 'mail.m_9' }],
      calendars: [{ id: 'c_9', enabled: true, label: 'Bad', kind: 'ics', url: 'ftp://example.com/x.ics', user: '', keyRef: null }],
    });
    const report = await diagnose({ deps: SILENT_DEPS });
    const actionless = report.checks
      .filter((c) => (c.status === 'fail' || c.status === 'warn') && !c.action)
      .map((c) => c.id);
    assert.deepEqual(actionless, [], `these say what is wrong but not what to do: ${actionless.join(', ')}`);
    for (const c of report.checks) {
      assert.ok(c.detail.length > 0, `${c.id} has no detail`);
      assert.ok(['pass', 'warn', 'fail', 'skip'].includes(c.status), `${c.id} has status ${c.status}`);
    }
  });

  test('no stored secret is ever repeated back in the report', async () => {
    const sentinel = 'sk-do-not-print-me-0000';
    process.env.ZELOS_HOME = freshHome({
      model: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', keyRef: 'model.default' },
      mail: [{ id: 'm_s', enabled: true, label: 'Work', host: 'imap.fastmail.com', port: 993, secure: true, user: 'a@fastmail.com', keyRef: 'mail.m_s' }],
    });
    const report = await diagnose({
      deps: {
        ...SILENT_DEPS,
        getSecret: async () => sentinel,
        listModels: async () => [{ id: 'claude-opus-5', label: 'Claude' }],
        testImap: async () => ({ ok: true, capabilities: [], mailboxes: [{ name: 'INBOX' }], error: null }),
      },
    });
    assert.ok(!JSON.stringify(report).includes(sentinel), 'the report contains a secret value');
    assert.ok(!formatReport(report).includes(sentinel), 'the printed report contains a secret value');
    assert.equal(report.ok, true);
    assert.equal(report.ready, true, 'a model and a source are configured and both answer');
  });

  test('the printed report puts an arrow on every action', async () => {
    process.env.ZELOS_HOME = freshHome({ sweep: { intervalMinutes: 1 } });
    const report = await diagnose({ deps: SILENT_DEPS });
    const text = formatReport(report);
    // Only the line that opens an action carries the marker in that column;
    // "Settings → AI" inside a sentence must not be counted.
    const arrows = (text.match(/^ {7}→ {2}/gm) ?? []).length;
    const actions = report.checks.filter((c) => c.action).length;
    assert.equal(arrows, actions, 'every action line should be marked, and nothing else should be');
    assert.match(text, /ZELOS DOCTOR/);
    assert.ok(text.split('\n').every((line) => line.length <= 100), 'the report should not need a wide terminal');
  });
});

/* ================================================================== *
 * 4. The subcommands, as processes
 * ================================================================== */

describe('zelos doctor, from the command line', () => {
  test('a fresh home exits 0 and reads like sentences', async () => {
    const { code, stdout } = await run(['doctor']);
    assert.equal(code, 0);
    assert.match(stdout, /ZELOS DOCTOR/);
    assert.match(stdout, /Node\.js/);
    assert.match(stdout, /Nothing is broken/);
  });

  test('a broken settings file exits 1', async () => {
    const home = freshHome({ version: 1, ui: { accent: 'not-a-colour' } });
    const { code, stdout } = await run(['doctor'], { home });
    assert.equal(code, 1, stdout);
    assert.match(stdout, /ui\.accent/);
  });

  test('--json prints the same findings as machine-readable data', async () => {
    const home = freshHome({ version: 1, ui: { accent: 'not-a-colour' } });
    const { code, stdout } = await run(['doctor', '--json'], { home });
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, false);
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.some((c) => c.id === 'config' && c.status === 'fail'));
    assert.equal(report.home, home);
  });
});

describe('zelos sweep, from the command line', () => {
  test('with nothing configured it fails, says why, and points at doctor', async () => {
    const { code, stdout } = await run(['sweep']);
    assert.equal(code, 1);
    assert.match(stdout, /Sweep failed/);
    assert.match(stdout, /zelos doctor/);
  });

  test('against a model on this machine it runs, summarises, and exits 0', async (t) => {
    const board = {
      first: null,
      items: [],
      notes: ['Nothing needs you right now.'],
    };
    let hits = 0;
    const mock = await mockServer((req, res) => {
      hits += 1;
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'mock-local',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(board) } }],
          usage: { prompt_tokens: 120, completion_tokens: 34 },
        }));
      });
    });
    t.after(() => mock.close());

    const home = freshHome({
      model: { protocol: 'openai', baseUrl: `${mock.origin}/v1`, label: 'Local', model: 'mock-local', keyRef: 'model.default' },
    });
    const { code, stdout, stderr } = await run(['sweep'], { home });
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.equal(hits, 1, 'the sweep should have called the model exactly once');
    assert.match(stdout, /ZELOS SWEEP/);
    assert.match(stdout, /Full sweep finished/);
    assert.match(stdout, /Board/);
    assert.match(stdout, /120 tokens in, 34 out/);
  });

  test('--mode light never calls the model', async (t) => {
    let hits = 0;
    const mock = await mockServer((req, res) => {
      hits += 1;
      res.writeHead(500);
      res.end('{}');
    });
    t.after(() => mock.close());
    const home = freshHome({
      model: { protocol: 'openai', baseUrl: `${mock.origin}/v1`, label: 'Local', model: 'mock-local', keyRef: 'model.default' },
    });
    const { code, stdout } = await run(['sweep', '--mode', 'light'], { home });
    assert.equal(code, 0, stdout);
    assert.equal(hits, 0, 'a light sweep must not reach the model');
    assert.match(stdout, /Light sweep finished/);
  });

  test('--json emits the run result and nothing else on stdout', async () => {
    const home = freshHome();
    const { code, stdout } = await run(['sweep', '--json'], { home });
    assert.equal(code, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    assert.ok(result.runId, 'the result should name its run');
    assert.ok(result.error, 'a failed run should carry its reason');
  });

  test('it holds the data home too, and says when somebody else has it', async () => {
    /* `zelos sweep` took no lock on any path — and it is the path that meets
       the problem most often, because docs/INSTALL.md recommends exactly this
       command for a crontab. A scheduled sweep landing on the home the desktop
       app is already sweeping reads the same mail twice and pays for the same
       model calls twice, with nothing anywhere saying so.

       The lock here is held by this test process, which is alive and
       signallable, so the subprocess has to find it held rather than reclaim
       it as stale. What is being proved is the whole chain: the record written
       by core/home-lock.mjs's publishLock, read back by acquireHomeLock in the
       child, phrased by contestMessage, and reaching a human through
       zelos.mjs's holdHomeQuietly → log.warn → stderr. */
    const home = freshHome();
    const mine = acquireHomeLock({ home, kind: 'desktop', port: 61234 });
    try {
      const { stderr } = await run(['sweep'], { home });
      assert.match(stderr, /already in use/, `a busy home went unreported:\n${stderr}`);
      assert.match(stderr, /another copy of the Zelos app/, 'and it has to name what to quit');
      assert.match(stderr, new RegExp(`process ${process.pid}\\b`));
      assert.match(stderr, /http:\/\/127\.0\.0\.1:61234\//, 'the port in the lock is what makes the warning actionable');
      assert.match(stderr, /delete /, 'a warning nobody can clear is a lockout');
      // Advisory, never a refusal: the sweep still ran and still reported its
      // own failure (nothing is configured), not the lock's.
      assert.equal(readHomeLock(home).pid, process.pid, 'the child took a lock that was not its to take');
    } finally {
      mine.release();
    }
  });

  test('it holds the lock for the length of the run and gives it back at the end', async (t) => {
    /* This test used to be called 'a sweep still leaves the lock behind it'
       while asserting that the lock was GONE, with the message 'the lock
       outlived the sweep that took it'. The title was the odd one out: the
       assertion and the message agree with the code, because `holdHome`
       registers its release on 'exit' (core/home-lock.mjs:364) precisely so
       that the next `zelos sweep` in the crontab is not warned off a home
       nobody is in.

       Half a test, though. `readHomeLock(home) === null` is also what a home
       that was never locked at all looks like, so deleting the
       `holdHomeQuietly` call from `commandSweep` left it green — measured. The
       missing half is an observation from inside the run, and the sweep hands
       one over: its model call arrives at this process, in this handler, while
       the child is still going. The lock file is on disk at that moment or the
       feature does not exist. */
    let home;
    let duringSweep = 'the model was never called, so nothing looked at the lock mid-run';
    const mock = await mockServer((req, res) => {
      duringSweep = readHomeLock(home);
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'mock-local',
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ first: null, items: [], notes: [] }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      });
    });
    t.after(() => mock.close());

    home = freshHome({
      model: { protocol: 'openai', baseUrl: `${mock.origin}/v1`, label: 'Local', model: 'mock-local', keyRef: 'model.default' },
    });
    const { code, stdout, stderr } = await run(['sweep'], { home });
    assert.equal(code, 0, `${stdout}\n${stderr}`);

    assert.ok(duringSweep && typeof duringSweep === 'object',
      `the sweep was mid-run and the home held no lock: ${JSON.stringify(duringSweep)}`);
    assert.equal(duringSweep.kind, 'cli', 'the record has to say which half of Zelos is in there');
    assert.notEqual(duringSweep.pid, process.pid, 'the lock must name the sweeping child, not this test');

    assert.equal(readHomeLock(home), null, 'the lock outlived the sweep that took it');
  });
});

/* ------------------------------------------------------------------ *
 * Stopping a sweep
 * ------------------------------------------------------------------ */

/**
 * An IMAP server that answers everything up to SELECT and then talks forever
 * without ever finishing the command.
 *
 * This is the shape the finding was measured against, and the detail that
 * matters is that it keeps EMITTING. core/sources/imap.mjs has a 30s silence
 * deadline, so a server that goes quiet is bounded; a server that sends a valid
 * untagged response every few hundred milliseconds resets that deadline forever
 * and the read never ends on its own. Nothing here leaves 127.0.0.1.
 */
function startChattyImap() {
  const sockets = new Set();
  const timers = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK Zelos never-ending mock ready\r\n');

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parts = line.split(' ');
        const tag = parts[0] || '';
        const verb = (parts[1] || '').toUpperCase();

        if (verb === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
        else if (verb === 'LOGIN') socket.write(`${tag} OK LOGIN completed\r\n`);
        else if (verb === 'SELECT' || verb === 'EXAMINE') {
          // No tagged completion, ever — just enough traffic to keep the
          // client's idle deadline from firing.
          const beat = setInterval(() => {
            if (socket.destroyed) return;
            socket.write('* OK [UNSEEN 1] still here\r\n');
          }, 250);
          timers.add(beat);
        } else socket.write(`${tag} BAD unexpected command in mock\r\n`);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => {
        for (const t of timers) clearInterval(t);
        for (const s of sockets) s.destroy();
        return new Promise((r) => server.close(r));
      },
    }));
  });
}

/**
 * How long the launcher waits for an aborted sweep before leaving anyway, read
 * out of the launcher.
 *
 * `SWEEP_STOP_GRACE_MS` is a private constant of `commandSweep` and has no
 * business being exported for a test. The two tests below are entirely about
 * the wait being bounded by it, so a copy of the number here would be a second
 * place for it to live and a second place for it to go stale — the same trap
 * as the `const MONTH_VISIBLE = 3` that test/ui.test.mjs used to keep beside a
 * line reference that had already moved. A grace period raised to 30s must
 * change what these tests allow, not silently outlive them.
 */
function sweepStopGraceMs() {
  const src = fs.readFileSync(path.join(ROOT, 'zelos.mjs'), 'utf8');
  const m = /\nconst SWEEP_STOP_GRACE_MS = ([\d_]+);/.exec(src);
  if (!m) {
    throw new Error('zelos.mjs no longer declares SWEEP_STOP_GRACE_MS where this reader looks — '
      + 'fix the reader, do not restate the number');
  }
  return Number(m[1].replaceAll('_', ''));
}

/** Put a password where the sweep will look for it, in this home only. */
async function seedMailPassword(home, ref, value) {
  const previous = process.env.ZELOS_HOME;
  process.env.ZELOS_HOME = home;
  try {
    const { setSecret } = await import('../core/secrets.mjs');
    await setSecret(ref, value);
  } finally {
    if (previous === undefined) delete process.env.ZELOS_HOME;
    else process.env.ZELOS_HOME = previous;
  }
}

describe('Ctrl-C during a sweep', { skip: process.platform === 'win32'
  ? 'Windows does not deliver POSIX signals; a handler that answers one cannot be tested here'
  : false }, () => {
  /**
   * REGRESSION, in two halves that landed a wave apart.
   *
   * `commandSweep` attached SIGINT and SIGTERM listeners, which removes Node's
   * default terminate-on-signal — so from that moment Ctrl-C did whatever those
   * listeners said and nothing else. What they said was `controller.abort()`,
   * silently, and abort was observed only between mailboxes while the mail
   * reader did not forward the signal into its socket at all. Measured against
   * this same mock: six SIGINTs and a SIGTERM all set `aborted` and changed
   * nothing, and the process held the terminal for 27 seconds without printing
   * a character. The `run` path prints "Stopping (SIGINT)."; this one printed
   * nothing, which is the whole difference between a program that is stopping
   * and a program that is stuck.
   *
   * The first half of the fix was the launcher's: say so, bound the wait with a
   * 5s unref'd escape timer, and let a second signal through. The tests here
   * were written against that, and asserted that one signal was NOT enough —
   * that the read held on and the timer was what ended the run, exit 128+signal.
   *
   * The second half then threaded `signal` into the reader
   * (core/sources/imap.mjs:627-634 — an abort fails the command in flight and
   * destroys the socket), and that turned those assertions upside down: one
   * signal now ends the run in about a tenth of a second, the escape timer never
   * comes due, and the exit code is the sweep's own 1 for a run that did not
   * finish rather than 130/143 from `leave()`. Both are non-zero, which is what
   * the crontab in docs/INSTALL.md reads, and "it stopped when I asked" is the
   * better product.
   *
   * So these two tests now assert the opposite of what they used to, and the
   * assertion that carries the weight is the one saying the timer did NOT fire:
   * put the reader back to ignoring its signal and the wait goes from ~100ms to
   * the full grace, with "that source will not let go" underneath it.
   *
   * What that leaves untested, said out loud rather than quietly dropped:
   * `leave()`'s 128+signal exit and the "Stopping now" second-signal branch
   * (zelos.mjs:539-556) are no longer reachable through the front door, because
   * every source Zelos has — IMAP, CalDAV/ICS fetches, and the model call —
   * honours the signal now. They are a net for a source that stops honouring
   * it, and nothing here can stage one without a hole in production code.
   */
  let imap;
  let home;

  before(async () => {
    imap = await startChattyImap();
    home = freshHome({
      mail: [{
        id: 'm_stuck', enabled: true, label: 'Work',
        host: '127.0.0.1', port: imap.port, secure: false, requireTls: false,
        user: 'nemo@example.com', keyRef: 'mail.m_stuck',
        mailboxes: ['INBOX'], sentMailbox: '', lookbackDays: 14, maxMessages: 10,
      }],
      sweep: { intervalMinutes: 30, activeHours: [0, 24], auto: false },
    });
    await seedMailPassword(home, 'mail.m_stuck', 'app-password');
  });

  after(async () => { await imap?.close(); });

  /** Start a sweep and wait until it is genuinely inside the mail read. */
  async function sweepingChild() {
    const child = spawn(process.execPath, ['zelos.mjs', 'sweep'], {
      cwd: ROOT,
      env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const seen = { stdout: '', stderr: '' };
    child.stdout.on('data', (d) => { seen.stdout += d; });
    child.stderr.on('data', (d) => { seen.stderr += d; });
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));

    const deadline = Date.now() + 20_000;
    while (!/Reading mail/.test(seen.stderr)) {
      if (child.exitCode !== null) throw new Error(`the sweep exited before it read anything:\n${seen.stderr}`);
      if (Date.now() > deadline) throw new Error(`the sweep never started reading:\n${seen.stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    // The progress line is printed before the socket is opened; give the read
    // long enough to be sitting on the mock rather than still resolving DNS.
    await new Promise((r) => setTimeout(r, 400));
    return { child, seen, exited };
  }

  test('one Ctrl-C both says so and cuts the read', async () => {
    const grace = sweepStopGraceMs();
    const { child, seen, exited } = await sweepingChild();
    try {
      const sent = Date.now();
      child.kill('SIGINT');
      const result = await Promise.race([
        exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error(
          `one Ctrl-C left the sweep running:\n${seen.stderr}`)), 20_000).unref()),
      ]);
      const waited = Date.now() - sent;

      // Half one: it speaks. A silent Ctrl-C is what made this read as a freeze.
      assert.match(seen.stderr, /Stopping \(SIGINT\)/,
        `Ctrl-C during a sweep printed nothing, so it reads as a freeze:\n${seen.stderr}`);

      /* Half two, and the assertion this test exists for: the READ let go,
         rather than the launcher giving up on it. The mock never completes
         SELECT and emits every 250ms forever, so a client that does not forward
         its signal into the socket cannot be interrupted at all — it sits there
         until the escape timer fires at `grace`, prints "will not let go", and
         is force-exited. Both of those are what a reverted reader looks like. */
      assert.doesNotMatch(seen.stderr, /will not let go/,
        `the sweep was ended by the escape hatch, not by the read letting go:\n${seen.stderr}`);
      assert.ok(waited < grace,
        `one Ctrl-C took ${waited}ms against a ${grace}ms grace, so the timer is what ended this, `
        + `not the abort reaching the socket:\n${seen.stderr}`);

      // And it says why it stopped, in the summary a person reads.
      assert.match(seen.stdout, /Sweep cancelled/, `the summary must name the reason:\n${seen.stdout}`);
      // Non-zero is the contract the crontab in docs/INSTALL.md depends on. It
      // is the sweep's own 1 now rather than 130 from `leave()`, because the
      // run unwinds and returns before the escape hatch is reached at all.
      assert.equal(result.signal, null, 'the process ended on its own, so it should not report a signal');
      assert.notEqual(result.code, 0, `an interrupted sweep must not exit 0:\n${seen.stdout}\n${seen.stderr}`);
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('one SIGTERM on its own still ends it, without a second signal', async () => {
    /* Cron itself never sends SIGTERM, so a plain crontab never met this. The
       wrappers do — `timeout N zelos sweep`, systemd's TimeoutStopSec, launchd
       — and those send one signal and then wait. Before any of this they waited
       for as long as the server cared to keep talking. */
    const grace = sweepStopGraceMs();
    const { child, seen, exited } = await sweepingChild();
    try {
      /* The home is locked right now — `commandSweep` takes it before it opens
         the database — which is what makes the null at the end of this test a
         release rather than an absence. Without this line the assertion below
         passes just as well on a sweep that never locked anything. */
      const held = readHomeLock(home);
      assert.equal(held?.kind, 'cli',
        `the sweep is sitting in the mail read and holds no lock: ${JSON.stringify(held)}`);

      const sent = Date.now();
      child.kill('SIGTERM');
      const result = await Promise.race([
        exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error(
          `one SIGTERM left the sweep running:\n${seen.stderr}`)), 20_000).unref()),
      ]);
      const waited = Date.now() - sent;
      assert.match(seen.stderr, /Stopping \(SIGTERM\)/);
      assert.ok(waited < grace,
        `one SIGTERM took ${waited}ms against a ${grace}ms grace, so it was the escape hatch that `
        + `ended this rather than the read letting go:\n${seen.stderr}`);
      assert.notEqual(result.code, 0, `an interrupted sweep must not exit 0:\n${seen.stdout}\n${seen.stderr}`);

      // And the stop still lets go of the home, on the cancelled path as much
      // as on the finished one — a sweep that stopped mid-read must not leave
      // the next one warned off a home nobody holds.
      assert.equal(readHomeLock(home), null, 'a cancelled sweep left its lock behind');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('zelos mcp, from the command line', () => {
  test('it serves JSON-RPC on stdout and exits 0 when stdin closes', async () => {
    const { code, stdout } = await run(['mcp'], { stdin: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n' });
    assert.equal(code, 0);
    const lines = stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `stdout must carry JSON-RPC and nothing else:\n${stdout}`);
    assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: {} });
  });

  test('the launch banner never reaches the JSON-RPC channel', async () => {
    const { stdout } = await run(['mcp'], { stdin: '' });
    assert.equal(stdout, '', `zelos mcp wrote to stdout with no request pending:\n${stdout}`);
  });
});

describe('the bare invocation is untouched', () => {
  test('it still starts a server on 127.0.0.1 and prints a tokened URL', async () => {
    const home = freshHome();
    const child = spawn(process.execPath, ['zelos.mjs', '--no-open', '--port', '0'], {
      cwd: ROOT,
      env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    try {
      const deadline = Date.now() + 20_000;
      let url = null;
      while (!url) {
        const m = /Open\s+(http:\/\/\S+)/.exec(stdout);
        if (m) url = new URL(m[1]);
        else if (child.exitCode !== null || Date.now() > deadline) throw new Error(`no URL was printed:\n${stdout}`);
        else await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(url.hostname, '127.0.0.1');
      assert.match(url.searchParams.get('t') ?? '', /^[0-9a-f]{64}$/);
    } finally {
      child.kill('SIGKILL');
    }
  });

  /**
   * REGRESSION, and a contract rather than a unit. `handleConfigPut` hands the
   * saved config to `ctx.scheduler`, which repairs the setting that never
   * reached a running sweep — but only if a scheduler is there to hand it to,
   * and the launcher used to build one only `if (config.sweep.auto)`. That left
   * the mirror case wide open: start with the schedule OFF and there is nothing
   * to reconfigure, so ticking "Sweep on a schedule" wrote to disk and changed
   * nothing until the next launch.
   *
   * The route's own test cannot see this — it supplies a scheduler. Only the
   * real launcher decides whether one exists, so this starts the real launcher
   * against a home seeded with `auto: false` and reads /api/health, which is
   * the one surface that reports `scheduler: null` when none was built.
   */
  test('the schedule can be switched on without a relaunch', async () => {
    const home = freshHome({ sweep: { auto: false } });
    const child = spawn(process.execPath, ['zelos.mjs', '--no-open', '--port', '0'], {
      cwd: ROOT,
      env: { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    try {
      const deadline = Date.now() + 20_000;
      let url = null;
      while (!url) {
        const m = /Open\s+(http:\/\/\S+)/.exec(stdout);
        if (m) url = new URL(m[1]);
        else if (child.exitCode !== null) throw new Error(`zelos exited ${child.exitCode}:\n${stdout}\n${stderr}`);
        else if (Date.now() > deadline) throw new Error(`no URL was printed:\n${stdout}\n${stderr}`);
        else await new Promise((r) => setTimeout(r, 50));
      }
      const api = (p, init = {}) => fetch(new URL(p, url.origin), {
        ...init,
        headers: { 'X-Zelos-Token': url.searchParams.get('t'), 'Content-Type': 'application/json', ...(init.headers || {}) },
      });

      // A scheduler has to exist even with the schedule off, or there is
      // nothing for a later save to reach.
      const before = await (await api('/api/health')).json();
      assert.ok(before.scheduler, 'launching with sweep.auto:false built no scheduler, so the setting cannot be switched on');
      assert.equal(before.scheduler.auto, false, 'an idle scheduler must still report the schedule as off');

      const cfg = await (await api('/api/config')).json();
      const put = await api('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ ...cfg.config, sweep: { ...cfg.config.sweep, auto: true } }),
      });
      assert.equal(put.status, 200, `saving the config failed:\n${await put.text()}`);

      const after = await (await api('/api/health')).json();
      assert.equal(after.scheduler?.auto, true, 'the schedule was switched on and the running scheduler never heard');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Opening the browser
 * ------------------------------------------------------------------ */

describe('the session token never reaches a command line', () => {
  /**
   * REGRESSION. The launch URL was handed to `open`/`xdg-open`/`cmd` as an
   * argument, so for the length of the launch — and, on Linux, for the whole
   * life of the browser — the session token sat in an argument vector any
   * co-resident process could read. That token is the entire local API.
   * core/secrets.mjs refuses to put a password in argv for exactly this reason;
   * these tests hold the launcher to the same rule.
   */
  const TOKEN = 'f3a1c9'.repeat(10) + 'abcd';
  const URL_WITH_TOKEN = `http://127.0.0.1:7777/?t=${TOKEN}`;
  const PLATFORMS = ['darwin', 'win32', 'linux', 'freebsd'];

  /** Just enough of a ChildProcess for openBrowser to drive. */
  function fakeChild(seen) {
    const stdin = { writes: [], on() {}, end(chunk) { if (chunk !== undefined) stdin.writes.push(String(chunk)); } };
    seen.stdin = stdin;
    return { on() {}, unref() {}, stdin };
  }

  test('no platform hands the token to a child process as an argument', () => {
    for (const platform of PLATFORMS) {
      const plan = browserLaunchPlan({ url: URL_WITH_TOKEN, platform });
      assert.ok(plan, `${platform} produced no plan at all`);
      const argv = [plan.command, ...plan.args].join(' ');
      assert.ok(!argv.includes(TOKEN), `${platform} put the session token in argv: ${argv}`);
      assert.ok(!plan.target.includes(TOKEN) || plan.stdin !== null,
        `${platform} routed the tokened URL through something that is not stdin`);
    }
  });

  test('macOS and Windows pass the URL on stdin, so it opens without pasting', () => {
    for (const platform of ['darwin', 'win32']) {
      const plan = browserLaunchPlan({ url: URL_WITH_TOKEN, platform });
      assert.deepEqual(plan.args, [], `${platform} should need no arguments at all`);
      assert.ok(plan.stdin.includes(URL_WITH_TOKEN), `${platform} did not send the URL on stdin`);
      assert.equal(plan.handsOverToken, true);
    }
    assert.equal(browserLaunchPlan({ url: URL_WITH_TOKEN, platform: 'darwin' }).command, 'osascript');
    assert.equal(browserLaunchPlan({ url: URL_WITH_TOKEN, platform: 'win32' }).command, 'cmd');
  });

  test('a platform with no private opener opens the tokenless address instead', () => {
    // xdg-open takes a positional argument and execs a browser with another, so
    // there is no private route at all: the user pastes what the banner printed.
    for (const platform of ['linux', 'freebsd']) {
      const plan = browserLaunchPlan({ url: URL_WITH_TOKEN, platform });
      assert.equal(plan.command, 'xdg-open');
      assert.deepEqual(plan.args, ['http://127.0.0.1:7777/']);
      assert.equal(plan.stdin, null);
      assert.equal(plan.handsOverToken, false, 'the user has to be told they must paste');
    }
  });

  test('a one-time handoff is used everywhere, and carries no token', () => {
    const handoffUrl = 'http://127.0.0.1:7777/h/9f3a1c7e5b2d4088';
    for (const platform of PLATFORMS) {
      const plan = browserLaunchPlan({ url: URL_WITH_TOKEN, handoffUrl, platform });
      const everything = [plan.command, ...plan.args, plan.stdin ?? ''].join(' ');
      assert.ok(!everything.includes(TOKEN), `${platform} leaked the token alongside the handoff`);
      assert.ok(everything.includes(handoffUrl), `${platform} did not use the handoff`);
      assert.equal(plan.handsOverToken, true);
      assert.equal(plan.stdin, null, 'a spent nonce is safe in argv, so the plain opener is fine');
    }
  });

  test('openBrowser spawns nothing that carries the token in argv', () => {
    for (const platform of PLATFORMS) {
      const seen = {};
      const spawn = (command, args, options) => {
        seen.command = command;
        seen.args = args;
        seen.options = options;
        return fakeChild(seen);
      };
      assert.equal(openBrowser(browserLaunchPlan({ url: URL_WITH_TOKEN, platform }), { spawn }), true);
      assert.ok(!JSON.stringify([seen.command, seen.args]).includes(TOKEN),
        `${platform} spawned ${seen.command} ${JSON.stringify(seen.args)}`);
      if (seen.stdin.writes.length) {
        assert.ok(seen.stdin.writes.join('').includes(URL_WITH_TOKEN), `${platform} wrote nothing usable to stdin`);
      }
    }
  });

  /**
   * REGRESSION, and the reason the one above was not enough. The launcher gated
   * the whole handoff on `typeof server.zelos.mintHandoff === 'function'` and
   * the server exposed no such function, so the branch was permanently false and
   * every launch went on putting the token in argv. A test that supplies its own
   * handoff URL cannot see that; this one asks the real server for one.
   */
  test('the server mints a handoff the launcher can actually open', async () => {
    const { createServer, listen } = await import('../core/server.mjs');
    const dbm = await import('../core/db.mjs');
    const handle = dbm.open(':memory:');
    dbm.migrate(handle);
    const server = createServer({ db: handle });
    const { url: origin, tokenUrl } = await listen(server, { port: 0 });

    try {
      assert.equal(typeof server.zelos.mintHandoff, 'function',
        'the launcher checks for exactly this before it will open a browser privately');

      // The two lines main() runs, verbatim.
      const at = server.zelos.mintHandoff();
      const handoffUrl = new URL(at, origin).href;

      for (const platform of PLATFORMS) {
        const plan = browserLaunchPlan({ url: tokenUrl, handoffUrl, platform });
        const everything = [plan.command, ...plan.args, plan.stdin ?? ''].join(' ');
        assert.ok(!everything.includes(server.sessionToken),
          `${platform} still launches with the token: ${everything}`);
        assert.ok(everything.includes(handoffUrl), `${platform} did not use the server's handoff`);
        assert.equal(plan.handsOverToken, true, `${platform} would make the user paste`);
      }

      // And the address the launcher built is one this server answers: a handoff
      // the browser cannot spend is the same dead branch with extra steps.
      const res = await fetch(handoffUrl, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `/?t=${server.sessionToken}`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      dbm.close(handle);
    }
  });

  test('anything that is not one of our own launch URLs is not run at all', () => {
    const bad = [
      'http://evil.example/?t=x',
      'https://127.0.0.1:7777/?t=x',
      'http://127.0.0.1:7777/?t=a&calc=1',
      'http://127.0.0.1:7777/" ; rm -rf ~',
      'http://127.0.0.1:7777/?t=$(id)',
      'file:///etc/passwd',
      'not a url at all',
      '',
      null,
      undefined,
    ];
    for (const url of bad) {
      assert.equal(browserLaunchPlan({ url, platform: 'win32' }), null, JSON.stringify(url));
      assert.equal(browserLaunchPlan({ url: URL_WITH_TOKEN, handoffUrl: url, platform: 'darwin' }).stdin !== null, true,
        `a bad handoff (${JSON.stringify(url)}) must fall back, never be run`);
    }
    assert.equal(openBrowser(null, { spawn: () => { throw new Error('nothing should have been spawned'); } }), false);
  });
});

describe('a runtime without FTS5 (TT-3467)', () => {
  /* QA, 2026-10-10: on a first run the refusal ended "nothing in your Zelos
     home has been changed" — after the launcher had made the home, logs/,
     cache/, .data-connections/ and an empty WAL-mode zelos.db. FTS5's absence
     is simulated, as QA did, with a preload that makes every FTS5 table fail. */
  let preload;
  before(() => {
    const file = path.join(SCRATCH, 'no-fts5.mjs');
    fs.writeFileSync(file, [
      "import sqlite from 'node:sqlite';",
      'const exec = sqlite.DatabaseSync.prototype.exec;',
      'sqlite.DatabaseSync.prototype.exec = function (sql) {',
      "  if (/using\\s+fts5/i.test(String(sql))) throw new Error('no such module: fts5');",
      '  return exec.call(this, sql);',
      '};',
    ].join('\n'));
    preload = `--import=${pathToFileURL(file).href}`;
  });

  for (const args of [[], ['sweep'], ['mcp']]) {
    test(`\`zelos ${args.join(' ') || '(serve)'}\` refuses before it makes a home, in one sentence`, async () => {
      const home = path.join(SCRATCH, `never-made-${homeCounter += 1}`);
      const result = await run(args.length ? args : ['--no-open'], {
        home,
        env: { NODE_OPTIONS: preload },
      });
      assert.equal(result.code, 1, `exit ${result.code}\n${result.stderr}`);
      assert.match(result.stderr, /built without SQLite's FTS5 extension/);
      assert.match(result.stderr, /nothing in your Zelos home has been changed/);
      assert.doesNotMatch(result.stderr, /\n\s+at /, 'a stack trace instead of the sentence');
      assert.equal(fs.existsSync(home), false, `the home was created: ${fs.existsSync(home) ? fs.readdirSync(home).join(', ') : ''}`);
    });
  }
});

test('a command that gives up prints the refusal sentence for a runtime without FTS5, a stack otherwise (TT-3502)', async () => {
  /* QA, 2026-10-10: `zelos mcp` on a runtime without FTS5 printed a stack
     trace where the server and doctor print the one-sentence refusal. Both mcp
     entry points (the CLI's and the desktop app's) now print through fatalText. */
  const { fatalText, UnsupportedRuntimeError, assertRuntimeSupported } = await import('../core/db.mjs');
  let refusal;
  try {
    const sqlite = await import('node:sqlite');
    const exec = sqlite.DatabaseSync.prototype.exec;
    sqlite.DatabaseSync.prototype.exec = function (sql) {
      if (/using\s+fts5/i.test(String(sql))) throw new Error('no such module: fts5');
      return exec.call(this, sql);
    };
    try { assertRuntimeSupported(); } catch (err) { refusal = err; } finally { sqlite.DatabaseSync.prototype.exec = exec; }
  } catch { /* fall through */ }
  assert.ok(refusal instanceof UnsupportedRuntimeError, 'the refusal could not be produced, so this proves nothing');
  const said = fatalText('zelos mcp', refusal);
  assert.match(said, /built without SQLite's FTS5 extension/);
  assert.doesNotMatch(said, /\n\s+at /, 'a stack trace instead of the sentence');
  assert.match(fatalText('zelos mcp', new Error('boom')), /^zelos mcp: Error: boom\n\s+at /, 'anything else keeps its stack');
  // The desktop path, where this is reachable, is driven end to end in
  // test/desktop.test.mjs; the CLI's own launcher refuses before commandMcp.
});

describe('zelos doctor sees the data folder as it is (TT-3484)', () => {
  /* QA, 2026-10-10: the launcher called paths() — which creates the home and
     sets it to 0700 — before doctor ran, so a missing or world-readable home
     was silently fixed, then reported as fine; a home that is a file printed a
     stack trace; and a hand-broken config.json was renamed aside, then reported
     as "No settings file has been written yet… Nothing to do", with exit 0. */
  const doctorIn = (home) => run(['doctor'], { home, env: { ZELOS_SECRETS_BACKEND: 'encrypted-file' } });

  test('a missing home is reported, and left missing', async () => {
    const home = path.join(SCRATCH, `doctor-missing-${homeCounter += 1}`);
    const result = await doctorIn(home);
    assert.equal(result.code, 0, 'a home that is not made yet is worth knowing, not broken');
    assert.match(result.stdout, /does\s+not\s+exist\s+yet/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.equal(fs.existsSync(home), false, `doctor made the home: ${fs.existsSync(home) ? fs.readdirSync(home).join(', ') : ''}`);
  });

  test('a world-readable home is reported, not quietly locked down', { skip: process.platform === 'win32' }, async () => {
    const home = freshHome();
    fs.chmodSync(home, 0o755);
    const result = await doctorIn(home);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /readable\s+by\s+other\s+accounts/);
    assert.equal(fs.statSync(home).mode & 0o777, 0o755, 'doctor changed the mode it was reporting');
  });

  test('a home that is a file gets the sentence, not a stack trace', async () => {
    const home = path.join(SCRATCH, `doctor-file-${homeCounter += 1}`);
    fs.writeFileSync(home, 'not a folder');
    const result = await doctorIn(home);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /is\s+a\s+file,\s+not\s+a\s+folder/);
    assert.doesNotMatch(result.stderr, /\n\s+at /, 'a stack trace');
  });

  test('a config.json that is valid JSON but not an object is not "valid"', async () => {
    const home = freshHome();
    fs.writeFileSync(path.join(home, 'config.json'), '[]', { mode: 0o600 });
    const result = await doctorIn(home);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /not\s+a\s+JSON\s+object/);
  });

  test('a broken config.json is reported and left where it is', async () => {
    const home = freshHome();
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, '{ "identity": ', { mode: 0o600 });
    const result = await doctorIn(home);
    assert.notEqual(result.code, 0, 'a broken settings file passed');
    assert.match(result.stdout, /not\s+valid JSON/);
    assert.doesNotMatch(result.stdout, /No\s+settings\s+file\s+has\s+been\s+written\s+yet/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ "identity": ', 'doctor moved or changed the file it was reporting');
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.includes('corrupt')), [], 'doctor moved the file aside');
  });
});
