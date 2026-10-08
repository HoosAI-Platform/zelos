/**
 * test/desktop.test.mjs — the Electron shell.
 *
 * Electron itself is not installed (and installing it is not this project's
 * idea of a dependency-free core), so the shell is booted against a stub
 * `electron` module supplied through Node's own module-customisation hooks.
 * That is not a mock of the shell — `desktop/main.js` runs for real, boots the
 * real core in-process, binds a real socket, and builds the real window
 * options, tray menu and navigation guards. Only Chromium is missing.
 *
 * Everything here runs against a temp ZELOS_HOME on an OS-chosen port, so it
 * can never touch the user's own Zelos or collide with one that is running.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { after, before, describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classifyTarget, guardWebContents } from '../desktop/guard.js';
import { clampToDisplays, DEFAULT_BOUNDS, MIN_SIZE, WindowState } from '../desktop/window-state.js';
import { buildAppMenuTemplate, buildTrayMenuTemplate, supportsLoginItem, VIEWS } from '../desktop/menus.js';
import { startCore } from '../desktop/runtime.js';
/* The lock used to be defined in desktop/runtime.js and is now in core/, which
   is what made it reachable from the published package at all — `desktop/` is
   deliberately not shipped, so a lock living there was a lock only a git
   checkout had. It is still exercised here rather than in a file of its own,
   because the shell is one of its two callers and every case below was written
   against that caller. See core/home-lock.mjs for the whole story. */
import { acquireHomeLock, holdHome, lockHolderState, readHomeLock } from '../core/home-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

it('shutdown retries native quit after Electron clears its reentrant quit guard', async () => {
  const source = fs.readFileSync(path.join(REPO, 'desktop/main.js'), 'utf8');
  const shutdown = /function beginShutdown\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(shutdown, 'exercise the real shutdown function');
  const observed = { inNativeQuit: true, released: false, ignored: 0, exited: false };
  // Electron drains JS microtasks inside will-quit, before it resets its
  // native is_quitting flag after a prevented event. Model that boundary;
  // a plain EventEmitter misses the reentrant second-quit failure.
  vm.runInNewContext(`
    let shuttingDown = null, crashTimer = null, windowState = null, updater = null, installAfterShutdown = false;
    let zelos = { stop: async () => { observed.released = true; } };
    ${shutdown}
    beginShutdown();
  `, {
    observed, setImmediate, clearTimeout,
    app: { quit() {
      if (observed.inNativeQuit) observed.ignored++;
      else observed.exited = true;
    } },
  }, { microtaskMode: 'afterEvaluate' });
  observed.inNativeQuit = false;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.released, true);
  assert.equal(observed.ignored, 0, 'Electron ignored the reentrant second quit');
  assert.equal(observed.exited, true, 'the core stopped but the native shell stayed alive');
});

it('a restart for an update hands the exit to the installer only after the core has stopped', async () => {
  const source = fs.readFileSync(path.join(REPO, 'desktop/main.js'), 'utf8');
  const shutdown = /function beginShutdown\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
  const grace = /const UPDATE_INSTALL_GRACE_MS = [\d_]+;/.exec(source)?.[0];
  assert.ok(grace, 'the watchdog constant is read from main.js, not restated here');
  const graceMs = Number(grace.replace(/\D/g, ''));
  /* Windows: the installer runs detached and waits for Zelos to exit, so the
     shell must quit itself. macOS: Squirrel ends the process, and a timer
     quits anyway if it never does. A refused install still exits. */
  const cases = [
    ['win32', true, ['updater-stop', 'core-stop', 'install', 'quit'], []],
    ['darwin', true, ['updater-stop', 'core-stop', 'install'], [graceMs]],
    ['win32', false, ['updater-stop', 'core-stop', 'install', 'quit'], []],
  ];
  for (const [platform, installs, expected, graces] of cases) {
    const order = [];
    const timers = [];
    vm.runInNewContext(`
      let shuttingDown = null, crashTimer = null, windowState = null, installAfterShutdown = true;
      ${grace}
      let updater = { stop: () => order.push('updater-stop'), install: () => { order.push('install'); return installs; } };
      let zelos = { stop: async () => { order.push('core-stop'); } };
      ${shutdown}
      beginShutdown();
    `, {
      order, installs, setImmediate, clearTimeout, process: { platform },
      setTimeout: (fn, ms) => { timers.push(ms); },
      app: { quit: () => order.push('quit') },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, expected, `${platform}, install ${installs}`);
    assert.deepEqual(timers, graces);
  }
});

/* ------------------------------------------------------------------ *
 * guard.js
 * ------------------------------------------------------------------ */

describe('classifyTarget', () => {
  const port = 7777;

  it('calls the board itself internal, on every loopback spelling', () => {
    for (const url of [
      'http://127.0.0.1:7777/',
      'http://127.0.0.1:7777/?t=abc#/now',
      'http://localhost:7777/app.css',
      'http://[::1]:7777/api/state',
    ]) {
      assert.equal(classifyTarget(url, { port }).action, 'internal', url);
    }
  });

  it('sends ordinary web and mail links to the system browser', () => {
    for (const url of ['https://example.com/a', 'http://example.com/', 'mailto:someone@example.com?subject=hi']) {
      assert.equal(classifyTarget(url, { port }).action, 'external', url);
    }
  });

  it('blocks every scheme that could reach this machine', () => {
    for (const url of [
      'file:///etc/passwd',
      'file://' + path.join(REPO, 'core', 'config.mjs'),
      'javascript:fetch("/api/state")',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'blob:http://127.0.0.1:7777/9f',
      'about:blank',
      'chrome://settings',
      'ms-msdt:/id PCWDiagnostic',
      'zoommtg://zoom.us/join?confno=1',
      'not a url at all',
      '',
    ]) {
      assert.equal(classifyTarget(url, { port }).action, 'block', url);
    }
  });

  it('treats another port on this machine as external, not as itself', () => {
    // Ollama on 11434 is still somebody else's server.
    assert.equal(classifyTarget('http://127.0.0.1:11434/v1/models', { port }).action, 'external');
    assert.equal(classifyTarget('http://127.0.0.1/', { port }).action, 'external'); // port 80
  });

  it('fails closed when the server has no port yet', () => {
    for (const noPort of [{}, { port: 0 }, { port: null }, { port: NaN }]) {
      assert.equal(classifyTarget('http://127.0.0.1:7777/', noPort).action, 'external');
    }
  });
});

describe('guardWebContents', () => {
  function harness({ port = 7777, openExternal, onExternalOpenError } = {}) {
    const opened = [];
    const warned = [];
    const logs = [];
    const handlers = new Map();
    const contents = {
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) || []), handler]);
      },
      setWindowOpenHandler(handler) { contents.windowOpen = handler; },
      windowOpen: null,
    };
    guardWebContents(contents, {
      getPort: () => port,
      openExternal: openExternal ?? ((url) => opened.push(url)),
      onExternalOpenError,
      logger: {
        info: (msg, meta) => logs.push({ msg, meta }),
        warn: (msg, meta) => { warned.push(meta ?? msg); logs.push({ msg, meta }); },
      },
    });
    const navigate = (url) => {
      let prevented = false;
      const event = { preventDefault: () => { prevented = true; } };
      for (const handler of handlers.get('will-navigate')) handler(event, url);
      return prevented;
    };
    return { contents, opened, warned, logs, navigate, handlers };
  }

  it('lets the board navigate itself and nothing else', () => {
    const h = harness();
    assert.equal(h.navigate('http://127.0.0.1:7777/#/today'), false);
    assert.equal(h.opened.length, 0);

    assert.equal(h.navigate('https://evil.example/steal'), true);
    assert.deepEqual(h.opened, ['https://evil.example/steal']);

    assert.equal(h.navigate('file:///etc/passwd'), true);
    assert.deepEqual(h.opened, ['https://evil.example/steal']); // still just the one
    assert.deepEqual(h.warned, [{ scheme: 'file:', host: null, reason: 'file: is not a scheme the shell will open' }]);
  });

  it('guards redirects too, not just clicks', () => {
    const h = harness();
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    for (const handler of h.handlers.get('will-redirect')) handler(event, 'https://elsewhere.example/');
    assert.equal(prevented, true);
    assert.deepEqual(h.opened, ['https://elsewhere.example/']);
  });

  it('never opens a second window, and hands external popups to the browser', () => {
    const h = harness();
    assert.deepEqual(h.contents.windowOpen({ url: 'https://example.com/docs' }), { action: 'deny' });
    assert.deepEqual(h.opened, ['https://example.com/docs']);

    assert.deepEqual(h.contents.windowOpen({ url: 'http://127.0.0.1:7777/#/ask' }), { action: 'deny' });
    assert.equal(h.opened.length, 1, 'the board itself is never handed to the system browser');

    assert.deepEqual(h.contents.windowOpen({ url: 'file:///etc/hosts' }), { action: 'deny' });
    assert.equal(h.opened.length, 1);
  });

  it('REGRESSION: a new-window link onto the board itself is refused and logged, not routed into the open window', () => {
    /* Every item link renders target=_blank, so a click lands here and never
       in will-navigate; and ui/lib/items.js resolves a feed's `<link>` against
       the board's own address, so `<link>/?t=x</link>` arrives as this origin
       carrying a `?t=`. The internal branch used to hand that URL to an
       onInternalPopup hook wired to mainWindow.loadURL; the page then stored
       `x` in place of the live session token and every API call 401ed until
       "Reload board" (a localhost spelling loaded the board on a second origin
       with no token at all). The board opens no popups of its own, so there is
       nothing for an internal verdict to carry: it is refused and logged like
       any other new window, and the window keeps the page it has. */
    const h = harness();
    for (const url of ['http://127.0.0.1:7777/?t=garbage', 'http://localhost:7777/?t=garbage', 'http://[::1]:7777/#/settings']) {
      assert.deepEqual(h.contents.windowOpen({ url }), { action: 'deny' });
      assert.deepEqual(h.warned.at(-1), {
        scheme: 'http:', host: new URL(url).hostname, reason: 'the board opens no popups of its own',
      });
    }
    assert.equal(h.opened.length, 0, 'none of them belongs in the system browser either');
  });

  it('logs only scheme and host, keeping draft bodies, credentials, paths and tokens out of logs', () => {
    const h = harness();
    const mail = 'mailto:PRIVATE_RECIPIENT@example.com?subject=PRIVATE_SUBJECT&body=PRIVATE_DRAFT';
    const web = 'https://PRIVATE_USER:PRIVATE_PASSWORD@example.com/PRIVATE_PATH?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT';
    h.navigate(mail);
    h.contents.windowOpen({ url: web });
    h.navigate('data:text/plain,PRIVATE_BLOCKED_CONTENT');
    h.navigate('PRIVATE_INVALID_URL');
    h.contents.windowOpen({ url: 'http://127.0.0.1:7777/?t=PRIVATE_SESSION_TOKEN' });

    assert.deepEqual(h.opened, [mail, web], 'the external app still receives the complete link');
    assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'), false);
    assert.deepEqual(h.logs[0].meta, { scheme: 'mailto:', host: null });
    assert.deepEqual(h.logs[1].meta, { scheme: 'https:', host: 'example.com' });
    assert.deepEqual(h.logs[3].meta, {
      scheme: null, host: null, reason: 'not a URL the shell can parse',
    });
  });

  it('reports rejected external opens without leaking the URL or the platform error', async () => {
    const failures = [];
    const h = harness({
      openExternal: () => Promise.reject(new Error('PRIVATE_PLATFORM_ERROR')),
      onExternalOpenError: (target) => failures.push(target),
    });
    assert.equal(h.navigate('mailto:PRIVATE_RECIPIENT@example.com?body=PRIVATE_DRAFT'), true);
    assert.deepEqual(h.contents.windowOpen({ url: 'https://example.com/PRIVATE_PATH' }), { action: 'deny' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, [
      { scheme: 'mailto:', host: null }, { scheme: 'https:', host: 'example.com' },
    ]);
    assert.equal(h.warned.length, 2);
    assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'), false);
  });

  it('handles synchronous opener failures and callback failures without interrupting navigation guards', async () => {
    for (const callback of [undefined, () => { throw new Error('PRIVATE_CALLBACK_ERROR'); },
      () => Promise.reject(new Error('PRIVATE_CALLBACK_ERROR'))]) {
      const h = harness({
        openExternal: () => { throw new Error('PRIVATE_OPENER_ERROR'); },
        onExternalOpenError: callback,
      });
      assert.equal(h.navigate('mailto:PRIVATE_RECIPIENT@example.com?body=PRIVATE_DRAFT'), true);
      assert.deepEqual(h.contents.windowOpen({ url: 'https://example.com/PRIVATE_PATH' }), { action: 'deny' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'), false);
      assert.equal(h.navigate('http://127.0.0.1:7777/#/now'), false, 'the board stays usable');
    }
  });

  it('refuses a webview', () => {
    const h = harness();
    let prevented = false;
    for (const handler of h.handlers.get('will-attach-webview')) {
      handler({ preventDefault: () => { prevented = true; } });
    }
    assert.equal(prevented, true);
  });
});

/* ------------------------------------------------------------------ *
 * window-state.js
 * ------------------------------------------------------------------ */

describe('clampToDisplays', () => {
  const laptop = { x: 0, y: 0, width: 1680, height: 1020 };
  const secondary = { x: 1680, y: -200, width: 2560, height: 1440 };

  it('keeps a rectangle that is where it says it is', () => {
    const fitted = clampToDisplays({ x: 100, y: 80, width: 1200, height: 800 }, [laptop, secondary]);
    assert.deepEqual(fitted, { x: 100, y: 80, width: 1200, height: 800 });
  });

  it('drops the position when the monitor it was on has gone', () => {
    const fitted = clampToDisplays({ x: 2400, y: 300, width: 1200, height: 800 }, [laptop]);
    assert.deepEqual(fitted, { width: 1200, height: 800 });
  });

  it('keeps a window on the second monitor when there is one', () => {
    const fitted = clampToDisplays({ x: 2400, y: 300, width: 1200, height: 800 }, [laptop, secondary]);
    assert.equal(fitted.x, 2400);
    assert.equal(fitted.y, 300);
  });

  it('puts a straddling window on the display it is mostly on', () => {
    // 280px of this window is on the laptop and 920px is on the second monitor.
    // Taking the first work area that overlapped at all put it back on the
    // laptop — so a window dragged over a boundary teleported to whichever
    // display the OS listed first, which is not the one it was on.
    const fitted = clampToDisplays({ x: 1400, y: 100, width: 1200, height: 800 }, [laptop, secondary]);
    assert.deepEqual(fitted, { x: 1680, y: 100, width: 1200, height: 800 });

    // And the same answer whichever order the displays arrive in.
    assert.deepEqual(
      clampToDisplays({ x: 1400, y: 100, width: 1200, height: 800 }, [secondary, laptop]),
      fitted,
    );
  });

  it('pulls a mostly-offscreen window back on', () => {
    // A corner still on the display: enough to count as visible, not enough to
    // leave where it is.
    const fitted = clampToDisplays({ x: 1500, y: 960, width: 1200, height: 800 }, [laptop]);
    assert.deepEqual(fitted, { x: 480, y: 220, width: 1200, height: 800 });
  });

  it('gives up on a position that barely clips the screen', () => {
    // 80px of overlap is a window you cannot grab; the size survives, the
    // position does not.
    assert.deepEqual(clampToDisplays({ x: 1600, y: 990, width: 1200, height: 800 }, [laptop]), {
      width: 1200, height: 800,
    });
  });

  it('never returns a window too small to use, or bigger than the screen', () => {
    const tiny = clampToDisplays({ x: 10, y: 10, width: 40, height: 10 }, [laptop]);
    assert.equal(tiny.width, MIN_SIZE.width);
    assert.equal(tiny.height, MIN_SIZE.height);

    const huge = clampToDisplays({ x: 0, y: 0, width: 9000, height: 9000 }, [laptop]);
    assert.deepEqual({ width: huge.width, height: huge.height }, { width: laptop.width, height: laptop.height });
  });

  it('falls back to the default size when there is nothing remembered', () => {
    assert.deepEqual(clampToDisplays(null, [laptop]), { ...DEFAULT_BOUNDS });
    assert.deepEqual(clampToDisplays({ width: 1200, height: 800 }, []), { width: 1200, height: 800 });
  });
});

describe('WindowState', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-winstate-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('starts from the defaults and writes what it captured', () => {
    const file = path.join(dir, 'window.json');
    const state = new WindowState({ file });
    assert.deepEqual(state.initial([]), { ...DEFAULT_BOUNDS, minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height });

    state.track(fakeWindow({ x: 42, y: 24, width: 1000, height: 700 }));
    state.capture();

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.bounds, { x: 42, y: 24, width: 1000, height: 700 });
    assert.equal(written.maximized, false);

    // A fresh instance reads it back.
    assert.equal(new WindowState({ file }).initial([]).width, 1000);
  });

  /**
   * The mode is a separate test because it is the one part of the promise that
   * only two of the three platforms can keep, and a skip with a name in the
   * output is honest where an `if` buried in an assertion is not.
   *
   * A window rectangle is not a secret, but this file lives in the Zelos home
   * beside the mail database, and everything Zelos writes there is 0600 — one
   * file written 0644 is the one a later `cp -p` or synced folder carries out
   * wide open. On Windows that promise is not available to make: there are no
   * POSIX modes, `fs.chmod` sets little beyond the read-only flag, and the mode
   * `statSync` reports back is a synthesised 0666 no matter what the writer
   * asked for. What protects the file there is the ACL on the user's profile
   * directory, which is what docs/SECURITY.md says on Windows — so this asserts
   * nothing there rather than asserting something weaker and calling it a pass.
   */
  it('writes it 0600, like everything else in the Zelos home', {
    skip: process.platform === 'win32'
      ? 'Windows has no POSIX file modes: fs.chmod sets little more than the read-only flag and fs.stat reports a synthesised 0666, so a 0600 request is unobservable. At-rest protection on Windows is the profile-directory ACL (see docs/SECURITY.md), which this test cannot speak to.'
      : false,
  }, () => {
    const file = path.join(dir, 'mode.json');
    new WindowState({ file }).track(fakeWindow({ x: 1, y: 2, width: 900, height: 600 })).capture();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('remembers the restored size of a maximised window, not the screen', () => {
    const file = path.join(dir, 'maximised.json');
    const win = fakeWindow({ x: 8, y: 8, width: 1100, height: 760 });
    win.maximized = true;
    win.screenBounds = { x: 0, y: 0, width: 1680, height: 1020 };
    const state = new WindowState({ file });
    state.track(win).capture();

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.maximized, true);
    assert.deepEqual(written.bounds, { x: 8, y: 8, width: 1100, height: 760 });
  });

  it('survives a corrupt file rather than refusing to open a window', () => {
    const file = path.join(dir, 'corrupt.json');
    fs.writeFileSync(file, '{"bounds": {"width": 12');
    assert.equal(new WindowState({ file }).initial([]).width, DEFAULT_BOUNDS.width);
  });

  function fakeWindow(bounds) {
    return {
      maximized: false,
      screenBounds: null,
      on() { return this; },
      isDestroyed: () => false,
      isMaximized() { return this.maximized; },
      isFullScreen: () => false,
      getNormalBounds: () => bounds,
      getBounds() { return this.screenBounds || bounds; },
    };
  }
});

