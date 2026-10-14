# Sources

**Beyond mail and calendar, Zelos reads eight more things. This page is one
section per source: what it reads, where you mint the credential, what it costs,
what it deliberately does not do, and where it stops.**

You add them in **Settings → Sources**. Each one asks for the credential in its
own words, with a link to the page where you mint it, and each has a **Test**
that says what it found rather than "OK".

---

## The rules every source obeys

These are properties of the code, not promises about it. They are worth reading
once, because they answer most of the questions the sections below would
otherwise have to answer eight times.

**You mint the credential, in your own account.** For these eight sources,
Zelos publishes no OAuth app. There is no client id, no client secret, no
consent screen, no callback and no "Connect with…" button. The mail sign-ins
are the exception ([OAUTH.md](OAUTH.md)), and even they need no server of
Zelos's: the Google one comes back to the Zelos port on `127.0.0.1`, and the
Microsoft one is a code you type. Every source below is a token you created
and can revoke, or a file on your own disk.

**Nothing you did not type is contactable.** Each source declares the hosts it
may reach, and the only thing that widens that list is an address *you* typed
into a settings field. A URL that arrived inside a payload — a feed's `<link>`,
a GitHub repository's `html_url`, a redirect target — is stored as text and is
never fetched. That is one array, and it is the whole of the SSRF story.

**A token is never in a URL.** Credentials travel in an `Authorization` header
and there is no option to send one any other way. `core/log.mjs` redacts a
header by name and a `Bearer` by shape, and can do neither for `?api_key=…`
inside a URL — which lands in the vendor's access log, in every proxy's, and in
ours. Removing the option was cheaper than auditing for it.

**Read-only is enforced by the shape, not by convention.** A source is described
by a manifest, and the list of keys a manifest may carry has no `send`, no
`reply`, no `archive` and no `complete` in it. Adding one means editing a single
line that a reviewer can find. A manifest that invents a key fails the import —
in CI, not at seven in the morning on your laptop.

**Every budget is persisted.** The number of calls a source has spent is written
to disk, not held in memory. A laptop that sleeps and wakes ten times a day
would otherwise burn five hundred calls against a fifty-a-day allowance without
ever exceeding it as far as it knew.

**A refused credential rests for six hours.** When a host says the token is
dead, Zelos stops asking — until the six hours are up or until you change the
stored secret, whichever comes first. Pasting a new key lifts the rest
immediately.

**`zelos doctor` is the command to run when a source is quiet.** Each source
below has its own check, and each answers the question a person actually has —
*whose* token is this, *which* workspace, *how old* is that file — rather than
"the request succeeded".

---

## GitHub

**What it reads.** `GET /notifications?all=false&participating=true` — the
notifications inbox, and only the threads you were assigned, asked to review,
mentioned in, or have already commented on.

That endpoint is the reason GitHub is a source at all. Every other candidate
hands back a stream of everything that happened and leaves Zelos to guess which
of it was aimed at you. This one hands back a **`reason`** — `assign`,
`review_requested`, `mention`, `approval_requested` — which *is* the answer to
"what needs me", decided by the system that knows. A connector that has to infer
relevance from a firehose will infer it wrong on somebody's repository.

The reason is not merely printed. `assign`, `review_requested`, `mention`,
`approval_requested`, `invitation` and `security_alert` put you on the row's
**To** line; `team_mention` puts you on the **Cc** line, which is what a team
mention is. Zelos's ranker reads those fields and reads no prose, so a source
that only wrote the reason into the subject would have described the fact to you
and hidden it from the thing that sorts — and your review request would sort
below a CI failure.

**Where you mint the credential.** GitHub → **Settings → Developer settings →
Personal access tokens**, which is <https://github.com/settings/tokens>. Zelos
links straight there.

**Scopes.** A **classic** token needs `notifications`; `repo` includes it. A
**fine-grained** token needs read access to **Notifications**. GitHub's own
reference for these endpoints says it in one line: *all calls require the
`notifications` or `repo` scopes*.

