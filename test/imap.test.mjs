import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The environment has to be set before the modules that read it are evaluated,
   which is why the imports below are dynamic and these three lines are not.
   `core/log.mjs` fixes its level at import time, and — since the XOAUTH2 work —
   `core/sources/imap.mjs` reaches `core/secrets.mjs` to keep a refresh token, so
   an unforced backend would detect and use the operator's own login keychain no
   matter where ZELOS_HOME points. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-imap-test-'));
process.env.ZELOS_HOME = home;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';

/* ------------------------------------------------------- outbound guard
 *
 * The token half of this file talks HTTP, and every endpoint it talks to has to
 * be a mock on 127.0.0.1. Wrapping `fetch` for the whole run is what makes that
 * a fact rather than an intention: if an edit forgets to pass an explicit
 * endpoint and falls back to login.microsoftonline.com, this suite says so
 * instead of dialling Microsoft from whatever machine is running it. */
const realFetch = globalThis.fetch;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
  const url = new URL(raw);
  if (!LOOPBACK.test(url.hostname)) {
    throw new Error(`this suite must not contact ${url.host} — every endpoint has to be a local mock`);
  }
  return realFetch(input, init);
};

const {
  ImapClient,
  ImapOAuthError,
  MS_IMAP_SCOPES,
  MS_LOGIN_ORIGIN,
  GOOGLE_TOKEN_ORIGIN,
  accessTokenFor,
  assertGoogleTokenEndpoint,
  assertTokenEndpoint,
  normalizeGoogleClientId,
  beginDeviceAuthorization,
  connectDeviceCode,
  describeProvider,
  describeXOAuth2Challenge,
  discoverProvider,
  fetchRecent,
  guessImapHost,
  isLoopbackHost,
  loadOAuthTokens,
  normalizeClientId,
  normalizeTenant,
  pollForDeviceToken,
  refreshAccessToken,
  resolveAuthMethod,
  saveOAuthTokens,
  testConnection,
  tlsRequiredByDefault,
  xoauth2Payload,
  READ_ONLY_COMMANDS,
  assertReadOnlyCommand,
} = await import('../core/sources/imap.mjs');

const { getSecret, setSecret, deleteSecret } = await import('../core/secrets.mjs');

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/* ================================================================== *
 * A mock IMAP server.
 *
 * It speaks real IMAP over a real socket on 127.0.0.1 — no stubbing of the
 * client's internals — and records every line the client sends so tests can
 * assert on what actually went over the wire.
 * ================================================================== */

const DEFAULT_GREETING = '* OK [CAPABILITY IMAP4rev1] Zelos mock ready';

function startMockImap({ greeting = DEFAULT_GREETING, onCommand }) {
  const received = [];
  const sockets = new Set();
  // Connections, not lines: "did the client dial this host at all" is a
  // different question from "what did it say", and cancellation turns on it.
  const connections = [];

  const server = net.createServer((socket) => {
    connections.push(Date.now());
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {}); // a client that hangs up mid-test is not a failure
    socket.on('close', () => sockets.delete(socket));
    if (greeting) socket.write(`${greeting}\r\n`);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        received.push(line);

        const parts = line.split(' ');
        let verb = (parts[1] || '').toUpperCase();
        let argStart = 2;
        if (verb === 'UID') {
          verb = `UID ${(parts[2] || '').toUpperCase()}`;
          argStart = 3;
        }
        onCommand({
          line,
          tag: parts[0] || '',
          verb,
          args: parts.slice(argStart).join(' '),
          socket,
          send: (text) => socket.write(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')),
        });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        connections,
        async close() {
          for (const socket of sockets) socket.destroy();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

/** Handles the boilerplate every session needs; `extra` answers the rest. */
function session({ capability = 'IMAP4rev1', exists = 3, extra }) {
  return (ctx) => {
    const { tag, verb, send } = ctx;
    switch (verb) {
      case 'CAPABILITY':
        send(`* CAPABILITY ${capability}\r\n${tag} OK CAPABILITY completed\r\n`);
        return;
      case 'LOGIN':
        send(`${tag} OK LOGIN completed\r\n`);
        return;
      case 'EXAMINE':
      case 'SELECT':
        send(
          `* ${exists} EXISTS\r\n` +
            '* OK [UIDVALIDITY 1234567890] UIDs valid\r\n' +
            '* OK [UIDNEXT 9001] Predicted next UID\r\n' +
            '* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n' +
            `${tag} OK [READ-ONLY] EXAMINE completed\r\n`,
        );
        return;
      case 'LOGOUT':
        send(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`);
        return;
      default:
        if (extra && extra(ctx)) return;
        send(`${tag} BAD unexpected command in mock\r\n`);
    }
  };
}

/** `* n FETCH (… BODY[section] {len}\r\n<payload>)` as exact bytes. */
function fetchLine({ seq, uid, items = '', section, payload }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([
    Buffer.from(`* ${seq} FETCH (UID ${uid}${items ? ` ${items}` : ''} BODY[${section}] {${body.length}}\r\n`, 'utf8'),
    body,
    Buffer.from(')\r\n', 'utf8'),
  ]);
}

const HEADER_SECTION = 'HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID)';

/**
 * Answers UID SEARCH and both UID FETCH passes from a list of fixtures.
 * Each fixture: {uid, flags, internalDate, structure, headers, parts:{[n]:payload}}
 */
function mailbox(messages, { write = (send, buf) => send(buf) } = {}) {
  const byUid = new Map(messages.map((m) => [String(m.uid), m]));
  return ({ tag, verb, args, send }) => {
    if (verb === 'UID SEARCH') {
      send(`* SEARCH ${messages.map((m) => m.uid).join(' ')}\r\n${tag} OK UID SEARCH completed\r\n`);
      return true;
    }
    if (verb !== 'UID FETCH') return false;

    const set = args.slice(0, args.indexOf('(')).trim().split(',').filter(Boolean);
    const wanted = set.map((uid) => byUid.get(uid)).filter(Boolean);
    const spec = args.slice(args.indexOf('('));

    if (spec.includes('BODYSTRUCTURE')) {
      wanted.forEach((m, i) => {
        write(send, fetchLine({
          seq: i + 1,
          uid: m.uid,
          items: `FLAGS (${m.flags ?? '\\Seen'}) INTERNALDATE "${m.internalDate}" BODYSTRUCTURE ${m.structure}`,
          section: HEADER_SECTION,
          payload: m.headers,
        }));
      });
    } else {
      const part = /BODY\.PEEK\[([^\]]*)\]/.exec(spec)?.[1] ?? '1';
      wanted.forEach((m, i) => {
        const payload = m.parts?.[part];
        if (payload === undefined) return;
        write(send, fetchLine({ seq: i + 1, uid: m.uid, section: part, payload }));
      });
    }
    send(`${tag} OK UID FETCH completed\r\n`);
    return true;
  };
}

const PLAIN_TEXT_STRUCTURE = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 120 4 NIL NIL NIL NIL)';

/** Every command line the client sent, minus its tag. */
function commands(received) {
  return received.map((line) => line.replace(/^\S+\s*/, ''));
}

async function withServer(options, fn) {
  const server = await startMockImap(options);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

/* ================================================================== *
 * Literals
 * ================================================================== */

test('a literal carrying CRLF, ")" and a fake literal marker is parsed intact', async () => {
  const headers = [
    'From: "Reyes, Marcus" <marcus@riverstone.example>',
    'To: Nemo Hale <nemo@northgate.example>, "Roe, Jane" <jane@aldervance.example>',
    'Subject: Re: change order (final) ) and a stray paren',
    'X-Decoy: this line ends with what looks like a literal {7}',
    'Date: Fri, 08 Aug 2026 09:15:00 -0400',
    'Message-ID: <a1@riverstone.example>',
    'In-Reply-To: <root@aldervance.example>',
    'References: <root@aldervance.example> <a0@riverstone.example>',
    '',
    '',
  ].join('\r\n');

  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 101,
            internalDate: '08-Aug-2026 09:15:00 -0400',
            structure: PLAIN_TEXT_STRUCTURE,
            headers,
            parts: { 1: 'Numbers are firm.\r\n\r\nThanks,\r\nMarcus\r\n' },
          },
        ]),
      }),
    },
    async ({ port, received }) => {
      const messages = await fetchRecent({
        host: '127.0.0.1', port, secure: false, user: 'nemo', pass: 'pw', timeoutMs: 5000,
      });

      assert.equal(messages.length, 1);
      const [msg] = messages;
      assert.equal(msg.subject, 'Re: change order (final) ) and a stray paren');
      assert.deepEqual(msg.from, { name: 'Reyes, Marcus', email: 'marcus@riverstone.example' });
      assert.deepEqual(msg.to, [
        { name: 'Nemo Hale', email: 'nemo@northgate.example' },
        { name: 'Roe, Jane', email: 'jane@aldervance.example' },
      ]);
      assert.equal(msg.date, '2026-08-08T09:15:00-04:00');
      assert.equal(msg.messageId, 'a1@riverstone.example');
      assert.deepEqual(msg.references, ['root@aldervance.example', 'a0@riverstone.example']);
      assert.equal(msg.threadKey, 'root@aldervance.example');
      assert.equal(msg.text, 'Numbers are firm.\n\nThanks,\nMarcus');
      assert.equal(msg.snippet, 'Numbers are firm. Thanks, Marcus');
      assert.equal(msg.folder, 'INBOX');
      assert.deepEqual(msg.flags, ['\\Seen']);
      assert.equal(msg.hasAttachments, false);

      // The decoy "{7}" inside the literal must not have been read as a length.
      assert.ok(commands(received).some((c) => c === 'LOGOUT'), 'the session ran to completion');
    },
  );
});

test('a literal that opens with a space and closes with one keeps every byte', async () => {
  // Whitespace is how the tokenizer separates values, so a literal payload that
  // starts with a space is the case where an over-eager parser eats data.
  const payload = ' )not the end\r\nstill inside the literal ';
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'UID FETCH') return false;
          const body = Buffer.from(payload, 'utf8');
          send(Buffer.concat([
            Buffer.from(`* 1 FETCH (UID 9 BODY[TEXT] {${body.length}}\r\n`, 'utf8'),
            body,
            Buffer.from(` FLAGS (\\Answered \\Seen))\r\n${tag} OK UID FETCH completed\r\n`, 'utf8'),
          ]));
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();
      const [row] = await client.fetch([9], 'UID BODY.PEEK[TEXT]');
      assert.equal(row.uid, 9);
      assert.equal(row.sections.get('TEXT').toString('utf8'), payload);
      assert.deepEqual(row.flags, ['\\Answered', '\\Seen'], 'parsing resumed after the literal');
      await client.close();
    },
  );
});

test('a zero-length literal is kept as an empty value so FETCH pairing holds', async () => {
  // "{0}" is a legal literal — an empty body part, say — and it is still a
  // value. Dropping it shifts every FETCH item after it onto the wrong key,
  // which is how this exact wire once parsed UID 9 into uid null.
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'UID FETCH') return false;
          send(`* 1 FETCH (BODY[1] {0}\r\n UID 9)\r\n${tag} OK UID FETCH completed\r\n`);
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();
      const [row] = await client.fetch([9], 'UID BODY.PEEK[1]');
      assert.equal(row.uid, 9, 'the UID that follows the empty literal must not shift into its slot');
      const section = row.sections.get('1');
      assert.ok(Buffer.isBuffer(section), 'the empty literal is a value, not a hole');
      assert.equal(section.length, 0);
      await client.close();
    },
  );
});

test('HEADER.FIELDS matching nothing comes back as {0} and pairs cleanly', async () => {
  // A message with none of the requested headers is served as a zero-length
  // literal; the items after it must still land on their own keys.
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'UID FETCH') return false;
          send(`* 1 FETCH (BODY[HEADER.FIELDS (X-NOPE)] {0}\r\n UID 12 FLAGS (\\Seen))\r\n${tag} OK UID FETCH completed\r\n`);
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();
      const [row] = await client.fetch([12], 'UID FLAGS BODY.PEEK[HEADER.FIELDS (X-NOPE)]');
      assert.equal(row.uid, 12);
      assert.deepEqual(row.flags, ['\\Seen'], 'FLAGS pairs with its own list, not a shifted neighbour');
      const section = row.sections.get('HEADER.FIELDS (X-NOPE)');
      assert.ok(Buffer.isBuffer(section));
      assert.equal(section.length, 0);
      await client.close();
    },
  );
});

test('REGRESSION: a flood of zero-length literals is refused instead of eaten', async () => {
  // A `{0}\r\n` marker costs six bytes on the wire and buys an entry in both
  // of the assembler's arrays while leaving its byte counter at zero, so the
  // 96 MB cap — which reads that counter — never saw this coming. A hostile
  // server streaming nothing but markers took the real client to 464 MB rss
  // and a fatal V8 out-of-memory in about a second and a half, during the
  // pre-auth CAPABILITY, with no credentials involved. An OOM cannot be
  // caught, so the only fix that counts is one that refuses the response.
  //
  // 80,000 markers is 480 KB on the wire and 160,000 pieces — past the cap,
  // and small enough that the *unfixed* client survives long enough to fail
  // this test by timing out rather than by killing the test runner.
  const flood = Buffer.from('{0}\r\n'.repeat(80_000), 'latin1');

  await withServer(
    {
      // No [CAPABILITY] in the greeting, so the client has to ask — which puts
      // the flood inside connect(), before a password exists anywhere.
      greeting: '* OK Zelos mock ready',
      onCommand: ({ verb, send }) => {
        if (verb === 'CAPABILITY') {
          send(flood); // …and never a tagged completion
          return;
        }
        send('* BAD nothing else should be reached\r\n');
      },
    },
    async ({ port, received }) => {
      // A password with no substring in common with the guard's own message —
      // otherwise a redaction bug would fail this test under a literals name.
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'qqqqqqqq', timeoutMs: 1500 });
      await assert.rejects(
        () => client.connect(),
        (err) => {
          assert.match(err.message, /number of pieces/, 'refused for its shape, not by the idle timer');
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          return true;
        },
      );
      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)), 'this happens before any credential');
      await client.close();
    },
  );
});

test('REGRESSION: a flood of complete untagged responses is refused instead of eaten', async () => {
  // The sibling of the `{0}` flood above, and the one the assembler cannot see.
  // Every path in the assembler that emits a complete response resets its
  // segments, its literals and its byte counter, so a server sending nothing
  // but well-formed untagged lines trips neither of its two caps — it hands
  // them off one at a time to the in-flight job's `untagged` array, which had
  // no cap at all and only empties when the tagged completion arrives. A
  // hostile server never sends one.
  //
  // Measured against the real client with the real socket, at `--max-old-space
  // -size=400`: a server answering the pre-auth CAPABILITY with
  // `* OK <1 KB>\r\n` forever drove rss 231 -> 343 -> 452 -> 491 MB and then
  // `FATAL ERROR: ... JavaScript heap out of memory` at 1.75 s. Same harm as
  // the `{0}` flood, same absence of credentials, and an OOM is still not
  // catchable. With the cap in place the same server is refused at 265 ms.
  //
  // Six bytes per response is the cheapest way to reach the 50,000 cap: 300 KB
  // on the wire, and about 18 MB held by the client before it refuses (a
  // parsed untagged response retains ~372 bytes however short its text is,
  // which is exactly why the cap counts responses and not only their bytes).
  const flood = Buffer.from('* OK\r\n'.repeat(50_001), 'latin1');

  await withServer(
    {
      // As above: no [CAPABILITY] in the greeting puts the flood inside
      // connect(), before a password exists anywhere.
      greeting: '* OK Zelos mock ready',
      onCommand: ({ verb, send }) => {
        if (verb === 'CAPABILITY') {
          send(flood); // …and never a tagged completion
          return;
        }
        send('* BAD nothing else should be reached\r\n');
      },
    },
    async ({ port, received }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'qqqqqqqq', timeoutMs: 1500 });
      await assert.rejects(
        () => client.connect(),
        (err) => {
          assert.match(
            err.message,
            /more untagged responses to one command than Zelos will buffer/,
            'refused for its shape, not by the idle timer',
          );
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          return true;
        },
      );
      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)), 'this happens before any credential');
      await client.close();
    },
  );
});

test('the byte cap on untagged responses refuses a flood of few but enormous ones', async () => {
  /* The count cap above and this one are not the same guard, and the count cap
     cannot stand in for it: 50,000 responses is a lot of small ones, and a
     server that sends FIFTY of two megabytes each never approaches it while
     handing the client a hundred megabytes to hold. `job.untaggedBytes` is the
     only thing standing between that and the heap.

     Neither direction of this branch had a test — the string it fails with
     appeared in production code and nowhere else — which mattered because the
     cap was added late and its threshold is the one number here that a real,
     legitimate mailbox could conceivably reach.

     2 MB x 49 stays under, and the 50th crosses; a tagged completion is never
     sent, so the only two ways out are the cap and the idle timer, and the
     assertion distinguishes them by message. */
  const chunk = `* OK ${'x'.repeat(2 * 1024 * 1024)}\r\n`;

  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ verb, send }) => {
        if (verb === 'CAPABILITY') {
          for (let i = 0; i < 50; i++) send(chunk);
          return; // …and never a tagged completion
        }
        send('* BAD nothing else should be reached\r\n');
      },
    },
    async ({ port, received }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'qqqqqqqq', timeoutMs: 20_000 });
      await assert.rejects(
        () => client.connect(),
        (err) => {
          assert.match(
            err.message,
            /untagged responses to one command exceeded the maximum size Zelos will buffer/,
            `refused for its size, not by the idle timer or the count cap: ${err.message}`,
          );
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          return true;
        },
      );
      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)),
        'this happens before any credential');
      await client.close();
    },
  );
});

