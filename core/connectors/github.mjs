/**
 * core/connectors/github.mjs — GitHub notifications.
 *
 * `GET /notifications?participating=true` is the reason this is the ninth
 * connector rather than the twelfth. Every other candidate hands back a stream
 * of everything that happened and leaves Zelos to guess which of it was aimed at
 * the user; this endpoint hands back a `reason` — `assign`, `review_requested`,
 * `mention`, `approval_requested` — which IS the answer to "what needs you",
 * decided by the system that knows. A connector that has to infer relevance from
 * a firehose is a connector that will infer it wrong on somebody's repo.
 *
 * FOUR THINGS THIS FILE IS THE FIRST TO DO, AND EACH IS THE REASON FOR ITS OWN
 * PILE OF COMMENTS BELOW.
 *
 *  1. THE CONDITIONAL-REQUEST DANCE THE ENDPOINT DOCUMENTS. `Last-Modified` out,
 *     `If-Modified-Since` back verbatim, and a 304 costs NOTHING against the
 *     5,000-an-hour budget. That is the whole difference between a polite
 *     connector and a rude one: a sweep every thirty minutes is 48 reads a day,
 *     and 46 of them are 304s on a quiet day. RSS already does the ETag half of
 *     this; what is new here is that the header is not an optimisation, it is
 *     the thing the vendor asks for in writing.
 *  2. A POLL INTERVAL THE SERVER CHOOSES. `X-Poll-Interval` comes back in
 *     SECONDS on every response, 304s included, and it is the floor GitHub wants
 *     between polls. `limits.minIntervalMs` is a static number in a manifest and
 *     cannot move, so the live one is carried in the CURSOR and enforced by this
 *     file before a socket exists. Without it, the "Sweep now" button is a
 *     hammer: the sweep's own 30-minute cadence respects any sane interval, and
 *     a person clicking Refresh does not.
 *  3. A THREAD KEY DERIVED FROM THE SUBJECT, NOT FROM THE NOTIFICATION. See
 *     `threadKeyFor`. This is the difference between one board item for a pull
 *     request and six.
 *  4. THE TRIAGE SCORER REACHED THROUGH THE ONLY DOOR IT HAS. core/triage.mjs
 *     scores a message from `flags`, `to`, `cc`, `direction` and `sentAt` — it
 *     never reads prose. So `reason` is mapped onto those fields rather than
 *     only written into the subject line, and the mapping is at `ADDRESSED_TO_YOU`.
 *
 * NOTHING HERE WRITES. There is no mark-as-read, no thread subscription, no
 * `PATCH /notifications`; the interface has no slot for one and `assertShape`
 * refuses a manifest that invents a key. A notification the user reads on
 * github.com simply stops coming back, and the row Zelos already stored stays
 * where it is — which is right: the board is a record of what arrived, not a
 * mirror of somebody else's unread count.
 */

import crypto from 'node:crypto';

import { parseDate } from '../sources/mime.mjs';
import { AuthError, RateLimitError } from './http.mjs';

/** The public API. A user on GitHub Enterprise Server overrides it; see `fields`. */
const DEFAULT_API = 'https://api.github.com';

/** Where a person mints the thing they are being asked to paste. */
const TOKEN_URL = 'https://github.com/settings/tokens';

/**
 * The REST version GitHub asks every request to name.
 *
 * Sending it is not optional politeness. GitHub's stated contract is that an
 * unversioned request gets whatever the current default is, and the default
 * moves; a connector that does not pin one is a connector whose payload shape
 * changes on a date nobody here chose. It is sent on `collect` and on `check`,
 * because a probe that speaks a different dialect from the reader is a probe
 * that can pass while the reader fails.
 */
const API_VERSION = '2022-11-28';

const ACCEPT = 'application/vnd.github+json';

/** GitHub caps `per_page` at 50 on this endpoint. Asking for 100 gets 50. */
const PER_PAGE = 50;

/**
 * How deep the pager will go.
 *
 * Four pages, 200 notifications, four requests in the worst case. It is a
 * ceiling rather than a target: the loop stops the moment a page comes back
 * short (that was the last one) or the user's `maxItems` is satisfied, so the
 * ordinary cost is ONE request. The ceiling exists because a repo filter can
 * reject every entry on a page — somebody watching forty repos and scoping to
 * one — and an unbounded "keep paging until you find some" is how a connector
 * spends a whole hourly allowance on a single sweep.
 */
const MAX_PAGES = 4;
const MAX_NOTIFICATIONS = PER_PAGE * MAX_PAGES;

const DEFAULT_KEEP = 50;
const SNIPPET_CHARS = 400;

/**
 * The subject is built from the same payload title the note below was measured
 * on, and the BODY_CHARS fix left it whole: a 500,000-character `subject.title`
 * still produced a 500,019-character `messages.subject`, re-written into the
 * search index's title on every sweep. slack.mjs caps its subject at 120 and
 * linear.mjs at 200; this is the same rule.
 */
const SUBJECT_CHARS = 200;

/**
 * The house cap on a message body, and this file was the only messages-sink
 * connector without one.
 *
 * rss.mjs, slack.mjs, fireflies.mjs, folder.mjs and whatsapp.mjs all cap at
 * 20,000; linear.mjs and todoist.mjs at 4,000. github.mjs declared SNIPPET_CHARS
 * alone, which capped what the BOARD shows and nothing else: measured, a
 * notification whose `subject.title` is 500,000 characters produced a `text` of
 * 500,081, and that string goes into `messages.body` AND into the FTS index via
 * `indexDoc` (core/db.mjs:411). Nothing bounded it but `readCapped`'s 8 MiB
 * per-response ceiling, so one sweep could push four page-loads of title text
 * into SQLite. github.com caps an issue title at 256 characters; a GHES install,
 * a proxy, or a rewritten payload does not, and "the vendor would never" is the
 * assumption every other cap in this repo exists because somebody made.
 */
const BODY_CHARS = 20_000;

