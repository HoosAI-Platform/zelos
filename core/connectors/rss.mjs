/**
 * core/connectors/rss.mjs — an RSS or Atom feed.
 *
 * This is the connector written to prove the interface, and it was chosen
 * because it needs no credential and no vendor account: the whole of it can be
 * exercised against a local HTTP server with no secret store involved. If the
 * contract were awkward for a source this plain, it would be wrong.
 *
 * Three things it demonstrates that a mail account cannot:
 *
 *  - THE CURSOR IS OPAQUE, and here it is HTTP's own incremental mechanism.
 *    `ETag` and `Last-Modified` come back as `If-None-Match` and
 *    `If-Modified-Since`, and a 304 is a successful read of nothing. Zelos never
 *    looks inside the value; it stores what it was handed and hands it back.
 *  - A ROW WITHOUT A `uid`. core/db.mjs:384 reads `Number.isFinite(Number(uid))
 *    ? Number(uid) : null`, so `uid: null` becomes 0 and an OMITTED uid becomes
 *    null — two different row ids for the same entry (36c5d228c13041e4 against
 *    58ac70ac2a9131aa, measured). A connector that emits `uid: null` on one
 *    release and omits it on the next re-inserts every row it has ever seen, on
 *    every sweep, forever. There is no `uid` key anywhere below and there must
 *    never be one: a feed entry has no integer identity.
 *  - `sink: 'messages'` FOR SOMETHING THAT IS NOT MAIL. `source_id` and `folder`
 *    are free text and `from_email` is never validated as an address, so an
 *    article is a message that arrived from a publication — which is exactly
 *    how the board should read it. The record types are named for how the board
 *    reads a thing, not for the vendor's noun.
 *
 * The parser is deliberately small and deliberately not a parser. A feed is a
 * stranger's XML; the only questions asked of it are "which elements are items"
 * and "what text is inside this one", and both are answered by scanning rather
 * than by building a tree. Nothing here evaluates, resolves an entity file, or
 * follows a URL the document names — `ctx.http` would refuse the last one
 * anyway, which is the point of the allow-list.
 */

import crypto from 'node:crypto';

import { htmlToText, parseDate } from '../sources/mime.mjs';

/** How much of a feed is worth reading. Beyond this it is an archive, not news. */
const MAX_ENTRIES = 200;

/**
 * How many dateless entries a cursor remembers a first-seen instant for. See
 * `collect`: at ~43 characters each, 64 of them is under 3 KB of the 4 KB
 * ceiling core/sweep.mjs puts on a cursor, with room left for the validators
 * and the address beside them.
 */
const SEEN_MAX = 64;

/**
 * core/sweep.mjs's ceiling on a serialised cursor, restated. Past it the
 * cursor is DROPPED whole, not trimmed, with only a log line — see the trim at
 * the bottom of `collect` for what that would cost this connector.
 */
const CURSOR_MAX_CHARS = 4096;

/** The snippet the board shows; the body it can open. */
const SNIPPET_CHARS = 400;
const BODY_CHARS = 20_000;

/**
 * The rest of what one entry may put in a row, because BODY_CHARS alone was a
 * cap two of the four fields honoured. `subject` was the collapsed <title>
 * verbatim, and the link was concatenated AFTER the body slice — measured, a
 * 500,000-character title and a 300,000-character link produced a 500,000-char
 * subject and a 320,021-char text against the 20,000 above, bounded by nothing
 * but the transport's 8 MiB response ceiling. A feed is a stranger's XML and
 * both fields land in `messages`, in the search index's title, and on every
 * surface that renders subjects. The numbers are folder.mjs's, for folder.mjs's
 * reasons: 300 is longer than any title a person writes, 2,000 is past every
 * address length worth naming.
 */
const TITLE_CHARS = 300;
const LINK_CHARS = 2_000;
const NAME_CHARS = 120;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

