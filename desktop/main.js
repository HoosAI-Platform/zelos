/**
 * desktop/main.js — the Electron shell.
 *
 * A window, a tray icon, a menu bar, and the Zelos core running in this same
 * process. That last part is the design: `runtime.js` imports `createServer`
 * and calls it here rather than forking `zelos.mjs` as a child, so there is
 * one process, one sqlite handle, one lifecycle, and no pipe between the tray
 * and the thing the tray is driving.
 *
 * What the shell is careful about:
 *
 *   - The window is pointed at the local board and nothing else. `guard.js`
 *     classifies every navigation and every window-open; anything that is not
 *     this server's own origin either goes to the system browser or is refused
 *     outright. Mail is attacker-controlled, and a link in it must never be
 *     able to load inside a window that holds the session token.
 *   - The renderer has no privileges: context isolation on, node integration
 *     off, sandbox on, `<webview>` off, and a preload that exposes four strings
 *     and one function — "show the Zelos folder", answered only for the
 *     board's own window and carrying nothing the page chose.
 *   - The session cancels every outbound request that is not the board itself —
 *     on every scheme Chromium will put on the network, WebSockets included,
 *     and not only the http(s) a scheme wildcard would have shown it. WebRTC,
 *     which never becomes a request at all, is blocked in the board's CSP and
 *     stripped of UDP underneath that. The session also denies every
 *     permission but the one the Owed view's copy buttons use.
 *     Spellcheck is off because Chromium fetches its dictionaries from Google,
 *     and this app does not talk to anyone the user did not configure.
 *   - Nothing here assumes it succeeded. There may be no tray icon, so closing
 *     the window may have nowhere to hide to; the renderer may die repeatedly,
 *     so a reload is rationed rather than automatic; and another Zelos may
 *     already hold the data home, which the shell reports instead of quietly
 *     becoming the second scheduler sweeping one database.
 *
 * `ready` is exported so the shell can be booted and inspected without a
 * packaged build; it resolves rather than rejects, because a shell that throws
 * on start would leave the user with no window and no message.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell,
} from 'electron';

import { classifyTarget, guardWebContents } from './guard.js';
import { buildAppMenuTemplate, buildTrayMenuTemplate, VIEWS } from './menus.js';
import { startCore } from './runtime.js';
import {
  createUpdater, macAppCopier, macBundleInfoReader, macOtherInstances, macReplaceCheck, macSwapLauncher, macZipExtractor,
  PENDING_DIR, publicKeyFrom, windowsInstallerLauncher, windowsReplaceCheck, windowsSignatureVerifier,
} from './updater.js';
import { clampToDisplays, WindowState } from './window-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where `core/`, `ui/` and `assets/` live. In development they are one level up
 * from this file. In a build they are copied into `Contents/Resources` (see
 * `extraResources` in package.json) — outside the asar, so the core is loaded
 * by the plain ESM loader from plain files, exactly as it is in development.
 */
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(HERE, '..');

const APP_NAME = 'Zelos';

/**
 * The commit this build was cut from, read off the package.json beside this
 * file. CI writes it there at packaging time (`-c.extraMetadata.commit=` in
 * .github/workflows/desktop.yml), because three builds that all said
 * "Zelos 1.0.0" in About and shared a filename were three builds nobody could
 * tell apart — and the one the operator ran for a day predated every fix.
 * A source checkout carries no stamp and a build made by hand may not either;
 * that reads as the plain version, never as an error, so the shell starts the
 * same way with or without it. Anything that is not a sha is treated as no
 * stamp rather than shown.
 */
export function readBuildCommit(dir) {
  try {
    const { commit } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof commit === 'string' && /^[0-9a-f]{7,40}$/i.test(commit.trim()) ? commit.trim() : '';
  } catch {
    return '';
  }
}

/**
 * "1.1.0 (a1b2c3d)" when stamped, "1.1.0" when not. CI stamps the whole sha —
 * a short one that happens to be all digits is a number by the time
 * electron-builder's argument parser has seen it — and seven characters is
 * what a person holds up against `git log`.
 */
export function versionLabel(version, commit = '') {
  return commit ? `${version} (${commit.slice(0, 7)})` : String(version);
}

const BUILD_COMMIT = readBuildCommit(HERE);

/**
 * How this build recognises a genuine update, from the `updates` block of the
 * package.json beside this file: the Zelos update keys (Ed25519 public keys,
 * base64url — scripts/generate-update-key.mjs prints one), and optionally the
 * Windows publisher an installer's Authenticode signature must also name. No
 * valid key means the build does not update itself — see desktop/updater.js.
 * Anything malformed is dropped rather than trusted.
 */
export function readUpdateConfig(dir) {
  try {
    const { updates } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const keys = Array.isArray(updates?.publicKeys) ? updates.publicKeys : [];
    const publisher = typeof updates?.windowsPublisher === 'string' ? updates.windowsPublisher.trim() : '';
    return {
      publicKeys: keys.filter((key) => publicKeyFrom(key) !== null),
      windowsPublisher: /^[^\0-\x1f"=]{1,200}$/.test(publisher) ? publisher : '',
    };
  } catch {
    return { publicKeys: [], windowsPublisher: '' };
  }
}

/** ui/app.css: marble ground and black-figure ground. Kills the white flash. */
const GROUND = { light: '#F4EFE6', dark: '#12100E' };
/** The one permission the board needs: the Owed view copies drafts. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/**
 * How long a renderer crash is remembered, and how long the shell waits before
 * each restart. A renderer that dies once is a glitch and reloading it instantly
 * is the right answer; one that dies on every load is a bug, and the fourth
 * silent reload inside a minute only hides the message. Three attempts, then a
 * dialog that says what happened and where to look.
 */
const CRASH_WINDOW_MS = 60_000;
const CRASH_RELOAD_DELAYS_MS = Object.freeze([0, 750, 3_000]);

let zelos = null;      // the running core (runtime.js handle)
let mainWindow = null;
let tray = null;
let actions = null;
let windowState = null;
let quitting = false;
let shuttingDown = null;
let leaving = null;
let leaveAction = null;
let maintenanceActive = false;
let updater = null;
let installAfterShutdown = false;
let crashes = [];      // timestamps of recent render-process-gone events
let crashTimer = null;

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

/**
 * The same three flags the CLI has, plus its one subcommand: `mcp`, the bare
 * word the "Ready to paste" block in Settings spawns this binary with (see
 * serveMcp). Unknown arguments are ignored rather than rejected: Chromium adds
 * its own switches, macOS appends `-psn_…` when an app is launched from
 * Finder, and neither is an error.
 */
export function parseShellArgs(argv = []) {
  const flags = { home: null, port: null, sweepNow: false, mcp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'mcp') { flags.mcp = true; continue; }
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const value = () => (inline === null ? argv[++i] ?? '' : inline);

    switch (name) {
      case '--home': {
        // Reject the literal strings "undefined" and "null" alongside the
        // empty value: they are what a wrapper script produces when it
        // interpolates an unset variable into `--home=${dir}`, and passing
        // them through once created a real data directory named `undefined/`.
        const dir = value();
        const junk = dir.trim().toLowerCase();
        if (dir && junk !== 'undefined' && junk !== 'null') flags.home = dir;
        break;
      }
      case '--port': {
        const raw = value();
        // 0 means "any free port" — how the tests avoid colliding with a
        // Zelos the user is actually running. An empty value is not a zero.
        const port = raw === '' ? NaN : Number(raw);
        if (Number.isInteger(port) && port >= 0 && port <= 65535) flags.port = port;
        break;
      }
      case '--sweep-now':
        flags.sweepNow = true;
        break;
      default:
        break;
    }
  }
  return flags;
}