/* ------------------------------------------------------------------ *
 * menus.js
 * ------------------------------------------------------------------ */

describe('menus', () => {
  const labels = (template) => template.map((item) => item.label ?? item.role ?? item.type);

  it('gives the tray exactly Check now, Open Zelos and Quit', () => {
    const fired = [];
    const template = buildTrayMenuTemplate({
      actions: { sweepNow: () => fired.push('sweep'), openBoard: () => fired.push('open'), quit: () => fired.push('quit') },
    });
    assert.deepEqual(labels(template), ['Check now', 'Open Zelos', 'separator', 'Quit Zelos']);
    for (const item of template) item.click?.();
    assert.deepEqual(fired, ['sweep', 'open', 'quit']);
  });

  it('adds a restart item to the tray only while a downloaded update is waiting', () => {
    const fired = [];
    const actions = { restartToUpdate: () => fired.push('restart'), checkForUpdates: () => fired.push('check') };
    for (const status of ['idle', 'checking', 'downloading', 'available', 'error']) {
      assert.deepEqual(labels(buildTrayMenuTemplate({ actions, update: { status, latestVersion: '1.9.0' } })),
        ['Check now', 'Open Zelos', 'separator', 'Quit Zelos'], status);
    }
    const ready = buildTrayMenuTemplate({ actions, update: { status: 'ready', latestVersion: '1.9.0' } });
    assert.deepEqual(labels(ready), ['Check now', 'Open Zelos', 'separator', 'Restart to Install Zelos 1.9.0', 'separator', 'Quit Zelos']);
    ready[3].click();
    assert.deepEqual(fired, ['restart']);
  });

  it('offers Check for Updates in the app menu, and Restart once an update is ready', () => {
    const fired = [];
    const actions = { restartToUpdate: () => fired.push('restart'), checkForUpdates: () => fired.push('check') };
    const mac = buildAppMenuTemplate({ platform: 'darwin', actions, update: { status: 'idle' } });
    const item = mac[0].submenu[1];
    assert.equal(item.label, 'Check for Updates…');
    item.click();
    const win = buildAppMenuTemplate({ platform: 'win32', actions, update: { status: 'ready', latestVersion: '1.9.0' } });
    const help = win.find((menu) => menu.label === 'Help').submenu;
    const restart = help.find((entry) => entry.label === 'Restart to Install Zelos 1.9.0');
    assert.ok(restart, 'Windows and Linux carry the update item in Help, beside About');
    restart.click();
    assert.deepEqual(fired, ['check', 'restart']);
    assert.ok(!buildAppMenuTemplate({ platform: 'darwin', actions: {} })[0].submenu.some((entry) => /Update/.test(entry.label ?? '')),
      'no updater wired, no update item');
  });

  it('builds a macOS menu with the app menu first and a working Edit menu', () => {
    const template = buildAppMenuTemplate({ platform: 'darwin', appName: 'Zelos', actions: {} });
    assert.equal(template[0].label, 'Zelos');
    const edit = template.find((menu) => menu.label === 'Edit');
    for (const role of ['undo', 'cut', 'copy', 'paste', 'selectAll']) {
      assert.ok(edit.submenu.some((item) => item.role === role), `Edit is missing ${role}`);
    }
    // ⌘Q lives in the app menu on macOS and nowhere else.
    const board = template.find((menu) => menu.label === 'Board');
    assert.equal(board.submenu.some((item) => item.role === 'quit'), false);
    assert.ok(template[0].submenu.some((item) => item.role === 'quit'));
  });

  it('puts Quit in the first menu on Windows and Linux', () => {
    const template = buildAppMenuTemplate({ platform: 'win32', actions: {} });
    assert.equal(template[0].label, 'Board');
    assert.ok(template[0].submenu.some((item) => item.role === 'quit'));
    assert.ok(template.find((menu) => menu.label === 'Help').submenu.some((item) => item.label === 'About Zelos'));
  });

  it('gives macOS a ⌘W that closes the window', () => {
    // Without `close` in the Window menu there is no ⌘W anywhere in the app,
    // and ⌘W is the first thing a Mac user reaches for on a window that is
    // meant to be closed and left running.
    for (const platform of ['darwin', 'win32', 'linux']) {
      const template = buildAppMenuTemplate({ platform, actions: {} });
      const window = template.find((menu) => menu.label === 'Window');
      assert.ok(
        window.submenu.some((item) => item.role === 'close'),
        `the Window menu on ${platform} has no close role`,
      );
    }
  });

  it('offers open-at-login where the OS has one, off until it is asked for', () => {
    const set = [];
    const template = buildAppMenuTemplate({
      platform: 'darwin',
      actions: { openAtLogin: () => false, setOpenAtLogin: (want) => set.push(want) },
    });
    const item = template
      .find((menu) => menu.label === 'Board')
      .submenu.find((entry) => entry.label === 'Open Zelos at login');

    assert.ok(item, 'there is no way to make Zelos start with the machine');
    assert.equal(item.type, 'checkbox');
    assert.equal(item.checked, false, 'launch at login must be opt-in');

    // Electron flips `checked` before it calls click, so the item carries the
    // state being asked for.
    item.click({ checked: true });
    item.click({ checked: false });
    assert.deepEqual(set, [true, false]);

    // Ticked when the OS says it is ticked — the OS list is the only state.
    const on = buildAppMenuTemplate({ platform: 'win32', actions: { openAtLogin: () => true } });
    assert.equal(
      on.find((menu) => menu.label === 'Board').submenu.find((entry) => entry.label === 'Open Zelos at login').checked,
      true,
    );
  });

  it('leaves the login-item checkbox off Linux, where it would do nothing', () => {
    assert.equal(supportsLoginItem('linux'), false);
    const template = buildAppMenuTemplate({ platform: 'linux', actions: { openAtLogin: () => false } });
    assert.equal(
      template.find((menu) => menu.label === 'Board').submenu.some((entry) => entry.label === 'Open Zelos at login'),
      false,
    );
  });

  it('names the views the board names, in the board\'s own order', () => {
    /* ui/app.js VIEWS is the rail; the Go menu is a copy of it, and a copy
       drifts — this menu said 'Owed' for a season after the board renamed the
       view 'Promises', and never offered Search at all. Pinned at the source,
       the way the preload test pins its channel name. */
    const app = fs.readFileSync(path.join(REPO, 'ui', 'app.js'), 'utf8');
    const block = /const VIEWS = \[([\s\S]*?)\];/.exec(app);
    assert.ok(block, 'ui/app.js no longer declares its VIEWS where this can read them');
    const rail = [...block[1].matchAll(/\{ id: '([a-z]+)', label: '([A-Za-z]+)'/g)]
      .map(([, id, label]) => ({ id, label }));
    assert.ok(rail.length >= 6, 'the rail should list at least six views');
    assert.deepEqual(VIEWS.map(({ id, label }) => ({ id, label })), rail,
      'the Go menu and the rail must list the same views under the same names');
  });

  it('gives Search the find shortcut, and everything else its place in the rail', () => {
    const go = buildAppMenuTemplate({ platform: 'darwin', actions: {} })
      .find((menu) => menu.label === 'Go');
    const search = go.submenu.find((item) => item.label === 'Search');
    assert.ok(search, 'the Go menu has no way into Search');
    assert.equal(search.accelerator, 'CmdOrCtrl+F');
    // Search still counts as a position, so ⌘6 is the sixth thing on screen.
    for (const [i, item] of go.submenu.entries()) {
      if (item.label === 'Search') continue;
      assert.equal(item.accelerator, `CmdOrCtrl+${i + 1}`, `${item.label} lost the number of its place`);
    }
  });

  it('offers the board to the system browser, through an action the shell supplies', () => {
    const fired = [];
    const template = buildAppMenuTemplate({
      platform: 'darwin',
      actions: { openInBrowser: () => fired.push('browser') },
    });
    const item = template
      .find((menu) => menu.label === 'Board')
      .submenu.find((entry) => entry.label === 'Open in your web browser');
    assert.ok(item, 'there is no way to open the board in a browser');
    item.click();
    assert.deepEqual(fired, ['browser']);
  });

  it('routes every view to showView, and reload to the URL the shell holds', () => {
    const seen = [];
    const template = buildAppMenuTemplate({
      platform: 'darwin',
      actions: { showView: (id) => seen.push(id), reloadBoard: () => seen.push('reload') },
    });
    const go = template.find((menu) => menu.label === 'Go');
    for (const item of go.submenu) item.click();
    assert.deepEqual(seen, VIEWS.map((view) => view.id));

    const board = template.find((menu) => menu.label === 'Board');
    board.submenu.find((item) => item.label === 'Reload board').click();
    assert.equal(seen.at(-1), 'reload');
  });
});

/* ------------------------------------------------------------------ *
 * The shell, booted for real against a stub Electron
 * ------------------------------------------------------------------ */

/**
 * The stub is written to a temp file and injected by a resolve hook, so the
 * `import ... from 'electron'` in desktop/main.js resolves to it. Deliberately
 * written without template literals so it can live inside one here.
 */
const ELECTRON_STUB = `
import fs from 'node:fs';

export const recorded = {
  appEvents: new Map(),
  windows: [],
  trays: [],
  applicationMenu: null,
  external: [],
  openedPaths: [],
  errorBoxes: [],
  permission: { request: null, check: null },
  beforeRequest: null,
  headersReceived: null,
  quits: 0,
  appName: null,
  messageBoxes: [],
  badgeCount: null,
  dockBadge: null,
  loginItem: null,
  messageBoxResponse: 0,
};

function push(map, event, handler) {
  const list = map.get(event) || [];
  list.push(handler);
  map.set(event, list);
}

function fire(map, event, ...args) {
  const list = map.get(event) || [];
  for (const handler of list) handler(...args);
  return list.length;
}

class WebContentsStub {
  constructor() {
    this.handlers = new Map();
    this.windowOpenHandler = null;
    this.executed = [];
    this.webRTCIPHandlingPolicy = null;
  }
  on(event, handler) { push(this.handlers, event, handler); return this; }
  once(event, handler) { push(this.handlers, event, handler); return this; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  setWebRTCIPHandlingPolicy(policy) { this.webRTCIPHandlingPolicy = policy; }
  executeJavaScript(code) { this.executed.push(code); return Promise.resolve(code.includes('__zelosFlushDrafts') ? true : undefined); }
  emit(event, ...args) { return fire(this.handlers, event, ...args); }
}

export class BrowserWindow {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.webContents = new WebContentsStub();
    this.loaded = [];
    this.destroyed = false;
    this.visible = false;
    this.minimized = false;
    this.maximizedState = false;
    this.fullScreenState = false;
    this.bounds = {
      x: typeof options.x === 'number' ? options.x : 120,
      y: typeof options.y === 'number' ? options.y : 90,
      width: options.width,
      height: options.height,
    };
    this.boundsSets = 0;
    this.centred = 0;
    recorded.windows.push(this);
    // Electron announces every webContents on the app object; the shell's
    // navigation guard is attached from there, so the stub must do it too.
    fire(recorded.appEvents, 'web-contents-created', { preventDefault() {} }, this.webContents);
  }
  on(event, handler) { push(this.handlers, event, handler); return this; }
  once(event, handler) {
    push(this.handlers, event, handler);
    if (event === 'ready-to-show') setImmediate(() => this.emit('ready-to-show'));
    return this;
  }
  emit(event, ...args) { return fire(this.handlers, event, ...args); }
  loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  restore() { this.minimized = false; }
  maximize() { this.maximizedState = true; }
  setFullScreen(value) { this.fullScreenState = value; }
  isMaximized() { return this.maximizedState; }
  isFullScreen() { return this.fullScreenState; }
  isMinimized() { return this.minimized; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  getBounds() { return Object.assign({}, this.bounds); }
  getNormalBounds() { return Object.assign({}, this.bounds); }
  // Electron emits move and resize from setBounds, and WindowState is listening
  // to both — so a corrected position is a position that gets remembered.
  setBounds(bounds) {
    this.boundsSets += 1;
    Object.assign(this.bounds, bounds);
    this.emit('move');
    this.emit('resize');
    return this;
  }
  // The real one places the window on the display it is on, or the primary one
  // when that answer is nowhere; the stub has a single display to place it on.
  center() {
    this.centred += 1;
    const area = screen.getAllDisplays()[0].workArea;
    this.bounds.x = Math.round(area.x + (area.width - this.bounds.width) / 2);
    this.bounds.y = Math.round(area.y + (area.height - this.bounds.height) / 2);
    this.emit('move');
    return this;
  }
}
BrowserWindow.getAllWindows = () => recorded.windows;

export const app = {
  isPackaged: false,
  dock: {
    setIcon() {},
    setBadge(text) { recorded.dockBadge = text; },
  },
  requestSingleInstanceLock() { return true; },
  setName(name) { recorded.appName = name; },
  getVersion() { return '1.0.0'; },
  // Only the updater asks, and only for where a Windows installer would wait.
  getPath(name) { return name === 'userData' ? recorded.userData : ''; },
  setAboutPanelOptions() {},
  setBadgeCount(n) { recorded.badgeCount = n; return true; },
  // Electron's own default is openAtLogin:false, and a Zelos that has never
  // been asked must look exactly like one that was told no.
  getLoginItemSettings() { return recorded.loginItem || { openAtLogin: false }; },
  setLoginItemSettings(settings) { recorded.loginItem = Object.assign({}, settings); },
  whenReady() { return Promise.resolve(); },
  on(event, handler) { push(recorded.appEvents, event, handler); return this; },
  emit(event, ...args) { return fire(recorded.appEvents, event, ...args); },
  quit() {
    recorded.quits += 1;
    let prevented = false;
    fire(recorded.appEvents, 'before-quit', { preventDefault() { prevented = true; } });
    if (prevented) return;
    fire(recorded.appEvents, 'will-quit', { preventDefault() {} });
  },
};

export const Menu = {
  buildFromTemplate(template) { return { template }; },
  setApplicationMenu(menu) { recorded.applicationMenu = menu; },
};

export class Tray {
  constructor(image) {
    this.image = image;
    this.tooltip = '';
    this.menu = null;
    this.handlers = new Map();
    recorded.trays.push(this);
  }
  setToolTip(text) { this.tooltip = text; }
  setContextMenu(menu) { this.menu = menu; }
  on(event, handler) { push(this.handlers, event, handler); return this; }
  emit(event, ...args) { return fire(this.handlers, event, ...args); }
}

export const dialog = {
  showErrorBox(title, content) { recorded.errorBoxes.push({ title, content }); },
  showMessageBox(options) {
    recorded.messageBoxes.push(options);
    return Promise.resolve({ response: recorded.messageBoxResponse ?? 0, options });
  },
};

export const nativeImage = {
  createFromPath(file) {
    const exists = fs.existsSync(file);
    return { file, isEmpty() { return !exists; }, setTemplateImage() {} };
  },
};

export const nativeTheme = { shouldUseDarkColors: false };

export const screen = {
  getAllDisplays() { return [{ workArea: { x: 0, y: 0, width: 1680, height: 1020 } }]; },
};

export const session = {
  defaultSession: {
    setPermissionRequestHandler(handler) { recorded.permission.request = handler; },
    setPermissionCheckHandler(handler) { recorded.permission.check = handler; },
    webRequest: {
      onBeforeRequest(filter, handler) { recorded.beforeRequest = { filter, handler }; },
      onHeadersReceived(filter, handler) { recorded.headersReceived = { filter, handler }; },
    },
  },
};

export const shell = {
  openExternal(url) { recorded.external.push(url); return Promise.resolve(''); },
  openPath(target) { recorded.openedPaths.push(target); return Promise.resolve(''); },
  showItemInFolder(target) { recorded.revealed.push(target); },
};

// The one channel the preload may invoke. Recorded by name so a test can
// call the handler the shell registered, with a sender of its choosing.
export const ipcMain = {
  handle(channel, handler) { recorded.ipcHandlers.set(channel, handler); },
};
// Squirrel.Mac, as far as the shell touches it. An unpackaged shell never
// points it anywhere, which the suite checks by its staying untouched.
export const autoUpdater = {
  handlers: new Map(),
  feeds: [],
  on(event, handler) { push(this.handlers, event, handler); return this; },
  setFeedURL(options) { this.feeds.push(options); },
  checkForUpdates() { recorded.squirrelChecks = (recorded.squirrelChecks || 0) + 1; },
  quitAndInstall() { recorded.squirrelInstalls = (recorded.squirrelInstalls || 0) + 1; },
};
recorded.revealed = [];
recorded.ipcHandlers = new Map();
recorded.userData = '';
`;

describe('the shell, booted against a stub Electron', () => {
  let sandbox;
  let home;
  let recorded;
  let electron;
  let main;
  let booted;

  before(async () => {
    // realpath, not the mkdtemp path: on macOS /var/folders is a symlink into
    // /private/var, Node's resolver stores the resolved form, and a hook that
    // hands back the unresolved one gets a *second* copy of the same module.
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-shell-')));
    home = path.join(sandbox, 'home');
    process.env.ZELOS_HOME = home;
    process.env.ZELOS_PORT = '0';          // let the OS pick; never collide
    process.env.ZELOS_LOG_LEVEL = 'error'; // the shell logs a lot on purpose
    // A temp home is not enough. The shell boots the real core, and /api/health
    // calls secrets.backend(), which on an unforced macOS run shells out to
    // /usr/bin/security against the operator's own login keychain — a real
    // credential store, on their real machine, every time the suite runs. Force
    // the file backend so this test stays inside its sandbox.
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';

    const stubPath = path.join(sandbox, 'electron-stub.mjs');
    fs.writeFileSync(stubPath, ELECTRON_STUB);
    const stubUrl = pathToFileURL(stubPath).href;
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'electron') return { url: stubUrl, shortCircuit: true };
        return next(specifier, context);
      },
    });

    electron = await import(stubUrl);
    ({ recorded } = electron);
    main = await import(pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href);
    booted = await main.ready;
    // ready-to-show is delivered on the next turn, as it is in Electron.
    await new Promise((resolve) => setImmediate(resolve));
  });

  after(async () => {
    await main?.shutdown();
    try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    /* A temp directory that Windows still holds a handle on is litter, not a
       test result. The OS clears it; failing the whole run over it reports a
       defect that does not exist and hides the ones that do. */
    if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
  }
    delete process.env.ZELOS_HOME;
    delete process.env.ZELOS_PORT;
    delete process.env.ZELOS_LOG_LEVEL;
    delete process.env.ZELOS_SECRETS_BACKEND;
  });

  it('boots the core in this process and binds a loopback port', () => {
    assert.equal(booted.ok, true, booted.error?.stack);
    assert.ok(booted.zelos.port > 0);
    assert.equal(booted.zelos.url, `http://127.0.0.1:${booted.zelos.port}/`);
    assert.match(booted.zelos.token, /^[0-9a-f]{64}$/);
    assert.equal(booted.zelos.paths.home, home);
    assert.ok(fs.existsSync(path.join(home, 'zelos.db')), 'the database was not created');
  });

  it('opens the window at the URL that carries the session token', () => {
    const win = recorded.windows.at(0);
    assert.equal(recorded.windows.length, 1);
    assert.deepEqual(win.loaded, [`http://127.0.0.1:${booted.zelos.port}/?t=${booted.zelos.token}`]);
    assert.equal(win.visible, true, 'the window never came out of ready-to-show');
  });

  it('creates that window with no privileges to lend a page', () => {
    const { webPreferences } = recorded.windows[0].options;
    assert.equal(webPreferences.contextIsolation, true);
    assert.equal(webPreferences.nodeIntegration, false);
    assert.equal(webPreferences.nodeIntegrationInWorker, false);
    assert.equal(webPreferences.nodeIntegrationInSubFrames, false);
    assert.equal(webPreferences.sandbox, true);
    assert.equal(webPreferences.webviewTag, false);
    assert.equal(webPreferences.webSecurity, true);
    assert.equal(webPreferences.allowRunningInsecureContent, false);
    // Chromium fetches spellcheck dictionaries from a Google host.
    assert.equal(webPreferences.spellcheck, false);
    assert.equal(webPreferences.preload, path.join(REPO, 'desktop', 'preload.js'));
    assert.ok(fs.existsSync(webPreferences.preload));
  });

  it('reveals the data folder when the board asks, and for nobody else', () => {
    /* Settings → Your data says "drag this folder to the Trash", and a sentence
       about "this folder" has to be able to show it. The bridge is one channel,
       takes no argument, reveals only the shell's own home, and answers only
       the board's window — any other sender gets false and nothing happens. */
    const handler = recorded.ipcHandlers.get(main.SHOW_HOME_CHANNEL);
    assert.ok(handler, `no handler registered on ${main.SHOW_HOME_CHANNEL}`);
    const board = recorded.windows[0].webContents;

    recorded.revealed.length = 0;
    assert.equal(handler({ sender: board }), true);
    assert.deepEqual(recorded.revealed, [booted.zelos.paths.home], 'the shell must reveal its own data home and nothing else');

    recorded.revealed.length = 0;
    assert.equal(handler({ sender: {} }), false, 'a sender that is not the board must be refused');
    assert.equal(handler(undefined), false);
    assert.deepEqual(recorded.revealed, []);

    // The page's half names the same channel, by the same string, and sends
    // nothing with it. Pinned at the source because the preload runs only
    // inside Electron's sandbox loader.
    const preload = fs.readFileSync(path.join(REPO, 'desktop', 'preload.js'), 'utf8');
    const channel = /const SHOW_HOME_CHANNEL = '([^']+)'/.exec(preload);
    assert.ok(channel, 'the preload no longer names its channel in one place');
    assert.equal(channel[1], main.SHOW_HOME_CHANNEL, 'the preload and the shell disagree about the channel name');
    assert.match(preload, /showHome: \(\) => ipcRenderer\.invoke\(SHOW_HOME_CHANNEL\)/, 'showHome must invoke the channel with no argument');
    assert.ok(!/ipcRenderer\.(on|send|sendSync)\(/.test(preload), 'the preload must expose nothing but the one invoke');
    assert.ok(!/require\('(fs|child_process|path)'\)/.test(preload), 'the preload must not reach into Node');
  });

  it('exposes only argument-free backup actions and refuses foreign frames or renderer paths', async () => {
    const calls = [];
    let bridge;
    vm.runInNewContext(fs.readFileSync(path.join(REPO, 'desktop', 'preload.js'), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } }),
      process: { platform: 'darwin', versions: {} }, console,
    });
    await bridge.createBackup('/renderer/path'); await bridge.restoreBackup('/renderer/path');
    assert.deepEqual(calls, [[main.CREATE_BACKUP_CHANNEL], [main.RESTORE_BACKUP_CHANNEL]]);
    const board = recorded.windows[0].webContents;
    const frame = { url: booted.zelos.url };
    board.mainFrame = frame;
    for (const name of [main.CREATE_BACKUP_CHANNEL, main.RESTORE_BACKUP_CHANNEL]) {
      const handler = recorded.ipcHandlers.get(name);
      assert.equal((await handler({ sender: board, senderFrame: frame }, '/renderer/path')).ok, false);
      assert.equal((await handler({ sender: board, senderFrame: { url: frame.url } })).ok, false);
      assert.equal((await handler({ sender: {}, senderFrame: frame })).ok, false);
      frame.url = 'https://untrusted.example/';
      assert.equal((await handler({ sender: board, senderFrame: frame })).ok, false);
      frame.url = booted.zelos.url;
    }
  });

  it('reads the update signing identity from the shell\'s package.json, refusing anything malformed', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop', 'package.json'), 'utf8'));
    assert.deepEqual(committed.updates, { windowsPublisher: '', macTeamId: '' },
      'the committed build is unsigned, so it does not update itself');
    const dir = fs.mkdtempSync(path.join(sandbox, 'signing-'));
    const read = (updates) => {
      fs.writeFileSync(path.join(dir, 'package.json'), typeof updates === 'string' ? updates : JSON.stringify({ updates }));
      return main.readUpdateSigning(dir);
    };
    assert.deepEqual(read({ windowsPublisher: ' Example, Ltd ', macTeamId: 'ABCDE12345' }), { windowsPublisher: 'Example, Ltd', macTeamId: 'ABCDE12345' });
    assert.deepEqual(read({ windowsPublisher: 'Bad"Name', macTeamId: 'short' }), { windowsPublisher: '', macTeamId: '' });
    assert.deepEqual(read({ windowsPublisher: 'CN=Injected', macTeamId: 'abcde12345' }), { windowsPublisher: '', macTeamId: '' });
    assert.deepEqual(read({ windowsPublisher: 42, macTeamId: null }), { windowsPublisher: '', macTeamId: '' });
    assert.deepEqual(read('{broken'), { windowsPublisher: '', macTeamId: '' });
  });

  it('wires an unpackaged shell\'s updater off, so it contacts nobody', async () => {
    const handler = recorded.ipcHandlers.get(main.UPDATE_STATE_CHANNEL);
    assert.ok(handler, 'the update state channel is registered');
    const board = recorded.windows[0].webContents;
    const frame = { url: booted.zelos.url };
    board.mainFrame = frame;
    const answer = await handler({ sender: board, senderFrame: frame });
    assert.equal(answer.ok, true);
    assert.equal(answer.state.supported, false);
    assert.match(answer.state.reason, /runs from source/);
    assert.equal(electron.autoUpdater.feeds.length, 0, 'Squirrel is never pointed anywhere by an unpackaged shell');
    assert.equal(recorded.squirrelChecks ?? 0, 0);
  });

  it('answers the update channels for the board\'s own frame only, and takes one boolean at most', async () => {
    const calls = [];
    const fake = {
      state: () => ({ status: 'idle' }),
      checkNow: async () => { calls.push('check'); return { status: 'checking' }; },
      download: async () => { calls.push('download'); return { status: 'downloading' }; },
      setAuto: (value) => { calls.push(['auto', value]); return { status: 'idle', auto: value }; },
    };
    let restarts = 0;
    let boardFrame = true;
    const handlers = main.updateHandlers({
      isBoard: () => boardFrame, getUpdater: () => fake, restart: async () => { restarts++; return { ok: true }; },
    });
    assert.deepEqual(await handlers.state({}), { ok: true, state: { status: 'idle' } });
    assert.equal((await handlers.check({})).ok, true);
    assert.equal((await handlers.download({})).ok, true);
    assert.equal((await handlers.setAuto({}, false)).state.auto, false);
    assert.equal((await handlers.restart({})).ok, true);
    for (const bad of [[], ['false'], [0], [null], [true, true], [{ auto: true }]]) {
      assert.equal((await handlers.setAuto({}, ...bad)).ok, false, JSON.stringify(bad));
    }
    for (const name of ['state', 'check', 'download', 'restart']) {
      assert.equal((await handlers[name]({}, 'https://evil.example/installer.exe')).ok, false, `${name} takes no argument`);
    }
    boardFrame = false;
    for (const name of ['state', 'check', 'download', 'restart']) assert.equal((await handlers[name]({})).ok, false);
    assert.equal((await handlers.setAuto({}, true)).ok, false);
    assert.deepEqual(calls, ['check', 'download', ['auto', false]]);
    assert.equal(restarts, 1);
    const empty = main.updateHandlers({ isBoard: () => true, getUpdater: () => null, restart: async () => ({ ok: true }) });
    assert.match((await empty.state({})).error, /not ready/);
  });

  it('gives the page the updater through invoke calls whose channels the shell answers', async () => {
    const calls = [];
    let bridge;
    vm.runInNewContext(fs.readFileSync(path.join(REPO, 'desktop', 'preload.js'), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } }),
      process: { platform: 'win32', versions: {} }, console,
    });
    await bridge.updates.state('ignored');
    await bridge.updates.check('ignored');
    await bridge.updates.download('ignored');
    await bridge.updates.setAuto('yes');
    await bridge.updates.setAuto(true);
    await bridge.updates.restart('ignored');
    assert.deepEqual(calls, [
      [main.UPDATE_STATE_CHANNEL], [main.UPDATE_CHECK_CHANNEL], [main.UPDATE_DOWNLOAD_CHANNEL],
      [main.UPDATE_SET_AUTO_CHANNEL, false], [main.UPDATE_SET_AUTO_CHANNEL, true], [main.UPDATE_RESTART_CHANNEL],
    ], 'the page cannot pass anything but the one boolean');
    for (const channel of [main.UPDATE_STATE_CHANNEL, main.UPDATE_CHECK_CHANNEL, main.UPDATE_DOWNLOAD_CHANNEL, main.UPDATE_SET_AUTO_CHANNEL, main.UPDATE_RESTART_CHANNEL]) {
      assert.ok(recorded.ipcHandlers.has(channel), `the shell answers ${channel}`);
    }
    const failing = [];
    vm.runInNewContext(fs.readFileSync(path.join(REPO, 'desktop', 'preload.js'), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { failing.push(value); } }, ipcRenderer: { invoke: () => Promise.reject(new Error('gone')) } }),
      process: { platform: 'win32', versions: {} }, console,
    });
    assert.equal((await failing[0].updates.state()).ok, false, 'a failed channel answers in the same shape');
  });

  function backupHarness({ cancel = false, confirm = 1, failFlush = false, failRestore = false } = {}) {
    const order = [];
    const nativePath = '/native-dialog-selected.zelos-backup';
    const win = { isDestroyed: () => false, webContents: {}, setEnabled: (value) => order.push(`enabled:${value}`) };
    const core = {
      paths: { home }, closed: false,
      stageBackup: (file) => { assert.equal(file, nativePath); order.push('stage'); return { manifest: { createdAt: '2026-09-10T12:00:00Z', appVersion: '1.8.0', credentials: 'encrypted-file-included', counts: { messages: 1, events: 2, items: 3, drafts: 4, captures: 5, runs: 6, item_history: 7 } }, cleanup: () => order.push('cleanup') }; },
      createBackup: async (file) => { assert.equal(file, nativePath); order.push('backup'); },
      restoreBackup: async () => { order.push('restore'); core.closed = true; if (failRestore) throw new Error('fixture failure'); },
    };
    const handlers = main.backupHandlers({
      isBoard: () => true, getCore: () => core, getWindow: () => win, appVersion: '1.8.0',
      dialogs: {
        showSaveDialog: async () => ({ canceled: cancel, filePath: nativePath }),
        showOpenDialog: async () => ({ canceled: cancel, filePaths: [nativePath] }),
        showMessageBox: async (_win, options) => { order.push(options.buttons.includes('Restore and reopen') ? 'confirm' : 'warning'); if (options.buttons.includes('Restore and reopen')) { assert.match(options.detail, /7 history revisions/); assert.match(options.detail, /credential file and its key/); assert.equal(options.defaultId, 0); } return { response: confirm }; },
      },
      flush: async () => { order.push('flush'); if (failFlush) throw new Error('pending edits'); },
      restart: async () => { order.push('restart'); },
    });
    return { handlers, order, core };
  }

  it('cancels native backup and restore without flushing, replacing, or restarting', async () => {
    const h = backupHarness({ cancel: true });
    assert.equal((await h.handlers.createBackup({})).cancelled, true);
    assert.equal((await h.handlers.restoreBackup({})).cancelled, true);
    assert.deepEqual(h.order, []);
    const preview = backupHarness({ confirm: 0 });
    assert.equal((await preview.handlers.restoreBackup({})).cancelled, true);
    assert.deepEqual(preview.order, ['enabled:false', 'stage', 'confirm', 'cleanup', 'enabled:true']);
  });

  it('flushes latest drafts before native backup and keeps edits open if saving fails', async () => {
    const h = backupHarness();
    assert.deepEqual(await h.handlers.createBackup({}), { ok: true });
    assert.deepEqual(h.order, ['enabled:false', 'flush', 'backup', 'enabled:true']);
    const failed = backupHarness({ failFlush: true });
    assert.equal((await failed.handlers.restoreBackup({})).ok, false);
    assert.ok(!failed.order.includes('restore')); assert.ok(!failed.order.includes('restart'));
    assert.ok(failed.order.includes('warning')); assert.equal(failed.order.at(-1), 'enabled:true');
  });

  it('shows the restore preview, flushes, replaces, then reopens; post-close failures also reopen for recovery', async () => {
    for (const failRestore of [false, true]) {
      const h = backupHarness({ failRestore });
      assert.equal((await h.handlers.restoreBackup({})).ok, !failRestore);
      assert.ok(h.order.indexOf('confirm') < h.order.indexOf('flush'));
      assert.ok(h.order.indexOf('flush') < h.order.indexOf('restore'));
      assert.equal(h.order.at(-1), 'restart');
      if (failRestore) assert.ok(h.order.includes('warning'));
    }
  });

  it('serializes native backup dialogs so a second operation cannot race the first', async () => {
    let finish;
    let opened = 0;
    const handlers = main.backupHandlers({
      isBoard: () => true, getCore: () => ({ paths: { home } }), getWindow: () => ({ isDestroyed: () => false }), appVersion: '1.8.0', flush: async () => {}, restart: async () => {},
      dialogs: { showSaveDialog: () => { opened++; return new Promise((resolve) => { finish = resolve; }); } },
    });
    const first = handlers.createBackup({});
    assert.equal((await handlers.restoreBackup({})).ok, false); assert.equal(opened, 1);
    finish({ canceled: true }); assert.equal((await first).cancelled, true);
  });

  it('serves the board and refuses the API without the token', async () => {
    const base = booted.zelos.url;

    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('access-control-allow-origin'), null);

    const denied = await fetch(new URL('/api/health', base));
    assert.equal(denied.status, 401);

    const allowed = await fetch(new URL('/api/health', base), {
      headers: { 'X-Zelos-Token': booted.zelos.token },
    });
    assert.equal(allowed.status, 200);
    const health = await allowed.json();
    assert.equal(health.ok, true);
    assert.equal(health.home, home);
  });

  it('guards the window it opened', () => {
    const contents = recorded.windows[0].webContents;
    const before = recorded.external.length;

    let prevented = false;
    contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://phish.example/login');
    assert.equal(prevented, true);
    assert.equal(recorded.external.at(-1), 'https://phish.example/login');

    prevented = false;
    contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, `${booted.zelos.url}#/owed`);
    assert.equal(prevented, false, 'the board may navigate itself');
    assert.equal(recorded.external.length, before + 1);

    assert.deepEqual(contents.windowOpenHandler({ url: 'https://example.com/' }), { action: 'deny' });
  });

  it('REGRESSION: a popup onto the board carrying a ?t= is denied, and the window keeps the URL it was opened at', () => {
    // The pure guard is covered above; this is the wiring. main.js used to
    // pass an onInternalPopup that called mainWindow.loadURL, so the verdict
    // was "deny" and the window navigated anyway.
    const win = recorded.windows[0];
    const loadedBefore = [...win.loaded];
    const externalBefore = recorded.external.length;
    assert.deepEqual(win.webContents.windowOpenHandler({ url: `${booted.zelos.url}?t=garbage` }), { action: 'deny' });
    assert.deepEqual(win.loaded, loadedBefore, 'a connector-supplied URL was loaded into the board window');
    assert.equal(recorded.external.length, externalBefore, 'and it is not a link for the system browser either');
  });

  it('shows the build commit next to the version when the package carries one, and just the version when it does not', () => {
    /* The operator's Aug 9 app, the site's dbbd584 installers and a HEAD
       build were all "Zelos 1.0.0" in About and shared a filename, so "which
       build do you have?" had no answer while one of them predated every fix.
       CI stamps the commit into the packaged package.json; this is the reader,
       the label, and the dialog that shows it. */
    assert.equal(main.versionLabel('1.1.0', 'a1b2c3d'), '1.1.0 (a1b2c3d)');
    assert.equal(main.versionLabel('1.1.0', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'), '1.1.0 (a1b2c3d)',
      'CI stamps the whole sha; the label shows what a person compares with git log');
    assert.equal(main.versionLabel('1.1.0', ''), '1.1.0');
    assert.equal(main.versionLabel('1.1.0'), '1.1.0');

    const stamped = path.join(sandbox, 'stamped');
    fs.mkdirSync(stamped, { recursive: true });
    fs.writeFileSync(path.join(stamped, 'package.json'),
      JSON.stringify({ name: 'zelos-desktop', version: '1.1.0', commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }));
    assert.equal(main.readBuildCommit(stamped), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    const about = main.aboutText({ version: '1.1.0', commit: main.readBuildCommit(stamped), url: 'http://127.0.0.1:1/', home: '/x' });
    assert.equal(about.message, 'Zelos 1.1.0 (a1b2c3d)');
    assert.match(about.detail, /Board   http:\/\/127\.0\.0\.1:1\//);

    // Unstamped, junk, or no package at all: the plain version, never a throw.
    const unstamped = path.join(sandbox, 'unstamped');
    fs.mkdirSync(unstamped, { recursive: true });
    fs.writeFileSync(path.join(unstamped, 'package.json'), JSON.stringify({ version: '1.1.0' }));
    assert.equal(main.readBuildCommit(unstamped), '');
    fs.writeFileSync(path.join(unstamped, 'package.json'), JSON.stringify({ version: '1.1.0', commit: 'not a sha; $(rm -rf /)' }));
    assert.equal(main.readBuildCommit(unstamped), '', 'a stamp that is not a sha is not shown');
    fs.writeFileSync(path.join(unstamped, 'package.json'), JSON.stringify({ version: '1.1.0', commit: 1234567 }));
    assert.equal(main.readBuildCommit(unstamped), '', 'the argument parser turned an all-digit stamp into a number once; that is no stamp');
    assert.equal(main.readBuildCommit(path.join(sandbox, 'nowhere')), '');
    assert.equal(main.aboutText({ version: '1.1.0', commit: '' }).message, 'Zelos 1.1.0');

    // The two ends of the contract: CI writes the field main.js reads.
    const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'desktop.yml'), 'utf8');
    assert.match(workflow, /-c\.extraMetadata\.commit=\$\{\{ github\.sha \}\}/,
      'the workflow no longer stamps the commit the shell reads');
  });

  it('the About dialog is built from the stamp the shell read at launch', () => {
    const before = recorded.messageBoxes.length;
    booted.actions.about();
    assert.equal(recorded.messageBoxes.length, before + 1, 'About showed no dialog');
    const shown = recorded.messageBoxes.at(-1);
    // A source checkout carries no stamp, and has to read as the plain version.
    const commit = main.readBuildCommit(path.join(REPO, 'desktop'));
    assert.equal(commit, '', 'desktop/package.json in the checkout must not carry a commit — that field is CI\'s to write');
    assert.equal(shown.message, 'Zelos 1.0.0');
    assert.deepEqual(shown, main.aboutText({ version: '1.0.0', commit, url: booted.zelos.url, home }));
  });

  it('cancels any request from the board that is not the board, on every scheme', () => {
    const { filter, handler } = recorded.beforeRequest;
    // Not `*://*/*`. That pattern reads as "any scheme" and means http and
    // https: `*` in the scheme position of a match pattern is those two only.
    // Measured against the pinned Electron 43.3.0 with five requests on five
    // schemes, `*://*/*` delivered three to this handler and `<all_urls>`
    // delivered five — the two it had been swallowing were ws: and wss:. The
    // filter is the whole of the bug, and it cannot be caught from the handler
    // side: a handler that is never called cancels nothing and looks perfect.
    assert.deepEqual(filter.urls, ['<all_urls>'],
      'a backstop sold as the layer a CSP bypass cannot reach must see every scheme');

    const verdicts = [];
    for (const url of [
      'https://telemetry.example/collect',
      'ws://telemetry.example/socket',
      'wss://telemetry.example/socket',
      // The board's own port, still not the board: it speaks SSE over fetch and
      // opens no socket, so a WebSocket to loopback is somebody else's idea.
      `ws://127.0.0.1:${booted.zelos.port}/`,
    ]) {
      handler({ url }, (r) => verdicts.push(r.cancel));
    }
    assert.deepEqual(verdicts, [true, true, true, true]);

    // And the board's own files still load — the half that makes this a
    // backstop rather than a wall.
    handler({ url: `${booted.zelos.url}app.css` }, (r) => verdicts.push(r.cancel));
    assert.equal(verdicts.at(-1), false);
  });

  it('shuts WebRTC off: the board\'s CSP gains webrtc \'block\', and the peer layer gets no UDP', () => {
    /* WebRTC is not a URL request. ICE, STUN/TURN and data channels never
       enter the onBeforeRequest pipeline the test above exercises, and
       `connect-src 'self'` does not govern them either — so without these two
       controls, a script in the board's origin could hand the session token to
       `turn:attacker.example` as an ICE credential and neither layer would
       fire. The CSP directive is the deny; the IP-handling policy is the layer
       underneath it, for the page that has somehow shed its CSP. */
    for (const win of recorded.windows) {
      assert.equal(win.webContents.webRTCIPHandlingPolicy, 'disable_non_proxied_udp',
        'a window\'s peer-connection layer was left with its default UDP reach');
    }

    const { filter, handler } = recorded.headersReceived ?? {};
    assert.ok(handler, 'no header hook: the board\'s CSP never gains the webrtc directive');
    assert.deepEqual(filter.urls, ['<all_urls>']);

    // Appended to the policy the server sent, whatever case the header came in.
    let out;
    handler({ responseHeaders: { 'content-security-policy': ["default-src 'self'"] } },
      (r) => { out = r.responseHeaders; });
    assert.deepEqual(out['content-security-policy'], ["default-src 'self'", "webrtc 'block'"]);
    handler({ responseHeaders: { 'Content-Security-Policy': ["default-src 'self'"] } },
      (r) => { out = r.responseHeaders; });
    assert.deepEqual(out['Content-Security-Policy'], ["default-src 'self'", "webrtc 'block'"]);

    // And present even on a response that carried no policy at all.
    handler({ responseHeaders: {} }, (r) => { out = r.responseHeaders; });
    assert.deepEqual(out['Content-Security-Policy'], ["webrtc 'block'"]);
  });

  it('denies every browser permission but the one the copy buttons need', () => {
    const granted = [];
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write']) {
      recorded.permission.request(null, permission, (ok) => granted.push([permission, ok]));
      assert.equal(recorded.permission.check(null, permission), permission === 'clipboard-sanitized-write');
    }
    assert.deepEqual(granted, [
      ['media', false],
      ['geolocation', false],
      ['notifications', false],
      ['clipboard-read', false],
      ['clipboard-sanitized-write', true],
    ]);
  });

  it('puts a tray icon up with the three items, and a real image behind it', () => {
    const tray = recorded.trays.at(0);
    assert.ok(tray, 'no tray was created');
    assert.ok(fs.existsSync(tray.image.file), `tray icon missing: ${tray.image.file}`);
    assert.deepEqual(
      tray.menu.template.map((item) => item.label ?? item.type),
      ['Check now', 'Open Zelos', 'separator', 'Quit Zelos'],
    );
    assert.match(tray.tooltip, /^Zelos — http:\/\/127\.0\.0\.1:/);
    assert.ok(recorded.applicationMenu, 'no application menu was installed');
  });

  it('runs a sweep from the tray, against the supervisor and not a socket', async () => {
    const sweep = recorded.trays[0].menu.template.find((item) => item.label === 'Check now');
    sweep.click();
    assert.equal(booted.zelos.sweepStatus().running, true, 'the tray did not reach the sweep supervisor');

    // With nothing configured the run fails on its own terms — no model key, so
    // no request is ever made — and the shell survives it.
    for (let i = 0; i < 200 && booted.zelos.sweepStatus().running; i++) {
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    assert.equal(booted.zelos.sweepStatus().running, false, 'the sweep never finished');

    const health = await (await fetch(new URL('/api/health', booted.zelos.url), {
      headers: { 'X-Zelos-Token': booted.zelos.token },
    })).json();
    assert.equal(health.ok, true);
  });

  it('switches views through a fixed allowlist, never a string from outside', () => {
    const contents = recorded.windows[0].webContents;
    const before = contents.executed.length;
    booted.actions.showView('calendar');
    assert.equal(contents.executed.at(-1), 'window.location.hash = "#/calendar";');

    booted.actions.showView('../../etc/passwd');
    booted.actions.showView('now"; fetch("http://evil.example");//');
    assert.equal(contents.executed.length, before + 1, 'an unknown view id must do nothing at all');
  });

  it('hands the browser a one-time address, never the bare board or the token', async () => {
    /* The Board menu and the crash dialog both say the board works in a
       browser. The bare address does not — without the session token it lands
       on the refusal screen — and the token itself must never reach a command
       line, where every process on the machine can read it. So the shell asks
       the core it embeds for the same ten-second single-use handoff the CLI
       launcher mints, and hands THAT to the system browser. */
    const before = recorded.external.length;
    booted.actions.openInBrowser();
    assert.equal(recorded.external.length, before + 1, 'nothing reached the system browser');
    const opened = recorded.external.at(-1);
    assert.ok(opened.startsWith(booted.zelos.url), 'the address must be the board\'s own origin');
    assert.match(new URL(opened).pathname, /^\/h\/[0-9a-f]{64}$/, 'the address must be a minted handoff');
    assert.ok(!opened.includes(booted.zelos.token), 'the session token must never reach an argument vector');

    // And it is a real one: the server trades it for the token, exactly once.
    const traded = await fetch(opened, { redirect: 'manual' });
    assert.equal(traded.status, 302);
    assert.equal(new URL(traded.headers.get('location'), opened).searchParams.get('t'), booted.zelos.token);
    const again = await fetch(opened, { redirect: 'manual' });
    assert.equal(again.status, 404, 'a handoff spends exactly once');
  });

  it('badges the icon after a sweep, and clears it when the board is looked at', async () => {
    const { upsertItem } = await import(pathToFileURL(path.join(REPO, 'core', 'db.mjs')).href);
    upsertItem(booted.zelos.db, {
      key: 'badge-test-1',
      kind: 'reply',
      bucket: 'now',
      headline: 'Somebody is waiting on you',
      severity: 3,
    });
    assert.equal(booted.zelos.attentionCount(), 1);

    // A badge only means anything while the board is not on screen; a window
    // the user is looking at has already told them the number.
    const win = recorded.windows[0];
    win.hide();
    recorded.badgeCount = null;
    booted.zelos.server.zelos.sweeps.relay('done', { ok: true });
    assert.equal(recorded.badgeCount, 1, 'a finished sweep did not badge the icon');

    booted.actions.openBoard();
    assert.equal(recorded.badgeCount, 0, 'opening the board did not clear the badge');
  });

  it('turns launch-at-login on and off, and never turns it on by itself', () => {
    assert.equal(recorded.loginItem, null, 'the shell set a login item nobody asked for');
    assert.equal(booted.actions.openAtLogin(), false);

    booted.actions.setOpenAtLogin(true);
    assert.equal(recorded.loginItem.openAtLogin, true);
    /* openAtLogin and nothing else. This used to also assert `openAsHidden`,
       under the message "a login launch must not steal the screen" — a claim
       no code path in this repo delivers. Electron 43 marks the flag
       deprecated and does not implement it on macOS 13 and up, it does not
       exist on Windows where menus.js offers the same checkbox, and its
       counterpart `wasOpenedAsHidden` is read nowhere here, so createWindow()
       shows the window at 1180×820 whatever the OS answers. Passing it again
       would restore the promise without restoring any behaviour, which is what
       this pins against. */
    assert.deepEqual(Object.keys(recorded.loginItem), ['openAtLogin'],
      'the shell must ask the OS only for what it can actually deliver');
    assert.equal(booted.actions.openAtLogin(), true);

    booted.actions.setOpenAtLogin(false);
    assert.equal(recorded.loginItem.openAtLogin, false);
  });

  it('stops reloading a renderer that keeps dying, and says so', () => {
    const win = recorded.windows[0];
    const contents = win.webContents;
    const before = win.loaded.length;
    const boxes = recorded.messageBoxes.length;

    // The first crash is reloaded at once — that is the glitch case, and it is
    // the only one that happens without a timer.
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(win.loaded.length, before + 1, 'the first crash was not reloaded');
    assert.equal(recorded.messageBoxes.length, boxes, 'one crash is not worth a dialog');

    // The next two back off, so nothing more is loaded synchronously.
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(win.loaded.length, before + 1);

    // The fourth inside the minute is a loop. It gets a dialog instead.
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    const explained = recorded.messageBoxes.slice(boxes);
    assert.equal(explained.length, 2, 'a looping renderer must be explained, not reloaded forever');
    assert.match(explained[0].title, /keeps stopping/);
    assert.match(explained[0].detail, /crashed/);
    assert.deepEqual(explained[0].buttons, ['OK', 'Open in your web browser'],
      'the dialog must offer the browser it talks about');
    assert.equal(win.loaded.length, before + 1, 'the shell reloaded past its own limit');
  });

  it('a board that loads and then dies again is still a loop, and is still stopped', () => {
    // The tempting rule — "a load finished, so forget the crashes" — reads as
    // common sense and is a trap. A renderer running out of memory on a very
    // long board loads FIRST and dies after, so forgetting on a finished load
    // resets the attempt count every lap and the reload runs forever at zero
    // delay: precisely the loop the counter exists to stop. Unrelated crashes
    // are handled by the one-minute window instead, which is tested below.
    const win = recorded.windows[0];
    const contents = win.webContents;

    const boxes = recorded.messageBoxes.length;
    for (let i = 0; i < 4; i++) {
      contents.emit('render-process-gone', {}, { reason: 'oom' });
      // Each reload succeeds — and the next crash arrives anyway.
      contents.emit('did-finish-load');
    }

    assert.ok(recorded.messageBoxes.length > boxes,
      'a renderer that keeps dying after each successful load must eventually be explained');
  });

  it('the crash dialog\'s browser button opens a fresh handoff', async () => {
    /* The dialog used to print the bare board address and claim it works in a
       browser — it does not; without the token it is the refusal screen. Now
       the claim is a button, and the button mints when it is clicked, so the
       handoff's ten seconds start as the browser is about to spend it. */
    const contents = recorded.windows[0].webContents;
    recorded.messageBoxResponse = 1; // the second button: Open in your web browser
    const before = recorded.external.length;
    try {
      // The crashes above are still inside the minute, so these hit the limit.
      for (let i = 0; i < 4; i++) contents.emit('render-process-gone', {}, { reason: 'crashed' });
      await new Promise((resolve) => { setImmediate(resolve); });
    } finally {
      recorded.messageBoxResponse = 0;
    }
    const opened = recorded.external.slice(before);
    assert.ok(opened.length > 0, 'the dialog\'s button opened nothing');
    for (const url of opened) {
      assert.match(new URL(url).pathname, /^\/h\/[0-9a-f]{64}$/,
        'the dialog must open a handoff, not the bare address');
    }
  });

  it('closing honours residency and protects unsaved drafts before destructive close', async (t) => {
    /* What is being tested here is the WIRING: that the close handler asks
       shouldStayResidentOnClose and does what it says. The rule's own truth
       table is tested separately, further down, where every platform is
       supplied as data instead of being whatever this machine happens to be.

       Asserting a fixed answer here is what went wrong twice: "always stays
       resident" was a macOS assumption that failed on Linux, and "only macOS
       stays resident" was a Linux assumption that failed on Windows — where a
       tray really does exist and really is somewhere to go. */
    const { shouldStayResidentOnClose } = await import(
      pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href);
    const expected = shouldStayResidentOnClose({
      platform: process.platform,
      hasTray: recorded.trays.length > 0,
      autoSweep: booted.zelos.config.sweep.auto === true,
      trayConfirmed: process.env.ZELOS_TRAY_RESIDENT === '1',
    });

    const win = recorded.windows[0];
    if (!expected) t.mock.method(win.webContents, 'executeJavaScript', async () => { throw new Error('Draft save failed'); });
    let prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });

    assert.equal(prevented, true, 'close must hide a resident window or wait for its draft saves');
    if (expected) assert.equal(win.visible, false, 'it should have gone to the background');
    else {
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(readHomeLock(home), 'a failed save must keep the core running');
      assert.equal(win.visible, true, 'a failed save must leave the editable page visible');
    }

    // Where it was is remembered either way: that is not a residency question.
    const state = JSON.parse(fs.readFileSync(path.join(home, 'window.json'), 'utf8'));
    assert.equal(state.bounds.width, win.options.width);
    assert.equal(state.bounds.height, win.options.height);
  });

  it('re-fits a hidden window to the displays that are left, before showing it', () => {
    /* The tray-resident path is the one that can lose a window: `close` hides
       it instead of destroying it, so it can sit for hours holding a rectangle
       on a monitor that is unplugged in the meantime, and `show()` honours that
       rectangle exactly. Live on Windows, and on Linux with
       ZELOS_TRAY_RESIDENT=1; not on macOS, where AppKit constrains the frame
       onto a real screen by itself — there the code runs and finds nothing to
       do, which is what the last case below asserts.

       The stub screen has one work area: 1680×1020 at the origin. */
    const win = recorded.windows[0];

    // Hidden at x:1500 with a second monitor to the right of it; the laptop
    // came off the desk, and 180px of the window is all that is still on a
    // screen — enough to count as visible, not enough to leave where it is.
    win.hide();
    win.bounds = { x: 1500, y: 960, width: 1180, height: 820 };
    booted.actions.openBoard();
    assert.equal(win.visible, true);
    assert.deepEqual(win.getBounds(), { x: 500, y: 200, width: 1180, height: 820 },
      'a window shown where its monitor used to be is a window the user cannot find');

    // The harder half: nothing that exists overlaps it at all, so there is no
    // corrected position to slide to — only a screen to start over on.
    win.hide();
    win.bounds = { x: 2600, y: 300, width: 1180, height: 820 };
    const centred = win.centred;
    booted.actions.openBoard();
    assert.equal(win.centred, centred + 1, 'a window whose display is gone must be re-placed, not shown at x:2600');
    assert.equal(win.visible, true);

    // And a window that never went anywhere is left alone — not re-set to the
    // same numbers. Every tray click and every ⌘Tab comes through here, and a
    // setBounds per visit is a move event per visit for no reason at all.
    win.hide();
    win.bounds = { x: 120, y: 90, width: 1180, height: 820 };
    const sets = win.boundsSets;
    booted.actions.openBoard();
    assert.equal(win.boundsSets, sets, 'a window that is where it says it is must not be moved');
    assert.deepEqual(win.getBounds(), { x: 120, y: 90, width: 1180, height: 820 });
  });

  it('holds the data home while it runs, with the pid and the port in it', () => {
    const held = readHomeLock(home);
    assert.ok(held, `nothing is holding ${home}`);
    assert.equal(held.pid, process.pid);
    assert.equal(held.kind, 'desktop');
    assert.equal(held.port, booted.zelos.port, 'the lock does not say where the board is');
  });

  it('repeating the Search shortcut refocuses its field on the current route', () => {
    const contents = recorded.windows[0].webContents;
    booted.actions.showView('search');
    const code = contents.executed.at(-1);
    let focused = false;
    const field = { focus() { focused = true; } };
    const window = { location: { hash: '#/search' } };
    const document = { querySelector(selector) { assert.equal(selector, '.search-field'); return field; } };
    new Function('window', 'document', code)(window, document);
    assert.equal(focused, true, 'same-route Search left focus on another control');
    window.location.hash = '#/now';
    focused = false;
    new Function('window', 'document', code)(window, document);
    assert.equal(window.location.hash, '#/search');
    assert.equal(focused, false, 'arriving Search lets the newly rendered view focus its field');
  });

  it('reload waits for draft saves, and a failed save keeps the page open', async (t) => {
    const win = recorded.windows[0];
    let finish;
    const execute = t.mock.method(win.webContents, 'executeJavaScript', () => new Promise(resolve => { finish = resolve; }));
    const loaded = win.loaded.length;
    const reloading = booted.actions.reloadBoard();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(win.loaded.length, loaded, 'reload destroyed the page before its draft save returned');
    assert.match(execute.mock.calls[0].arguments[0], /__zelosFlushDrafts/);
    finish(true);
    await reloading;
    assert.equal(win.loaded.length, loaded + 1);
    execute.mock.mockImplementation(async () => { throw new Error('synthetic private draft error'); });
    const notices = recorded.messageBoxes.length;
    await booted.actions.reloadBoard();
    assert.equal(win.loaded.length, loaded + 1, 'a failed save must cancel reload');
    assert.equal(recorded.messageBoxes.length, notices + 1);
    assert.match(recorded.messageBoxes.at(-1).detail, /draft|copy/i);
    assert.ok(!JSON.stringify(recorded.messageBoxes.at(-1)).includes('synthetic private draft error'));
  });

  it('a page that has not loaded its draft editor can leave without importing anything', async () => {
    const contents = { executeJavaScript: code => Promise.resolve(new Function('globalThis', `return (${code});`)({})) };
    await main.flushDraftsInPage(contents);
  });

  it('a stalled draft flush times out without leaving the page', async () => {
    const contents = { executeJavaScript: () => new Promise(() => {}) };
    await assert.rejects(main.flushDraftsInPage(contents, { timeoutMs: 15 }), /saving/i);
  });

  it('a rejected browser handoff is explained without exposing the handoff or error', async (t) => {
    t.mock.method(electron.shell, 'openExternal', async () => { throw new Error('private-handoff-canary'); });
    const notices = recorded.messageBoxes.length;
    await booted.actions.openInBrowser();
    assert.equal(recorded.messageBoxes.length, notices + 1);
    assert.match(recorded.messageBoxes.at(-1).message, /browser/i);
    assert.ok(!JSON.stringify(recorded.messageBoxes.at(-1)).includes('private-handoff-canary'));
  });

  it('failed draft saving cancels native quit and allows another attempt', async (t) => {
    t.mock.method(recorded.windows[0].webContents, 'executeJavaScript', async () => { throw new Error('Save failed'); });
    const notices = recorded.messageBoxes.length;
    electron.app.quit();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(readHomeLock(home));
    assert.equal((await fetch(booted.zelos.url)).status, 200);
    assert.equal(recorded.messageBoxes.length, notices + 1);
    assert.match(recorded.messageBoxes.at(-1).message, /draft edits open/);
  });

  it('native quit waits for draft saves before closing the server and releasing the home', async (t) => {
    const win = recorded.windows[0];
    let finish;
    t.mock.method(win.webContents, 'executeJavaScript', () => new Promise(resolve => { finish = resolve; }));
    electron.app.quit();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(readHomeLock(home), 'quit shut down before the renderer acknowledged its draft saves');
    assert.equal((await fetch(booted.zelos.url)).status, 200);
    finish(true);
    await new Promise(resolve => setImmediate(resolve));
    await main.shutdown();
    await assert.rejects(fetch(booted.zelos.url), 'the socket is still open after shutdown');
    assert.equal(readHomeLock(home), null, 'the lock outlived the process that took it');
    assert.equal(fs.existsSync(path.join(home, 'zelos.lock')), false);
  });
});

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