test('a mailbox that is merely large does not trip the byte cap', async () => {
  /* The other direction, and the one that would bite a real person rather than
     an attacker. `fetch()` chunks at 100 UIDs and the sweep pulls a body part
     for each, so a chunk of long messages is ordinary traffic — a cap set too
     low turns a big but honest mailbox into a connection that fails every
     sweep, with an error about buffering that names nothing the user can act
     on. Twenty megabytes across ten responses is comfortably more than a real
     hundred-message header fetch and must still go through. */
  const chunk = `* OK ${'y'.repeat(2 * 1024 * 1024)}\r\n`;

  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'CAPABILITY') {
          for (let i = 0; i < 10; i++) send(chunk);
          send(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'qqqqqqqq', timeoutMs: 20_000 });
      await client.connect();
      const caps = await client.capabilities();
      assert.ok(caps.has('IMAP4REV1'), 'the capability list survived twenty megabytes of chatter');
      await client.close();
    },
  );
});

test('a command whose server is merely chatty still gets every untagged response', async () => {
  // The other half of the cap: it must not truncate. `select()` reads EXISTS
  // out of the untagged pile, so a cap that silently dropped responses would
  // hand the caller a mailbox with the wrong number of messages in it —
  // quieter and worse than a connection that says why it stopped. 4,000
  // untagged lines is an order of magnitude past any real command and an order
  // of magnitude under the cap.
  const chatter = '* OK [ALERT] the server would like a word\r\n'.repeat(4_000);

  await withServer(
    {
      // Written out rather than via session(), whose EXAMINE case is ahead of
      // its `extra` hook and would answer before the chatter could go out.
      onCommand: ({ verb, tag, send }) => {
        if (verb === 'LOGIN') { send(`${tag} OK LOGIN completed\r\n`); return; }
        if (verb === 'EXAMINE') {
          send(`${chatter}* 3 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
          return;
        }
        send(`${tag} BAD unexpected command in mock\r\n`);
      },
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'qqqqqqqq', timeoutMs: 5000 });
      await client.connect();
      await client.login();
      const box = await client.select('INBOX');
      assert.equal(box.exists, 3, 'EXISTS survived 4,000 lines of chatter ahead of it');
      assert.equal(box.uidValidity, 7);
      await client.close();
    },
  );
});

test('an empty search result short-circuits without fetching anything', async () => {
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'UID SEARCH') return false;
          send(`* SEARCH\r\n${tag} OK UID SEARCH completed\r\n`);
          return true;
        },
      }),
    },
    async ({ port, received }) => {
      const messages = await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      assert.deepEqual(messages, []);
      assert.ok(!commands(received).some((c) => c.startsWith('UID FETCH')), 'nothing to fetch, nothing fetched');
    },
  );
});

test('a dropped connection rejects queued commands as well as the in-flight one', async () => {
  await withServer(
    {
      onCommand: session({
        extra: ({ verb, socket }) => {
          if (verb !== 'UID SEARCH') return false;
          socket.destroy();
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();

      // Two commands issued back to back: one goes on the wire, one waits in
      // the queue. Neither may be left hanging when the socket dies.
      const results = await Promise.allSettled([client.search(['ALL']), client.search(['UNSEEN'])]);
      assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
      for (const result of results) {
        assert.match(result.reason.message, /IMAP 127\.0\.0\.1:\d+/);
      }
      await client.close();
    },
  );
});

/* ================================================================== *
 * The commands that go on the wire
 * ================================================================== */

test('the client only ever uses UID commands, BODY.PEEK, and read-only EXAMINE', async () => {
  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 101,
            internalDate: '08-Aug-2026 09:15:00 -0400',
            structure: PLAIN_TEXT_STRUCTURE,
            headers: 'Subject: hello\r\nFrom: a@b.example\r\nDate: Fri, 08 Aug 2026 09:15:00 -0400\r\n\r\n',
            parts: { 1: 'body\r\n' },
          },
        ]),
      }),
    },
    async ({ port, received }) => {
      await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'nemo', pass: 'pw', timeoutMs: 5000 });
      const sent = commands(received);

      // BODY[ without PEEK sets \Seen. It must never appear.
      for (const line of received) {
        assert.ok(!/\bBODY\s*\[/i.test(line), `command marks mail as read: ${line}`);
      }
      assert.ok(sent.some((c) => c.includes('BODY.PEEK[')), 'bodies are fetched with PEEK');

      assert.ok(sent.some((c) => c.startsWith('UID SEARCH ')), 'search is by UID');
      assert.ok(sent.some((c) => c.startsWith('UID FETCH ')), 'fetch is by UID');
      assert.ok(!sent.some((c) => /^(SEARCH|FETCH)\b/.test(c)), 'no sequence-number commands');

      assert.ok(sent.some((c) => c === 'EXAMINE "INBOX"'), 'the mailbox is opened read-only');
      assert.ok(!sent.some((c) => c.startsWith('SELECT ')), 'SELECT would allow \\Seen to be set');

      assert.ok(
        sent.some((c) =>
          /^UID FETCH [\d,]+ \(UID FLAGS INTERNALDATE BODYSTRUCTURE BODY\.PEEK\[HEADER\.FIELDS \(FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-ID\)\]\)$/.test(c)),
        `cheap first pass not as specified: ${sent.join(' | ')}`,
      );
      assert.ok(sent.some((c) => /^UID FETCH [\d,]+ \(UID BODY\.PEEK\[1\]\)$/.test(c)), 'second pass pulls one part');
    },
  );
});

test('fetch() refuses to put a \\Seen-setting BODY[...] on the wire', async () => {
  await withServer({ onCommand: session({}) }, async ({ port, received }) => {
    const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
    await client.connect();
    await client.login();
    await assert.rejects(
      () => client.fetch([1], 'UID BODY[]'),
      /refusing to send BODY\[/,
    );
    assert.ok(!received.some((line) => /\bBODY\s*\[/i.test(line)), 'nothing was sent');
    await client.close();
  });
});

/* ------------------------------------------------------------------ *
 * No write command, ever (TT-3432). docs/VERIFICATION.md tells Google's
 * reviewers that the client never issues STORE, COPY, MOVE, APPEND or EXPUNGE
 * and that the test suite checks it. These three are that check: on the wire
 * for every way the program reads, at the gate every command passes, and over
 * every command the file can issue.
 * ------------------------------------------------------------------ */

const WRITE_VERBS = ['STORE', 'COPY', 'MOVE', 'APPEND', 'EXPUNGE', 'SELECT', 'CREATE', 'DELETE', 'RENAME', 'SUBSCRIBE', 'UNSUBSCRIBE', 'SETACL', 'DELETEACL', 'SETQUOTA', 'SETMETADATA'];

/** The verb of every tagged command on the wire (continuation lines are data). */
function verbsOnTheWire(received) {
  return received
    .filter((line) => /^A\d{4} /.test(line))
    .map((line) => {
      const words = line.split(' ');
      return words[1].toUpperCase() === 'UID' ? `UID ${words[2].toUpperCase()}` : words[1].toUpperCase();
    });
}

function assertOnlyReads(received, label) {
  // Whatever its tag: a line smuggled behind another command need not use ours.
  for (const line of received) {
    assert.doesNotMatch(line, new RegExp(`^\\S+ (?:UID )?(?:${WRITE_VERBS.join('|')})\\b`, 'i'), `${label}: a write command went on the wire: ${line}`);
  }
  const verbs = verbsOnTheWire(received);
  assert.ok(verbs.length > 0, `${label}: nothing was sent, so this proves nothing`);
  for (const verb of verbs) {
    assert.ok(READ_ONLY_COMMANDS.includes(verb), `${label}: ${verb} went on the wire`);
    assert.ok(!WRITE_VERBS.includes(verb.replace(/^UID /, '')), `${label}: a write command, ${verb}, went on the wire`);
  }
  for (const line of received.filter((l) => / UID FETCH /i.test(l))) {
    assert.doesNotMatch(line, /\bBODY\s*\[|\bRFC822(?:\.TEXT)?(?![.\w])/i, `${label}: a fetch that sets \\Seen: ${line}`);
  }
  return verbs;
}

test('no write command reaches the wire on any path the program reads by', async () => {
  const messages = [101, 102, 103].map((uid) => ({
    uid,
    internalDate: '08-Aug-2026 09:15:00 -0400',
    structure: PLAIN_TEXT_STRUCTURE,
    headers: `Subject: m${uid}\r\nFrom: a@b.example\r\nDate: Fri, 08 Aug 2026 09:15:00 -0400\r\n\r\n`,
    parts: { 1: `body ${uid}\r\n` },
  }));
  const seen = new Set();

  // A sweep's read of the inbox and of Sent, by password.
  for (const mailboxName of ['INBOX', 'Sent']) {
    await withServer({ onCommand: session({ extra: mailbox(messages) }) }, async ({ port, received }) => {
      const rows = await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'nemo', pass: 'pw', mailbox: mailboxName, timeoutMs: 5000 });
      assert.equal(rows.length, 3, 'the read did not complete, so its commands are not all here');
      for (const verb of assertOnlyReads(received, `fetchRecent ${mailboxName}`)) seen.add(verb);
    });
  }

  // The same read signed in with XOAUTH2, as a Google or Microsoft account is.
  const token = 'EwBwA8l6BAAUs5-access-token-for-the-read-only-check';
  await withServer({
    greeting: '* OK Zelos mock ready',
    onCommand: xoauth2Session({ user: 'nemo@gmail.com', token, extra: session({ extra: mailbox(messages) }) }),
  }, async ({ port, received }) => {
    const rows = await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'nemo@gmail.com', auth: 'xoauth2', accessToken: token, timeoutMs: 5000 });
    assert.equal(rows.length, 3);
    for (const verb of assertOnlyReads(received, 'fetchRecent xoauth2')) seen.add(verb);
  });

  // Settings' "Test the connection", which also lists the folders.
  await withServer({
    onCommand: session({
      extra: ({ tag, verb, send }) => {
        if (verb !== 'LIST') return false;
        send(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n${tag} OK LIST completed\r\n`);
        return true;
      },
    }),
  }, async ({ port, received }) => {
    const result = await testConnection({ host: '127.0.0.1', port, secure: false, user: 'nemo', pass: 'pw', timeoutMs: 5000 });
    assert.equal(result.ok, true, result.error);
    for (const verb of assertOnlyReads(received, 'testConnection')) seen.add(verb);
  });

  // The paths between them used the read verbs they are meant to.
  for (const verb of ['LOGIN', 'AUTHENTICATE', 'LIST', 'EXAMINE', 'UID SEARCH', 'UID FETCH']) {
    assert.ok(seen.has(verb), `${verb} was never exercised: ${[...seen].join(', ')}`);
  }
});

test('the client refuses to send any command that is not a read, before it reaches the socket', async () => {
  for (const verb of WRITE_VERBS) {
    assert.throws(() => assertReadOnlyCommand(`${verb} "INBOX"`), /this client only reads/, verb);
    if (['STORE', 'COPY', 'MOVE', 'EXPUNGE'].includes(verb)) {
      assert.throws(() => assertReadOnlyCommand(`UID ${verb} 1:* +FLAGS (\\Deleted)`), /this client only reads/, `UID ${verb}`);
    }
  }
  // Read verbs this client does not use are refused too: the list is closed.
  for (const command of ['NOOP', 'IDLE', 'SEARCH ALL', 'FETCH 1 (FLAGS)', 'STATUS "INBOX" (MESSAGES)', 'ENABLE QRESYNC', '', '   ']) {
    assert.throws(() => assertReadOnlyCommand(command), /refusing to send/, JSON.stringify(command));
  }
  for (const spec of ['UID BODY[]', 'UID BODY[TEXT]', 'UID BINARY[1]', 'UID RFC822', 'UID FLAGS RFC822.TEXT']) {
    assert.throws(() => assertReadOnlyCommand(`UID FETCH 1 (${spec})`), /mark the message as read/, spec);
  }
  for (const command of ['CAPABILITY', 'LOGIN "u" "p"', 'AUTHENTICATE XOAUTH2', 'LIST "" "*"', 'EXAMINE "INBOX"', 'UID SEARCH SINCE 1-Aug-2026', 'UID FETCH 1,2 (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM)])', 'LOGOUT', 'uid fetch 3 (BODY.PEEK[1])']) {
    assert.doesNotThrow(() => assertReadOnlyCommand(command), command);
  }
  // One command per line: an allowed verb cannot carry a second command.
  for (const command of ['UID SEARCH ALL\r\nX EXPUNGE', 'UID FETCH 1 (UID)\nA1 STORE 1 +FLAGS (\\Deleted)', 'LOGOUT\0STORE']) {
    assert.throws(() => assertReadOnlyCommand(command), /line break/, JSON.stringify(command));
  }
  // The refusal never echoes the command: a LOGIN line carries the password.
  assert.doesNotMatch(String((() => { try { assertReadOnlyCommand('XLOGIN "u" "hunter2"'); } catch (err) { return err.message; } })()), /hunter2/);

  // And the gate is in the path: a refused command never reaches the server.
  await withServer({ onCommand: session({}) }, async ({ port, received }) => {
    const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
    await client.connect();
    await client.login();
    await assert.rejects(() => client.fetch([1], 'UID RFC822'), /mark the message as read/);
    assert.ok(!received.some((line) => /RFC822/i.test(line)), 'the refused fetch was sent');
    // The review's smuggle: fetch() puts its items into the command as given.
    await assert.rejects(() => client.fetch([1], 'UID)\r\nA0099 UID STORE 1 +FLAGS (\\Deleted)\r\nA0100 NOOP (UID'), /line break/);
    assert.ok(!received.some((line) => /STORE|NOOP/i.test(line)), 'a command was smuggled onto the wire');
    await client.close();
  });
});

test('every command the IMAP client can issue is one of the read verbs', () => {
  /* The wire test covers what the program does today; this covers what the
     file can do at all. Every command goes out through #exec — #pump is the
     only place a tagged line is written — and every #exec call names its verb
     as the literal start of its first argument. */
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'sources', 'imap.mjs'), 'utf8');
  const calls = [...src.matchAll(/this\.#exec\(\s*(['"`])([^'"`$]*)/g)].map((m) => m[2]);
  assert.ok(calls.length >= 9, `only ${calls.length} #exec calls found — the scan is broken`);
  for (const literal of calls) {
    assert.doesNotThrow(() => assertReadOnlyCommand(literal), `#exec issues ${literal}`);
  }
  // Every #exec call opens with a plain literal verb, not a computed one.
  const allCalls = [...src.matchAll(/this\.#exec\(\s*([^\n]{0,20})/g)].map((m) => m[1]);
  assert.equal(allCalls.length, calls.length, `a #exec call whose verb is computed: ${allCalls.filter((c) => !/^['"`][A-Z]/.test(c)).join(' | ')}`);
  // And the socket is written in exactly three places: #pump's tagged command,
  // the `*` that cancels an unwanted prompt, and a checked SASL continuation.
  // A fourth is a way onto the wire that skips the gate.
  const writes = [...src.matchAll(/\.write\(([^\n]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(writes, ['`${job.tag} ${job.command}${CRLF}`);', '`*${CRLF}`);', '`${line}${CRLF}`);'], `the socket is written outside the three known places: ${writes.join(' | ')}`);
  // ...and nothing reaches #exec except as `this.#exec(`.
  assert.equal((src.match(/#exec\b/g) || []).length, calls.length + 1, 'a #exec reference other than its definition and the scanned calls');
});

test('UID sets are chunked to at most 100 per command', async () => {
  const uids = Array.from({ length: 250 }, (_, i) => 1000 + i);
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb === 'UID SEARCH') {
            send(`* SEARCH ${uids.join(' ')}\r\n${tag} OK UID SEARCH completed\r\n`);
            return true;
          }
          if (verb === 'UID FETCH') {
            send(`${tag} OK UID FETCH completed\r\n`);
            return true;
          }
          return false;
        },
      }),
    },
    async ({ port, received }) => {
      await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', limit: 250, timeoutMs: 5000 });
      const fetches = commands(received).filter((c) => c.startsWith('UID FETCH '));
      assert.equal(fetches.length, 3, 'three chunks for 250 uids');
      const counts = fetches.map((c) => c.split(' ')[2].split(',').length);
      assert.deepEqual(counts, [100, 100, 50]);
      const all = fetches.flatMap((c) => c.split(' ')[2].split(',').map(Number));
      assert.equal(new Set(all).size, 250, 'every uid was requested exactly once');
    },
  );
});