A 403 is genuinely ambiguous here and Zelos says so rather than guessing — it is
one of three things: a classic token without `notifications`, a fine-grained
token without Notifications read, or GitHub's secondary rate limit. `zelos
doctor` resolves it by printing the scopes the token actually carries, read off
the `x-oauth-scopes` header of a `GET /user` call.

**What it costs.** Nothing. Personal access tokens are free and the
authenticated REST allowance is 5,000 requests an hour, shared with everything
else you point that token at.

The ordinary cost of a sweep is **one request**, and often that request is free
too. GitHub asks callers to poll this endpoint conditionally: it returns a
`Last-Modified`, you send it back as `If-Modified-Since`, and a `304 Not
Modified` **does not count against the 5,000**. On a quiet day, 46 of 48 daily
polls are 304s. GitHub also states a floor between polls in an `X-Poll-Interval`
header, in seconds, on every response including the 304s — Zelos carries that
number in its cursor and honours it before a socket exists, which is what stops
the **Check now** button from being a hammer.

Zelos declares its own budget of 120 calls an hour against GitHub's 5,000. That
is sixty times the expected spend and exists only to cap a runaway — a retry
loop, a held-down Refresh, a bug in the pager. Your 5,000 is shared with
everything else you own, and a background app that eats it is a background app
you uninstall.

**What it deliberately does not do.** It never marks anything read, never
subscribes or unsubscribes a thread, and never sends a `PATCH`. There is no slot
in the interface for one. A notification you read on github.com simply stops
coming back, and the row Zelos already stored stays where it is — the board is a
record of what arrived, not a mirror of somebody else's unread count.

It also never asks for notifications you have already read: `all=false` is in
the URL explicitly rather than left to the default, so that promise is visible
in a packet capture and not only in this sentence.

Two smaller refusals worth knowing. The sender is left blank rather than filled
in with GitHub's real `notifications@github.com`, because Zelos's ranker docks a
message 18 points for looking like bulk mail on the strength of a local part
beginning "notification" — the true address would have sunk every row from this
source, review requests included. And nothing is starred on your behalf: a
`\Flagged` is worth +10 and means *you* starred it, so minting one would sort an
automated row above a message a human actually flagged.

**Where it stops.**

- GitHub caps `per_page` at 50 on this endpoint whatever you ask for. Zelos
  walks at most 4 pages, so 200 notifications a sweep, and stops the moment a
  page comes back short or your "Notifications to keep" is satisfied.
- **CI activity is off by default.** GitHub sends one for every failing workflow
  on a branch you touched; for most people it is the noisiest reason there is,
  and it is a build log, not a person waiting. All of a repository's CI
  notifications collapse into one board item when you do turn it on.
- **Repositories you only watch are off by default.** Turning them on drops
  `participating=true`, which is a firehose.
- A notification with no id is dropped and counted, because every id-less
  notification would hash to the same row and they would overwrite each other.
- **GitHub Enterprise Server** works: put `https://your-host/api/v3` in the
  GitHub API address field. That field is also what adds your host to the
  contactable list — nothing else can.
- Change what you are asking for — add a repository, switch CI activity on,
  widen to watched repos — and the stored `If-Modified-Since` is dropped rather
  than sent, because it describes the *old* question. Without that, a settings
  change is followed by a confident green zero while the new repository's
  notifications sit on the server. It costs one full read, once.

---

## Slack

**What it reads.** Your conversations, through `conversations.list` and
`conversations.history`, with `users.info` to turn `U04ABCDEF` into a name and
`auth.test` to learn which of those ids is you. Knowing that last one is not
cosmetic: without it every message looks incoming, and the half of the board
that tracks what *you* promised cannot exist.

The default breadth is **participating** — direct messages, group DMs, and the
channels you are actually a member of. A user token with `channels:history` can
read every public channel in the workspace, which for most companies is tens of
thousands of messages a day and a great deal of other people's conversation.
Widening that is a choice you make in a labelled field, not something that
happens because a scope was granted.

**Where you mint the credential.** <https://api.slack.com/apps> → **Create New
App** → in **your own** workspace → **OAuth & Permissions** → add the scopes →
**Install to Workspace** → copy the token. A user token starts `xoxp-`, a bot
token `xoxb-`; Zelos accepts either.

**Scopes.** Read scopes only: `channels:history`, `groups:history`,
`im:history`, `mpim:history` for the messages; `channels:read`, `groups:read`,
`im:read`, `mpim:read` to list the conversations; `users:read` for display
names. Grant only the halves you want — Zelos asks for all the types in one
call, and if that call is refused for a missing scope it falls back to asking
for each type separately and tells you in a note which halves of your Slack are
dark and why.