/* ------------------------------------------------------------------ *
 * The scan
 *
 * Every question asked of the XML below is answered by `indexOf` and a
 * character test, never by a regex with `[\s\S]*?` in it. The first version
 * used `<item(\s[^>]*)?>([\s\S]*?)</item\s*>` with matchAll, and a lazy
 * quantifier with nothing to stop it scans to the end of the input for EVERY
 * `<item>` that has no `</item>` after it. Measured: 1 MiB of `<item>` took
 * 12.7 s, 1 MiB of `<!--` 23.8 s, four times longer per doubling, and the
 * transport's 8 MiB cap extrapolated to a quarter of an hour with the event
 * loop pinned — core/server.mjs runs the sweep in-process, so the board and
 * /api/state stopped answering for the duration, and `ctx.signal` cannot
 * pre-empt a synchronous regex. `<title>` repeated inside one item, `<link `
 * repeated inside one item and `<![CDATA[` repeated inside one description
 * had the same shape for the same reason. Same class as core/sources/mime.mjs
 * `stripTags`, same cure: a search that fails from here fails from everywhere
 * later, so one failed search ends the walk instead of starting it again one
 * tag along.
 * ------------------------------------------------------------------ */

/**
 * `<![CDATA[…]]>` is a quoting device, not content.
 *
 * An unterminated section is left as written, which is what the regex this
 * replaces did by not matching it — except that the regex took 22 ms to decide
 * so for 64 KB of openers and four times that per doubling.
 */
function unwrapCdata(input, outside = (text) => text) {
  const s = String(input ?? '');
  let start = s.indexOf('<![CDATA[');
  if (start < 0) return outside(s);
  let out = '';
  let plain = 0;
  while (start >= 0) {
    const end = s.indexOf(']]>', start + 9);
    if (end < 0) break;
    out += outside(s.slice(plain, start)) + s.slice(start + 9, end);
    plain = end + 3;
    start = s.indexOf('<![CDATA[', plain);
  }
  return out + outside(s.slice(plain));
}

/**
 * Comments removed. An unterminated `<!--` takes the rest of the document, as
 * a browser's tokenizer has it and as core/sources/mime.mjs `stripTags` has
 * it; a comment that never closes has nothing after it to keep.
 */
function stripComments(xml) {
  let start = xml.indexOf('<!--');
  if (start < 0) return xml;
  let out = '';
  let plain = 0;
  while (start >= 0) {
    out += xml.slice(plain, start);
    const end = xml.indexOf('-->', start + 4);
    if (end < 0) return out;
    plain = end + 3;
    start = xml.indexOf('<!--', plain);
  }
  return out + xml.slice(plain);
}

/**
 * The most of one element `textOf` will read, in characters: mime.mjs's
 * MAX_HTML_CHARS, applied here as well because the XML-layer decode below runs
 * before `htmlToText` gets the chance to cap its input.
 */
const MAX_TEXT_CHARS = 512 * 1024;

/**
 * A `<` that does not open a complete tag, as `&lt;`.
 *
 * After the XML layer is decoded, "x&lt;y" is "x<y", and `stripTags` reads an
 * unterminated `<y` as a tag running to the end of the input — the rest of a
 * title gone. Escaping it again lets `htmlToText` hand it back as the character
 * it was. Each `<` looks ahead only as far as the next `<` or `>`, so this is
 * linear.
 */
const escapeStrayLt = (s) => s.replace(/<(?![A-Za-z/!?][^<>]*>)/g, '&lt;');

/**
 * The text of one element, markup removed and entities decoded.
 *
 * `htmlToText` is core/sources/mime.mjs's, the same function that turns an HTML
 * mail part into something a model can read: a feed's `<description>` is HTML
 * inside XML about half the time, and re-deriving a tag stripper here would be a
 * second answer to a question this repo has already answered carefully.
 *
 * The XML layer is decoded first, and only outside CDATA. RSS 2.0's own form
 * for markup in a `<description>` is entity-encoded HTML, and Atom's
 * `type="html"` is the same: `&lt;b&gt;cash&lt;/b&gt;` is the tag `<b>`, not the
 * text "<b>". Stripping tags before decoding handed the model — and the stored
 * row — the markup itself. Inside CDATA the text is already the HTML, so
 * decoding it there would turn an escaped `&amp;lt;` into a tag that was never
 * one.
 */