/* ================================================================== *
 * Decoding real message shapes
 * ================================================================== */

test('an RFC 2047 base64 UTF-8 subject survives the round trip', async () => {
  const subject = 'Überfällige Zahlung für März — Projekt Süd';
  const half = Math.ceil(Buffer.byteLength(subject, 'utf8') / 2);
  const bytes = Buffer.from(subject, 'utf8');
  // Deliberately split the encoded words mid-character, the way real mailers do.
  const word = (buf) => `=?UTF-8?B?${buf.toString('base64')}?=`;
  const headers = [
    `Subject: ${word(bytes.subarray(0, half))}`,
    ` ${word(bytes.subarray(half))}`,
    'From: =?UTF-8?Q?Ana_M=C3=BCller?= <ana@sued.example>',
    'Date: Fri, 08 Aug 2026 11:00:00 +0200',
    'Message-ID: <m2@sued.example>',
    '',
    '',
  ].join('\r\n');

  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 77,
            internalDate: '08-Aug-2026 11:00:00 +0200',
            structure: PLAIN_TEXT_STRUCTURE,
            headers,
            parts: { 1: 'Bitte prüfen.\r\n' },
          },
        ]),
      }),
    },
    async ({ port }) => {
      const [msg] = await fetchRecent({
        host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000,
      });
      assert.equal(msg.subject, subject);
      assert.deepEqual(msg.from, { name: 'Ana Müller', email: 'ana@sued.example' });
      assert.equal(msg.date, '2026-08-08T11:00:00+02:00');
    },
  );
});

test('a multipart message with no text/plain falls back to the html part', async () => {
  const structure =
    '((("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 412 12 NIL NIL NIL NIL)' +
    ' "ALTERNATIVE" ("BOUNDARY" "b2") NIL NIL NIL)' +
    '("APPLICATION" "PDF" ("NAME" "quote.pdf") NIL NIL "BASE64" 90210 NIL' +
    ' ("attachment" ("FILENAME" "quote.pdf")) NIL NIL)' +
    ' "MIXED" ("BOUNDARY" "b1") NIL NIL NIL)';

  const html =
    '<html><body><p>Hi Nemo,</p><p>The change order is approved =\r\n' +
    'at the number we discussed &euro;4,200.</p><style>p{color:red}</style></body></html>';

  const plainStructure = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 200 5 NIL NIL NIL NIL)';
  const plainBody =
    'Marcus,\r\n\r\nThe number we agreed was =E2=82=AC4,200 and the schedule =\r\nholds through Friday.\r\n';

  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 201,
            internalDate: '08-Aug-2026 12:00:00 -0400',
            structure,
            headers: 'Subject: Change order approved\r\nFrom: pm@aldervance.example\r\nDate: Fri, 08 Aug 2026 12:00:00 -0400\r\nMessage-ID: <m201@aldervance.example>\r\n\r\n',
            parts: { '1.1': html },
          },
          {
            uid: 202,
            internalDate: '08-Aug-2026 08:00:00 -0400',
            structure: plainStructure,
            headers: 'Subject: Re: Change order\r\nFrom: nemo@northgate.example\r\nDate: Fri, 08 Aug 2026 08:00:00 -0400\r\nMessage-ID: <m202@northgate.example>\r\n\r\n',
            parts: { 1: plainBody },
          },
        ]),
      }),
    },
    async ({ port, received }) => {
      const messages = await fetchRecent({
        host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000,
      });
      assert.equal(messages.length, 2);

      const htmlMessage = messages.find((m) => m.uid === 201);
      assert.equal(
        htmlMessage.text,
        'Hi Nemo,\n\nThe change order is approved at the number we discussed €4,200.',
      );
      assert.ok(!htmlMessage.text.includes('<'), 'no markup reaches the caller');
      assert.equal(htmlMessage.hasAttachments, true, 'the pdf part is an attachment');

      const plainMessage = messages.find((m) => m.uid === 202);
      assert.equal(
        plainMessage.text,
        'Marcus,\n\nThe number we agreed was €4,200 and the schedule holds through Friday.',
      );
      assert.equal(plainMessage.hasAttachments, false);

      // Newest first.
      assert.deepEqual(messages.map((m) => m.uid), [201, 202]);

      const sent = commands(received);
      assert.ok(sent.some((c) => c.includes('BODY.PEEK[1.1]')), 'the nested html part number was resolved');
      assert.ok(sent.some((c) => /\(UID BODY\.PEEK\[1\]\)$/.test(c)), 'the plain message used part 1');
    },
  );
});

test('REGRESSION: a signature part and an inline logo are not attachments', async () => {
  // hasAttachments used to be "attachment disposition OR any filename OR any
  // application/* part", and the last two clauses fired on machinery. Every
  // S/MIME mail carries a pkcs7-signature; every templated newsletter carries
  // a cid: logo with a NAME param. Both came out as `[unread, has attachment]`
  // in front of the model, and both ship to MCP clients.
  const TEXT = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 120 4 NIL NIL NIL NIL)';

  // Outlook's shape: the signature is named and dispositioned like a file.
  const signedOnly =
    `(${TEXT}` +
    '("APPLICATION" "PKCS7-SIGNATURE" ("NAME" "smime.p7s") NIL NIL "BASE64" 3210 NIL' +
    ' ("attachment" ("FILENAME" "smime.p7s")) NIL NIL)' +
    ' "SIGNED" ("BOUNDARY" "b7" "PROTOCOL" "application/pkcs7-signature") NIL NIL NIL)';

  // A cid: logo: no disposition at all, a NAME param, a Content-ID the html draws.
  const relatedLogo =
    '(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 300 6 NIL NIL NIL NIL)' +
    '("IMAGE" "PNG" ("NAME" "logo.png") "<logo@aldervance.example>" NIL "BASE64" 4096 NIL NIL NIL NIL)' +
    ' "RELATED" ("BOUNDARY" "b8" "TYPE" "text/html") NIL NIL NIL)';

  // The same signed envelope, but with a real document inside it.
  const signedWithPdf =
    `((${TEXT}` +
    '("APPLICATION" "PDF" ("NAME" "invoice.pdf") NIL NIL "BASE64" 40000 NIL' +
    ' ("attachment" ("FILENAME" "invoice.pdf")) NIL NIL)' +
    ' "MIXED" ("BOUNDARY" "b9") NIL NIL NIL)' +
    '("APPLICATION" "PGP-SIGNATURE" ("NAME" "signature.asc") NIL NIL "7BIT" 833 NIL NIL NIL NIL)' +
    ' "SIGNED" ("BOUNDARY" "b10" "PROTOCOL" "application/pgp-signature") NIL NIL NIL)';

  const headers = (n) =>
    `Subject: m${n}\r\nFrom: pm@aldervance.example\r\nDate: Fri, 08 Aug 2026 12:00:00 -0400\r\nMessage-ID: <m${n}@aldervance.example>\r\n\r\n`;

  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 401, internalDate: '08-Aug-2026 12:00:00 -0400', structure: signedOnly,
            headers: headers(401), parts: { 1: 'Signed, nothing enclosed.\r\n' },
          },
          {
            uid: 402, internalDate: '08-Aug-2026 11:00:00 -0400', structure: relatedLogo,
            headers: headers(402), parts: { 1: '<html><body><p>Newsletter</p><img src="cid:logo@aldervance.example"></body></html>' },
          },
          {
            uid: 403, internalDate: '08-Aug-2026 10:00:00 -0400', structure: signedWithPdf,
            headers: headers(403), parts: { '1.1': 'Invoice attached and signed.\r\n' },
          },
        ]),
      }),
    },
    async ({ port }) => {
      const messages = await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      const byUid = new Map(messages.map((m) => [m.uid, m]));

      assert.equal(byUid.get(401).hasAttachments, false, 'smime.p7s is machinery, not a document');
      assert.equal(byUid.get(402).hasAttachments, false, 'a cid: logo is drawn by the body, not attached to it');
      assert.equal(byUid.get(403).hasAttachments, true, 'the pdf inside the signed envelope still counts');

      // The text still has to come out of the right part, or the flag is the
      // least of the problems.
      assert.equal(byUid.get(401).text, 'Signed, nothing enclosed.');
      assert.equal(byUid.get(403).text, 'Invoice attached and signed.');
    },
  );
});

test('REGRESSION: an attached email is not read as the message body', async () => {
  /* "Forward as attachment" from a client that writes HTML only. The parts
     inside the attached message/rfc822 carry no disposition of their own, so
     chooseTextPart's plain-before-HTML rule picked the ATTACHED email's text
     (BODY.PEEK[2.1]) and the model never saw a word the sender wrote. */
  const envelope = '("Thu, 06 Aug 2026 09:00:00 -0400" "Original" NIL NIL NIL NIL NIL NIL NIL NIL)';
  const inner = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 40 1 NIL NIL NIL NIL)';
  const attached = (disposition) =>
    `("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 400 ${envelope} ${inner} 12 NIL ${disposition} NIL NIL)`;
  const forwarded = (disposition) =>
    '(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 60 2 NIL NIL NIL NIL)' +
    `${attached(disposition)} "MIXED" ("BOUNDARY" "b10") NIL NIL NIL)`;
  // Nothing of its own to read: the attached email is better than nothing.
  const onlyEnclosed = `(${attached('("attachment" ("FILENAME" "original.eml"))')} "MIXED" ("BOUNDARY" "b11") NIL NIL NIL)`;
  const headers = (uid) => `Subject: Fwd ${uid}\r\nFrom: Kit <kit@alder.example>\r\nDate: Sat, 08 Aug 2026 12:00:00 -0400\r\n\r\n`;
  const parts = { 1: '<p>See below, Nemo &mdash; the <b>sender</b> wrote this.</p>', '2.1': 'Words from the attached email.\r\n' };

  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          { uid: 501, internalDate: '08-Aug-2026 12:00:00 -0400', structure: forwarded('("attachment" ("FILENAME" "original.eml"))'), headers: headers(501), parts },
          { uid: 502, internalDate: '08-Aug-2026 11:00:00 -0400', structure: forwarded('NIL'), headers: headers(502), parts },
          { uid: 503, internalDate: '08-Aug-2026 10:00:00 -0400', structure: onlyEnclosed, headers: headers(503), parts: { '1.1': 'Only the original.\r\n' } },
        ]),
      }),
    },
    async ({ port }) => {
      const messages = await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      const byUid = new Map(messages.map((m) => [m.uid, m]));
      assert.equal(byUid.get(501).text, 'See below, Nemo — the sender wrote this.');
      assert.equal(byUid.get(502).text, 'See below, Nemo — the sender wrote this.',
        'an attached email with no disposition is still someone else\'s words');
      assert.equal(byUid.get(503).text, 'Only the original.');
      assert.equal(byUid.get(501).hasAttachments, true);
    },
  );
});

test('a message with no usable BODYSTRUCTURE falls back to the TEXT section', async () => {
  await withServer(
    {
      onCommand: session({
        extra: mailbox([
          {
            uid: 300,
            internalDate: '08-Aug-2026 07:30:00 -0400',
            structure: 'NIL',
            headers: 'Subject: no structure\r\nFrom: odd@server.example\r\nDate: Fri, 08 Aug 2026 07:30:00 -0400\r\n\r\n',
            parts: { TEXT: 'The server would not describe this message.\r\n' },
          },
        ]),
      }),
    },
    async ({ port, received }) => {
      const [msg] = await fetchRecent({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      assert.equal(msg.text, 'The server would not describe this message.');
      assert.equal(msg.hasAttachments, false);
      assert.ok(commands(received).some((c) => c.includes('BODY.PEEK[TEXT]')));
    },
  );
});

/* ================================================================== *
 * Transport hazards
 * ================================================================== */

test('a response split mid-multibyte-character across TCP packets still decodes', async () => {
  const subject = 'Überfällig — Zahlung für März';
  const headers = [
    `Subject: ${subject}`, // raw 8-bit header, as plenty of mailers still send
    'From: Ana <ana@sued.example>',
    'Date: Fri, 08 Aug 2026 11:00:00 +0200',
    'Message-ID: <split@sued.example>',
    '',
    '',
  ].join('\r\n');
  const body = 'Grüße aus München — bitte prüfen.\r\n';

  // Write each response in three packets: the first ends between the CR and LF
  // that terminate the literal marker, the second ends between the two bytes of
  // a multi-byte character inside the payload.
  const splittingWrite = (send, buf) => {
    const afterMarker = buf.indexOf(Buffer.from('}\r\n', 'utf8')) + 3;
    let lead = -1;
    for (let i = afterMarker; i < buf.length; i++) {
      if (buf[i] >= 0xc0) { lead = i; break; }
    }
    assert.ok(lead > afterMarker, 'fixture must contain a multibyte character in the payload');
    send(buf.subarray(0, afterMarker - 1));
    send(buf.subarray(afterMarker - 1, lead + 1));
    send(buf.subarray(lead + 1));
  };

  await withServer(
    {
      onCommand: session({
        extra: mailbox(
          [
            {
              uid: 55,
              internalDate: '08-Aug-2026 11:00:00 +0200',
              structure: PLAIN_TEXT_STRUCTURE,
              headers,
              parts: { 1: body },
            },
          ],
          { write: splittingWrite },
        ),
      }),
    },
    async ({ port }) => {
      const [msg] = await fetchRecent({
        host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000,
      });
      assert.equal(msg.subject, subject);
      assert.equal(msg.text, 'Grüße aus München — bitte prüfen.');
    },
  );
});

test('an authentication failure rejects with the host and the server code', async () => {
  await withServer(
    {
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'LOGIN') {
          send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'bad', timeoutMs: 5000 });
      await client.connect();
      await assert.rejects(
        () => client.login(),
        (err) => {
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/, 'the error names the host');
          assert.match(err.message, /AUTHENTICATIONFAILED/);
          assert.equal(err.status, 'NO');
          assert.equal(err.code, 'AUTHENTICATIONFAILED');
          assert.equal(err.host, '127.0.0.1');
          return true;
        },
      );
      await client.close();
    },
  );
});

test('testConnection reports the failure instead of throwing', async () => {
  await withServer(
    {
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'LOGIN') {
          send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port }) => {
      const result = await testConnection({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'bad', timeoutMs: 5000 });
      assert.equal(result.ok, false);
      assert.match(result.error, /AUTHENTICATIONFAILED/);
      assert.match(result.error, /127\.0\.0\.1/);
      assert.deepEqual(result.mailboxes, []);
    },
  );
});

/** A server that quotes back the LOGIN line it just rejected. Real ones do. */
function echoingLogin({ tag, verb, line, send }) {
  if (verb === 'LOGIN') {
    send(`${tag} NO [AUTHENTICATIONFAILED] rejected: ${line}\r\n`);
    return;
  }
  send(`${tag} OK fine\r\n`);
}

test('REGRESSION: a password containing " and \\ is struck out of the echoed LOGIN line', async () => {
  // quoted() backslash-escapes both characters before the password goes on the
  // wire, so `pa"ss\word` leaves as `"pa\"ss\\word"`. The redaction list used
  // to hold only the verbatim bytes, the base64 and the SASL PLAIN payload, so
  // includes(pass) was false and the escaped form went straight through — into
  // this very string, which /api/mail/test returns in its HTTP body the moment
  // a user clicks "Test connection" with a mistyped password, and which the
  // sweep writes to runs.stats_json and re-serves from /api/state forever.
  const pass = 'pa"ss\\word';
  const escaped = 'pa\\"ss\\\\word';

  await withServer(
    { onCommand: echoingLogin },
    async ({ port, received }) => {
      const result = await testConnection({
        host: '127.0.0.1', port, secure: false, user: 'me@x.example', pass, timeoutMs: 5000,
      });
      assert.equal(result.ok, false);

      // The escaped spelling is the one that is actually on the wire; assert
      // the fixture really produced it before asserting it was struck.
      assert.ok(
        received.some((line) => line.includes(`"${escaped}"`)),
        'the fixture must exercise the escaped wire form',
      );
      assert.ok(!result.error.includes(escaped), 'the escaped wire form is redacted');
      assert.ok(!result.error.includes(pass), 'the verbatim form is redacted');
      assert.match(result.error, /<password withheld>/);
      assert.match(result.error, /AUTHENTICATIONFAILED/, 'the diagnosis survives the redaction');
    },
  );
});