function portFromEnv() {
  const raw = process.env.ZELOS_PORT;
  if (raw === undefined || raw === '') return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

const currentConfig = () => zelos?.server?.zelos?.config ?? zelos?.config ?? null;

/**
 * Whether closing the window should leave Zelos running.
 *
 * macOS: always — an app there outlives its windows, quitting is ⌘Q, and the
 * dock icon is the way back in whether or not a tray icon was ever created.
 * Windows: when Zelos sweeps on a schedule and a tray icon was made. There a
 * `Tray` is a `Shell_NotifyIcon` that the shell itself owns; it may end up in
 * the overflow flyout, but it exists and it can be clicked.
 *
 * Linux is the one this function is careful about, and the reason it takes a
 * fourth argument. A `Tray` there is a StatusNotifierItem published on the
 * session bus, and publishing succeeds whether or not anything is watching:
 * GNOME without an AppIndicator extension, a bare tiling WM, a session where
 * the panel died — `new Tray()` returns an object in every one of them and
 * throws in none. So `tray !== null` is not evidence that a tray exists, and
 * treating it as evidence is what once hid the window into nowhere, leaving an
 * app with no window, no icon and no way back short of killing it. Nothing
 * Electron exposes can prove the icon is on screen, so the honest answer is
 * that on Linux this cannot be detected: closing the window closes the app
 * unless the person running it has said out loud that their tray works, with
 * `ZELOS_TRAY_RESIDENT=1`. Losing a background sweep is recoverable in one
 * click; losing the way back into the app is not.
 */
export function shouldStayResidentOnClose({
  platform = process.platform, hasTray = false, autoSweep = false, trayConfirmed = false,
} = {}) {
  if (platform === 'darwin') return true;
  if (!hasTray || autoSweep !== true) return false;
  if (platform === 'linux') return trayConfirmed === true;
  return true;
}

function staysResidentOnClose() {
  return shouldStayResidentOnClose({
    platform: process.platform,
    hasTray: tray !== null,
    autoSweep: currentConfig()?.sweep?.auto === true,
    trayConfirmed: process.env.ZELOS_TRAY_RESIDENT === '1',
  });
}

/**
 * What to do about a renderer that just died, given when the previous ones did.
 * Pure, and exported, because the interesting case — the fourth crash in a
 * minute — is one nobody wants to reproduce by hand.
 */
export function planRendererRestart(history = [], now = Date.now()) {
  const recent = history.filter((at) => Number.isFinite(at) && now - at < CRASH_WINDOW_MS);
  const attempt = recent.length; // this crash included; the caller records it first
  if (attempt < 1 || attempt > CRASH_RELOAD_DELAYS_MS.length) {
    return { action: 'explain', attempt, delayMs: 0 };
  }
  return { action: 'reload', attempt, delayMs: CRASH_RELOAD_DELAYS_MS[attempt - 1] };
}

/**
 * The count of things asking for something now, on the dock or taskbar icon.
 *
 * `setBadgeCount` is macOS and Linux-with-Unity; Windows has no equivalent that
 * does not involve shipping a second icon, and a platform without a badge is
 * not a failure — the board still says the same number. So this degrades to
 * nothing, quietly, everywhere it is not supported.
 */
function setBadge(count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  try {
    if (typeof app.setBadgeCount === 'function') app.setBadgeCount(n);
    else if (process.platform === 'darwin' && typeof app.dock?.setBadge === 'function') {
      app.dock.setBadge(n > 0 ? String(n) : '');
    }
  } catch (err) {
    zelos?.logger.info('desktop: this desktop has no badge to set', { error: err.message });
  }
}

function createWindow() {
  windowState = new WindowState({ file: path.join(zelos.paths.home, 'window.json') });
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);

  const win = new BrowserWindow({
    ...windowState.initial(workAreas),
    show: false, // shown on ready-to-show, so the first paint is the board
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light,
    // Linux takes its window icon from the process, not the desktop file.
    ...(process.platform === 'linux' ? { icon: path.join(ROOT, 'assets', 'icon.png') } : {}),
    webPreferences: {
      preload: path.join(HERE, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // Chromium downloads hunspell dictionaries from a Google host the first
      // time spellcheck runs. Nothing leaves this machine that the user did not
      // configure, so spellcheck is off.
      spellcheck: false,
    },
  });

  windowState.track(win);
  if (windowState.maximized) win.maximize();
  if (windowState.fullScreen) win.setFullScreen(true);

  win.once('ready-to-show', () => win.show());

  // Looking at the board is what "I have seen these" means, so the badge is
  // cleared by the window coming forward and not by any button in it.
  win.on('focus', () => setBadge(0));
  win.on('show', () => setBadge(0));

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (staysResidentOnClose()) win.hide();
    else leaveBoard(() => { quitting = true; app.quit(); }, { quit: true });
  });
  win.on('closed', () => { mainWindow = null; });

  /* There is deliberately no "the load finished, so forget the crashes" hook
     here. It reads as common sense and it is a trap: the commonest repeating
     crash — a renderer running out of memory on a very long board — happens
     AFTER a load finishes, so clearing the record there resets the attempt
     count on every lap and the reload loop runs forever at zero delay, which is
     the exact outcome the counter exists to stop. Unrelated crashes hours apart
     are already handled, by the sliding CRASH_WINDOW_MS filter below: a crash
     older than a minute is not counted at all. */

  // A renderer that died takes the board with it; reloading the URL we hold
  // brings it back with its token, which a plain reload would not. But a crash
  // that repeats is a crash that will repeat, and an unconditional reload turns
  // it into a loop the user watches forever without ever being told anything.
  win.webContents.on('render-process-gone', (_event, details) => {
    zelos?.logger.error('desktop: the board renderer stopped', { reason: details?.reason });
    if (quitting || win.isDestroyed()) return;

    const now = Date.now();
    crashes = [...crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    const plan = planRendererRestart(crashes, now);

    // At most one restart is ever pending. A crash that arrives while the last
    // one is still waiting supersedes it — two timers would reload twice for a
    // window that only died once, which is the loop this exists to prevent.
    if (crashTimer) {
      clearTimeout(crashTimer);
      crashTimer = null;
    }

    if (plan.action === 'explain') {
      zelos?.logger.error('desktop: giving up on reloading the board', { attempts: plan.attempt });
      dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} — the board keeps stopping`,
        message: 'The board window has stopped several times in a row.',
        detail: [
          `Zelos reloaded it ${CRASH_RELOAD_DELAYS_MS.length} times and it stopped again each time, so it has`,
          'stopped trying rather than loop.',
          '',
          'The sweeps are still running: the button below opens the board in your',
          'web browser, and the tray menu still sweeps.',
          '',
          `Reason given: ${details?.reason ?? 'unknown'}`,
          `Logs: ${zelos?.paths.logsDir ?? ''}`,
          '',
          'Board ▸ Reload board tries again.',
        ].join('\n'),
        buttons: ['OK', 'Open in your web browser'],
      }).then(({ response }) => {
        // The same action as the Board menu, and minted only now: a handoff
        // lives ten seconds, and this dialog can sit unread for an afternoon.
        if (response === 1) actions?.openInBrowser?.();
      });
      return;
    }

    const reload = () => {
      crashTimer = null;
      if (quitting || win.isDestroyed() || !zelos) return;
      win.loadURL(zelos.tokenUrl);
    };
    if (plan.delayMs === 0) {
      reload();
      return;
    }
    crashTimer = setTimeout(reload, plan.delayMs);
    crashTimer.unref?.();
  });

  win.loadURL(zelos.tokenUrl);
  mainWindow = win;
  return win;
}

/**
 * Put a window back on a display that exists, before anyone is shown it.
 *
 * `WindowState.initial()` clamps the remembered rectangle, and for a long time
 * that was the only place it happened — which covers a window that is created
 * and then lives until the app ends. A tray-resident Zelos is not that one:
 * `close` hides the window instead of destroying it (see
 * `shouldStayResidentOnClose` — Windows with a tray, or Linux with
 * `ZELOS_TRAY_RESIDENT=1`), so it can sit hidden for hours holding a rectangle
 * on a monitor that gets unplugged in the meantime. `show()` honours that
 * rectangle exactly, and the board reappears at x:2600 on a machine whose only
 * work area now ends at 1680 — the failure `window-state.js:6-11` exists to
 * prevent, one `show()` away from the clamp that prevents it.
 *
 * macOS is not the platform this is written for: Electron does not set
 * `enableLargerThanScreen`, so AppKit constrains the frame onto a real screen
 * on `makeKeyAndOrderFront:` whether or not anybody asked. There the clamp
 * agrees with what the OS was going to do anyway, which is exactly why nothing
 * is set when the rectangle comes back unchanged — this must not turn into a
 * move event on every ⌘Tab back into an app that was never lost.
 */
function fitToDisplays(win) {
  // A maximised or full-screen window is wearing the OS's rectangle, not ours.
  // Setting bounds under one is how a window nobody asked to restore gets
  // restored, and the size to keep is already saved by WindowState.
  if (win.isMaximized?.() === true || win.isFullScreen?.() === true) return;
  const bounds = win.getNormalBounds?.() ?? win.getBounds?.();
  if (!bounds) return;

  const fitted = clampToDisplays(bounds, screen.getAllDisplays().map((display) => display.workArea));
  if (typeof fitted.x !== 'number') {
    // Nothing that exists overlaps it any more, so there is no corrected
    // position to move to — only a screen to start over on. Same answer
    // `initial()` gives by returning a size with no position and letting the
    // window manager place it.
    zelos?.logger.info('desktop: the window was on a display that is gone; centring it', { bounds });
    win.center?.();
    return;
  }
  if (fitted.x === bounds.x && fitted.y === bounds.y
      && fitted.width === bounds.width && fitted.height === bounds.height) return;
  zelos?.logger.info('desktop: pulled the window back onto a display that exists', { from: bounds, to: fitted });
  win.setBounds?.(fitted);
}

function showWindow() {
  setBadge(0);
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (zelos) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) {
    fitToDisplays(mainWindow); // it may have been hidden on a monitor that left
    mainWindow.show();
  }
  mainWindow.focus();
}

/**
 * Switch the board to one of its views. The id is checked against a fixed list
 * before it is put in a string — nothing here is ever derived from a message, a
 * calendar event or model output, and the allowlist is what makes that provable
 * at a glance.
 */
function showView(id) {
  if (!VIEWS.some((view) => view.id === id)) return;
  showWindow();
  const navigate = `window.location.hash = ${JSON.stringify(`#/${id}`)};`;
  const script = id === 'search'
    ? `if (window.location.hash === '#/search') { document.querySelector('.search-field')?.focus({ preventScroll: true }); } else { ${navigate} }`
    : navigate;
  mainWindow?.webContents
    .executeJavaScript(script)
    .catch((err) => zelos?.logger.warn('desktop: could not switch view', { view: id, error: err.message }));
}

/* ------------------------------------------------------------------ *
 * Session hardening
 * ------------------------------------------------------------------ */

function hardenSession(ses) {
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    const granted = ALLOWED_PERMISSIONS.has(permission);
    if (!granted) zelos?.logger.warn('desktop: denied a permission request', { permission });
    callback(granted);
  });
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));

  // The renderer's CSP already says `default-src 'self'`. This is the same rule
  // enforced a second time, one layer down, where a CSP bypass would not reach:
  // no request leaves this window for anywhere but the board. (What is not a
  // request at all — WebRTC — cannot be cancelled here; it is dealt with below.)
  //
  // The pattern is `<all_urls>` and not the `*://*/*` that reads like it means
  // the same thing. It does not: `*` in a match pattern's scheme position is
  // http and https and nothing else, so a `new WebSocket('wss://…')` sailed
  // straight past the layer this comment sells as the one a CSP bypass cannot
  // reach. Measured against the pinned Electron 43.3.0 with five requests on
  // five schemes: `*://*/*` delivered three, `<all_urls>` delivered five, and
  // the two it had been missing were `ws:` and `wss:`. (`file:`, `data:` and
  // `blob:` are not part of that difference — Chromium refuses those in the
  // renderer before they ever become network requests.)
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const verdict = classifyTarget(details.url, { port: zelos?.port ?? 0 });
    if (verdict.action !== 'internal') {
      zelos?.logger.warn('desktop: cancelled an outbound request from the board', { url: verdict.url });
    }
    callback({ cancel: verdict.action !== 'internal' });
  });

  // The one channel Chromium will put on the network that is NOT a request:
  // WebRTC. ICE, STUN/TURN and data channels never enter the pipeline above on
  // any pattern, and `connect-src 'self'` does not govern them either — so a
  // script in the board's origin could hand data to `turn:attacker.example` as
  // an ICE credential with neither layer firing. So the board's responses gain
  // a second CSP that does govern it: `webrtc 'block'` shuts the whole API's
  // network path off in the renderer, and a policy carrying only that
  // directive can loosen nothing beside it. (Appended by the shell rather than
  // baked into the server's headers because the promise being kept — nothing
  // leaves this window — is the shell's own.) The layer underneath it, for a
  // page that has somehow shed its CSP, is the IP-handling policy set on every
  // webContents in bootstrap.
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    const key = Object.keys(responseHeaders).find((name) => name.toLowerCase() === 'content-security-policy')
      ?? 'Content-Security-Policy';
    responseHeaders[key] = [...(responseHeaders[key] ?? []), "webrtc 'block'"];
    callback({ responseHeaders });
  });
}

