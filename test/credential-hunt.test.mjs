/**
 * test/credential-hunt.test.mjs — every route, hunted for every stored secret.
 *
 * test/server.test.mjs's "no route returns a stored secret" asked ten routes,
 * and nothing tied that list to the routing table, so a new route was never
 * hunted (QA, 2026-10-10, TT-3527). This file plants a distinct secret for each
 * kind of credential Zelos holds, asks every route in core/server.mjs's table
 * plus /api/mcp with a request that gets past validation, and then looks for
 * each secret, in several spellings, in every status line, header, body and
 * stream frame, and in everything the server logged. A guard executes the
 * table's own patterns, so a route without a probe fails here by name.
 *
 * Nothing leaves this machine. Every upstream is a mock on 127.0.0.1, the
 * outbound seams createServer already has are pointed at them, and fetch,
 * net.connect and tls.connect are wrapped for the run to throw on any other host.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import path from 'node:path';

/* The environment has to be set before the modules that read it are evaluated,
   which static imports would not allow — hence the dynamic imports below. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-hunt-home-'));
process.env.ZELOS_HOME = HOME;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file'; // never the real keychain
process.env.ZELOS_LOG_LEVEL = 'silent';

const { createServer, listen, ROUTE_LIST } = await import('../core/server.mjs');
const db = await import('../core/db.mjs');
const { loadConfig } = await import('../core/config.mjs');
const { setSecret } = await import('../core/secrets.mjs');
const { Scheduler } = await import('../core/sweep.mjs');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * The secrets: one per kind, each spelled so its encodings differ
 * ------------------------------------------------------------------ */

// `/`, `+` and `=` make the URL-encoded and base64 spellings differ from the
// raw one, and the first sixteen characters of each are unique to it.
const SECRETS = {
  model: 'Qm7vK2model/key+Zt9=xR4wL8pN3sB6',
  mail: 'Wd3jH8mail/pass+Yc5=nT1qF7vG2kM9',
  mailOAuth: 'Ep6tR1oauth/refresh+Ua4=gH8bZ3mX',
  calendar: 'Lx9fC4cal/pass+Ob2=sV7yJ5eD1hK6',
  source: 'Ti2nP5slack/token+Ig8=wQ3cA6rY4u',
  googleClient: 'Hb4yS7gcp/client+Vz1=kE9mN2tW5o',
};

const USER = 'nemo@example.com';

/** Every spelling of `secret` that would count as handing it back. */
function spellings(secret, { user = null } = {}) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
  const forms = [
    secret,
    b64(secret),
    Buffer.from(secret, 'utf8').toString('base64url'),
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    secret.slice(0, 16),
  ];
  // A Basic header, and SASL PLAIN, carry it inside a longer base64 string.
  if (user) forms.push(b64(`${user}:${secret}`), b64(`\0${user}\0${secret}`));
  return [...new Set(forms)];
}

/* ------------------------------------------------------------------ *
 * Nothing but loopback, for the whole file
 * ------------------------------------------------------------------ */

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;
const refuse = (where) => {
  throw new Error(`the credential hunt must not contact ${where}: every upstream here is a mock on 127.0.0.1`);
};
const real = { fetch: globalThis.fetch, netConnect: net.connect, tlsConnect: tls.connect };

function hostOf(args) {
  const [first, second] = args;
  if (first && typeof first === 'object') {
    if (first.socket || first.path) return 'localhost'; // an upgrade, or a pipe
    return first.host ?? 'localhost';
  }
  return typeof second === 'string' ? second : 'localhost';
}

// core opens its sockets through the default `net` and `tls` objects (see
// core/sources/imap.mjs), which is what these wrap. `net.createConnection` and
// a named `import { connect }` would go round them; nothing in core uses
// either today, and a reader that started to would need adding here.
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
  if (!LOOPBACK.test(url.hostname)) refuse(url.host);
  return real.fetch(input, init);
};
net.connect = function guardedConnect(...args) {
  if (!LOOPBACK.test(hostOf(args))) refuse(hostOf(args));
  return real.netConnect.apply(this, args);
};
tls.connect = function guardedTlsConnect(...args) {
  if (!LOOPBACK.test(hostOf(args))) refuse(hostOf(args));
  return real.tlsConnect.apply(this, args);
};
test.after(() => {
  globalThis.fetch = real.fetch;
  net.connect = real.netConnect;
  tls.connect = real.tlsConnect;
});