If you add a scope later you must **reinstall** the app for it to take effect.
Zelos deliberately does *not* treat a missing scope as a dead token, because a
reinstall frequently returns the same token string — the six-hour credential
rest would then keep Slack dark for six hours after you had already fixed it.

**What it costs. This is the section worth reading twice.**

Nothing. And the rate limit you are about to design around does not apply.

In 2025 Slack cut apps to **one request per minute** on `conversations.history`,
with the `limit` parameter capped and defaulted to **15 objects**. If that were
the number Zelos had to live inside, twenty channels would take twenty minutes.
It is not, and Slack's own words settle it. From the clarifying changelog:

> any internal customer-built apps will maintain their existing rate limits and
> will not be subject to the new posted limits

and from the rate-limits reference:

> Apps already approved for the Slack Marketplace and internal customer-built
> applications should not see rate limit changes.

The cut applies to apps **commercially distributed outside the Marketplace**.
Zelos's model is an internal customer-built app exactly and only: *you* create
an app in *your* workspace, grant it *your* scopes, install it for yourself, and
paste the token in. **Zelos publishes no Slack app** — no client id, no
Marketplace listing, no OAuth redirect — so there is nothing here for the new
limit to attach to.

What applies instead are Slack's ordinary published tiers: `conversations.list`
is **Tier 2** (20+ per minute), `conversations.history` is **Tier 3** (50+ per
minute), `users.info` is **Tier 4** (100+ per minute). Zelos paces to Tier 3's
sustained rate — 1.2
seconds between calls — because history is the call it makes repeatedly, once
per channel. Its declared budget is 120 calls per half hour, which covers a
scheduled sweep plus a manual one and refuses a third: an `auth.test`, a page or
two of `conversations.list`, twenty histories and up to forty first-time name
lookups is about 65.

If your workspace ever *is* throttled, nothing breaks — `conversations.history`
would answer with fifteen messages and a cursor, and the pagination loop simply
takes more pages. The harsher limit costs calls, not correctness.

**What it deliberately does not do.**

It does not post, react, mark anything read, or join a channel.

**It does not fetch thread replies.** `conversations.history` returns thread
*parents* only; the replies need one `conversations.replies` call per thread, so
a channel with twenty live threads would cost twenty calls on top of its one
history call — the whole per-sweep budget for a single channel. Instead the
parent's reply count is appended to its body so the board can see there is more,
and a reply the author chose to broadcast back to the channel (which Slack *does*
put in history) lands in the same thread as its parent.

It also filters out Slack talking about itself — joins, leaves, topic changes,
pins, renames. "Nemo has joined the channel" is not correspondence, and a board
that surfaces it teaches people to ignore the board. Messages from apps are
kept, because a deploy that failed is exactly what the board is for.

**Where it stops.**

- Slack answers **HTTP 200 with `{"ok": false}`** for a revoked token, a missing
  scope, and a channel it cannot see. The transport never sees a 401, so every
  failure is noticed by the connector itself. A version that trusted the status
  line would report a dead token as a quiet week.
- 10 pages of conversation listing (2,000 conversations). Past that you get a
  note telling you to name the ones you want, because otherwise "Conversations
  to read" is applied to an arbitrary prefix of an order Slack documents nothing
  about.
- 8 pages of history per conversation; defaults of 20 conversations, 200
  messages each, 7 days of lookback (90 maximum). Direct messages come first,
  then group DMs, then channels by name.
- Up to 80 resolved display names ride along in the cursor for 7 days. Without
  that cache a twelve-person channel costs twelve name lookups every thirty
  minutes to render names that have not changed since March.
- The whole cursor must serialise under 4,096 characters or the host drops it —
  which would mean re-reading the full lookback of every channel forever on a
  rate-limited API. Zelos trims it to fit rather than hoping.
- A **direct message threads as one conversation**; a public or private channel
  threads per message. #general is not one conversation, and collapsing a busy
  channel into a single thread would make its newest message the "latest" of
  everything anyone said in it.

---

## Fireflies

**What it reads.** Your meeting recaps: the title, the time, the duration, who
was in the room, the overview, and — the reason the row is worth having at all —
the **action items**. Those come first in the body, deliberately: when the
prompt does not fit, the bottom of every message is what the model never sees,
and an overview runs to thousands of characters where the action items run to a
few hundred.