test('REGRESSION: a one-character password is struck without shredding the sentence', async () => {
  // withoutCredentials is a blind split/join, so a password of "e" used to
  // replace every "e" in the server's own words — which destroys the message
  // and, by the shape of the holes, spells the password out for whoever reads
  // it. Short passwords are now struck only in the spellings they travel in.
  await withServer(
    { onCommand: echoingLogin },
    async ({ port }) => {
      const result = await testConnection({
        host: '127.0.0.1', port, secure: false, user: 'u', pass: 'e', timeoutMs: 5000,
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /AUTHENTICATIONFAILED/, 'prose survives intact');
      assert.match(result.error, /rejected: A\d+ LOGIN "u" <password withheld>/, 'the quoted argument still goes');
      assert.ok(!result.error.includes('"e"'), 'nothing quoted-and-short is left behind');
    },
  );
});

test('REGRESSION: redaction runs once over the original text, never over its own marker', async () => {
  // The fix for the escaped wire form added a second needle to a list that was
  // substituted one form at a time, and two things went wrong at once.
  //
  // A password containing neither `"` nor `\` escapes to itself, so `pass` and
  // `escaped` were the same string and the same scan ran twice. And the marker
  // `<password withheld>` is not inert: it contains "pass", "word", "password"
  // and "withheld", so every scan after the first ate the marker the previous
  // one had just written. Measured through the real testConnection against a
  // server that quotes back the LOGIN line it rejected:
  //
  //   pass="pass"      -> <<<password withheld>word withheld>word withheld>
  //   pass="word"      -> <pass<pass<password withheld> withheld> withheld>
  //   pass="withheld"  -> <password <password <password withheld>>>
  //
  // Nothing leaked — the cascade ate the marker, not the secret — but this
  // string is the body of POST /api/mail/test, i.e. what the Settings "Test
  // connection" button puts in front of a user at the exact moment they need
  // to read "AUTHENTICATIONFAILED", and it is also what the sweep writes to
  // runs.stats_json and re-serves from /api/state forever.
  //
  // Every one of these is a substring of the marker, which is the whole point.
  for (const pass of ['pass', 'word', 'password', 'withheld', 'hunter2']) {
    await withServer(
      { onCommand: echoingLogin },
      async ({ port, received }) => {
        const result = await testConnection({
          host: '127.0.0.1', port, secure: false, user: 'u', pass, timeoutMs: 5000,
        });
        assert.equal(result.ok, false);
        assert.ok(
          received.some((line) => line.includes(`"${pass}"`)),
          `the fixture must put ${JSON.stringify(pass)} on the wire for the server to echo`,
        );
        assert.equal(
          result.error.match(/withheld/g)?.length,
          1,
          `${JSON.stringify(pass)} produced a nested marker: ${result.error}`,
        );
        assert.match(
          result.error,
          /rejected: A\d+ LOGIN "u" <password withheld>$/,
          `${JSON.stringify(pass)} shredded the sentence: ${result.error}`,
        );
        assert.match(result.error, /AUTHENTICATIONFAILED/, 'the diagnosis survives the redaction');
      },
    );
  }
});

test('REGRESSION: redaction is linear in the reply, however many times the password appears', async () => {
  /* The repair for the nested-marker cascade above replaced the per-form
     split/join with a single left-to-right scan — and the obvious way to write
     that scan re-runs `indexOf` for EVERY form from the cursor on EVERY hit,
     which is quadratic in a string a hostile server controls the length and the
     hit-count of. Measured through the real testConnection before this test
     existed: 7 ms at 18 KB, 29 ms at 72 KB, 431 ms at 288 KB — 15x the time for
     4x the input, against MAX_RESPONSE_BYTES of 96 MB.

     So the assertion is a SHAPE, not a stopwatch reading: quadrupling the reply
     must not multiply the time by anything like sixteen. A wall-clock budget
     alone would be flaky on a loaded runner; a ratio survives a slow machine,
     because a slow machine is slow at both sizes. */
  const pass = 'hunter2!';
  const timeFor = async (repeats) => {
    let ms = 0;
    await withServer(
      {
        onCommand: ({ tag, verb, send }) => {
          if (verb === 'LOGIN') send(`${tag} NO [AUTHENTICATIONFAILED] rejected ${`${pass} `.repeat(repeats)}\r\n`);
          else send(`${tag} OK fine\r\n`);
        },
      },
      async ({ port }) => {
        const started = performance.now();
        const result = await testConnection({
          host: '127.0.0.1', port, secure: false, user: 'u', pass, timeoutMs: 30_000,
        });
        ms = performance.now() - started;
        assert.equal(result.ok, false);
        assert.ok(!result.error.includes(pass), 'the password survived a reply that repeats it');
      },
    );
    return ms;
  };

  // A floor keeps the ratio meaningful when both numbers round to nothing.
  const small = Math.max(await timeFor(4_000), 1);
  const large = Math.max(await timeFor(16_000), 1);
  assert.ok(
    large < small * 8,
    `redaction is superlinear: 4,000 repeats took ${small.toFixed(0)}ms and 16,000 took ${large.toFixed(0)}ms `
    + '(4x the input should cost about 4x, not 16x)',
  );
});

test('* BYE followed by a dropped connection rejects the in-flight command', async () => {
  await withServer(
    {
      onCommand: session({
        extra: ({ verb, send, socket }) => {
          if (verb !== 'UID SEARCH') return false;
          send('* BYE Server shutting down for maintenance\r\n');
          setTimeout(() => socket.destroy(), 10);
          return true;
        },
      }),
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      await client.connect();
      await client.login();
      await client.select('INBOX');
      await assert.rejects(
        () => client.search(['ALL']),
        (err) => {
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          assert.match(err.message, /Server shutting down for maintenance/);
          return true;
        },
      );
      await client.close();
    },
  );
});

test('a server that never answers times out with a message naming the host', async () => {
  await withServer(
    {
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'CAPABILITY' || verb === 'LOGIN') send(`${tag} OK fine\r\n`);
        // Everything else: silence.
      },
    },
    async ({ port }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 250 });
      await client.connect();
      await client.login();
      await assert.rejects(
        () => client.select('INBOX'),
        (err) => {
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          assert.match(err.message, /for 250ms/);
          return true;
        },
      );
      await client.close();
    },
  );
});

/* ================================================================== *
 * Authentication paths
 * ================================================================== */

test('LOGINDISABLED switches to AUTHENTICATE PLAIN and never sends the password as a command argument', async () => {
  const password = 'correct horse battery staple';
  let credentials = null;
  let authTag = null;

  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, line, send }) => {
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        if (verb === 'AUTHENTICATE') {
          authTag = tag;
          send('+ \r\n');
          return;
        }
        if (authTag && !line.includes(' ')) {
          // The SASL payload arrives as a bare line, with no tag of its own.
          credentials = Buffer.from(line, 'base64').toString('utf8').split('\0');
          send(`${authTag} OK AUTHENTICATE completed\r\n`);
          authTag = null;
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port, received }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'nemo', pass: password, timeoutMs: 5000 });
      await client.connect();
      await client.login();
      assert.deepEqual(credentials, ['', 'nemo', password]);
      assert.ok(commands(received).includes('AUTHENTICATE PLAIN'));
      assert.ok(!received.some((line) => line.includes(password)), 'the password never appears in clear text');
      await client.close();
    },
  );
});

test('a plaintext connection upgrades when the server advertises STARTTLS', async () => {
  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, send, socket }) => {
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        if (verb === 'STARTTLS') {
          send(`${tag} OK Begin TLS negotiation now\r\n`);
          // This mock cannot actually do TLS; dropping the socket proves the
          // client attempted the handshake and reports the failure honestly.
          setTimeout(() => socket.destroy(), 10);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port, received }) => {
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 3000 });
      await assert.rejects(
        () => client.connect(),
        (err) => {
          assert.match(err.message, /STARTTLS handshake failed/);
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          return true;
        },
      );
      assert.ok(commands(received).includes('STARTTLS'), 'the upgrade was attempted before any credentials');
      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)), 'no credentials on the plaintext socket');
      await client.close();
    },
  );
});

/* ================================================================== *
 * Requiring TLS
 *
 * REGRESSION. With `secure: false` the client offered to upgrade and then went
 * ahead regardless, because "the server did not advertise STARTTLS" and "there
 * is nobody in the middle" look identical from here. Stripping one word out of
 * a CAPABILITY reply was enough to be handed the password in the clear, and
 * nothing anywhere said so.
 * ================================================================== */

test('the TLS requirement is on by default everywhere except loopback', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3', 'localhost', 'LOCALHOST',
    'bridge.localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.equal(tlsRequiredByDefault(host), false, host);
  }
  // Near-misses. Each of these is a real network address that has fooled a
  // loopback check written with `includes` or `startsWith` somewhere before.
  for (const host of ['imap.example.com', '192.168.1.10', '128.0.0.1', '10.0.0.1',
    '127.0.0.1.evil.example', 'localhost.evil.example', 'notlocalhost', '227.0.0.1',
    '127.0.0.999', '::ffff:8.8.8.8', '']) {
    assert.equal(isLoopbackHost(host), false, host);
    assert.equal(tlsRequiredByDefault(host), true, host);
  }
});

test('a client takes its TLS requirement from the host, and an explicit setting wins', () => {
  assert.equal(new ImapClient({ host: 'imap.example.com', secure: false }).requireTls, true);
  assert.equal(new ImapClient({ host: '127.0.0.1', port: 1143, secure: false }).requireTls, false);
  assert.equal(new ImapClient({ host: 'imap.example.com', secure: false, requireTls: false }).requireTls, false);
  assert.equal(new ImapClient({ host: '127.0.0.1', secure: false, requireTls: true }).requireTls, true);
  // Anything that is not a deliberate `false` is a requirement. A form field
  // that arrives as the string "false" must not switch encryption off.
  assert.equal(new ImapClient({ host: '127.0.0.1', secure: false, requireTls: 'false' }).requireTls, true);
});

test('a server that never offers STARTTLS gets no credentials, and says why', async () => {
  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, send }) => {
        // A capability list with STARTTLS quietly removed — exactly what a
        // machine in the middle would send.
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port, received }) => {
      const client = new ImapClient({
        host: '127.0.0.1', port, secure: false, requireTls: true,
        user: 'nemo', pass: 'hunter2', timeoutMs: 3000,
      });

      await assert.rejects(
        () => client.connect(),
        (err) => {
          assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/);
          assert.match(err.message, /still in the clear/);
          assert.match(err.message, /never offered STARTTLS/);
          assert.match(err.message, /requireTls/, 'the error has to name the way out');
          return true;
        },
      );
      // And the credential gate holds on its own, without connect() in front.
      await assert.rejects(() => client.login(), /still in the clear/);

      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)),
        `credentials went out over cleartext: ${received.join(' | ')}`);
      assert.ok(!received.some((line) => line.includes('hunter2')));
      await client.close();
    },
  );
});

test('a loopback bridge still connects and logs in with no TLS at all', async () => {
  await withServer(
    { greeting: '* OK Zelos mock ready', onCommand: session({}) },
    async ({ port, received }) => {
      // No requireTls given: 127.0.0.1 is where Proton Bridge lives, and that
      // is the documented reason plaintext is still allowed.
      const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'nemo', pass: 'p', timeoutMs: 3000 });
      await client.connect();
      await client.login();
      assert.ok(commands(received).some((c) => c.startsWith('LOGIN')), 'the bridge case must keep working');
      await client.close();
    },
  );
});

test('testConnection carries the requirement through and reports it as a failure', async () => {
  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port, received }) => {
      const refused = await testConnection({
        host: '127.0.0.1', port, secure: false, requireTls: true, user: 'nemo', pass: 'hunter2', timeoutMs: 3000,
      });
      assert.equal(refused.ok, false);
      assert.match(refused.error, /still in the clear/);
      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)));
    },
  );
});

/* ================================================================== *
 * Mailboxes
 * ================================================================== */