function textOf(raw, type = 'html') {
  let s = String(raw ?? '');
  if (s.length > MAX_TEXT_CHARS) s = s.slice(0, MAX_TEXT_CHARS);
  // Atom xhtml is real elements in the XML: they are the markup and `&lt;` in
  // them is text, so tags come off before entities are decoded, as always.
  if (type === 'xhtml') return htmlToText(unwrapCdata(s));
  // Atom type="text" is the characters themselves; `&lt;b&gt;` is "<b>". They
  // are escaped for htmlToText so it only tidies the whitespace.
  if (type === 'text') {
    return htmlToText(unwrapCdata(s, decodeXmlEntities).replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  }
  return htmlToText(unwrapCdata(s, (text) => escapeStrayLt(decodeXmlEntities(text))));
}

/**
 * How an element's text is to be read -> 'html', 'xhtml' or 'text'.
 *
 * Only Atom says: its `type` attribute is `text`, `html` or `xhtml` (or, on
 * `<content>`, a media type). Everything in RSS is read as HTML, which is what
 * its `<description>` is and the safe reading of a title. An Atom element with
 * no `type` is text by RFC 4287, but feeds that put escaped HTML there without
 * saying so are common, and reading those as text hands the model the markup —
 * so only an explicit `text` is read literally.
 */
function textTypeOf(attrs) {
  const type = attr(attrs, 'type').trim().toLowerCase();
  if (type === 'xhtml' || type === 'application/xhtml+xml') return 'xhtml';
  if (type === 'text' || type === 'text/plain') return 'text';
  return 'html';
}

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const isNameChar = (code) => (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)
  || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x2e || code === 0x2d;
const isSpace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/**
 * Does the qualified name starting at `i` have `name` as its local part?
 * -> the index just past the name, or -1.
 *
 * Namespace prefix optional: `<title>`, `<dc:creator>`, `<atom:link>`. The
 * whole token is read, so `<items>` is not `item` and `<content:encoded>` is
 * not `content`.
 */
function localNameEnd(xml, i, name) {
  let j = i;
  while (isNameChar(xml.charCodeAt(j))) j += 1;
  let local = i;
  if (xml.charCodeAt(j) === 0x3a /* : */) {
    local = j + 1;
    j = local;
    while (isNameChar(xml.charCodeAt(j))) j += 1;
  }
  return j - local === name.length && xml.startsWith(name, local) ? j : -1;
}

/**
 * The next `<name …>` open tag at or after `from` -> {start, attrsAt, open,
 * selfClosing}, or null when no complete tag of that name follows.
 *
 * The name must be followed by whitespace, `/` or `>`, and the tag by a `>`:
 * a tag with no `>` after it is not a tag, and nothing after it is either.
 */
function nextTag(xml, name, from) {
  let pos = from;
  for (;;) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) return null;
    const nameEnd = localNameEnd(xml, lt + 1, name);
    const after = nameEnd < 0 ? -1 : xml.charCodeAt(nameEnd);
    if (nameEnd < 0 || !(isSpace(after) || after === 0x3e /* > */ || after === 0x2f /* / */)) {
      pos = lt + 1;
      continue;
    }
    const gt = xml.indexOf('>', nameEnd);
    if (gt < 0) return null;
    return { start: lt, attrsAt: nameEnd, open: gt + 1, selfClosing: xml.charCodeAt(gt - 1) === 0x2f };
  }
}

/** The next `</name>` at or after `from` -> {at, end}, or null. */
function nextCloser(xml, name, from) {
  let pos = from;
  for (;;) {
    const lt = xml.indexOf('</', pos);
    if (lt < 0) return null;
    const nameEnd = localNameEnd(xml, lt + 2, name);
    if (nameEnd >= 0) {
      let j = nameEnd;
      while (isSpace(xml.charCodeAt(j))) j += 1;
      if (xml.charCodeAt(j) === 0x3e) return { at: lt, end: j + 1 };
    }
    pos = lt + 2;
  }
}