/* ------------------------------------------------------------------ *
 * Tray and menus
 * ------------------------------------------------------------------ */

function trayImage() {
  // macOS wants a monochrome mask it can invert with the menu bar; everyone
  // else wants the coloured mark. Electron picks up the @2x file on its own.
  const file = path.join(HERE, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
  const image = nativeImage.createFromPath(file);
  if (process.platform === 'darwin' && !image.isEmpty()) image.setTemplateImage(true);
  return image;
}

function createTray(actions) {
  try {
    const image = trayImage();
    if (image.isEmpty()) throw new Error(`tray icon missing or unreadable`);
    tray = new Tray(image);
    tray.setToolTip(`${APP_NAME} — ${zelos.url}`);
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({ actions, update: updater?.state() })));
    // On Windows and Linux a left click is how people expect to reopen a
    // tray app; on macOS a click opens the menu, so this is not wired there.
    if (process.platform !== 'darwin') tray.on('click', () => actions.openBoard());
  } catch (err) {
    tray = null;
    zelos?.logger.warn('desktop: no tray icon; use the window and the menu bar', { error: err.message });
  }
  return tray;
}

function openLocalPath(target) {
  shell.openPath(target).then((problem) => {
    if (problem) zelos?.logger.warn('desktop: could not open a local path', { target, problem });
  });
}