**Where you mint the credential.** Fireflies calls it an API key. In the app:
**Integrations → Fireflies API**, or **Settings → Developer settings** on the
Personal tab. Zelos links to
<https://app.fireflies.ai/integrations/custom/fireflies>. It is sent as
`Authorization: Bearer <key>` to `https://api.fireflies.ai/graphql`, which is
the whole of Fireflies' API surface.

**What it costs — and this number is the design.**

Fireflies' published API limits are **50 requests per day on the free plan**,
500 per day on Pro, and 60 per minute on Business and Enterprise. Fifty a day is
small enough to shape everything.

An hourly poll costs **24 requests**. That fits in fifty with room to spare, and
it fits only because the connector makes exactly **one** request per poll. The
obvious way to write it is the wrong one:

```
transcripts { id }                     ->  1 request
transcript(id: $id) { summary { … } }  ->  one request PER MEETING
```

That is 1 + N. An hourly poll on a day with four meetings is 24 + 96 = 120
requests against an allowance of 50, so the source would stop working before
lunch on the first busy day — and you would be told "rate limited" about
something you poll once an hour. GraphQL exists precisely so that does not have
to happen: `transcripts` returns whole objects, so the nested summary comes back
inside the *same* response as the list.

Zelos declares 40 calls a day rather than 50, and the missing ten are not slack.
`zelos doctor` builds its own transport without the persisted meter, so every
diagnostic run spends a real Fireflies request the budget never sees. Ten a day
of headroom is the difference between "a doctor run at four o'clock breaks the
evening poll" and "it does not".

**What it deliberately does not do.**

There is **no pagination**. A second page is a second request out of fifty, and
an hour of a person's life does not contain fifty meetings.

The query asks for three arguments — `fromDate`, `toDate`, `limit` — and no
more. Every extra argument and every extra selected field is a name that has to
exist in the vendor's schema, and a GraphQL server rejects the *whole* document
over one unknown field. A filter that would be nice to have is not worth a
source that returns nothing for everyone the week Fireflies renames something.

**Where it stops.**

- 50 meetings per poll, which is Fireflies' own ceiling on `limit`. The default
  is 25.
- A minimum of one hour between polls, whatever the sweep schedule says.
- **A 200 with an `errors` array is a failure, and Zelos treats it as one.**
  GraphQL states failures in the body, not in the status line: a bad key, a
  spent allowance and a mistyped field all arrive as HTTP 200. A naive reader
  does `json.data.transcripts ?? []` and returns an empty array — which reads as
  "you had no meetings" for a source that is in fact broken. A body with neither
  meetings nor an error is refused too, because that third shape is the same lie
  wearing a different hat.
- Because a refused key arrives as a 200, the connector classifies it itself and
  raises the six-hour rest. Without that, a key you revoked would cost 24 wasted
  requests a day, every day, silently.
- Each poll re-reads the last six hours on top of where it left off. A
  transcript exists the moment a meeting ends but the *summary* is generated
  afterwards and lands minutes later, so a poll that catches a meeting in that
  gap gets a title with no action items. The overlap costs nothing — it is the
  same one request with an earlier start date — and a later, richer read
  replaces the thin one rather than the other way round.

---

## Linear

**What it reads.** The issues assigned to you that are not finished and are due
inside your horizon. Overdue always comes through, whatever the horizon says.

An issue with a due date is an **obligation** — something that arrived at you
and is waiting — so it lands on the board as a message rather than as an entry
in the day's schedule. An event is a thing that happens whether you attend or
not; an assigned issue is not that.

