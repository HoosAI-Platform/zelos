# Sign in with Google, Sign in with Microsoft — how it works and what it takes to ship

Rewritten 2026-08-22 against Google's and Microsoft's own pages, fetched that day. Every number
and rule below carries the page it came from; the list is at the bottom. Where two Google pages
disagree with each other, both are quoted and the cautious reading is taken.

**The short version.** Zelos is for everyone, so the two providers most people use get a real
sign-in button: Google (Gmail and Google Workspace) and Microsoft (Outlook.com, Hotmail, Live,
MSN and Microsoft 365). Both are built to run against **client registrations Zelos itself will
ship** — press the button, approve in the browser, and the mailbox is connected. Those
registrations do not exist yet, so today each sign-in runs against a registration of your
own; the rest of this page is what each flow sends where and what shipping Zelos's own takes.
Everything else — iCloud, Yahoo, AOL, Fastmail, Zoho, Proton Bridge, a self-hosted server — keeps
the app-password path, which is the floor and stays.

The code works today against the operator's own Google Cloud project in **Testing** mode and his
own Entra registration, and it is byte-identical after Google verifies Zelos: the only thing that
changes later is two constants. What Google's verification costs, and what Testing mode does to
users in the meantime, is the second half of this page.

---

## Why sign-in

An app password is a fine credential — it is revocable on its own, scoped to mail, and it is what
every provider but Microsoft still offers. But it is six steps on someone else's website, it needs
two-step verification turned on first, and the first time the operator connected a real mailbox it
went in with no password at all. "Sign in with Google" is what people expect; the previous version
of this page argued for keeping Gmail on app passwords until the audit was worth paying for, and
the product decision is now the other way: pay it, because a second brain that most people cannot
connect in one click is not a mass-market product.

Password stays valid for Gmail — an app password still works over IMAP and always will as far as
Google has said — so sign-in is the front door, not the only door. For personal Microsoft
accounts it is the only door, because Microsoft accepts no password of any kind from a mail app on
those accounts (`core/sources/imap.mjs` § 6 has the date and the reason).

---

## Google — how Zelos's flow works

It is OAuth 2.0 **Authorization Code with PKCE** and a **loopback redirect**, the flow Google
documents for desktop apps ([native-app][g-native]), with one twist: Zelos is already an HTTP
server on `127.0.0.1`, so the redirect lands on the Zelos port rather than on a throwaway listener.

1. **Settings → Mail → Add a mailbox.** You type your address; `describeProvider` answers
   `signIn: 'google'` for `gmail.com` and `googlemail.com`, and `discoverProvider` answers the
   same for a custom domain whose MX records point at Google. The page asks `POST /api/mail/guess`
   and gets `clientReady: true` when a Google client is known — from `DEFAULT_OAUTH_CLIENTS` in the
   shipped build, or from `config.oauth.clients.google` on a self-hoster's machine. The button
   reads **Sign in with Google**.