/**
 * The one request the page can make of the shell: show the Zelos folder.
 *
 * Settings → Your data tells a person to erase everything by dragging the
 * folder to the Trash, and a sentence that says "this folder" has to be able
 * to put it on screen — `rm -rf` in a code block was the previous answer,
 * and the audit's reader would not type it. The channel takes no argument
 * and reveals only the shell's own data home; the page cannot name a path.
 * Answered only for the board's own window, because the preload is attached
 * to that window alone and any other sender is by definition not the board.
 * `showItemInFolder` selects the folder in its parent rather than opening it,
 * which is the view a person drags from.
 */
export const SHOW_HOME_CHANNEL = 'zelos:show-home';

export function showHomeHandler({ getHome, isBoard, reveal }) {
  return (event) => {
    if (!isBoard(event?.sender)) return false;
    const home = getHome();
    if (!home) return false;
    reveal(home);
    return true;
  };
}

function installShowHome() {
  ipcMain.handle(SHOW_HOME_CHANNEL, showHomeHandler({
    getHome: () => zelos?.paths.home ?? '',
    isBoard: (sender) => Boolean(sender) && Boolean(mainWindow) && !mainWindow.isDestroyed() && sender === mainWindow.webContents,
    reveal: (home) => shell.showItemInFolder(home),
  }));
}

export const CREATE_BACKUP_CHANNEL = 'zelos:create-backup';
export const RESTORE_BACKUP_CHANNEL = 'zelos:restore-backup';

/** Only fixed native actions, never a renderer-supplied path or option. The
 * dependency boundary also lets tests exercise cancellation and failure without
 * opening an OS dialog or loading any real user data.
 */
