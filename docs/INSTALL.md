# Installing Zelos

Zelos is available as a desktop app or a source download. Both run the same
program. The desktop app includes its runtime and opens in its own window.

**Not a programmer?** You want the desktop app. Download it for your Mac or
Windows PC from [zelos-app.netlify.app](https://zelos-app.netlify.app/#download).
These builds do not have a verified publisher signature, so your computer may
show a warning. Continue only if you trust the download. The sections
[Installing on macOS](#installing-on-macos--and-what-you-will-actually-see) and
[Installing on Windows](#installing-on-windows--and-what-you-will-actually-see)
below say what to click. The rest of this page is for people who type commands.

## Updating from an earlier version

Quit Zelos, then copy the data folder shown in Settings to a safe location before
installing the update. The usual folder is `~/.zelos`. Install the new app over
the old one; it retains your data and upgrades the database on first launch.
Keep the copy if you may need to return to an older version. A board snapshot
is not a complete backup, and credentials in your operating system's keychain
may need reconnecting on another computer.

Release notes, all four installers, source, and SHA-256 checksums are on the
[GitHub releases page](https://github.com/HoosAI-Platform/zelos/releases).

Starting with 1.8, the desktop app also offers **Settings → Your data → Create backup**.
It saves a consistent archive of the database, captures, drafts, item history,
settings and portable credentials. Keep the `.zelos-backup` file private: it is
not password protected and can include credentials. Passwords held outside the
data folder by the operating system may need reconnecting on another computer.

**Restore a backup…** validates the file and previews its date and contents before
asking to replace your current data. Zelos keeps a private recovery copy, then
restarts after a successful restore. Close other Zelos sessions and connected AI
clients before starting; restore refuses to replace data while another client is
using it. Only restore a backup you trust, with a version that supports its schema.
The command-line/browser app retains the full-folder backup procedure above.

**Settings → About → Check for updates** checks the official GitHub release when
pressed. It sends no account content or credentials.

**Automatic updates.** A desktop app that carries the Zelos update key also
checks when it opens and every six hours, downloads a newer release in the
background, checks it against the release's signed manifest, and installs it
when you choose **Restart to update** (in Settings → About, the app menu, or
the tray). **Install updates automatically** in Settings → About turns this
off. On a Mac, Zelos must be in a folder you can change (normally
Applications), and macOS may ask whether Zelos may update apps, possibly at
each update. On Windows it works for an installation just for you; one for all
users is updated from the release page. Current
builds do not carry the key yet, so they check only when you ask and you
install new versions yourself, as described above.

## Path 1 — Command-line usage

Download and unpack the source archive, then open a terminal in its `zelos`
folder. The npm package is not part of this release; use `node zelos.mjs`
followed by any subcommand below.

### The four things you can type

```
node zelos.mjs                Run the app. This is the one you want.
node zelos.mjs sweep          Read your sources once, think about them, print what
                     changed, and stop. Exits non-zero if the sweep failed,
                     so it is safe to put in a cron job.
node zelos.mjs doctor         Check every part of the setup and say, in plain words,
                     what to do about anything that is wrong.
node zelos.mjs mcp            Serve Zelos's read-only tools over MCP on stdin/stdout,
                     for an AI client that spawns it. Off unless you have
                     switched AI access on in Settings.
```

Every one of them takes `--home <dir>`. `zelos sweep` and `zelos doctor` also
take `--json`, if you would rather have data than sentences.

### When something is not working, ask the doctor first

```
zelos doctor
```

It checks your Node version, the permissions on your data folder, whether your
settings file loads, whether the secret store can be written, whether your model
answers, whether each mail account signs in, and whether each calendar link
resolves. Every line that is not a `✓` ends in a specific thing to do:

```
  ✕  Model          Could not reach the model at http://127.0.0.1:11434/v1
       →  Nothing is listening there. Start your local model first — for
          Ollama that is: ollama serve

  ✕  Mail · Work    imap.gmail.com: [AUTHENTICATIONFAILED] Invalid credentials
       →  Gmail requires 2-Step Verification plus a 16-character App
          Password. Your normal password will not work over IMAP.
```

It exits `0` when nothing is broken and `1` when something is. Things you simply
have not set up yet are marked `!`, not `✕` — a fresh install is unfinished, not
faulty.

---

## Path 2 — Run it from source

### What you need

This path is for people who already type commands. If that is not you, the
desktop app in [Path 3](#path-3--the-desktop-app) is the same program in a
window — take that instead.

**Node.js 22.16 or newer, or 24 or newer** — and the gap in the middle is real,
not a typo. Zelos keeps everything in the SQLite built into Node, and its index
needs that SQLite's full-text search extension. Node's build did not include it
until **22.16**, and does not include it anywhere in the **Node 23** line. On a
runtime without it Zelos will not start, and says which versions do work rather
than failing partway through a migration. **Node 26 is what it is developed and
tested against**, and it is what you want. Get Node from
[nodejs.org](https://nodejs.org) and take the defaults.

To check what you have, open Terminal (macOS/Linux) or PowerShell (Windows):

```
node --version
```

### Get Zelos and start it

```
cd zelos
node zelos.mjs
```

That is the whole installation. There is **no `npm install`** step, because the
app has no dependencies — the entire thing is written against what Node ships
with. If instructions anywhere ever tell you to `npm install` in the Zelos
folder, something is wrong. (The one exception is the `desktop/` folder, which
is a separate package that exists only to put this same app in a window. See
Path 3.)

You will see a banner like this, and your browser will open:

```
  ZELOS 1.8.1
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Open   http://127.0.0.1:7777/?t=9c1f…

  Data   /Users/you/.zelos
  Model  not set up yet — the app will walk you through it
  …
```

**That `?t=…` is a session token, and it is not decoration.** Any web page you
have open can send requests to `127.0.0.1`; the token is what stops one from
reading your board. It is new on every launch, so the previous link stops
working when you restart. Do not paste it into anything.

### Options

```
node zelos.mjs --port 7788     # a different port (default 7777, or $ZELOS_PORT)
node zelos.mjs --home ~/zdata  # keep the data somewhere else (default ~/.zelos)
node zelos.mjs --no-open       # do not open a browser, just print the URL
node zelos.mjs --sweep-now     # sweep immediately on start
node zelos.mjs --help
```

The subcommands from Path 1 work here too — `node zelos.mjs doctor`,
`node zelos.mjs sweep`, `node zelos.mjs mcp`.

Press `Ctrl-C` in the terminal to stop it.

---

## Path 3 — The desktop app

### What the shell adds

- A real application window and a Dock/taskbar icon.
- A tray icon with **Check now**, **Open Zelos** and **Quit**.
- A menu bar, so ⌘C and ⌘V work in the draft editors, and ⌘1…⌘6 jump between
  views.
- It keeps running when you close the window, so scheduled sweeps keep
  happening. Exactly when, by platform:
  - **macOS** — always. That is how macOS apps work; ⌘Q quits.
  - **Windows** — when automatic sweeps are on *and* a tray icon was created.
    With sweeps off, closing the window quits.
  - **Linux** — closing the window **quits**, even with sweeps on and a tray
    icon apparently made, **unless you set `ZELOS_TRAY_RESIDENT=1`**. A tray
    icon there is a StatusNotifierItem published on the session bus, and
    publishing succeeds whether or not any panel is watching — so `new Tray()`
    returning an object proves nothing. Rather than hide the window into a tray
    that may not exist, Zelos quits and makes you say out loud that your tray
    works. Losing a background sweep costs one click; losing the way back into
    the app does not.

### What it does not add

- No Zelos account, no automatic update check, no telemetry. Pressing **Check
  for updates** asks the official GitHub release API for public release details;
  it sends no archived content or credentials. The shell blocks every
  outbound request from the window that is not the local board — **including
  WebSockets**, which is the class it silently missed until the guard's match
  pattern was widened from `*://*/*` to `<all_urls>` (`*` in a scheme position
  means http and https and nothing else, so `new WebSocket('wss://…')` used to
  sail past). It denies every browser permission except the one the "copy draft"
  buttons need, and turns spellcheck off because Chromium fetches its
  dictionaries from a Google server.
- No hidden launch. **Open Zelos at login** puts Zelos in the OS login-items
  list and nothing more: at login the window opens, in front of whatever you sat
  down to do. It never launched hidden, and the code no longer implies it might.
- No second copy of anything. The shell runs the Zelos core **inside its own
  process** — it does not launch a background Node.

### Where a build comes from

There is no download page in this repository, and no release binary committed to
it. Builds come from one of two places.

**A GitHub Actions run.** `.github/workflows/desktop.yml` builds the installers
on a real Windows runner and a real macOS runner, either when a `v*` tag is
pushed or when somebody starts the workflow by hand. It runs the whole test
suite *before* it packages anything and fails the job rather than shipping an
installer built from a failing tree. What comes out is attached to that run as
an artifact:

```
Zelos-1.8.1-arm64.dmg          Apple Silicon
Zelos-1.8.1-x64.dmg            Intel Macs
Zelos-1.8.1-setup-x64.exe      Windows, 64-bit — ordinary PCs
Zelos-1.8.1-setup-arm64.exe    Windows on ARM
```

Windows also gets a third installer from the same run, carrying both
architectures in one larger file; take it if you are not sure which machine you
are on. (That is why the workflow collects `*setup*.exe` rather than two fixed
names.)

A run artifact is not a public download link. GitHub hands artifacts only to
signed-in users, and deletes them once the repository's retention window is up —
90 days unless someone has changed it. If that does not suit you, build it
yourself; it is the same code and the same configuration the runner uses.

### Building it yourself

Building needs one `npm install`, and it is the only one in the project:

```
cd desktop
npm install          # downloads Electron (~120 MB) and electron-builder
npm start            # run it now, unpackaged, to see if you like it
npm run dist:mac     # build the macOS .dmg files  (must be run on a Mac)
npm run dist:win     # build the Windows installers (run it on Windows)
```

Finished installers land in `desktop/dist/`, named as above.

Two honest limits on cross-building, and they are the reason the workflow above
exists at all:

- **A macOS `.dmg` can only be built on a Mac.** It needs Apple's own tools.
- **Building the Windows installers from a Mac or Linux needs Wine**, and it
  frequently does not work. Build them on Windows, or let the Windows runner do
  it.

`npm install` here installs Electron and electron-builder as *development*
dependencies of the shell only. Nothing from npm ends up in the Zelos core,
and the core still has zero dependencies — you can confirm that by looking at
the top-level `package.json`, which has no `dependencies` field at all.

---

## Installing on macOS — and what you will actually see

**In plain English first.** Your Mac shows a warning the first time you open
Zelos because its publisher has not been verified by Apple. Only continue if
you trust this release. Here is what to click: press **Done** on the warning
(not *Move to Trash*), then open **System Settings → Privacy & Security**,
scroll to the bottom, and press **Open Anyway**. Everything below this paragraph
is the technical explanation of why.

**These builds are ad-hoc signed and not notarized**, and the difference between
those two words is the whole of this section.

`desktop/package.json` sets `"identity": "-"`, which is an *ad-hoc* signature:
it satisfies the loader on Apple Silicon, and it identifies **nobody**. It also
sets `"notarize": false` and `"hardenedRuntime": false`. So there is a signature
on the bundle, and it vouches for no one — nobody has paid Apple the **$99 a
year** the Developer Program costs, and nothing has been through Apple's
notary service. macOS therefore treats these builds the way it treats any
unknown app. This is not a bug to work around quietly; it is the trade, and you
should know exactly what you are agreeing to before you click past a security
warning.

1. Open the `.dmg`, drag **Zelos** to **Applications**, eject the disk image.
2. Double-click Zelos in Applications. macOS refuses:

   > **Apple could not verify "Zelos" is free of malware that may harm your
   > Mac or compromise your privacy.**
   > `Move to Trash` `Done`

   (On macOS 14 and earlier the wording is *""Zelos" cannot be opened because
   the developer cannot be verified."*)

   Click **Done**. Do not move it to the trash.
3. Open **System Settings → Privacy & Security** and scroll down to the
   **Security** section. There will be a line that just appeared:

   > **"Zelos" was blocked to protect your Mac.**  `Open Anyway`

4. Click **Open Anyway** and authenticate with Touch ID or your password.
5. One more confirmation appears — *"macOS cannot verify the developer of
   "Zelos". Are you sure you want to open it?"* — click **Open**.

macOS remembers. You will not be asked again.

**On macOS 14 and earlier** there is a shortcut: Control-click (right-click) the
app in Finder → **Open** → **Open**. Apple removed that path in macOS 15, which
is why the System Settings route above is the one that works everywhere.

**From the Terminal**, if you prefer:

```
xattr -d com.apple.quarantine /Applications/Zelos.app
```

That deletes the "downloaded from the internet" flag macOS attaches to the file.
It is a real safety mechanism — only strip it from something you built yourself
or fetched deliberately, and never because a web page told you to.

### If it says "Zelos is damaged and can't be opened"

On Apple Silicon, every executable needs at least an ad-hoc signature, and an
unsigned build gets refused with that misleading message. Sign it locally:

```
codesign --force --deep --sign - /Applications/Zelos.app
```

`--sign -` is the same *ad-hoc* signature the build already applies
(`mac.identity: "-"` in `desktop/package.json`): it identifies nobody, it just
satisfies the loader. So a build you made yourself should not hit this — the fix
is here for a bundle that was modified after it was signed, which invalidates
the signature.

---

## Installing on Windows — and what you will actually see

**In plain English first.** Windows shows a blue box that says **Windows
protected your PC** the first time you run the installer. Click **More info**,
then **Run anyway** only if you trust this release. Windows cannot verify the
publisher of these installers. Everything below this paragraph explains why.

**These builds are not signed at all** — not even ad-hoc. There is no signing
configuration in the `win` block of `desktop/package.json`, so nothing is
applied. (The macOS builds do carry an ad-hoc signature; Windows carries none.
The $99 figure in the macOS section is Apple's Developer Program and buys you
nothing here — a Windows certificate is a separate purchase from a certificate
authority at its own price.) A code-signing certificate is a bill that
arrives every year, and this project does not pay it, so the installer reaches
you with no publisher name attached and no reputation with Microsoft. Windows
will say so, in a dialog designed to stop you, and it is right to. This is not a
bug to work around quietly; it is the trade, and you should know exactly what
you are agreeing to before you click past a security warning. The reason it is
reasonable to click past *this* one is that you can read the source and build
the installer yourself.

1. **Take the installer that matches your machine.**
   `Zelos-1.8.1-setup-x64.exe` for an ordinary PC, `-arm64` for Windows on ARM,
   or the combined installer if you are not sure. The wrong one either runs
   slowly under emulation or does not run at all.
2. **Your browser may refuse to keep the file.** Edge says *"…setup.exe was
   blocked because it could harm your device"*; Chrome says *"…isn't commonly
   downloaded"*. Open the downloads list, click the **…** beside the file, and
   choose **Keep** — then **Keep anyway** on the confirmation that follows.
3. **Run it, and Windows stops it.** A blue full-window dialog:

   > **Windows protected your PC**
   > Microsoft Defender SmartScreen prevented an unrecognized app from starting.
   > Running this app might put your PC at risk.
   > `Don't run`

   **The button you need is not on screen yet.** The only other thing on that
   dialog is a small **More info** link under the message text. Click it. It
   expands to show the file name and *Publisher: Unknown publisher*, and a
   **Run anyway** button appears next to **Don't run**. Click **Run anyway**.

   That is SmartScreen's entire objection: it has not seen this file before and
   nobody it recognises vouches for it. Signing would replace *Unknown
   publisher* with a name. It would not make the app safer — it would make it
   more expensive to hand out.
4. **The installer does not need an administrator.** It installs per-user, so
   Windows does not ask for an admin password, and it goes to
   `C:\Users\<you>\AppData\Local\Programs\Zelos`. You can change that path
   during setup. It offers a Start menu entry and a desktop shortcut, and
   launches Zelos when it finishes.

The warning is about the *downloaded file*, so it is the installer that trips
it. Starting Zelos afterwards from the Start menu should not raise it again.

**If you would rather deal with it before running anything**, Windows keeps a
"this came from the internet" marker on the file, exactly as macOS does, and you
can clear it first: right-click the `.exe` → **Properties** → tick **Unblock**
at the bottom of the **General** tab → **OK**. In PowerShell that is:

```
Unblock-File .\Zelos-1.8.1-setup-x64.exe
```

That marker is a real safety mechanism — clear it only from something you built
yourself or fetched deliberately, and never because a web page told you to.

To uninstall: **Settings → Apps → Installed apps → Zelos → Uninstall**. It
leaves `C:\Users\<you>\.zelos` alone, on purpose — see **Where your things
live** below.

### One thing that is genuinely weaker on Windows

Zelos asks for `0700` on its home folder and `0600` on every file it writes
there. On Windows those calls do almost nothing — there are no POSIX modes to
set — so the protection around your mail cache is the NTFS ACL your user profile
already carries, which also lets Administrators read it.
[SECURITY.md § 5](SECURITY.md#5-what-leaves-your-machine) states that properly
and is the one place it is kept up to date; if you are on a machine you do not
solely administer, read it before you connect a mail account.

---

## Where your things live

| | macOS / Linux | Windows |
|---|---|---|
| Your data (database, config, logs) | `~/.zelos` | `C:\Users\<you>\.zelos` |
| Window size and position | `~/.zelos/window.json` | same |
| Logs | `~/.zelos/logs/desktop.log` — **desktop app only** | same |
| Secrets | your login Keychain, service `com.zelos.app` (or `secrets.enc` + `.seed` in `~/.zelos` if there is no keychain) | `%LOCALAPPDATA%\Zelos\secrets`, DPAPI-encrypted |
| The shell's browser profile (your theme choice, nothing else) | `~/Library/Application Support/Zelos` | `%APPDATA%\Zelos` |

**There is no `zelos.log`.** The `logs/` directory is created on every launch,
but only the desktop shell ever writes to it, and the file it writes is
`desktop.log`. Run Zelos from a terminal and the log is the terminal — nothing
is written to disk. An empty `~/.zelos/logs/` after a CLI session is correct,
not a fault.

**Uninstalling never deletes `~/.zelos`.** Your mail cache, your board and
your settings survive, on purpose, so that reinstalling does not lose your work.

Getting rid of it is two deliberate steps, and Zelos makes you do both by
hand. There is no "wipe everything" button and no API route that erases the
database — a local server that will destroy your data on request is a local
server some stray web page can be pointed at.

1. Quit Zelos, then delete the folder: `rm -rf ~/.zelos`
   (Windows: delete `C:\Users\<you>\.zelos`). If you installed the command
   globally, remove it too: `npm uninstall -g zelos-app`. (`npx` leaves nothing
   behind but an npm cache entry, which npm clears on its own.)
2. Your mail passwords and API keys are usually **not in that folder** — but
   check, because there is one case where they are. On macOS they are in your
   login keychain under the service `com.zelos.app` — remove them with Keychain
   Access. On Windows they are DPAPI-encrypted files in
   `%LOCALAPPDATA%\Zelos\secrets` — delete that folder. On Linux they are in
   your desktop keyring under the same service name. **If no keychain was
   available**, they are `secrets.enc` in `~/.zelos`, decrypted by `.seed` in
   the same folder, and step 1 has already deleted both. **Settings → About**
   tells you which store your machine actually ended up using, and so does
   `zelos doctor`; the folder itself now records the answer in
   `secrets.backend.json`.

**Settings → Your data** inside the app shows the exact path and offers a board
snapshot containing the current board and settings without passwords. The desktop
app also offers backup and restore; a board snapshot alone cannot restore the full archive. The
`Board → Show data folder` and `Board → Show logs` menu items open these
directly.

---

## Honest notes about these builds

- **macOS: ad-hoc signed, not notarized. Windows: not signed at all.** Every
  warning above is macOS and Windows doing their job. You are choosing to trust
  a build; the reason that is a reasonable choice here is that you can read the
  source and, if you want, produce the build yourself.
- **Windows is built and tested, but nobody has lived with it.** The suite runs
  on Windows as well as macOS and Linux, on four Node versions each, on every
  push to `main` and every pull request — and the installers are packaged on a
  Windows runner that has to go green first. That says the code runs there and
  the package builds. It does not say the experience is good: no person has
  installed Zelos on Windows and used it for a week. The tray behaviour, the
  shortcuts and the dialog wording above are what the tests, the build
  configuration and Windows itself say they are, not something anyone has sat
  and watched. If something is wrong on that side, it will not already have been
  noticed — which is a reason to report it, not a reason to assume it is you.
- **The app is shipped unpacked, on purpose.** Most Electron apps bundle their
  code into an opaque `app.asar` archive. Zelos does not: `asar` is off in the
  build configuration. Open `/Applications/Zelos.app/Contents/Resources/`
  (right-click the app → Show Package Contents) and you will find `core/`,
  `ui/`, `assets/` and the shell itself in `app/` as ordinary readable files —
  byte for byte the ones in this repository. An app whose entire claim is "you
  can check what it does" should not hide its own code. Diff them against a
  clone if you want to be sure.
- **No auto-update, at all.** The app never contacts a server to ask whether it
  is old. Check back here yourself when you want a newer version, and install it
  the same way.
- **One copy at a time, and it tells you rather than stopping you.** Launching
  the app while the app is already running brings the existing window forward.
  The other pairing — a `zelos` running in a terminal and the app in the tray,
  both pointed at the same home — is caught differently: both write a
  `zelos.lock` in the data directory, and the second one to arrive *warns* you,
  naming what it thinks is already running and where its board is. It does not
  refuse. That check reads a file to guess whether another process is alive,
  and a guess is occasionally wrong; a wrong guess that could stop you opening
  your own app would be a worse bug than the overlap it prevents. If you know
  nothing else is running, the warning tells you which file to delete. What the
  overlap actually costs, if you do run two: the same mail fetched twice and
  the same model calls paid for twice.
- **The desktop board is not reachable from your browser.** The shell keeps the
  session token to itself and never prints it. If you want the board in your own
  browser, use Path 1 or Path 2, where the launcher prints the URL for you.
- **Architecture matters on both platforms.** Take the `arm64` build for Apple
  Silicon and Windows on ARM, and the `x64` build for Intel Macs and ordinary
  PCs. The wrong one either runs slowly under emulation or does not run at all.
  Windows is the one place you can dodge the question, by taking the combined
  installer instead; it is larger because it contains both.

---

## Troubleshooting

**Start here: `zelos doctor`.** It is the shortest path from "it isn't working"
to "here is the line to fix", and it names the specific next action rather than
the exception it caught. From source that is `node zelos.mjs doctor`; in the
desktop app, **Settings → About** shows the same findings.

**"Zelos could not start" on launch.**
Almost always a port or a data folder problem. The dialog names the actual
error. If another Zelos is already running, quit that one first. To use a
different port: `open -a Zelos --args --port 7788` on macOS, or add
`--port 7788` to the shortcut's target on Windows.

**The window is blank.**
Use `Board → Reload board` (⌘R / Ctrl+R). It reloads the URL the shell holds,
token included — an ordinary browser refresh would not.

**Links do not open.**
By design, only `http`, `https` and `mailto` links leave the app, and they open
in your normal browser rather than inside the window. Anything else — `file:`,
`data:`, or an app-specific scheme like `zoommtg:` — is refused outright and
logged. Mail is written by strangers; a link in it does not get to reach into
this machine.

**Where did the app go when I closed the window?**
It is in the tray (macOS: the menu bar, top right). That is where **Check now**,
**Open Zelos** and **Quit** live. On Windows this only happens when automatic
sweeps are switched on; with them off, closing the window quits. On Linux,
closing the window quits even with sweeps on, unless you have set
`ZELOS_TRAY_RESIDENT=1` — see "What the shell adds" above for why.

**Something is wrong and I want to see why.**
Run `zelos doctor` first. If you want the raw record after that:
`Board → Show logs`, then open `desktop.log`. Passwords and API keys are
redacted before anything is written, so the file is safe to read and safe to
send to someone — but read it first anyway.