describe('parseShellArgs', () => {
  let parseShellArgs;
  before(async () => {
    ({ parseShellArgs } = await import(pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href));
  });

  it('reads the three flags in both spellings', () => {
    assert.deepEqual(parseShellArgs(['--home=/tmp/z', '--port=9999', '--sweep-now']), {
      home: '/tmp/z', port: 9999, sweepNow: true, mcp: false,
    });
    assert.deepEqual(parseShellArgs(['--home', '/tmp/z', '--port', '9999']), {
      home: '/tmp/z', port: 9999, sweepNow: false, mcp: false,
    });
  });

  it('notices the one bare word the pasted config block sends', () => {
    // The "Ready to paste" block in Settings spawns this binary with `mcp` and
    // nothing else — the packaged build ships no zelos.mjs for a client to
    // name, so the shell itself has to answer it.
    assert.deepEqual(parseShellArgs(['mcp']), { home: null, port: null, sweepNow: false, mcp: true });
    assert.equal(parseShellArgs(['mcp', '--home=/tmp/z']).home, '/tmp/z');
    assert.equal(parseShellArgs(['.', 'mcp']).mcp, true, 'a dev shell sees its app path first');
  });

  it('ignores what Chromium and macOS add, rather than refusing to start', () => {
    assert.deepEqual(parseShellArgs(['.', '-psn_0_1234', '--disable-gpu', '--inspect=9229', '--port=0']), {
      home: null, port: 0, sweepNow: false, mcp: false,
    });
  });

  it('ignores a --home that is interpolation garbage, not a directory', () => {
    // `--home=${dir}` with `dir` unset hands us the literal string
    // "undefined"; honouring it once created a live data directory named
    // undefined/ in the working directory.
    for (const bad of [['--home=undefined'], ['--home', 'undefined'], ['--home=null'], ['--home', 'NULL']]) {
      assert.equal(parseShellArgs(bad).home, null, bad.join(' '));
    }
  });

  it('ignores a port that is not one', () => {
    for (const bad of [['--port=nope'], ['--port=70000'], ['--port=-1'], ['--port']]) {
      assert.equal(parseShellArgs(bad).port, null, bad.join(' '));
    }
  });
});

