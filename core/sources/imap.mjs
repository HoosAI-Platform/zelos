/**
 * core/sources/imap.mjs — IMAP4rev1, from the socket up.
 *
 * The whole reason this file exists instead of an npm install: Zelos claims
 * that nothing about your mail leaves your machine, and that claim is only
 * worth something if every byte of the mail path is auditable in this repo.
 *
 * Three decisions carry the correctness of the module:
 *
 *  1. The wire is parsed as BYTES with an explicit literal-length state, never
 *     by splitting on CRLF. `{123}\r\n` means "the next 123 bytes are opaque",
 *     and those bytes routinely contain CRLF, ")" and quotes. A line splitter
 *     appears to work until someone sends you a subject with a paren in it.
 *  2. Reads never mutate the mailbox. `EXAMINE` instead of `SELECT`, and
 *     `BODY.PEEK[...]` instead of `BODY[...]` — a `BODY[` fetch sets \Seen, and
 *     silently marking somebody's mail as read is not a bug you get to ship.
 *     `fetch()` refuses to send one, and every command passes
 *     `assertReadOnlyCommand` on its way to the socket:
 *     nine read verbs and nothing else, so STORE, COPY, MOVE, APPEND, EXPUNGE
 *     and their kind cannot be put on the wire by any caller.
 *  3. UIDs only. Sequence numbers are renumbered by any expunge, including one
 *     that happens between two of our own commands.
 *
 * Section 6 is the fourth decision and the newest: some providers no longer
 * accept a password at all, so the client speaks `AUTHENTICATE XOAUTH2` as well
 * as LOGIN and PLAIN, and the bearer token it needs is minted here by an OAuth
 * device authorization grant against a registration the USER owns. Nothing else
 * about the client changes — the mechanism is chosen by config in one branch of
 * `login()`, and every other byte of the session is the same session.
 */

import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

import { imapDate, instant } from '../time.mjs';
import { log as defaultLog } from '../log.mjs';
import { getSecret, setSecret, deleteSecret } from '../secrets.mjs';
import { isModelKeyRef } from '../model-key.mjs';
/* The one provider table. Google's authorization and token endpoints are
   read from it rather than restated here, so the calendar plumbing and the
   mail sign-in can never disagree about where a Google token comes from. */
import { PROVIDERS as OAUTH_PROVIDERS } from './oauth.mjs';
import {
  decodeCharset,
  decodeTransfer,
  decodeWords,
  htmlToText,
  parseAddressList,
  parseDate,
  parseHeaders,
  threadKeyFor,
} from './mime.mjs';

const CRLF = '\r\n';
const CRLF_BYTES = Buffer.from(CRLF, 'latin1');

/** Some servers choke on very large UID sets; 100 is universally safe. */
const UID_CHUNK = 100;

/** The cheap first pass: everything needed to decide, nothing that costs a body. */
const HEADER_FIELDS = 'FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID';

/** Guard rails against a hostile or broken server exhausting memory. */
const MAX_LITERAL_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;

/**
 * The third guard rail, and the one that is not a byte count.
 *
 * An in-progress response is two arrays — the text segments and the literal
 * ranges that index them — and a marker line costs an entry in both while
 * adding *zero* bytes to the response. `{0}\r\n` is the pure form: six bytes on
 * the wire, an empty head pushed onto `#segments` and an empty range pushed
 * onto `#literals`, and `#length` still 0. A byte cap cannot see that. Measured
 * before this existed: a hostile server flooding `{0}\r\n` during the pre-auth
 * CAPABILITY drove rss to 464 MB and then a fatal V8 out-of-memory in about a
 * second and a half, with the 96 MB cap never firing once. An OOM is not
 * catchable, so this has to be a cap and not a rescue.
 *
 * 100,000 pieces is four orders of magnitude past any real response — a FETCH
 * uses a handful of literals — and costs about 4 MB of heap if a server ever
 * gets near it.
 */
const MAX_RESPONSE_PARTS = 100_000;

/**
 * The fourth guard rail, and the one that lives a layer above the other three.
 *
 * The assembler's caps only ever describe *one* response: every path that
 * emits a complete response resets `#segments`, `#literals` and `#length` to
 * empty. So a server that sends nothing but well-formed, complete untagged
 * lines never trips either of them — it hands them off, one at a time, to
 * `#current.untagged`, which had no cap at all. That array only empties when
 * the tagged completion arrives, and a hostile server simply never sends one.
 *
 * This is the same reported harm as the `{0}` flood and needs the same absence
 * of credentials: measured against the real client with the real socket, a
 * server answering the pre-auth CAPABILITY with `* OK <1 KB>\r\n` forever took
 * rss from 231 MB to 491 MB in 1.6 s and then a fatal V8 out-of-memory, with
 * both assembler caps quiet throughout because no single response was ever
 * large or ever had many pieces. `#onData` re-arms the idle timer on every
 * chunk, so the 30 s deadline never helps here either.
 *
 * Counted two ways for the same reason the assembler counts two ways — a
 * response costs far more heap than its own text. Measured retained cost of a
 * parsed untagged response: 372 bytes for a 5-character one, 503 for 65
 * characters, 1,451 for 1,005. Bytes alone would let sixteen million six-byte
 * responses through before noticing.
 *
 * 50,000 responses is two orders of magnitude past the largest real command —
 * `fetch()` chunks at 100 UIDs, so a FETCH yields ~100, and `LIST "" "*"` one
 * per mailbox — and the byte ceiling is the same 96 MB the assembler already
 * allows a single response, so "one command may buffer 96 MB" holds however
 * the server chooses to slice it.
 */
const MAX_UNTAGGED_RESPONSES = 50_000;

const SPECIAL_USE_FLAGS = new Set(['\\sent', '\\drafts', '\\trash', '\\junk', '\\archive', '\\all', '\\flagged', '\\important']);

/* ================================================================== *
 * 1. Byte-stream assembly
 * ================================================================== */

/**
 * Turns a TCP byte stream into complete IMAP responses.
 *
 * A response is emitted as `{ text, literals }` where `text` is the whole
 * response decoded as latin1 — one byte per character, so offsets are exact and
 * reversible — and `literals` marks the character ranges that came from a
 * literal. The tokenizer uses those ranges to jump over literal payloads
 * wholesale, which is what makes CRLF and ")" inside a literal harmless.
 */
class ResponseAssembler {
  #buf = Buffer.alloc(0);
  #segments = [];
  #literals = [];
  #length = 0;
  #pendingLiteral = 0;
  #scan = 0;

  /** @returns {{text:string, literals:{start:number,end:number}[]}[]} */
  push(chunk) {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out = [];

    for (;;) {
      // Inside the loop, not after it. One 64 KB chunk holds ten thousand
      // `{0}\r\n` markers, and a check that waits for the loop to drain has
      // already let every one of them onto the heap.
      this.#guard();

      if (this.#pendingLiteral > 0) {
        if (this.#buf.length < this.#pendingLiteral) break;
        const payload = this.#buf.subarray(0, this.#pendingLiteral);
        this.#literals.push({ start: this.#length, end: this.#length + payload.length });
        this.#segments.push(payload.toString('latin1'));
        this.#length += payload.length;
        this.#buf = this.#buf.subarray(this.#pendingLiteral);
        this.#pendingLiteral = 0;
        this.#scan = 0;
        continue;
      }

      const idx = this.#buf.indexOf(CRLF_BYTES, this.#scan);
      if (idx < 0) {
        // Resume the search at the last byte: a CR may be the tail of this
        // chunk with its LF arriving in the next one.
        this.#scan = Math.max(0, this.#buf.length - 1);
        break;
      }

      const line = this.#buf.subarray(0, idx).toString('latin1');
      const marker = /\{(\d+)\+?\}$/.exec(line);
      if (marker) {
        const size = Number(marker[1]);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LITERAL_BYTES) {
          throw new Error(`server announced an implausible literal of ${marker[1]} bytes`);
        }
        // Drop the "{n}" marker and its CRLF: the literal's bytes then sit
        // exactly where the value belongs, so the tokenizer needs no special case.
        const head = line.slice(0, marker.index);
        this.#segments.push(head);
        this.#length += head.length;
        if (size === 0) {
          // "{0}" is a real value — the empty string — not a formality. The
          // payload branch above never runs for it (there are no bytes to
          // wait for), so the empty range is recorded here; dropping it
          // instead would delete a value from a FETCH response and shift
          // every item after it onto the wrong key.
          this.#literals.push({ start: this.#length, end: this.#length });
        } else {
          this.#pendingLiteral = size;
        }
        this.#buf = this.#buf.subarray(idx + 2);
        this.#scan = 0;
        continue;
      }

      this.#segments.push(line);
      this.#length += line.length;
      out.push({ text: this.#segments.join(''), literals: this.#literals });
      this.#segments = [];
      this.#literals = [];
      this.#length = 0;
      this.#buf = this.#buf.subarray(idx + 2);
      this.#scan = 0;
    }

    return out;
  }

  /**
   * Everything the assembler is holding for a response that has not been
   * emitted yet, measured two ways. Every path through the loop that grows
   * state ends in `continue`, so running this at the top of each iteration
   * means no growth goes unmeasured, and the very first iteration covers the
   * chunk that was just concatenated on.
   */
  #guard() {
    if (this.#length + this.#buf.length > MAX_RESPONSE_BYTES) {
      throw new Error('server response exceeded the maximum size Zelos will buffer');
    }
    if (this.#segments.length + this.#literals.length > MAX_RESPONSE_PARTS) {
      throw new Error('server response exceeded the number of pieces Zelos will buffer');
    }
  }
}

/* ================================================================== *
 * 2. Tokenizer
 * ================================================================== */

/**
 * Parse one assembled response into IMAP values.
 * Value shapes: {type:'atom',value:string} | {type:'string',value:Buffer}
 *             | {type:'list',value:Value[]} | {type:'nil',value:null}
 */
function parseResponse({ text, literals }) {
  const literalAt = new Map();
  for (const range of literals) literalAt.set(range.start, range);

  const end = text.length;
  let pos = 0;

  const atLiteral = () => literalAt.has(pos);

  function skipSpace() {
    // A literal's payload may start with a space, so never skip into one.
    while (pos < end && !atLiteral() && text[pos] === ' ') pos++;
  }

  function skipBracket(from) {
    let p = from + 1;
    let depth = 1;
    while (p < end && depth > 0) {
      const c = text[p];
      if (c === '"') {
        p++;
        while (p < end && text[p] !== '"') {
          if (text[p] === '\\') p++;
          p++;
        }
        p++;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') depth--;
      p++;
    }
    return p;
  }

  function readQuoted() {
    pos++; // opening quote
    let out = '';
    while (pos < end) {
      const c = text[pos];
      if (c === '\\' && pos + 1 < end) { out += text[pos + 1]; pos += 2; continue; }
      if (c === '"') { pos++; break; }
      out += c;
      pos++;
    }
    return { type: 'string', value: Buffer.from(out, 'latin1') };
  }

  function readAtom() {
    const start = pos;
    while (pos < end) {
      if (atLiteral()) break;
      const c = text[pos];
      if (c === ' ' || c === ')' || c === '(') break;
      // "BODY[HEADER.FIELDS (FROM TO)]<0>" is one atom: the section spec holds
      // spaces and parens, so consume the bracketed part whole.
      if (c === '[') { pos = skipBracket(pos); continue; }
      pos++;
    }
    const raw = text.slice(start, pos);
    if (raw.toUpperCase() === 'NIL') return { type: 'nil', value: null };
    return { type: 'atom', value: raw };
  }

  function readValue() {
    skipSpace();
    if (pos >= end) return null;
    const range = literalAt.get(pos);
    if (range) {
      // Consumed ranges are forgotten so a zero-length literal — whose end is
      // its start, leaving `pos` where it stood — reads as one empty value
      // instead of an endless stream of them.
      literalAt.delete(range.start);
      const buf = Buffer.from(text.slice(range.start, range.end), 'latin1');
      pos = range.end;
      return { type: 'string', value: buf };
    }
    const c = text[pos];
    if (c === '(') {
      pos++;
      const items = [];
      for (;;) {
        skipSpace();
        if (pos >= end) break;
        if (!atLiteral() && text[pos] === ')') { pos++; break; }
        const value = readValue();
        if (value === null) break;
        items.push(value);
      }
      return { type: 'list', value: items };
    }
    if (c === '"') return readQuoted();
    if (c === ')') return null;
    return readAtom();
  }

  const values = [];
  for (;;) {
    skipSpace();
    if (pos >= end) break;
    const before = pos;
    const value = readValue();
    if (value === null) {
      pos = Math.max(pos + 1, before + 1); // never stall on stray punctuation
      continue;
    }
    values.push(value);
  }
  return values;
}

/** Protocol-level text of a value (mailbox names, dates, numbers). */
function tokenText(value) {
  if (!value) return null;
  if (value.type === 'atom') return value.value;
  if (value.type === 'string') return value.value.toString('latin1');
  return null;
}

function tokenBytes(value) {
  if (!value) return Buffer.alloc(0);
  if (value.type === 'string') return value.value;
  if (value.type === 'atom') return Buffer.from(value.value, 'latin1');
  return Buffer.alloc(0);
}

function listItems(value) {
  return value && value.type === 'list' ? value.value : [];
}

/* ================================================================== *
 * 3. Mailbox names (modified UTF-7, RFC 3501 §5.1.3)
 * ================================================================== */

function decodeModifiedUTF7(name) {
  return String(name).replace(/&([^-]*)-/g, (match, encoded) => {
    if (encoded === '') return '&';
    try {
      const buf = Buffer.from(encoded.replace(/,/g, '/'), 'base64');
      let out = '';
      for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i));
      return out || match;
    } catch {
      return match;
    }
  });
}