/* ------------------------------------------------------------------ *
 * Mock upstreams
 * ------------------------------------------------------------------ */

const ICS_BODY = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'X-WR-CALNAME:Mock Calendar',
  'BEGIN:VEVENT', 'UID:evt-1@test', 'DTSTAMP:20260801T120000Z',
  'DTSTART:20260811T180000Z', 'DTEND:20260811T190000Z', 'SUMMARY:Budget review',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

/** A model endpoint (openai wire), an .ics feed, and Google's two OAuth pages. */
async function startUpstream(t) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    received.push({ method: req.method, url: req.url, headers: req.headers });

    if (req.url.startsWith('/calendar.ics')) {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.end(ICS_BODY);
    } else if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    } else if (req.url.startsWith('/v1/chat/completions') && body?.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: { content: 'Budget review is on Tuesday.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 5 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else if (req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content: 'ready' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    } else {
      res.writeHead(404, { 'Content-Length': 0 });
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, baseUrl: `${origin}/v1`, received };
}

/** An IMAP server that refuses every sign-in: enough for the mail Test to send the password. */
async function startRefusingImap(t) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK mock ready\r\n');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let cut;
      while ((cut = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        seen.push(line);
        const [tag, verb] = line.split(' ');
        const upper = (verb || '').toUpperCase();
        if (upper === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`);
        else if (upper === 'LOGIN' || upper === 'AUTHENTICATE') socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        else if (upper === 'LOGOUT') socket.end(`* BYE\r\n${tag} OK bye\r\n`);
        else socket.write(`${tag} BAD unexpected\r\n`);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, sawLogin: () => seen.some((l) => /\bLOGIN\b/i.test(l)) };
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function recordingLogger() {
  const lines = [];
  const record = (lvl) => (msg, meta) => { lines.push(`${lvl} ${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`); };
  const logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  logger.child = () => logger;
  return { logger, lines };
}

async function startServer(t, options) {
  const handle = db.open(':memory:');
  db.migrate(handle);
  const server = createServer({ db: handle, ...options });
  const { port } = await listen(server, { port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close(handle);
  });
  return { db: handle, token: server.sessionToken, base: `http://127.0.0.1:${port}`, sweeps: server.zelos.sweeps };
}

/** Read an event stream until `until(frame)` says stop. */
async function readFrames(response, until) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        frames.push(frame);
        if (until(frame)) return frames;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

const nxdomain = async () => { throw Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' }); };
const GOOGLE_CLIENT = '4242-zelos-hunt.apps.googleusercontent.com';

/* ================================================================== *
 * The hunt
 * ================================================================== */

test('no route, and no line in the log, hands back a stored secret in any spelling', async (t) => {
  const upstream = await startUpstream(t);
  const imap = await startRefusingImap(t);
  const { logger, lines } = recordingLogger();
  const releaseChecks = [];
  const sweeps = [];

  const model = { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model' };
  const ctx = await startServer(t, {
    config: { ...loadConfig(), model },
    logger,
    // A stand-in engine: what is under test is what the server relays. The
    // real sweep's own redaction is out of scope here; the last test below
    // has an engine error that quotes a secret.
    async runSweep({ onProgress, mode }) {
      sweeps.push(mode);
      onProgress({ phase: 'mail', message: 'reading Work', done: 1, total: 2 });
      return { runId: 'run_hunt0001', ok: true, stats: { messages: 0, mode } };
    },
    releaseChecker: async () => {
      releaseChecks.push(Date.now());
      return { ok: true, current: '0.0.0', latest: '0.0.0', available: false };
    },
    // Microsoft is never begun here, and Google's two pages are pointed at a
    // loopback address so that nothing about a sign-in can leave the machine.
    deviceAuth: { endpoint: upstream.origin, sleep: async () => {} },
    browserAuth: {
      authorizeUrl: `${upstream.origin}/auth`,
      tokenUrl: `${upstream.origin}/token`,
      fetchImpl: (...args) => globalThis.fetch(...args),
    },
    dns: { resolveMx: nxdomain, resolveSrv: nxdomain },
  });

  /* Every request goes through `ask`, which records what came back. A probe
     names the families it is allowed to show: only the mint response may carry
     the AI token, which is that route's whole job. */
  const seen = [];
  const asked = [];
  async function ask(method, route, { body, expect, mayShow = [], headers = {} } = {}) {
    const sent = { 'X-Zelos-Token': ctx.token, ...headers };
    if (body !== undefined) sent['Content-Type'] = 'application/json';
    const res = await real.fetch(`${ctx.base}${route}`, {
      method, headers: sent, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* an event stream, or plain text */ }
    asked.push({ method, path: new URL(route, ctx.base).pathname });
    seen.push({ where: `${method} ${route}`, mayShow, text: `${res.status} ${JSON.stringify([...res.headers])}\n${text}` });
    assert.equal(res.status, expect, `${method} ${route} answered ${res.status}, not ${expect}: ${text.slice(0, 300)}`);
    return { status: res.status, text, json };
  }

  // --- Plant one secret of each kind, through the routes that file them.
  await ask('POST', '/api/model/key', { body: { baseUrl: upstream.baseUrl, value: SECRETS.model }, expect: 200 });
  await ask('POST', '/api/secrets', { body: { ref: 'mail.m_hunt', value: SECRETS.mail }, expect: 200 });
  await ask('POST', '/api/secrets', { body: { ref: 'calendar.c_hunt', value: SECRETS.calendar }, expect: 200 });
  await ask('POST', '/api/secrets', { body: { ref: 'slack.s_hunt', value: SECRETS.source }, expect: 200 });
  // An OAuth grant is filed by the callback, not by a route a test can drive
  // without a browser, so it goes straight into the store.
  await setSecret('mail.m_oauth', JSON.stringify({ kind: 'xoauth2', refreshToken: SECRETS.mailOAuth }));

  await ask('PUT', '/api/config', {
    expect: 200,
    body: {
      identity: { name: 'Nemo' },
      model: { ...model, keyRef: 'model.default' },
      mail: [
        { id: 'm_hunt', enabled: true, label: 'Work', host: '127.0.0.1', port: imap.port, secure: false,
          user: USER, keyRef: 'mail.m_hunt', mailboxes: ['INBOX'], sentMailbox: '', lookbackDays: 14, maxMessages: 10 },
        { id: 'm_oauth', enabled: false, label: 'Gmail', host: '127.0.0.1', port: imap.port, secure: false, auth: 'xoauth2',
          user: USER, keyRef: 'mail.m_oauth', mailboxes: ['INBOX'], sentMailbox: '', lookbackDays: 14, maxMessages: 10 },
      ],
      calendars: [{ id: 'c_hunt', kind: 'ics', label: 'Team', url: `${upstream.origin}/calendar.ics`, user: USER, keyRef: 'calendar.c_hunt', enabled: true }],
    },
  });

  const google = await ask('POST', '/api/mail/oauth', {
    expect: 200,
    body: { provider: 'google', keyRef: 'mail.m_g', clientId: GOOGLE_CLIENT, clientSecret: SECRETS.googleClient },
  });
  const flow = google.json.id;
  assert.ok(flow, `the Google sign-in began without an id: ${google.text}`);

  await ask('PUT', '/api/ai', { expect: 200, body: { enabled: true, scopes: { board: true, calendar: true, 'mail.metadata': true, drafts: true, people: true } } });
  const minted = await ask('POST', '/api/ai/tokens', { body: { label: 'Hunt' }, expect: 201, mayShow: ['ai'] });
  const aiValue = minted.json.value;
  const aiSecret = /^zlt_[a-z]{1,8}_[0-9a-f]{4,16}_([A-Za-z0-9_-]{22,128})$/.exec(aiValue)?.[1];
  assert.ok(aiSecret, `the minted token is not shaped as core/ai-access.mjs documents: ${aiValue}`);
  const aiTokenId = minted.json.token.id;

  // Something on the board, so the item, draft, search and ask routes have rows.
  await ask('POST', '/api/sample-data', { expect: 201 });
  const itemId = ctx.db.prepare('SELECT id FROM items LIMIT 1').get()?.id;
  const draftId = ctx.db.prepare('SELECT id FROM drafts LIMIT 1').get()?.id;
  const threadKey = ctx.db.prepare('SELECT thread_key FROM messages WHERE thread_key IS NOT NULL LIMIT 1').get()?.thread_key;
  assert.ok(itemId && draftId && threadKey, 'the sample data has no item, draft or thread to ask about');

  // --- Every read and every action, with the secrets in place.
  await ask('GET', '/api/health', { expect: 200 });
  await ask('GET', '/api/state', { expect: 200 });
  await ask('GET', '/api/config', { expect: 200 });
  await ask('GET', '/api/model/presets', { expect: 200 });
  await ask('GET', `/api/model/key?baseUrl=${encodeURIComponent(upstream.baseUrl)}`, { expect: 200 });
  await ask('GET', `/api/model/list?protocol=openai&baseUrl=${encodeURIComponent(upstream.baseUrl)}`, { expect: 200 });
  const tested = await ask('POST', '/api/model/test', { body: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model' }, expect: 200 });
  assert.equal(tested.json.ok, true, `the model Test never reached the mock: ${tested.text}`);
  assert.ok(upstream.received.some((r) => (r.headers.authorization || '').includes(SECRETS.model)),
    'the model key was never sent to its own address, so the routes were hunted without it in play');
  await ask('GET', '/api/guides', { expect: 200 });
  await ask('POST', '/api/help', { body: { step: 'ai' }, expect: 200 });
  await ask('GET', '/api/local/probe', { expect: 200 });
  await ask('GET', '/api/connectors', { expect: 200 });
  await ask('POST', '/api/mail/guess', { body: { email: 'nemo@gmail.com' }, expect: 200 });
  await ask('POST', '/api/mail/guess', { body: { email: 'nemo@hunt-unknown.example' }, expect: 200 });
  const mailTest = await ask('POST', '/api/mail/test', {
    body: { host: '127.0.0.1', port: imap.port, secure: false, user: USER, keyRef: 'mail.m_hunt' }, expect: 200,
  });
  assert.equal(mailTest.json.ok, false);
  assert.ok(imap.sawLogin(), 'the mail Test never sent the password, so its reply proves nothing');
  await ask('GET', `/api/mail/oauth/${encodeURIComponent(flow)}`, { expect: 200 });
  const calendarTest = await ask('POST', '/api/calendar/test', {
    body: { kind: 'ics', url: `${upstream.origin}/calendar.ics`, user: USER, keyRef: 'calendar.c_hunt' }, expect: 200,
  });
  assert.equal(calendarTest.json.ok, true, `the calendar Test never read the feed: ${calendarTest.text}`);
  assert.ok(upstream.received.some((r) => r.url.startsWith('/calendar.ics') && /^Basic /.test(r.headers.authorization || '')),
    'the calendar password was never sent, so the calendar Test was hunted without it in play');
  await ask('POST', `/api/items/${encodeURIComponent(itemId)}/state`, { body: { state: 'done' }, expect: 200 });
  await ask('GET', `/api/items/${encodeURIComponent(itemId)}/history`, { expect: 200 });
  await ask('PUT', `/api/drafts/${encodeURIComponent(draftId)}`, { body: { body: 'Tuesday works.', state: 'edited' }, expect: 200 });
  await ask('POST', '/api/capture', { body: { text: 'call the bank about the transfer' }, expect: 201 });
  await ask('GET', '/api/search?q=budget', { expect: 200 });
  await ask('GET', '/api/data', { expect: 200 });
  await ask('GET', '/api/sample-data', { expect: 200 });
  await ask('POST', '/api/updates/check', { body: {}, expect: 200 });
  assert.equal(releaseChecks.length, 1, 'the update check did not go to the stand-in checker');
  const answered = await ask('POST', '/api/ask', { body: { question: 'budget review' }, expect: 200 });
  assert.match(answered.text, /event: done/, 'the ask stream never finished');
  await ask('GET', '/api/ai', { expect: 200 });
  const aiTest = await ask('POST', '/api/ai/test', { body: { token: aiValue }, expect: 200 });
  assert.equal(aiTest.json.ok, true, `the AI Test did not accept the token it was given: ${aiTest.text}`);

  // --- The sweep, and the stream that relays it.
  const stream = await real.fetch(`${ctx.base}/api/sweep/stream`, { headers: { 'X-Zelos-Token': ctx.token } });
  assert.equal(stream.status, 200);
  asked.push({ method: 'GET', path: '/api/sweep/stream' });
  const reading = readFrames(stream, (frame) => /^event: (done|failed)/.test(frame));
  await new Promise((r) => setTimeout(r, 30)); // subscribed before the sweep starts
  await ask('POST', '/api/sweep', { body: { mode: 'light' }, expect: 202 });
  const frames = await reading;
  assert.deepEqual(sweeps, ['light']);
  seen.push({ where: 'GET /api/sweep/stream', mayShow: [], text: `${stream.status} ${JSON.stringify([...stream.headers])}\n${frames.join('\n\n')}` });

  // --- /api/mcp: every read tool, through the bearer token the routes minted.
  const rpc = async (method, params, id = asked.length) => {
    const res = await real.fetch(`${ctx.base}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiValue}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await res.text();
    asked.push({ method: 'POST', path: '/api/mcp' });
    seen.push({ where: `POST /api/mcp ${method} ${params?.name ?? ''}`, mayShow: [], text: `${res.status} ${JSON.stringify([...res.headers])}\n${text}` });
    assert.equal(res.status, 200, `/api/mcp ${method} answered ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    assert.equal(json.error, undefined, `/api/mcp ${method} ${params?.name ?? ''} failed: ${text.slice(0, 300)}`);
    return json.result;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hunt', version: '1' } });
  const tools = (await rpc('tools/list', {})).tools.map((tool) => tool.name).sort();
  const READS = {
    zelos_board: {},
    zelos_item: { id: itemId },
    zelos_calendar: {},
    zelos_search: { query: 'budget' },
    zelos_thread: { thread: threadKey },
    zelos_drafts: {},
    zelos_people: {},
  };
  assert.deepEqual(tools, Object.keys(READS).sort(), 'the tool list changed; give the new tool a call here');
  for (const [name, args] of Object.entries(READS)) await rpc('tools/call', { name, arguments: args });

  // --- Last, the routes that take things away.
  await ask('DELETE', `/api/mail/oauth/${encodeURIComponent(flow)}`, { expect: 200 });
  await ask('DELETE', '/api/secrets/slack.s_hunt', { expect: 200 });
  await ask('DELETE', `/api/ai/tokens/${encodeURIComponent(aiTokenId)}`, { expect: 200 });
  await ask('DELETE', '/api/sample-data', { expect: 200 });
  await ask('DELETE', `/api/model/key?baseUrl=${encodeURIComponent(upstream.baseUrl)}`, { expect: 200 });

  /* Coverage, by executing the table's own patterns: every probe matches
     exactly one route, and every route was probed. /api/mcp sits outside the
     table on purpose (it has its own gate), so it is held to its own count. */
  const table = ROUTE_LIST.map(([method, source]) => ({ method, re: new RegExp(source), key: `${method} ${source}` }));
  const hits = new Map(table.map((r) => [r.key, 0]));
  for (const probe of asked) {
    if (probe.path === '/api/mcp') continue;
    const matches = table.filter((r) => r.method === probe.method && r.re.test(probe.path));
    assert.equal(matches.length, 1, `${probe.method} ${probe.path} matched ${matches.length} routes`);
    hits.set(matches[0].key, hits.get(matches[0].key) + 1);
  }
  const unasked = [...hits].filter(([, n]) => n === 0).map(([key]) => key);
  assert.deepEqual(unasked, [], `routes nobody hunted — give each a probe above:\n  ${unasked.join('\n  ')}`);
  assert.ok(asked.filter((p) => p.path === '/api/mcp').length >= 2 + Object.keys(READS).length);

  /* And the hunt itself. */
  const families = {
    model: spellings(SECRETS.model),
    mail: spellings(SECRETS.mail, { user: USER }),
    mailOAuth: spellings(SECRETS.mailOAuth),
    calendar: spellings(SECRETS.calendar, { user: USER }),
    source: spellings(SECRETS.source),
    googleClient: spellings(SECRETS.googleClient),
    ai: spellings(aiSecret),
  };
  const leaks = [];
  for (const { where, mayShow, text } of seen) {
    for (const [family, forms] of Object.entries(families)) {
      if (mayShow.includes(family)) continue;
      const form = forms.find((f) => text.includes(f));
      if (form) leaks.push(`${where} carried the ${family} secret as "${form}"`);
    }
  }
  const logged = lines.join('\n');
  for (const [family, forms] of Object.entries(families)) {
    const form = forms.find((f) => logged.includes(f));
    if (form) leaks.push(`the log carried the ${family} secret as "${form}"`);
  }
  assert.deepEqual(leaks, []);
  assert.ok(seen.length > ROUTE_LIST.length, 'fewer responses than routes were hunted');
});
/* ------------------------------------------------------------------ *
 * What the engine says, on its way to the page
 * ------------------------------------------------------------------ */

test('a sweep error that quotes a held secret reaches neither the stream nor the run record', async (t) => {
  /* The stream relayed an engine error's text exactly as thrown, so a secret
     in it went straight to the page (QA, 2026-10-10, TT-3527). The real
     sweep's readers strip what they send, and test/sweep.test.mjs holds the
     run record to the same; here the engine is a stand-in that quotes
     credentials back, once by throwing and once in a finished run's rows. */
  const { logger, lines } = recordingLogger();
  await setSecret('mail.m_stream', SECRETS.mail);
  await setSecret('calendar.c_stream', SECRETS.calendar);
  const config = {
    ...loadConfig(),
    mail: [{ id: 'm_stream', enabled: true, label: 'Work', host: '127.0.0.1', port: 1, secure: false,
      user: USER, keyRef: 'mail.m_stream', mailboxes: ['INBOX'], sentMailbox: '', lookbackDays: 14, maxMessages: 10 }],
    calendars: [{ id: 'c_stream', kind: 'ics', label: 'Team', url: 'http://127.0.0.1:1/calendar.ics', user: USER, keyRef: 'calendar.c_stream', enabled: true }],
  };
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  let runs = 0;
  const ctx = await startServer(t, {
    config,
    logger,
    async runSweep() {
      runs += 1;
      if (runs === 1) throw new Error(`imap: LOGIN ${USER} "${SECRETS.mail}" refused; AUTH PLAIN ${b64(`\0${USER}\0${SECRETS.mail}`)}`);
      return {
        runId: 'run_stream0002',
        ok: false,
        error: `calendar: Basic ${b64(`${USER}:${SECRETS.calendar}`)} was refused`,
        stats: { sources: [{ kind: 'calendar', id: 'c_stream', ok: false, error: `401 for ${encodeURIComponent(SECRETS.calendar)}` }] },
      };
    },
  });

  const sweepOnce = async () => {
    const stream = await real.fetch(`${ctx.base}/api/sweep/stream`, { headers: { 'X-Zelos-Token': ctx.token } });
    const reading = readFrames(stream, (frame) => /^event: (done|failed)/.test(frame));
    await new Promise((r) => setTimeout(r, 30));
    const started = await real.fetch(`${ctx.base}/api/sweep`, {
      method: 'POST', headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 202);
    return (await reading).join('\n\n');
  };
  const thrown = await sweepOnce();
  const finished = await sweepOnce();
  assert.match(thrown, /event: failed/);
  assert.match(thrown, /refused/, 'the error was dropped rather than screened, which leaves the page nothing to say');
  assert.match(finished, /event: failed/);
  assert.match(finished, /was refused/);

  const state = await real.fetch(`${ctx.base}/api/state`, { headers: { 'X-Zelos-Token': ctx.token } });
  assert.equal(state.status, 200);
  const stored = JSON.stringify(ctx.db.prepare('SELECT * FROM runs').all());
  const places = { 'the stream (thrown)': thrown, 'the stream (finished)': finished, '/api/state': await state.text(), 'the runs table': stored, 'the log': lines.join('\n') };
  for (const [where, text] of Object.entries(places)) {
    for (const form of [...spellings(SECRETS.mail, { user: USER }), ...spellings(SECRETS.calendar, { user: USER })]) {
      assert.ok(!text.includes(form), `${where} carried a held secret as "${form}"`);
    }
  }
});

test('a screened sweep frame is never overtaken, and a completion relayed meanwhile is not lost', async (t) => {
  /* Screening a completion that has error text waits on the secret store, so
     the frame goes out a moment later than it was made (QA, 2026-10-10,
     TT-3527). Two things must not happen in that moment: a frame made after
     it — the next sweep's `started` — going out first, and a Scheduler's own
     completion, relayed while ours is still being screened, being parked on a
     sweep that has already finished and never sent. */
  await setSecret('mail.m_order', SECRETS.mail);
  const config = {
    ...loadConfig(),
    mail: [{ id: 'm_order', enabled: true, label: 'Work', host: '127.0.0.1', port: 1, secure: false,
      user: USER, keyRef: 'mail.m_order', mailboxes: ['INBOX'], sentMailbox: '', lookbackDays: 14, maxMessages: 10 }],
  };
  let sweeps;
  const ctx = await startServer(t, {
    config,
    async runSweep() {
      // The Scheduler's own tick finishing just after ours did.
      setImmediate(() => sweeps.relay('done', { runId: 'run_tick', ok: true }));
      return { runId: 'run_ours', ok: false, error: `imap: "${SECRETS.mail}" refused` };
    },
  });
  sweeps = ctx.sweeps;
  const events = [];
  sweeps.subscribe((event, data) => events.push(`${event}:${data?.runId ?? data?.mode ?? ''}`));

  // A relayed completion with error text, then at once a sweep of our own.
  sweeps.relay('failed', { runId: 'run_relayed', ok: false, error: `calendar: "${SECRETS.mail}" refused` });
  await sweeps.start('light');
  const settled = Date.now() + 5_000;
  while (!events.includes('done:run_tick') && Date.now() < settled) await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(events, ['failed:run_relayed', 'started:light', 'failed:run_ours', 'done:run_tick'],
    'frames went out in an order other than the one they were made in, or one was lost');
});

test('a scheduled sweep that throws a held secret keeps it out of the stream and /api/health', async (t) => {
  /* The Scheduler catches a sweep that throws and keeps its words as
     `lastResult`, which GET /api/health serves, and a hand-started sweep runs
     through it whenever one exists (QA, 2026-10-10, TT-3527). */
  await setSecret('mail.m_sched', SECRETS.mail);
  const config = {
    ...loadConfig(),
    mail: [{ id: 'm_sched', enabled: true, label: 'Work', host: '127.0.0.1', port: 1, secure: false,
      user: USER, keyRef: 'mail.m_sched', mailboxes: ['INBOX'], sentMailbox: '', lookbackDays: 14, maxMessages: 10 }],
  };
  const handle = db.open(':memory:');
  db.migrate(handle);
  t.after(() => db.close(handle));
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const scheduler = new Scheduler({
    db: handle,
    config,
    async run() { throw new Error(`imap: LOGIN ${USER} "${SECRETS.mail}" refused; PLAIN ${b64(`\0${USER}\0${SECRETS.mail}`)}`); },
  });
  const { logger, lines } = recordingLogger();
  const ctx = await startServer(t, { config, scheduler, logger });

  const stream = await real.fetch(`${ctx.base}/api/sweep/stream`, { headers: { 'X-Zelos-Token': ctx.token } });
  const reading = readFrames(stream, (frame) => /^event: (done|failed)/.test(frame));
  await new Promise((r) => setTimeout(r, 30));
  const started = await real.fetch(`${ctx.base}/api/sweep`, {
    method: 'POST', headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(started.status, 202);
  const frames = (await reading).join('\n\n');
  assert.match(frames, /event: failed/);
  assert.match(frames, /refused/, 'the error was dropped rather than screened');

  const health = await real.fetch(`${ctx.base}/api/health`, { headers: { 'X-Zelos-Token': ctx.token } });
  assert.equal(health.status, 200);
  const served = await health.text();
  assert.match(served, /"lastResult":\{[^}]*refused/, 'the Scheduler kept no result to serve, so this proves nothing');

  const places = { 'the stream': frames, '/api/health': served, 'the log': lines.join('\n') };
  for (const [where, text] of Object.entries(places)) {
    for (const form of spellings(SECRETS.mail, { user: USER })) {
      assert.ok(!text.includes(form), `${where} carried the mail password as "${form}"`);
    }
  }
});