/**
 * The interval to assume when GitHub does not state one, and the ceiling on the
 * one it does.
 *
 * 60 s is GitHub's own documented default for `X-Poll-Interval`. The 15-minute
 * cap is a guard, not a preference: the sweep's default cadence is 30 minutes
 * (core/config.mjs, `sweep.intervalMinutes`), so anything at or below 15 minutes
 * can never suppress a SCHEDULED sweep — it only suppresses the second and third
 * click of "Sweep now". A header of 86400, whether it arrives from a bug at the
 * far end, a caching proxy, or a header a user's corporate TLS-inspection box
 * rewrote, would otherwise retire the source for a day with nothing anywhere
 * saying why. A source that has quietly stopped is the one failure mode this
 * product cannot afford, because there is no error to read.
 */
const DEFAULT_POLL_MS = 60_000;
const MAX_POLL_MS = 15 * 60_000;

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ *
 * The reason field — the thing this connector exists for
 * ------------------------------------------------------------------ */

/**
 * GitHub's `reason`, in words a person reads on a board.
 *
 * The map is deliberately NOT exhaustive-by-construction, and the fallback is
 * the important half. GitHub has added reasons since this endpoint shipped —
 * `approval_requested` and `member_feature_requested` both postdate the original
 * list — so a `switch` with no default, or a filter that keeps only known
 * reasons, drops notifications on the day GitHub ships the next one, silently
 * and with no error to read. An unknown reason is humanised and KEPT.
 */
const REASON_LABEL = new Map(Object.entries({
  approval_requested: 'Approval requested',
  assign: 'Assigned to you',
  author: 'You opened this',
  ci_activity: 'CI activity',
  comment: 'New comment',
  invitation: 'You were invited',
  manual: 'You subscribed to this thread',
  member_feature_requested: 'Member feature requested',
  mention: 'You were mentioned',
  review_requested: 'Review requested',
  security_advisory_credit: 'Security advisory credit',
  security_alert: 'Security alert',
  state_change: 'Opened or closed',
  subscribed: 'From a repository you watch',
  team_mention: 'Your team was mentioned',
}));