2. **`POST /api/mail/oauth` with `{ provider: 'google', keyRef, email? }`.** The server mints a
   PKCE verifier and an opaque `state`, remembers both against the flow id, and answers
   `{ id, provider: 'google', authUrl, expiresAt }`. The page opens `authUrl` in your browser.
   That URL is built on `https://accounts.google.com/o/oauth2/v2/auth` with:
   - `scope=https://mail.google.com/` — Google's only scope for IMAP ([xoauth2-protocol][g-imap]:
     "The scope for IMAP, POP, and SMTP access is `https://mail.google.com/`")
   - `access_type=offline` and `prompt=consent`, so Google issues a refresh token and issues it
     every time rather than only the first ([native-app][g-native])
   - `code_challenge` and `code_challenge_method=S256` ([native-app][g-native]: "S256
     (recommended)")
   - `redirect_uri=http://127.0.0.1:<the Zelos port>/oauth/callback` — a loopback address, which
     Google accepts for a Desktop client on any port ([native-app][g-native]: "`http://127.0.0.1:port`
     … start an HTTP listener on a random available port")
   The URL carries no session token, no Zelos secret and no address — not even yours as a
   `login_hint`, because it is a URL handed to the page, and nothing Zelos builds for the page carries
   an address or a token. It carries the client id, which is public
   by design — Google's own words are that installed apps "cannot keep secrets" ([native-app][g-native]).
3. **You approve in the browser.** Google sends the browser to
   `http://127.0.0.1:<port>/oauth/callback?state=…&code=…`. That route is the one place Zelos
   accepts a request with **no session token**, because a browser redirect cannot carry one. In
   its place: the connection must come from `127.0.0.1`; `state` must match a flow that is still
   pending, else a plain `400` with generic text; the `code` is exchanged at once for tokens and
   never stored. The page it answers with is one sentence — *Signed in. You can close this tab and
   go back to Zelos.* — with no script, no token and no address in it, so there is nothing for a
   browser extension or a cache to pick up. `?error=…` marks the flow failed with a generic reason
   and the same kind of page.
4. **The exchange.** `POST https://oauth2.googleapis.com/token` with `grant_type=authorization_code`,
   the `code`, the PKCE `code_verifier`, the `redirect_uri` from step 2, the `client_id`, and the
   `client_secret` **when the client has one**. Google issues a client secret for a Desktop-type
   client and expects it back at exchange, and says in the same breath that it is not actually
   secret in an installed app ([native-app][g-native]: `client_secret` is listed as *Optional*,
   "not applicable to requests from clients registered as Android, iOS, or Chrome applications";
   and "incremental authorization with installed apps is not supported due to the fact that the
   client cannot keep the client_secret confidential"). Zelos supports both shapes.
5. **Storage.** The refresh token goes into the OS keychain under the mailbox's own `keyRef`, in
   the same `{ v: 1, kind: 'xoauth2', accessToken, refreshToken, expiresAt, … }` blob the Microsoft
   flow writes (`saveOAuthTokens` in `core/sources/imap.mjs`) — one secret per account, so removing
   the account removes the grant. The account is saved as `auth: 'xoauth2'` with
   `oauth: { provider: 'google', clientId }`. Nothing about the sign-in lands in `config.json`
   except that block and the `keyRef` name.
6. **Every sweep after that.** When the stored access token is within a minute of expiry, Zelos
   posts the refresh token to `https://oauth2.googleapis.com/token` with
   `grant_type=refresh_token` (+ `client_id`, and `client_secret` when there is one), gets an
   access token good for about an hour, and opens `imap.gmail.com:993` with `AUTHENTICATE XOAUTH2`.
   Same `BODY.PEEK`, same read-only client, same sent-folder detection as a password account.

**What leaves the machine, and when.** During sign-in and on each refresh: `accounts.google.com`
(the consent page, in your browser) and `oauth2.googleapis.com` (the token exchange, from Zelos).
For mail: `imap.gmail.com`, exactly as with an app password. There is no Zelos server in the loop
at any step — there is no server to put in it — and the refresh token never goes anywhere but
`oauth2.googleapis.com`, which the code refuses to substitute.

**Microsoft accounts written before this change** have `oauth: { clientId, tenantId }` with no
`provider`; a missing `provider` is read as `'microsoft'`, so nothing has to be re-connected.

---

## Google — register Zelos's client

This is the operator's checklist. It produces one client id and one client secret. It takes about
twenty minutes and costs nothing; the verification afterwards is the next section.

1. **A Google Cloud project.** [console.cloud.google.com](https://console.cloud.google.com) →
   create a project (say `zelos`). A production app should be its own project, separate from
   anything used for development — Google recommends "separate cloud projects for
   development/testing and production/publishing" and says you should "only submit 'production'
   tier projects for verification" ([submit][g-submit], [not-needed][g-notneeded]).
2. **Enable the Gmail API.** APIs & Services → Library → Gmail API → Enable. It is the API the
   `https://mail.google.com/` scope belongs to, even though Zelos speaks IMAP and never calls the
   REST API.
3. **OAuth consent screen** (Google now calls the page *Google Auth Platform*). User type
   **External**. Fill in ([submit][g-submit] lists every field):
   - **App name** `Zelos`, **User support email**, **App logo** (`assets/` has one; 120×120,
     square).
   - **App home page** `https://zelos-app.netlify.app/` and **App privacy policy**
     `https://zelos-app.netlify.app/privacy` — the page the site ships. Note the trap in the
     verification section below: these must be on a **domain you own and have verified**, and
     a `netlify.app` subdomain is not one.
   - **Authorized domains**: the domain those two URLs are on.
   - **Developer contact information**: an address someone reads. Google's reviewers write to the
     project owners and editors and nowhere else ([submit][g-submit]).
4. **Scopes** → Add or remove scopes → add `https://mail.google.com/`. The console will label it
   *restricted*; that label is what the next section is about.
5. **Test users** — while the app is in **Testing**, only accounts on this list can sign in
   ([submit][g-submit]: the app "will only be available to users you add to the 'test users'
   list"). Add the operator's own accounts and anyone piloting.
6. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app.** Name it
   `Zelos desktop`. Google shows a **Client ID** (`…apps.googleusercontent.com`) and a **Client
   secret**. Copy both. A Desktop client needs no registered redirect URI — the loopback rule
   covers it.
7. **Where they go.**
   - **The shipped build:** `DEFAULT_OAUTH_CLIENTS.google.clientId` in `core/sources/oauth.mjs`.
     That constant is `''` in the repository until Zelos's own registration exists, and is the
     first of the "two constants" this page keeps referring to. The Desktop client's secret has to
     travel with it (step 4 of the flow above); Google's position is that it is not a secret in an
     installed app, and the repository's position is that nothing secret-shaped goes in source —
     both are satisfied by treating it the way Google does, as a public value beside the client id.
   - **A self-hoster with their own project:** `config.oauth.clients.google.clientId` in
     `config.json`, and the secret pasted into Settings, which stores it in the keychain under the
     ref `oauth.google.clientSecret` — `config.json` carries the ref name only, never the value.
     `oauthClient(config, 'google')` reports which one it used as
     `source: 'config' | 'default' | 'none'`.

At this point **Sign in with Google works**, for the accounts on the test-user list, with the
limits below.

---

## Google — what Testing mode means, and what verification and CASA take

### Testing mode: the state the shipped client is in until Google says otherwise

Two hard limits, both from Google's pages:

- **100 users.** An unverified app requesting a sensitive or restricted scope has "a 100 new-user
  cap restriction", and exhausting it ends in "Google sign-in being disabled for your users"
  ([faq][g-faq]). In Testing, "the 100-user cap will be in effect … This cap is removed only after
  an app has been successfully verified" ([not-needed][g-notneeded]).
- **7-day refresh tokens.** "A Google Cloud Platform project with an OAuth consent screen
  configured for an external user type and a publishing status of 'Testing' is issued a refresh
  token expiring in 7 days" ([oauth2 § Refresh token expiration][g-oauth2]). So every Gmail user
  signs in again weekly until verification lands. Zelos reports the expired grant in Settings —
  "This account's sign-in is no longer accepted. Sign in again in Settings → Email." — stops
  retrying it until the account is signed in again, and offers **Sign in again**; it does not
  pretend.

A third, softer one: a Testing app shows Google's tester warning screen ([restricted][g-restricted]:
"a tester warning screen … a user cap is in effect, and the refresh token lifetime is limited").

**Publishing to Production without verification does not help.** The same 100-cap applies to an
unverified production app, the consent page shows the *unverified app* screen, and the Testing
page says plainly that the cap "is removed only after an app has been successfully verified"
([not-needed][g-notneeded], [faq][g-faq]). Production is the state you submit from, not an escape
from review ([submit][g-submit]: "publish your app from 'testing' to 'production' … then click
'Prepare for Verification'").

### The scope is restricted, and IMAP is the reason

Google lists `https://mail.google.com/` first among restricted scopes, and annotates it
"(includes any usage of IMAP, SMTP, and POP3 protocols)" ([restricted scopes][g-restrictedlist]).
The FAQ is blunter: "IMAP and SMTP usage requires using https://mail.google.com/, you will need to
submit your app for the restricted scope verification" ([faq][g-faq]).

**The risk, stated once and early.** The same FAQ answer says the full-mail scope "should only be
requested if your application also needs to immediately and permanently delete threads and
messages, bypassing Trash; all other actions can be performed with less permissive scopes. If your
app does not do this, you will need to migrate to the Gmail API and request less permissive
scopes" ([faq][g-faq]). Zelos deletes nothing, so a reviewer applying that sentence literally could
refuse the IMAP scope and point at the Gmail API. [VERIFICATION.md](VERIFICATION.md) carries the
justification written against exactly that sentence: IMAP is the one mail protocol Zelos speaks,
for every provider, with zero dependencies; Google itself documents `https://mail.google.com/` as
the only scope that opens an IMAP session; and the alternative — a second, Gmail-only reader under
`gmail.readonly` — is also a restricted scope with the same assessment, so it buys Google's users
nothing. If Google still says no, that is the fallback and it is a code change, not a policy one.

### What verification requires

From [Verification requirements][g-reqs] and [Submitting your app][g-submit]:

| what | the rule, in Google's words | for Zelos |
|---|---|---|
| a verified domain | "You must verify that you own all domains listed in your Authorized domains section … using Google Search Console" | **Blocking.** `zelos-app.netlify.app` is Netlify's domain. Zelos needs a domain of its own, verified in Search Console, and the site moved or mirrored onto it before submission. |
| a homepage | "must be hosted on a verified domain you own … must describe your app's functionality … You must add the link of your privacy policy to your homepage" | the front page, with the footer link to `/privacy` it now has |
| a privacy policy | "hosted within the domain that hosts your homepage … linked on your homepage … linked from the OAuth consent screen … must disclose how your app accesses, uses, stores, and/or shares Google user data" and must "conform with Google's Limited use requirements" | `/privacy` on the site: what is read, where it is stored (your disk), what leaves (your model endpoint), the Limited Use sentence verbatim |
| scope justification | "a detailed justification … An explanation why narrower scopes would not work, including specifics on what functionality would not work as intended" | the text in [VERIFICATION.md](VERIFICATION.md) |
| a demo video | "Must show the end-to-end flow of your app including the OAuth grant process … the complete OAuth Consent Screen … the same exact scopes … Must demonstrate the app functionalities that utilize the requested OAuth scopes", in English | the shot list in [VERIFICATION.md](VERIFICATION.md) |
| branding | "Buttons or links that initiate an action on a Google product must follow the Google branding guidelines" | the **Sign in with Google** button follows Google's sign-in button guidance |
| contact | project owners and editors must be reachable; "Failure to act on timely notifications … could result in the loss of access" | keep the project contacts current |

Changes later to "your app's name, logo/icon, redirect URI, homepage link, or privacy policy link"
re-trigger brand verification; adding scopes re-triggers scope review but "does not require your
app to redo a security assessment if you have already completed one" ([changes][g-changes]).

### CASA — the security assessment

- **Who and what.** "Applications requesting access to restricted scopes must undergo an annual
  security assessment … we are leveraging the industry standard App Defense Alliance and its Cloud
  App Security Assessment framework (CASA)." Passing yields a "Letter of Validation" (LOV).
  Applications are assigned "to either the AL1 or AL2 assurance level" ([assessment][g-assess]).
- **Every year, in full.** "All applications must be revalidated every year" ([assessment][g-assess]);
  the 12 months run "from the effective date of the app's previous 'Letter of Validation'", and the
  reassessment is "a comprehensive test of your app, regardless of any changes made to the app"
  ([annual][g-annual]).
- **When.** It is "the final step of the restricted scopes review process … the Google Trust and
  Safety team will contact you when it is time to initiate the security assessment process"
  ([assessment][g-assess]). You do not start it; they tell you to.
- **Cost.** Google charges nothing: "Google does not charge the developer any fees for security
  assessment." The assessor does: "The cost for such a service is agreed on between the developer
  and the assessor without any involvement from Google." There is a self-scan route at the lower
  tier — the FAQ refers to "the free tier 2 assessment" and says that if you would rather not scan
  your own application "you will be required to pay the authorized assessor directly"
  ([faq][g-faq]). **No Google page publishes a price.** The figures the previous version of this
  page carried ($540–$1,000 for the self-serve tier; $15k–$75k for a manual assessment) came from
  third-party write-ups, not from Google, and are repeated here only as an order of magnitude.
  Get quotes from more than one assessor; Google says to.
- **Timeline.** Brand verification "typically takes 2-3 business days"; the restricted-scope
  process "can potentially take several weeks to complete" ([restricted][g-restricted]).
- **Does a local-only app even need it?** Two Google pages suggest not: "Apps accessing restricted
  data from or through a third-party server must undergo an annual security assessment"
  and "If you store or transmit restricted scope data on servers, then you need to complete a
  security assessment" ([restricted][g-restricted]); the Gmail scopes page says the same
  ([gmail scopes][g-gmailscopes]: "If you store restricted scope data on servers (or transmit),
  then you must go through a security assessment"). Zelos has no server and stores everything on
  the user's disk. But the help-centre pages say *every* restricted-scope app is assessed, with no
  carve-out written down ([assessment][g-assess], [reqs][g-reqs]). **Assume CASA applies**, ask
  Trust & Safety for the local-only determination in writing when they make contact, and budget
  as if the answer is no. [VERIFICATION.md](VERIFICATION.md) has the properties to put in front of
  an assessor either way.

### The order of work

1. Buy a domain for Zelos and verify it in Search Console. Everything below is blocked on it.
2. Put the site, with `/privacy`, on that domain. Set the consent screen's homepage, privacy and
   authorized-domain fields to it.
3. Record the video to the shot list. Publish the app to Production. **Prepare for Verification**
   → paste the justification → link the video → **Submit for Verification**.
4. Wait for the brand result (days), then the scope result (weeks), then the email that opens the
   assessment. Get assessor quotes in parallel.
5. When the LOV lands and the scope is approved, nothing in the code changes. The 100-user cap and
   the 7-day token stop applying to the client id already in the build.
6. Put the anniversary of the LOV in a calendar. The reassessment is comprehensive and annual.

---

## Microsoft — register Zelos's multi-tenant public client

Zelos already ships the Microsoft flow — RFC 8628 device code, `core/sources/imap.mjs` § 6 — and
until now it ran only against a registration the user made in their own tenant. The change is that
Zelos ships a registration of its own, so the second of the two constants is the Microsoft client
id. The flow is unchanged: the app shows a code, you type it at `microsoft.com/devicelogin`, the
app polls. What the registration has to look like comes from Microsoft's pages:

1. **Entra admin center** ([entra.microsoft.com](https://entra.microsoft.com)) → **Entra ID → App
   registrations → New registration** ([register][ms-register]).
2. **Name** `Zelos`. Under **Supported account types** choose the option the quickstart labels
   **"Any Entra ID Tenant + Personal Microsoft accounts"** — "For *multitenant* apps that support
   both organizational and personal Microsoft accounts (for example, Skype, Xbox, Live, Hotmail)"
   ([register][ms-register]; older portals word it *Accounts in any organizational directory …
   and personal Microsoft accounts*). This is what lets one client id serve Outlook.com and
   Microsoft 365 alike, against the `common` authority ([multi-tenant][ms-multi]:
   `https://login.microsoftonline.com/common` is "for applications processing accounts in any
   organizational directory … and personal Microsoft accounts").
3. **No redirect URI.** Device code needs none. **Register**, then copy the **Application (client)
   ID** from the Overview page ([register][ms-register]).
4. **Authentication → Advanced settings → Allow public client flows → Yes → Save.** Microsoft's
   desktop-app page ties this switch to exactly this flow: "To distinguish device code flow … from a
   confidential client application … configure it as a public client application … Under Advanced
   settings, for Allow public client flows, select Yes" ([desktop][ms-desktop]). Without it the
   `/devicecode` request is refused.
5. **API permissions → Add a permission → Office 365 Exchange Online → Delegated →
   `IMAP.AccessAsUser.All`**, and **Microsoft Graph → Delegated → `offline_access`**. The v2
   endpoint consents to whatever scopes the request names, so these are documentation of intent as
   much as configuration; what Zelos actually asks for is `MS_IMAP_SCOPES` in `imap.mjs`:
   `https://outlook.office.com/IMAP.AccessAsUser.All` and `offline_access`. Both come from
   Microsoft's IMAP page ([ms-imap]: the IMAP permission scope string, and "you can request for
   offline_access scope. When a user approves the offline_access scope, your app can receive
   refresh tokens"). That page also says the OAuth IMAP support "is available for both Microsoft
   365 … and Outlook.com users" — one registration, both audiences.
6. **Branding & properties → Publisher domain** — set it to Zelos's domain once there is one
   ([publisher domain][ms-pubdomain]). A multi-tenant app registered after 30 November 2020 whose
   publisher is not verified shows **unverified** on the consent prompt with no domain beside it.
7. **Publisher verification** — optional for launch, worth doing. Requirements
   ([publisher verification][ms-pubver]): a Microsoft AI Cloud Partner Program account with a
   Partner One ID that has completed verification; the app registered from a work or school account
   (not a personal one); a publisher domain that is not `*.onmicrosoft.com`; the verifying user in
   an Application Administrator role, signed in with MFA. "Microsoft doesn't charge developers for
   publisher verification", and "Developers who have already met these requirements can be verified
   in minutes."

   **Who it matters for.** Microsoft's block is on the organisation side: since November 2020, in
   tenants with risk-based step-up consent enabled, "users can't consent to most newly registered
   multitenant apps that *aren't* publisher verified" when the app asks for more than basic sign-in
   from a tenant other than its own ([publisher verification][ms-pubver]). That is a Microsoft 365
   work-account problem. A personal Outlook.com account is not in such a tenant; it sees the
   *unverified* label and can still consent. So an unverified Zelos registration covers personal
   accounts on day one, and publisher verification is what unlocks the stricter company tenants.
   Some tenants will additionally require an administrator's consent whatever the badge says.
8. **Where the id goes.** `DEFAULT_OAUTH_CLIENTS.microsoft.clientId` in `core/sources/oauth.mjs`,
   with `tenantId: 'common'`. A self-hoster or a company pointing Zelos at its own single-tenant
   registration sets `config.oauth.clients.microsoft = { clientId, tenantId }` instead, and the
   existing Settings fields for pasting a client id and tenant id still work for one account at a
   time.

The device-code specifics Zelos implements are Microsoft's ([device code][ms-device]): the
`/devicecode` request names the tenant (`common`, `organizations`, `consumers` or a tenant id),
the user "has 15 minutes to sign in", the client polls `/token` no faster than `interval` and backs
off on `slow_down`, and a personal account "asked to sign in again in order to transfer
authentication state to the device" is normal, not a failure.

---

## App passwords — the floor

For every provider with no sign-in of its own the path is the one the app has had since 1.2:
type the address, Zelos names the provider and opens the exact page where it mints an app
password, you paste it, **Connect** tests, finds the sent folder and saves. Gmail keeps this path
beside the button. [README.md § Connecting your mail](README.md#connecting-your-mail) has the
per-provider steps.

| provider | what it takes |
|---|---|
| iCloud | app-specific password at account.apple.com; `imap.mail.me.com:993` |
| Yahoo, AOL | app password under Account Security |
| Fastmail | app password with the **Mail (IMAP)** scope |
| Zoho | app password under Security |
| Proton | Proton Bridge on `127.0.0.1:1143` with the password Bridge shows |
| self-hosted / work IMAP | whatever the server takes; `requireTls` decides what may travel in the clear and defaults to *nothing off this machine* |
| Gmail, Google Workspace | **Sign in with Google**, or an app password — both valid |
| Outlook.com, Hotmail, Live, MSN, Microsoft 365 | **Sign in with Microsoft** only |

---

## What each path sends where

Every host below is one you chose by choosing a provider. None of them is a Zelos server; there is
none.

| path | step | host | what travels | when |
|---|---|---|---|---|
| Google sign-in | consent | `accounts.google.com` | the client id, the scope, a PKCE challenge, an opaque `state` — in your browser, not from Zelos; you pick the account on Google's page | once, while you sign in |
| Google sign-in | exchange | `oauth2.googleapis.com` | the one-time code, the PKCE verifier, the client id (+ secret when the client has one) | once, from Zelos, the moment the redirect lands |
| Google refresh | refresh | `oauth2.googleapis.com` | the refresh token, the client id (+ secret) | when the access token is within a minute of expiry — about hourly while sweeping |
| Google mail | IMAP | `imap.gmail.com:993` | `AUTHENTICATE XOAUTH2` with the access token, then `BODY.PEEK` reads | every sweep |
| Microsoft sign-in | device code | `login.microsoftonline.com` | the client id, the tenant, the scopes; then polls carrying the device code | once, while you sign in |
| Microsoft refresh | refresh | `login.microsoftonline.com` | the refresh token | about hourly while sweeping; Microsoft rotates it each time |
| Microsoft mail | IMAP | `outlook.office365.com:993` | `AUTHENTICATE XOAUTH2`, then reads | every sweep |
| app password | IMAP | the host you typed | `LOGIN` over TLS, then reads | every sweep |
| any, custom domain | discovery | your system DNS resolver | the **domain** of the address — never the address — for its MX and `_imaps._tcp` SRV records | once, when you type the address |

The only thing in that table that carries what Zelos *read* is nothing: mail comes in, and the one
request that carries it out is to the model you chose, which is a different table
([SECURITY.md § 5](SECURITY.md#5-what-leaves-your-machine)).

---

Sources, all fetched 2026-08-22:

- `g-native` — <https://developers.google.com/identity/protocols/oauth2/native-app> — loopback redirect, PKCE S256, `client_secret` optional and not confidential in installed apps, endpoints
- `g-imap` — <https://developers.google.com/workspace/gmail/imap/xoauth2-protocol> — `https://mail.google.com/` is the IMAP scope; "must show full utilization"
- `g-oauth2` — <https://developers.google.com/identity/protocols/oauth2#expiration> — 7-day refresh tokens in Testing; 100 refresh tokens per account per client
- `g-restrictedlist` — <https://support.google.com/cloud/answer/13464325> — the restricted-scope list, with the IMAP/SMTP/POP3 note
- `g-restricted` — <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification> — timeline, "from or through a third-party server", tester warning
- `g-reqs` — <https://support.google.com/cloud/answer/13464321> — verification requirements: domain, homepage, privacy policy, video, narrowest scope, assessment
- `g-submit` — <https://support.google.com/cloud/answer/13461325> — consent-screen fields, test users, publish then Prepare for Verification
- `g-notneeded` — <https://support.google.com/cloud/answer/13464323> — 100-user cap in Testing, removed only by verification
- `g-assess` — <https://support.google.com/cloud/answer/13465431> — CASA, AL1/AL2, LOV, annual, Trust & Safety initiates
- `g-annual` — <https://support.google.com/cloud/answer/13463816> — 12 months from the LOV, comprehensive
- `g-faq` — <https://support.google.com/cloud/answer/13463817> — 100 new-user cap, IMAP needs the restricted review, the permanent-delete sentence, Limited Use wording, no Google fee, free tier-2 self-scan
- `g-changes` — <https://support.google.com/cloud/answer/13464018> — what re-triggers verification
- `g-gmailscopes` — <https://developers.google.com/workspace/gmail/api/auth/scopes> — scope tiers; "store … on servers (or transmit)"
- `ms-register` — <https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app> — registration steps and account-type labels
- `ms-desktop` — <https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration> — Allow public client flows
- `ms-device` — <https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code> — the device authorization grant
- `ms-imap` — <https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth> — `IMAP.AccessAsUser.All`, `offline_access`, Outlook.com and Microsoft 365
- `ms-multi` — <https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant> — the `common` authority
- `ms-pubdomain` — <https://learn.microsoft.com/en-us/entra/identity-platform/howto-configure-publisher-domain> — what *unverified* means on the consent prompt
- `ms-pubver` — <https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview> — requirements, no charge, the November 2020 step-up consent rule

[g-native]: https://developers.google.com/identity/protocols/oauth2/native-app
[g-imap]: https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
[g-oauth2]: https://developers.google.com/identity/protocols/oauth2#expiration
[g-restrictedlist]: https://support.google.com/cloud/answer/13464325
[g-restricted]: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
[g-reqs]: https://support.google.com/cloud/answer/13464321
[g-submit]: https://support.google.com/cloud/answer/13461325
[g-notneeded]: https://support.google.com/cloud/answer/13464323
[g-assess]: https://support.google.com/cloud/answer/13465431
[g-annual]: https://support.google.com/cloud/answer/13463816
[g-faq]: https://support.google.com/cloud/answer/13463817
[g-changes]: https://support.google.com/cloud/answer/13464018
[g-gmailscopes]: https://developers.google.com/workspace/gmail/api/auth/scopes
[ms-register]: https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
[ms-desktop]: https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration
[ms-device]: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
[ms-imap]: https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
[ms-multi]: https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant
[ms-pubdomain]: https://learn.microsoft.com/en-us/entra/identity-platform/howto-configure-publisher-domain
[ms-pubver]: https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
