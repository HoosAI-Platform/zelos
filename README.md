# Zelos

**A local-first second brain.** It reads your mail and your calendar, works out what actually
needs you, and hands you one page: what needs you now, what you owe, what owes you, what is coming.

It runs on your own machine, stores everything in one directory you control, and thinks with
whatever model you choose — including one running on your own desk.

→ **[zelos-app.netlify.app](https://zelos-app.netlify.app)** · [live demo](https://zelos-app.netlify.app/demo/) · MIT

---

## Zero dependencies

Not "few" — zero. There is no `dependencies` block, no top-level `node_modules`, no postinstall
script, nothing to audit but the code itself. (`desktop/` has its own `package.json` with Electron
and electron-builder as `devDependencies` — they build a window and never reach the core, and none
of them ships in the published package.)

That is not asceticism. It is the product's central claim: an app that reads your mail should not
ask you to trust a supply chain you cannot see. Everything is Node built-ins — `node:sqlite`
(with FTS5 compiled in), `node:tls`, `node:http`, `node:crypto`, `node:test`, and global `fetch`.

The consequence is that the IMAP client, the MIME and RFC 2047 decoders, the RFC 5545 parser with
RRULE expansion, the CalDAV client and the model adapter are all written here, from the RFCs.
About **42,700 lines** of JavaScript in `core/`, `ui/` and `zelos.mjs`, and a test suite that is
**larger than the code it tests** — about 44,400 lines in `test/`. Count them yourself:

```bash
{ find core ui -name '*.mjs' -o -name '*.js'; echo zelos.mjs; } | xargs wc -l | tail -1
wc -l test/*.mjs | tail -1
```

## Run it

**Not a programmer?** Download the Mac or Windows app from
[zelos-app.netlify.app](https://zelos-app.netlify.app/#download) and skip this section. The site
says what to click the first time your computer warns you about it, and if you get stuck on any
step, [zelos-app.netlify.app/help](https://zelos-app.netlify.app/help) has a message written for
Claude that walks you through that step.

```bash
node zelos.mjs
```

Node **22.16+ or 24+**. Not "22 or newer": Zelos's index needs SQLite's FTS5 extension, and Node's
bundled SQLite is built without it before 22.16 and throughout the whole Node 23 line. On a runtime
that lacks it, Zelos refuses to start and names the versions that work.

It opens in your browser at `127.0.0.1` and stays there. Nothing to install, no account, no server.
To connect a mailbox, type your email address. Gmail, iCloud, Yahoo, Fastmail and a server of your
own get one button to the page where your provider makes an app password, and **Connect** does the
rest. **Sign in with Google** and **Sign in with Microsoft** are built and wired — the Google one
comes back to Zelos on `127.0.0.1` — but the client registrations they run against are not shipped
yet: `DEFAULT_OAUTH_CLIENTS` in `core/sources/oauth.mjs` is blank for both, so today each needs a
registration of your own, pasted in under Settings → Mail. That matters most for a personal
Outlook, Hotmail, Live or MSN address, which Microsoft no longer lets in with a password at all: a
one-time, ten-minute registration at Microsoft's site is the way in until Zelos ships its own.
[docs/OAUTH.md](docs/OAUTH.md) has what the sign-ins send where, what registering each takes, and
what Google's review of them costs.

```bash
node zelos.mjs              # open Zelos
node zelos.mjs sweep        # check sources once and assess what changed
node zelos.mjs doctor       # diagnose setup problems
node zelos.mjs mcp          # expose the enabled MCP tools over standard input/output
```

The source download runs without installing dependencies. Desktop installers include
Node and need no terminal setup. The npm package is not part of this release.
[Installation and updates](docs/INSTALL.md) · [Release notes](docs/RELEASE-NOTES.md).

In the desktop app, **Settings → Your data** creates and restores private backups.
Item cards offer **More → What changed?** for recorded deadline, priority and status changes.
The **Commands** button, or **⌘/Ctrl+Shift+P**, searches navigation and common actions.
Connection warnings lead to the relevant account, and **Settings → About → Check for updates**
checks the official release. A signed desktop app also updates itself, with your say on the restart —
see [What leaves your machine](#what-leaves-your-machine).

Seven MCP tools, none of which sends, deletes or reconfigures anything. Six declare `readOnlyHint`;
`zelos_board` does not, because reading the board does what opening the window does — wakes a snooze
that has come due, and holds the `now` bucket to four items. [docs/SECURITY.md § 6a](docs/SECURITY.md)
has the exact extent of it.

## What leaves your machine

Three things by default, and you chose all three: your mail provider, your calendar address, and
your model endpoint — plus one host for each source you add in Settings → Sources, which is also
an address you chose. Each connector names its host (`origins` in `core/connectors/*.mjs`) and the
one transport they all share (`core/connectors/http.mjs`) refuses any other. Signing in with Google
or Microsoft adds that provider's sign-in service — `accounts.google.com` and
`oauth2.googleapis.com`, or `login.microsoftonline.com` — for the length of the sign-in and of each
token refresh, and still no Zelos server. Of all of those, only
the model request carries what Zelos read; point it at a local model and nothing it read leaves at
all. **Update checks** go to the official GitHub release API, without account content or
credentials: when you press **Check for updates**, and in a signed desktop app with automatic updates
on (the default; Settings → About turns it off), when the app opens and every six hours. A newer
release is then fetched from that release's own files on GitHub (on a Mac, when you choose
**Restart to update**), checked against the publisher's code signature, and installed only when you
choose **Restart to update**. Builds that are not yet
signed — which today is all of them — check only when you ask. No telemetry, analytics or crash reports.

Your keys live in your operating system's keychain — **when there is one**. With no keychain
available (a headless Linux box, or a desktop without `secret-tool`), they go to `secrets.enc` in
`~/.zelos`, encrypted with a key held in `.seed` **in the same folder**. A copied credential file
needs that seed to decrypt it; anything running as you can read both files. Zelos says so in
the app, and `zelos doctor` says which backend this home is actually on. A backup containing
both files can decrypt those credentials: keep it private. Guided backups are not password protected.

On macOS and Linux the database is `0600` inside a `0700` home; on Windows there are no POSIX modes
to set, so the protection is the ACL on your user profile — see
[docs/SECURITY.md](docs/SECURITY.md#5-what-leaves-your-machine) for what that does and does not buy
you.

The local server binds `127.0.0.1` only, mints a new session token every launch, and rejects foreign
origins. Every route in the router's table needs that token. **One path is not in
that table:** `POST /api/mcp`, the channel an AI client uses. It is lifted out of the pipeline
*before* the session gate because it takes the separate AI token you mint in Settings, and the two
credentials work in neither direction — the session gate returns 401 for an AI token, and the MCP
gate ignores `X-Zelos-Token` entirely. The loopback bind, the `Host` check and the `Origin` check
apply to it unchanged, so a web page cannot reach it even holding a stolen bearer token. A second
one, `GET /oauth/callback`, is where Google's sign-in redirect lands; a browser redirect cannot
carry a token, so that route takes none and is held instead to `127.0.0.1`, to a `state` that
matches a sign-in still in progress, and to a reply page with nothing in it —
[docs/SECURITY.md § 6](docs/SECURITY.md) has the exact extent.

**One thing said plainly:** your mail is written by other people, so a message can contain text
aimed at the model. Zelos never acts on what the model says — it renders, and you click. That is a
stronger guarantee than claiming a model cannot be fooled. See [docs/SECURITY.md](docs/SECURITY.md).

## Any model

Two wire protocols (`openai` and `anthropic`) cover every hosted provider and every local runtime.
Settings probes the usual local ports — Ollama 11434, LM Studio 1234, llama.cpp 8080, vLLM 8000 —
and offers whatever is already running before it offers you a paid one.

## Tests

```bash
node --test test/*.test.mjs
```

Including an adversarial security suite: exploit tests for credential leaks, path traversal, DNS
rebinding, FTS injection, token forgery and MCP scope escapes.

## Docs

| | |
|---|---|
| [docs/README.md](docs/README.md) | the long version |
| [docs/INSTALL.md](docs/INSTALL.md) | installing, including the unsigned-app dance |
| [docs/SECURITY.md](docs/SECURITY.md) | the threat model, stated honestly |
| [docs/SPEC.md](docs/SPEC.md) · [docs/SPEC-v2.md](docs/SPEC-v2.md) | what it is meant to do |
| [docs/OAUTH.md](docs/OAUTH.md) | how Sign in with Google and Sign in with Microsoft work, and what registering them takes |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | the Google review kit: scope justification, demo shot list, CASA checklist |

## Licence

MIT.