/**
 * The next complete `<name …>…</name>` at or after `from` -> {start, open,
 * close, end}, or null.
 *
 * A self-closing tag has no body and is stepped over. A tag with no closer
 * ends the search outright: nothing later could be closed either, and looking
 * again from each later tag is exactly the quadratic this replaces.
 */
function nextElement(xml, name, from) {
  let pos = from;
  for (;;) {
    const tag = nextTag(xml, name, pos);
    if (!tag) return null;
    if (tag.selfClosing) { pos = tag.open; continue; }
    const closer = nextCloser(xml, name, tag.open);
    if (!closer) return null;
    return { start: tag.start, attrsAt: tag.attrsAt, open: tag.open, close: closer.at, end: closer.end };
  }
}

/** The body of the first matching element, or ''. */
function first(xml, name) {
  const el = nextElement(xml, name, 0);
  return el ? xml.slice(el.open, el.close) : '';
}

/**
 * The text of the first of `names` that has any, read as its own `type` says.
 * `first(a) || first(b)`, keeping the attributes `first` throws away.
 */
function textOfFirst(xml, ...names) {
  for (const name of names) {
    const el = nextElement(xml, name, 0);
    if (!el || el.close === el.open) continue;
    return textOf(xml.slice(el.open, el.close), textTypeOf(xml.slice(el.attrsAt, el.open - 1)));
  }
  return '';
}

/** One attribute off a tag's attribute string. */
function attr(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs || '');
  return m ? (m[2] ?? m[3] ?? '') : '';
}

/**
 * The entry's link.
 *
 * RSS puts it in `<link>`'s body; Atom puts it in a `href` attribute on a
 * self-closing tag and may offer several, of which `rel="alternate"` (or no
 * `rel` at all) is the one a human would click. `rel="enclosure"` is a media
 * file and `rel="self"` is the feed itself, and neither is the article.
 */
/**
 * XML entities, decoded — in a URL, where leaving them is not cosmetic.
 *
 * `&` is not legal raw in XML character data, so a feed that publishes
 * `?a=1&b=2` MUST escape it, and publishers vary in how: `&amp;` from most,
 * `&#038;` from WordPress. Found by pointing this connector at NASA's real feed
 * rather than at a fixture — 2 of 10 entries came back with
 * `?post_type=image-article&#038;p=1036264`, because a person writing a test
 * fixture types a clean URL and never sees this.
 *
 * It matters beyond the href being slightly wrong. That string is the `<guid>`
 * fallback, so it becomes `messageId`, and `messageRowId` hashes it: if the
 * publisher ever changes escaping — `&#038;` to `&amp;`, or a CDN normalising
 * on the way out — the same article hashes to a different row and arrives
 * again as new. It is also `threadKey`, so one article can become two threads.
 *
 * Only the five predefined XML entities plus numeric references are decoded.
 * The HTML named set (`&nbsp;`, `&copy;`, …) is deliberately not: those are not
 * XML entities, a conforming feed cannot use them bare, and decoding them here
 * would mean guessing at bytes the publisher never wrote.
 */
function decodeXmlEntities(s) {
  return String(s ?? '').replace(/&(#\d+|#[xX][0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // A reference outside Unicode, or to a surrogate half, is left as written
      // rather than turned into a replacement character.
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body] ?? whole;
  });
}

function linkOf(xml) {
  const body = first(xml, 'link');
  const inline = collapse(unwrapCdata(body));
  if (inline) return decodeXmlEntities(inline);
  for (let tag = nextTag(xml, 'link', 0); tag; tag = nextTag(xml, 'link', tag.open)) {
    const attrs = xml.slice(tag.attrsAt, tag.open - 1);
    const rel = attr(attrs, 'rel').toLowerCase();
    if (rel && rel !== 'alternate') continue;
    const href = attr(attrs, 'href');
    if (href) return decodeXmlEntities(href.trim());
  }
  return '';
}

