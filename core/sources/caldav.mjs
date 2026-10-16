/**
 * core/sources/caldav.mjs — a minimal CalDAV client, built on global fetch.
 *
 * The shape of the protocol, in three hops:
 *   PROPFIND Depth:0  →  current-user-principal   ("who am I on this server")
 *   PROPFIND Depth:0  →  calendar-home-set        ("where are my collections")
 *   PROPFIND Depth:1  →  the collections themselves, filtered to resourcetype
 *                        `calendar` and, when advertised, VEVENT support
 *   REPORT   Depth:1  →  calendar-query with a time-range, returning raw .ics
 *
 * Servers disagree about almost everything else — namespace prefixes, whether
 * hrefs are absolute or path-only, whether the URL a user pastes is the server
 * root, the principal, the home set or one calendar. So: every URL a server
 * hands back is resolved against the URL it came from, all XML matching is on
 * *local* names with the prefix ignored, and discovery falls back through
 * `/.well-known/caldav` and the origin root before giving up.
 *
 * The XML parser here is deliberately tiny and deliberately incurious: it skips
 * `<!DOCTYPE …>` wholesale, so no entity declaration is ever read, let alone
 * expanded. Server responses are untrusted input like everything else — the
 * calendar text this module returns is data for the ICS parser, never anything
 * that gets executed or fetched.
 *
 * A sweep no longer pays for the whole walk. What the discovery hops found is
 * remembered between runs and the ctag decides whether a calendar has to be
 * read at all — see "Remembering the layout", below.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { paths, writeFileAtomic } from '../config.mjs';
import { log } from '../log.mjs';
import { assertCleartextAllowed } from '../net.mjs';

const dav = log.child('[caldav]');

const DEFAULT_TIMEOUT_MS = 20_000;
/** Refuse to buffer a response larger than this; a calendar is text. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_XML_DEPTH = 512;

/* ------------------------------------------------------------------ *
 * Tiny XML reader
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Index just past a tag, honouring quoted attribute values containing '>'. */
function findTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/** Index just past a `<!…>` declaration, including any internal subset. */
function skipDeclaration(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  return source.length;
}

function parseAttrs(raw) {
  const attrs = Object.create(null);
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].includes(':') ? m[1].slice(m[1].indexOf(':') + 1) : m[1];
    attrs[name.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

function makeNode(name) {
  const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  return { name, local: local.toLowerCase(), attrs: Object.create(null), children: [], text: '' };
}

/**
 * Parse an XML document into a node tree. Iterative, so a deeply nested
 * document costs memory rather than the call stack; malformed markup degrades
 * to a partial tree instead of throwing.
 */
function parseXml(source) {
  const root = makeNode('#document');
  const stack = [root];
  const text = String(source ?? '');
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) root.incomplete = true;
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) root.incomplete = true;
      stack[stack.length - 1].text += text.slice(lt + 9, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      i = skipDeclaration(text, lt);
      if (text[i - 1] !== '>') root.incomplete = true;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) root.incomplete = true;
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    const gt = findTagEnd(text, lt);
    if (gt === -1) { root.incomplete = true; break; }
    const inner = text.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === '/') {
      const closing = makeNode(inner.slice(1).trim());
      if (stack.length === 1 || stack[stack.length - 1].name !== closing.name) root.incomplete = true;
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].local === closing.local) {
          stack.length = d;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s/]/);
    const node = makeNode((nameEnd === -1 ? body : body.slice(0, nameEnd)).trim());
    if (nameEnd !== -1) Object.assign(node.attrs, parseAttrs(body.slice(nameEnd)));
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) {
        dav.warn('XML nesting cap reached; remainder of the document ignored');
        root.incomplete = true;
        break;
      }
      stack.push(node);
    }
  }

  if (stack.length !== 1 || root.children.length !== 1 || root.children[0]?.local !== 'multistatus' || root.text.trim()) root.incomplete = true;
  return root;
}

/** A partial discovery tree cannot establish which calendars exist. */
function discoveryDocument(response) {
  const doc = parseXml(response.text);
  if (doc.incomplete) throw new CalDavError(`Incomplete calendar discovery response from ${hostOf(response.url)}`, { host: hostOf(response.url) });
  return doc;
}

/** Every descendant with this local name, document order. */
function findAll(node, local, out = []) {
  for (const child of node.children) {
    if (child.local === local) out.push(child);
    findAll(child, local, out);
  }
  return out;
}

/** First descendant with this local name, or null. */
function findOne(node, local) {
  for (const child of node.children) {
    if (child.local === local) return child;
    const deeper = findOne(child, local);
    if (deeper) return deeper;
  }
  return null;
}