export function backupHandlers({ isBoard, getCore, getWindow, dialogs, flush, appVersion, restart, setBusy = () => {} }) {
  let busy = false;
  const safeError = (err) => {
    if (err?.code === 'ZELOS_DATA_BUSY' || err?.code === 'ZELOS_RESTORE_PENDING' || err?.message?.startsWith('Backup: ')) return err.message;
    return 'Zelos could not finish this operation. Check that other Zelos and AI clients are closed, finish any active request, and try again. Your recovery copies are kept in the data folder’s backups folder.';
  };
  const run = (restore) => async (event, ...args) => {
    // Frame identity matters: an embedded or navigated frame must not inherit
    // a filesystem action merely because it lives in the same webContents.
    if (args.length || !isBoard(event)) return { ok: false, error: 'This action is only available in the Zelos desktop board.' };
    if (busy) return { ok: false, error: 'A backup or restore is already in progress.' };
    const core = getCore();
    const win = getWindow();
    if (!core || !win || win.isDestroyed()) return { ok: false, error: 'The Zelos board is not ready.' };
    busy = true; setBusy(true);
    let staged;
    let success = false;
    let disabled = false;
    try {
      const selected = restore
        ? await dialogs.showOpenDialog(win, { title: 'Restore a Zelos backup', properties: ['openFile'], filters: [{ name: 'Zelos backup', extensions: ['zelos-backup'] }] })
        : await dialogs.showSaveDialog(win, { title: 'Create a Zelos backup', defaultPath: `Zelos-${new Date().toISOString().slice(0, 10)}.zelos-backup`, filters: [{ name: 'Zelos backup', extensions: ['zelos-backup'] }], message: 'This file contains private archive data and may include credentials. Keep it in a safe location.' });
      const selectedPath = restore ? selected.filePaths?.[0] : selected.filePath;
      if (selected.canceled || !selectedPath) return { ok: false, cancelled: true };
      win.setEnabled?.(false);
      disabled = true;
      if (restore) {
        staged = await core.stageBackup(selectedPath);
        const info = staged.manifest;
        const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
        const choice = await dialogs.showMessageBox(win, {
          type: 'warning', title: 'Restore this backup?', message: 'Replace the current Zelos data?',
          detail: [
            `Backup date: ${new Date(info.createdAt).toLocaleString()}`,
            `Created by Zelos ${info.appVersion}`,
            `${count(info.counts.messages, 'archived message')} · ${count(info.counts.events, 'event')} · ${count(info.counts.items, 'board item')}`,
            `${count(info.counts.drafts, 'draft')} · ${count(info.counts.captures, 'note')} · ${count(info.counts.runs, 'run')} · ${count(info.counts.item_history, 'history revision')}`,
            '',
            'Your current data will be replaced. Zelos will first keep a private recovery copy in the data folder’s backups folder, then reopen.',
            info.credentials === 'encrypted-file-included'
              ? 'This backup includes the local encrypted credential file and its key. Treat the backup like a password. Credentials held in an operating-system keychain may still need reconnecting.'
              : 'Operating-system keychain credentials are not portable. You may need to reconnect mail, calendars, task sources, and your model after restoring.',
            'Restore only a backup you trust. Local calendar files outside the Zelos folder must be copied separately.',
          ].join('\n'),
          buttons: ['Cancel', 'Restore and reopen'], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (choice.response !== 1) return { ok: false, cancelled: true };
      }
      // Flush after file selection and confirmation: the most recent keystroke
      // is included, and a failed save keeps the renderer and its edits alive.
      await flush(win.webContents);
      if (restore) await core.restoreBackup(staged, { appVersion });
      else await core.createBackup(selectedPath, { appVersion });
      success = true;
      return { ok: true };
    } catch (err) {
      const error = safeError(err);
      await dialogs.showMessageBox(win, { type: 'warning', buttons: ['OK'], message: restore ? 'Restore could not finish' : 'Backup could not finish', detail: `${error}${core.closed ? '\nZelos will reopen to recover or load its data.' : '\nZelos kept the current board open. If a draft could not save, copy its text before leaving.'}` }).catch(() => {});
      return { ok: false, error };
    } finally {
      // Never remove a transaction whose journal is needed by startup recovery.
      if (staged && !fs.existsSync(path.join(core.paths.home, '.restore-journal.json'))) staged.cleanup();
      if (disabled && !win.isDestroyed()) win.setEnabled?.(true);
      busy = false; setBusy(false);
      if (restore && core.closed) await restart({ restored: success });
    }
  };
  return { createBackup: run(false), restoreBackup: run(true) };
}

function installBackups() {
  const handlers = backupHandlers({
    isBoard: (event) => Boolean(mainWindow) && !mainWindow.isDestroyed()
      && event?.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame
      && classifyTarget(event.senderFrame?.url, { port: zelos?.port ?? 0 }).action === 'internal',
    getCore: () => zelos, getWindow: () => mainWindow, dialogs: dialog,
    flush: flushDraftsInPage, appVersion: app.getVersion(), setBusy: (value) => { maintenanceActive = value; },
    restart: async () => {
      // Geometry is outside the portable data set. Preserve it once, then stop
      // the shell cleanly and let a fresh process load restored configuration.
      windowState?.capture();
      app.relaunch();
      quitting = true;
      app.quit();
    },
  });
  ipcMain.handle(CREATE_BACKUP_CHANNEL, handlers.createBackup);
  ipcMain.handle(RESTORE_BACKUP_CHANNEL, handlers.restoreBackup);
}

export const UPDATE_STATE_CHANNEL = 'zelos:update-state';
export const UPDATE_CHECK_CHANNEL = 'zelos:update-check';
export const UPDATE_DOWNLOAD_CHANNEL = 'zelos:update-download';
export const UPDATE_SET_AUTO_CHANNEL = 'zelos:update-set-auto';
export const UPDATE_RESTART_CHANNEL = 'zelos:update-restart';
export const UPDATE_SNOOZE_CHANNEL = 'zelos:update-snooze';
export const UPDATE_SKIP_CHANNEL = 'zelos:update-skip';

/**
 * The page's view of the updater. Every channel answers the board's own main
 * frame and nobody else, and only one of them carries an argument: the
 * automatic-updates switch, which must be a real boolean. Nothing the page
 * sends can name a file, an address or a version — those come only from the
 * verified release.
 */
export function updateHandlers({ isBoard, getUpdater, restart }) {
  const refused = { ok: false, error: 'This action is only available in the Zelos desktop board.' };
  const guard = (fn) => async (event, ...args) => {
    if (!isBoard(event)) return refused;
    const current = getUpdater();
    if (!current) return { ok: false, error: 'Updates are not ready yet.' };
    return fn(current, ...args);
  };
  const noArgs = (fn) => guard((current, ...args) => (args.length ? refused : fn(current)));
  return {
    state: noArgs((current) => ({ ok: true, state: current.state() })),
    check: noArgs(async (current) => ({ ok: true, state: await current.checkNow() })),
    download: noArgs(async (current) => ({ ok: true, state: await current.download() })),
    setAuto: guard((current, ...args) => (args.length === 1 && typeof args[0] === 'boolean'
      ? { ok: true, state: current.setAuto(args[0]) } : refused)),
    restart: noArgs(() => restart()),
    snooze: noArgs((current) => ({ ok: true, state: current.snoozeBanner() })),
    skip: noArgs((current) => ({ ok: true, state: current.skipBanner() })),
  };
}

/**
 * Restart into a downloaded update. The installer is re-verified first, while
 * there is still a window to explain a failure in; then the shell leaves the
 * way it always does — drafts saved, core stopped, home lock released — and
 * beginShutdown hands the exit to the installer instead of a plain quit.
 */
let restarting = null;

/** One restart at a time: the menu, the tray and Settings can all ask at once. */
function restartToUpdate() {
  restarting ??= restartOnce().finally(() => { restarting = null; });
  return restarting;
}

async function restartOnce() {
  if (!updater || updater.state().status !== 'ready') return { ok: false, error: 'No update is ready to install.' };
  if (maintenanceActive) return { ok: false, error: 'Finish the backup or restore first, then restart to update.' };
  if (!(await updater.prepareInstall())) return { ok: false, error: updater.state().error || 'The update could not be verified.' };
  // Preparing a Mac update takes a moment; a backup or restore may have begun meanwhile.
  if (maintenanceActive) {
    updater.abandonInstall();
    return { ok: false, error: 'Finish the backup or restore first, then restart to update.' };
  }
  let blocked = false;
  const left = await leaveBoard(() => {
    // A backup or restore that began while drafts were saving wins: quitting
    // now would be refused anyway, and the install flag must not outlive it.
    if (maintenanceActive) { blocked = true; return; }
    installAfterShutdown = true;
    quitting = true;
    app.quit();
  }, { quit: true });
  if (blocked || !left) updater.abandonInstall();
  if (blocked) return { ok: false, error: 'Finish the backup or restore first, then restart to update.' };
  return left ? { ok: true } : { ok: false, error: 'Zelos stayed open so your draft edits are not lost.' };
}

function installUpdates() {
  const handlers = updateHandlers({
    isBoard: (event) => Boolean(mainWindow) && !mainWindow.isDestroyed()
      && event?.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame
      && classifyTarget(event.senderFrame?.url, { port: zelos?.port ?? 0 }).action === 'internal',
    getUpdater: () => updater,
    restart: restartToUpdate,
  });
  ipcMain.handle(UPDATE_STATE_CHANNEL, handlers.state);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, handlers.check);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, handlers.download);
  ipcMain.handle(UPDATE_SET_AUTO_CHANNEL, handlers.setAuto);
  ipcMain.handle(UPDATE_RESTART_CHANNEL, handlers.restart);
  ipcMain.handle(UPDATE_SNOOZE_CHANNEL, handlers.snooze);
  ipcMain.handle(UPDATE_SKIP_CHANNEL, handlers.skip);
}