/**
 * Who wrote the entry.
 *
 * RSS's `<author>` is text ("dana@vance.example (Dana Vance)") and
 * `<dc:creator>` is a name. Atom's `<author>` is a person construct whose
 * `<name>` sits beside a `<uri>` and an `<email>`; reading the whole element as
 * text made the sender "Ines Calder http://…/ines". So the `<name>` inside it
 * is preferred when there is one.
 */
function authorOf(block) {
  const creator = first(block, 'creator');
  if (creator) return collapse(textOf(creator));
  const author = first(block, 'author');
  return collapse(textOf(first(author, 'name') || author || first(block, 'name')));
}

/**
 * -> {title, date, entries: [{title, link, id, author, date, body}]}
 *
 * Comments are removed first, because a commented-out `<item>` is a real thing
 * in hand-edited feeds and it is not an entry. `date` is the channel's own —
 * `<lastBuildDate>`, Atom's feed-level `<updated>`, `<pubDate>`, `<dc:date>` —
 * and is what `collect` dates an entry by when the entry has none.
 */
export function parseFeed(input) {
  const xml = stripComments(String(input ?? ''));

  // Collected up to MAX_ENTRIES and no further: what lies past the two
  // hundredth entry is an archive, and scanning it would only cost time.
  const blocks = [];
  let firstEntryAt = xml.length;
  const blocksOf = (name) => {
    for (let el = nextElement(xml, name, 0); el && blocks.length < MAX_ENTRIES; el = nextElement(xml, name, el.end)) {
      if (!blocks.length) firstEntryAt = el.start;
      blocks.push(xml.slice(el.open, el.close));
    }
  };
  blocksOf('item');
  if (!blocks.length) blocksOf('entry');

  // The feed's own title is whatever `<title>` comes before the first entry;
  // taking the first `<title>` in the document without that check picks up the
  // first article's title on a feed whose channel has none.
  const head = xml.slice(0, firstEntryAt);
  const title = collapse(textOfFirst(head, 'title'));
  const date = collapse(unwrapCdata(
    first(head, 'lastBuildDate') || first(head, 'updated') || first(head, 'pubDate') || first(head, 'date'),
  ));

  const entries = blocks.map((block) => ({
    title: collapse(textOfFirst(block, 'title')),
    link: linkOf(block),
    // The guid gets the same treatment as the link, and for the same reason:
    // it is usually a URL, it is the FIRST choice for messageId, and an escaped
    // ampersand in it is a row identity that moves when the publisher's
    // escaping does.
    id: decodeXmlEntities(collapse(unwrapCdata(first(block, 'guid') || first(block, 'id')))),
    author: authorOf(block),
    date: collapse(unwrapCdata(
      first(block, 'pubDate') || first(block, 'published') || first(block, 'updated') || first(block, 'date'),
    )),
    body: textOfFirst(block, 'encoded', 'content', 'description', 'summary'),
  }));

  return { title, date, entries };
}