/** Concatenated character data of a node and everything under it. */
function textOf(node) {
  if (!node) return '';
  let out = node.text;
  for (const child of node.children) out += textOf(child);
  return out;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

class CalDavError extends Error {
  constructor(message, { status = 0, host = '', anonymous = false } = {}) {
    super(message);
    this.name = 'CalDavError';
    this.status = status;
    this.host = host;
    /**
     * Set only on a 401/403 from a hop the origin pin deliberately sent without
     * the credential. It is the difference between "your password is wrong" and
     * "we never offered one", and discovery has to be able to tell them apart —
     * see `isCredentialVerdict`.
     */
    this.anonymous = anonymous;
  }
}

/**
 * Is this 401/403 an answer *about the credential*?
 *
 * It is when the request carried the credential and the server refused it, and
 * it is when there was no credential to carry — both mean the walk cannot get
 * any further and the caller needs to hear about it now.
 *
 * It is not when the origin pin withheld the credential on purpose. That host
 * declined an anonymous caller, which is a fact about the pin, not about the
 * password; treating it as a verdict abandons every remaining search root —
 * including `base`, the URL the user typed, which has not been asked at Depth:1
 * yet. Servers that partition an account across hosts (iCloud answers an
 * unauthenticated PROPFIND with `x-apple-user-partition`) hand back exactly this
 * shape as their ordinary layout, not as an attack.
 */
const isCredentialVerdict = (err) =>
  err instanceof CalDavError && (err.status === 401 || err.status === 403) && !err.anonymous;

/** The other half of that split: a hop refused because we withheld the password. */
const wasDeclinedAnonymously = (err) => err instanceof CalDavError && err.anonymous;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
}

function basicAuth(user, pass) {
  if (!user) return null;
  return `Basic ${Buffer.from(`${user}:${pass ?? ''}`, 'utf8').toString('base64')}`;
}

/**
 * The origin the user typed. Credentials go there and nowhere else.
 *
 * Everything after the first request is chosen by the server: a `Location`
 * header, or an `href` inside a multistatus document naming the principal, the
 * calendar-home-set, or a collection. A server that is hostile — or merely
 * compromised, or answering a URL the user mistyped — can point any of those at
 * a host it controls, and Basic auth would carry the calendar password there in
 * a header trivially decoded back to plaintext. So authorisation is pinned to
 * one origin: the hop is still followed, just anonymously, and if it needs a
 * password the caller gets told to point the calendar URL at it directly.
 */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * One WebDAV request. Follows at most one redirect, re-issuing the same method
 * and body — a 301 from `/` to `/dav/` is how several servers point you at the
 * real collection, and dropping the body there turns a REPORT into a no-op.
 */
