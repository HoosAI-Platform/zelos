# Zelos v2 — integration contract for the AI-access, packaging and onboarding work

Read `docs/SPEC.md` first; it still governs. Everything here is additive. The v1 constraints hold
without exception — **zero third-party runtime dependencies**, ESM, `127.0.0.1` only, secrets never
in argv or logs, and the app never acts on model output.

---

## 1. Zelos as a knowledge source for someone else's AI

The ask: *"use this as a master knowledge source for their AI, set up an API directly with it, and
select what data comes and goes from that API."*

That is **MCP** — the protocol every current AI client speaks. Zelos becomes a server their
assistant connects to, exposing the mail, calendar and board it has already indexed.

### The governing principle

**Off by default, and scoped by the user, forever.** Zelos exists because people don't want their
mail on someone else's computer. An AI-access feature that is loose by default would betray the
entire product. So:

- The master switch starts **off**. Nothing is exposed until a human turns it on.
- Every scope is **individually** toggled. Turning on "calendar" must not turn on "mail bodies".
- The panel states, in plain words, what each scope actually hands over.
- Access needs a token the user mints, can name, can see the last-used time of, and can revoke.
- Every MCP call is logged locally with the tool, the scope, and how many rows it returned, and
  that log is visible in the UI. Someone must be able to answer "what did my AI read?"

### `core/mcp.mjs` — the server

Implement MCP over **JSON-RPC 2.0**, both transports:
- **stdio** — `zelos mcp` runs a server on stdin/stdout. This is what desktop AI clients spawn.
  The desktop app's block runs the app's own binary with `ELECTRON_RUN_AS_NODE=1` on
  `core/mcp-stdio.mjs`, because Electron's own start-up writes to stdout before any app code
  runs (TT-3507); `core/mcp-stdio.mjs` `stdioLaunch` builds that command for Settings and CI.
- **HTTP** — `POST /api/mcp` on the existing local server, token-gated, for clients that prefer it.

```js
export const SCOPES        // the closed set, see below
export function toolsFor(scopes)                  // -> MCP tool descriptors the scopes allow
export async function handle(request, ctx)        // -> JSON-RPC response
export function createStdioServer({ db, config, logger })
export async function serveStdio(opts)            // runs until stdin closes
```

Implement at least `initialize`, `tools/list`, `tools/call`, and `ping`. Unknown methods get a
proper JSON-RPC error, never a crash.

### Scopes — a closed set, stored in `config.ai.scopes`

| scope | tool(s) | what it actually hands over |
|---|---|---|
| `board` | `zelos_board`, `zelos_item` | the triaged items: headline, why, bucket, due, person |
| `calendar` | `zelos_calendar` | events in a window: title, time, location, attendees |
| `mail.metadata` | `zelos_search`, `zelos_thread` | sender, subject, date, snippet — **no body** |
| `mail.bodies` | upgrades the above | full message text. Implies `mail.metadata`. |
| `drafts` | `zelos_drafts` | drafts Zelos has written |
| `people` | `zelos_people` | who you correspond with, and how recently |

`mail.bodies` is the one that matters. It must be **off** unless explicitly enabled, must be
visibly marked as the most exposing choice, and enabling it must not be a side effect of anything.

Config shape:
```jsonc
"ai": {
  "enabled": false,
  "scopes": { "board": true, "calendar": true, "mail.metadata": false,
              "mail.bodies": false, "drafts": false, "people": false },
  "tokens": [{ "id": "t_x", "label": "Claude Desktop", "ref": "ai.t_x",
               "createdAt": "…", "lastUsedAt": null }],
  "maxRows": 50
}
```
Token *values* live in the secret store like every other credential — `config.json` holds refs.

**Never expose a tool that sends, deletes or reconfigures.** That held and still holds.

**"Read-only" did not, and the spec was wrong to state it flatly.** `zelos_board` performs the
same board repair opening the app performs — a due snooze wakes (`WAKE_DUE_SNOOZES` in
`core/db.mjs`) and the `now` bucket is held to four items (`capNowBucket` in `core/sweep.mjs`,
which demotes, never deletes). A board read that skipped it would hand an AI a different board
from the one on the user's screen, which is worse than the write. So the requirement is:

- Six tools carry `readOnlyHint: true`. `zelos_board` carries `readOnlyHint: false`, because that
  is the field an MCP host reads to decide it may run a tool without asking the owner.
- The write is confined to `items`, to the columns those two rules own — `state`,
  `snoozed_until`, `bucket`, plus the `state_at`/`updated_at` stamps — and to the `item_history`
  row that records each such change as `automatic`, exactly as the app's own repair does. Apart
  from those and `ai_access_log` — every tool call adds a row, and the log trims itself to the
  newest 5,000 — no other table moves, the search index does not move, and no item is created,
  deleted or finished.
- The split is **measured**, not asserted: run every tool against a real database and the set that
  changed a row must equal the set that does not claim `readOnlyHint`.

### `ui/views/settings.js` — an "AI access" panel

New panel between Privacy and Data. It must contain: the master switch; one row per scope with an
honest one-line description; token minting (show the value **once**, at creation, because it can
never be read back); a revoke button; the recent-access log; and a copy-paste config block for
Claude Desktop / a generic MCP client with the real path filled in.

---

## 2. `npx zelos-app`

The npm name `zelos` is taken, so the package is `zelos-app`. **It is not registered and not
published** — `npm view zelos-app` answers 404, so `npx zelos-app` does not work today. Publishing
is the operator's call — prepare it, do not publish. Any document that prints the `npx` line
without saying this is sending a reader to an error.