test('listMailboxes decodes modified UTF-7 names and reports special-use folders', async () => {
  await withServer(
    {
      onCommand: session({
        extra: ({ tag, verb, send }) => {
          if (verb !== 'LIST') return false;
          send(
            '* LIST (\\HasNoChildren) "/" "INBOX"\r\n' +
              '* LIST (\\HasNoChildren \\Sent) "/" "Gesendete Objekte"\r\n' +
              '* LIST (\\HasNoChildren \\Trash) "/" "Gel&APY-schte Objekte"\r\n' +
              '* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"\r\n' +
              `${tag} OK LIST completed\r\n`,
          );
          return true;
        },
      }),
    },
    async ({ port }) => {
      const result = await testConnection({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
      assert.equal(result.ok, true, result.error ?? '');
      assert.deepEqual(result.mailboxes.map((m) => m.name), [
        'INBOX',
        'Gesendete Objekte',
        'Gelöschte Objekte',
        '[Gmail]',
      ]);
      assert.deepEqual(result.mailboxes.map((m) => m.specialUse), ['inbox', 'sent', 'trash', null]);
      assert.equal(result.mailboxes[0].delimiter, '/');
      assert.ok(result.capabilities.includes('IMAP4REV1'));
    },
  );
});

test('select reports the mailbox facts the sync needs', async () => {
  await withServer({ onCommand: session({ exists: 42 }) }, async ({ port }) => {
    const client = new ImapClient({ host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', timeoutMs: 5000 });
    await client.connect();
    await client.login();
    const box = await client.select('INBOX');
    assert.equal(box.exists, 42);
    assert.equal(box.uidValidity, 1234567890);
    assert.equal(box.uidNext, 9001);
    assert.ok(box.flags.includes('\\Seen'));
    assert.equal(box.readOnly, true);
    await client.close();
  });
});

/* ================================================================== *
 * guessImapHost
 * ================================================================== */

test('guessImapHost knows the providers that need an app password', () => {
  const appPassword = /app[- ]?(specific[- ])?password/i;

  const gmail = guessImapHost('nemo@gmail.com');
  assert.equal(gmail.host, 'imap.gmail.com');
  assert.equal(gmail.port, 993);
  assert.equal(gmail.secure, true);
  assert.match(gmail.note, appPassword);

  const icloud = guessImapHost('Nemo@ICLOUD.com');
  assert.equal(icloud.host, 'imap.mail.me.com');
  assert.match(icloud.note, appPassword);

  const yahoo = guessImapHost('nemo@ymail.com');
  assert.equal(yahoo.host, 'imap.mail.yahoo.com');
  assert.match(yahoo.note, appPassword);
});

test('guessImapHost covers the other common providers and degrades sensibly', () => {
  assert.equal(guessImapHost('a@outlook.com').host, 'outlook.office365.com');
  assert.equal(guessImapHost('a@fastmail.com').host, 'imap.fastmail.com');

  const proton = guessImapHost('a@proton.me');
  assert.equal(proton.host, '127.0.0.1');
  assert.equal(proton.port, 1143);
  assert.equal(proton.secure, false);
  assert.match(proton.note, /Bridge/);

  // These notes reach the expert form and the doctor, so the facts stay —
  // the Microsoft shut-off date above all — but each one opens in the words
  // a person uses. The Outlook note used to open on the date and send the
  // reader to "register a free app".
  const outlook = guessImapHost('a@hotmail.com');
  assert.match(outlook.note, /^Hotmail and Outlook\.com need a one-time setup at Microsoft’s website first \(about ten minutes\) — the app shows you every step\./);
  assert.match(outlook.note, /16 September 2024/, 'the shut-off date is a fact the expert form still needs');
  assert.ok(!/register a free app/.test(outlook.note), 'the note still says "register a free app"');
  for (const address of ['a@gmail.com', 'a@icloud.com', 'a@yahoo.com', 'a@hotmail.com', 'a@fastmail.com', 'a@proton.me', 'a@aol.com', 'a@zoho.com']) {
    const { note } = guessImapHost(address);
    const opening = note.split(/ — |[.:]\s/)[0];
    assert.doesNotMatch(opening, /\bIMAP\b/, `${address}: the note opens on the protocol: "${opening}"`);
  }

  const guessed = guessImapHost('marcus@deco-associates.example');
  assert.equal(guessed.host, 'imap.deco-associates.example');
  assert.equal(guessed.port, 993);
  assert.ok(guessed.note.length > 0);

  for (const bad of ['', null, 'not-an-email', 'a@localhost']) {
    const result = guessImapHost(bad);
    assert.equal(result.host, '');
    assert.equal(result.port, 993);
    assert.ok(result.note.length > 0, 'the user is always told what to do next');
  }
});

/**
 * The simple mail form asks one question — "what does connecting this address
 * take?" — and this is the answer. Gmail, iCloud, Yahoo, AOL, Fastmail and
 * Zoho each get the page where an app password is CREATED, every one fetched
 * live (200, through the provider's sign-in redirect where there is one)
 * before it shipped; Microsoft's personal domains get no page because no
 * password of any kind opens them any more; Proton gets Bridge. Anything else
 * is a guess, and says so.
 */
test('describeProvider says what each known provider is called, how it signs in, and where its app password is made', () => {
  const expected = {
    'nemo@gmail.com': ['Gmail', 'password', 'https://myaccount.google.com/apppasswords'],
    'Nemo@ICLOUD.com': ['iCloud Mail', 'password', 'https://account.apple.com/account/manage'],
    'nemo@ymail.com': ['Yahoo Mail', 'password', 'https://login.yahoo.com/myaccount/security/app-password'],
    'nemo@aol.com': ['AOL Mail', 'password', 'https://login.aol.com/myaccount/security/app-password'],
    'nemo@fastmail.fm': ['Fastmail', 'password', 'https://app.fastmail.com/settings/security/devicekeys'],
    'nemo@zohomail.com': ['Zoho Mail', 'password', 'https://accounts.zoho.com/home#security/app_password'],
    'nemo@hotmail.com': ['Outlook / Microsoft', 'xoauth2', null],
    'nemo@pm.me': ['Proton Mail', 'bridge', null],
  };
  for (const [address, [label, auth, url]] of Object.entries(expected)) {
    const got = describeProvider(address);
    assert.equal(got.known, true, address);
    assert.equal(got.label, label, address);
    assert.equal(got.auth, auth, address);
    assert.equal(got.appPasswordUrl, url, address);
    // Where to connect is the answer guessImapHost already gives: one table.
    assert.deepEqual({ host: got.host, port: got.port, secure: got.secure, note: got.note }, guessImapHost(address), address);
    assert.ok(got.note.length > 0, address);
    if (auth === 'password') {
      assert.ok(url, `${address}: a password provider with no page to make one on`);
      assert.equal(new URL(url).protocol, 'https:', `${address}: an app-password page has to be https`);
    } else {
      assert.equal(url, null, `${address}: no password, so no page for one`);
    }
  }
  // Proton is the one that connects to this machine, not to Proton.
  const proton = describeProvider('nemo@pm.me');
  assert.equal(proton.host, '127.0.0.1');
  assert.equal(proton.port, 1143);
  assert.equal(proton.secure, false);
});

test('describeProvider guesses for a domain it does not know, and says that it is guessing', () => {
  const guessed = describeProvider('marcus@deco-associates.example');
  assert.equal(guessed.known, false);
  assert.equal(guessed.label, 'deco-associates.example', 'the domain is the only name there is');
  assert.equal(guessed.host, 'imap.deco-associates.example');
  assert.equal(guessed.port, 993);
  assert.equal(guessed.secure, true);
  assert.equal(guessed.auth, 'password');
  assert.equal(guessed.appPasswordUrl, null);
  assert.deepEqual(
    { host: guessed.host, port: guessed.port, secure: guessed.secure, note: guessed.note },
    guessImapHost('marcus@deco-associates.example'),
    'the fallback is guessImapHost\'s fallback, not a second one',
  );

  for (const bad of ['', null, undefined, 42, 'not-an-email', 'a@localhost', '@', 'a@', { email: 'a@gmail.com' }]) {
    const got = describeProvider(bad);
    assert.equal(got.known, false, JSON.stringify(bad));
    assert.equal(got.host, '', JSON.stringify(bad));
    assert.equal(got.label, '', `${JSON.stringify(bad)}: nothing to name`);
    assert.equal(got.auth, 'password', JSON.stringify(bad));
    assert.equal(got.appPasswordUrl, null, JSON.stringify(bad));
    assert.ok(got.note.length > 0, 'the user is always told what to do next');
  }
});

/* ------------------------------------------------------------------ *
 * discoverProvider
 * ------------------------------------------------------------------ */

/**
 * The operator's own address: a custom domain on Google Workspace, which
 * describeProvider's table cannot list because the domain is his. On v1.2.0
 * the card said "A provider Zelos does not know · imap.<his domain>:993" and
 * Connect failed with ENOTFOUND. The domain's MX says who hosts its mail,
 * and the answer is the Gmail row of the one table — host, port, page and
 * all — under the name Workspace users know it by.
 */
const nxdomain = (code = 'ENOTFOUND') => async () => { throw Object.assign(new Error(`queryMx ${code}`), { code }); };
const never = () => new Promise(() => {});

test('discoverProvider answers a known consumer domain from the table and never asks DNS', async () => {
  const asked = [];
  const spy = async (name) => { asked.push(name); return []; };
  for (const address of ['nemo@gmail.com', 'Nemo@ICLOUD.com', 'nemo@hotmail.com', 'nemo@pm.me', 'nemo@fastmail.com']) {
    const got = await discoverProvider(address, { resolveMx: spy, resolveSrv: spy });
    assert.deepEqual(got, describeProvider(address), `${address}: the table's answer, unchanged`);
    assert.equal(got.via, undefined, `${address}: no via on a table answer`);
  }
  assert.deepEqual(asked, [], 'a consumer domain went to the resolver');
});

test('discoverProvider reads a Google Workspace domain off its lowest-priority MX', async () => {
  const asked = [];
  const resolveMx = async (name) => {
    asked.push(name);
    // Out of order and with the backups first, so the sort is what picks.
    return [
      { priority: 20, exchange: 'alt1.aspmx.l.google.com.' },
      { priority: 30, exchange: 'alt2.aspmx.l.google.com.' },
      { priority: 10, exchange: 'aspmx.l.google.com.' },
    ];
  };
  const resolveSrv = async (name) => { asked.push(name); return []; };
  const got = await discoverProvider('Nemo@Workspace-Shaped.example', { resolveMx, resolveSrv });
  const gmail = describeProvider('nemo@gmail.com');

  assert.equal(got.known, true);
  assert.equal(got.via, 'mx');
  assert.equal(got.mx, 'aspmx.l.google.com', 'the lowest priority, lower-cased, no trailing dot');
  assert.equal(got.label, 'Google Workspace');
  assert.equal(got.host, gmail.host);
  assert.equal(got.port, gmail.port);
  assert.equal(got.secure, gmail.secure);
  assert.equal(got.auth, 'password');
  assert.equal(got.appPasswordUrl, gmail.appPasswordUrl, 'the app-password page is Google\'s, from the one table');
  assert.match(got.note, /^Your domain's mail is hosted by Google, so this is Gmail underneath\. /);
  assert.ok(got.note.endsWith(gmail.note), 'the Gmail note follows, not a copy of it');

  // Only the domain went out: lower-cased, and with no address in it.
  assert.deepEqual(asked, ['workspace-shaped.example']);
  for (const name of asked) assert.ok(!name.includes('@'), `the address went to the resolver: ${name}`);
});

test('discoverProvider names Microsoft 365, Fastmail, Zoho, Proton, iCloud and Yahoo by their MX hosts', async () => {
  const cases = [
    ['contoso-com.mail.protection.outlook.com', 'Microsoft 365', 'nemo@hotmail.com', 'xoauth2'],
    ['in1-smtp.messagingengine.com', 'Fastmail', 'nemo@fastmail.com', 'password'],
    ['mx.zoho.com', 'Zoho Mail', 'nemo@zoho.com', 'password'],
    ['mx.zoho.eu', 'Zoho Mail', 'nemo@zoho.com', 'password'],
    ['mail.protonmail.ch', 'Proton Mail', 'nemo@proton.me', 'bridge'],
    ['mx01.mail.icloud.com', 'iCloud Mail', 'nemo@icloud.com', 'password'],
    ['mta5.am0.yahoodns.net', 'Yahoo Mail', 'nemo@yahoo.com', 'password'],
  ];
  for (const [exchange, label, twin, auth] of cases) {
    const got = await discoverProvider('nemo@custom.example', {
      resolveMx: async () => [{ priority: 10, exchange }],
      resolveSrv: never,
    });
    const entry = describeProvider(twin);
    assert.equal(got.known, true, exchange);
    assert.equal(got.via, 'mx', exchange);
    assert.equal(got.mx, exchange);
    assert.equal(got.label, label, exchange);
    assert.equal(got.auth, auth, exchange);
    assert.deepEqual(
      { host: got.host, port: got.port, secure: got.secure, appPasswordUrl: got.appPasswordUrl },
      { host: entry.host, port: entry.port, secure: entry.secure, appPasswordUrl: entry.appPasswordUrl },
      `${exchange}: where to connect and where the password is made come from the table`,
    );
    assert.match(got.note, /^Your domain's mail is hosted by /, exchange);
  }
  // Microsoft's note is the work-account one: sign in with Microsoft, and a
  // password only where the tenant still allows IMAP — the same rule the
  // consumer note ends on.
  const m365 = await discoverProvider('nemo@custom.example', {
    resolveMx: async () => [{ priority: 10, exchange: 'contoso-com.mail.protection.outlook.com' }],
    resolveSrv: never,
  });
  assert.match(m365.note, /Sign in with Microsoft/);
  assert.match(m365.note, /administrator has left IMAP on/);
  assert.ok(!/16 September 2024/.test(m365.note), 'the consumer shut-off date is not the story for a tenant');
});

test('discoverProvider falls through to an RFC 6186 SRV record when the MX says nothing it knows', async () => {
  const asked = [];
  const resolveMx = async (name) => { asked.push(name); return [{ priority: 10, exchange: 'mail.deco-associates.example' }]; };
  const resolveSrv = async (name) => {
    asked.push(name);
    return [
      { priority: 10, weight: 0, port: 1993, name: 'backup.deco-associates.example' },
      { priority: 0, weight: 1, port: 993, name: 'Mail.Deco-Associates.example.' },
    ];
  };
  const got = await discoverProvider('marcus@deco-associates.example', { resolveMx, resolveSrv });
  assert.deepEqual(asked, ['deco-associates.example', '_imaps._tcp.deco-associates.example']);
  assert.equal(got.known, false, 'a host is all an SRV record says');
  assert.equal(got.via, 'srv');
  assert.equal(got.label, 'deco-associates.example');
  assert.equal(got.host, 'mail.deco-associates.example');
  assert.equal(got.port, 993);
  assert.equal(got.secure, true);
  assert.equal(got.auth, 'password');
  assert.equal(got.appPasswordUrl, null);
  assert.match(got.note, /^Your domain advertises an IMAP server \(mail\.deco-associates\.example:993\)/);

  // RFC 2782: a target of "." is a domain saying "no such service".
  const refused = await discoverProvider('marcus@deco-associates.example', {
    resolveMx: nxdomain('ENODATA'),
    resolveSrv: async () => [{ priority: 0, weight: 0, port: 0, name: '.' }],
  });
  assert.equal(refused.via, 'guess');
  assert.equal(refused.host, 'imap.deco-associates.example');
});

test('discoverProvider makes the same guess describeProvider does when DNS has nothing, errors or stalls', async () => {
  const address = 'marcus@deco-associates.example';
  const guess = { ...describeProvider(address), via: 'guess' };
  const shapes = {
    'NXDOMAIN on both': { resolveMx: nxdomain('ENOTFOUND'), resolveSrv: nxdomain('ENOTFOUND') },
    'NODATA on both': { resolveMx: nxdomain('ENODATA'), resolveSrv: nxdomain('ENODATA') },
    'a resolver that throws synchronously': { resolveMx: () => { throw new Error('boom'); }, resolveSrv: () => { throw new Error('boom'); } },
    'empty answers': { resolveMx: async () => [], resolveSrv: async () => [] },
    'answers that are not arrays': { resolveMx: async () => null, resolveSrv: async () => 'nope' },
    'an MX nobody here knows and no SRV': { resolveMx: async () => [{ priority: 10, exchange: 'mail.deco-associates.example' }], resolveSrv: nxdomain('ENODATA') },
    'an exchange that is not a host name': { resolveMx: async () => [{ priority: 10, exchange: 'not a host' }], resolveSrv: async () => [] },
  };
  for (const [name, resolvers] of Object.entries(shapes)) {
    assert.deepEqual(await discoverProvider(address, resolvers), guess, name);
  }

  // A resolver that never answers: the timer wins, and the timer is cleared —
  // proved by the call returning in well under the 3 s default.
  const started = Date.now();
  const stalled = await discoverProvider(address, { resolveMx: never, resolveSrv: never, timeoutMs: 20 });
  assert.deepEqual(stalled, guess, 'a stalled resolver is a guess, not a hang');
  assert.ok(Date.now() - started < 1000, 'the timeout is the injected one');

  // Nothing to ask about: no usable domain means no lookup at all.
  const asked = [];
  const spy = async (name) => { asked.push(name); return []; };
  for (const bad of ['', null, 'not-an-email', 'a@localhost', '@', 'a@']) {
    const got = await discoverProvider(bad, { resolveMx: spy, resolveSrv: spy });
    assert.equal(got.host, '', JSON.stringify(bad));
    assert.equal(got.via, 'guess', JSON.stringify(bad));
  }
  assert.deepEqual(asked, [], 'an address with no domain went to the resolver');
});

/* ================================================================== *
 * XOAUTH2 and the device authorization grant
 *
 * Microsoft ended password IMAP for personal Outlook, Hotmail, Live and MSN
 * accounts on 16 September 2024, and app passwords went with it, so the preset
 * this app ships for those domains had no working credential behind it at all.
 * Everything below is the replacement, tested the way the rest of this file is
 * tested: a real socket for the protocol half and a real loopback HTTP server
 * for the token half, with nothing about either client stubbed out.
 * ================================================================== */

/** The SASL field separator. `^A` in every document that describes XOAUTH2. */
const SOH = '\x01';

/** A GUID-shaped client id, because normalizeClientId insists on one. */
const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

/**
 * A mock that speaks AUTH=XOAUTH2 the way Exchange does, including the part
 * that matters: a refused payload is answered with a SECOND continuation
 * carrying base64 JSON, and the tagged completion arrives only after the client
 * acknowledges it.
 *
 * `seen.payload` is the base64 the client sent and `seen.afterChallenge` is the
 * literal line it sent next, so a test can assert on bytes rather than on
 * intentions.
 */
function xoauth2Session({
  user,
  token,
  capability = 'IMAP4rev1 AUTH=XOAUTH2',
  challenge = { status: '400', schemes: 'Bearer', scope: 'https://outlook.office.com/IMAP.AccessAsUser.All' },
  extra = null,
} = {}) {
  const seen = { payload: null, afterChallenge: null, decoded: null };
  let stage = 'idle';
  let authTag = null;

  const handler = (ctx) => {
    const { tag, verb, line, send } = ctx;

    if (stage === 'prompted') {
      seen.payload = line;
      seen.decoded = Buffer.from(line, 'base64').toString('utf8');
      if (seen.decoded === `user=${user}${SOH}auth=Bearer ${token}${SOH}${SOH}`) {
        send(`${authTag} OK AUTHENTICATE completed\r\n`);
        stage = 'done';
        authTag = null;
        return;
      }
      send(`+ ${Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64')}\r\n`);
      stage = 'challenged';
      return;
    }

    if (stage === 'challenged') {
      seen.afterChallenge = line;
      /* RFC 3501 §6.2.2 makes `*` a client-side abort and a conformant server
         answers it, so this mock answers both — the difference is only in what
         it calls the failure. What Microsoft documents as the acknowledgement
         for an XOAUTH2 challenge is an EMPTY line, and that is what the test
         asserts on, because it is the byte that actually went out. */
      send(line === ''
        ? `${authTag} NO AUTHENTICATE failed.\r\n`
        : `${authTag} BAD Authentication aborted.\r\n`);
      stage = 'done';
      authTag = null;
      return;
    }

    switch (verb) {
      case 'CAPABILITY':
        send(`* CAPABILITY ${capability}\r\n${tag} OK CAPABILITY completed\r\n`);
        return;
      case 'AUTHENTICATE':
        authTag = tag;
        stage = 'prompted';
        send('+ \r\n');
        return;
      case 'LOGIN':
        send(`${tag} NO [AUTHENTICATIONFAILED] basic authentication is disabled for this mailbox\r\n`);
        return;
      case 'EXAMINE':
      case 'SELECT':
        send(
          '* 1 EXISTS\r\n'
          + '* OK [UIDVALIDITY 42] UIDs valid\r\n'
          + `${tag} OK [READ-ONLY] EXAMINE completed\r\n`,
        );
        return;
      case 'LIST':
        send(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST completed\r\n`);
        return;
      case 'LOGOUT':
        send(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`);
        return;
      default:
        if (extra && extra(ctx)) return;
        send(`${tag} BAD unexpected command in mock\r\n`);
    }
  };
  handler.seen = seen;
  return handler;
}

/**
 * A mock Microsoft identity platform: the two endpoints the device grant uses,
 * on 127.0.0.1, recording every form it was posted.
 *
 * `pending` is how many `authorization_pending` answers to give before the user
 * "finishes" in their browser, `slowDown` how many `slow_down` answers to give
 * first. `rotate` models the behaviour that makes the write-back mandatory:
 * every redemption of a refresh token invalidates it and issues a new one, and
 * the old one is refused from then on.
 */
async function startMockEntra({
  tenant = 'common',
  clientId = CLIENT_ID,
  pending = 0,
  slowDown = 0,
  interval = 5,
  expiresIn = 3600,
  rotate = true,
  refreshToken = 'refresh-0',
  deviceFailure = null,
  tokenFailure = null,
} = {}) {
  const seen = [];
  let live = refreshToken;
  let issued = 0;
  let polls = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const form = Object.fromEntries(new URLSearchParams(body).entries());
      seen.push({ path: url.pathname, form });

      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };

      if (url.pathname === `/${tenant}/oauth2/v2.0/devicecode`) {
        if (deviceFailure) { send(deviceFailure.status, deviceFailure.body); return; }
        send(200, {
          device_code: 'device-code-secret',
          user_code: 'HXQR-2K9T',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval,
          message: 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code HXQR-2K9T to authenticate.',
        });
        return;
      }

      if (url.pathname !== `/${tenant}/oauth2/v2.0/token`) {
        send(404, { error: 'not_found' });
        return;
      }
      if (tokenFailure) { send(tokenFailure.status, tokenFailure.body); return; }
      if (form.client_id !== clientId) { send(400, { error: 'unauthorized_client' }); return; }

      if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        polls += 1;
        if (polls <= slowDown) { send(400, { error: 'slow_down' }); return; }
        if (polls <= slowDown + pending) { send(400, { error: 'authorization_pending' }); return; }
      } else if (form.grant_type === 'refresh_token') {
        if (form.refresh_token !== live) {
          send(400, {
            error: 'invalid_grant',
            error_description: 'AADSTS70008: the refresh token has expired or been revoked',
          });
          return;
        }
      }

      issued += 1;
      if (rotate) live = `refresh-${issued}`;
      send(200, {
        token_type: 'Bearer',
        scope: MS_IMAP_SCOPES.join(' '),
        expires_in: expiresIn,
        access_token: `access-token-${issued}`,
        refresh_token: live,
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    seen,
    get liveRefreshToken() { return live; },
    async close() { await new Promise((done) => server.close(done)); },
  };
}

/** Records the delays the poll loop ASKS for, without spending them. */
function recordingSleep() {
  const waited = [];
  const sleep = (ms) => { waited.push(ms); return Promise.resolve(); };
  sleep.waited = waited;
  return sleep;
}

let refSeq = 0;
const freshRef = () => `mail.m_xo${(refSeq += 1)}`;

/* ------------------------------------------------------------ the wire */

test('AUTHENTICATE XOAUTH2 puts the documented SASL payload on the wire, and no password', async () => {
  const token = 'EwBwA8l6BAAUs5-access-token-with-no-substring-in-common';
  const handler = xoauth2Session({ user: 'nemo@outlook.com', token });

  await withServer({ greeting: '* OK Zelos mock ready', onCommand: handler }, async ({ port, received }) => {
    const client = new ImapClient({
      host: '127.0.0.1', port, secure: false, user: 'nemo@outlook.com',
      auth: 'xoauth2', accessToken: token, timeoutMs: 5000,
    });
    await client.connect();
    await client.login();

    // The payload, byte for byte. There are TWO trailing separators — the first
    // closes `auth=`, the second closes the empty list of further pairs — and
    // Exchange refuses a payload with one of them using the same opaque
    // challenge it uses for an expired token.
    assert.equal(handler.seen.decoded, `user=nemo@outlook.com${SOH}auth=Bearer ${token}${SOH}${SOH}`);
    assert.equal(handler.seen.payload, xoauth2Payload('nemo@outlook.com', token));

    const sent = commands(received);
    assert.ok(sent.includes('AUTHENTICATE XOAUTH2'), `the mechanism was named on the command line: ${sent.join(' | ')}`);
    assert.ok(!sent.some((c) => /^LOGIN\b/i.test(c)), 'no password path was tried');
    assert.ok(!received.some((line) => line.includes(token)), 'the bearer token never appears outside base64');

    await client.close();
  });
});

test('REGRESSION: a refused XOAUTH2 payload is answered with an empty line, and the challenge is decoded', async () => {
  /* This is the handshake everyone gets wrong. A server that refuses an XOAUTH2
     payload does NOT answer with a tagged NO — it answers with a second
     continuation carrying base64 JSON (`{"status":"400","scope":...}`) and then
     waits. The acknowledgement Microsoft documents is an EMPTY line, and only
     after it does the tagged NO arrive.

     Two things go wrong without it. A client that copies the PLAIN path and
     sends `*` is aborting a request nobody asked it to abort; a client that
     sends nothing at all sits until its own idle timer fires and then reports a
     timeout, which names the wrong problem entirely — the connection was fine
     and the token was not. And in both cases the one thing the server was
     trying to hand over, WHY it refused, is thrown away: `status 400` (expired
     or malformed) and `status 403` (a token with no IMAP scope) are two
     different afternoons behind one identical `NO AUTHENTICATE failed.`

     The assertion is on the byte that went out rather than on the outcome,
     because against a conformant server the outcome is a rejection either way. */
  const handler = xoauth2Session({ user: 'nemo@outlook.com', token: 'the-right-token' });

  await withServer({ greeting: '* OK Zelos mock ready', onCommand: handler }, async ({ port }) => {
    const client = new ImapClient({
      host: '127.0.0.1', port, secure: false, user: 'nemo@outlook.com',
      auth: 'xoauth2', accessToken: 'a-stale-token', timeoutMs: 5000,
    });
    await client.connect();
    await assert.rejects(
      () => client.login(),
      (err) => {
        assert.match(err.message, /IMAP 127\.0\.0\.1:\d+/, 'the error names the host');
        assert.match(err.message, /status 400/, 'the decoded challenge is what says why');
        assert.match(err.message, /IMAP\.AccessAsUser\.All/, 'the scope the server wanted survives too');
        assert.equal(err.reconnect, true, 'a refused token is something the user has to fix, not a retry');
        return true;
      },
    );

    assert.equal(
      handler.seen.afterChallenge,
      '',
      `the client answered the challenge with ${JSON.stringify(handler.seen.afterChallenge)} instead of an empty line`,
    );
    await client.close();
  });
});

test('REGRESSION: a server that echoes the SASL blob does not get to hand the bearer token back', async () => {
  /* The same harm the LOGIN redaction tests above cover, one credential up. A
     bearer token is mail access for the next hour with no second factor in
     front of it, and a server is entitled to quote the line it rejected — real
     ones do. That string is not a screen: it is the body of POST
     /api/mail/test, and it is `sources[].error`, which the sweep writes into
     `runs.stats_json` on disk and re-serves from /api/state forever.

     The base64 blob is the shape the token travels in, so the blob is what has
     to be struck; the raw token is listed alongside it because the failure
     challenge is bytes the server chooses and is the obvious place to reflect
     one back. */
  const token = 'EwBwA8l6BAAU-bearer-9f3a1c-do-not-echo-me';
  const payload = xoauth2Payload('nemo@outlook.com', token);
  // The SASL response is a bare line with no tag of its own, so the mock has to
  // remember the tag AUTHENTICATE arrived under to answer it at all.
  let authTag = null;

  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, line, send }) => {
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1 AUTH=XOAUTH2\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        if (verb === 'AUTHENTICATE') { authTag = tag; send('+ \r\n'); return; }
        // The bare SASL line, quoted straight back in the rejection.
        send(`${authTag ?? tag} NO [AUTHENTICATIONFAILED] rejected: ${line}\r\n`);
      },
    },
    async ({ port, received }) => {
      const result = await testConnection({
        host: '127.0.0.1', port, secure: false, user: 'nemo@outlook.com',
        auth: 'xoauth2', accessToken: token, timeoutMs: 5000,
      });
      assert.equal(result.ok, false);
      assert.ok(received.some((l) => l === payload), 'the fixture must put the real SASL blob on the wire');
      assert.ok(!result.error.includes(payload), `the SASL blob came back intact: ${result.error}`);
      assert.ok(!result.error.includes(token), `the bearer token came back intact: ${result.error}`);
      assert.match(result.error, /<password withheld>/);
      assert.match(result.error, /AUTHENTICATIONFAILED/, 'the diagnosis survives the redaction');
      assert.equal(result.reconnect, true,
        'a refused bearer token is a reconnect — "check your password" is advice about a thing that no longer exists');
    },
  );
});

test('a NO the server calls temporary is not "sign in again"; a refused credential is (TT-3436)', async () => {
  /* The sweep rests an account for six hours on `reconnect`, so it must mean
     the sign-in was turned down — not a backend that said UNAVAILABLE. */
  const token = 'EwBwA8l6BAAUs5-token-for-the-transient-check';
  const answering = (reply) => ({ tag, verb, send }) => {
    if (verb === 'CAPABILITY') { send(`* CAPABILITY IMAP4rev1 AUTH=XOAUTH2\r\n${tag} OK done\r\n`); return; }
    if (verb === 'AUTHENTICATE') { send(`${tag} ${reply}\r\n`); return; }
    if (verb === 'LOGOUT') { send(`* BYE\r\n${tag} OK bye\r\n`); return; }
    send(`${tag} BAD unexpected\r\n`);
  };
  const cases = [
    ['NO [UNAVAILABLE] Temporary authentication failure', false],
    ['NO [THROTTLED 30] Slow down', false],
    ['NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)', true],
    ['NO AUTHENTICATE failed.', true],
  ];
  for (const [reply, reconnect] of cases) {
    await withServer({ greeting: '* OK Zelos mock ready', onCommand: answering(reply) }, async ({ port }) => {
      const result = await testConnection({ host: '127.0.0.1', port, secure: false, user: 'nemo@gmail.com', auth: 'xoauth2', accessToken: token, timeoutMs: 5000 });
      assert.equal(result.ok, false, reply);
      assert.equal(result.reconnect, reconnect, reply);
      if (reconnect) assert.match(result.error, /^This account's sign-in is no longer accepted\. Sign in again/, reply);
      else assert.doesNotMatch(result.error, /Sign in again/, reply);
      assert.ok(!result.error.includes(token), 'the token was echoed');
    });
  }
});

test('a server with no AUTH=XOAUTH2 is refused before the token is offered to it', async () => {
  await withServer(
    {
      greeting: '* OK Zelos mock ready',
      onCommand: ({ tag, verb, send }) => {
        if (verb === 'CAPABILITY') {
          send(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
          return;
        }
        send(`${tag} OK fine\r\n`);
      },
    },
    async ({ port, received }) => {
      const client = new ImapClient({
        host: '127.0.0.1', port, secure: false, user: 'nemo@outlook.com',
        auth: 'xoauth2', accessToken: 'a-perfectly-good-token', timeoutMs: 5000,
      });
      await client.connect();
      await assert.rejects(() => client.login(), /does not offer AUTH=XOAUTH2/);
      assert.ok(!received.some((line) => /AUTHENTICATE/i.test(line)),
        `a token was offered to a server that cannot take one: ${received.join(' | ')}`);
      await client.close();
    },
  );
});

test('an OAuth account with no token says to reconnect instead of trying a blank password', async () => {
  /* The failure this exists to prevent is a quiet one. An OAuth account whose
     token could not be minted has an EMPTY access token, and a client that
     falls back to "well, use the password then" sends Microsoft a LOGIN with a
     blank one. That is a real authentication attempt against a mailbox with
     basic auth switched off, so what comes back is AUTHENTICATIONFAILED — which
     reads as "your credentials are wrong" and sends the user off to re-type a
     password that has not been accepted since September 2024. */
  await withServer(
    { greeting: '* OK Zelos mock ready', onCommand: xoauth2Session({ user: 'u', token: 't' }) },
    async ({ port, received }) => {
      const client = new ImapClient({
        host: '127.0.0.1', port, secure: false, user: 'nemo@outlook.com',
        auth: 'xoauth2', accessToken: '', timeoutMs: 5000,
      });
      await client.connect();
      await assert.rejects(() => client.login(), /reconnect the account/);
      assert.ok(!received.some((line) => /LOGIN|AUTHENTICATE/i.test(line)),
        `something was offered as a credential anyway: ${received.join(' | ')}`);
      await client.close();
    },
  );
});

test('the auth method is named, not guessed, and an unknown one is refused', () => {
  assert.equal(resolveAuthMethod(null, ''), 'password', 'every config written before this says nothing');
  assert.equal(resolveAuthMethod(null, 'tok'), 'xoauth2');
  assert.equal(resolveAuthMethod('xoauth2', ''), 'xoauth2', 'a stated method survives a missing token');
  assert.equal(resolveAuthMethod('password', 'tok'), 'password');
  assert.throws(() => resolveAuthMethod('ntlm', ''), /unknown auth method/);
  assert.equal(new ImapClient({ host: 'imap.example.com' }).auth, 'password');
  assert.equal(new ImapClient({ host: 'imap.example.com', accessToken: 'tok' }).auth, 'xoauth2');
});

test('xoauth2Payload refuses a field carrying the SASL separator', () => {
  // The separator is what delimits the fields, so a username or token holding
  // one would append key/value pairs of somebody else's choosing to our
  // authentication request.
  assert.equal(
    Buffer.from(xoauth2Payload('a@b.example', 'tok'), 'base64').toString('utf8'),
    `user=a@b.example${SOH}auth=Bearer tok${SOH}${SOH}`,
  );
  assert.throws(() => xoauth2Payload(`a@b.example${SOH}auth=Bearer stolen`, 'tok'), /separator or a line break/);
  assert.throws(() => xoauth2Payload('a@b.example', `tok${SOH}x=y`), /separator or a line break/);
  assert.throws(() => xoauth2Payload('a@b.example', 'tok\r\nA1 LOGOUT'), /separator or a line break/);
  assert.throws(() => xoauth2Payload('a@b.example', ''), /access token is required/);
});

test('a challenge that is not JSON, or not anything, degrades without throwing', () => {
  assert.equal(describeXOAuth2Challenge(Buffer.from('{"status":"401"}').toString('base64')), 'status 401');
  assert.equal(describeXOAuth2Challenge(Buffer.from('service unavailable').toString('base64')), 'service unavailable');
  assert.equal(describeXOAuth2Challenge(''), null);
  assert.equal(describeXOAuth2Challenge(null), null);
  assert.equal(describeXOAuth2Challenge(Buffer.from('{}').toString('base64')), null);
});

/* ------------------------------------------------------- the device grant */

test('the device grant hands back a code to type, then stores the refresh token and nothing else', async () => {
  const entra = await startMockEntra({ pending: 2 });
  const ref = freshRef();
  const shown = [];
  const sleep = recordingSleep();
  try {
    const result = await connectDeviceCode({
      clientId: CLIENT_ID,
      tenantId: 'common',
      tokenRef: ref,
      endpoint: entra.origin,
      onCode: (code) => shown.push(code),
      sleep,
    });

    assert.equal(shown.length, 1);
    assert.equal(shown[0].userCode, 'HXQR-2K9T');
    assert.equal(shown[0].verificationUri, 'https://microsoft.com/devicelogin');
    assert.match(shown[0].message, /devicelogin/, "Microsoft's own localised sentence is passed through");
    assert.ok(!JSON.stringify(shown[0]).includes('device-code-secret'),
      'the device code is a credential and is not for showing');

    assert.equal(result.ok, true);
    assert.equal(result.hasRefreshToken, true);
    assert.ok(!Object.values(result).some((v) => typeof v === 'string' && v.startsWith('access-token-')),
      'the caller is told there is a token, never handed one');

    // The scope has to be asked for, or there is no refresh token to store.
    const devicecode = entra.seen.find((r) => r.path.endsWith('/devicecode'));
    assert.match(devicecode.form.scope, /IMAP\.AccessAsUser\.All/);
    assert.match(devicecode.form.scope, /\boffline_access\b/,
      'without offline_access Microsoft returns no refresh token and the account dies in an hour');
    assert.ok(!('client_secret' in devicecode.form), 'a public client sends no secret');

    // Where it lives: the secret store, under the account's own keyRef.
    const stored = JSON.parse(await getSecret(ref));
    assert.equal(stored.kind, 'xoauth2');
    assert.equal(stored.refreshToken, entra.liveRefreshToken);
    assert.equal(stored.accessToken, 'access-token-1');
    assert.ok(!(await getSecret(ref)).includes('\n'), 'the blob has to be one line for the macOS keychain');

    // Two pending answers, three polls, and the interval the server asked for.
    assert.deepEqual(sleep.waited, [5000, 5000, 5000]);
  } finally {
    await entra.close();
  }
});

test('REGRESSION: slow_down adds five seconds to the interval instead of being ignored', async () => {
  /* RFC 8628 §3.5 is explicit: `slow_down` means the client must increase its
     polling interval by five seconds, not merely keep polling. A loop that
     treats it as a synonym for `authorization_pending` keeps hammering at the
     rate the server has just said is too fast, and the identity platform
     answers that by refusing the device code outright — so the user, who is
     doing everything right in their browser, watches the sign-in fail for
     reasons that are entirely ours.

     Asserted on the delays the loop ASKS for rather than on a clock: the floor
     is five seconds and each slow_down adds five more, so proving this with a
     real timer would cost most of a minute and would therefore have been
     written not to prove it. */
  const entra = await startMockEntra({ slowDown: 2, pending: 1 });
  const sleep = recordingSleep();
  try {
    const pending = await beginDeviceAuthorization({
      clientId: CLIENT_ID, tenantId: 'common', endpoint: entra.origin,
    });
    const tokens = await pollForDeviceToken(pending, { sleep });
    assert.equal(tokens.accessToken, 'access-token-1');
    assert.deepEqual(sleep.waited, [5000, 10000, 15000, 15000],
      'each slow_down adds five seconds; authorization_pending changes nothing');
  } finally {
    await entra.close();
  }
});

test('a declined sign-in stops polling and says the user has to start again', async () => {
  const entra = await startMockEntra({
    tokenFailure: { status: 400, body: { error: 'authorization_declined', error_description: 'the user declined' } },
  });
  const sleep = recordingSleep();
  try {
    await assert.rejects(
      () => connectDeviceCode({
        clientId: CLIENT_ID, tenantId: 'common', tokenRef: freshRef(), endpoint: entra.origin, sleep,
      }),
      (err) => {
        assert.ok(err instanceof ImapOAuthError);
        assert.equal(err.code, 'authorization_declined');
        assert.equal(err.reconnect, true);
        return true;
      },
    );
    const polls = entra.seen.filter((r) => r.path.endsWith('/token'));
    assert.equal(polls.length, 1, 'a declined grant is not polled again');
  } finally {
    await entra.close();
  }
});

test('a device code that expires before it is typed is not polled forever', async () => {
  const entra = await startMockEntra({ pending: 10_000 });
  const sleep = recordingSleep();
  try {
    let clock = Date.parse('2026-08-11T09:00:00Z');
    const pending = await beginDeviceAuthorization({
      clientId: CLIENT_ID, tenantId: 'common', endpoint: entra.origin, now: clock,
    });
    await assert.rejects(
      () => pollForDeviceToken(pending, {
        sleep: (ms) => { clock += ms; return sleep(ms); },
        now: () => clock,
      }),
      (err) => {
        assert.equal(err.code, 'expired_token');
        assert.equal(err.reconnect, true);
        return true;
      },
    );
    // 900 seconds of life at five seconds a poll: bounded, and the bound is the
    // server's own expiry rather than a number this file invented.
    assert.equal(sleep.waited.length, 180);
  } finally {
    await entra.close();
  }
});

/* ------------------------------------------------------------- refreshing */

test('REGRESSION: a refresh stores the rotated refresh token, or the account works exactly once', async () => {
  /* Microsoft rotates: every redemption of a refresh token invalidates it and
     the response carries a replacement. A version of this that returned the new
     access token without writing the new refresh token back works perfectly the
     first time and then hands Microsoft a dead token on every sweep after it,
     for an `invalid_grant` the user has no way to interpret — an account that
     appears to connect and then quietly goes stale.

     The mock refuses anything but the current token, so the second refresh below
     is the assertion: it can only succeed if the first one was stored. */
  const entra = await startMockEntra({ refreshToken: 'refresh-0' });
  const ref = freshRef();
  try {
    await saveOAuthTokens(ref, {
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-0',
      tokenType: 'Bearer',
      scope: MS_IMAP_SCOPES.join(' '),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      obtainedAt: new Date(Date.now() - 3_660_000).toISOString(),
    });

    const first = await accessTokenFor({
      clientId: CLIENT_ID, tenantId: 'common', tokenRef: ref, endpoint: entra.origin,
    });
    assert.equal(first.refreshed, true);
    assert.equal(first.accessToken, 'access-token-1');
    assert.equal((await loadOAuthTokens(ref)).refreshToken, 'refresh-1', 'the rotated token was written back');

    // A second sweep, an hour later. This is the call that used to fail.
    const second = await accessTokenFor({
      clientId: CLIENT_ID, tenantId: 'common', tokenRef: ref, endpoint: entra.origin,
      now: Date.now() + 3_600_000,
    });
    assert.equal(second.refreshed, true);
    assert.equal(second.accessToken, 'access-token-2');
    assert.equal((await loadOAuthTokens(ref)).refreshToken, 'refresh-2');
  } finally {
    await entra.close();
  }
});

test('a token that is still good is not refreshed, and one a minute from death is', async () => {
  const entra = await startMockEntra();
  const ref = freshRef();
  try {
    const now = Date.parse('2026-08-11T09:00:00Z');
    await saveOAuthTokens(ref, {
      accessToken: 'still-good',
      refreshToken: 'refresh-0',
      expiresAt: new Date(now + 600_000).toISOString(),
    });
    const fresh = await accessTokenFor({
      clientId: CLIENT_ID, tenantId: 'common', tokenRef: ref, endpoint: entra.origin, now,
    });
    assert.equal(fresh.refreshed, false);
    assert.equal(fresh.accessToken, 'still-good');
    assert.deepEqual(entra.seen, [], 'a live token costs no round trip');

    // Inside the skew: treated as spent, so a fetch never races its own expiry
    // across the wire.
    const soon = await accessTokenFor({
      clientId: CLIENT_ID, tenantId: 'common', tokenRef: ref, endpoint: entra.origin,
      now: now + 600_000 - 30_000,
    });
    assert.equal(soon.refreshed, true);
  } finally {
    await entra.close();
  }
});

test('REGRESSION: invalid_grant is a reconnect, and a 503 is not', async () => {
  /* The two failures that look alike from a distance and are nothing alike.
     `invalid_grant` is what Microsoft returns when the refresh token was
     revoked, the password changed, a conditional-access policy changed, or 90
     days of inactivity expired it — permanent, every one, until a human does
     something. A server error is the next sweep's problem and nobody else's.
     Undifferentiated, the first becomes a mailbox that silently stops updating
     while the sweep dials Microsoft every fifteen minutes forever to be told
     the same thing. */
  const dead = await startMockEntra({
    tokenFailure: {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'AADSTS50173: the token was revoked' },
    },
  });
  try {
    await assert.rejects(
      () => refreshAccessToken({
        clientId: CLIENT_ID, tenantId: 'common', refreshToken: 'refresh-0', endpoint: dead.origin,
      }),
      (err) => {
        assert.equal(err.code, 'invalid_grant');
        assert.equal(err.reconnect, true, 'the user has to reconnect; retrying can never work');
        assert.match(err.message, /AADSTS50173/, "Microsoft's own diagnosis survives");
        return true;
      },
    );
  } finally {
    await dead.close();
  }

  const flaky = await startMockEntra({ tokenFailure: { status: 503, body: { error: 'temporarily_unavailable' } } });
  try {
    await assert.rejects(
      () => refreshAccessToken({
        clientId: CLIENT_ID, tenantId: 'common', refreshToken: 'refresh-0', endpoint: flaky.origin,
      }),
      (err) => {
        assert.equal(err.reconnect, false, 'a bad afternoon at Microsoft is not a broken account');
        return true;
      },
    );
  } finally {
    await flaky.close();
  }
});

test('an account that was never connected reads as not connected, not as a broken grant', async () => {
  /* The grant is filed under the account's own `keyRef` — the same ref the
     password used to live at, so that removing the account removes the refresh
     token with it rather than leaving a live credential behind. That sharing is
     the reason `kind` is checked and not merely `typeof`: an account carried
     over from the password era has a PASSWORD sitting at that ref, and a
     password is whatever the user's password manager generated. Most of them
     fail to parse, but `{"note":"exported"}` is a legal password and parses into
     a perfectly good object with no tokens in it — which would then be treated
     as a connected account whose refresh token is `undefined`, and the user
     would be told their grant was rejected rather than that they never made
     one. */
  const plain = freshRef();
  await setSecret(plain, 'hunter2');
  assert.equal(await loadOAuthTokens(plain), null);

  const ref = freshRef();
  await setSecret(ref, '{"note":"exported from my password manager"}');
  assert.equal(await loadOAuthTokens(ref), null, 'a password that happens to be JSON is still a password');

  await assert.rejects(
    () => accessTokenFor({ clientId: CLIENT_ID, tenantId: 'common', tokenRef: ref, endpoint: MS_LOGIN_ORIGIN }),
    (err) => {
      assert.equal(err.code, 'not_connected');
      assert.equal(err.reconnect, true);
      return true;
    },
  );
});

/* ------------------------------------------------- where the token may go */

test('REGRESSION: a tenant that is not a tenant never reaches the network', async () => {
  /* The tenant is the one piece of user input that becomes a URL PATH SEGMENT.
     `${origin}/${tenant}/oauth2/v2.0/token` with `..` in it resolves — silently,
     with no error anywhere — to a different endpoint on the same host, and what
     goes to that endpoint is the refresh token, which is the whole account. So
     the tenant is a closed set: three aliases, a GUID, or a domain. */
  for (const bad of ['..', '../..', 'common/../../evil', 'a b', 'tenant?x=1', 'tenant#f', '%2e%2e', 'tenant/']) {
    assert.throws(() => normalizeTenant(bad), (err) => {
      assert.equal(err.code, 'bad_tenant');
      return true;
    }, `${JSON.stringify(bad)} was accepted as a tenant`);
  }
  for (const good of ['common', 'CONSUMERS', 'organizations',
    '72f988bf-86f1-41af-91ab-2d7cd011db47', 'contoso.onmicrosoft.com']) {
    assert.equal(typeof normalizeTenant(good), 'string');
  }
  assert.equal(normalizeTenant(''), 'common', 'nothing said means the alias that accepts either kind of account');

  const entra = await startMockEntra();
  try {
    await assert.rejects(
      () => beginDeviceAuthorization({ clientId: CLIENT_ID, tenantId: '../../evil', endpoint: entra.origin }),
      /is not a Microsoft tenant/,
    );
    assert.deepEqual(entra.seen, [], 'a request went out on a tenant that was refused');
  } finally {
    await entra.close();
  }
});

test('REGRESSION: a refresh token is only ever spent against Microsoft or loopback', async () => {
  /* A configurable token endpoint is a one-field exfiltration route for the most
     valuable secret this app holds, so it is a check rather than a default.
     Only the ORIGIN survives — a path, query or fragment on the end is dropped
     rather than honoured, which is what makes the tenant check above sufficient:
     the host cannot be moved from the path. */
  assert.equal(assertTokenEndpoint(MS_LOGIN_ORIGIN), MS_LOGIN_ORIGIN);
  assert.equal(assertTokenEndpoint('https://login.microsoftonline.com/anything?x=1#f'), MS_LOGIN_ORIGIN);
  assert.equal(assertTokenEndpoint('http://127.0.0.1:9/x'), 'http://127.0.0.1:9');

  for (const bad of [
    'https://login.microsoftonline.com.evil.example',
    'https://evil.example',
    'https://login.microsoftonline.com@evil.example',
    'not-a-url',
    '',
  ]) {
    assert.throws(() => assertTokenEndpoint(bad), (err) => {
      assert.equal(err.code, 'bad_endpoint');
      return true;
    }, `${JSON.stringify(bad)} was accepted as a sign-in endpoint`);
  }

  // And the check stands in front of the network rather than beside it.
  let dialled = 0;
  await assert.rejects(
    () => refreshAccessToken({
      clientId: CLIENT_ID,
      tenantId: 'common',
      refreshToken: 'refresh-0',
      endpoint: 'https://evil.example',
      fetchImpl: () => { dialled += 1; throw new Error('unreachable'); },
    }),
    /refusing to send a refresh token/,
  );
  assert.equal(dialled, 0);
});

test('a client id that is not a GUID is refused before anything is sent', () => {
  assert.equal(normalizeClientId(' 11111111-2222-3333-4444-555555555555 '), CLIENT_ID);
  for (const bad of ['', 'my-app', 'https://evil.example/app', '1111-2222']) {
    assert.throws(() => normalizeClientId(bad), (err) => {
      assert.ok(err instanceof ImapOAuthError);
      assert.equal(err.code, 'not_configured');
      return true;
    }, `${JSON.stringify(bad)} was accepted as a client id`);
  }
});

/* ------------------------------------------------------------- end to end */

test('fetchRecent signs in with the stored Microsoft grant and reads the mailbox over XOAUTH2', async () => {
  /* The whole path in one test: an expired grant in the secret store, a refresh
     against the identity platform, and the minted token presented to the mail
     server as XOAUTH2 — with no password anywhere in it, and every other byte
     of the session exactly what it was before. */
  const entra = await startMockEntra();
  const ref = freshRef();
  const headers = [
    'From: Marcus Reyes <marcus@riverstone.example>',
    'Subject: Change order',
    'Date: Tue, 11 Aug 2026 09:15:00 -0400',
    'Message-ID: <ms1@riverstone.example>',
    '',
    '',
  ].join('\r\n');

  const box = mailbox([{
    uid: 501,
    internalDate: '11-Aug-2026 09:15:00 -0400',
    structure: PLAIN_TEXT_STRUCTURE,
    headers,
    parts: { 1: 'Numbers are firm.\r\n' },
  }]);
  const handler = xoauth2Session({ user: 'nemo@outlook.com', token: 'access-token-1', extra: box });

  try {
    await saveOAuthTokens(ref, {
      accessToken: 'long-expired',
      refreshToken: 'refresh-0',
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    });

    await withServer(
      { greeting: '* OK Zelos mock ready', onCommand: handler },
      async ({ port, received }) => {
        const messages = await fetchRecent({
          host: '127.0.0.1',
          port,
          secure: false,
          user: 'nemo@outlook.com',
          auth: 'xoauth2',
          oauth: { clientId: CLIENT_ID, tenantId: 'common', tokenRef: ref, endpoint: entra.origin },
          timeoutMs: 5000,
        });

        assert.equal(messages.length, 1);
        assert.equal(messages[0].subject, 'Change order');
        assert.equal(messages[0].text, 'Numbers are firm.');

        // The token on the wire is the one that was just minted, not the stale
        // one that was in the store.
        assert.equal(handler.seen.decoded, `user=nemo@outlook.com${SOH}auth=Bearer access-token-1${SOH}${SOH}`);
        const sent = commands(received);
        assert.ok(sent.includes('AUTHENTICATE XOAUTH2'));
        assert.ok(!sent.some((c) => /^LOGIN\b/i.test(c)), 'an OAuth account never tries a password');
        assert.ok(sent.some((c) => c === 'EXAMINE "INBOX"'), 'and the rest of the session is unchanged');
        assert.ok(sent.some((c) => c.includes('BODY.PEEK[')), 'still read-only');
      },
    );

    assert.equal((await loadOAuthTokens(ref)).refreshToken, 'refresh-1', 'the rotation survived the sweep');
  } finally {
    await entra.close();
  }
});

test('an OAuth account that was never connected fails before a socket is opened', async () => {
  await withServer(
    { greeting: '* OK Zelos mock ready', onCommand: xoauth2Session({ user: 'u', token: 't' }) },
    async ({ port, connections }) => {
      await assert.rejects(
        () => fetchRecent({
          host: '127.0.0.1', port, secure: false, user: 'nemo@outlook.com',
          auth: 'xoauth2',
          oauth: { clientId: CLIENT_ID, tenantId: 'common', tokenRef: freshRef(), endpoint: MS_LOGIN_ORIGIN },
          timeoutMs: 5000,
        }),
        (err) => {
          assert.equal(err.code, 'not_connected');
          assert.equal(err.reconnect, true);
          return true;
        },
      );
      assert.deepEqual(connections, [], 'the mail server was never dialled for an account with no grant');
    },
  );
});

test('the Outlook preset stops recommending a password that has not worked since 2024', () => {
  /* The note is the whole user-facing half of this defect. What shipped said
     Microsoft "is retiring" password IMAP and to try an app password if
     two-step verification was on — a sentence that had been false for eleven
     months by the time anyone read it, and that sent every one of these users
     off to mint a credential Microsoft would refuse. */
  const appPassword = /app[- ]?(specific[- ])?password/i;
  for (const domain of ['outlook.com', 'hotmail.com', 'live.com', 'msn.com']) {
    const guess = guessImapHost(`nemo@${domain}`);
    assert.equal(guess.host, 'outlook.office365.com');
    assert.match(guess.note, /16 September 2024/, `${domain}: the note has to name the date`);
    assert.match(guess.note, /devicelogin/, `${domain}: and the way in that still works`);
    assert.ok(
      !appPassword.test(guess.note.replace(/app passwords no longer work[^.]*\./i, '')),
      `${domain}: the note still recommends an app password: ${guess.note}`,
    );
  }
});

/* ================================================================== *
 * Sign in with Google: the same stored grant, renewed at Google
 *
 * The browser half lives in core/server.mjs and is tested there. What this
 * file owns is what the two providers share after the browser is gone — the
 * grant under `keyRef`, its renewal, and the bearer token on the wire — and
 * the one thing that differs: where the refresh token is spent, and with what.
 * ================================================================== */

const GOOGLE_CLIENT_ID = '4242-zelos-test.apps.googleusercontent.com';

/**
 * A mock of Google's token endpoint on 127.0.0.1: one path, one grant type,
 * no rotation. `secret` is what a "Desktop app" client is expected to carry;
 * blank means the client has none and the mock does not ask.
 */
async function startMockGoogleToken({
  clientId = GOOGLE_CLIENT_ID,
  secret = '',
  expiresIn = 3600,
  refreshToken = '1//refresh-fixture',
} = {}) {
  const seen = [];
  let issued = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const form = Object.fromEntries(new URLSearchParams(body).entries());
      seen.push({ path: url.pathname, form });
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (url.pathname !== '/token') { send(404, { error: 'not_found' }); return; }
      if (form.client_id !== clientId) { send(401, { error: 'invalid_client' }); return; }
      if (secret && form.client_secret !== secret) {
        send(401, { error: 'invalid_client', error_description: 'client_secret is missing' });
        return;
      }
      if (form.grant_type !== 'refresh_token' || form.refresh_token !== refreshToken) {
        send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return;
      }
      issued += 1;
      // As Google does: a new access token, the scope, and no refresh token.
      send(200, { access_token: `ya29.access-${issued}`, token_type: 'Bearer', expires_in: expiresIn, scope: 'https://mail.google.com/' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    tokenUrl: `http://127.0.0.1:${server.address().port}/token`,
    seen,
    async close() { await new Promise((done) => server.close(done)); },
  };
}

const longAgo = () => new Date(Date.now() - 3_600_000).toISOString();

test('describeProvider names the browser sign-in a provider has, beside the password it still takes', () => {
  for (const address of ['nemo@gmail.com', 'Nemo@GoogleMail.com']) {
    const got = describeProvider(address);
    assert.equal(got.signIn, 'google', address);
    assert.equal(got.auth, 'password', `${address}: a password stays a way in for Gmail`);
    assert.match(got.note, /Sign in with Google/);
  }
  for (const domain of ['outlook.com', 'hotmail.com', 'live.com', 'msn.com']) {
    const got = describeProvider(`nemo@${domain}`);
    assert.equal(got.signIn, 'microsoft', domain);
    assert.equal(got.auth, 'xoauth2', `${domain}: and no password at all`);
  }
  for (const address of [
    'nemo@icloud.com', 'nemo@yahoo.com', 'nemo@fastmail.com', 'nemo@pm.me', 'nemo@aol.com', 'nemo@zoho.com',
    'marcus@deco-associates.example', '', 'not-an-email', null,
  ]) {
    const got = describeProvider(address);
    assert.equal(got.signIn, null, JSON.stringify(address));
    assert.ok('signIn' in got, `${JSON.stringify(address)}: the field is always present, so the form never reads undefined`);
  }
});

test('discoverProvider carries the sign-in through an MX answer: Workspace is Google, 365 is Microsoft, the rest have none', async () => {
  const mx = (exchange) => ({ resolveMx: async () => [{ priority: 10, exchange }], resolveSrv: async () => [] });
  const workspace = await discoverProvider('nemo@custom.example', mx('aspmx.l.google.com.'));
  assert.equal(workspace.signIn, 'google');
  assert.equal(workspace.label, 'Google Workspace');
  const tenant = await discoverProvider('nemo@custom.example', mx('custom-example.mail.protection.outlook.com.'));
  assert.equal(tenant.signIn, 'microsoft');
  assert.equal(tenant.label, 'Microsoft 365');
  assert.equal((await discoverProvider('nemo@custom.example', mx('in1-smtp.messagingengine.com.'))).signIn, null);

  const srv = { resolveMx: async () => [], resolveSrv: async () => [{ priority: 0, name: 'imap.custom.example', port: 993 }] };
  const own = await discoverProvider('nemo@custom.example', srv);
  assert.equal(own.via, 'srv');
  assert.equal(own.signIn, null);
  const nothing = {
    resolveMx: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); },
    resolveSrv: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); },
  };
  const guessed = await discoverProvider('nemo@custom.example', nothing);
  assert.equal(guessed.via, 'guess');
  assert.equal(guessed.signIn, null);
});