let menuKey = '';

function startUpdater() {
  const bundle = path.resolve(path.dirname(process.execPath), '..', '..');
  try {
    updater = createUpdater({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      settingsFile: path.join(zelos.paths.home, 'updates.json'),
      // Outside the data folder on purpose: a backup of the data folder must
      // not carry a hundred-megabyte installer along with it.
      downloadDir: path.join(app.getPath('userData'), PENDING_DIR),
      ...readUpdateConfig(HERE),
      mac: process.platform === 'darwin' ? {
        bundlePath: bundle,
        canReplace: macReplaceCheck(),
        extractZip: macZipExtractor({ execFile }),
        readBundleInfo: macBundleInfoReader({ execFile }),
        copyApp: macAppCopier({ execFile }),
        otherInstances: macOtherInstances({ execFile }),
        launchSwap: macSwapLauncher({ spawn }),
      } : {},
      windows: process.platform === 'win32' ? {
        canReplace: windowsReplaceCheck(),
        verifySignature: windowsSignatureVerifier({ execFile }),
        launchInstaller: windowsInstallerLauncher({ spawn }),
      } : {},
      logger: zelos.logger,
      // The menus show only whether an update is ready and which; download
      // progress changes neither, so it does not rebuild them.
      onChange: (state) => {
        const key = `${state.status === 'ready'}:${state.latestVersion}`;
        if (key === menuKey) return;
        menuKey = key;
        refreshMenus();
      },
    });
    updater.start().then((state) => {
      // An update the last restart did not land is said once, out loud; the
      // Updates panel keeps saying it for the rest of the session.
      if (!state.installProblem) return;
      showWindow();
      return dialog.showMessageBox({ type: 'warning', buttons: ['OK'], message: 'The update did not install', detail: state.installProblem });
    }).catch((err) => zelos?.logger.warn('desktop: the updater could not start', { error: err.message }));
  } catch (err) {
    updater = null;
    zelos?.logger.warn('desktop: the updater could not start', { error: err.message });
  }
}

/** Rebuild the menus whose items depend on state — the login item, a ready update. */
function refreshMenus() {
  installAppMenu();
  if (tray && actions) {
    try {
      tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({ actions, update: updater?.state() })));
    } catch { /* a tray that vanished is not worth failing over */ }
  }
}

function installAppMenu() {
  if (!actions) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate({ appName: APP_NAME, actions, update: updater?.state() })));
}

/**
 * The About dialog, as data. Pure so a test can hold what the dialog says up
 * against the build stamp without Electron; `commit` may be empty, see
 * readBuildCommit.
 */
export function aboutText({ version, commit = '', url = null, home = '' }) {
  return {
    type: 'info',
    title: `About ${APP_NAME}`,
    message: `${APP_NAME} ${versionLabel(version, commit)}`,
    detail: [
      'A local-first second brain.',
      '',
      `Board   ${url ?? 'not running'}`,
      `Data    ${home}`,
      '',
      'Listening on 127.0.0.1 only. Reading and AI use the services you configure.',
      'Update checks contact GitHub, without your data, and can be turned off in Settings.',
    ].join('\n'),
    buttons: ['OK'],
  };
}