/* ------------------------------------------------------------------ *
 * The lock on the data home
 * ------------------------------------------------------------------ */

/**
 * The case Electron's single-instance lock cannot see: a `zelos` in a terminal
 * and this app, both pointed at one home, both sweeping. These run against
 * their own temp homes and never load the core, except for the one test that
 * has to prove startCore refuses before it opens anything.
 */
describe('the lock on the data home', () => {
  let dir;
  before(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-lock-'))); });
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const freshHome = (name) => path.join(dir, name);

  it('reports a second Zelos while the first one is alive, and still starts', () => {
    const home = freshHome('busy');
    const first = acquireHomeLock({ home, kind: 'cli', port: 4321 });

    // Advisory, not exclusive: it never throws, because the diagnosis reads a
    // file to guess whether a process is alive and a guess that is sometimes
    // wrong must not be able to stop somebody starting their own app.
    const second = acquireHomeLock({ home, kind: 'desktop' });
    assert.ok(second.contested, 'a busy home has to be reported');
    // The warning has to name what to quit, and how to clear it if the
    // diagnosis was wrong — that escape hatch is the whole safety net.
    assert.match(second.contested.message, /terminal/);
    assert.match(second.contested.message, new RegExp(`process ${process.pid}\\b`));
    assert.match(second.contested.message, /http:\/\/127\.0\.0\.1:4321\//);
    assert.match(second.contested.message, /delete /);
    assert.equal(second.contested.pid, process.pid);
    assert.equal(second.contested.kind, 'cli');
    assert.equal(second.contested.home, home);
    // The loser owns nothing: releasing it must not take the live lock away.
    second.release();
    assert.equal(readHomeLock(home).pid, process.pid);
    assert.equal(readHomeLock(home).kind, 'cli', 'the first holder still holds it');

    first.release();
    // And once it lets go, the next one walks straight in, uncontested.
    const third = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(third.contested, null);
    assert.equal(readHomeLock(home).kind, 'desktop');
    third.release();
  });

  it('records the port once the board has bound one', () => {
    const home = freshHome('port');
    const held = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(readHomeLock(home).port, null);
    held.setPort(51234);
    assert.equal(readHomeLock(home).port, 51234);
    held.release();
  });

  it('reclaims a lock left behind by a crash rather than locking the user out', () => {
    const home = freshHome('stale');
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'zelos.lock');

    // A pid far above any pid_max on any platform this runs on: a process that
    // is certainly not there, which is what a lock left by a crash looks like.
    fs.writeFileSync(file, JSON.stringify({ pid: 2_147_483_646, kind: 'cli', port: 7777 }));
    const afterCrash = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(readHomeLock(home).pid, process.pid, 'a dead pid still held the home');
    afterCrash.release();

    // And a lock file truncated by a hard power-off is not a lock either.
    fs.writeFileSync(file, '{"pid": 12');
    const afterPowerCut = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(readHomeLock(home).pid, process.pid, 'an unreadable lock file locked the user out');
    afterPowerCut.release();
    assert.equal(fs.existsSync(file), false);
  });

  it('will not release a lock that belongs to somebody else', () => {
    const home = freshHome('handover');
    const mine = acquireHomeLock({ home, kind: 'desktop' });
    // Somebody reclaimed it while this instance was shutting down. Releasing
    // here would take the live instance's lock away with us.
    fs.writeFileSync(path.join(home, 'zelos.lock'), JSON.stringify({ pid: 2_147_483_645, kind: 'cli', port: null }));
    mine.release();
    assert.equal(readHomeLock(home).pid, 2_147_483_645);
  });

  it('startCore reports a busy home on its handle rather than refusing to run', async () => {
    const home = freshHome('startcore');
    const held = acquireHomeLock({ home, kind: 'cli', port: 9999 });
    const previous = process.env.ZELOS_HOME;
    try {
      const handle = await startCore({ root: REPO, home, port: 0 });
      try {
        // It started — that is the point. What it must not do is stay quiet
        // about the other instance, because the cost of the overlap (the same
        // mail read twice, the same model calls paid for twice) is invisible.
        assert.ok(handle.contested, 'a busy home has to reach the shell');
        assert.equal(handle.contested.kind, 'cli');
        assert.match(handle.contested.message, /terminal/);
      } finally {
        await handle.stop();
      }
      // And starting must not have taken the live instance's lock with it.
      assert.equal(readHomeLock(home).port, 9999);
      assert.equal(readHomeLock(home).pid, process.pid);
    } finally {
      held.release();
      if (previous === undefined) delete process.env.ZELOS_HOME;
      else process.env.ZELOS_HOME = previous;
    }
  });

  it('takes the lock for a launcher in one call, and says a terminal holds it', () => {
    // The pairing the lock exists for only works if both entry points take it.
    // This is the whole CLI half: one call, released when the process ends.
    const home = freshHome('holdhome');
    const lock = holdHome({ home, kind: 'cli' });
    try {
      assert.equal(readHomeLock(home).kind, 'cli');
      assert.equal(readHomeLock(home).pid, process.pid);
      const shell = acquireHomeLock({ home, kind: 'desktop' });
      assert.ok(shell.contested, 'the app has to be told a terminal got here first');
      assert.equal(shell.contested.kind, 'cli');
      assert.match(shell.contested.message, /terminal/);
      shell.release();
      lock.setPort(5150);
      assert.equal(readHomeLock(home).port, 5150);
    } finally {
      lock.release();
    }
  });

  it('the launcher reaches the lock through a path the package actually ships', () => {
    /* REGRESSION, and the reason this test is not the one that used to be here.
       The old version grepped zelos.mjs for the string `holdHome` and passed —
       while the feature was completely dead in every installed copy. The
       launcher was importing it from `./desktop/runtime.js`, `package.json`'s
       `files` list deliberately omits `desktop/` (the Electron shell is a
       separate artefact, and the test two files over asserts the tarball is
       free of it), and the ERR_MODULE_NOT_FOUND went into a bare `catch {}`.
       Measured on the packed tarball: no zelos.lock was ever written and a
       second process on a busy home started silently. A grep for a function
       name cannot see any of that, because the name was right; the *import
       target* was the defect.

       So this asserts the shape that broke: the launcher may only reach the
       lock through a specifier the published `files` list covers. The
       behavioural half — that a `zelos` run out of the real tarball warns about
       a home somebody else holds — is in test/cli.test.mjs, which has an
       extracted tarball to run from. */
    const source = fs.readFileSync(path.join(REPO, 'zelos.mjs'), 'utf8');
    const shipped = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).files;

    const specifiers = [...source.matchAll(/(?:^|[^\w])import\(\s*'([^']+)'/g)].map((m) => m[1])
      .concat([...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]))
      .filter((s) => s.startsWith('.'));
    const lockImport = specifiers.find((s) => s.includes('home-lock'));
    assert.ok(lockImport, 'zelos.mjs must import the home lock — it is the CLI half of the exclusion');
    assert.ok(!specifiers.some((s) => s.startsWith('./desktop/')),
      `zelos.mjs imports ${specifiers.filter((s) => s.startsWith('./desktop/')).join(', ')}, which npm does not publish`);

    // And the directory it does import from has to be one `files` carries.
    const dir = `${lockImport.replace(/^\.\//, '').split('/')[0]}/`;
    assert.ok(shipped.includes(dir), `zelos.mjs takes the lock from ${dir}, which is not in package.json files`);
    assert.ok(!shipped.some((f) => f.startsWith('desktop')), 'the Electron shell is a separate artefact and must stay out of the tarball');

    assert.match(source, /kind: 'cli'/, 'the launcher must identify itself as the terminal one');
    // It must still never be able to take the launcher down with it — but a
    // silent catch is what hid the dead import for a whole release, so the
    // failure has to reach the log on its way past.
    const at = source.indexOf(`import('${lockImport}')`);
    assert.notEqual(at, -1, 'the lock has to be loaded at the point of use, after --home has been settled');
    const call = source.slice(at - 200, at + 600);
    assert.match(call, /try\s*{/, 'the lock must never be able to stop the launcher');
    assert.match(call, /catch\s*\(\s*err\s*\)[\s\S]{0,200}warn/, 'and a swallowed failure has to say so');
  });
});

/* ------------------------------------------------------------------ *
 * Deciding whether a lock is still held
 * ------------------------------------------------------------------ */

/**
 * The failure this replaces was a permanent one. `EPERM` from `kill(pid, 0)`
 * was read as "alive", so after an unclean exit and a reboot — where the
 * recorded number has very likely been handed to a root-owned daemon — Zelos
 * refused to start and went on refusing, with nothing a user could do about it
 * short of finding a file nobody had told them existed.
 */
describe('lockHolderState', () => {
  const NOW = Date.parse('2026-08-09T12:00:00Z');
  const BOOTED = Date.parse('2026-08-09T09:00:00Z');
  const at = (iso) => iso;
  const state = (record, probe) => lockHolderState(record, { now: NOW, bootedAt: BOOTED, uid: 501, ...probe });

  it('reclaims a pre-boot lock even when it names this very process', () => {
    // The nastiest version of pid reuse: after a reboot the kernel hands the
    // numbers out again from the start, so a lock left by an unclean exit can
    // name the pid THIS process is now running under. Answering "held — this
    // process holds it" there is a refusal justified by a coincidence, and it
    // never clears. The boot rule has to be read before the identity check.
    const verdict = state(
      { pid: process.pid, kind: 'desktop', uid: 501, startedAt: at('2026-08-08T22:00:00Z') },
      { signal: () => 'alive' },
    );
    assert.equal(verdict.held, false);
    assert.match(verdict.why, /booted/);
  });

  it('will not hold on a foreign lock that cannot say when it was taken', () => {
    // A record naming another user and an unsignallable pid, with no readable
    // startedAt, used to be held forever: with no age, neither the boot rule
    // nor the month-old ceiling could ever release it. An unreadable date is a
    // broken lock, and a broken lock must not outrank somebody starting up.
    const verdict = state(
      { pid: 1, kind: 'desktop', uid: 0 },
      { signal: () => 'denied' },
    );
    assert.equal(verdict.held, false);
  });

  it('reclaims a pid handed to something else across a reboot', () => {
    // The reproduction: pid 1, owned by root, answering EPERM. It is alive, it
    // is simply not Zelos — and the lock predates the boot, which settles it
    // whatever the signal says.
    const verdict = state(
      { pid: 1, kind: 'desktop', uid: 501, startedAt: at('2026-08-08T22:00:00Z') },
      { signal: () => 'alive' },
    );
    assert.equal(verdict.held, false, 'a lock written before this boot cannot still be held');
    assert.match(verdict.why, /booted/);
  });

  it('reads EPERM on a lock this user wrote as pid reuse, not as life', () => {
    // A process this user started can always be signalled by this user. So a
    // refusal to signal one is proof the pid belongs to somebody else now.
    const verdict = state(
      { pid: 1, kind: 'cli', uid: 501, startedAt: at('2026-08-09T11:00:00Z') },
      { signal: () => 'denied' },
    );
    assert.equal(verdict.held, false);
    assert.match(verdict.why, /someone else/);
  });

  it('treats a lock with no uid at all as reclaimable when it cannot be probed', () => {
    // Written by an older Zelos, or truncated. Unknowable is not a reason to
    // lock somebody out of their own data.
    assert.equal(
      state({ pid: 1, kind: 'cli', startedAt: at('2026-08-09T11:00:00Z') }, { signal: () => 'denied' }).held,
      false,
    );
  });

  it('still refuses for a Zelos another user is running', () => {
    const record = { pid: 4242, kind: 'cli', uid: 0, startedAt: at('2026-08-09T11:00:00Z') };
    assert.equal(state(record, { signal: () => 'denied' }).held, true, 'sudo zelos is a real holder');
    // ...but not forever. A month of nobody being able to probe it is a lockout.
    assert.equal(
      state({ ...record, startedAt: at('2026-05-01T00:00:00Z') }, { signal: () => 'denied' }).held,
      false,
    );
  });

  it('leaves the ordinary answers where they were', () => {
    const fresh = { pid: 4242, kind: 'desktop', uid: 501, startedAt: at('2026-08-09T11:00:00Z') };
    assert.equal(state(fresh, { signal: () => 'alive' }).held, true);
    assert.equal(state(fresh, { signal: () => 'gone' }).held, false);
    assert.equal(state({ pid: 0 }, { signal: () => 'alive' }).held, false);
    assert.equal(state(null, { signal: () => 'alive' }).held, false);
  });

  it('does not call a clock that moved a reason to reclaim', () => {
    // NTP stepped the clock forward, so the lock looks like it was taken in the
    // future. That is not evidence of anything; the signal decides.
    const record = { pid: 4242, kind: 'desktop', uid: 501, startedAt: at('2027-01-01T00:00:00Z') };
    assert.equal(state(record, { signal: () => 'alive' }).held, true);
    // And a lock a few minutes either side of the boot instant is left alone.
    const borderline = { pid: 4242, kind: 'desktop', uid: 501, startedAt: at('2026-08-09T08:58:00Z') };
    assert.equal(state(borderline, { signal: () => 'alive' }).held, true);
  });
});

/* ------------------------------------------------------------------ *
 * A lock that cannot be taken must not stop Zelos
 * ------------------------------------------------------------------ */

/**
 * A data home on a filesystem with no hard links — an external drive formatted
 * FAT32, a USB stick, a Windows share — answered `ENOTSUP` from `link(2)`, and
 * that error came straight out of `startCore`. Zelos could not be run at all,
 * on account of a lock it does not need to run.
 */
describe('a home on a filesystem that cannot do the lock', () => {
  let dir;
  before(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-nolink-'))); });
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  /**
   * Make the named fs calls fail for the lock file only, the way FAT32 does.
   * The patch is on the `fs` object runtime.js holds, so only its own explicit
   * calls see it — Node's internals reach their own bindings — and it stands
   * until the body settles, promise or not.
   */
  function withoutLinking(names, body) {
    const real = new Map(names.map((name) => [name, fs[name]]));
    const restore = () => { for (const [name, fn] of real) fs[name] = fn; };
    for (const name of names) {
      fs[name] = (...args) => {
        const target = String(name === 'linkSync' ? args[1] : args[0]);
        if (!target.endsWith('zelos.lock')) return real.get(name).apply(fs, args);
        const err = new Error(`ENOTSUP: operation not supported, ${name.replace('Sync', '')} '${target}'`);
        err.code = 'ENOTSUP';
        throw err;
      };
    }
    let out;
    try {
      out = body();
    } catch (err) {
      restore();
      throw err;
    }
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  }

  it('falls back to an exclusive create, which is still a lock', () => {
    const home = path.join(dir, 'fallback');
    const held = withoutLinking(['linkSync'], () => acquireHomeLock({ home, kind: 'desktop' }));
    try {
      assert.equal(held.degraded, null, 'O_EXCL works here, so the lock is real');
      assert.equal(readHomeLock(home).pid, process.pid);
      const next = acquireHomeLock({ home, kind: 'cli' });
      assert.ok(next.contested, 'a lock taken by O_EXCL still has to be seen by the next process');
      next.release();
    } finally {
      held.release();
    }
  });

  it('runs unlocked, and says so, when nothing exclusive is available', () => {
    const home = path.join(dir, 'unlocked');
    const held = withoutLinking(['linkSync', 'openSync'], () => acquireHomeLock({ home, kind: 'desktop' }));
    assert.ok(held.degraded, 'a lock that was never taken must not be reported as taken');
    assert.equal(held.degraded.code, 'ENOTSUP');
    assert.equal(fs.existsSync(path.join(home, 'zelos.lock')), false);
    // The handle still has to behave like one, since nothing else knows.
    held.setPort(4444);
    assert.equal(held.record.port, 4444);
    held.release();
  });

  it('boots the whole core there rather than refusing to start', async () => {
    const home = path.join(dir, 'boots');
    const previousHome = process.env.ZELOS_HOME;
    const previousSecrets = process.env.ZELOS_SECRETS_BACKEND;
    // The core's secrets backend shells out to the real login keychain on an
    // unforced macOS run; this stays inside its sandbox.
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
    try {
      const outcome = await withoutLinking(['linkSync', 'openSync'], () =>
        startCore({ root: REPO, home, port: 0 }).then((handle) => ({ handle }), (error) => ({ error })));
      assert.equal(outcome.error, undefined, `a home with no hard links stopped Zelos: ${outcome.error?.message}`);
      assert.ok(outcome.handle.port > 0, 'nothing bound');
      assert.ok(fs.existsSync(path.join(home, 'zelos.db')), 'the database was never opened');
      await outcome.handle.stop();
    } finally {
      if (previousHome === undefined) delete process.env.ZELOS_HOME;
      else process.env.ZELOS_HOME = previousHome;
      if (previousSecrets === undefined) delete process.env.ZELOS_SECRETS_BACKEND;
      else process.env.ZELOS_SECRETS_BACKEND = previousSecrets;
    }
  });

  it('lets a real reused pid go, rather than refusing forever', () => {
    // pid 1 is init/launchd: owned by root, certainly running, certainly not
    // Zelos. Before this, kill(1, 0) answering EPERM read as "alive" and the
    // refusal it produced could not be cleared by quitting anything.
    const home = path.join(dir, 'pid1');
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'zelos.lock');

    fs.writeFileSync(file, JSON.stringify({
      pid: 1, kind: 'desktop', port: 7777, uid: process.getuid?.() ?? null,
      startedAt: new Date(Date.now() - 400 * 24 * 60 * 60_000).toISOString(),
    }));
    const afterReboot = acquireHomeLock({ home, kind: 'desktop' });
    assert.equal(readHomeLock(home).pid, process.pid, 'a lock older than the boot still locked the user out');
    afterReboot.release();

    // And the same thing without the reboot to settle it: the record says this
    // user wrote it, so a pid this user may not signal is not this user's Zelos.
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      fs.writeFileSync(file, JSON.stringify({
        pid: 1, kind: 'cli', port: null, uid: process.getuid(), startedAt: new Date().toISOString(),
      }));
      const afterReuse = acquireHomeLock({ home, kind: 'desktop' });
      assert.equal(readHomeLock(home).pid, process.pid, 'a recycled pid still held the home');
      afterReuse.release();
    }
  });

  it('always says how to clear a lock it warns about', () => {
    // The warning is a guess about another process, so the way out of a wrong
    // guess has to be in the warning itself — naming the file, by full path.
    const home = path.join(dir, 'wayout');
    const lockFile = path.join(home, 'zelos.lock');
    const held = acquireHomeLock({ home, kind: 'desktop' });
    try {
      const next = acquireHomeLock({ home, kind: 'cli' });
      assert.ok(next.contested);
      // Compared literally, not as a pattern. This used to build a RegExp out
      // of the path and escape only the dots, which is fine as long as the
      // separator is `/` — on Windows the path is `C:\Users\…\zelos.lock` and
      // every separator is a regex escape, so `\U` and `\z` compiled into
      // something that could not match the path they came from. The assertion
      // is about a literal string appearing in a sentence; `includes` is what
      // that means, and it holds identically on all three platforms.
      assert.ok(
        next.contested.message.includes(`delete ${lockFile}`),
        `the warning must name the file to delete, in full: ${next.contested.message}`,
      );
      assert.equal(next.contested.lockFile, lockFile);
      next.release();
    } finally {
      held.release();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Closing, and crashing
 * ------------------------------------------------------------------ */

describe('what closing the window means', () => {
  let shouldStayResidentOnClose;
  before(async () => {
    ({ shouldStayResidentOnClose } = await import(pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href));
  });

  it('hides to the tray only when there is a tray to hide to', () => {
    // The one that mattered: a Linux desktop with no system tray, auto-sweep
    // on, and a close handler that hid the window anyway — leaving an app with
    // no window, no tray icon and no way back to either.
    assert.equal(shouldStayResidentOnClose({ platform: 'linux', hasTray: false, autoSweep: true }), false);
    assert.equal(shouldStayResidentOnClose({ platform: 'win32', hasTray: false, autoSweep: true }), false);

    assert.equal(shouldStayResidentOnClose({ platform: 'win32', hasTray: true, autoSweep: true }), true);
    // A tray with nothing to sweep is still not a reason to outlive the window.
    assert.equal(shouldStayResidentOnClose({ platform: 'win32', hasTray: true, autoSweep: false }), false);
  });

  it('does not believe a Linux tray it cannot see', () => {
    // The case the old check claimed to cover and did not: GNOME without an
    // AppIndicator extension. `new Tray()` does not fail there — it publishes a
    // StatusNotifierItem that nothing displays — so a non-null tray was never
    // evidence, and hiding the window on that evidence hid it into nowhere.
    assert.equal(shouldStayResidentOnClose({ platform: 'linux', hasTray: true, autoSweep: true }), false);
    // Only the person looking at the panel can settle it, so only they can.
    assert.equal(
      shouldStayResidentOnClose({ platform: 'linux', hasTray: true, autoSweep: true, trayConfirmed: true }),
      true,
    );
    // And saying the tray works is not a reason to outlive the window on its own.
    assert.equal(
      shouldStayResidentOnClose({ platform: 'linux', hasTray: false, autoSweep: true, trayConfirmed: true }),
      false,
    );
  });

  it('leaves macOS alone: an app there outlives its windows, tray or no tray', () => {
    assert.equal(shouldStayResidentOnClose({ platform: 'darwin', hasTray: false, autoSweep: false }), true);
    assert.equal(shouldStayResidentOnClose({ platform: 'darwin', hasTray: true, autoSweep: true }), true);
  });
});

describe('planRendererRestart', () => {
  let planRendererRestart;
  before(async () => {
    ({ planRendererRestart } = await import(pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href));
  });

  it('reloads the first three crashes, further apart each time, then stops', () => {
    const now = 1_000_000;
    const at = (n) => Array.from({ length: n }, (_, i) => now - (n - 1 - i));

    const delays = [1, 2, 3].map((n) => planRendererRestart(at(n), now));
    assert.deepEqual(delays.map((plan) => plan.action), ['reload', 'reload', 'reload']);
    assert.ok(delays[0].delayMs === 0, 'the first crash should come back at once');
    assert.ok(delays[1].delayMs > delays[0].delayMs, 'the second attempt does not back off');
    assert.ok(delays[2].delayMs > delays[1].delayMs, 'the third attempt does not back off');

    // Four in a minute is a loop, and a loop gets a message rather than a
    // fourth reload nobody sees.
    for (const n of [4, 5, 40]) {
      assert.equal(planRendererRestart(at(n), now).action, 'explain', `${n} crashes`);
    }
  });

  it('forgets crashes that are old news', () => {
    const now = 1_000_000;
    const longAgo = [now - 600_000, now - 500_000, now - 400_000];
    const plan = planRendererRestart([...longAgo, now], now);
    assert.equal(plan.action, 'reload');
    assert.equal(plan.attempt, 1, 'crashes from ten minutes ago are not this crash');
  });
});

/* ------------------------------------------------------------------ *
 * The shell as a stdio MCP server
 *
 * The "Ready to paste" block in Settings names the packaged binary plus the
 * one word `mcp` (core/server.mjs mcpClientHints), because the build ships no
 * zelos.mjs for a client to spawn. That block is only true if the shell
 * actually serves JSON-RPC on stdio when spawned that way — this is the other
 * end of that contract, run with the streams a real client would own.
 * ------------------------------------------------------------------ */

describe('the shell as a stdio MCP server', () => {
  let main;
  let sandbox;

  before(async () => {
    // The electron stub hooks are registered by the shell suite above; the
    // module comes back from cache with them in place.
    main = await import(pathToFileURL(path.join(REPO, 'desktop', 'main.js')).href);
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-shell-mcp-')));
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file'; // never the real keychain
  });

  after(() => {
    delete process.env.ZELOS_HOME; // serveMcp set it from --home
    delete process.env.ZELOS_SECRETS_BACKEND;
    try {
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (err) {
      if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
    }
  });

  it('answers the handshake on the streams it is handed, and stdout stays pure JSON-RPC', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => { written += chunk; });

    const flags = main.parseShellArgs(['mcp', `--home=${path.join(sandbox, 'home')}`]);
    const serving = main.serveMcp(flags, { input, output });

    input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test client', version: '0' } },
    })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    input.end(); // the client hanging up is what ends the server

    const result = await serving;
    assert.equal(result.ok, true, result.error?.stack);

    // Rule 3 from zelos.mjs holds here too: every stdout line is a JSON-RPC
    // message, because one stray banner corrupts the stream.
    const lines = written.split('\n').filter((line) => line.trim());
    const replies = lines.map((line) => JSON.parse(line));
    assert.equal(replies.length, 2);
    assert.equal(replies[0].result.serverInfo.name, 'zelos');
    // A fresh home has AI access off, so the tool list is empty — proof the
    // server read its config from the home the flags named.
    assert.deepEqual(replies[1].result.tools, []);
  });
});