test('accessTokenFor on a Google account renews at Google with the stored secret, keeps the refresh token, and honours the cache', async () => {
  const google = await startMockGoogleToken({ secret: 'GOCSPX-fixture-not-a-real-secret' });
  const ref = freshRef();
  const secretRef = `oauth.google.t${refSeq}`;
  try {
    await setSecret(secretRef, 'GOCSPX-fixture-not-a-real-secret');
    await saveOAuthTokens(ref, { accessToken: 'spent', refreshToken: '1//refresh-fixture', expiresAt: longAgo() });
    const args = { provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecretRef: secretRef, tokenRef: ref, tokenUrl: google.tokenUrl };

    const first = await accessTokenFor(args);
    assert.equal(first.accessToken, 'ya29.access-1');
    assert.equal(first.refreshed, true);
    assert.equal(google.seen.length, 1);
    const { form } = google.seen[0];
    assert.equal(form.grant_type, 'refresh_token');
    assert.equal(form.client_id, GOOGLE_CLIENT_ID);
    assert.equal(form.client_secret, 'GOCSPX-fixture-not-a-real-secret', 'the secret came from the store, not from the caller');
    assert.equal(form.refresh_token, '1//refresh-fixture');
    assert.equal(form.scope, undefined, 'Google is not re-asked for a scope on a refresh');

    // Written back in the one shape every reader of the ref understands.
    const stored = await loadOAuthTokens(ref);
    assert.equal(stored.kind, 'xoauth2');
    assert.equal(stored.accessToken, 'ya29.access-1');
    assert.equal(stored.refreshToken, '1//refresh-fixture', 'Google does not rotate, so the one that was sent is kept');
    assert.equal(stored.scope, 'https://mail.google.com/');

    // Fresh for an hour: no request.
    const second = await accessTokenFor(args);
    assert.equal(second.accessToken, 'ya29.access-1');
    assert.equal(second.refreshed, false);
    assert.equal(google.seen.length, 1);

    // Spent a minute early, so a session never races its own expiry.
    const third = await accessTokenFor({ ...args, now: Date.parse(stored.expiresAt) - 30_000 });
    assert.equal(third.accessToken, 'ya29.access-2');
    assert.equal(third.refreshed, true);
    assert.equal(google.seen.length, 2);
  } finally {
    await google.close();
  }
});