function encodeModifiedUTF7(name) {
  const s = String(name);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 0x26) { out += '&-'; i++; continue; }
    if (code >= 0x20 && code <= 0x7e) { out += s[i]; i++; continue; }
    const units = [];
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c >= 0x20 && c <= 0x7e) break;
      units.push(c);
      i++;
    }
    const buf = Buffer.alloc(units.length * 2);
    units.forEach((u, k) => buf.writeUInt16BE(u, k * 2));
    out += `&${buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
  }
  return out;
}

/* ================================================================== *
 * 4. BODYSTRUCTURE
 * ================================================================== */

/**
 * Flatten a BODYSTRUCTURE into addressable parts.
 *
 * Part numbering follows RFC 3501 §6.4.5: children of a multipart are 1, 2, …
 * prefixed by their parent's number, and the body of a message/rfc822 part is
 * numbered inside that part. A non-multipart message's body is part "1".
 */
function structureParts(node) {
  const out = [];
  walkStructure(node, '', false, out, false);
  return out;
}

/**
 * `enclosed` marks every part that sits inside a message/rfc822 at any depth: an
 * email carried by this one ("Forward as attachment"), not words its sender
 * wrote. Those parts keep only their own disposition, which is usually none, so
 * without the mark an attached email looks like this message's inline body.
 */
function walkStructure(node, prefix, insideMessage, out, enclosed) {
  if (!node || node.type !== 'list' || node.value.length === 0) return;
  const items = node.value;

  if (items[0] && items[0].type === 'list') {
    let index = 0;
    for (const child of items) {
      if (child.type !== 'list') break; // the multipart subtype follows the children
      index++;
      walkStructure(child, prefix ? `${prefix}.${index}` : String(index), false, out, enclosed);
    }
    return;
  }

  const type = (tokenText(items[0]) || '').toLowerCase();
  const subtype = (tokenText(items[1]) || '').toLowerCase();
  const params = paramMap(items[2]);
  const encoding = (tokenText(items[5]) || '7bit').toLowerCase();
  const size = Number(tokenText(items[6])) || 0;
  const part = insideMessage ? `${prefix}.1` : prefix || '1';

  // Field layout differs by type: text parts carry a line count before the
  // extension fields, message/rfc822 carries an envelope plus a nested body.
  const isMessage = type === 'message' && subtype === 'rfc822';
  const dispositionIndex = type === 'text' ? 9 : isMessage ? 11 : 8;
  const disposition = dispositionFrom(items[dispositionIndex]);

  out.push({
    part,
    type,
    subtype,
    charset: params.get('charset') || null,
    encoding,
    size,
    disposition: disposition.kind,
    filename: disposition.filename || params.get('name') || null,
    // body-fld-id, RFC 3501 §7.4.2. Worth carrying only because it is the one
    // reliable mark of a part the message draws itself: an HTML body that says
    // <img src="cid:logo@x"> needs a sibling whose Content-ID is <logo@x>.
    contentId: tokenText(items[3]) || null,
    enclosed,
  });

  if (isMessage) walkStructure(items[8], part, true, out, true);
}

function paramMap(node) {
  const map = new Map();
  const items = listItems(node);
  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = (tokenText(items[i]) || '').toLowerCase();
    const value = tokenText(items[i + 1]);
    if (key && value !== null) map.set(key, value);
  }
  return map;
}

function dispositionFrom(node) {
  const items = listItems(node);
  if (!items.length) return { kind: null, filename: null };
  const kind = (tokenText(items[0]) || '').toLowerCase() || null;
  const params = paramMap(items[1]);
  return { kind, filename: params.get('filename') || params.get('name') || null };
}

/**
 * The part a human would read: the sender's own plain text if there is any,
 * otherwise their own HTML, and only then anything enclosed.
 *
 * The sender's own words come first, whichever of the two they wrote. A message
 * whose own body is HTML only and which carries an email as an attachment used
 * to be read as the ATTACHED email's plain text — the model was shown someone
 * else's words and never the sender's. An attached email is read only when the
 * message has nothing of its own.
 *
 * The trade is deliberate: an HTML-only forward with nothing typed now reads as
 * its near-empty HTML rather than as the attached email, which is honest about
 * who wrote what. A size cut-off to tell a stub from a body would be a guess.
 */
function chooseTextPart(parts) {
  const inline = parts.filter((p) => p.disposition !== 'attachment');
  const own = inline.filter((p) => !p.enclosed);
  const pick = (list, subtype) => list.find((p) => p.type === 'text' && p.subtype === subtype);
  return (
    pick(own, 'plain') ||
    pick(own, 'html') ||
    pick(inline, 'plain') ||
    pick(inline, 'html') ||
    pick(parts, 'plain') ||
    pick(parts, 'html') ||
    null
  );
}

/**
 * A detached signature is machinery, not a document. Every S/MIME or PGP/MIME
 * mail carries one, under one of these three subtypes, and nobody has ever
 * wanted to be told their signed mail "has an attachment".
 */
const SIGNATURE_SUBTYPES = new Set(['pkcs7-signature', 'x-pkcs7-signature', 'pgp-signature']);

/**
 * Does this message carry something a person would call an attachment?
 *
 * The question is narrower than "is there a non-text part", and the old answer
 * — attachment disposition OR any filename OR any `application/*` — got it
 * wrong twice in the same direction. `application/*` alone fired on the
 * `smime.p7s` and `signature.asc` parts that ride along with every signed
 * corporate mail, which have no disposition and no name at all; the bare
 * filename test fired on the logo in a `multipart/related` newsletter, because
 * inline images routinely carry a NAME param. Both produced the model-facing
 * mark `[unread, has attachment]` on mail with nothing attached to it.
 *
 * So: honour what the message says about itself. RFC 2183 defines `inline` as
 * "display this as part of the message", which is the opposite of an
 * attachment, and RFC 2392 gives a referenced part a Content-ID. Neither counts.
 * A named part that claims neither does.
 *
 * The trade is deliberate: an unnamed `application/pdf` with no disposition —
 * which some scanners and fax gateways still emit — now reads as no
 * attachment. That is a false negative on an advisory flag nothing ranks or
 * filters on, bought in exchange for the false positive that was firing on
 * essentially every signed message in the mailbox.
 */
function hasAttachmentParts(parts, chosen) {
  return parts.some((p) => {
    if (p === chosen) return false; // the part we render as the body
    if (SIGNATURE_SUBTYPES.has(p.subtype)) return false;
    if (p.disposition === 'attachment') return true;
    if (p.disposition === 'inline') return false;
    if (p.contentId) return false; // a cid: target the body already draws
    return Boolean(p.filename);
  });
}

/* ================================================================== *
 * 5. The client
 * ================================================================== */

/**
 * Loopback, in every spelling a person or a provider actually writes.
 *
 * This matters because loopback is the one address where a cleartext IMAP
 * session is defensible: local proxies that decrypt on your behalf listen on
 * 127.0.0.1, and that traffic never leaves the machine. Proton Bridge is one
 * (it does encrypt, with a certificate of its own — see `tlsOptionsFor`), and
 * `guessImapHost` returns exactly that for a proton.me address. Any other host
 * is a network, and a network has people on it.
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  const v4 = mapped ? mapped[1] : h;
  if (!/^127(?:\.\d{1,3}){3}$/.test(v4)) return false;
  return v4.split('.').every((octet) => Number(octet) <= 255);
}

/**
 * Whether an account must prove the connection is encrypted before it hands
 * over a password, when the config has not said either way. On by default
 * everywhere except loopback — see `isLoopbackHost`.
 */
export function tlsRequiredByDefault(host) {
  return !isLoopbackHost(host);
}

/**
 * Which SASL mechanism a session will use — stated, never inferred from what
 * happens to be lying around.
 *
 * The inferred version has one failure mode and it is expensive. An account
 * configured for OAuth whose token could not be minted — the refresh token was
 * revoked, the machine was offline, the user changed their password — arrives
 * here with an EMPTY access token, and "no token, so fall back to a password"
 * then sends Microsoft a LOGIN with a blank password. That is a real
 * authentication attempt against an account with basic auth switched off, so
 * what the user is told is `AUTHENTICATIONFAILED`, which reads as "your
 * credentials are wrong" and sends them to re-type a password that has not been
 * accepted since 16 September 2024. What they need to be told is "reconnect the
 * account", and the only way to say that is to know the account meant OAuth.
 *
 * So `auth: 'xoauth2'` with no token is refused before a socket is opened, and
 * `auth: null` — which is what every config written before this existed says —
 * still means "password", exactly as it always did.
 */
export function resolveAuthMethod(auth, accessToken) {
  const named = String(auth ?? '').trim().toLowerCase();
  if (named === 'xoauth2') return 'xoauth2';
  if (named === 'password' || named === 'login') return 'password';
  if (named) throw new Error(`ImapClient: unknown auth method ${JSON.stringify(auth)}`);
  return accessToken ? 'xoauth2' : 'password';
}

export class ImapClient {
  #socket = null;
  #assembler = new ResponseAssembler();
  #queue = [];
  #current = null;
  #tagSeq = 0;
  #caps = null;
  #greeting = null;
  #authenticated = false;
  #dead = false;
  #loggedOut = false;
  #byeText = null;
  #onSocketData = null;
  #onSocketError = null;
  #onSocketClose = null;
  #signal = null;
  #cancelled = false;

