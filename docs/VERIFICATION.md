# The Google verification kit

What goes into the submission for `https://mail.google.com/`, written so it can be pasted. The
process around it — why the scope is restricted, what Testing mode costs users, what CASA is and
when it recurs — is in [OAUTH.md](OAUTH.md); this page is only the three things a reviewer and an
assessor will ask for. Every Google rule quoted here is sourced at the bottom of OAUTH.md.

Three things to have before opening the form: a domain Zelos owns, verified in Search Console, with
the site and `/privacy` on it; the consent screen filled in against that domain; the client id from
that project in the build you will film. Google will not take the submission without the first and
will reject it without the third matching the video.

---

## 1. Scope justification — `https://mail.google.com/`

Written for the reviewer, against the two things Google's own pages say they check: that the scope
is the narrowest one that works, and that an IMAP app which does not need permanent delete "will
need to migrate to the Gmail API" (OAuth verification FAQ, *IMAP / SMTP*). Paste as is; the
bracketed line at the end is the one to edit.

> **What Zelos is.** Zelos is an open-source (MIT) desktop application that runs entirely on the
> user's own computer. It reads the user's mailbox and calendar, asks a language model of the
> user's choosing which messages need a reply, a decision, or a follow-up, and shows the result on
> one page. It has no server of its own: there is no Zelos account, no Zelos backend, and no
> endpoint operated by us that user data is ever sent to. Source: github.com/HoosAI-Platform/zelos.
>
> **What the scope is used for.** Zelos connects to `imap.gmail.com` over TLS and authenticates
> with `AUTHENTICATE XOAUTH2` using the access token this scope grants. Over that connection it
> does exactly one thing: it fetches recent messages from `INBOX` (by default the last 14 days, at
> most 400) and, if the user turns it on, from the Sent folder, using `BODY.PEEK` so that no
> message is marked read. It never issues `STORE`, `COPY`, `MOVE`, `APPEND` or `EXPUNGE`; it never
> sends mail (there is no SMTP client in the program); it never deletes, labels, moves or modifies
> anything. The IMAP client is in `core/sources/imap.mjs`, and the absence of every write command
> is checked by the test suite, which is larger than the program.
>
> **Why `https://mail.google.com/` and not a narrower scope.** Zelos reads mail over IMAP, not
> over the Gmail REST API, and Google's own documentation states that "the scope for IMAP, POP,
> and SMTP access is https://mail.google.com/" — there is no narrower scope that opens an IMAP
> session. IMAP is the one protocol Zelos speaks to every mail provider (Gmail, Google Workspace,
> iCloud, Outlook, Yahoo, Fastmail and self-hosted servers alike) through a single client written
> from the RFCs, because the program's central commitment to its users is that it has zero
> third-party dependencies: nothing in it can phone home except through code they can read. A
> Gmail-specific reader under `gmail.readonly` would be a second mail implementation for one
> provider, would still be a restricted scope subject to the same review and assessment, and would
> give Google's users nothing they do not already have — the read-only property is a property of
> what the program does, not of which scope it holds. We request the full-mail scope because it is
> the only scope that fits the protocol, and we use a strict subset of what it permits: read only.
>
> **Where the data goes.** Messages are stored in a SQLite file in the user's home directory
> (`~/.zelos/zelos.db`), on their own disk, with file permissions restricting it to their account.
> The OAuth refresh token is stored in the operating system's keychain (macOS Keychain, Windows
> DPAPI, Linux libsecret), never in a configuration file. The only transfer of message content
> out of the machine is to the language-model endpoint the user has configured — a provider they
> chose and hold their own key for, or a model running locally on `127.0.0.1`, in which case no
> message content leaves the computer at all. That request carries message subjects, addresses,
> dates and bodies (bodies capped at 4,000 characters and switchable off) for the sole purpose of
> producing the user-facing page; it is inference only. Zelos operates no model, trains no model,
> and transfers no data to any model for training.
>
> **Limited Use.** Zelos's use of information received from Google APIs will adhere to Google API
> Services User Data Policy, including the Limited Use requirements. Specifically: Google user
> data is used only to provide the user-facing features visible in the application (the daily
> page, reply drafts the user sends themselves, and search over their own archive); it is not
> transferred to anyone except, at the user's direction, the model endpoint the user configured,
> and then only to provide those features; it is never sold, never used for advertising, never
> used to determine credit-worthiness, and never read by a human at Zelos — there is no Zelos
> server for a human to read it from; and it is never used to create, train or improve a
> machine-learning or AI model, foundational or otherwise.
>
> **Disclosure and revocation.** The privacy policy at `<https://<zelos domain>/privacy>` states
> all of the above, including the Limited Use disclosure verbatim, and is linked from the
> homepage and from the consent screen. The user can remove the account from Zelos, which
> deletes the stored grant from the keychain, and can revoke Zelos's access at
> myaccount.google.com/permissions at any time; either ends all access.
>
> [Contact for this submission: `<project owner address>`.]