test('a Google client with no secret sends none, and the refresh token goes to Google or loopback and nowhere else', async () => {
  const google = await startMockGoogleToken();
  const ref = freshRef();
  try {
    await saveOAuthTokens(ref, { accessToken: 'spent', refreshToken: '1//refresh-fixture', expiresAt: longAgo() });
    const got = await accessTokenFor({
      provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecretRef: `oauth.google.nothing${refSeq}`, tokenRef: ref, tokenUrl: google.tokenUrl,
    });
    assert.equal(got.accessToken, 'ya29.access-1');
    assert.equal(google.seen[0].form.client_secret, undefined, 'nothing under the ref, nothing on the wire');

    assert.equal(GOOGLE_TOKEN_ORIGIN, 'https://oauth2.googleapis.com');
    assert.equal(assertGoogleTokenEndpoint(null), 'https://oauth2.googleapis.com/token');
    assert.equal(assertGoogleTokenEndpoint(''), 'https://oauth2.googleapis.com/token');
    assert.equal(assertGoogleTokenEndpoint(google.tokenUrl), google.tokenUrl, 'loopback keeps its path');
    for (const bad of [
      'https://oauth2.googleapis.com.evil.example/token',
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      'http://oauth2.googleapis.com/token',
      'https://accounts.google.com/o/oauth2/token',
      'not a url',
    ]) {
      assert.throws(() => assertGoogleTokenEndpoint(bad), (err) => err.code === 'bad_endpoint', bad);
    }
    await assert.rejects(
      () => accessTokenFor({
        provider: 'google', clientId: GOOGLE_CLIENT_ID, tokenRef: ref,
        tokenUrl: 'https://oauth2.googleapis.com.evil.example/token', now: Date.now() + 7_200_000,
      }),
      (err) => err.code === 'bad_endpoint',
    );
    assert.equal(google.seen.length, 1, 'and the refusal came before any request');

    // A GUID check would refuse every real Google client id.
    assert.equal(normalizeGoogleClientId(`  ${GOOGLE_CLIENT_ID} `), GOOGLE_CLIENT_ID);
    for (const bad of ['', '   ', null, 'has space.apps.googleusercontent.com', 'a'.repeat(201), 'tab\tid']) {
      assert.throws(() => normalizeGoogleClientId(bad), (err) => err.code === 'not_configured', JSON.stringify(bad));
    }
  } finally {
    await google.close();
  }
});

