/**
 * desktop/menus.js — menu templates, as data.
 *
 * These are plain arrays: `Menu.buildFromTemplate` is called by main.js, not
 * here. That keeps the shape of every menu — and the fact that the tray really
 * does carry Check now / Open Zelos / Quit — checkable without Electron.
 *
 * The macOS menu is not decoration. Without a real Edit menu, ⌘C and ⌘V do
 * nothing in a text field, and the Promises view is mostly text fields.
 */

/**
 * Where `app.setLoginItemSettings` means anything. macOS and Windows both have
 * a real login-items list Electron can write to; on Linux the call is a no-op,
 * and a checkbox that silently does nothing is worse than no checkbox at all.
 */
export function supportsLoginItem(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

/** The board's views, in the order the UI lists them (ui/app.js VIEWS — the
 * test holds the two lists together). Used for ⌘1…⌘7, except Search. */
export const VIEWS = Object.freeze([
  { id: 'now', label: 'Now' },
  { id: 'today', label: 'Today' },
  // 'Promises', as the board says it — the id 'owed' is the route, not a name
  // anyone sees.
  { id: 'owed', label: 'Promises' },
  { id: 'calendar', label: 'Calendar' },
  // Search answers to ⌘F, the shortcut every find field answers to. It still
  // counts as a position, so Ask and Settings keep the numbers of the places
  // they are seen in.
  { id: 'search', label: 'Search', accelerator: 'CmdOrCtrl+F' },
  { id: 'ask', label: 'Ask' },
  { id: 'settings', label: 'Settings' },
]);

/**
 * The one update item, from the updater's state (desktop/updater.js). A ready
 * update offers the restart that installs it; otherwise the item opens
 * Settings → Updates and checks, which is also where an unsigned build
 * explains why it cannot update itself.
 */
export function updateMenuItem({ update = null, actions = {} } = {}) {
  if (update?.status === 'ready') {
    return { label: update.latestVersion ? `Restart to Install Zelos ${update.latestVersion}` : 'Restart to Install Update', click: () => actions.restartToUpdate?.() };
  }
  if (!actions.checkForUpdates) return null;
  return { label: 'Check for Updates…', click: () => actions.checkForUpdates() };
}

/**
 * `actions` is every effect a menu item can have; main.js supplies them.
 * Missing ones simply drop their item rather than crashing a menu build.
 */
export function buildAppMenuTemplate({ platform = process.platform, appName = 'Zelos', actions = {}, update = null } = {}) {
  const mac = platform === 'darwin';
  const template = [];
  const updateItem = updateMenuItem({ update, actions });

  if (mac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        ...(updateItem ? [updateItem] : []),
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => actions.showView?.('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'Board',
    submenu: [
      { label: 'Check now', accelerator: 'CmdOrCtrl+Shift+S', click: () => actions.sweepNow?.() },
      { type: 'separator' },
      // Deliberately not `role: 'reload'`. The board strips its session token
      // out of the address bar the moment it has read it, so a plain reload
      // would reload a URL that no longer carries one. This reloads the URL the
      // shell holds, token included.
      { label: 'Reload board', accelerator: 'CmdOrCtrl+R', click: () => actions.reloadBoard?.() },
      // The same board, in the default browser. The bare address refuses
      // without the session token, so the action mints a one-time handoff
      // through the core this process embeds (see HandoffPad, core/server.mjs)
      // — the token itself never touches a command line.
      { label: 'Open in your web browser', click: () => actions.openInBrowser?.() },
      { type: 'separator' },
      { label: 'Show data folder', click: () => actions.openDataFolder?.() },
      { label: 'Show logs', click: () => actions.openLogs?.() },
      // The whole pitch is a Zelos that sweeps while you are doing something
      // else, and today it only sweeps if you remember to launch it. Opt-in,
      // never assumed: the checkbox reads the OS's own list rather than a
      // setting of ours, so it cannot disagree with what the OS will do.
      ...(supportsLoginItem(platform) ? [
        { type: 'separator' },
        {
          label: 'Open Zelos at login',
          type: 'checkbox',
          checked: actions.openAtLogin?.() === true,
          click: (item) => actions.setOpenAtLogin?.(item?.checked === true),
        },
      ] : []),
      ...(mac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Quit Zelos' }]),
    ],
  });

  template.push({
    label: 'Go',
    submenu: VIEWS.map((view, i) => ({
      label: view.label,
      accelerator: view.accelerator ?? `CmdOrCtrl+${i + 1}`,
      click: () => actions.showView?.(view.id),
    })),
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'toggleDevTools' },
    ],
  });

  // `close` is on both branches. Without it a macOS build has no ⌘W at all —
  // the shortcut every Mac user reaches for first, doing nothing, in an app
  // whose window is *meant* to be closed and left running.
  template.push({
    label: 'Window',
    role: 'window',
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }],
  });

  template.push({
    label: 'Help',
    role: 'help',
    submenu: [
      // Local files only. Nothing in this app opens a web page the user did not
      // click on themselves.
      { label: 'Install notes', click: () => actions.openInstallNotes?.() },
      { label: 'Security notes', click: () => actions.openSecurityNotes?.() },
      ...(mac ? [] : [
        { type: 'separator' },
        ...(updateItem ? [updateItem] : []),
        { label: `About ${appName}`, click: () => actions.about?.() },
      ]),
    ],
  });

  return template;
}

/**
 * The tray menu — the three things the spec asks for, plus a restart item
 * only while a downloaded update is waiting. A tray-resident Zelos may not
 * have a window open, and this is where the person would otherwise not learn
 * that an update is ready.
 */
export function buildTrayMenuTemplate({ actions = {}, update = null } = {}) {
  return [
    { label: 'Check now', click: () => actions.sweepNow?.() },
    { label: 'Open Zelos', click: () => actions.openBoard?.() },
    ...(update?.status === 'ready' ? [{ type: 'separator' }, updateMenuItem({ update, actions })] : []),
    { type: 'separator' },
    { label: 'Quit Zelos', click: () => actions.quit?.() },
  ];
}