function buildActions() {
  return {
    sweepNow: () => {
      // A person asking for a sweep by hand means the full thing — sources
      // re-fetched and the model consulted — which is what --sweep-now does too.
      zelos?.sweepNow('full');
      showWindow();
    },
    openBoard: () => showWindow(),
    showView,
    reloadBoard: () => leaveBoard(() => {
      if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.loadURL(zelos.tokenUrl);
    }),
    /**
     * The same board, in the system browser. The bare address lands on the
     * refusal screen — it carries no session token — and the token itself must
     * never reach a command line, where `ps` hands it to every process on the
     * machine. So this asks the core this process embeds for the same
     * ten-second single-use handoff the CLI launcher mints (see HandoffPad in
     * core/server.mjs), resolved against the address the core bound. Minted on
     * the click, not before, so its ten seconds start as the browser opens.
     * A mint that fails opens nothing: falling back to the token on the
     * command line would trade the failure for the leak the handoff exists to
     * prevent.
     */
    openInBrowser: async () => {
      try {
        const at = zelos?.server?.zelos?.mintHandoff?.();
        if (typeof at !== 'string' || !at) throw new Error('No browser handoff');
        await shell.openExternal(new URL(at, zelos.url).href);
      } catch {
        // Neither the handoff URL nor the OS error belongs in a log: both can
        // contain the single-use credential passed to the browser.
        zelos?.logger.warn('desktop: could not open the board in a browser');
        await explainExternalOpenFailure({ scheme: 'http:' });
      }
    },
    /**
     * The OS's own login-items list is the state; nothing is mirrored into
     * config.json, so the two can never disagree. Reading it is wrapped because
     * the call does not exist on every platform and throws on some of them.
     */
    openAtLogin: () => {
      try {
        return app.getLoginItemSettings?.().openAtLogin === true;
      } catch {
        return false;
      }
    },
    setOpenAtLogin: (want) => {
      const openAtLogin = want === true;
      try {
        // Only `openAtLogin`, and deliberately. This used to pass
        // `openAsHidden` too, under a comment promising that a Zelos launched
        // at login would sweep without putting a window in front of whatever
        // the person sat down to do — a promise nothing here could keep.
        // Electron 43 marks the flag deprecated and does not implement it on
        // macOS 13 and up; it does not exist on Windows, where menus.js offers
        // the same checkbox; and the counterpart it is supposed to set,
        // `getLoginItemSettings().wasOpenedAsHidden`, is read nowhere in this
        // repo, so even where the OS answered true the window would still be
        // created and shown at its full size. An argument that changes nothing
        // is cheap; the sentence above it, which a reader would have believed,
        // is not.
        app.setLoginItemSettings({ openAtLogin });
        zelos?.logger.info('desktop: login item changed', { openAtLogin });
      } catch (err) {
        zelos?.logger.warn('desktop: this platform would not set the login item', { error: err.message });
      }
      // The checkbox's state is read when the template is built, so the menu is
      // rebuilt rather than left showing what it showed a moment ago.
      installAppMenu();
    },

    /**
     * Settings → About, where the Updates panel is, with a fresh check started
     * for the person who asked. A build that cannot update itself shows its
     * manual check there instead, and the reason.
     */
    checkForUpdates: () => {
      showWindow();
      mainWindow?.webContents
        .executeJavaScript(`window.location.hash = ${JSON.stringify('#/settings/about')};`)
        .catch((err) => zelos?.logger.warn('desktop: could not open Settings', { error: err.message }));
      updater?.checkNow().catch(() => {});
    },
    restartToUpdate: () => {
      // From the tray or a menu there may be no window, and preparing a Mac
      // update takes a moment; show the panel that reports how it went.
      showWindow();
      mainWindow?.webContents
        .executeJavaScript(`window.location.hash = ${JSON.stringify('#/settings/about')};`)
        .catch(() => {});
      restartToUpdate().then((result) => {
        if (result.ok) return;
        showWindow();
        return dialog.showMessageBox({ type: 'warning', buttons: ['OK'], message: 'Zelos did not restart to update', detail: result.error });
      }).catch(() => {});
    },

    openDataFolder: () => openLocalPath(zelos.paths.home),
    openLogs: () => openLocalPath(zelos.paths.logsDir),
    openInstallNotes: () => openLocalPath(path.join(ROOT, 'docs', 'INSTALL.md')),
    openSecurityNotes: () => openLocalPath(path.join(ROOT, 'docs', 'SECURITY.md')),
    about: () => {
      dialog.showMessageBox(aboutText({
        version: app.getVersion(),
        commit: BUILD_COMMIT,
        url: zelos?.url,
        home: zelos?.paths.home ?? '',
      }));
    },
    quit: () => app.quit(),
  };
}

/* ------------------------------------------------------------------ *
 * Shutdown
 * ------------------------------------------------------------------ */

/** Fixed page callback; no renderer-provided code or new preload powers.
 * A stalled local write cancels leaving after a bounded wait. It may still
 * finish later, but the page stays open until the user asks again.
 */
export async function flushDraftsInPage(contents, { timeoutMs = 10_000 } = {}) {
  let timer;
  try {
    const saved = await Promise.race([
      contents.executeJavaScript('globalThis.__zelosFlushDrafts ? globalThis.__zelosFlushDrafts() : true'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Drafts are still saving.')), timeoutMs);
      }),
    ]);
    if (saved !== true) throw new Error('Draft saving was not confirmed.');
  } finally {
    clearTimeout(timer);
  }
}

function leaveBoard(action, { quit = false } = {}) {
  if (maintenanceActive) return Promise.resolve(false);
  // Repeated shortcuts share one save. Quit takes precedence over a reload
  // already waiting for the same edits, so a second request is not lost.
  if (leaving) {
    if (quit) leaveAction = action;
    return leaving;
  }
  leaveAction = action;
  leaving = (async () => {
    try {
      const win = mainWindow;
      if (win && !win.isDestroyed() && !win.webContents.isCrashed?.()) await flushDraftsInPage(win.webContents);
      await leaveAction();
      return true;
    } catch {
      try {
        showWindow();
        await dialog.showMessageBox({
          type: 'warning', buttons: ['Keep editing'], defaultId: 0,
          message: 'Zelos kept your draft edits open',
          detail: 'The drafts could not finish saving, so Zelos stayed open. Try quitting or reloading again. If saving still fails, use Copy the text on each edited draft to keep your words.',
        });
      } catch { /* Leaving remains cancelled even if the OS cannot show a dialog. */ }
      return false;
    } finally {
      leaving = null;
      leaveAction = null;
    }
  })();
  return leaving;
}

async function explainExternalOpenFailure({ scheme }) {
  const mail = scheme === 'mailto:';
  try {
    await dialog.showMessageBox({
      type: 'warning', buttons: ['OK'],
      message: mail ? 'Could not open your mail app' : 'Could not open your browser',
      detail: `Choose a default ${mail ? 'mail app' : 'browser'} in your computer’s settings, then try again.${mail ? ' You can also use Copy the text and paste the draft into your email.' : ''}`,
    });
  } catch { /* A dialog failure must not turn an OS opener refusal into a crash. */ }
}

function beginShutdown() {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    try {
      if (crashTimer) {
        clearTimeout(crashTimer);
        crashTimer = null;
      }
      windowState?.capture();
      updater?.stop();
      await zelos?.stop();
    } catch {
      // Quitting is not allowed to fail; whatever did not close is about to
      // stop existing anyway.
    } finally {
      zelos = null;
      // Electron drains microtasks inside will-quit while its native quit
      // guard is still set. Wait for that event to return before retrying,
      // or an idle core can stop while the second app.quit is ignored.
      // A restart for an update first hands off to the installer (Windows)
      // or the swap script (macOS); both wait for this process to exit, so
      // the quit follows either way.
      setImmediate(() => {
        if (installAfterShutdown) updater?.install({ onFailure: () => {} });
        app.quit();
      });
    }
  })();
  return shuttingDown;
}

/* ------------------------------------------------------------------ *
 * The stdio MCP server
 * ------------------------------------------------------------------ */

/**
 * `Zelos mcp` — the packaged app doubling as the stdio MCP server.
 *
 * The build ships `core/` but not `zelos.mjs` (see extraResources in
 * package.json), so the "Ready to paste" block in Settings names this binary
 * plus the one word — and this is the code that makes that block true. Three
 * things are deliberately not done here: no window and no tray, and the dock
 * icon is hidden before anything can draw one, because this process is a pipe;
 * no single-instance lock, because the copy the person is using holds it and
 * this one has to run beside it; and nothing is ever written to stdout — it is
 * the JSON-RPC channel, and one stray line corrupts the stream, which is
 * `zelos.mjs`'s rule 3 holding here too. The server ends when the client
 * closes stdin, exactly as the CLI's `commandMcp` does.
 *
 * `io` exists for the tests, which own both streams; a real spawn passes
 * nothing and serveStdio takes the process's own.
 */