**Where you mint the credential.** A **personal API key**. Linear's own
developer documentation points at **Settings → Security & access**
(<https://linear.app/settings/account/security>). Zelos's link currently opens
<https://linear.app/settings/api>; if that does not land you on the key page,
Security & access is where to look.

**Scopes.** A personal key carries your own access — there is nothing to tick.
There is also nothing to authorise: Zelos ships no Linear app and no client
secret, so there is no consent screen and no callback.

**The one detail that will waste your afternoon if it is lost:** Linear wants
the key sent as `Authorization: <key>` with **no `Bearer` prefix**. The prefixed
form is what an OAuth access token uses, and Linear refuses a personal key sent
that way. Zelos sends the bare form, and the empty prefix in its manifest is
load-bearing — deleting it as a tidy-up silently re-adds `Bearer ` and every
read starts failing with a 401 that looks exactly like a bad key.

**What it costs.** Nothing. A personal API key needs no paid plan.

Linear's published rate-limit table gives an **API key 2,500 requests an hour**
per user, an OAuth app 5,000, and an unauthenticated caller 600. (The prose on
that same page says 5,000 for an API key; the table says 2,500, and Zelos takes
the smaller of the two.) The distinction matters: this connector accepts only a
personal key, so 5,000 is somebody else's row, and a source that declared it
would discover the real number by being throttled.

Zelos declares **20 calls an hour** — not a claim about Linear's ceiling, but
what a sweep actually costs: at most 4 paged calls, plus whatever `zelos doctor`
spends. Twenty covers both several times over and still bounds a paging loop
that has gone wrong, which is the only job a budget has here.

**What it deliberately does not do.** It never creates, comments on, closes,
reassigns or moves an issue.

It also keeps **no cursor between sweeps**, and that is a decision rather than
an omission. Linear can filter by `updatedAt`, so an incremental sync is
available and would be wrong: what changes about these rows between sweeps is
mostly that **the clock moved**. An issue nobody has touched since March goes
from "due in 3 days" to "overdue by 9" with no update event anywhere, and a
modified-since cursor would freeze it at the weight it had when it was last
edited.

**Where it stops.**

- 4 pages of 100 issues — 400 read per sweep — with 200 rows kept at most and 50
  by default. The most overdue are kept first, so lowering the number drops what
  is least urgent.
- Linear's `orderBy` accepts only `createdAt` and `updatedAt`, so there is no
  way to ask the server for "most overdue first". The ranking is done locally,
  which is exactly why the due-date filter is in the query: it guarantees the
  pages held in memory are the pages that matter.
- When a read is cut short, the total is stated as a **floor**, never as a fact.
  A note saying "Linear had 400 issues" after a read that stopped at four pages
  with more waiting is a falsehood the product generated about an account it had
  not finished reading.
- An issue arriving with no id is dropped and counted rather than given a
  colliding row.
- **The date on the row is the moment of the read, not the due date.** This
  looks wrong and is deliberate: the model is shown messages from the last 21
  days, so putting the due date there would mean an issue six weeks overdue —
  the single most urgent row this source can produce — is the one row the model
  never sees. `updatedAt` has the same cliff and is worse, because the tasks
  nobody has touched are exactly the dropped ones. The due date appears once per
  row, in words, in the snippet.

---

## Todoist

**What it reads.** The tasks matching a Todoist filter you control. The default
is `overdue | today` — everything late plus everything due today.

The filter is yours, with a default Zelos chooses. Todoist's filter grammar is a
real query language and it is theirs, not ours: leaving the box editable means
that if you share projects you can write `(overdue | today) & assigned to: me`
without waiting for a release, and means this source never has to grow a second
opinion about what "mine" means in somebody else's workspace.

**Where you mint the credential.** Todoist → your avatar → **Settings →
Integrations → Developer**, and the **API token** is at the bottom of that page
(<https://app.todoist.com/app/settings/integrations/developer>). It is sent as
`Authorization: Bearer <token>` — the opposite of Linear, which is why copying
one of these two manifests onto the other breaks both.

**What it costs.** Nothing. A personal API token needs no paid plan. Zelos
declares 60 calls per fifteen minutes, written as its own restraint rather than
as a claim about Todoist's ceiling: a sweep needs three calls at the very most,
so the budget's only real job is to stop a paging loop that has gone wrong.
Guessing high at somebody else's limit is how a connector discovers it by being
throttled.

**What it deliberately does not do.** It never completes, reschedules, creates,
comments on or deletes a task. Finishing something is your click in Todoist.

It keeps no cursor, for the same reason Linear keeps none: Todoist's cursor
paginates *one* answer and is spent when that answer ends — it is not a sync
token — and even a real sync token would be wrong, because what changes about
these rows is that the clock moved.

**Where it stops.**

- 3 pages of 200 — 600 tasks read per sweep — with 200 rows kept at most and 50
  by default.
- **The filter is a different endpoint, not a parameter.** Under the old REST v2
  API a filter rode along as `GET /tasks?filter=…`. API v1 removed it in favour
  of a dedicated `/api/v1/tasks/filter`, and the expression travels as **`query`**,
  not `filter`. This matters because `GET /api/v1/tasks` is a perfectly valid
  request that answers 200 with **every active task in the account** and ignores
  the parameter it does not know — so a version pointed at the wrong endpoint
  drops your entire selection criterion in silence. Nothing throws, nothing
  warns, and the board quietly fills with tasks due weeks out under a source
  whose own label promises "due today or overdue". This connector shipped that
  way once.
- **Todoist's priority is numbered backwards from the app**: in the API
  `priority: 4` is the most urgent and 1 is the default, where the app calls
  those P1 and P4. It also runs opposite to Linear's. That is most of why the
  two sources share no helper.
- A due value has three shapes and only one may be converted through a timezone:
  a bare `YYYY-MM-DD` (a date, which must not be — every task due today would
  read as one day overdue for every user in the Americas), a datetime carrying
  an offset (which must be), and a datetime with no offset at all (a wall clock,
  the digits you typed, with no instant in it to convert).
- A recurring task keeps its id, so "water the plants" is one standing
  obligation updating one row in place, not a new row every day forever.
- A task arriving with no id is dropped and counted.
- `zelos doctor` runs **your own filter**, not a token probe, because a typo in
  the filter is the likeliest thing to be wrong and a token probe cannot see it.

---

## RSS or Atom feed

**What it reads.** Any RSS or Atom feed. An article arrives on the board as a
message from a publication, which is how the board should read it — record types
here are named for how the board reads a thing, not for the vendor's noun.

**Where you mint the credential.** Nowhere. This source has **no credential at
all** — not an optional one, none — so Zelos never asks you for a password for
it and never reports one as missing.

**What it costs.** Nothing, and there is no budget and no minimum interval. A
feed is a static file on somebody's CDN; there is nothing to be gentle about.
Zelos still sends `If-None-Match` and `If-Modified-Since` from the last read, so
an unchanged feed costs a 304 and is reported as a successful read of nothing.

**What it deliberately does not do.** It follows **no URL the document names**.
This source declares no hosts of its own — the only address it may contact is
the one *you* typed into the feed address field. A feed that redirects off its
own origin, or names a host in a `<link>`, is refused before a socket exists.

The parser is deliberately not a parser. A feed is a stranger's XML, and the
only questions asked of it are "which elements are items" and "what text is
inside this one". Nothing evaluates, resolves an entity file, or fetches
anything.

**Where it stops.**

- 200 entries read, 50 kept by default; bodies capped at 20,000 characters.
- Only the five predefined XML entities and numeric references are decoded.
  HTML's named set (`&nbsp;`, `&copy;`) is deliberately left alone: those are not
  XML entities, a conforming feed cannot use them bare, and decoding them would
  mean guessing at bytes the publisher never wrote.
- Escaped ampersands **are** decoded, and that is not cosmetic. Found by
  pointing this at NASA's real feed rather than at a fixture: 2 of 10 entries
  came back with `?post_type=image-article&#038;p=1036264`, because a person
  writing a test fixture types a clean URL and never sees this. That string is
  the article's identity, so a publisher changing escaping — `&#038;` to
  `&amp;`, or a CDN normalising on the way out — would make the same article
  arrive again as new, and turn one article into two threads.

---

## A folder on this machine

**This is the answer to "generic webhook", and it is not a compromise.**

Zelos binds `127.0.0.1` and opens no inbound port, so a webhook is not a feature
that was skipped — it is structurally impossible. Every way of restoring it (a
tunnel, a relay, a hosted forwarder) puts back the server the product
deliberately does not have, along with a public URL that anybody who guesses it
can post to.

A watched directory buys the same thing with none of it. A cron job, a shell
script, a Shortcut, an `at`, a Syncthing or iCloud folder, or a human dragging a
file all become inputs, and the authorisation check is the one your operating
system already performs on the directory. **There is no token to leak because
there is no listener to authenticate to.**

**What it reads.** `*.json` and `*.txt` in one directory. It does not recurse.
The default is `~/.zelos/inbox`; a relative path resolves against the Zelos home
rather than the working directory, because the Electron shell has a different
working directory launched from Finder, from a login item and from a terminal —
one saved setting would otherwise name three folders on one machine, one of them
written to and the others empty.

A `.txt` is a note whose title is its filename. A `.json` is this shape:

```json
{"title": "…", "body": "…", "from": "…", "date": "…", "link": "…"}
```

Five keys, all optional, any other key ignored silently — a script that also
writes `"run_id"` should not be refused for being generous. What is refused is a
document that cannot be a message: an array (one file is one message), a bare
string or number, and an object with neither a title nor a body, which would
arrive on the board as an empty row nobody can account for.

**Where you mint the credential.** Nowhere. There is nothing to authenticate —
it is a path on your own disk — and nothing to contact.

**What it costs.** Nothing.

**What it deliberately does not do. Nothing happens to a file once it has been
read. Ever.**

The three options were delete it, move it to an `archive/`, or remember it.
Delete is out on principle — a read-only product that removes your file is not
read-only, and "Zelos ate the only copy of the thing my script wrote" is an
unrecoverable bug report. Move is the same act wearing a hat: it is still a
write into a directory you own, it still breaks whatever else was watching that
folder, and it fails halfway across a filesystem boundary. So: **remember**.

Remembering is cheap because identity does the work. A row's id is a hash of the
file's **name and its bytes**, so re-reading the same file updates the same row.
Duplicates are impossible even with no memory at all — the cursor is a
work-saving device, not a correctness device.

To archive files yourself, `mv` them into a subdirectory. This source does not
recurse, so an `archive/` folder inside the watched directory is invisible to
it.

It also does not follow symlinks and skips dotfiles.

**Where it stops.**

- **1 MB per file**, checked against the file's size *before* anything is
  opened, so the bytes are never allocated. What that really refuses is the
  2 GB case — a log, a database dump, a video someone parked in the folder.
- **200 files per sweep**; the rest wait for the next one.
- 5,000 directory entries walked at most.
- Titles are capped at 300 characters and links at 2,000, not just bodies. A cap
  that two of four fields honour is not a cap: measured, a
  `{"title": "A".repeat(900000)}` reached the board, the search index and the
  settings export at its full 900,000 characters from a source whose bodies stop
  at 20,000.
- A `.txt` containing NUL bytes is refused as not-text. The extension is a
  claim, not a fact — a renamed `.zip`, a Word document, a UTF-16 file — and
  shipping one into a model prompt is how a prompt gets several kilobytes of
  nothing.
- **The cursor remembers 300 files, and past that some are re-read every sweep,
  permanently.** This is stated plainly because an earlier version of this note
  called it a one-off and it is not: the memory keeps the *newest* digests while
  the walk reads the *oldest* files, so the two ends fight. Measured at 300 files
  against an older 240-file memory: 200, 100, 60, 60, … rows, and it stays at 60.
  Any deterministic choice of 300 digests out of 400 files forgets 100 of them,
  so within the 4,096-character cursor the host allows, this is a ceiling and not
  a bug. What it costs is a re-read of a small local file; what it never costs is
  a duplicate row or an extra model run.
- **Have your script write to a temporary name and rename it into place.** A
  rename is atomic; a redirect is not, and a file still being written is deferred
  rather than read half-finished.
- A folder that does not exist yet is quiet — nobody has run `mkdir` on a fresh
  install, and an error banner every thirty minutes for an empty inbox is
  fatigue, not information. `zelos doctor` says it plainly instead, with the
  command. But a folder that *used to* be there and has gone is reported once,
  and so is a path whose parent does not exist either — a typo and an unmounted
  volume both look like that, and both used to be silently green forever.

---

## A WhatsApp chat you exported

**This is an archive you bring, not a connection. It shows nothing new until you
export again — not in an hour, not tomorrow, not ever.**

That sentence is in the option you pick in Settings, in the field's hint, and in
`zelos doctor` with the export's own date attached, because the difference
between "Zelos reads my WhatsApp" and "Zelos read a file I gave it" is the
difference between a product that works and a product that quietly stops telling
you about the message that mattered. Someone who believes the first will not
export again, and the board will go on showing a conversation that ended weeks
ago as though it were current.

**Why it is a file and not an integration.** There are exactly three ways to
reach a personal WhatsApp account's messages, and two are unavailable at any
price.

1. **The WhatsApp Business Cloud API.** It is business-to-customer messaging and
   it has **no read endpoint at all** — no "list my conversations", no "fetch
   messages since". Inbound messages arrive only as webhooks to a public HTTPS
   URL you operate, which is the server Zelos deliberately does not have. And
   the cost of trying is not a rate limit: **registering a phone number on the
   Cloud API deletes that number's personal WhatsApp account.** A user who
   followed a setup wizard to "connect WhatsApp" would lose the chat history
   they were trying to read.
2. **The unofficial web/multi-device libraries.** They do read personal chats,
   and they are out on two independent grounds. They cannot ship here: the
   browser-automation ones carry Puppeteer, which is a Chromium download, and
   the protocol ones carry a native Rust addon — either is a `node_modules`
   directory, and CI asserts one does not exist. And this would still be
   disqualifying if they were pure JavaScript: they drive an unauthorised client
   against WhatsApp's servers, and the documented consequence is termination of
   the account. That account holds somebody's family, their children's school
   group and their bank's one-time codes. A second brain is not worth a phone
   number.
3. **Export chat.** First-party, free, unconditional: no developer account, no
   token, no review, no risk to the account. It is a button in the app that
   hands you a `_chat.txt`. That is what this reads.

**How to export.** In WhatsApp: open the chat → tap the contact or group name →
**Export chat** → **Without media**. Point Zelos at the `.txt` or `.zip` it
gives you, or at a folder you drop exports into.

**Two settings worth filling in.**

- **Your name in this chat**, exactly as it appears in the export. An export has
  display names and no addresses, so this is the only thing that reliably tells
  Zelos which messages are yours. Left blank, Zelos tries to work it out and
  otherwise **files everything as received rather than guess** — and says so in
  a note, once, listing the names it found.
- **Date order.** WhatsApp writes dates the way the exporting phone does and the
  file never says which way that was, so `2/8/26` is two different days. Auto
  settles it from any date past the 12th in the export and falls back to this
  computer's setting for a chat that never reached one — and tells you when it
  had to.

**Where you mint the credential.** Nowhere. What authorises the read is the
file's own mode on your own disk.

**What it costs.** Nothing.

**What it deliberately does not do.** Nothing is ever written, moved or deleted
— including the export and including the `.zip`, which is read a few kilobytes
at a time through its own central directory rather than unpacked. A media export
can be two gigabytes; this reads only the `_chat.txt` inside it — its last 8 MB
directly when it is stored, or a megabyte at a time when it is compressed — and
never holds more than about 8 MB of its text. An unchanged export is
not re-read at all.

**Where it stops.**

- 8 MB of chat text per export, read **from the end** — a `.txt` and a `.zip`
  alike. A chat log is append-only, so the tail is the recent part, and the
  recent part is what a board about today wants. A zipped chat that inflates to
  more than 512 MB of text is refused with a sentence asking for the unzipped
  `_chat.txt`; it is a work limit, not a memory one.
- 2,000 messages kept per chat, 20 export files per sweep, 40 remembered.
- **There is no "WhatsApp export format".** WhatsApp renders each line with the
  phone's own date and time formatter, so the file's shape is a product of the
  exporting platform and its locale — iOS brackets the timestamp, Android
  separates it with " - ", times are 12- or 24-hour, the meridiem may come
  *before* the digits in Korean, and Arabic locales write the digits in
  Arabic-Indic numerals with bidi control characters threaded through the line.
  Two locale-blind facts do the heavy lifting: a line that does not begin with a
  timestamp is a continuation of the one above it, and a system notice has no
  "Sender: " prefix because nobody sent it.
- `zelos doctor` prints how many days ago the export was made. That is the
  question only it can usefully ask: a source working perfectly and reading a
  four-month-old file produces no error at all — the sweep is green, the rows
  are real, and the conversation stopped in April.

---

## See also

- **[NOTETAKERS.md](NOTETAKERS.md)** — the whole category that needs no source
  at all. Seven of eight AI notetakers email you a structured recap, and Zelos
  already reads your mail.
- **[README.md](README.md)** — mail, calendar, models, and where your data
  lives.
- **[SECURITY.md](SECURITY.md)** — what leaves your machine, and what Zelos does
  not protect you from.