async function request(method, url, { user, pass, body = null, depth = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal, redirectsLeft = 1, authOrigin } = {}) {
  const headers = { Accept: 'application/xml, text/xml' };
  // Defaults to this call's own origin, so a direct request is always authorised
  // and only a server-chosen hop can fall outside it.
  const scope = authOrigin ?? originOf(url);
  const auth = originOf(url) === scope ? basicAuth(user, pass) : null;
  if (auth) headers.Authorization = auth;
  if (depth !== null) headers.Depth = String(depth);
  if (body !== null) headers['Content-Type'] = 'application/xml; charset=utf-8';

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw new CalDavError('request aborted', { host: hostOf(url) });
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('timeout'));
  }, timeoutMs);

  // The deadline and the caller's abort wiring must outlive the header
  // exchange: fetch() resolves the moment the status line and headers are in,
  // and the body — which a stalling or trickling server controls — is read
  // after that. Tearing the timer down when fetch() resolves would leave the
  // body read unbounded and un-abortable, so everything through the last body
  // byte runs inside this try and the teardown happens once, in the finally.
  let response;
  let text;
  try {
    try {
      response = await fetch(url, { method, headers, body, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      const reason = timedOut
        ? `no response within ${timeoutMs}ms`
        : signal?.aborted
          ? 'cancelled'
          : err?.message || String(err);
      throw new CalDavError(`CalDAV ${method} could not reach ${hostOf(url)}: ${reason}`, { host: hostOf(url) });
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (redirectsLeft > 0 && location) {
        let next;
        try {
          next = new URL(location, url);
        } catch {
          throw new CalDavError(`CalDAV ${method} at ${hostOf(url)} redirected to an unusable location`, {
            status: response.status,
            host: hostOf(url),
          });
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new CalDavError(`CalDAV ${method} at ${hostOf(url)} redirected to a non-HTTP location`, {
            status: response.status,
            host: hostOf(url),
          });
        }
        dav.debug(`${method} ${response.status} -> ${next.origin}${next.pathname}`);
        return await request(method, next.toString(), { user, pass, body, depth, timeoutMs, signal, redirectsLeft: redirectsLeft - 1, authOrigin: scope });
      }
      throw new CalDavError(`CalDAV ${method} at ${hostOf(url)} redirected more than once`, {
        status: response.status,
        host: hostOf(url),
      });
    }

    if (response.status === 401 || response.status === 403) {
      // Told apart on purpose: "your password is wrong" and "we declined to send
      // your password to a host you did not choose" are different problems, and a
      // user given the first message for the second one will keep retyping a
      // password that was never the issue.
      if (!auth && basicAuth(user, pass)) {
        throw new CalDavError(
          `${hostOf(url)} asked for a password, but it is not the calendar host you configured — ` +
            'Zelos will not send your calendar password to a host a server redirected it to. ' +
            `If ${hostOf(url)} really is your calendar, put its address in the calendar URL directly.`,
          { status: response.status, host: hostOf(url), anonymous: true },
        );
      }
      throw new CalDavError(
        `CalDAV rejected the credentials for ${hostOf(url)} (HTTP ${response.status}). ` +
          'iCloud and Fastmail need an app-specific password, not the account password.',
        { status: response.status, host: hostOf(url) },
      );
    }

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_RESPONSE_BYTES) {
      // Cancel explicitly: a refused body left unconsumed keeps its pooled
      // connection busy and the next request to the same host queues behind it.
      response.body?.cancel()?.catch?.(() => {});
      throw new CalDavError(`CalDAV response from ${hostOf(url)} is too large (${declared} bytes)`, {
        status: response.status,
        host: hostOf(url),
      });
    }

    try {
      text = await readBodyCapped(response, url);
    } catch (err) {
      if (err instanceof CalDavError) throw err;
      const reason = timedOut
        ? `no response within ${timeoutMs}ms`
        : signal?.aborted
          ? 'cancelled'
          : err?.message || String(err);
      throw new CalDavError(`CalDAV ${method} response from ${hostOf(url)} could not be read: ${reason}`, {
        status: response.status,
        host: hostOf(url),
      });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (response.status >= 400) {
    throw new CalDavError(`CalDAV ${method} at ${hostOf(url)} failed: HTTP ${response.status}`, {
      status: response.status,
      host: hostOf(url),
    });
  }

  return { status: response.status, text, url };
}

/**
 * Read a response body while counting bytes, not after buffering them.
 * A content-length check upstream catches the honest oversized response; this
 * catches the chunked one that never declares a length — the read stops and
 * the connection is cancelled the moment the cap is crossed, so a server
 * trickling gigabytes costs at most MAX_RESPONSE_BYTES of memory.
 */
async function readBodyCapped(response, url) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CalDavError(`CalDAV response from ${hostOf(url)} is too large`, {
        status: response.status,
        host: hostOf(url),
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/* ------------------------------------------------------------------ *
 * Request bodies
 * ------------------------------------------------------------------ */

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

const BODY_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop><d:current-user-principal/><d:principal-URL/><d:resourcetype/></d:prop></d:propfind>`;

const BODY_HOME_SET = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;

const BODY_COLLECTIONS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${NS}><d:prop>
  <d:resourcetype/><d:displayname/>
  <c:supported-calendar-component-set/><c:calendar-description/>
  <cs:getctag/><ic:calendar-color/>
</d:prop></d:propfind>`;

/** An ISO string, a Date or epoch milliseconds, read as milliseconds. */
function msOf(value, fallbackMs) {
  if (value === undefined || value === null || value === '') return fallbackMs;
  const at = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : new Date(String(value));
  const ms = at.getTime();
  return Number.isNaN(ms) ? fallbackMs : ms;
}

const DAY_MS = 86_400_000;
const floorDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const ceilDay = (ms) => Math.ceil(ms / DAY_MS) * DAY_MS;

/** CalDAV wants basic-format UTC: 20260811T140000Z. */
function davStamp(ms) {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

function calendarQueryBody(start, end) {
  // Both values come from davTime, which emits a fixed 16-character basic-format
  // timestamp — nothing user-controlled reaches the document.
  return `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query ${NS}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${start}" end="${end}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/* ------------------------------------------------------------------ *
 * Response shapes
 * ------------------------------------------------------------------ */

/** Absolute URL for an href a server handed back, resolved against its source. */
function resolveHref(base, href) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  try {
    const resolved = new URL(raw, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/** A propstat block counts only if its status line says 200. */
function okProps(responseNode) {
  const out = [];
  const propstats = findAll(responseNode, 'propstat');
  if (!propstats.length) {
    const prop = findOne(responseNode, 'prop');
    if (prop) out.push(prop);
    return out;
  }
  for (const ps of propstats) {
    const status = textOf(findOne(ps, 'status'));
    if (status && !/\b200\b/.test(status)) continue;
    const prop = findOne(ps, 'prop');
    if (prop) out.push(prop);
  }
  return out;
}

/** First href found under a named property, across all 200 propstats. */
function hrefUnder(doc, base, propLocal) {
  for (const response of findAll(doc, 'response')) {
    for (const prop of okProps(response)) {
      for (const child of prop.children) {
        if (child.local !== propLocal) continue;
        const href = findOne(child, 'href');
        const resolved = resolveHref(base, textOf(href || child));
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

function calendarsFrom(doc, base) {
  const out = [];
  for (const response of findAll(doc, 'response')) {
    const href = resolveHref(base, textOf(findOne(response, 'href')));
    if (!href) { Object.defineProperty(out, 'incomplete', { value: true, configurable: true }); continue; }

    let isCalendar = false;
    let classified = false;
    let name = '';
    let color = null;
    let ctag = null;
    let components = null;

    for (const prop of okProps(response)) {
      for (const child of prop.children) {
        switch (child.local) {
          case 'resourcetype':
            classified = true;
            if (child.children.some((t) => t.local === 'calendar')) isCalendar = true;
            // Scheduling inboxes/outboxes are not something a person reads.
            if (child.children.some((t) => t.local === 'schedule-inbox' || t.local === 'schedule-outbox')) {
              isCalendar = false;
            }
            break;
          case 'displayname':
            name = textOf(child).trim();
            break;
          case 'calendar-color':
            color = textOf(child).trim() || null;
            break;
          case 'getctag':
            ctag = textOf(child).trim() || null;
            break;
          case 'supported-calendar-component-set':
            components = child.children
              .filter((c) => c.local === 'comp' && c.attrs.name)
              .map((c) => String(c.attrs.name).toUpperCase());
            break;
          default:
            break;
        }
      }
    }

    // Optional properties may return 404; only the resource type is needed
    // to prove that an omitted collection is not another calendar.
    if (!classified) Object.defineProperty(out, 'incomplete', { value: true, configurable: true });
    if (!isCalendar) continue;
    if (components && components.length && !components.includes('VEVENT')) continue;
    out.push({
      href,
      name: name || decodeURIComponent(new URL(href).pathname.replace(/\/$/, '').split('/').pop() || 'Calendar'),
      color,
      ctag,
      components: components || [],
    });
  }
  return out;
}

/** Candidate roots to probe, in order, for a URL a person typed or pasted. */
function candidateRoots(url) {
  const roots = [url];
  try {
    const parsed = new URL(url);
    const wellKnown = new URL('/.well-known/caldav', parsed).toString();
    const origin = new URL('/', parsed).toString();
    for (const candidate of [wellKnown, origin]) {
      if (!roots.includes(candidate)) roots.push(candidate);
    }
  } catch {
    /* a malformed URL fails on the first attempt, with a real message */
  }
  return roots;
}

function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) throw new CalDavError('No calendar URL was given');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new CalDavError(`"${raw}" is not a usable calendar URL`);
  }
  if (parsed.protocol === 'webcal:') parsed.protocol = 'https:';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CalDavError(`Calendar URLs must be http or https, got ${parsed.protocol}`);
  }
  return parsed.toString();
}

/* ------------------------------------------------------------------ *
 * Remembering the layout
 * ------------------------------------------------------------------ */

/**
 * Every sweep used to buy the same three answers again.
 *
 * `fetchRange` ran the full walk — principal, then calendar-home-set, then the
 * Depth:1 collection listing — before it could ask a single calendar for a
 * single event, against a layout that had not moved since the account was
 * configured. On a five-minute sweep that is three remote round trips an hour
 * apiece to relearn something already known, and it was the largest fixed cost
 * in a calendar sweep.
 *
 * So the *layout* is remembered: the principal, the home set, and the URL whose
 * listing actually produced calendars. The listing itself is deliberately not
 * remembered. That one PROPFIND still runs on every sweep, because its response
 * is where each collection's ctag lives, and a cached ctag would be a cache
 * that answers "nothing changed" forever. Three requests become one, and the
 * fresh ctag then decides whether the REPORT behind it has to happen at all.
 *
 * The principal and the home set are kept for the day the listing root stops
 * answering. They are the rungs above it, and a provider that moves a
 * collection has almost always left them where they were, so `targetsFor` walks
 * back up them one at a time before it gives up and re-runs the walk from the
 * URL the user typed. Remembering them and then not consulting them would be a
 * cache of two strings that cost a write and bought nothing.
 *
 * The record is keyed by a hash of the normalised URL and the username, so
 * changing either in Settings keys a different record and is its own
 * invalidation; `invalidate()` covers the edits that change neither. **No
 * password goes into the key and none is written to the file** — what is stored
 * is server layout, in the Zelos home at 0600, and nothing else.
 *
 * The origin pin is untouched by any of this. `authOrigin` is derived from the
 * URL the user configured on every call, so a remembered href that points
 * somewhere else is still requested anonymously, exactly as a freshly
 * discovered one would be.
 *
 * Every read and write here is best effort. A cache that cannot be opened,
 * parsed or written falls back to the full walk rather than failing a sweep.
 */

const CACHE_SCHEMA = 1;
/**
 * How long a remembered layout stands before the full walk runs again. It can
 * be generous: the listing is re-read every sweep anyway, and a listing that
 * fails or comes back empty drops the record on the spot. What this bounds is
 * the rarer case — a provider that moves the principal or the home set under an
 * account whose collection URLs still answer.
 */
const LAYOUT_TTL_MS = 6 * 60 * 60 * 1000;

/** Parsed records, so repeat sweeps in one process do not re-read the file. */
const layouts = new Map();

function accountKey(base, user) {
  return crypto.createHash('sha256')
    .update([CACHE_SCHEMA, base, user ?? ''].join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function layoutFile(key) {
  return path.join(paths().cacheDir, 'caldav', `${key}.json`);
}

const stillFresh = (record) => Date.now() - record.at < LAYOUT_TTL_MS;

function readLayout(key) {
  const memo = layouts.get(key);
  if (memo) return stillFresh(memo) ? memo : null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(layoutFile(key), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.schema !== CACHE_SCHEMA || typeof parsed.listRoot !== 'string') return null;

  const record = {
    listRoot: parsed.listRoot,
    principal: typeof parsed.principal === 'string' ? parsed.principal : null,
    homeSet: typeof parsed.homeSet === 'string' ? parsed.homeSet : null,
    at: Number(parsed.at) || 0,
  };
  if (!stillFresh(record)) return null;
  layouts.set(key, record);
  return record;
}

function writeLayout(key, record) {
  layouts.set(key, record);
  try {
    const file = layoutFile(key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify({ schema: CACHE_SCHEMA, ...record })}\n`, 0o600);
  } catch (err) {
    dav.debug(`could not remember the calendar layout: ${err.message}`);
  }
}

/**
 * The documents each calendar last returned, kept in this process and nowhere
 * else.
 *
 * A ctag that has not moved means the collection has not changed, so the REPORT
 * behind it can be skipped — but only if the answer it would have given is
 * still to hand, which is why the answer is kept. It is kept in memory on
 * purpose: this is the text of somebody's calendar, and the database is where
 * calendar contents belong. A long-lived sweep gets the whole benefit of it; a
 * one-shot CLI run pays for one REPORT per calendar, which is what it was
 * always going to pay.
 *
 * The budget is a memory ceiling, not a policy: entries are dropped oldest
 * first once the total passes it, so a person with a great many calendars costs
 * bounded memory rather than however much their provider felt like sending.
 */
const documents = new Map();
const MAX_REMEMBERED_BYTES = 32 * 1024 * 1024;
let rememberedBytes = 0;

const slotFor = (key, href) => `${key} ${href}`;

function drop(slot) {
  const entry = documents.get(slot);
  if (!entry) return;
  rememberedBytes -= entry.bytes;
  documents.delete(slot);
}

function recall(key, href) {
  return documents.get(slotFor(key, href)) || null;
}

function remember(key, href, { ctag, start, end, docs }) {
  const slot = slotFor(key, href);
  drop(slot);
  const bytes = docs.reduce((sum, doc) => sum + doc.length, 0);
  if (bytes > MAX_REMEMBERED_BYTES) return;
  documents.set(slot, { ctag, start, end, docs, bytes });
  rememberedBytes += bytes;
  // Map iteration is insertion order, so the first key is the oldest entry.
  for (const oldest of documents.keys()) {
    if (rememberedBytes <= MAX_REMEMBERED_BYTES) break;
    if (oldest !== slot) drop(oldest);
  }
}

/** Drop one account's record, on disk and in memory, documents included. */
function forgetLayout(key) {
  layouts.delete(key);
  for (const slot of [...documents.keys()]) {
    if (slot.startsWith(`${key} `)) drop(slot);
  }
  try {
    fs.rmSync(layoutFile(key), { force: true });
  } catch (err) {
    dav.debug(`could not drop a remembered calendar layout: ${err.message}`);
  }
}

/**
 * Forget what is remembered about one account — or, with no argument, about
 * every account.
 *
 * Settings calls this whenever a calendar is written or removed. A URL or a
 * username that changed keys a different record and would have been rediscovered
 * anyway; this is for the edits that change neither and still mean the old
 * answer should not be trusted — a password corrected, a collection added on the
 * server, an account deleted outright.
 */
export function invalidate({ url = null, user = null } = {}) {
  if (url === null || url === undefined) {
    layouts.clear();
    documents.clear();
    rememberedBytes = 0;
    try {
      fs.rmSync(path.join(paths().cacheDir, 'caldav'), { recursive: true, force: true });
    } catch (err) {
      dav.debug(`could not clear the calendar layout cache: ${err.message}`);
    }
    return;
  }
  let base;
  try {
    base = normalizeUrl(url);
  } catch {
    return; // a URL that cannot be normalised was never a cache key
  }
  forgetLayout(accountKey(base, user));
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/*
 * Sending the password in the clear. (QA, 2026-10-10, TT-3425)
 *
 * `basicAuth` puts the username and password on every request to the typed
 * origin, base64'd — readable by anybody on the path — and an account typed as
 * `http://` used to send it that way without a word. Each entry point below now
 * runs `assertCleartextAllowed` (core/net.mjs) on the normalised URL before it
 * opens a single connection: mail's `requireTls` rule, read off the calendar's
 * own `requireTls`.
 *
 * Only the typed URL is checked because only the typed origin ever gets the
 * credential — the origin pin above sends every other hop anonymously, so an
 * `http://` href the server hands back carries nothing worth refusing.
 *
 * It is NOT inside `request()`, though that looks like the one place that would
 * catch everything. `request()`'s callers swallow every error that is not a
 * credential verdict — that is how discovery falls through its candidate roots
 * — so a refusal thrown there would come back as "no calendars here", the walk
 * would end empty, `targetsFor` would `forgetLayout` on every sweep, and the
 * user would be told nothing. Thrown here, before any of that, it reaches the
 * sweep and the Test button as itself.
 */

/**
 * Walk current-user-principal -> calendar-home-set -> calendar collections.
 * -> {principal, homeSet, listRoot, calendars:[{href, name, color, ctag, components}]}
 * Throws CalDavError (with .status and .host) when the server cannot be
 * reached, when it rejects the credentials, and when the only thing standing
 * between the walk and a calendar is a host the origin pin would not spend the
 * password on — that last one is a real failure with a real remedy in its
 * message, and it must never come back as an empty, unexplained calendar list.
 *
 * `listRoot` is the URL whose Depth:1 listing produced the calendars — the one
 * hop worth repeating on its own later, and null when nothing produced any.
 */
export async function discover({ url, user, pass, requireTls = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const base = normalizeUrl(url);
  // Before the first request, and on the typed URL only — see "Sending the
  // password in the clear", below. `request()` is the wrong place for it.
  assertCleartextAllowed(base, { user, requireTls });
  // Every URL followed from here on is one the server chose. Pinning the
  // credential scope to the address the user typed is what keeps a hostile
  // `href` from turning discovery into password delivery.
  const opts = { user, pass, timeoutMs, signal, authOrigin: originOf(base) };

  let principal = null;
  let reached = null;
  // The failure worth reporting is the one on the URL the user actually typed,
  // not whatever /.well-known said afterwards — so this is only ever set once.
  let probeError = null;
  // The first hop the pin refused to authenticate, kept rather than thrown. It
  // must not end the walk — a partitioned account puts its calendars behind a
  // second host and its *listing* behind the first — but if the walk then turns
  // up nothing at all, this is the error to report, because its message is the
  // only one that names the host to paste into the calendar URL.
  let declined = null;
  const note = (err) => {
    if (!declined && wasDeclinedAnonymously(err)) declined = err;
  };

  for (const root of candidateRoots(base)) {
    try {
      const res = await request('PROPFIND', root, { ...opts, body: BODY_PRINCIPAL, depth: 0 });
      reached = res.url;
      const doc = discoveryDocument(res);
      principal = hrefUnder(doc, res.url, 'current-user-principal') || hrefUnder(doc, res.url, 'principal-url');
      if (principal) break;
    } catch (err) {
      if (!probeError) probeError = err;
      if (isCredentialVerdict(err)) throw err;
      note(err);
    }
  }

  if (!reached && probeError) throw probeError;

  let homeSet = null;
  if (principal) {
    try {
      const res = await request('PROPFIND', principal, { ...opts, body: BODY_HOME_SET, depth: 0 });
      homeSet = hrefUnder(discoveryDocument(res), res.url, 'calendar-home-set');
    } catch (err) {
      note(err);
      dav.debug(`calendar-home-set lookup failed: ${err.message}`);
    }
  }

  // Depth:1 on a collection includes the collection itself, so a URL that
  // already points at one calendar is discovered by exactly the same call.
  const searchRoots = [];
  for (const candidate of [homeSet, base, reached]) {
    if (candidate && !searchRoots.includes(candidate)) searchRoots.push(candidate);
  }

  let listed = false;
  let incompleteListing = false;
  let listError = null;
  for (const root of searchRoots) {
    try {
      const res = await request('PROPFIND', root, { ...opts, body: BODY_COLLECTIONS, depth: 1 });
      const calendars = calendarsFrom(discoveryDocument(res), res.url);
      listed = true;
      if (calendars.incomplete) incompleteListing = true;
      // `res.url`, not `root`: a redirect means the collections live at the
      // address the server pointed at, and that is the hop worth remembering.
      if (calendars.length) {
        if (incompleteListing || listError || (principal && !homeSet)) Object.defineProperty(calendars, 'incomplete', { value: true, configurable: true });
        return { principal, homeSet, listRoot: res.url, calendars };
      }
    } catch (err) {
      listError = err;
      if (isCredentialVerdict(err)) throw err;
      note(err);
      dav.debug(`collection listing failed at ${hostOf(root)}: ${err.message}`);
    }
  }

  // A listing that succeeded and simply held no calendars is an answer, not an
  // error — only report a failure when nothing could be listed at all.
  //
  // Unless a hop was declined anonymously: then "no calendars" is not an answer,
  // it is the part of the account we were not allowed to look at, and returning
  // an empty list makes the source contribute nothing for ever and say nothing
  // about why. `declined` comes first in both throws because it is the error
  // this walk used to raise on the spot, and the one that carries the fix.
  if (!listed) {
    throw declined || listError || probeError
      || new CalDavError(`No DAV collections at ${hostOf(base)}`, { host: hostOf(base) });
  }
  if (declined) throw declined;
  const calendars = [];
  // An empty fallback root does not prove that a home set which failed to
  // answer has no calendars. Keep that uncertainty through to the sweep.
  if (incompleteListing || listError || (principal && !homeSet)) Object.defineProperty(calendars, 'incomplete', { value: true });
  return { principal, homeSet, listRoot: null, calendars };
}

/**
 * One Depth:1 listing. -> {listRoot, calendars} when it produced any, else null.
 *
 * A 401 or 403 is rethrown rather than reported as "no calendars here": that is
 * an answer about credentials, not about layout, and it belongs to the caller
 * exactly as it would from a fresh walk. Anything else is this URL being wrong,
 * which is a thing the next candidate might fix — and a remembered home set on
 * a partition host, refused because the origin pin sent no password, is exactly
 * that: the next rung down still has to be tried.
 */
async function listCalendarsAt(root, opts) {
  try {
    const res = await request('PROPFIND', root, { ...opts, body: BODY_COLLECTIONS, depth: 1 });
    const calendars = calendarsFrom(discoveryDocument(res), res.url);
    if (calendars.length) return { listRoot: res.url, calendars };
    dav.debug(`the remembered listing at ${hostOf(root)} holds no calendars any more`);
  } catch (err) {
    if (isCredentialVerdict(err)) throw err;
    dav.debug(`the remembered listing at ${hostOf(root)} failed: ${err.message}`);
  }
  return null;
}

/**
 * The calendars to query this sweep, from the cheapest source that can still be
 * trusted.
 *
 * The remembered listing root is one PROPFIND and covers the ordinary case. The
 * two hops above it are remembered as well, and they are what makes a *moved*
 * collection cheap rather than a full rediscovery: a provider that renames a
 * calendar collection usually leaves the home set where it was, and one that
 * moves the home set usually leaves the principal where it was. So a failed
 * listing walks back up the record one rung at a time — list the home set, then
 * re-ask the principal for its home set and list that — and only falls all the
 * way through to `discover` when the remembered layout is wrong from the top.
 * Each rung that works rewrites the record with the root that answered, so the
 * next sweep is back to one request.
 *
 * Nothing here is patched around. A rung that produces calendars is trusted; a
 * record that produces none anywhere is dropped rather than kept, so an account
 * whose provider moved everything heals itself on the next sweep.
 */
async function targetsFor(base, key, opts) {
  const known = readLayout(key);
  if (known) {
    const tried = new Set();
    for (const root of [known.listRoot, known.homeSet]) {
      if (!root || tried.has(root)) continue;
      tried.add(root);
      const found = await listCalendarsAt(root, opts);
      if (!found) continue;
      if (found.listRoot !== known.listRoot) {
        writeLayout(key, { ...known, listRoot: found.listRoot, at: Date.now() });
      }
      return found.calendars;
    }

    if (known.principal) {
      // The principal is the one URL a server almost never moves, so asking it
      // where the calendars live now is two requests where the walk is four.
      let homeSet = null;
      try {
        const res = await request('PROPFIND', known.principal, { ...opts, body: BODY_HOME_SET, depth: 0 });
        homeSet = hrefUnder(discoveryDocument(res), res.url, 'calendar-home-set');
      } catch (err) {
        if (isCredentialVerdict(err)) throw err;
        dav.debug(`the remembered principal at ${hostOf(known.principal)} failed: ${err.message}`);
      }
      if (homeSet && !tried.has(homeSet)) {
        const found = await listCalendarsAt(homeSet, opts);
        if (found) {
          writeLayout(key, { ...known, homeSet, listRoot: found.listRoot, at: Date.now() });
          return found.calendars;
        }
      }
    }

    forgetLayout(key);
  }

  const found = await discover({ url: base, ...opts });
  if (found.listRoot) {
    writeLayout(key, {
      listRoot: found.listRoot,
      principal: found.principal,
      homeSet: found.homeSet,
      at: Date.now(),
    });
  }
  return found.calendars;
}

/**
 * REPORT calendar-query over [from, to) against every discovered calendar.
 * -> [icsText] — raw VCALENDAR documents, to be handed to the ICS parser.
 *
 * `from`/`to` accept an ISO string, a Date or epoch milliseconds. Omitted, they
 * default to the last 30 and the next 180 days.
 *
 * The window is snapped outward to whole UTC days before it is used. A sweep's
 * window slides by however long it was since the last one, which would make
 * every request — and so every cache entry — unique, and the ctag check below
 * pointless. Snapping widens the query by less than a day at each end, it is
 * applied to the REPORT as well as to what is remembered so the two can never
 * disagree, and the ICS parser downstream filters to the caller's real window
 * regardless.
 */
export async function fetchRange({ url, user, pass, requireTls = null, from, to, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const base = normalizeUrl(url);
  // Here as well as in `discover`, because a remembered layout means a sweep
  // can reach a REPORT without ever calling it.
  assertCleartextAllowed(base, { user, requireTls });
  const opts = { user, pass, requireTls, timeoutMs, signal, authOrigin: originOf(base) };
  const now = Date.now();
  const start = floorDay(msOf(from, now - 30 * DAY_MS));
  const end = ceilDay(msOf(to, now + 180 * DAY_MS));
  const body = calendarQueryBody(davStamp(start), davStamp(end));

  const key = accountKey(base, user);
  const targets = await targetsFor(base, key, opts);
  if (!targets.length) {
    dav.warn(`no calendar collections found at ${hostOf(base)}`);
    return targets;
  }

  const out = [];
  if (targets.incomplete) Object.defineProperty(out, 'incomplete', { value: true, configurable: true });
  for (const calendar of targets) {
    // The ctag is the server's own answer to "has anything in this collection
    // changed?". When it has not moved and the window is the same one, the
    // REPORT would return what we already hold, so it is not sent.
    const held = recall(key, calendar.href);
    if (calendar.ctag && held && held.ctag === calendar.ctag && held.start === start && held.end === end) {
      dav.debug(`${calendar.name} is unchanged; skipping its calendar-query`);
      out.push(...held.docs);
      continue;
    }

    let res;
    try {
      res = await request('REPORT', calendar.href, { ...opts, body, depth: 1 });
    } catch (err) {
      // One unreadable calendar must not cost the user the others.
      dav.warn(`calendar-query failed for ${calendar.name}: ${err.message}`);
      Object.defineProperty(out, 'incomplete', { value: true, configurable: true });
      continue;
    }
    const docs = [];
    const doc = parseXml(res.text);
    let incomplete = doc.incomplete === true;
    for (const response of findAll(doc, 'response')) {
      let hasCalendarData = false;
      for (const prop of okProps(response)) {
        for (const child of prop.children) {
          if (child.local !== 'calendar-data') continue;
          const text = textOf(child).trim();
          if (text.includes('BEGIN:VCALENDAR')) { docs.push(text); hasCalendarData = true; }
        }
      }
      if (!hasCalendarData) incomplete = true;
    }
    if (incomplete) Object.defineProperty(out, 'incomplete', { value: true, configurable: true });
    // Only a server that advertises a ctag can be skipped later: without one
    // there is no way to know the collection has not moved on.
    if (calendar.ctag && !incomplete) remember(key, calendar.href, { ctag: calendar.ctag, start, end, docs });
    out.push(...docs);
  }
  return out;
}

/**
 * Probe a calendar account without changing anything.
 * -> {ok, calendars:[{href, name}], error, cleartextRefused?}
 *
 * `requireTls` is taken so the probe runs under the rule the sweep will, and
 * `cleartextRefused` is handed back as a flag rather than left in the wording,
 * so `zelos doctor` and the Settings route can tell "nothing was sent, on
 * purpose" from "the server said no" without matching a sentence.
 */
export async function testConnection({ url, user, pass, requireTls = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  try {
    const { calendars } = await discover({ url, user, pass, requireTls, timeoutMs, signal });
    if (!calendars.length) {
      return { ok: false, calendars: [], error: `Connected to ${hostOf(normalizeUrl(url))} but found no calendars.` };
    }
    return { ok: true, calendars: calendars.map((c) => ({ href: c.href, name: c.name })), error: null };
  } catch (err) {
    return {
      ok: false,
      calendars: [],
      error: err?.message || String(err),
      ...(err?.cleartextRefused ? { cleartextRefused: true } : {}),
    };
  }
}