export async function serveMcp(flags, io = {}) {
  if (flags.home) process.env.ZELOS_HOME = path.resolve(flags.home);
  app.dock?.hide?.();
  const load = (rel) => import(pathToFileURL(path.join(ROOT, 'core', rel)).href);
  try {
    const [{ serveStdio }, { log }] = await Promise.all([load('mcp.mjs'), load('log.mjs')]);
    await serveStdio({ logger: log, ...io });
    app.exit?.(0);
    return { ok: true, mcp: true };
  } catch (err) {
    process.stderr.write(`zelos mcp: ${err?.stack ?? err}\n`);
    app.exit?.(1);
    return { ok: false, mcp: true, error: err };
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function bootstrap() {
  const flags = parseShellArgs(process.argv.slice(1));

  // Spawned by an AI client, not opened by a person: serve JSON-RPC on stdio
  // and never become a window. Decided before the single-instance lock below,
  // because this copy has to run beside the Zelos the person is using rather
  // than lose the lock to it and quit.
  if (flags.mcp) return serveMcp(flags);

  // One Zelos per machine: two would fight over the same database and the
  // second would bind a different port, so the URL in the banner would be a lie.
  // This half only ever sees another Electron app — a CLI `zelos` is invisible
  // to it — so the real exclusion is the lock runtime.js takes on the data
  // home. This stays because it is the only one that can raise the window that
  // is already open instead of showing a dialog about it.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { ok: false, reason: 'another copy of Zelos is already running' };
  }

  app.setName(APP_NAME);
  app.on('second-instance', () => showWindow());

  // A page must never be able to raise an HTTP-auth or proxy prompt.
  app.on('login', (event) => event.preventDefault());

  app.on('activate', () => showWindow());

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return; // macOS apps outlive their windows
    if (staysResidentOnClose()) return;        // the schedule is still running in the tray
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (maintenanceActive) { event.preventDefault(); return; }
    if (quitting || !mainWindow || mainWindow.isDestroyed()) { quitting = true; return; }
    event.preventDefault();
    leaveBoard(() => { quitting = true; app.quit(); }, { quit: true });
  });
  app.on('will-quit', (event) => {
    if (shuttingDown) return; // second pass: everything is closed, let it go
    event.preventDefault();
    beginShutdown();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => app.quit());
  }

  // whenReady() is called before the first await so its listener is attached
  // while the ready event is still ahead of us; the core boots alongside it
  // rather than after it, because none of that work needs Chromium.
  const ready = app.whenReady();
  const booting = startCore({
    root: ROOT,
    home: flags.home,
    port: flags.port ?? portFromEnv(),
  }).then((handle) => ({ handle }), (error) => ({ error }));

  await ready;
  const booted = await booting;

  if (booted.error) {
    // Whatever went wrong, the error's own words come first: it is the only
    // part of this that knows what actually happened. The lines after it are
    // orientation — where the data lives — and nothing is guessed at, because
    // a confident wrong diagnosis sends people looking in the wrong place.
    const detail = [
      booted.error.message,
      '',
      `Zelos keeps its data in ${process.env.ZELOS_HOME || '~/.zelos'}.`,
      ...(booted.error.lockFile ? ['', `The file it was reading is ${booted.error.lockFile}.`] : []),
    ].join('\n');
    dialog.showErrorBox(`${APP_NAME} could not start`, detail);
    app.quit();
    return { ok: false, error: booted.error, holder: null };
  }

  zelos = booted.handle;

  /* A home that looks busy is a warning, never a refusal — the diagnosis reads
     a file on disk and can be wrong, and being wrong must not cost somebody
     their app. So it is put to the person, with the safe choice as the default
     button and the consequence spelled out rather than implied. */
  if (zelos.contested) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: `${APP_NAME} may already be running`,
      message: `${APP_NAME} may already be running`,
      detail: zelos.contested.message,
      buttons: ['Quit', 'Open anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 0) {
      app.quit();
      return { ok: false, error: null, holder: zelos.contested };
    }
  }
  hardenSession(session.defaultSession);

  // Every webContents, not just the first window: a guard that only covers the
  // window you remembered to guard is not a guard. Registered here, after the
  // core is up, so it has the real port and the real logger from the start —
  // nothing has created a webContents before this line.
  const logger = zelos.logger;
  app.on('web-contents-created', (_event, contents) => {
    // The second WebRTC lock (the CSP directive in hardenSession is the
    // first): even a page that shed its CSP gets no UDP to speak over.
    // `disable_non_proxied_udp` allows peer traffic only through a UDP proxy,
    // and this app configures none. TCP-only ICE is what remains — the pinned
    // Electron has no switch for it, which is why the CSP block above matters.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    guardWebContents(contents, {
      // Read at event time, not captured: after shutdown there is no port, and
      // "no port" means nothing counts as internal.
      getPort: () => zelos?.port ?? 0,
      openExternal: (url) => shell.openExternal(url),
      onExternalOpenError: explainExternalOpenFailure,
      logger,
    });
  });

  if (typeof app.setAboutPanelOptions === 'function') {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: versionLabel(app.getVersion(), BUILD_COMMIT),
      copyright: 'MIT licensed. Local-first: reading and AI use the services you configure. Update checks contact GitHub without your data.',
    });
  }
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

  actions = buildActions();
  installAppMenu();
  createTray(actions);
  createWindow();
  installShowHome();
  installBackups();
  installUpdates();
  startUpdater();

  // The badge is the only thing a swept-in-the-background Zelos says while its
  // window is shut. It is set when a sweep ends — from the clock or by hand,
  // both come through the same supervisor — and cleared the moment the board is
  // looked at, which is what makes it a count of things not yet seen.
  zelos.onSweep((event) => {
    if (event !== 'done' && event !== 'failed') return;
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      setBadge(0);
      return;
    }
    setBadge(zelos?.attentionCount() ?? 0);
  });

  if (flags.sweepNow) zelos.sweepNow('full');

  zelos.logger.info('desktop: shell ready', {
    url: zelos.url,
    root: ROOT,
    version: versionLabel(app.getVersion(), BUILD_COMMIT),
  });
  return { ok: true, zelos, window: mainWindow, tray, actions, flags };
}

/**
 * Kicked off at import, which is how an Electron main script runs. The promise
 * is exported — and resolves on failure rather than rejecting — so a test can
 * boot the shell against a stub Electron and inspect what it built.
 */
export const ready = bootstrap();

/** Exported for the same reason: a test has to be able to put it back down. */
export function shutdown() {
  return beginShutdown();
}