- `package.json`: `name: "zelos-app"`, `bin: { "zelos": "./zelos.mjs" }`, `files` allowlisting
  exactly what ships (§3's negation of `core/sources/oauth.mjs` is gone — sign-in shipped, so the
  file ships too), and **still no dependencies**. `engines.node` is **`">=22.16.0 <23 || >=24"`**, not the `>= 22.5.0` this spec
  first asked for: the board's index needs SQLite FTS5, and Node's bundled SQLite is built without
  it before 22.16 and throughout the whole Node 23 line. The exclusion of 23 is deliberate.
- `npx zelos-app` must start the app. `npm i -g zelos-app && zelos` must work too.
- `npm pack --dry-run` currently reports **69 files, ~740 kB packed, 2.3 MB unpacked**. Editing
  `docs/*.md` moves that number, since they ship — measure, don't quote.
- Subcommands, parsed in `zelos.mjs`: bare (run), `mcp` (stdio MCP), `sweep` (one sweep, print a
  summary, exit), `doctor` (check Node version, home dir perms, model reachability, source
  connectivity — and print what is wrong in words a non-programmer can act on).
- `npm pack` must produce a tarball that runs from a clean extract. Verify that, don't assume it.

---

## 3. OAuth: wired for mail, with no client ids shipped

Researched and settled — do not re-litigate:

- **Google Calendar** read is a **sensitive** scope: verification only (~10 days, demo video,
  privacy policy, verified domain). **No CASA, no annual audit, no fee.** Genuinely achievable.
- **Gmail** read is a **restricted** scope: CASA Tier 2, ~$540–1,000, re-assessed annually,
  4–12 weeks. A real commitment, not a paperwork step.
- **Microsoft** needs a multi-tenant Entra app plus publisher verification (Partner One ID +
  verified domain). No CASA equivalent.

So: build `core/sources/oauth.mjs` implementing **OAuth 2.0 + PKCE with a loopback redirect** —
the correct flow for a desktop app, and the one that needs no client secret. Refresh tokens go in
the secret store. **Do not wire Gmail.** IMAP stays the supported mail path. (Since reversed:
Gmail sign-in is wired, over IMAP with XOAUTH2 — `docs/OAUTH.md` § Why sign-in has the decision.)

**Status: wired end to end for mail; no client ids ship.** Settings → Email offers **Sign in with
Google** and **Sign in with Microsoft**. Google is Authorization Code + PKCE back to
`GET /oauth/callback` on the Zelos port; Microsoft is the device code (`core/sources/imap.mjs` § 6);
either grant is used as XOAUTH2 over IMAP. What is missing is the registrations:
`DEFAULT_OAUTH_CLIENTS` in `core/sources/oauth.mjs` is blank, so each sign-in needs the user's own
Google Cloud or Entra client id, pasted into the sign-in panel or set as
`config.oauth.clients.<provider>`, and `POST /api/mail/guess` answers `clientReady: false` until
one exists. That bites hardest on personal Microsoft accounts (Outlook.com, Hotmail, Live):
Microsoft accepts no password from a mail app there, so without a registration they have no way
in at all. Calendars do not use OAuth: `CALENDAR_KINDS` is still `['ics','caldav','file']`.
`docs/OAUTH.md` has both flows and what shipping Zelos's own registrations takes.

---

## 4. Onboarding

Cut the first run to the shortest honest path.

- **One screen to a usable app.** Detect a local model and offer it as one click; if none is
  running, the top choice is still "skip and look around", not a form.
- `zelos doctor` output should be reachable from the UI when something is wrong.
- The app-password step is where people fall off. Give the exact per-provider link, say plainly
  that the normal password will not work and why, and validate the connection before moving on.
- A **"Try it with sample data"** button so someone can see the board before connecting anything.
  It must be obvious that it is sample data and one click to clear. **Implemented not as a scratch
  home but as an exactly reversible seed into the real database**: `POST /api/sample-data` writes a
  manifest into `kv` listing every row it created, `DELETE` removes exactly those rows and nothing
  else, and `GET` reports `{installed, version, seededAt, counts, summary}`. A scratch home would
  have needed a second database and a way to swap between them; a manifest is one row and is
  auditable.

## 5. Tests

Everything above ships with tests in `test/`, run with `node --test "test/*.test.mjs"`.
Required: scope enforcement (a disabled scope's tool is absent from `tools/list` **and** refused by
`tools/call`); `mail.bodies` off means no body text in any response; token auth required and
revocation effective; JSON-RPC error shapes; `npm pack` extract runs; `doctor` exits non-zero when
something is genuinely wrong.

"No write-capable tool exists" is replaced by the measured version in §1: **run every tool against
a seeded database and assert that the set of tools that changed a row is exactly the set that does
not claim `readOnlyHint`.** The old wording was satisfiable by a test that looked at the source and
found nothing — which is what happened, for months, while `zelos_board` wrote. The fixture matters
as much as the assertion: it needs five `now` items and a snooze already past its wake-up time, or
both writes are no-ops and the test passes by proving nothing.

Two more that exist because their absence hid a real hole: **the route lists these suites iterate
must be parsed out of `core/server.mjs`'s `ROUTES`**, never restated by hand, and any probe of a
derived path must prove the path reaches the router. Note that `test/security.test.mjs` and
`test/ai-security.test.mjs` contain raw NUL bytes as payloads, so `grep` needs `-a` on them.