**If the reviewer still directs Zelos to the Gmail API.** The fallback is a Gmail-API reader under
`https://www.googleapis.com/auth/gmail.readonly` — also restricted, also assessed, so the cost
and timeline do not change, only the code. Say so in the reply rather than arguing twice; ask
whether the read-only IMAP usage described above is accepted under the "full utilization" language
of the IMAP page, and if the answer is no, build the reader. Do not promise the reader before it
exists.

---

## 2. Demo video — shot list

Google's requirements for the video (Verification requirements § 2): end-to-end flow including the
OAuth grant; the same app name and branding as the submission; the complete consent screen, showing
the exact scopes requested, with its language toggled to English; and the features that use the
scope. Unlisted YouTube is the conventional host. Keep it under four minutes; one take; no edits
between the consent screen and the redirect.

| # | shot | what must be visible | why |
|---|---|---|---|
| 1 | Zelos starting from a terminal: `node zelos.mjs` | the `127.0.0.1:7777` URL in the banner | establishes that the app is local and that the loopback redirect in shot 6 is the same port |
| 2 | The empty board, then **Settings → Mail → Add a mailbox** | the app name *Zelos* in the window title | branding matches the consent screen |
| 3 | Typing a Gmail address | the provider line reading *Google* and the button **Sign in with Google** | the grant is initiated by a user action, with Google's branding |
| 4 | The browser opening on `accounts.google.com` | the address bar, with `client_id=…apps.googleusercontent.com` legible when paused | reviewers match the client id in the URL to the project submitted |
| 5 | The consent screen, in English | *Zelos wants access to your Google Account*, the single scope line *Read, compose, send, and permanently delete all your email from Gmail*, **Continue** | "the complete OAuth Consent Screen … the same exact scopes" |
| 6 | The redirect landing | `http://127.0.0.1:7777/oauth/callback` in the address bar and the page *Signed in. You can close this tab and go back to Zelos.* | shows the loopback redirect and that the page carries no token |
| 7 | Back in Zelos | the mailbox listed as connected, auth *Signed in with Google*, sent folder detected | the grant finished without anything being typed |
| 8 | **Sweep now** | the sweep log counting messages read; the board filling | the feature the scope exists for |
| 9 | Open one item | the message rendered, and the draft reply, which Zelos never sends — you copy it into your own mail client | read-only is a product property, shown rather than claimed |
| 10 | Gmail in another tab | the same messages still unread | `BODY.PEEK` visibly did not change the mailbox |
| 11 | **Settings → Privacy** | *Send message bodies* and the local-model option | the only transfer is to the model the user chose, and it is switchable |
| 12 | Remove the mailbox | the account gone from Settings, and from the list `zelos doctor` prints | deletion on request, which the assessment also asks about |

Film against the production project's client id, not a development one: the submission is rejected
if the id in shot 4 is not the id under review. Do not show a real inbox — use a test account
holding nothing but mail written for the recording.

---

## 3. CASA — what to put in front of the assessor