test('a revoked Google grant is the reconnect case, and an account with no provider is still Microsoft', async () => {
  const google = await startMockGoogleToken({ refreshToken: '1//the-live-one' });
  const entra = await startMockEntra();
  try {
    const ref = freshRef();
    await saveOAuthTokens(ref, { accessToken: 'spent', refreshToken: '1//revoked', expiresAt: longAgo() });
    await assert.rejects(
      () => accessTokenFor({ provider: 'google', clientId: GOOGLE_CLIENT_ID, tokenRef: ref, tokenUrl: google.tokenUrl }),
      (err) => {
        assert.ok(err instanceof ImapOAuthError);
        assert.equal(err.code, 'invalid_grant');
        assert.equal(err.reconnect, true, 'the flag every caller acts on: connect the account again');
        return true;
      },
    );
    await assert.rejects(
      () => accessTokenFor({ provider: 'google', clientId: GOOGLE_CLIENT_ID, tokenRef: freshRef(), tokenUrl: google.tokenUrl }),
      (err) => err.code === 'not_connected' && err.reconnect === true && /Google/.test(err.message),
    );

    // No provider: the block is read as it always was — a GUID, against Entra.
    const msRef = freshRef();
    await saveOAuthTokens(msRef, { accessToken: 'spent', refreshToken: 'refresh-0', expiresAt: longAgo() });
    const ms = await accessTokenFor({ clientId: CLIENT_ID, tenantId: 'common', tokenRef: msRef, endpoint: entra.origin });
    assert.equal(ms.accessToken, 'access-token-1');
    assert.equal(entra.seen.at(-1).path, '/common/oauth2/v2.0/token');
    await assert.rejects(
      () => accessTokenFor({ clientId: GOOGLE_CLIENT_ID, tokenRef: msRef, endpoint: entra.origin }),
      (err) => err.code === 'not_configured',
      'with no provider, a Google-shaped id is a paste that went wrong',
    );
  } finally {
    await entra.close();
    await google.close();
  }
});

test('a Google secret filed under the shared ref is still found when the account names a scoped one', async () => {
  const google = await startMockGoogleToken({ secret: 'GOCSPX-fixture-not-a-real-secret' });
  const ref = freshRef();
  try {
    /* An account connected before per-client refs existed has its secret
       under the shared name; the sweep now asks for the client's own ref
       first. Falling back to the shared name is what keeps that account
       refreshing after the update. */
    await setSecret('oauth.google.clientSecret', 'GOCSPX-fixture-not-a-real-secret');
    await saveOAuthTokens(ref, { accessToken: 'spent', refreshToken: '1//refresh-fixture', expiresAt: longAgo() });
    const got = await accessTokenFor({
      provider: 'google', clientId: GOOGLE_CLIENT_ID, clientSecretRef: `oauth.google.clientSecret.scoped${refSeq}`, tokenRef: ref, tokenUrl: google.tokenUrl,
    });
    assert.equal(got.accessToken, 'ya29.access-1');
    assert.equal(google.seen[0].form.client_secret, 'GOCSPX-fixture-not-a-real-secret', 'the shared ref answers when the scoped one is empty');
  } finally {
    await deleteSecret('oauth.google.clientSecret').catch(() => {});
    await google.close();
  }
});

test('fetchRecent signs in to a Google mailbox with the stored grant over XOAUTH2, and the session is otherwise the Microsoft one', async () => {
  const google = await startMockGoogleToken();
  const ref = freshRef();
  const headers = [
    'From: Marcus Reyes <marcus@riverstone.example>',
    'Subject: Change order',
    'Date: Tue, 11 Aug 2026 09:15:00 -0400',
    'Message-ID: <g1@riverstone.example>',
    '',
    '',
  ].join('\r\n');
  const box = mailbox([{
    uid: 701,
    internalDate: '11-Aug-2026 09:15:00 -0400',
    structure: PLAIN_TEXT_STRUCTURE,
    headers,
    parts: { 1: 'Numbers are firm.\r\n' },
  }]);
  const handler = xoauth2Session({ user: 'nemo@gmail.com', token: 'ya29.access-1', extra: box });
  const progress = [];

  try {
    await saveOAuthTokens(ref, { accessToken: 'spent', refreshToken: '1//refresh-fixture', expiresAt: longAgo() });
    await withServer({ greeting: '* OK Zelos mock ready', onCommand: handler }, async ({ port, received }) => {
      const messages = await fetchRecent({
        host: '127.0.0.1',
        port,
        secure: false,
        user: 'nemo@gmail.com',
        auth: 'xoauth2',
        oauth: { provider: 'google', clientId: GOOGLE_CLIENT_ID, tokenRef: ref, tokenUrl: google.tokenUrl },
        timeoutMs: 5000,
        onProgress: (p) => progress.push(p.message),
      });
      assert.equal(messages.length, 1);
      assert.equal(messages[0].subject, 'Change order');
      assert.equal(handler.seen.decoded, `user=nemo@gmail.com${SOH}auth=Bearer ya29.access-1${SOH}${SOH}`);
      const sent = commands(received);
      assert.ok(sent.includes('AUTHENTICATE XOAUTH2'));
      assert.ok(!sent.some((c) => /^LOGIN\b/i.test(c)), 'a Google account never tries a password');
      assert.ok(sent.some((c) => c === 'EXAMINE "INBOX"'), 'and the rest of the session is unchanged');
    });
    assert.ok(progress.includes('Renewing the Google sign-in'), progress.join(' | '));
    assert.equal(google.seen.length, 1);

    // The test button takes the same path, and a dead grant comes back as
    // "connect it again" rather than "check your password".
    const dead = await startMockGoogleToken({ refreshToken: '1//some-other-grant' });
    try {
      const result = await testConnection({
        host: '127.0.0.1', port: 1, secure: false, user: 'nemo@gmail.com', auth: 'xoauth2',
        oauth: { provider: 'google', clientId: GOOGLE_CLIENT_ID, tokenRef: ref, tokenUrl: dead.tokenUrl, now: Date.now() + 7_200_000 },
        timeoutMs: 1000,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reconnect, true);
      assert.match(result.error, /invalid_grant/);
    } finally {
      await dead.close();
    }
  } finally {
    await google.close();
  }
});