export default {
  type: 'rss',
  family: 'rss',
  label: 'Feed',
  option: 'RSS or Atom feed',
  configKey: 'sources',
  sink: 'messages',

  /* No credential at all — not an optional one. The host must therefore never
     write "No password stored for …" about a feed, which is what makes
     `credential: null` different from `{required: false}`. */
  credential: null,

  /* Empty, and it is not an oversight: the only address this connector may
     contact is the one the user typed into the `url` field below, and the host
     adds the origin of every `type: 'url'` field to the allow-list. A feed that
     redirects off its own origin, or names one in a <link>, is refused. */
  origins: [],

  fields: [
    { name: 'url', type: 'url', label: 'Feed address', required: true, hint: 'The .xml or /feed address, not the site.' },
    { name: 'maxItems', type: 'int', label: 'Entries to keep', default: 50, min: 1, max: MAX_ENTRIES },
  ],

  /* A feed is a static file on somebody's CDN. There is nothing to be gentle
     about, and `maxRows` is the only real limit: a feed that answers with ten
     thousand entries is an archive dump and it is not going in the board. */
  limits: { minIntervalMs: 0, minGapMs: 0, budget: null, maxRows: MAX_ENTRIES },

  async collect(ctx) {
    const url = String(ctx.source?.settings?.url ?? '').trim();
    if (!url) throw new Error('this feed has no address yet — add one in Settings');

    const cursor = ctx.cursor && typeof ctx.cursor === 'object' ? ctx.cursor : {};
    /* A VALIDATOR DESCRIBES ONE ADDRESS. The cursor records the URL it was
       minted at, and when the feed address has been edited in Settings the
       validators are dropped rather than sent: nothing clears
       `source.<id>.cursor` on a settings save, so without this the new address
       was asked with the old address's `If-Modified-Since`. A server ignores
       that header when an `If-None-Match` is beside it (RFC 9110 §13.1.3), but
       the old feed need not have sent an ETag — and then a new feed whose own
       Last-Modified is the older of the two answers 304, forever, about
       entries it has never once sent, and the source reads "unchanged, 0
       entries, ok". One full read per address change is what a change is
       worth. github.mjs hashes the shape of its question into the cursor for
       the same reason; a cursor written before `url` was recorded costs the
       same single read, once. */
    const sameAddress = cursor.url === url;
    const headers = {};
    if (sameAddress && cursor.etag) headers['if-none-match'] = cursor.etag;
    if (sameAddress && cursor.lastModified) headers['if-modified-since'] = cursor.lastModified;

    const res = await ctx.http.get(url, {
      headers,
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    });

    if (res.status === 304) {
      // A successful read of nothing. The cursor is handed straight back so a
      // server that answers 304 forever is never re-read, and the source is
      // reported ok with a count of zero — which is what happened.
      ctx.emit(`${ctx.label}: unchanged`, 0, 0);
      return { parts: [{ label: '', rows: [], error: null, note: null }], cursor };
    }

    const feed = parseFeed(res.text);
    const folder = (feed.title || new URL(url).host).slice(0, TITLE_CHARS);
    const keep = Math.max(1, Math.min(Number(ctx.source?.settings?.maxItems) || 50, MAX_ENTRIES));

    /* AN ENTRY WITH NO DATE IS STILL DATED, AND THE DATE MUST NOT MOVE.
       `pubDate` is optional in RSS 2.0 and hand-rolled feeds leave it out; a
       `date: null` lands in `messages.sent_at` as NULL, and core/db.mjs:441
       filters the prompt with `sent_at >= ?`, which SQLite evaluates to NULL
       for a NULL row. So the entry was stored, counted as new, reported ok with
       a count — and never once reached the model or the board. The same
       failure fireflies.mjs had (fab9f6f), with the same half of the cure: fall
       back to an instant that buys inclusion in the window.

       WHICH instant is where this differs from Fireflies. core/db.mjs's upsert
       sets `sent_at = excluded.sent_at` unconditionally, and a feed is
       re-parsed whole on every 200 — so `|| readAt` alone would re-date every
       dateless entry to "now" each time anything in the feed changed, and a
       month-old post would walk back into the seven-day prompt window as
       today's, every time its neighbours moved. The instant is therefore chosen
       ONCE, the first time the entry is seen, and the cursor remembers it under
       a hash of the entry's identity: the channel's own date first
       (`<lastBuildDate>`, Atom's feed-level `<updated>` — the publisher's own
       claim about when this feed was built, and the entry was in it), then the
       instant of this read. Both go through `parseDate` so the stored form is
       the one a parsed `<pubDate>` has; core/db.mjs orders `sent_at` as text,
       and folder.mjs:424 already paid for learning that `+00:00` and `Z` sort
       apart.

       The memory is bounded at SEEN_MAX because core/sweep.mjs refuses a
       cursor over 4 KB OUTRIGHT — validators and all — and it is keyed by
       identity rather than position so an entry keeps its instant as the feed
       reorders. Dateless entries past the bound are dated afresh on each
       parse, which is the old behaviour minus the NULL; entries that leave the
       feed leave the memory with them. The cursor is not moved by any of this
       — there is no high-water mark here to move — so the Fireflies hazard of
       an invented instant dragging the window forward does not arise. */
    const seenBefore = cursor.seen && typeof cursor.seen === 'object' ? cursor.seen : {};
    const seen = {};
    let remembered = 0;
    const feedDate = parseDate(feed.date);
    const readAt = parseDate(new Date(Date.parse(String(ctx.now ?? '')) || Date.now()).toISOString());

    const rows = feed.entries.slice(0, keep).map((entry) => {
      /* The row identity, and the one thing in this file that must be right
         forever: `messageRowId(sourceId, uid, messageId)` is the primary key, so
         a messageId that changes between releases re-inserts every entry and a
         messageId that collides loses one. A `<guid>` is the publisher's own
         promise of stability and is used verbatim; a link is the next best
         thing; a hash of title-and-date is the last resort and is namespaced so
         it can never be mistaken for a real guid. */
      const messageId = entry.id
        || (entry.link ? `rss:sha256:${sha256(entry.link)}` : `rss:sha256:${sha256(`${entry.title}\n${entry.date}`)}`);
      let date = parseDate(entry.date);
      if (!date) {
        const key = sha256(messageId).slice(0, 12);
        const pinned = typeof seenBefore[key] === 'string' && seenBefore[key] ? seenBefore[key] : null;
        date = pinned || feedDate || readAt;
        if (remembered < SEEN_MAX) { seen[key] = date; remembered += 1; }
      }
      /* The link is inside the body's budget rather than exempt from it, as
         folder.mjs:499 has it: it is measured first and the body takes what is
         left, so `text` cannot pass BODY_CHARS however long either half is.
         Slicing the pair afterwards would silently drop the link for any body
         at the ceiling — the half a reader acts on. */
      const link = entry.link.slice(0, LINK_CHARS);
      const tail = link ? `\n\n${link}` : '';
      const body = entry.body.slice(0, Math.max(0, BODY_CHARS - tail.length));
      return {
        messageId,
        threadKey: messageId,
        folder,
        direction: 'in',
        from: { name: (entry.author || folder).slice(0, NAME_CHARS), email: '' },
        to: [],
        cc: [],
        subject: (entry.title || entry.link || '(untitled)').slice(0, TITLE_CHARS),
        date,
        snippet: collapse(body).slice(0, SNIPPET_CHARS),
        text: `${body}${tail}`.trim(),
        hasAttachments: false,
        flags: [],
      };
    });

    ctx.emit(`${ctx.label}: ${rows.length} entries`, rows.length, rows.length);

    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    // `null` clears a cursor the feed no longer supports; `undefined` would mean
    // "leave whatever was there", which would keep sending a validator this
    // server has stopped honouring. The remembered instants ride along only
    // when there are any, so a feed that dates its entries keeps the cursor it
    // always had.
    const next = etag || lastModified || remembered
      ? { etag: etag || null, lastModified: lastModified || null, url, ...(remembered ? { seen } : {}) }
      : null;

    /* Trimmed until it will actually be stored. core/sweep.mjs refuses a
       cursor over CURSOR_MAX_CHARS OUTRIGHT — validators, pins and all — so an
       oversized cursor is not a big cursor, it is NO cursor: a full re-read
       every sweep, and every dateless entry re-dated on each parse, which is
       the walk-back SEEN_MAX exists to prevent. The arithmetic above SEEN_MAX
       assumed the validators and the address stay small, and a token-bearing
       feed address behind a CDN's long ETag does not. So the pins go first,
       oldest instant first — the entries most likely to have left the window —
       and the validators go last, because one 304 pays for them on every
       sweep. slack.mjs's packCursor is the same trim against the same ceiling. */
    if (next) {
      const size = () => JSON.stringify(next).length;
      const oldestFirst = Object.keys(next.seen ?? {})
        .sort((a, b) => String(next.seen[a]).localeCompare(String(next.seen[b])));
      while (size() > CURSOR_MAX_CHARS && oldestFirst.length) delete next.seen[oldestFirst.shift()];
      if (size() > CURSOR_MAX_CHARS) next.etag = null;
      if (size() > CURSOR_MAX_CHARS) next.lastModified = null;
    }

    return { parts: [{ label: '', rows, error: null, note: null }], cursor: next };
  },
};