Google tells you when to start (OAUTH.md § CASA), and the assessor runs the framework; what Zelos
controls is how short the list of findings is. The properties below are the ones the assessment
asks about, each mapped to where the repository proves it. Cite the section, not the sentence —
the sections are tested.

| CASA asks about | Zelos's answer | where it is written down and tested |
|---|---|---|
| architecture; data flows; where Google user data is stored and processed | no Zelos server; the archive is stored on the user's disk in `~/.zelos`; reading and model calls use configured services, sign-in and refresh use the provider's sign-in services, and update checks (manual, and automatic in a desktop app carrying the Zelos update key) use the official GitHub release API without archived content or credentials | [SECURITY.md § 5](SECURITY.md#5-what-leaves-your-machine) — the complete list and its footnotes; [README.md § Count the places it could phone home](README.md) is a grep the test suite keeps true |
| third-party components and supply chain | zero runtime dependencies; Node built-ins only; `package.json` has no `dependencies` key; the desktop shell's Electron is the named exception and never reaches the core | `test/repo.test.mjs` walks every import in the tree; [README.md § Zero dependencies](../README.md) |
| network exposure | the HTTP server binds `127.0.0.1` only; per-launch session token on every API route; `Origin` and `Host` checks; no CORS at any status; a strict CSP | [SECURITY.md § 6](SECURITY.md#6-the-local-http-surface); `test/security.test.mjs` parses the route table out of the router so no route is exempt |
| the OAuth redirect | `GET /oauth/callback` is loopback-only, bound to a pending `state`, exchanges the code immediately with PKCE, stores only the refresh token, and answers a page with no token, address or script | [SECURITY.md § 6 and § 7](SECURITY.md) |
| credential storage | refresh tokens and passwords in the OS keychain (Keychain / DPAPI / libsecret), by reference from config; an encrypted-file fallback whose limits are stated rather than hidden; values never on a command line | [SECURITY.md § 7](SECURITY.md#7-secrets); `test/secrets.test.mjs` |
| token handling | the refresh token is spent only against the provider's own token endpoint; any other origin is refused before a socket opens; access tokens are refreshed a minute early and never logged | `assertTokenEndpoint` in `core/sources/imap.mjs`; the Google counterpart in `core/sources/oauth.mjs` |
| transport security | TLS to every non-loopback host; `STARTTLS` stripping aborts the connection before a credential is sent (`requireTls`) | [SECURITY.md § 5 item 1](SECURITY.md#5-what-leaves-your-machine); `test/imap.test.mjs` |
| logging and telemetry | no telemetry, analytics or crash reporting; update checks carry no user data (SECURITY.md § 5, item 7); logs redact by key name and by value shape | [SECURITY.md § 5 and § 7](SECURITY.md); `core/log.mjs` |
| input handling / injection | mail is treated as hostile input; model output is rendered, never acted on; URLs screened; markup stripped before storage | [SECURITY.md § 2–4](SECURITY.md); `test/safety.test.mjs`, `test/ai-security.test.mjs` |
| data deletion | removing the account deletes the keychain entry; deleting `~/.zelos` deletes every message; no copy exists anywhere else | [SECURITY.md § 7](SECURITY.md#7-secrets); `/privacy` on the site § *Deleting everything* |
| access control to production systems | there are none — no cloud account holds Google user data, so the *Tier 3* deployment review (read-only cloud access for the assessor) has nothing to review | state this in the questionnaire; it is the reason to ask Trust & Safety for the local-only determination in writing |
| secure development | every security claim in SECURITY.md has a test; regressions are marked; CI runs the suite on three operating systems | [SECURITY.md § 8a](SECURITY.md#8a-checking-this-document-instead-of-believing-it) |

Two things to have ready that are not in the repository: the self-assessment questionnaire filled
in with the rows above, and a build the assessor can run — the source archive from the site is the
right one, because it has no Electron in it and nothing to install.

What to expect from the result: a Letter of Validation dated the day it passes, and an email a year
later. The reassessment is a full test whether or not anything changed.