export function reasonLabel(reason) {
  const key = String(reason ?? '').trim().toLowerCase();
  if (!key) return 'Notification';
  const known = REASON_LABEL.get(key);
  if (known) return known;
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Which reasons put the user on the To line, and which only on the Cc line.
 *
 * This is not decoration and it is not a metaphor. core/triage.mjs:437-438 is
 * the entire mechanism by which "GitHub says this one is on you" reaches the
 * ranking:
 *
 *     if (msg.to.some((a) => sameEmail(a?.email, ctx.userEmail))) score += 6;
 *     else if (msg.cc.some((a) => sameEmail(a?.email, ctx.userEmail))) score -= 2;
 *
 * The scorer reads no prose. A connector that surfaced `reason` only in the
 * subject string would have described the fact to a human and hidden it from
 * the thing that ranks, and the review request would sort below a CI failure.
 *
 * The split is meant literally. `assign`, `review_requested` and `mention` name
 * the user; `team_mention` names a group they belong to, which is exactly what a
 * Cc is, and the −2 is the right size for it. Everything else — `subscribed`,
 * `comment`, `ci_activity`, `state_change`, and every reason GitHub has not
 * invented yet — is neither, and lands with no address at all.
 *
 * `\\Flagged` was considered for `review_requested` and rejected. That flag is
 * worth +10 and it means "the user starred this themselves"; minting one on the
 * user's behalf would sort an automated GitHub row above a message a human
 * actually starred, which is a lie about provenance and not merely a tuning
 * choice.
 */
const ADDRESSED_TO_YOU = new Set([
  'assign', 'review_requested', 'mention', 'approval_requested', 'invitation', 'security_alert',
]);
const COPIED_IN = new Set(['team_mention']);

/* ------------------------------------------------------------------ *
 * Subject → identity, thread and link
 * ------------------------------------------------------------------ */

/**
 * `PullRequest` -> `pull request`, `CheckSuite` -> `check suite`.
 *
 * Split on the camel hump rather than looked up in a table, for the same reason
 * `reasonLabel` has a fallback: GitHub adds subject types, and a table would
 * turn a new one into an empty string on the board. This produces a readable
 * phrase for every type that has ever existed and every type that will.
 */
export function typeWord(type) {
  const raw = String(type ?? '').trim();
  if (!raw) return 'notification';
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * The part of `subject.url` after the repository — `issues/123`, `pulls/456`.
 *
 * `/api/v3/` is GitHub Enterprise Server's prefix, so both shapes are matched;
 * a self-hosted install is the whole reason the API address is a field.
 * Returns '' for a subject with no URL at all, which is the normal case for
 * `CheckSuite` and for `Discussion` — GitHub sends `"url": null` there, and a
 * connector that assumed a string would throw on the first CI notification it
 * ever saw.
 */
const REPO_PATH = /^\/(?:api\/v3\/)?repos\/[^/]+\/[^/]+\/(.+)$/;

export function subjectPath(url) {
  let pathname;
  try {
    pathname = new URL(String(url ?? '')).pathname;
  } catch {
    return '';
  }
  const m = REPO_PATH.exec(pathname);
  if (!m) return '';
  return m[1].replace(/\/+$/, '').toLowerCase();
}

/**
 * The key that makes a conversation with six notifications ONE board item.
 *
 * The obvious key is the notification id, and it is wrong. GitHub's notification
 * thread is not the conversation: mark a pull request Done, get a new comment,
 * and a notification with a FRESH id arrives about the same pull request. Key on
 * the notification and that pull request is two threads, then three, then five —
 * `threadIndex` (core/triage.mjs:403) counts each as a conversation of one, the
 * model is shown five unrelated fragments, and the board grows five items for
 * one thing that needs doing once.
 *
 * So the key is derived from the SUBJECT — the pull request, the issue, the
 * discussion — which is stable across every notification GitHub will ever send
 * about it.
 *
 * `pulls/456` is rewritten to `issues/456` on purpose, and it is not a
 * convenience. Issues and pull requests share ONE number sequence per
 * repository, so `/repos/o/r/issues/456` and `/repos/o/r/pulls/456` name the
 * same object; GitHub itself uses the issues path for a pull request's comment
 * API. Without the rewrite, a review request and a comment on the same PR land
 * in two threads that can never merge — which is the exact defect this function
 * exists to prevent, arriving through the back door.
 *
 * A `CheckSuite` — which is what `ci_activity` is, and which GitHub sends with
 * `"url": null` — falls back to repository-plus-type. That collapses ALL of a
 * repository's CI noise into one thread, deliberately: "the build for this repo
 * needs looking at" is one board item however many workflows failed.
 *
 * THAT COLLAPSE IS FOR BUILDS AND FOR NOTHING ELSE, and the first cut applied it
 * to every URL-less subject. `Discussion` is the other type GitHub sends with a
 * null `subject.url` — see the comment on `subjectPath`, which says so — so it
 * took the CI fallback and every discussion in a repository landed on the one
 * key `github:o/r:discussion`. Measured: two notifications about two different
 * discussions produced one thread key, `messagesInThread` returned both, and
 * `threadIndex` (core/triage.mjs:403) counted two unrelated questions as one
 * conversation, so the model was shown two fragments glued together. Merging is
 * right for builds and a lie about conversations.
 *
 * So a URL-less subject that is not a check suite is discriminated by its TITLE,
 * hashed because a title is unbounded text and a thread key is an index column.
 * Renaming a discussion therefore starts a new board item, which is the cost of
 * this and is worth paying: a renamed discussion appearing twice is a nuisance,
 * and every discussion in a repository appearing once is a defect. A subject
 * with neither URL nor title has nothing to key on and keeps the old collapse.
 */
const CHECK_SUITE = 'checksuite';

const titleHash = (title) => crypto.createHash('sha256').update(title).digest('hex').slice(0, 12);

export function threadKeyFor(notification) {
  const repo = String(notification?.repository?.full_name ?? '').trim().toLowerCase() || 'github';
  const path = subjectPath(notification?.subject?.url);
  if (path) return `github:${repo}:${path.replace(/^pulls\//, 'issues/')}`;
  const type = String(notification?.subject?.type ?? '').trim().toLowerCase() || 'thread';
  /* Collapsed the same way `notificationRow` collapses it for the subject line,
     so a title that gained a line break between two notifications about one
     discussion still lands on one key. */
  const title = collapse(notification?.subject?.title).toLowerCase();
  if (type === CHECK_SUITE || !title) return `github:${repo}:${type}`;
  return `github:${repo}:${type}:${titleHash(title)}`;
}

/**
 * Where a human clicks.
 *
 * The base is `repository.html_url` when it is an http(s) URL and a URL Zelos
 * built otherwise. THE SCHEME CHECK IS THE POINT. `html_url` is a string that
 * arrived in a payload; `ctx.http` guarantees it is never FETCHED — api.github.com
 * is the only origin on the allow-list — but this one is different, because the
 * value is written into a message body that the board renders, that the settings
 * export copies, and that a model reads. A `javascript:` or `data:` URL in that
 * position is a link the product printed. Two lines refuse it, and the fallback
 * is a URL made of nothing but the repository's own name.
 *
 * The web path is derived from `subject.url` rather than taken from the payload
 * for the same reason, and the mapping is not the identity: the API says
 * `pulls/456` and the web says `pull/456`, the API says `commits/<sha>` and the
 * web says `commit/<sha>`. A release's `subject.url` carries the release ID and
 * the web page is addressed by TAG, which the payload does not contain — so a
 * release links to the repository's releases page rather than to a URL built
 * from the wrong number, which would 404.
 */
function repoHome(repository) {
  const stated = String(repository?.html_url ?? '').trim();
  if (stated) {
    try {
      const u = new URL(stated);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.href.replace(/\/+$/, '');
    } catch { /* fall through to the constructed one */ }
  }
  const full = String(repository?.full_name ?? '').trim();
  return full ? `https://github.com/${full}` : 'https://github.com';
}

export function webUrlFor(notification) {
  const home = repoHome(notification?.repository);
  const path = subjectPath(notification?.subject?.url);
  if (!path) return home;

  let web = '';
  if (/^pulls\/\d+$/.test(path)) web = path.replace(/^pulls\//, 'pull/');
  else if (/^(?:issues|discussions)\/\d+$/.test(path)) web = path;
  else if (/^commits\/[0-9a-f]{7,40}$/.test(path)) web = path.replace(/^commits\//, 'commit/');
  else if (/^releases\//.test(path)) web = 'releases';

  return web ? `${home}/${web}` : home;
}

/* ------------------------------------------------------------------ *
 * Scoping — which repositories the user cares about
 * ------------------------------------------------------------------ */

/**
 * `octocat/Hello-World, acme` -> [{owner, repo}, {owner, repo: null}].
 *
 * A leading scheme and host are stripped, so pasting the address out of the
 * browser bar works — that is what a person reaches for, and telling them off
 * for it in a hint nobody reads is not a design. `octocat/Hello-World/pull/3`
 * therefore also works, since everything past the second segment is dropped.
 *
 * BOTH SIDES ARE LOWERCASED, and this is the bug that would otherwise ship.
 * GitHub repository and owner names are case-INSENSITIVE for addressing and the
 * API returns the canonical case in `full_name`, so a user who types
 * `octocat/hello-world` and a payload that says `octocat/Hello-World` compare
 * unequal as raw strings — and the source silently returns nothing, forever,
 * with no error, which is the failure this product exists to not have.
 *
 * THE HOST STRIP USED TO REQUIRE A SCHEME, and that left the same failure open
 * on the far commoner paste. Measured: `github.com/acme/widgets` parsed as owner
 * `github.com`, repo `acme`, so `inScope` was false for every notification the
 * account has and the source returned nothing, forever, with `ok: true` and no
 * error anywhere. Safari's address bar drops the scheme when you copy, chat
 * clients print the bare host, and a person retyping an address does not type
 * `https://`. `@acme` and an SSH remote (`git@github.com:acme/widgets.git`) went
 * the same way.
 *
 * A DOT IN THE FIRST SEGMENT IS WHAT IDENTIFIES A HOST, which is exact rather
 * than a heuristic: a GitHub login — user or organisation — may contain only
 * letters, digits and hyphens, so a dotted first segment is never an owner. Repo
 * NAMES may contain dots (`acme/widgets.js`), and the second segment is left
 * alone. That covers github.com, www.github.com and any GitHub Enterprise Server
 * host without this function needing to know the configured API address.
 */
export function scopeList(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return [];
  const out = [];
  for (const piece of text.split(/[,\s]+/)) {
    const entry = piece
      .trim()
      .toLowerCase()
      // https:// , ssh:// , git://
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      // `git@github.com:...`, and the `@` a person puts in front of a handle
      .replace(/^[^@/:]*@/, '')
      // a bare host, with an optional port, ending in `/` or the SSH remote's `:`
      .replace(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?[/:]/, '')
      .replace(/^\/+|\/+$/g, '');
    if (!entry) continue;
    const parts = entry.split('/').filter(Boolean);
    if (!parts.length) continue;
    // `.git` is how every clone URL ends and is never part of the repository name.
    const repo = parts.length > 1 ? parts[1].replace(/\.git$/, '') : '';
    out.push({ owner: parts[0], repo: repo || null });
  }
  return out;
}

/** An empty list means "everything I take part in" — never "nothing". */
export function inScope(list, fullName) {
  if (!list.length) return true;
  const name = String(fullName ?? '').trim().toLowerCase();
  if (!name) return false;
  const [owner, repo] = name.split('/');
  return list.some((s) => s.owner === owner && (s.repo === null || s.repo === repo));
}

/* ------------------------------------------------------------------ *
 * One notification -> one message row
 * ------------------------------------------------------------------ */

/**
 * -> a `sink: 'messages'` row, or null for a notification with no id.
 *
 * THE NULL IS THE INTERESTING RETURN. `messageRowId(sourceId, uid, messageId)`
 * (core/db.mjs:270) is `sha256(sourceId|uid|messageId).slice(0,16)`, so every
 * notification with a blank id hashes to the SAME row id — measured: two of them
 * both land on `messageRowId('s_gh', null, '')`. They would not error, they
 * would overwrite each other, and the board would show one row whose contents
 * changed on every sweep. Dropping them is the only honest option and the count
 * is logged.
 *
 * There is no `uid` key on the row, and there must never be one. core/db.mjs:384
 * reads `Number.isFinite(Number(uid)) ? Number(uid) : null`, so `uid: null`
 * becomes 0 while an OMITTED uid stays null — two different row ids for one
 * notification. A release that flips between them re-inserts every row the user
 * has ever seen, on every sweep, forever. A GitHub notification thread id is a
 * decimal string, so it is TEMPTING to put it in `uid`; it is a 64-bit-ish
 * counter that has already passed 2^53 for some accounts, and `Number()` on it
 * would silently round. It goes in `messageId`, as text, where it is exact.
 */
export function notificationRow(notification, { identityEmail = '', now = new Date().toISOString() } = {}) {
  const id = String(notification?.id ?? '').trim();
  if (!id) return null;

  const repository = notification?.repository ?? {};
  const folder = String(repository.full_name ?? '').trim() || 'github';
  const subject = notification?.subject ?? {};
  const title = collapse(subject.title) || '(no title)';
  const reason = String(notification?.reason ?? '').trim().toLowerCase();
  const label = reasonLabel(reason);
  const link = webUrlFor(notification);

  /* THE BODY MUST NOT CONTAIN THE WORD "unsubscribe". core/triage.mjs:392
     `looksBulk` scans the snippet and the first 2,000 characters of the body for
     it and docks 18 points — enough to sink a review request below a week-old
     newsletter. GitHub's own EMAIL notifications carry an unsubscribe footer and
     a `notification.subscription_url` is right there in the payload, so pasting
     one in is the obvious thing to do and it would quietly break the ranking
     this connector exists to feed. The link is the thread's own web address and
     nothing else. */
  /* CAPPED, and the truncation is spent on the title rather than on the link.
     The last line is where a human clicks; slicing the joined string alone would
     have thrown the link away to make room for the 19,000th character of a
     title nobody is reading. The join is still sliced afterwards, because
     `link` comes off `repository.html_url`, which is also a payload string with
     no length anybody here controls. */
  const head = `${label} · ${typeWord(subject.type)} · ${folder}`;
  const room = Math.max(0, BODY_CHARS - head.length - link.length - 2);
  const body = [head, title.slice(0, room), link].join('\n').slice(0, BODY_CHARS);

  const you = String(identityEmail ?? '').trim();
  const me = you ? [{ name: '', email: you }] : [];

  return {
    messageId: `github:thread:${id}`,
    threadKey: threadKeyFor(notification),
    folder,
    /* Always inbound. `direction: 'out'` is what feeds `promised` — the things
       the USER said they would do — and it is mined from what the user wrote.
       A notification is never something the user wrote, not even when the reason
       is `author`: that means they opened the issue, not that they sent this. */
    direction: 'in',
    /* `from_email` is never validated as an address (core/db.mjs:297), so the
       repository is the sender in the same way a publication is the sender of an
       RSS article.
       THE EMAIL IS BLANK ON PURPOSE, AND THE OBVIOUS VALUE IS A TRAP. GitHub's
       real notification sender is `notifications@github.com`, and
       core/triage.mjs:384 `BULK_LOCALPART_RE` matches a local part beginning
       `notification`/`notifications` — so filling in the true address would mark
       EVERY row from this connector as bulk mail and dock all of them 18 points,
       including the review requests. A blank local part matches nothing. It also
       keeps `ctx.correspondents` — the set of people the user emails back —
       free of an address no human reads. */
    from: { name: folder, email: '' },
    to: ADDRESSED_TO_YOU.has(reason) ? me : [],
    cc: COPIED_IN.has(reason) ? me : [],
    subject: `${label} · ${title}`.slice(0, SUBJECT_CHARS),
    /* The read instant, never null. A null lands in `messages.sent_at` as
       NULL, core/db.mjs:441 filters the prompt with `sent_at >= ?`, and SQLite
       makes that NULL for a NULL row — the row is stored and counted and never
       reaches the model or the board. GitHub always sends `updated_at`, so
       this is the guard fireflies.mjs (fab9f6f) and rss.mjs needed and this
       file happened not to; it is here so a payload change cannot turn a
       notification invisible rather than visibly mis-dated. */
    date: parseDate(notification?.updated_at) || now,
    snippet: collapse(body).slice(0, SNIPPET_CHARS),
    text: body,
    hasAttachments: false,
    /* `unread === false` rather than `!unread`. A payload with no `unread` key
       at all is treated as UNREAD, which is the safe direction: an unread
       inbound message is worth +8 (core/triage.mjs:433), and defaulting the
       other way would sink every row from a GitHub that changed its payload. */
    flags: notification?.unread === false ? ['\\Seen'] : [],
  };
}

/* ------------------------------------------------------------------ *
 * The cursor: Last-Modified, and the interval GitHub asked for
 * ------------------------------------------------------------------ */

/**
 * `X-Poll-Interval`, in SECONDS, from any response — 304s carry it too.
 *
 * An ABSENT header keeps whatever was already known; a header of `0` means zero.
 * The distinction matters and is easy to lose: `Number(null)` is 0, so the naive
 * one-liner reads a missing header as "poll as fast as you like" and throws away
 * the interval the server stated last time.
 */
export function pollIntervalFrom(headers, previousMs = 0) {
  const keep = Number.isFinite(previousMs) && previousMs > 0 ? previousMs : 0;
  const raw = headers?.get?.('x-poll-interval');
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!text) return keep;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0) return keep;
  return Math.min(Math.round(seconds * 1000), MAX_POLL_MS);
}

/**
 * The interval a CURSOR is asking for, with the ceiling applied — and applying
 * it here, on the read, is the whole point of the function existing.
 *
 * `pollIntervalFrom` clamps to `MAX_POLL_MS` when the header is parsed, and for
 * a long time that was the only clamp. It is the wrong side to guard alone: a
 * cursor is a PERSISTED kv row that outlives the code which wrote it. An older
 * release of this connector, a hand-edited row, a restored backup, or a future
 * change to `pollIntervalFrom` can all hand this version a number it would
 * never have stored itself.
 *
 * Measured before this existed: a cursor of `{pollIntervalMs: 86_400_000,
 * polledAtMs: a second ago}` made `collect` skip every request, emit "GitHub
 * asked for 86400s between polls — 86399s to go", return `rows: 0, error: null`
 * — which the sweep records as `ok: true, count: 0` — and hand the same cursor
 * straight back, so the number never shrank. That is a source that has quietly
 * stopped for a day while reporting a successful read of nothing, which the
 * comment on MAX_POLL_MS calls the one failure mode this product cannot afford.
 * The ceiling now holds whatever wrote the cursor.
 */
export function pollIntervalOf(cursor) {
  const ms = Math.min(Number(cursor?.pollIntervalMs), MAX_POLL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * How long is left of the interval GitHub asked for, or 0 to poll now.
 *
 * A clock that went BACKWARDS polls immediately rather than waiting out a
 * negative gap. A laptop that wakes with a corrected time, or a machine that
 * moved timezone mid-flight, would otherwise sit out the difference — hours, in
 * the ordinary NTP-correction case — with the source showing no error at all.
 */
export function pollWaitMs(cursor, nowMs) {
  const interval = pollIntervalOf(cursor);
  const last = Number(cursor?.polledAtMs);
  if (interval <= 0) return 0;
  if (!Number.isFinite(last) || last <= 0) return 0;
  const elapsed = nowMs - last;
  if (elapsed < 0) return 0;
  return elapsed >= interval ? 0 : interval - elapsed;
}

/**
 * The sweep's own clock, not this process's.
 *
 * `ctx.now` is `nowISO(tz)` — an ISO string carrying a real offset, so
 * `Date.parse` of it is the correct absolute instant. Reading it rather than
 * calling `Date.now()` is what makes the poll gate testable at all: a test can
 * move time by handing over a different `ctx.now`, with no fake timers and no
 * sleeping. The fallback exists because a caller that forgot `now` should get a
 * working connector, not a NaN.
 */
function clockOf(ctx) {
  const at = Date.parse(String(ctx?.now ?? ''));
  return Number.isFinite(at) ? at : Date.now();
}

/* ------------------------------------------------------------------ *
 * Failures worth rewording
 * ------------------------------------------------------------------ */

/**
 * The transport turns 401 AND 403 into one `AuthError` with one sentence:
 * "rejected the credential — check it in Settings". For GitHub that sentence is
 * right for a 401 and actively misleading for a 403, which is what you get from
 * a PERFECTLY VALID token that is merely missing the `notifications` scope. A
 * user who re-pastes the same token, as instructed, gets the same 403 and no new
 * information — and the sweep has by then rested the source for six hours
 * (AUTH_BLOCK_MS), so they will not even see it fail again for the rest of the
 * morning.
 *
 * The rewrite stays an `AuthError` on purpose. The six-hour rest and the
 * secret-hash unblock in core/sweep.mjs are exactly the behaviour that should
 * follow, whichever of the three causes it was; only the words change.
 */
function explainAuth(err) {
  if (!(err instanceof AuthError)) return err;
  if (err.status === 403) {
    return new AuthError(
      'GitHub answered 403. The response does not say which of three things it was: a classic token '
      + 'without the `notifications` scope (`repo` also grants it), a fine-grained token without read '
      + 'access to Notifications, or GitHub’s secondary rate limit. From a terminal, `zelos doctor` '
      + 'prints the scopes this token actually carries.',
      { status: 403 },
    );
  }
  return new AuthError(
    'GitHub refused the token (401). An expired, revoked or regenerated personal access token reads '
    + 'exactly like this. Mint a new one at https://github.com/settings/tokens and paste it in Settings '
    + '— Zelos will not keep trying with the one it has.',
    { status: err.status ?? 401 },
  );
}

function parseNotifications(text, where) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch {
    /* Not `err.message`. A JSON parse failure quotes the input in its message,
       and that message ends up in `sources[].error`, in /api/state on every
       board read, and in the settings export — see core/sweep.mjs's ERROR_CHARS
       for what a source is capable of putting in a single field. */
    throw new Error(`${where} did not answer with JSON — something between here and GitHub is rewriting the response`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`${where} answered with ${data === null ? 'null' : typeof data}, not a list of notifications`);
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

export function apiBaseOf(settings) {
  const raw = String(settings?.apiBase ?? '').trim();
  return (raw || DEFAULT_API).replace(/\/+$/, '');
}

const keepCount = (settings) => Math.max(1, Math.min(Number(settings?.maxItems) || DEFAULT_KEEP, MAX_NOTIFICATIONS));

export default {
  type: 'github',
  family: 'github',
  label: 'GitHub',
  option: 'GitHub — what needs you: assignments, review requests, mentions',
  configKey: 'sources',
  sink: 'messages',

  credential: {
    label: 'Personal access token',
    help: 'A classic token needs the `notifications` scope (`repo` includes it). A fine-grained token needs '
      + 'read access to Notifications. Zelos only ever reads: nothing it can do with this token changes '
      + 'anything in your account.',
    url: TOKEN_URL,
    required: true,
    /* `as: 'header'` and never a query string. GitHub accepts `Bearer` and
       `token` as prefixes; `Bearer` is the one core/log.mjs redacts BY SHAPE as
       well as by header name, so a stray log line that dumps a request cannot
       print it. That is worth more than matching the older examples in GitHub's
       own docs. */
    send: { as: 'header', name: 'authorization', prefix: 'Bearer ' },
  },

  /* The one origin this connector may contact on its own account. A user on
     GitHub Enterprise Server adds theirs by filling in the address field below —
     `originsFor` adds the origin of every `type: 'url'` field the USER typed,
     and nothing a payload said can widen it. `repository.html_url` naming
     somewhere else is a string in a body, not an address. */
  origins: [DEFAULT_API],

  fields: [
    {
      name: 'apiBase',
      type: 'url',
      label: 'GitHub API address',
      default: DEFAULT_API,
      placeholder: DEFAULT_API,
      hint: 'Leave this alone for github.com. GitHub Enterprise Server is https://your-host/api/v3.',
    },
    {
      name: 'repos',
      type: 'text',
      label: 'Repositories or owners',
      placeholder: 'octocat/Hello-World, acme',
      hint: 'Blank means everything you take part in. Otherwise a comma-separated list; an entry with no '
        + 'slash matches every repository under that owner. Pasting a repository’s web address works too.',
    },
    {
      name: 'includeCi',
      type: 'bool',
      label: 'Include CI activity',
      default: false,
      hint: 'GitHub sends one of these for every failing workflow on a branch you touched. Off by default: '
        + 'for most people it is the noisiest reason there is, and it is a build log, not a person waiting.',
    },
    {
      name: 'includeWatched',
      type: 'bool',
      label: 'Include repositories you only watch',
      default: false,
      hint: 'Off, Zelos asks for participating=true — only threads you were assigned, asked to review, '
        + 'mentioned in, or have already commented on. On, it is everything you watch, which is a firehose.',
    },
    {
      name: 'maxItems',
      type: 'int',
      label: 'Notifications to keep',
      default: DEFAULT_KEEP,
      min: 1,
      max: MAX_NOTIFICATIONS,
    },
  ],

  /**
   * `minIntervalMs` is the STATIC floor and `X-Poll-Interval` is the live one.
   * 60 s is GitHub's documented default for the header, so the manifest agrees
   * with the vendor before a single response has arrived; the cursor takes over
   * from the first one. A non-zero `minIntervalMs` is also what makes
   * core/sweep.mjs's `keepsState` true, which is what gets the state row written
   * at all — a connector with no limits leaves `kv` untouched and would have
   * nowhere to remember a rate-limit rest.
   *
   * `budget` is 120 calls an hour against GitHub's 5,000. That is not timidity:
   * the ordinary cost of this connector is ONE request per sweep and two sweeps
   * an hour, so 120 is sixty times the expected spend and exists only to cap a
   * runaway — a retry loop, a "Sweep now" held down, a bug in the pager. The
   * user's 5,000 is shared with every other thing they point this token at, and
   * a background app that eats it is a background app they uninstall.
   *
   * 250 ms between calls because the only time this makes two in a row is
   * pagination, and back-to-back page requests are what GitHub's secondary rate
   * limiter is watching for.
   */
  limits: {
    minIntervalMs: DEFAULT_POLL_MS,
    minGapMs: 250,
    budget: { calls: 120, perMs: 3_600_000 },
    maxRows: MAX_NOTIFICATIONS,
  },

  async collect(ctx) {
    const settings = ctx.source?.settings ?? {};
    const base = apiBaseOf(settings);
    const cursor = ctx.cursor && typeof ctx.cursor === 'object' && !Array.isArray(ctx.cursor) ? ctx.cursor : {};
    const nowMs = clockOf(ctx);
    const nothing = (next) => ({ parts: [{ label: '', rows: [], error: null, note: null }], cursor: next });

    /* THE POLITENESS GATE, and it runs before a socket exists.
       GitHub states a minimum gap between polls in a header; the manifest cannot
       carry a number the server chooses, so it is carried in the cursor and
       enforced here. Reported as a successful read of nothing — because that is
       what happened — rather than as an error, which would put a red line in the
       Now banner for a connector behaving correctly. */
    const wait = pollWaitMs(cursor, nowMs);
    if (wait > 0) {
      const stated = pollIntervalOf(cursor);
      ctx.emit(`${ctx.label}: GitHub asked for ${Math.round(stated / 1000)}s between polls`
        + ` — ${Math.ceil(wait / 1000)}s to go`, 0, 0);
      /* The CLAMPED number goes back, not the one that arrived. `pollIntervalOf`
         already stops an out-of-range cursor from suppressing the read, but a
         cursor returned unchanged carries the bad value forever and prints it in
         the line above — so the ceiling is written through on first contact and
         the row heals itself instead of being re-clamped on every sweep. */
      return nothing({ ...cursor, pollIntervalMs: stated });
    }

    const scope = scopeList(settings.repos);
    const includeCi = settings.includeCi === true;
    const participating = settings.includeWatched === true ? 'false' : 'true';
    const keep = keepCount(settings);

    const wanted = (n) => {
      if (!n || typeof n !== 'object') return false;
      if (!includeCi && String(n.reason ?? '').toLowerCase() === 'ci_activity') return false;
      return inScope(scope, n?.repository?.full_name);
    };

    /* THE VALIDATOR IS ONLY VALID FOR THE QUESTION IT WAS ASKED.
       `Last-Modified` describes the answer to one URL under one filter. Change
       what is being asked for — add a repo, switch CI activity on, widen from
       participating to watched, raise how many to keep — and the stored
       validator still describes the OLD question, so GitHub answers 304 and the
       connector says "nothing new" about notifications that were sitting on the
       server the whole time.

       Measured before this existed: a sweep scoped to one repo stores a
       validator; the user adds a second repo in Settings; the next sweep sends
       the old `If-Modified-Since`, gets a 304, and reports zero rows while the
       new repo's notifications were in the response body both times. Widening
       from `participating=true` to `false` was the worst case, because the URL
       genuinely changes and the validator is still the narrow one. On a quiet
       account the validator can hold for a day, so the user edits Settings,
       sees a confident green zero, and has nothing to read.

       So the shape of the question is hashed into the cursor, and a validator
       minted under a different shape is dropped rather than sent. Dropping it
       costs one full read, once, which is exactly what a changed question is
       worth. (`onConfigChanged` exists in the interface but nothing calls it,
       so this cannot be done on the write side.) */
    const shape = JSON.stringify([participating, includeCi, keep, base, [...scope].sort()]);
    const shapeChanged = typeof cursor.shape === 'string' && cursor.shape !== shape;

    const matched = [];
    let lastModified = shapeChanged || typeof cursor.lastModified !== 'string'
      ? null
      : cursor.lastModified;
    /* Clamped on the way in as well. `pollIntervalFrom` returns this untouched
       when a response carries no `X-Poll-Interval` — the header is optional and
       304s from an intermediary often drop it — so reading the raw cursor value
       here would copy an out-of-range number forward into the next cursor and
       the source would suppress itself on the sweep after this one instead. */
    let pollIntervalMs = pollIntervalOf(cursor);
    let dropped = 0;
    let aborted = false;
    let truncated = false;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (ctx.signal?.aborted === true) { aborted = true; break; }

      /* `all=false` is sent explicitly rather than left to the default, and it
         is the one query parameter here that is a promise: Zelos never asks for
         notifications the user has already read. It is in the URL so that the
         promise is visible in a packet capture and assertable in a test, not
         only in this comment. */
      const url = `${base}/notifications?all=false&participating=${participating}`
        + `&per_page=${PER_PAGE}&page=${page}`;

      const headers = { 'x-github-api-version': API_VERSION };
      /* The conditional header goes on page ONE only. `Last-Modified` describes
         the collection, not the page; sending it on page 3 invites a 304 in the
         middle of a walk, which has no sensible reading — "nothing changed"
         cannot be true of a page we have not seen. */
      if (page === 1 && lastModified) headers['if-modified-since'] = lastModified;

      let res;
      try {
        res = await ctx.http.get(url, { headers, accept: ACCEPT });
      } catch (err) {
        throw explainAuth(err);
      }

      if (page === 1) pollIntervalMs = pollIntervalFrom(res.headers, pollIntervalMs);

      if (res.status === 304) {
        /* On PAGE ONE this is a successful read of nothing, and it cost nothing
           against the 5,000/hr — the entire reason the conditional dance is
           here. The validator is kept, because clearing it would turn every
           later sweep back into a full read.

           On any LATER page it is not that at all, and the first cut treated it
           as if it were: it returned `nothing(...)`, which threw away every row
           already matched from page one AND stored the new validator, so those
           notifications were lost and the next sweep's genuine 304 meant they
           never came back. Measured with a server answering page 1 with fifty
           notifications and page 2 with 304 — which is what a caching proxy or a
           corporate TLS-inspecting middlebox does — the connector returned zero
           rows and kept the advanced cursor.

           The conditional header is only sent on page one, so a 304 here is an
           intermediary's opinion rather than GitHub's. Stop walking and keep
           what we have. */
        if (page === 1) {
          ctx.emit(`${ctx.label}: nothing new`, 0, 0);
          return nothing({ lastModified, shape, pollIntervalMs, polledAtMs: nowMs });
        }
        ctx.log?.warn?.('a 304 arrived mid-walk, which only an intermediary can mean; keeping the pages already read', { page });
        break;
      }

      if (page === 1) {
        /* Stored VERBATIM and echoed verbatim. An HTTP-date round-tripped
           through `new Date(...).toUTCString()` usually survives, and "usually"
           is not a property to build a cache validator on — the value is the
           server's string and Zelos is not a party to its format. */
        lastModified = res.headers.get('last-modified') || lastModified;
      }

      const batch = parseNotifications(res.text, `${base}/notifications`);
      for (const n of batch) if (wanted(n)) matched.push(n);

      if (batch.length < PER_PAGE) break; // that was the last page
      if (matched.length >= keep) break; // the user has what they asked for
      // GitHub still had more to give and this was the last page allowed.
      if (page === MAX_PAGES) truncated = true;
    }

    const rows = [];
    // Through `parseDate` so a fallback date has the form a parsed one has;
    // core/db.mjs orders `sent_at` as text and `+00:00` and `Z` sort apart.
    const readAt = parseDate(new Date(nowMs).toISOString());
    for (const n of matched.slice(0, keep)) {
      const row = notificationRow(n, { identityEmail: ctx.identityEmail, now: readAt });
      if (row) rows.push(row);
      else dropped += 1;
    }
    if (dropped) {
      ctx.log?.warn('dropped notifications with no id — they would all hash to one row', { dropped });
    }

    /* A CANCELLED READ IS NOT AN EMPTY DAY, and the first cut shaped it exactly
       like one: with `signal.aborted` already true, `collect` made zero requests
       and returned `rows: [], error: null, note: null` alongside a cursor whose
       `polledAtMs` had advanced to now — "I read GitHub and there was nothing".
       The mid-walk case is the sharper one: pages 1 and 2 came back as a
       COMPLETE answer carrying the new `Last-Modified`, so the pages never
       fetched would have been 304'd away on the next sweep and lost.

       Nothing is lost today, because core/sweep.mjs:762 drops the whole run
       before cursors are persisted — but that is the sweep's guarantee and not
       this connector's, and a second caller would not have it. So the cursor is
       handed back UNTOUCHED: the validator, the interval and the poll clock all
       stay where they were, the next read repeats this one, and the rows already
       in hand are still returned (they upsert to the same row ids, so repeating
       them costs nothing). The note is what stops it reading as a clean zero —
       core/sweep.mjs:711 turns any note into `ok: false` with a count, which is
       the shape it already uses for a truncated read: neither success nor
       failure. */
    if (aborted) {
      ctx.emit(`${ctx.label}: cancelled after ${rows.length} notification${rows.length === 1 ? '' : 's'}`,
        rows.length, rows.length);
      return {
        parts: [{
          label: '',
          rows,
          error: null,
          note: 'This read was cancelled part-way through, so it is not the whole picture. The next sweep starts again from where the last finished one left off.',
        }],
        /* The sanitised copy of what arrived, not `ctx.cursor` itself: a legacy
           cursor (a bare string, an array, a `{etag}` from an older release)
           already degraded to `{}` at the top of this function, and handing the
           unreadable original back would keep it in the kv row forever. */
        cursor,
      };
    }

    ctx.emit(`${ctx.label}: ${rows.length} notification${rows.length === 1 ? '' : 's'}`, rows.length, rows.length);

    /* THE CUT IS SAID, NOT REPAIRED. Four full pages with more still on offer
       means the oldest notifications were never fetched — and the page-1
       validator stored below will 304 the next sweep past them, so "later" is
       not when they arrive. The repo filter runs on this side of the wire, so
       with a scope the source could read "ok, 0" while the scoped repository's
       notifications sat on page five. linear.mjs names the identical silence
       as the defect it fixed ("Reading hasNextPage and dropping it on the
       floor…"), and slack notes both of its cuts; the note is the shape
       core/sweep.mjs renders as neither a success nor a failure. */
    const note = truncated
      ? `GitHub has more unread notifications than the ${MAX_NOTIFICATIONS} Zelos reads in one sweep, so the oldest `
        + 'were never fetched. They are not necessarily the least important — catching up on github.com shrinks the '
        + 'pile, and “Include repositories you only watch” is the setting that grows it.'
      : null;

    return {
      parts: [{ label: '', rows, error: null, note }],
      cursor: { lastModified, shape, pollIntervalMs, polledAtMs: nowMs },
    };
  },

  /**
   * `zelos doctor`: whose token is this, and can it do the job?
   *
   * `GET /user` is the cheapest authenticated call that NAMES the account. There
   * is a cheaper one — `GET /rate_limit` does not count against the allowance at
   * all — and it is the wrong one: it can prove a token is valid but not whose,
   * and "a token works" is not the line that was asked for. A user with three
   * GitHub accounts needs to be told which one Zelos is reading, and that
   * sentence is worth one request an hour.
   *
   * `x-oauth-scopes` is then read off the SAME response, which is what makes the
   * scope diagnosis free. Three states, and they are genuinely different facts:
   *
   *   header absent  — a fine-grained token or a GitHub App token. These carry
   *                    no scope list at all, so nothing can be concluded, and
   *                    saying so is more useful than guessing.
   *   header empty   — a CLASSIC token with nothing ticked. GitHub sends the
   *                    header with an empty value, which is why `null` and `''`
   *                    must not be collapsed: one is "cannot tell", the other is
   *                    "certainly cannot read notifications".
   *   header listed  — checkable. Neither `notifications` nor `repo` means every
   *                    read will 403, which is a fact and gets a `fail`.
   */
  async check(source, ctx) {
    const base = apiBaseOf(source?.settings);
    /* The module constant, not `this.credential.url`. A `check` reached through
       a destructured reference — which is exactly how a future doctor refactor
       would reach it — has no receiver, and a diagnostic that throws
       "cannot read properties of undefined" is the one crash a diagnostic may
       never have. */
    const mint = `Mint one at ${TOKEN_URL} with the \`notifications\` scope ticked, then paste it in Settings → Sources.`;

    let res;
    try {
      res = await ctx.http.get(`${base}/user`, {
        headers: { 'x-github-api-version': API_VERSION },
        accept: ACCEPT,
      });
    } catch (err) {
      /* A RATE LIMIT IS NOT A BROKEN SETTING, and telling a rate-limited user to
         check their network is worse than saying nothing: the machine can reach
         GitHub — it just did — and the API address is right. Measured before
         this arm existed: a 429 came back as `fail` with the action "Check that
         this machine can reach GitHub, and that the API address in Settings →
         Sources is right", and the detail printed the host twice because the
         transport's message already names it.

         `warn`, not `fail`. Nothing here needs the user to do anything and the
         allowance rolls over on its own, so this must not set doctor's exit
         code — but it is worth a line, because it also explains why the board
         has been quiet. Both flavours land here and the error's own sentence
         says which: GitHub's 429, and `ctx.http`'s own 120-an-hour cap being
         spent before a socket exists. */
      if (err instanceof RateLimitError) {
        const mins = Math.ceil((Number(err.retryAfterMs) || 0) / 60_000);
        const when = mins > 0
          ? ` The allowance rolls over in about ${mins} minute${mins === 1 ? '' : 's'}.`
          : ' The allowance rolls over on its own.';
        return {
          status: 'warn',
          detail: `${err.message}, so Zelos could not ask it whose token this is.${when}`,
          action: null,
        };
      }
      const explained = explainAuth(err);
      return {
        status: 'fail',
        detail: `${base}: ${explained?.message || String(err)}`,
        action: explained instanceof AuthError ? mint : 'Check that this machine can reach GitHub, and that the API address in Settings → Sources is right.',
      };
    }

    let login = '';
    try {
      login = String(JSON.parse(res.text)?.login ?? '').trim();
    } catch { /* answered below, with the status rather than the parser's words */ }

    if (!login) {
      return {
        status: 'fail',
        detail: `${base}/user answered ${res.status} but named no account, so Zelos cannot tell whose token this is.`,
        action: 'That is usually a proxy answering instead of GitHub. Check the API address in Settings → Sources.',
      };
    }

    const limit = Number(res.headers.get('x-ratelimit-limit'));
    const left = Number(res.headers.get('x-ratelimit-remaining'));
    const budget = Number.isFinite(limit) && Number.isFinite(left) && limit > 0
      ? ` · ${left.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} requests left this hour`
      : '';

    const rawScopes = res.headers.get('x-oauth-scopes');
    if (rawScopes === null || rawScopes === undefined) {
      return {
        status: 'pass',
        detail: `@${login}${budget} · fine-grained or app token (it states no scopes, so Zelos cannot check them from here).`,
      };
    }

    const scopes = String(rawScopes).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!scopes.length) {
      return {
        status: 'fail',
        detail: `@${login}${budget} · this classic token carries no scopes at all, so it can read a public profile and nothing else.`,
        action: mint,
      };
    }
    if (!scopes.includes('notifications') && !scopes.includes('repo')) {
      return {
        status: 'fail',
        detail: `@${login}${budget} · scopes: ${scopes.join(', ')} — neither \`notifications\` nor \`repo\`, so GitHub will answer 403 to every read.`,
        action: mint,
      };
    }
    return { status: 'pass', detail: `@${login}${budget} · scopes: ${scopes.join(', ')}` };
  },
};