  /**
   * The caller's cancellation, made real.
   *
   * An arrow field rather than a method so the reference is stable: the same
   * function has to reach `removeEventListener`, and one `AbortSignal` outlives
   * every client that borrows it — a sweep holds a single controller across
   * four mailboxes of three accounts, so a listener left behind on each is a
   * leak that grows for the length of the run.
   */
  #cancel = () => {
    this.#cancelled = true;
    this.#fail(this.#error('cancelled'));
  };

  /**
   * `requireTls` is the answer to a silent failure mode. With `secure: false`
   * the client offers to upgrade, but only if the server says it can — and a
   * machine in the middle can simply delete STARTTLS from the capability list,
   * at which point the client shrugs and sends the password in the clear. The
   * user is told nothing, because from the client's side nothing went wrong.
   *
   * So the requirement is stated, not inferred from what the server offered:
   * `true` refuses to authenticate over anything but a real TLS socket, `false`
   * permits cleartext, and `null` (or nothing at all, which is what every
   * existing config says) means "required unless the host is loopback".
   *
   * `signal` is the other half of Ctrl-C. The idle timer is a deadline for
   * SILENCE and nothing else — `#onData` re-arms it on every chunk — so a
   * server that keeps talking without ever completing the command is unbounded
   * in time, and even a silent one costs the full `timeoutMs`. Neither is a
   * cancellation: the user has already said stop. An abort fails the command in
   * flight and destroys the socket, which is what makes the stop visible in the
   * same second it was asked for.
   *
   * `accessToken` and `auth` are the OAuth seam, and they are the whole of it:
   * an account that carries a bearer token authenticates with `AUTHENTICATE
   * XOAUTH2` instead of a password and every other byte of the session is
   * unchanged. See `resolveAuthMethod` for why the choice is named rather than
   * guessed from whether a token happens to be present.
   */
  constructor({
    host, port, secure = true, user, pass, accessToken = '', auth = null,
    requireTls = null, timeoutMs = 30000, logger, signal, lookup = null,
  } = {}) {
    if (!host || typeof host !== 'string') throw new Error('ImapClient: host is required');
    this.host = host;
    this.secure = secure !== false;
    this.port = Number(port) || (this.secure ? 993 : 143);
    // Left to decide, the rule is re-read against the address the socket
    // reached; see `#assertEncrypted`.
    this.tlsDecidedByHost = requireTls === null || requireTls === undefined;
    this.requireTls = this.tlsDecidedByHost
      ? tlsRequiredByDefault(this.host)
      : requireTls !== false;
    this.user = user == null ? '' : String(user);
    this.pass = pass == null ? '' : String(pass);
    this.accessToken = accessToken == null ? '' : String(accessToken);
    this.auth = resolveAuthMethod(auth, this.accessToken);
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
    // A DNS seam for tests: it lets a test give a non-loopback NAME a loopback
    // address, which is how the certificate rule below is proved to read both.
    this.lookup = typeof lookup === 'function' ? lookup : null;
    this.mailbox = null;
    const base = logger || defaultLog;
    this.log = typeof base.child === 'function' ? base.child('[imap]') : base;
    if (signal) {
      // An already-aborted signal never dispatches, so it is read rather than
      // listened for. Handing one in means "do not start", and the difference
      // matters: no socket is opened at all.
      if (signal.aborted) this.#cancelled = true;
      else {
        this.#signal = signal;
        signal.addEventListener('abort', this.#cancel, { once: true });
      }
    }
  }

  /** Stop listening to a signal that outlives us. Idempotent. */
  #releaseSignal() {
    if (!this.#signal) return;
    this.#signal.removeEventListener('abort', this.#cancel);
    this.#signal = null;
  }

  /* ---------------- lifecycle ---------------- */

  async connect() {
    if (this.#socket) return;
    if (this.#cancelled) throw this.#error('cancelled');
    if (this.#dead) throw this.#error('client already closed');

    const greeting = new Promise((resolve, reject) => {
      this.#greeting = { resolve, reject };
    });

    let socket;
    try {
      socket = await this.#openSocket(this.secure);
    } catch (err) {
      this.#greeting = null;
      throw err;
    }
    this.#attach(socket);

    const timer = setTimeout(() => {
      this.#fail(this.#error(`no greeting within ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    try {
      await greeting;
    } finally {
      clearTimeout(timer);
    }

    if (!this.secure) {
      const caps = await this.capabilities();
      if (caps.has('STARTTLS')) await this.#startTls();
    }
    // Checked here as well as in login() so the caller learns immediately, on
    // the call that opened the socket, rather than one step later.
    this.#assertEncrypted();
  }

  /**
   * The gate. Not "did we try to upgrade" but "is this socket actually TLS" —
   * `encrypted` is set by node:tls itself and is the only thing here a hostile
   * server has no say over. A CAPABILITY reply is the server's word; a
   * TLSSocket is a handshake that happened.
   *
   * Failing closes the connection, because a session that is not allowed to
   * authenticate has nothing left to do on it.
   */
  #assertEncrypted() {
    if (this.#socket && this.#socket.encrypted === true) return;
    // Loopback by NAME is not enough when the account left this to Zelos:
    // `bridge.localhost` may be resolved by DNS, and a hostile network can
    // point it anywhere and simply not offer STARTTLS. Cleartext is excused
    // only when the address actually reached is loopback too. An explicit
    // `requireTls: false` is the user's standing word and is left alone.
    const required = this.requireTls
      || (this.tlsDecidedByHost && !isLoopbackHost(this.#socket?.remoteAddress));
    if (!required) return;
    const err = this.#error(
      'this connection is still in the clear and the server never offered STARTTLS, '
      + 'so your password was not sent. Connect with TLS (port 993 usually), or, if a '
      + 'plaintext connection to this host is deliberate, set requireTls to false on the account.',
    );
    this.#fail(err);
    throw err;
  }

  #openSocket(useTls) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      // `onError` stays registered after the promise settles: without a listener
      // an 'error' between connect and #attach would be thrown, not handled.
      const onError = (err) => finish(reject, this.#error(`connection failed — ${err.message}`, err));

      const where = { host: this.host, port: this.port, ...(this.lookup ? { lookup: this.lookup } : {}) };
      const socket = useTls
        ? tls.connect({ ...where, ...tlsOptionsFor(this.host) }, () => {
          const refused = this.#refuseUnverified(socket);
          if (refused) {
            socket.destroy();
            finish(reject, this.#error(`connection failed — ${refused}`));
          } else finish(resolve, socket);
        })
        : net.connect(where, () => finish(resolve, socket));

      const timer = setTimeout(() => {
        socket.destroy();
        finish(reject, this.#error(`timed out connecting after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      socket.once('error', onError);
    });
  }

  #attach(socket) {
    this.#socket = socket;
    socket.setNoDelay(true);
    this.#onSocketData = (chunk) => this.#onData(chunk);
    this.#onSocketError = (err) => this.#fail(this.#error(`socket error — ${err.message}`, err));
    this.#onSocketClose = () => {
      if (this.#loggedOut || this.#dead) return;
      const detail = this.#byeText ? ` — server said: ${this.#byeText}` : '';
      this.#fail(this.#error(`connection closed by server${detail}`));
    };
    socket.on('data', this.#onSocketData);
    socket.on('error', this.#onSocketError);
    socket.on('close', this.#onSocketClose);
  }

  #detach() {
    const socket = this.#socket;
    if (!socket) return null;
    socket.removeListener('data', this.#onSocketData);
    socket.removeListener('error', this.#onSocketError);
    socket.removeListener('close', this.#onSocketClose);
    return socket;
  }

  /**
   * The second half of the loopback certificate rule (see `tlsOptionsFor`): a
   * certificate nobody vouches for is accepted only when the address this
   * socket actually reached is loopback too. The name alone is not enough —
   * `bridge.localhost` is loopback by name, but the system resolver may well
   * ask DNS about it, and a hostile network can answer with anywhere at all.
   * -> null when the session may go on, or the reason it may not.
   */
  #refuseUnverified(socket) {
    if (socket.authorized) return null;
    if (isLoopbackHost(socket.remoteAddress)) return null;
    return `the server's certificate could not be verified (${socket.authorizationError || 'unknown reason'})`;
  }

  async #startTls() {
    await this.#exec('STARTTLS');
    const plain = this.#detach();
    // From here the TLS socket owns error reporting for the underlying one; a
    // bare socket with no 'error' listener would take the process down with it.
    plain?.on('error', () => {});
    this.#assembler = new ResponseAssembler();
    this.#caps = null; // capabilities are required to be re-advertised after TLS
    const secured = await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };
      const socket = tls.connect({ socket: plain, ...tlsOptionsFor(this.host) }, () => {
        const refused = this.#refuseUnverified(socket);
        if (refused) {
          socket.destroy();
          settle(reject, this.#error(`STARTTLS handshake failed — ${refused}`));
        } else settle(resolve, socket);
      });
      socket.once('error', (err) => settle(reject, this.#error(`STARTTLS handshake failed — ${err.message}`, err)));
      socket.once('close', () => settle(reject, this.#error('STARTTLS handshake failed — the server closed the connection')));
    });
    this.#attach(secured);
  }

  async login() {
    if (this.#authenticated) return;
    // The real gate: every path to a credential on the wire runs through here,
    // including one on a client somebody built by hand rather than via connect().
    // A bearer token needs this exactly as much as a password does: it is a
    // reusable credential with an hour of life on it, and base64 is not
    // encryption.
    this.#assertEncrypted();

    if (this.auth === 'xoauth2') {
      await this.#authenticateXOAuth2();
      this.#authenticated = true;
      this.#caps = null;
      return;
    }

    const caps = await this.capabilities();
    const asciiCredentials = isAsciiSafe(this.user) && isAsciiSafe(this.pass);

    // Non-ASCII credentials go through SASL too: base64 carries arbitrary bytes,
    // where a quoted LOGIN argument would need an 8-bit literal the server may
    // not accept.
    if (caps.has('LOGINDISABLED') || !asciiCredentials) {
      if (caps.has('LOGINDISABLED') && !caps.has('AUTH=PLAIN')) {
        throw this.#error('server refuses LOGIN and does not offer AUTH=PLAIN');
      }
      await this.#authenticatePlain();
    } else {
      await this.#exec(`LOGIN ${quoted(this.user)} ${quoted(this.pass)}`);
    }

    this.#authenticated = true;
    this.#caps = null; // the post-auth capability set is the one that matters
  }

  async #authenticatePlain() {
    const payload = Buffer.concat([
      Buffer.from([0]),
      Buffer.from(this.user, 'utf8'),
      Buffer.from([0]),
      Buffer.from(this.pass, 'utf8'),
    ]).toString('base64');
    let sent = false;
    await this.#exec('AUTHENTICATE PLAIN', {
      onContinuation: () => {
        if (sent) return '*'; // a second prompt means it went wrong: abort cleanly
        sent = true;
        return payload;
      },
    });
  }

  /**
   * SASL XOAUTH2, and specifically its failure handshake, which is the part
   * everybody gets wrong.
   *
   * The success path is unremarkable: the server prompts, we send
   * `base64(user=…^Aauth=Bearer …^A^A)`, the server says OK. The failure path is
   * not a tagged NO. The server answers the payload with ANOTHER continuation —
   * `+ eyJzdGF0dXMiOiI0MDAi…`, a base64 JSON object carrying `status` and
   * `scope` — and then says nothing. It is waiting for the client to
   * acknowledge, and the acknowledgement is an EMPTY line. A client that treats
   * a second prompt as "something went wrong, abort" and sends `*` is answering
   * a question that was not asked; a client that sends nothing at all sits there
   * until its own idle timer fires and reports a timeout, which names the wrong
   * problem entirely. Either way the one thing the server was trying to hand
   * over — WHY it refused — is thrown away, and that JSON is the difference
   * between "your token expired, reconnect" and "your mail server is broken".
   *
   * So: first prompt, send the payload. Second prompt, keep the challenge and
   * send an empty line. The tagged NO then arrives and the challenge is decoded
   * into it.
   */
  async #authenticateXOAuth2() {
    if (!this.accessToken) {
      const err = this.#error(
        'this account signs in with OAuth and there is no access token to sign in with — '
        + 'reconnect the account in Settings',
      );
      err.reconnect = true;
      throw err;
    }
    const caps = await this.capabilities();
    if (!caps.has('AUTH=XOAUTH2')) {
      throw this.#error(
        'this account signs in with OAuth but the server does not offer AUTH=XOAUTH2, '
        + 'so there is nothing a bearer token can be presented to',
      );
    }

    const payload = xoauth2Payload(this.user, this.accessToken);
    let challenge = null;
    let sent = false;
    let failure = null;
    try {
      await this.#exec('AUTHENTICATE XOAUTH2', {
        onContinuation: (text) => {
          if (!sent) {
            sent = true;
            return payload;
          }
          challenge = text;
          return '';
        },
      });
    } catch (err) {
      failure = err;
    }
    if (!failure) return;

    // A tagged NO on AUTHENTICATE is the server refusing the credential, and the
    // credential is a bearer token: retrying with the same one cannot work, and
    // neither can retrying with a password there is no longer any such thing as.
    // Settings reads this to say "connect this account again" instead of "check
    // your password", which is the only sentence that helps here — and the sweep
    // rests the account on it, so a NO the server itself calls temporary
    // (RFC 5530 UNAVAILABLE, a busy or broken backend) is not one of these.
    const transient = TRANSIENT_AUTH_CODES.has(String(failure.code || '').trim().split(/\s+/)[0].toUpperCase());
    if (failure.status === 'NO' && !transient) failure.reconnect = true;

    const note = describeXOAuth2Challenge(challenge);
    // `failure.status` is only set when the server ACTUALLY answered NO or BAD.
    // Without that check a socket that died mid-handshake — after the challenge
    // arrived and before the tagged line did — would be reported as a rejected
    // token, which is a diagnosis nobody can act on and the opposite of true.
    if (!note || !failure.status) throw failure;
    // Rebuilt rather than appended to, because `#error` is the only thing that
    // strikes our own credentials out — and the challenge is bytes a hostile
    // server chose, so it is exactly the place a reflected bearer token would
    // arrive.
    const err = this.#error(
      `AUTHENTICATE XOAUTH2 failed — ${failure.status}`
      + `${failure.detail ? ` ${failure.detail}` : ''} (${note})`,
    );
    err.status = failure.status;
    err.code = failure.code;
    err.reconnect = !transient;
    err.cause = failure;
    throw err;
  }

  async capabilities() {
    if (this.#caps) return new Set(this.#caps);
    const result = await this.#exec('CAPABILITY');
    const caps = new Set();
    for (const response of result.untagged) {
      if (untaggedName(response) !== 'CAPABILITY') continue;
      for (const value of response.values.slice(2)) {
        const text = tokenText(value);
        if (text) caps.add(text.toUpperCase());
      }
    }
    for (const cap of capsFromCode(result.code)) caps.add(cap);
    this.#caps = caps;
    return new Set(caps);
  }

  async listMailboxes() {
    const result = await this.#exec('LIST "" "*"');
    const out = [];
    for (const response of result.untagged) {
      if (untaggedName(response) !== 'LIST') continue;
      const flags = listItems(response.values[2]).map((v) => tokenText(v)).filter(Boolean);
      const delimiter = tokenText(response.values[3]);
      const rawName = tokenText(response.values[4]);
      if (rawName === null) continue;
      const name = decodeModifiedUTF7(rawName);
      out.push({ name, delimiter, flags, specialUse: specialUseOf(name, flags) });
    }
    return out;
  }

  /**
   * Open a mailbox, read-only: EXAMINE cannot set \Seen or expunge, which makes
   * "Zelos never changes your mail" true at the protocol level rather than by
   * our own good behaviour. There is no SELECT: nothing here needs a writable
   * mailbox, and assertReadOnlyCommand would refuse one.
   */
  async select(mailbox) {
    const name = String(mailbox ?? 'INBOX');
    const result = await this.#exec(`EXAMINE ${quoted(encodeModifiedUTF7(name))}`);

    let exists = 0;
    let uidValidity = null;
    let uidNext = null;
    let flags = [];
    for (const response of result.untagged) {
      const existsMatch = /^\*\s+(\d+)\s+EXISTS\b/i.exec(response.text);
      if (existsMatch) { exists = Number(existsMatch[1]); continue; }
      const validity = /\[UIDVALIDITY\s+(\d+)\]/i.exec(response.text);
      if (validity) uidValidity = Number(validity[1]);
      const next = /\[UIDNEXT\s+(\d+)\]/i.exec(response.text);
      if (next) uidNext = Number(next[1]);
      if (untaggedName(response) === 'FLAGS') {
        flags = listItems(response.values[2]).map((v) => tokenText(v)).filter(Boolean);
      }
    }

    this.mailbox = name;
    return { mailbox: name, exists, uidValidity, uidNext, flags, readOnly: true };
  }

  /** `search(['SINCE','01-Aug-2026'])` -> [uid]. Always UID SEARCH. */
  async search(criteria = ['ALL']) {
    const parts = (Array.isArray(criteria) ? criteria : [criteria]).map((c) => searchArg(c));
    const result = await this.#exec(`UID SEARCH ${parts.join(' ')}`);
    const uids = [];
    for (const response of result.untagged) {
      if (untaggedName(response) !== 'SEARCH') continue;
      for (const value of response.values.slice(2)) {
        const n = Number(tokenText(value));
        if (Number.isInteger(n) && n > 0) uids.push(n);
      }
    }
    return uids;
  }

  /**
   * `fetch([101,102], 'UID FLAGS BODY.PEEK[1]')` -> [{uid, flags, sections, …}]
   * Chunked into ≤100 UIDs per command.
   */
  async fetch(uids, items) {
    const spec = Array.isArray(items) ? items.join(' ') : String(items ?? 'UID');
    assertPeekOnly(spec);

    const wanted = [...new Set((Array.isArray(uids) ? uids : [uids]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const out = [];
    for (let i = 0; i < wanted.length; i += UID_CHUNK) {
      const chunk = wanted.slice(i, i + UID_CHUNK);
      const result = await this.#exec(`UID FETCH ${chunk.join(',')} (${spec})`);
      for (const response of result.untagged) {
        if (untaggedName(response) === 'FETCH') out.push(parseFetchResponse(response));
      }
    }
    return out;
  }

  async logout() {
    if (!this.#socket || this.#dead) return;
    try {
      await this.#exec('LOGOUT');
    } finally {
      this.#loggedOut = true;
    }
  }

  async close() {
    this.#dead = true;
    this.#releaseSignal();
    const socket = this.#detach();
    this.#socket = null;
    if (socket) {
      socket.destroy();
      // Give the event loop one turn so the destroyed socket's handlers settle
      // before a caller tears down a test server underneath it.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const pending = [...this.#queue];
    this.#queue = [];
    const current = this.#current;
    this.#current = null;
    if (current) {
      clearTimeout(current.timer);
      current.reject(this.#error('connection closed'));
    }
    for (const job of pending) job.reject(this.#error('connection closed'));
  }

  /* ---------------- command plumbing ---------------- */

  /**
   * One command in flight at a time. Untagged responses that arrive while a
   * command runs belong to it; the tagged completion resolves or rejects it.
   */
  #exec(command, { onContinuation = null } = {}) {
    return new Promise((resolve, reject) => {
      // First, before any state: a command that could change the mailbox is a
      // bug in this file, and it must not reach the socket however it got here.
      try {
        assertReadOnlyCommand(command);
      } catch (err) {
        reject(err);
        return;
      }
      // Ahead of the `#dead` check, because cancelling sets both and "cancelled"
      // is the answer the caller can act on — "not connected" reads like a bug.
      if (this.#cancelled) {
        reject(this.#error('cancelled'));
        return;
      }
      if (this.#dead || !this.#socket) {
        reject(this.#error('not connected'));
        return;
      }
      this.#queue.push({ command, onContinuation, resolve, reject, untagged: [], untaggedBytes: 0, tag: null, timer: null });
      this.#pump();
    });
  }

  #pump() {
    if (this.#current || this.#queue.length === 0 || this.#dead || !this.#socket) return;
    const job = this.#queue.shift();
    job.tag = `A${String(++this.#tagSeq).padStart(4, '0')}`;
    this.#current = job;
    this.#arm(job);
    this.log.debug(`C: ${job.tag} ${sanitizeCommand(job.command)}`);
    this.#socket.write(`${job.tag} ${job.command}${CRLF}`);
  }

  /**
   * The deadline is for *silence*, not for the whole command: fetching a
   * hundred messages over a slow link is healthy, a server that has said
   * nothing for 30 seconds is not.
   */
  #arm(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      this.#fail(this.#error(`no response to ${verbOf(job.command)} for ${this.timeoutMs}ms`));
    }, this.timeoutMs);
  }

  #onData(chunk) {
    if (this.#current) this.#arm(this.#current);
    let responses;
    try {
      responses = this.#assembler.push(chunk);
    } catch (err) {
      this.#fail(this.#error(err.message));
      return;
    }
    for (const raw of responses) {
      // One chunk can carry thousands of complete responses, and the guard in
      // #onResponse kills the connection from inside this loop. Without this
      // the rest of the chunk would keep being handed to a dead client.
      if (this.#dead) return;
      try {
        this.#onResponse(raw);
      } catch (err) {
        this.#fail(this.#error(`could not parse server response — ${err.message}`, err));
        return;
      }
    }
  }

  #onResponse(raw) {
    const values = parseResponse(raw);
    const lead = tokenText(values[0]);

    if (lead === '+') {
      const job = this.#current;
      if (!job || !job.onContinuation) {
        // Nothing wants this prompt; cancel it rather than deadlock.
        this.#socket?.write(`*${CRLF}`);
        return;
      }
      const reply = job.onContinuation(raw.text.slice(1).trim());
      this.log.debug('C: <continuation payload withheld>');
      // A continuation is a SASL payload: base64, an empty line, or `*` to
      // abort. Anything else could carry a command, and is refused like one.
      const line = reply == null ? '' : String(reply);
      if (!/^[A-Za-z0-9+/=]*$|^\*$/.test(line)) {
        this.#fail(this.#error('refusing to send a continuation that is not a SASL payload'));
        return;
      }
      this.#socket.write(`${line}${CRLF}`);
      return;
    }

    if (lead === '*') {
      const response = { text: raw.text, values };
      const name = untaggedName(response);
      if (name === 'CAPABILITY') this.#caps = null;
      if (name === 'BYE') this.#byeText = raw.text.replace(/^\*\s*BYE\s*/i, '').trim();
      if (this.#greeting) {
        const greeting = this.#greeting;
        this.#greeting = null;
        if (name === 'BYE') {
          greeting.reject(this.#error(`server refused the connection — ${this.#byeText}`));
          return;
        }
        if (name === 'PREAUTH') this.#authenticated = true;
        for (const cap of capsFromCode(codeOf(raw.text))) {
          this.#caps = this.#caps || new Set();
          this.#caps.add(cap);
        }
        greeting.resolve();
        return;
      }
      if (this.#current) this.#keepUntagged(this.#current, response);
      return;
    }

    const job = this.#current;
    if (!job || lead !== job.tag) {
      this.log.debug(`S: unsolicited tagged response ignored: ${raw.text.slice(0, 120)}`);
      return;
    }

    clearTimeout(job.timer);
    this.#current = null;

    const match = /^\S+\s+(OK|NO|BAD)\b\s*(.*)$/is.exec(raw.text);
    const status = match ? match[1].toUpperCase() : 'BAD';
    const detail = match ? match[2].trim() : raw.text;
    const code = codeOf(detail);

    if (status === 'OK') {
      job.resolve({ ok: true, status, code, text: detail, untagged: job.untagged });
    } else {
      const err = this.#error(`${verbOf(job.command)} failed — ${status}${detail ? ` ${detail}` : ''}`);
      err.status = status;
      err.code = code;
      // The server's own words, already struck of our credentials, kept apart
      // from the sentence they are wrapped in. `#authenticateXOAuth2` rebuilds
      // its error rather than appending to one, and this is what lets it do that
      // without either losing the diagnosis or printing the host twice.
      err.detail = withoutCredentials(detail, this.user, this.pass, this.accessToken);
      job.reject(err);
    }
    this.#pump();
  }

  /**
   * Hold an untagged response for the command in flight — the only place in
   * the client where memory grows across responses rather than within one.
   *
   * See MAX_UNTAGGED_RESPONSES. The cap has to refuse rather than truncate:
   * silently dropping responses would hand `select()` the wrong EXISTS or
   * `fetch()` a short list of messages, which is a worse outcome than a
   * connection that says why it stopped.
   */
  #keepUntagged(job, response) {
    if (job.untagged.length + 1 > MAX_UNTAGGED_RESPONSES) {
      this.#fail(this.#error('server sent more untagged responses to one command than Zelos will buffer'));
      return;
    }
    job.untaggedBytes += response.text.length;
    if (job.untaggedBytes > MAX_RESPONSE_BYTES) {
      this.#fail(this.#error('untagged responses to one command exceeded the maximum size Zelos will buffer'));
      return;
    }
    job.untagged.push(response);
  }

  /** A fatal condition: every waiting caller learns which host went wrong. */
  #fail(err) {
    if (this.#dead) return;
    this.#dead = true;
    this.#releaseSignal();
    const socket = this.#detach();
    this.#socket = null;
    socket?.destroy();

    const job = this.#current;
    this.#current = null;
    if (job) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    const pending = [...this.#queue];
    this.#queue = [];
    for (const queued of pending) queued.reject(err);
    if (this.#greeting) {
      const greeting = this.#greeting;
      this.#greeting = null;
      greeting.reject(err);
    }
  }

  /**
   * Every error this client raises is built here, which makes it the one place
   * that can guarantee the server's own words never carry our credentials back
   * out. A server is entitled to quote the command it rejected, and real ones do
   * — `NO [AUTHENTICATIONFAILED] rejected: A0002 LOGIN "me@x" "hunter2"`. That
   * text does not stop at the screen: it becomes `sources[].error`, which the
   * sweep writes into `runs.stats_json` in the database and serves from
   * /api/state. So the password is struck out of the message before it exists.
   */
  #error(message, cause) {
    const err = new Error(`IMAP ${this.host}:${this.port}: ${withoutCredentials(message, this.user, this.pass, this.accessToken)}`);
    err.host = this.host;
    err.port = this.port;
    if (cause) err.cause = cause;
    return err;
  }
}

/* ---------------- response helpers ---------------- */

function untaggedName(response) {
  const second = tokenText(response.values[1]);
  if (second && !/^\d+$/.test(second)) return second.toUpperCase();
  const third = tokenText(response.values[2]);
  return third ? third.toUpperCase() : '';
}

/** The `[BRACKETED CODE]` that follows a status word, if there is one. */
function codeOf(text) {
  const m = /^\s*(?:\*\s+)?(?:OK|NO|BAD|BYE|PREAUTH)?\s*\[([^\]]*)\]/i.exec(String(text ?? ''));
  return m ? m[1].trim() : null;
}

function capsFromCode(code) {
  if (!code || !/^CAPABILITY\b/i.test(code)) return [];
  return code.split(/\s+/).slice(1).map((c) => c.toUpperCase()).filter(Boolean);
}

function parseFetchResponse(response) {
  const seq = Number(tokenText(response.values[1]));
  const items = listItems(response.values[3]);
  const out = { seq: Number.isInteger(seq) ? seq : null, uid: null, flags: [], internalDate: null, size: null, structure: null, sections: new Map() };

  for (let i = 0; i + 1 < items.length; i += 2) {
    const key = (tokenText(items[i]) || '').toUpperCase();
    const value = items[i + 1];
    if (key === 'UID') { out.uid = Number(tokenText(value)); continue; }
    if (key === 'FLAGS') { out.flags = listItems(value).map((v) => tokenText(v)).filter(Boolean); continue; }
    if (key === 'INTERNALDATE') { out.internalDate = tokenText(value); continue; }
    if (key === 'RFC822.SIZE') { out.size = Number(tokenText(value)); continue; }
    if (key === 'BODYSTRUCTURE' || (key === 'BODY' && value && value.type === 'list')) { out.structure = value; continue; }
    const section = /^BODY(?:\.PEEK)?\[(.*)\](?:<\d+>)?$/i.exec(key);
    if (section) out.sections.set(normalizeSection(section[1]), tokenBytes(value));
  }
  return out;
}

/** "header.fields (from  to)" and "HEADER.FIELDS (FROM TO)" are one section. */
function normalizeSection(spec) {
  return String(spec).replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * The one thing this client must never do. `BODY[...]` sets \Seen on the
 * server, and so do `BINARY[...]` (RFC 3516), `RFC822` and `RFC822.TEXT`;
 * refuse to put one on the wire
 * even if a caller asks for it. (`RFC822.HEADER` and `RFC822.SIZE` do not.)
 */
function assertPeekOnly(spec) {
  if (/\b(?:BODY|BINARY)\s*\[/i.test(spec)) {
    throw new Error('refusing to send BODY[...] or BINARY[...] — it would mark the message as read; use BODY.PEEK[...]');
  }
  if (/\bRFC822(?:\.TEXT)?(?![.\w])/i.test(spec)) {
    throw new Error('refusing to send RFC822 or RFC822.TEXT — it would mark the message as read; use BODY.PEEK[...]');
  }
}

/**
 * Every command this client may send, by verb: connect and authenticate, list
 * and open a mailbox read-only, search and fetch by UID, leave. Nothing on this
 * list can change a mailbox, and nothing off it is ever written to the socket —
 * STORE, COPY, MOVE, APPEND, EXPUNGE, SELECT, CREATE, DELETE, RENAME and every
 * verb not yet invented included. docs/VERIFICATION.md tells Google's reviewers
 * that the client never issues a write; this is what makes that a property of
 * the code rather than of its current callers, and test/imap.test.mjs holds it
 * to it, on the wire and over every command the file can issue.
 */
export const READ_ONLY_COMMANDS = Object.freeze([
  'CAPABILITY', 'STARTTLS', 'LOGIN', 'AUTHENTICATE', 'LIST', 'EXAMINE', 'UID SEARCH', 'UID FETCH', 'LOGOUT',
]);

/**
 * Throws unless `command` is one of READ_ONLY_COMMANDS — and a fetch, a peek.
 * One command, one line: a line break inside an allowed command would put a
 * second command of anyone's choosing on the wire behind it, so CR, LF and
 * NUL are refused anywhere in it (`quoted()` already keeps them out of every
 * argument it builds; this is the gate that does not depend on that).
 */
export function assertReadOnlyCommand(command) {
  if (/[\r\n\0]/.test(String(command ?? ''))) {
    throw new Error('refusing to send a command containing a line break — this client sends one command per line');
  }
  const words = String(command ?? '').trimStart().split(/\s+/);
  const verb = (words[0] || '').toUpperCase() === 'UID'
    ? `UID ${(words[1] || '').toUpperCase()}`
    : (words[0] || '').toUpperCase();
  if (!READ_ONLY_COMMANDS.includes(verb)) {
    throw new Error(`refusing to send ${verb || 'an empty command'} — this client only reads (${READ_ONLY_COMMANDS.join(', ')})`);
  }
  if (verb === 'UID FETCH') assertPeekOnly(command);
}

/** The command name alone — arguments never reach an error message or a log. */
function verbOf(command) {
  const parts = String(command).trim().split(/\s+/);
  const head = (parts[0] || '').toUpperCase();
  return head === 'UID' && parts[1] ? `${head} ${parts[1].toUpperCase()}` : head;
}

function sanitizeCommand(command) {
  if (/^LOGIN\b/i.test(command)) return 'LOGIN <user> <password withheld>';
  if (/^AUTHENTICATE\b/i.test(command)) return String(command).split(/\s+/).slice(0, 2).join(' ');
  return command;
}

const WITHHELD = '<password withheld>';

/**
 * A bare substring shorter than this is not searched for.
 *
 * A blind scan has no notion of a word, so a two-character password turns every
 * accidental occurrence in the server's own sentence into `<password withheld>`
 * — and the pattern of holes it leaves behind spells the password out for
 * anyone reading the wreckage. Below the floor the credential is still struck
 * in the shapes it actually travels in (quoted, base64), which is where a
 * server that echoes it puts it; only the blind scan is skipped.
 */
const MIN_BARE_REDACTION = 4;

/**
 * Strike our own password out of text that came back from the server.
 *
 * Up to five spellings, because that is how many ways this password can come
 * back. `quoted()` does not put the password on the wire verbatim: it
 * backslash-escapes `"` and `\` first, so `pa"ss\word` leaves as
 * `"pa\"ss\\word"` and a server quoting the LOGIN line it rejected hands back a
 * string that `includes(pass)` says nothing about. That escaped form — with and
 * without its quotes — is listed here alongside the verbatim bytes, the
 * standalone base64, and the SASL PLAIN payload `base64(NUL user NUL pass)`.
 *
 * Two traps, both of which this used to walk into, and both of which are only
 * visible end to end through `testConnection` against a server that echoes the
 * line it rejected:
 *
 *  1. The list is not five distinct strings. A password with no `"` and no `\`
 *     escapes to itself, so `pass === escaped` and the same needle appeared
 *     twice — hence the `Set`.
 *  2. Substituting one form at a time re-scans text that has already been
 *     redacted, and `<password withheld>` is not inert: it contains "pass",
 *     "word", "password" and "withheld". Measured through the real
 *     `testConnection`, the password `pass` came back as
 *     `<<<password withheld>word withheld>word withheld>` and `word` as
 *     `<pass<pass<password withheld> withheld> withheld>`. Nothing leaked —
 *     each pass ate the marker, not the secret — but the diagnosis the user
 *     needs was shredded by the very code meant to preserve it.
 *
 * So: one left-to-right pass over the original text, longest form first at any
 * given offset, and the cursor jumps past what was struck. Output is never an
 * input, which is what makes the result independent of the order of the list.
 *
 * A server that echoes any of these forms is handing the credential back, and
 * everything downstream — the Settings "Test connection" response body,
 * `runs.stats_json` on disk, /api/state, a log line — would keep it.
 *
 * `accessToken` joined the list when XOAUTH2 did, and it is not a nicety. A
 * bearer token is a bigger credential than the password it replaces — it is
 * mail access for the next hour with no second factor in front of it — and it
 * travels in exactly two shapes: verbatim (the challenge a server writes back)
 * and inside `base64(user=…^Aauth=Bearer <token>^A^A)` (the SASL blob a server
 * quoting the line it rejected hands straight back). Both are listed, because
 * an XOAUTH2 `NO` lands in `sources[].error` by the same route a LOGIN one does.
 */
function withoutCredentials(message, user, pass, accessToken = '') {
  const text = String(message);
  const token = String(accessToken ?? '');
  if (!pass && !token) return text;
  const escaped = String(pass ?? '').replace(/([\\"])/g, '\\$1');
  const passForms = pass ? [
    `"${escaped}"`,
    Buffer.from(pass, 'utf8').toString('base64'),
    Buffer.concat([
      Buffer.from([0]), Buffer.from(String(user ?? ''), 'utf8'),
      Buffer.from([0]), Buffer.from(pass, 'utf8'),
    ]).toString('base64'),
    ...[pass, escaped].filter((form) => form.length >= MIN_BARE_REDACTION),
  ] : [];
  const tokenForms = token ? [
    // Built by the same function that puts it on the wire. Two copies of this
    // string is how the redaction comes to be searching for a payload the
    // client no longer sends.
    xoauth2Bytes(String(user ?? ''), token).toString('base64'),
    ...[token].filter((form) => form.length >= MIN_BARE_REDACTION),
  ] : [];
  const forms = [...new Set([...passForms, ...tokenForms])]
    .filter(Boolean)
    // Longest first, so a tie at the same offset — the bare password sitting
    // one character inside its own quoted spelling — is resolved in favour of
    // striking the whole quoted argument rather than leaving its quotes behind.
    .sort((a, b) => b.length - a.length);

  /* One left-to-right pass, with each form's next occurrence remembered.
     The obvious loop — re-running `indexOf(form, cursor)` for every form on
     every hit — is quadratic, and a hostile server chooses both the length and
     the number of hits: a `NO` reply repeating an 8-character password measured
     7 ms at 18 KB, 29 ms at 72 KB and 431 ms at 288 KB, which is 15x the time
     for 4x the input, against a MAX_RESPONSE_BYTES ceiling of 96 MB. Because a
     form's next index only ever moves forward, caching it and re-searching only
     the form that was just consumed makes the whole scan linear in the text
     once per form. `null` means "no further occurrence" and is never searched
     again. */
  const next = forms.map((form) => {
    const idx = text.indexOf(form);
    return idx < 0 ? null : idx;
  });

  let out = '';
  let cursor = 0;
  for (;;) {
    let at = -1;
    let which = -1;
    for (let i = 0; i < forms.length; i++) {
      const idx = next[i];
      if (idx === null) continue;
      if (at < 0 || idx < at) { at = idx; which = i; }
    }
    if (at < 0) break;
    out += text.slice(cursor, at) + WITHHELD;
    cursor = at + forms[which].length;
    // Every form now sitting at or before the cursor is stale — including the
    // one just struck, and any shorter form that overlapped it.
    for (let i = 0; i < forms.length; i++) {
      if (next[i] !== null && next[i] < cursor) {
        const idx = text.indexOf(forms[i], cursor);
        next[i] = idx < 0 ? null : idx;
      }
    }
  }
  return out + text.slice(cursor);
}

/**
 * SNI carries a hostname, and Node rejects an IP address there outright — which
 * matters because Proton Bridge and self-hosted servers are reached by IP.
 */
function sniFor(host) {
  return net.isIP(host) ? {} : { servername: host };
}

/**
 * The options for a TLS handshake with `host`.
 *
 * Proton Bridge encrypts — STARTTLS on 127.0.0.1:1143 by default, or TLS from
 * the first byte if the user switches it — with a certificate it makes for
 * itself, which nothing on this machine vouches for (Node does not read the
 * Keychain Bridge offers to install it in). Verifying it failed every Bridge
 * account, whatever was chosen: the client upgrades whenever STARTTLS is
 * offered, so there was no setting to get past it.
 *
 * So on loopback the certificate is not verified. That is no weaker than the
 * cleartext session `tlsRequiredByDefault` already allows there, and anything
 * able to answer on 127.0.0.1 is already running on this computer. The
 * session is still encrypted, so `requireTls` keeps meaning what it says.
 * The name is half the rule; `#refuseUnverified` checks the address the
 * socket really reached. Everywhere else, verification is Node's default.
 * Nothing outside this file opens TLS with these options.
 */
function tlsOptionsFor(host) {
  return { ...sniFor(host), ...(isLoopbackHost(host) ? { rejectUnauthorized: false } : {}) };
}

function quoted(value) {
  const s = String(value ?? '');
  if (/[\r\n]/.test(s)) throw new Error('IMAP argument contains a line break');
  return `"${s.replace(/([\\"])/g, '\\$1')}"`;
}

function isAsciiSafe(value) {
  return /^[\x20-\x7e]*$/.test(String(value ?? ''));
}

function searchArg(value) {
  const s = String(value ?? '');
  if (/[\r\n]/.test(s)) throw new Error('IMAP search argument contains a line break');
  if (/^[A-Za-z0-9._:*,+-]+$/.test(s)) return s;
  return quoted(s);
}

function specialUseOf(name, flags) {
  for (const flag of flags) {
    if (SPECIAL_USE_FLAGS.has(String(flag).toLowerCase())) return String(flag).slice(1).toLowerCase();
  }
  return name.toUpperCase() === 'INBOX' ? 'inbox' : null;
}

/* ================================================================== *
 * 6. XOAUTH2 credentials: the device authorization grant
 * ================================================================== */

/**
 * Why this section exists, and why it is a device code and nothing else.
 *
 * Microsoft switched basic authentication off for personal Outlook, Hotmail,
 * Live and MSN accounts on 16 September 2024, and app passwords went with it —
 * there is no password of any kind that opens an IMAP session on those accounts
 * any more. Zelos went on offering `outlook.office365.com` as a preset with no
 * caveat next to it, so the shipped path for one of the two largest consumer
 * mail providers was an authentication failure in the middle of onboarding,
 * with nothing anywhere saying why. `AUTHENTICATE XOAUTH2` is the way back in
 * and a bearer token is the only thing it accepts.
 *
 * Which OAuth flow is not a preference. Zelos ships NO client id of its own: one
 * we published would need Microsoft publisher verification (a Partner One ID and
 * a verified domain), and it would make every install's mail access contingent
 * on an app registration this project holds and could lose. So the credential is
 * a thing the USER mints in their own account and pastes in, like every other
 * credential in this app — which rules out a client secret (there is nowhere to
 * keep one) and rules out a redirect URI (a desktop app with no inbound port
 * cannot receive a callback, and RFC 8252's loopback receiver needs the
 * registration to name the port range). What is left is RFC 8628: the program
 * shows a code, the user types it into a browser they already trust, and the
 * program polls. It was designed for televisions and printers, and a mail
 * client that refuses to run a web server is the same shape of problem.
 *
 * Everything here is inert without a registration: no client id, no request.
 *
 * Google is the other way round, and the difference is Google's, not ours:
 * Google has no device grant that reaches IMAP, but its "Desktop app" clients
 * accept a loopback redirect on any port. So "Sign in with Google" is the PKCE
 * flow in core/sources/oauth.mjs, received on the Zelos server's own port by
 * core/server.mjs — and what lands here is only the part the two providers
 * share: the stored grant, its refresh, and the bearer token on the wire.
 * `accessTokenFor` branches on `provider`; an account written before that
 * field existed has none and is Microsoft, because nothing else was possible.
 */

/** The only origin outside loopback that a refresh token may be spent against. */
export const MS_LOGIN_ORIGIN = 'https://login.microsoftonline.com';

/**
 * Where a Google refresh token may be spent, read off the provider table. The
 * same rule as `assertTokenEndpoint` below — this origin, spelled exactly, or
 * loopback for the test rig — and for the same reason: a config that could
 * name its own token endpoint would be a one-field exfiltration route.
 */
export const GOOGLE_TOKEN_ORIGIN = new URL(OAUTH_PROVIDERS.google.tokenUrl).origin;

/**
 * The delegated permission that buys IMAP, plus the one that makes the grant
 * outlive the hour an access token lasts.
 *
 * `offline_access` is not optional on the v2 endpoint and its absence is silent:
 * Microsoft answers with an access token, no refresh token, and no error, so the
 * account works perfectly for an hour and then cannot be renewed without the
 * user going through the whole dance again. Asking for it is the difference
 * between connecting an account and borrowing one.
 */
export const MS_IMAP_SCOPES = Object.freeze([
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'offline_access',
]);

/**
 * A failure in the token half of the mail path.
 *
 * `code` is the machine-readable reason — the OAuth error verbatim where the
 * server named one (`authorization_pending`, `slow_down`, `invalid_grant`,
 * `expired_token`), otherwise one of ours (`not_configured`, `not_connected`,
 * `bad_endpoint`, `bad_tenant`, `network`, `timeout`, `bad_response`).
 *
 * `reconnect` is the flag every caller above this actually acts on, and the
 * reason this class exists rather than a bare Error. There are two entirely
 * different failures here that look alike from a distance: "the network was
 * down, try the next sweep" and "this grant is dead and no amount of retrying
 * will revive it". Only the second one is worth interrupting a person for, and
 * only the second one has an answer they can act on — reconnect the account.
 * Retrying an `invalid_grant` every fifteen minutes forever, which is what an
 * undifferentiated error gets you, is how a mailbox goes quietly stale.
 */
export class ImapOAuthError extends Error {
  constructor(message, { code = 'oauth_error', reconnect = false, status = 0, description = '' } = {}) {
    super(message);
    this.name = 'ImapOAuthError';
    this.code = code;
    this.reconnect = reconnect === true;
    this.status = status;
    this.description = description;
  }
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The three tenant aliases Microsoft defines, next to the two real spellings.
 *
 * `consumers` is the one a personal Outlook.com account needs, `organizations`
 * the one a work account needs, and `common` accepts either — which is why it is
 * the default and why the Settings copy tells people to leave it alone unless
 * their sign-in fails.
 */
const TENANT_ALIASES = new Set(['common', 'organizations', 'consumers']);

/**
 * The tenant is the one piece of user input that becomes a URL PATH SEGMENT, so
 * it is validated as a closed set rather than escaped.
 *
 * A tenant of `..` or `../..` is not hypothetical — it is what a mistyped or
 * pasted value looks like, and `${origin}/${tenant}/oauth2/v2.0/token` with one
 * in it resolves, silently and without error, to a completely different endpoint
 * on the same host. What goes to that endpoint is the refresh token, which is
 * the whole account. There is no legitimate tenant that is not a GUID, a domain
 * name, or one of the three aliases, so anything else is refused before a socket
 * exists rather than sanitised into something that might still be wrong.
 */
export function normalizeTenant(tenantId) {
  const raw = String(tenantId ?? '').trim();
  if (!raw) return 'common';
  const lower = raw.toLowerCase();
  if (TENANT_ALIASES.has(lower)) return lower;
  if (GUID_RE.test(raw)) return raw.toLowerCase();
  if (DOMAIN_RE.test(raw)) return lower;
  throw new ImapOAuthError(
    `oauth: ${JSON.stringify(raw)} is not a Microsoft tenant — use common, organizations, consumers, `
    + 'the directory (tenant) ID from your app registration, or your organisation\'s domain',
    { code: 'bad_tenant' },
  );
}

/** Entra hands out GUIDs. Anything else is a paste that went wrong. */
export function normalizeClientId(clientId) {
  const raw = String(clientId ?? '').trim();
  if (!raw) {
    throw new ImapOAuthError(
      'oauth: this account has no application (client) ID, so there is no registration to sign in against',
      { code: 'not_configured' },
    );
  }
  if (!GUID_RE.test(raw)) {
    throw new ImapOAuthError(
      `oauth: ${JSON.stringify(raw.slice(0, 60))} is not an application (client) ID — Entra shows it as a GUID `
      + 'on the app registration\'s Overview page',
      { code: 'not_configured' },
    );
  }
  return raw.toLowerCase();
}

/**
 * Where a refresh token is allowed to go.
 *
 * Only the origin survives this function — a path, a query string or a
 * fragment someone put on the end is dropped rather than honoured — which is
 * what makes the tenant check above sufficient: the host cannot be moved from
 * the path, and the path cannot be moved from the tenant.
 *
 * Loopback is permitted for the same reason `isLoopbackHost` exists further up:
 * it is where the test rig's mock authorization server lives, and it is traffic
 * that never leaves the machine. Everything else must be the Microsoft origin,
 * spelled exactly, over https. A config that could name its own token endpoint
 * would be a one-field exfiltration route for the most valuable secret this app
 * holds, so this is a check and not a default.
 */
export function assertTokenEndpoint(base) {
  let url;
  try {
    url = new URL(String(base ?? ''));
  } catch {
    throw new ImapOAuthError(`oauth: ${JSON.stringify(String(base ?? '').slice(0, 80))} is not a URL`, {
      code: 'bad_endpoint',
    });
  }
  if (url.origin === MS_LOGIN_ORIGIN) return url.origin;
  if (isLoopbackHost(url.hostname)) return url.origin;
  throw new ImapOAuthError(
    `oauth: refusing to send a refresh token to ${url.origin} — the only sign-in endpoint Zelos will use is ${MS_LOGIN_ORIGIN}`,
    { code: 'bad_endpoint' },
  );
}

function endpointFor(base, tenant, leaf) {
  return `${assertTokenEndpoint(base)}/${tenant}/oauth2/v2.0/${leaf}`;
}

/**
 * Google's token URL, or a loopback one. Unlike Microsoft's, the path is kept:
 * Google's endpoint is `/token` on its own host rather than a tenant segment
 * built here, and a loopback mock has whatever path it has.
 */
export function assertGoogleTokenEndpoint(base) {
  let url;
  try {
    url = new URL(String(base ?? '') || OAUTH_PROVIDERS.google.tokenUrl);
  } catch {
    throw new ImapOAuthError(`oauth: ${JSON.stringify(String(base ?? '').slice(0, 80))} is not a URL`, {
      code: 'bad_endpoint',
    });
  }
  if (url.origin === GOOGLE_TOKEN_ORIGIN || isLoopbackHost(url.hostname)) return url.toString();
  throw new ImapOAuthError(
    `oauth: refusing to send a refresh token to ${url.origin} — the only Google endpoint Zelos will use is ${GOOGLE_TOKEN_ORIGIN}`,
    { code: 'bad_endpoint' },
  );
}

/**
 * A Google client id is `<number>-<hash>.apps.googleusercontent.com`, not a
 * GUID, so `normalizeClientId` would refuse every real one. The shape is not
 * pinned beyond "one token with no whitespace": Google has changed the
 * suffix before and a paste that is merely unusual should reach Google, whose
 * refusal names the problem better than a regex here would.
 */
export function normalizeGoogleClientId(clientId) {
  const raw = String(clientId ?? '').trim();
  if (!raw) {
    throw new ImapOAuthError(
      'oauth: this account has no Google client ID, so there is no registration to sign in against',
      { code: 'not_configured' },
    );
  }
  if (raw.length > 200 || /[\s\x00-\x1f\x7f]/.test(raw)) {
    throw new ImapOAuthError(
      `oauth: ${JSON.stringify(raw.slice(0, 60))} is not a Google client ID`,
      { code: 'not_configured' },
    );
  }
  return raw;
}

const TOKEN_TIMEOUT_MS = 30_000;

/**
 * A token endpoint answers in a few hundred bytes. This is three orders of
 * magnitude past that, and it is read off the STREAM rather than off
 * `content-length` for the same reason section 1 counts bytes as they arrive: a
 * server that intends to hand Zelos a gigabyte does not announce it first.
 */
const MAX_TOKEN_RESPONSE_BYTES = 256 * 1024;

async function readCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_TOKEN_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ImapOAuthError('oauth: the sign-in endpoint sent more than Zelos will read', {
        code: 'bad_response',
        status: res.status,
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One POST to a Microsoft OAuth endpoint.
 *
 * `redirect: 'error'` rather than the default, and the reason is the same one
 * core/connectors/http.mjs writes out at length: undici follows twenty hops, and
 * a redirect chain is a way for the first host to hand the credential in the
 * body to the twentieth. There is no legitimate redirect on a token endpoint.
 *
 * `client_secret` is deleted from the body on the way out — structurally, not
 * by everyone remembering — and put back only from `clientSecret`, which a
 * caller fills from the secret store. Microsoft's device client has none.
 * Google's "Desktop app" client has one and is refused at `/token` without it,
 * while Google documents it as not confidential for an installed app.
 */
async function postForm(url, form, {
  timeoutMs = TOKEN_TIMEOUT_MS, signal = null, fetchImpl = null, clientSecret = '',
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const body = new URLSearchParams(form);
  body.delete('client_secret');
  if (typeof clientSecret === 'string' && clientSecret) body.set('client_secret', clientSecret);

  const deadline = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || TOKEN_TIMEOUT_MS));
  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      redirect: 'error',
    });
  } catch (err) {
    throw new ImapOAuthError(`oauth: could not reach the sign-in endpoint (${err.message})`, {
      code: err?.name === 'TimeoutError' ? 'timeout' : 'network',
    });
  }

  let text;
  try {
    text = await readCapped(res);
  } catch (err) {
    // A connection torn down between the headers and the body reads as a
    // network failure, not as an unhandled undici error two frames up.
    if (err instanceof ImapOAuthError) throw err;
    throw new ImapOAuthError(`oauth: the sign-in endpoint hung up mid-answer (${err.message})`, { code: 'network' });
  }
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    // The OAuth `error` verbatim, because the polling loop above branches on
    // `authorization_pending` and `slow_down` by name and an invented code would
    // turn "the user has not finished yet" into a hard failure.
    const code = String(payload?.error || `http_${res.status}`).slice(0, 80);
    const description = String(payload?.error_description || '').slice(0, 300);
    throw new ImapOAuthError(
      `oauth: the sign-in endpoint refused the request (${code}${description ? `: ${description}` : ''})`,
      { code, status: res.status, description, reconnect: RECONNECT_CODES.has(code) },
    );
  }
  if (!payload || typeof payload !== 'object') {
    throw new ImapOAuthError('oauth: the sign-in endpoint answered with something that was not JSON', {
      code: 'bad_response',
      status: res.status,
    });
  }
  return payload;
}

/**
 * The errors that mean "this grant is over", as opposed to "try again".
 *
 * `invalid_grant` is the important one and the easy one to get wrong. It is what
 * Microsoft returns when the refresh token has been revoked, when the user
 * changed their password, when the tenant's conditional access policy changed,
 * and when 90 days of inactivity expired it — every one of which is permanent
 * until a human does something. Treating it as retryable turns a two-minute fix
 * into a mailbox that silently stops updating and a sweep that dials Microsoft
 * every fifteen minutes forever to be told the same thing.
 */
const RECONNECT_CODES = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'expired_token',
  'authorization_declined',
  'bad_verification_code',
  'consent_required',
  'interaction_required',
]);

/* ---------------- the device code dance ---------------- */

/** RFC 8628 §3.5: never poll faster than this, whatever the server said. */
const POLL_FLOOR_MS = 5_000;

/** RFC 8628 §3.5: `slow_down` means "add five seconds", not "back off a bit". */
const SLOW_DOWN_STEP_MS = 5_000;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Step one: ask for a device code. Returns what the user has to be shown and
 * the handle `pollForDeviceToken` needs.
 *
 * `deviceCode` in the returned object is a credential — whoever holds it
 * collects the tokens when the user finishes — so it is never logged and never
 * displayed. `userCode` is the one meant for a human's eyes.
 */
export async function beginDeviceAuthorization({
  clientId,
  tenantId = 'common',
  scopes = MS_IMAP_SCOPES,
  endpoint = MS_LOGIN_ORIGIN,
  timeoutMs = TOKEN_TIMEOUT_MS,
  signal = null,
  fetchImpl = null,
  now = Date.now(),
} = {}) {
  const id = normalizeClientId(clientId);
  const tenant = normalizeTenant(tenantId);
  const scope = (Array.isArray(scopes) ? scopes : [scopes]).map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
  if (!scope) throw new ImapOAuthError('oauth: at least one scope is required', { code: 'bad_scope' });

  const payload = await postForm(
    endpointFor(endpoint, tenant, 'devicecode'),
    { client_id: id, scope },
    { timeoutMs, signal, fetchImpl },
  );

  const deviceCode = String(payload.device_code ?? '');
  const userCode = String(payload.user_code ?? '');
  const verificationUri = String(payload.verification_uri || payload.verification_url || 'https://microsoft.com/devicelogin');
  if (!deviceCode || !userCode) {
    throw new ImapOAuthError('oauth: the sign-in endpoint answered without a device code', { code: 'bad_response' });
  }

  const expiresIn = Number(payload.expires_in);
  const interval = Number(payload.interval);
  defaultLog.info('imap: started a device sign-in', { tenant });
  return {
    clientId: id,
    tenantId: tenant,
    endpoint,
    scope,
    deviceCode,
    userCode,
    verificationUri,
    // Microsoft's own sentence, which names the code and the URL together and is
    // already localised. Shown verbatim where there is one, because a
    // hand-written English paraphrase is worse for everyone who is not reading
    // this app in English.
    message: typeof payload.message === 'string' ? payload.message.slice(0, 500) : '',
    expiresAt: new Date((Number.isFinite(expiresIn) ? now + expiresIn * 1000 : now + 900_000)).toISOString(),
    intervalMs: Math.max(POLL_FLOOR_MS, Number.isFinite(interval) && interval > 0 ? interval * 1000 : POLL_FLOOR_MS),
  };
}

/**
 * Step two: poll until the user finishes in their browser, or until the code
 * expires.
 *
 * `sleep` is a parameter because the interval is the behaviour under test.
 * Microsoft's floor is five seconds and `slow_down` adds five more, so a test
 * that proved the back-off with a real timer would take a minute to run and
 * would therefore be written not to prove it at all. Recording the delays the
 * loop ASKS for is both faster and stricter than watching a clock.
 */
export async function pollForDeviceToken(pending, {
  signal = null,
  fetchImpl = null,
  timeoutMs = TOKEN_TIMEOUT_MS,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  if (!pending?.deviceCode) throw new TypeError('oauth: pollForDeviceToken needs the handle beginDeviceAuthorization returned');
  const url = endpointFor(pending.endpoint ?? MS_LOGIN_ORIGIN, normalizeTenant(pending.tenantId), 'token');
  const deadline = Date.parse(pending.expiresAt);
  let interval = Math.max(POLL_FLOOR_MS, Number(pending.intervalMs) || POLL_FLOOR_MS);

  for (;;) {
    if (signal?.aborted) throw new ImapOAuthError('oauth: the sign-in was cancelled', { code: 'cancelled' });
    if (Number.isFinite(deadline) && now() >= deadline) {
      throw new ImapOAuthError(
        'oauth: the sign-in code expired before it was entered — start again from Settings',
        { code: 'expired_token', reconnect: true },
      );
    }
    // Before the first request, not after it: the user has not had time to open
    // a browser, and RFC 8628 §3.5 asks for the wait between polls in any case.
    await sleep(interval);
    // Checked again on the way out of the sleep, which is where a cancel almost
    // always lands: carried into the POST instead, an already-aborted signal
    // reads as "could not reach the sign-in endpoint" — a network failure the
    // panel would show for a button the person just pressed.
    if (signal?.aborted) throw new ImapOAuthError('oauth: the sign-in was cancelled', { code: 'cancelled' });

    let payload;
    try {
      payload = await postForm(url, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: pending.clientId,
        device_code: pending.deviceCode,
      }, { timeoutMs, signal, fetchImpl });
    } catch (err) {
      if (err?.code === 'authorization_pending') continue;
      if (err?.code === 'slow_down') { interval += SLOW_DOWN_STEP_MS; continue; }
      throw err;
    }
    defaultLog.info('imap: a device sign-in completed', { tenant: pending.tenantId });
    return normalizeTokenSet(payload, { now: now() });
  }
}

/**
 * Begin, show the code, poll, store. The one call a Settings "Connect" button
 * needs, and it hands back no tokens — only whether there is one and when it
 * runs out — so a caller cannot casually log the thing it just stored.
 */
export async function connectDeviceCode({
  clientId,
  tenantId = 'common',
  tokenRef,
  scopes = MS_IMAP_SCOPES,
  endpoint = MS_LOGIN_ORIGIN,
  onCode,
  signal = null,
  fetchImpl = null,
  timeoutMs = TOKEN_TIMEOUT_MS,
  sleep = defaultSleep,
  now = Date.now(),
} = {}) {
  if (!tokenRef) throw new TypeError('oauth: connectDeviceCode needs the ref to store the grant under');
  const pending = await beginDeviceAuthorization({
    clientId, tenantId, scopes, endpoint, timeoutMs, signal, fetchImpl, now,
  });
  if (typeof onCode === 'function') {
    onCode({
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      message: pending.message,
      expiresAt: pending.expiresAt,
    });
  }
  const tokens = await pollForDeviceToken(pending, { signal, fetchImpl, timeoutMs, sleep });
  if (!tokens.refreshToken) {
    throw new ImapOAuthError(
      'oauth: Microsoft returned no refresh token, so this connection would stop working within the hour — '
      + 'the app registration has to request the offline_access scope',
      { code: 'no_refresh_token', reconnect: true },
    );
  }
  await saveOAuthTokens(tokenRef, tokens);
  return {
    ok: true,
    ref: tokenRef,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
    hasRefreshToken: true,
  };
}

/* ---------------- the stored grant ---------------- */

/**
 * A token set as this file keeps it. `expiresAt` is an instant, never a
 * wall-clock reading: it is only ever compared.
 *
 * `previous` exists because a refresh that omits `refresh_token` means "keep the
 * one you have" and not "you no longer have one". Microsoft usually rotates —
 * see `accessTokenFor` — but the omitting case is legal and dropping the token
 * on it would sign the user out on the first quiet refresh.
 */
function normalizeTokenSet(payload, { now = Date.now(), previous = null } = {}) {
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: String(payload.access_token ?? ''),
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : (previous?.refreshToken ?? null),
    tokenType: String(payload.token_type || 'Bearer'),
    scope: typeof payload.scope === 'string' && payload.scope ? payload.scope : (previous?.scope ?? ''),
    expiresAt: Number.isFinite(expiresIn) ? new Date(now + expiresIn * 1000).toISOString() : null,
    obtainedAt: new Date(now).toISOString(),
  };
}

/**
 * The grant goes in the secret store, under the mail account's own `keyRef` —
 * the same place the password used to live.
 *
 * Not a second ref beside it, deliberately. Removing an account deletes exactly
 * one secret, `account.keyRef`, and a refresh token filed anywhere else would be
 * left behind on the machine after the user believed they had disconnected the
 * account — a live credential for a mailbox nothing is reading any more.
 *
 * `JSON.stringify` escapes any newline inside a value, so the stored string is
 * always single-line, which the macOS keychain backend requires.
 */
export async function saveOAuthTokens(ref, tokens) {
  if (!tokens || typeof tokens !== 'object') throw new TypeError('oauth: saveOAuthTokens needs a token set');
  await setSecret(ref, JSON.stringify({
    v: 1,
    kind: 'xoauth2',
    accessToken: tokens.accessToken ?? '',
    refreshToken: tokens.refreshToken ?? null,
    tokenType: tokens.tokenType ?? 'Bearer',
    scope: tokens.scope ?? '',
    expiresAt: tokens.expiresAt ?? null,
    obtainedAt: tokens.obtainedAt ?? new Date().toISOString(),
  }));
  return { ok: true, ref };
}

export async function loadOAuthTokens(ref) {
  const raw = await getSecret(ref);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // A password stored under this ref parses as nothing, and so does a
    // password that happens to be valid JSON. `kind` is what tells the two
    // apart, and a miss reads as "not connected" rather than as a broken grant.
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'xoauth2') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function forgetOAuthTokens(ref) {
  return deleteSecret(ref);
}

/** Spent a minute early, so a fetch never races its own expiry across the wire. */
export function oauthTokensExpired(tokens, { now = Date.now(), skewMs = 60_000 } = {}) {
  if (!tokens?.accessToken) return true;
  if (!tokens.expiresAt) return true;
  const at = Date.parse(tokens.expiresAt);
  if (Number.isNaN(at)) return true;
  return at - skewMs <= now;
}

/** Spend the refresh token for a new access token. */
export async function refreshAccessToken({
  clientId,
  tenantId = 'common',
  refreshToken,
  scopes = MS_IMAP_SCOPES,
  endpoint = MS_LOGIN_ORIGIN,
  timeoutMs = TOKEN_TIMEOUT_MS,
  signal = null,
  fetchImpl = null,
  now = Date.now(),
  previous = null,
} = {}) {
  const id = normalizeClientId(clientId);
  const tenant = normalizeTenant(tenantId);
  if (!refreshToken) {
    throw new ImapOAuthError(
      'oauth: there is no stored sign-in for this account, so it has to be connected again',
      { code: 'no_refresh_token', reconnect: true },
    );
  }
  const payload = await postForm(endpointFor(endpoint, tenant, 'token'), {
    grant_type: 'refresh_token',
    client_id: id,
    refresh_token: String(refreshToken),
    scope: (Array.isArray(scopes) ? scopes : [scopes]).map((s) => String(s ?? '').trim()).filter(Boolean).join(' '),
  }, { timeoutMs, signal, fetchImpl });

  const tokens = normalizeTokenSet(payload, { now, previous: previous || { refreshToken: String(refreshToken) } });
  if (!tokens.accessToken) {
    throw new ImapOAuthError('oauth: the sign-in endpoint answered without an access token', { code: 'bad_response' });
  }
  return tokens;
}

/**
 * Spend a Google refresh token for a new access token.
 *
 * Google does not rotate: the response carries no `refresh_token`, and
 * `normalizeTokenSet`'s `previous` keeps the one that was sent. The errors are
 * the same vocabulary as Microsoft's — `invalid_grant` when the user revoked
 * access or the Testing-mode consent aged out — so RECONNECT_CODES applies
 * unchanged and a dead grant rests the account the same way.
 */
export async function refreshGoogleAccessToken({
  clientId,
  clientSecret = '',
  refreshToken,
  tokenUrl = null,
  timeoutMs = TOKEN_TIMEOUT_MS,
  signal = null,
  fetchImpl = null,
  now = Date.now(),
  previous = null,
} = {}) {
  const id = normalizeGoogleClientId(clientId);
  if (!refreshToken) {
    throw new ImapOAuthError(
      'oauth: there is no stored sign-in for this account, so it has to be connected again',
      { code: 'no_refresh_token', reconnect: true },
    );
  }
  const payload = await postForm(assertGoogleTokenEndpoint(tokenUrl), {
    grant_type: 'refresh_token',
    client_id: id,
    refresh_token: String(refreshToken),
  }, { timeoutMs, signal, fetchImpl, clientSecret });

  const tokens = normalizeTokenSet(payload, { now, previous: previous || { refreshToken: String(refreshToken) } });
  if (!tokens.accessToken) {
    throw new ImapOAuthError('oauth: the sign-in endpoint answered without an access token', { code: 'bad_response' });
  }
  return tokens;
}

/** The secret a Google client may carry, or '' when nothing is filed under the ref. */
async function clientSecretUnder(ref) {
  // An AI key is read only for its own address, never posted to Google.
  if (!ref || isModelKeyRef(ref)) return '';
  try {
    return (await getSecret(ref)) || '';
  } catch {
    return '';
  }
}

/**
 * A usable access token for one mail account: load the grant, refresh it if the
 * stored token is spent, write the result back.
 *
 * The write-back is not an optimisation. Microsoft ROTATES the refresh token on
 * every redemption — each refresh response carries a new `refresh_token` and
 * invalidates the one that was sent — so a version of this that returned the
 * access token without storing the new refresh token would work exactly once and
 * then hand the same dead token to Microsoft on every sweep after it, for an
 * `invalid_grant` the user has no way to interpret.
 *
 * `provider` picks the refresh: `google` spends the grant at Google's token
 * endpoint with the client's secret, if one is filed under `clientSecretRef`;
 * anything else is Microsoft, which is what every account connected before
 * the field existed is. Both read and write the same stored shape under the
 * same ref, and the cached token is honoured the same way — a fresh one is
 * returned without a request, a spent one (expiry minus a minute) is renewed.
 */
export async function accessTokenFor({
  provider = 'microsoft',
  clientId,
  clientSecretRef = null,
  tenantId = 'common',
  tokenRef,
  scopes = MS_IMAP_SCOPES,
  endpoint = MS_LOGIN_ORIGIN,
  tokenUrl = null,
  timeoutMs = TOKEN_TIMEOUT_MS,
  signal = null,
  fetchImpl = null,
  now = Date.now(),
  skewMs = 60_000,
} = {}) {
  if (!tokenRef) throw new TypeError('oauth: accessTokenFor needs the ref the grant is stored under');
  const google = String(provider ?? '').trim().toLowerCase() === 'google';
  const id = google ? normalizeGoogleClientId(clientId) : normalizeClientId(clientId);
  const tenant = google ? null : normalizeTenant(tenantId);

  const stored = await loadOAuthTokens(tokenRef);
  if (!stored) {
    throw new ImapOAuthError(
      `oauth: this account has not been connected to ${google ? 'Google' : 'Microsoft'} on this machine — connect it from Settings`,
      { code: 'not_connected', reconnect: true },
    );
  }
  if (!oauthTokensExpired(stored, { now, skewMs })) {
    return { accessToken: stored.accessToken, expiresAt: stored.expiresAt, refreshed: false, ref: tokenRef };
  }

  const next = google
    ? await refreshGoogleAccessToken({
      clientId: id,
      // The client's own ref first, then the shared name — which is where
      // every secret filed before per-client refs existed still lives.
      clientSecret: (await clientSecretUnder(clientSecretRef)) || (await clientSecretUnder('oauth.google.clientSecret')),
      refreshToken: stored.refreshToken,
      tokenUrl,
      timeoutMs,
      signal,
      fetchImpl,
      now,
      previous: stored,
    })
    : await refreshAccessToken({
      clientId: id,
      tenantId: tenant,
      refreshToken: stored.refreshToken,
      scopes,
      endpoint,
      timeoutMs,
      signal,
      fetchImpl,
      now,
      previous: stored,
    });
  await saveOAuthTokens(tokenRef, next);
  return { accessToken: next.accessToken, expiresAt: next.expiresAt, refreshed: true, ref: tokenRef };
}

/* ---------------- the SASL payload ---------------- */

/**
 * The bytes of a SASL XOAUTH2 initial client response, before base64.
 *
 * `^A` in every document that describes this is a literal 0x01 — SOH, not a
 * caret followed by an A — and the payload ends with TWO of them: the first
 * terminates `auth=…`, the second terminates the (empty) list of further
 * key/value pairs. Exchange rejects a payload with one trailing SOH using the
 * same opaque challenge it uses for an expired token, so getting this wrong
 * costs an afternoon and looks like a credential problem the whole time.
 *
 * One function, called by the client and by the redaction, so the two can never
 * disagree about what is on the wire.
 */
function xoauth2Bytes(user, accessToken) {
  return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8');
}

/**
 * The base64 the client sends, with the one check that matters: neither field
 * may contain a 0x01 of its own.
 *
 * SOH is the field separator, so a username or a token carrying one would append
 * key/value pairs of somebody else's choosing to our authentication request.
 * Nothing legitimate contains one — an access token is base64url and an address
 * is an address — which is exactly why the check is cheap and worth having.
 */
export function xoauth2Payload(user, accessToken) {
  const u = String(user ?? '');
  const t = String(accessToken ?? '');
  if (!t) throw new Error('xoauth2Payload: an access token is required');
  if (/[\x00\x01\r\n]/.test(u) || /[\x00\x01\r\n]/.test(t)) {
    throw new Error('xoauth2Payload: a SASL field contains a separator or a line break');
  }
  return xoauth2Bytes(u, t).toString('base64');
}

/**
 * Turn the base64 JSON a server sends when it refuses an XOAUTH2 payload into
 * one clause a person can act on, or null when there is nothing in it.
 *
 * Microsoft's is `{"status":"400","schemes":"Bearer","scope":"…"}`. `status` is
 * the whole diagnosis: 400 is a malformed or expired token, 401 an invalid one,
 * 403 a token whose scopes do not include IMAP — three different things to do,
 * behind one identical `NO AUTHENTICATE failed` on the tagged line.
 */
export function describeXOAuth2Challenge(challenge) {
  const raw = String(challenge ?? '').trim();
  if (!raw) return null;
  let text = '';
  try {
    text = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return null;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    // Not JSON, but still the server's own words about why it said no.
    return /^[\x20-\x7e]+$/.test(text) ? text.slice(0, 200) : null;
  }
  const bits = [];
  if (parsed.status) bits.push(`status ${String(parsed.status).slice(0, 20)}`);
  if (parsed.scope) bits.push(`scope ${String(parsed.scope).slice(0, 160)}`);
  if (parsed.schemes) bits.push(`schemes ${String(parsed.schemes).slice(0, 60)}`);
  return bits.length ? bits.join(', ') : null;
}

/* ================================================================== *
 * 7. The function the engine calls
 * ================================================================== */

/**
 * Newest-first messages from one mailbox, headers and readable body only.
 *
 * Two passes on purpose: the first is cheap enough to run over hundreds of
 * messages (headers + structure), the second pulls exactly one body part per
 * message, chosen from the structure. Fetching whole messages to throw away the
 * attachments is how a mail sync turns into a download.
 *
 * `signal` is handed to the client rather than checked between the steps below.
 * A poll between steps cancels nothing that matters: the expensive part of this
 * function is a single `fetch()` of a hundred bodies, and that is exactly where
 * a Ctrl-C lands. The client fails the command in flight and destroys the
 * socket, so this function's rejection is what the caller waits for.
 *
 * `auth: 'xoauth2'` plus `oauth: {clientId, tenantId, tokenRef}` is the OAuth
 * account. `pass` is not read on that path — there is no password to read — and
 * `oauth.tokenRef` is the account's own `keyRef`, which is where section 6 files
 * the grant so that removing the account removes it too. A caller that already
 * holds a token can hand it over as `accessToken` and nothing is minted.
 */
export async function fetchRecent({
  host,
  port,
  secure,
  user,
  pass,
  auth = null,
  oauth = null,
  accessToken = '',
  requireTls = null,
  mailbox = 'INBOX',
  sinceDays = 14,
  limit = 400,
  onProgress,
  timeoutMs,
  logger,
  signal,
} = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const method = resolveAuthMethod(auth, accessToken);

  // Minted before the socket, not during the session: a refresh is an HTTPS
  // round trip to Microsoft and an IMAP connection holding open across it buys
  // nothing except a longer window for the server's idle timer to fire.
  let bearer = accessToken;
  if (method === 'xoauth2' && !bearer) {
    const who = String(oauth?.provider ?? '').toLowerCase() === 'google' ? 'Google' : 'Microsoft';
    progress({ phase: 'connect', message: `Renewing the ${who} sign-in`, done: 0, total: 0 });
    ({ accessToken: bearer } = await accessTokenFor({ ...(oauth || {}), signal }));
  }

  const client = new ImapClient({
    host, port, secure, user, pass, requireTls, timeoutMs, logger, signal,
    auth: method,
    accessToken: bearer,
  });

  try {
    progress({ phase: 'connect', message: `Connecting to ${host}`, done: 0, total: 0 });
    await client.connect();
    await client.login();

    progress({ phase: 'select', message: `Opening ${mailbox}`, done: 0, total: 0 });
    await client.select(mailbox);

    const since = imapDate(new Date(Date.now() - Math.max(0, sinceDays) * 86_400_000));
    progress({ phase: 'search', message: `Looking for mail since ${since}`, done: 0, total: 0 });
    let uids;
    try {
      uids = await client.search(['SINCE', since]);
    } catch {
      // A server that rejects SINCE is rare but real. Falling back to the whole
      // mailbox and keeping the highest `limit` UIDs still yields the newest
      // messages — it just costs more to get there.
      uids = await client.search(['ALL']);
    }
    uids.sort((a, b) => b - a);
    if (uids.length > limit) uids = uids.slice(0, limit);
    if (uids.length === 0) {
      progress({ phase: 'done', message: 'No recent mail', done: 0, total: 0 });
      return [];
    }

    progress({ phase: 'headers', message: `Reading ${uids.length} headers`, done: 0, total: uids.length });
    const cheap = await client.fetch(
      uids,
      `UID FLAGS INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})]`,
    );

    const records = new Map();
    const byPart = new Map();
    for (const row of cheap) {
      if (!Number.isInteger(row.uid)) continue;
      const record = buildRecord(row, mailbox);
      records.set(row.uid, record);
      const key = record.bodyPart || 'TEXT';
      if (!byPart.has(key)) byPart.set(key, []);
      byPart.get(key).push(row.uid);
    }
    progress({ phase: 'headers', message: `Read ${records.size} headers`, done: records.size, total: uids.length });

    let done = 0;
    const total = records.size;
    for (const [part, partUids] of byPart) {
      const rows = await client.fetch(partUids, `UID BODY.PEEK[${part}]`);
      for (const row of rows) {
        const record = records.get(row.uid);
        if (!record) continue;
        const buf = row.sections.get(normalizeSection(part));
        if (buf) applyBody(record, buf);
      }
      done += partUids.length;
      progress({ phase: 'bodies', message: `Read ${done} of ${total} messages`, done, total });
    }

    const messages = [...records.values()].map(finishRecord);
    messages.sort((a, b) => (instant(b.date) ?? 0) - (instant(a.date) ?? 0) || b.uid - a.uid);
    progress({ phase: 'done', message: `${messages.length} messages`, done: messages.length, total: messages.length });
    return messages;
  } finally {
    try {
      await client.logout();
    } catch {
      // A failed logout tells us nothing we can act on; the close below is what matters.
    }
    await client.close();
  }
}

function buildRecord(row, mailbox) {
  const headerBytes = pickHeaderSection(row.sections);
  const headers = parseHeaders(headerBytes);
  const first = (name) => (headers.get(name) || [''])[0] || '';

  const parts = row.structure ? structureParts(row.structure) : [];
  const chosen = chooseTextPart(parts);
  const messageId = stripAngles(first('message-id'));
  const inReplyTo = stripAngles(first('in-reply-to'));
  const references = (headers.get('references') || [])
    .join(' ')
    .match(/<[^<>]*>/g)
    ?.map(stripAngles) ?? [];
  const subject = decodeWords(first('subject')).replace(/\s+/g, ' ').trim();

  return {
    uid: row.uid,
    messageId,
    inReplyTo,
    references,
    threadKey: threadKeyFor({ messageId, inReplyTo, references, subject }),
    from: parseAddressList(first('from'))[0] || { name: '', email: '' },
    to: parseAddressList(first('to')),
    cc: parseAddressList(first('cc')),
    subject,
    date: parseDate(first('date')) || parseDate(row.internalDate),
    snippet: '',
    text: '',
    hasAttachments: hasAttachmentParts(parts, chosen),
    flags: row.flags,
    folder: mailbox,
    bodyPart: chosen ? chosen.part : 'TEXT',
    bodyEncoding: chosen ? chosen.encoding : '7bit',
    bodyCharset: chosen ? chosen.charset : null,
    bodyIsHtml: chosen ? chosen.subtype === 'html' : false,
  };
}

function pickHeaderSection(sections) {
  for (const [key, value] of sections) {
    if (key.startsWith('HEADER')) return value;
  }
  return Buffer.alloc(0);
}

function applyBody(record, buf) {
  const decoded = decodeCharset(decodeTransfer(buf, record.bodyEncoding), record.bodyCharset);
  record.text = record.bodyIsHtml ? htmlToText(decoded) : normalizeText(decoded);
}

function finishRecord(record) {
  const { bodyPart, bodyEncoding, bodyCharset, bodyIsHtml, ...message } = record;
  message.snippet = record.text.replace(/\s+/g, ' ').trim().slice(0, 240);
  return message;
}

function normalizeText(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function stripAngles(value) {
  return String(value ?? '').trim().replace(/^</, '').replace(/>$/, '').trim();
}

/* ================================================================== *
 * 8. Setup helpers
 * ================================================================== */

/**
 * Response codes (RFC 5530, plus THROTTLED) a server uses to say a refused
 * AUTHENTICATE is its own temporary trouble, not the credential's. Anything
 * else — AUTHENTICATIONFAILED, EXPIRED, or Microsoft's bare `NO AUTHENTICATE
 * failed.` — means the sign-in itself was turned down.
 */
const TRANSIENT_AUTH_CODES = new Set(['UNAVAILABLE', 'INUSE', 'SERVERBUG', 'LIMIT', 'THROTTLED']);

/**
 * What a sign-in the server will no longer accept should say: the one action
 * that fixes it first, then the server's own words for whoever wants them.
 * `err.reconnect` marks these — a refused XOAUTH2 token, a refresh the provider
 * turned down, an account with no grant on this machine — and "check your
 * password" or a raw `AUTHENTICATE XOAUTH2 failed` helps nobody holding one.
 * The server's words have already been through `#error`, which strikes our own
 * credentials out of them.
 */
export function reconnectMessage(err) {
  const said = err?.message ? ` (${err.message})` : '';
  return `This account's sign-in is no longer accepted. Sign in again in Settings → Email.${said}`;
}

/**
 * Connect, authenticate, list. Never throws — the UI wants the reason, not a stack.
 *
 * The OAuth account is tested the same way it is swept, which is the point:
 * minting the token is where most of these accounts fail, so a "Test the
 * connection" that skipped it would report success on an account the 07:00 sweep
 * cannot open. `reconnect` comes back alongside `error` so the button can say
 * "connect this account again" instead of "check your password".
 */
export async function testConnection({
  host, port, secure, user, pass, auth = null, oauth = null, accessToken = '',
  requireTls = null, timeoutMs, logger,
} = {}) {
  let client;
  try {
    const method = resolveAuthMethod(auth, accessToken);
    let bearer = accessToken;
    if (method === 'xoauth2' && !bearer) {
      ({ accessToken: bearer } = await accessTokenFor({ ...(oauth || {}) }));
    }
    client = new ImapClient({
      host, port, secure, user, pass, requireTls, timeoutMs, logger,
      auth: method,
      accessToken: bearer,
    });
  } catch (err) {
    return {
      ok: false, capabilities: [], mailboxes: [], error: err.reconnect === true ? reconnectMessage(err) : err.message, reconnect: err.reconnect === true,
    };
  }
  try {
    await client.connect();
    await client.login();
    const capabilities = [...(await client.capabilities())].sort();
    const mailboxes = await client.listMailboxes();
    // A logout that fails after everything else worked is not a failed test.
    await client.logout().catch(() => {});
    return { ok: true, capabilities, mailboxes, error: null, reconnect: false };
  } catch (err) {
    return {
      ok: false, capabilities: [], mailboxes: [], error: err.reconnect === true ? reconnectMessage(err) : err.message, reconnect: err.reconnect === true,
    };
  } finally {
    await client.close();
  }
}

const APP_PASSWORD_NOTE =
  'This provider will not take your normal password from a program like Zelos. Make a special app password in your account’s security settings and paste that instead. (For experts: ordinary passwords are refused over IMAP.)';

/*
 * `appPasswordUrl` is the page where the user CREATES an app password — not a
 * help article about them. Every one was fetched and answered 200 (through
 * the provider's sign-in redirect, where there is one) on 2026-08-22; the
 * simple mail form puts it behind its one button, so a dead link here is the
 * first thing a new user meets. `label` is what that form calls the provider.
 * Two providers carry no page: Microsoft's personal domains have no password
 * of any kind (`auth: 'xoauth2'`) and Proton goes through Bridge
 * (`bridge: true`).
 */
const PROVIDERS = [
  {
    domains: ['gmail.com', 'googlemail.com'],
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    /* `signIn` is the one-button path and `auth` stays `password`: a Gmail
       account still takes an app password, and a person who would rather not
       sign in through a browser keeps that door. Microsoft's personal domains
       have no such door, which is why that row says `auth: 'xoauth2'`. */
    signIn: 'google',
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    note: `"Sign in with Google" connects this mailbox in one step. If you would rather use a password: Gmail requires 2-Step Verification plus a 16-character App Password (myaccount.google.com → Security → App passwords). ${APP_PASSWORD_NOTE}`,
  },
  {
    domains: ['icloud.com', 'me.com', 'mac.com'],
    label: 'iCloud Mail',
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    // App-Specific Passwords live under Sign-In and Security on this page.
    appPasswordUrl: 'https://account.apple.com/account/manage',
    note: `iCloud Mail requires an app-specific password (appleid.apple.com → Sign-In and Security). ${APP_PASSWORD_NOTE}`,
  },
  {
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com'],
    label: 'Yahoo Mail',
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    appPasswordUrl: 'https://login.yahoo.com/myaccount/security/app-password',
    note: `Yahoo requires an app password (Account Security → Generate app password). ${APP_PASSWORD_NOTE}`,
  },
  {
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com'],
    label: 'Outlook / Microsoft',
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: 'xoauth2',
    signIn: 'microsoft',
    appPasswordUrl: null,
    /* Written in the past tense on purpose. The previous version of this note
       said Microsoft "is retiring" password IMAP and suggested an app password
       if two-step verification was on — a sentence that had been false for
       eleven months by the time anyone read it, and that sent every one of these
       users to generate an app password Microsoft would refuse. Basic auth for
       personal Outlook, Hotmail, Live and MSN ended on 16 September 2024 and
       app passwords went with it: there is no password of any kind that opens
       an IMAP session on these accounts now. */
    note: 'Hotmail and Outlook.com need a one-time setup at Microsoft’s website first (about ten minutes) — the app shows you every step. After that, press "Sign in with Microsoft" and type the short code Zelos gives you at microsoft.com/devicelogin. There is no password to paste: Microsoft switched password sign-in off for personal Outlook, Hotmail, Live and MSN accounts on 16 September 2024, and app passwords no longer work either. A work or school account may still allow a password if your administrator has left IMAP on.',
  },
  {
    domains: ['fastmail.com', 'fastmail.fm', 'messagingengine.com'],
    label: 'Fastmail',
    host: 'imap.fastmail.com',
    port: 993,
    secure: true,
    appPasswordUrl: 'https://app.fastmail.com/settings/security/devicekeys',
    note: 'Fastmail needs a special app password made just for Zelos — when you make it, choose the "Mail (IMAP)" kind (Settings → Privacy & Security → App passwords).',
  },
  {
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    label: 'Proton Mail',
    host: '127.0.0.1',
    port: 1143,
    secure: false,
    bridge: true,
    appPasswordUrl: null,
    note: 'Proton Mail works through Proton Bridge, a program from Proton that runs on this computer. Use the host, port and password Bridge shows you — not your Proton account password. (Proton encrypts mail on its servers, so Bridge is the only way in over IMAP.)',
  },
  {
    domains: ['aol.com'],
    label: 'AOL Mail',
    host: 'imap.aol.com',
    port: 993,
    secure: true,
    appPasswordUrl: 'https://login.aol.com/myaccount/security/app-password',
    note: `AOL requires an app password. ${APP_PASSWORD_NOTE}`,
  },
  {
    domains: ['zoho.com', 'zohomail.com'],
    label: 'Zoho Mail',
    host: 'imap.zoho.com',
    port: 993,
    secure: true,
    appPasswordUrl: 'https://accounts.zoho.com/home#security/app_password',
    note: 'Zoho needs a switch turned on first: in Zoho Mail’s settings, enable IMAP access. If two-factor sign-in is on, it also needs a special app password made just for Zelos.',
  },
];

/**
 * Best guess at a mail host from an address.
 *
 * The `note` is load-bearing, not decoration: Gmail, iCloud and Yahoo all
 * reject the password a person actually knows, and without being told why,
 * every one of those users concludes the app is broken.
 */
export function guessImapHost(email) {
  const address = String(email ?? '').trim().toLowerCase();
  const domain = address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : '';
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return {
      host: '',
      port: 993,
      secure: true,
      note: 'Enter your full email address and Zelos will suggest a server, or type your provider\'s IMAP host directly.',
    };
  }

  for (const provider of PROVIDERS) {
    if (provider.domains.includes(domain)) {
      return { host: provider.host, port: provider.port, secure: provider.secure, note: provider.note };
    }
  }

  return {
    host: `imap.${domain}`,
    port: 993,
    secure: true,
    note: `Guessed from your address. If imap.${domain} is wrong, your provider's help pages list the correct IMAP server. Many providers also require an app-specific password rather than your normal one.`,
  };
}

/**
 * Everything the simple mail form needs to know about an address, in one
 * answer: what to call the provider, where to connect, how it signs in, and
 * the page where its app password is made.
 *
 * `guessImapHost` answers "which server"; this answers "what happens next".
 * `auth` is the branch the form takes — `password` pastes an app password,
 * `xoauth2` is Microsoft's device sign-in, `bridge` means Proton Bridge on
 * this machine and the full form. An address nobody here recognises gets the
 * same guess `guessImapHost` makes, marked `known: false` so the form can say
 * it is guessing and put the full form within reach; its label is the domain,
 * because that is the only name there is.
 */
export function describeProvider(email) {
  const address = String(email ?? '').trim().toLowerCase();
  const domain = address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : '';
  const provider = domain ? PROVIDERS.find((p) => p.domains.includes(domain)) : null;
  if (provider) return answerFor(provider);
  const guess = guessImapHost(email);
  return {
    // No host means no usable domain — there is nothing to name.
    label: guess.host ? domain : '',
    host: guess.host,
    port: guess.port,
    secure: guess.secure,
    auth: 'password',
    signIn: null,
    appPasswordUrl: null,
    note: guess.note,
    known: false,
  };
}

/**
 * The simple form's answer for one row of PROVIDERS.
 *
 * `signIn` names the browser sign-in the form can offer — `google` or
 * `microsoft` — and is null for every provider that has only a password. It
 * is a separate field from `auth` because the two answer different questions:
 * `auth` is what the account will be saved as if the person types a password,
 * `signIn` is the button that spares them one.
 */
function answerFor(provider) {
  return {
    label: provider.label,
    host: provider.host,
    port: provider.port,
    secure: provider.secure,
    auth: provider.bridge ? 'bridge' : (provider.auth || 'password'),
    signIn: provider.signIn || null,
    appPasswordUrl: provider.appPasswordUrl || null,
    note: provider.note,
    known: true,
  };
}

/**
 * Who hosts a domain's mail, read off the domain's lowest-priority MX.
 *
 * A custom domain on Google Workspace or Microsoft 365 is the commonest
 * mailbox there is for anyone with a business, and PROVIDERS cannot list it:
 * the domain is theirs, not Google's. What the domain does publish is where
 * its mail is delivered, and that exchange carries the host's name —
 * `aspmx.l.google.com` for Workspace, `*.mail.protection.outlook.com` for 365
 * — so the suffix is enough to name the provider. Each row points at a
 * PROVIDERS entry by its `host`, and the host, port, sign-in and app-password
 * page are that entry's; only the label and, where the note would otherwise
 * talk about a consumer mailbox, the note are this table's own.
 *
 * Suffixes checked live on 2026-08-22: a Workspace domain → `aspmx.l.google.com`
 * (`alt1.`–`alt4.` behind it), microsoft.com →
 * `microsoft-com.mail.protection.outlook.com`, fastmail.com → an
 * `in1-….messagingengine.com` host, zoho.com → an inbound host under
 * `.zoho.com` (customer domains get `mx.zoho.com`, hence the whole suffix),
 * proton.me → `mail.protonmail.ch`.
 */
const MX_HOSTS = [
  {
    suffixes: ['.google.com', '.googlemail.com'],
    host: 'imap.gmail.com',
    label: 'Google Workspace',
    note: (entry) => `Your domain's mail is hosted by Google, so this is Gmail underneath. ${entry.note}`,
  },
  {
    suffixes: ['.mail.protection.outlook.com'],
    host: 'outlook.office365.com',
    label: 'Microsoft 365',
    note: () => 'Your domain\'s mail is hosted by Microsoft 365. Work and school accounts connect with "Sign in with Microsoft" — a one-time setup at Microsoft’s website first (about ten minutes; the app shows you every step), then a short code to type at microsoft.com/devicelogin. Some tenants still allow a password, if your administrator has left IMAP on; Advanced is where that goes.',
  },
  { suffixes: ['.messagingengine.com'], host: 'imap.fastmail.com' },
  { suffixes: ['.zoho.com', '.zoho.eu'], host: 'imap.zoho.com' },
  { suffixes: ['.protonmail.ch'], host: '127.0.0.1' },
  { suffixes: ['.mail.icloud.com'], host: 'imap.mail.me.com' },
  { suffixes: ['.yahoodns.net'], host: 'imap.mail.yahoo.com' },
];

const DOMAIN_SHAPE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** A DNS answer, or a rejection once `ms` has passed — and the timer is always cleared. */
function withTimeout(work, ms) {
  let timer = null;
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([Promise.resolve().then(work), clock]).finally(() => clearTimeout(timer));
}

/** A host name off the wire, lower-cased and without its trailing dot — or '' if it is not one. */
function hostName(value) {
  const name = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN_SHAPE.test(name) ? name : '';
}

/**
 * `describeProvider`, and then the domain's own records for a domain nobody
 * here knows.
 *
 * Three answers, in order. PROVIDERS first, with no lookup at all — a Gmail
 * address has nothing to ask DNS about. Then the domain's MX, matched against
 * MX_HOSTS, which is how a Workspace or 365 domain comes back `known: true`
 * with the right host, sign-in and app-password page instead of
 * `imap.<domain>` and a refusal. Then the SRV record RFC 6186 lets a domain
 * publish for its own IMAP server, `_imaps._tcp.<domain>`, which stays
 * `known: false` because a host is all it says. Otherwise the same guess
 * `describeProvider` makes. `via` says which — `mx`, `srv` or `guess` — so
 * the form can say how it knows.
 *
 * Only the DOMAIN goes to the resolver, never the address, and the resolver
 * is the system's: MX and SRV are public records, and this is the one
 * moment at which Zelos asks about a name you did not type as a host. A
 * resolver that errors, answers NODATA, or takes longer than `timeoutMs`
 * makes this the guess it would have been anyway — nothing is thrown and
 * nothing is logged, at any level, because the one thing to log would be
 * the domain.
 */
export async function discoverProvider(email, {
  resolveMx = dns.promises.resolveMx,
  resolveSrv = dns.promises.resolveSrv,
  timeoutMs = 3000,
} = {}) {
  const described = describeProvider(email);
  if (described.known) return described;
  const fallback = { ...described, via: 'guess' };
  if (!described.host) return fallback;

  const address = String(email ?? '').trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (!DOMAIN_SHAPE.test(domain)) return fallback;

  try {
    const records = await withTimeout(() => resolveMx(domain), timeoutMs);
    const exchanges = (Array.isArray(records) ? records : [])
      .map((r) => ({ priority: Number(r?.priority) || 0, exchange: hostName(r?.exchange) }))
      .filter((r) => r.exchange)
      .sort((a, b) => a.priority - b.priority);
    const exchange = exchanges[0]?.exchange;
    if (exchange) {
      const row = MX_HOSTS.find((m) => m.suffixes.some((suffix) => exchange.endsWith(suffix)));
      const entry = row ? PROVIDERS.find((p) => p.host === row.host) : null;
      if (entry) {
        const answer = answerFor(entry);
        return {
          ...answer,
          label: row.label ?? answer.label,
          note: row.note ? row.note(entry) : `Your domain's mail is hosted by ${answer.label}. ${answer.note}`,
          known: true,
          via: 'mx',
          mx: exchange,
        };
      }
    }
  } catch {
    /* ENOTFOUND, ENODATA, a refusing resolver, a slow one: the guess below. */
  }

  try {
    const records = await withTimeout(() => resolveSrv(`_imaps._tcp.${domain}`), timeoutMs);
    const targets = (Array.isArray(records) ? records : [])
      .map((r) => ({ priority: Number(r?.priority) || 0, host: hostName(r?.name), port: Number(r?.port) }))
      // RFC 2782: a target of "." means the service is deliberately absent.
      .filter((r) => r.host)
      .sort((a, b) => a.priority - b.priority);
    const target = targets[0];
    if (target) {
      const port = Number.isInteger(target.port) && target.port > 0 && target.port < 65536 ? target.port : 993;
      return {
        label: domain,
        host: target.host,
        port,
        secure: true,
        auth: 'password',
        signIn: null,
        appPasswordUrl: null,
        note: `Your domain advertises an IMAP server (${target.host}:${port}) — Connect will tell you if it answers. Many providers want an app-specific password rather than your normal one.`,
        known: false,
        via: 'srv',
      };
    }
  } catch {
    /* Same as above. */
  }

  return fallback;
}
