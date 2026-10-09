/**
 * test/server.test.mjs — the local HTTP server.
 *
 * The security properties are the point of this file, so they are tested the
 * way an attacker would probe them: raw sockets where a client library would
 * "helpfully" normalise a path, a real symlink pointing out of the web root, a
 * real secret written to a real (temporary) secret store and then hunted for in
 * every response the API can produce.
 *
 * Nothing here touches the real ~/.zelos, and nothing here opens a socket to
 * anything but 127.0.0.1: the model, the calendar host and the mail host are
 * all local mock servers stood up by the test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

/* The environment has to be set before the modules that read it are evaluated,
   which static imports would not allow — hence the dynamic imports below. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-server-home-'));
process.env.ZELOS_HOME = HOME;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file'; // never the real keychain
process.env.ZELOS_LOG_LEVEL = 'silent';

const { createServer, listen } = await import('../core/server.mjs');
const db = await import('../core/db.mjs');
const { loadConfig } = await import('../core/config.mjs');
const { getSecret, setSecret, deleteSecret } = await import('../core/secrets.mjs');
const { googleSecretRefFor, oauthClient } = await import('../core/sources/oauth.mjs');
const { todayKey, addDaysToKey, instant, localTimezone, offsetFor, wallClock } =
  await import('../core/time.mjs');

const SECRET_VALUE = 'zelos-test-secret-4d1f9c7b2e6a';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * A web root we control, including a symlink that escapes it
 * ------------------------------------------------------------------ */

const STATIC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-static-'));
const UI_DIR = path.join(STATIC_ROOT, 'ui');
const ASSETS_DIR = path.join(STATIC_ROOT, 'assets');
const OUTSIDE_DIR = path.join(STATIC_ROOT, 'outside');
const OUTSIDE_MARKER = 'OUTSIDE-THE-WEB-ROOT-b31c9a';

fs.mkdirSync(path.join(UI_DIR, 'sub'), { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
fs.writeFileSync(path.join(UI_DIR, 'index.html'), '<!doctype html><title>board</title>');
fs.writeFileSync(path.join(UI_DIR, 'app.css'), ':root{--ink:#171310}');
fs.writeFileSync(path.join(UI_DIR, 'sub', 'deep.txt'), 'deep');
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.txt'), 'icon');
fs.writeFileSync(path.join(OUTSIDE_DIR, 'outside.txt'), OUTSIDE_MARKER);
fs.symlinkSync(path.join(OUTSIDE_DIR, 'outside.txt'), path.join(UI_DIR, 'escape.txt'));

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function baseConfig(patch = {}) {
  const cfg = loadConfig();
  return { ...cfg, ...patch, model: { ...cfg.model, ...(patch.model || {}) } };
}

async function startServer(t, options = {}) {
  const handle = db.open(':memory:');
  db.migrate(handle);
  const server = createServer({
    db: handle,
    config: options.config ?? baseConfig(),
    uiDir: UI_DIR,
    assetsDir: ASSETS_DIR,
    ...options,
  });
  const { port } = await listen(server, { port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close(handle);
  });
  return {
    db: handle,
    server,
    port,
    token: server.sessionToken,
    base: `http://127.0.0.1:${port}`,
  };
}

async function call(ctx, method, route, { token = ctx.token, body, headers = {}, signal } = {}) {
  const sent = { ...headers };
  if (token !== null) sent['X-Zelos-Token'] = token;
  if (body !== undefined) sent['Content-Type'] = 'application/json';
  const res = await fetch(`${ctx.base}${route}`, {
    method,
    headers: sent,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* not every response is JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * A request written straight onto the socket. Used wherever a client library
 * would normalise the request target before it ever left the process — which
 * is exactly the thing a traversal test must not allow.
 */
function rawRequest(port, requestLine, extraHeaders = []) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = '';
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error('raw request timed out'));
    });
    socket.on('connect', () => {
      const hasHost = extraHeaders.some((h) => /^host:/i.test(h));
      socket.write([
        requestLine,
        ...(hasHost ? [] : [`Host: 127.0.0.1:${port}`]),
        ...extraHeaders,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (d) => { buf += d.toString('utf8'); });
    socket.on('end', () => resolve(buf));
    socket.on('close', () => resolve(buf));
    socket.on('error', reject);
  });
}

const statusOf = (raw) => Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);

/** Read an SSE body, handing each complete frame to `onFrame`. */
async function readStream(response, onFrame, { until } = {}) {
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
        onFrame?.(frame);
        if (until && until(frame)) return frames;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

function parseFrame(frame) {
  const lines = frame.split('\n');
  if (lines.every((l) => l.startsWith(':'))) return { comment: lines.join('\n') };
  const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? null;
  const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
  return { event, data: data ? JSON.parse(data) : null };
}

/* ------------------------------------------------------------------ *
 * Mock upstreams — all on 127.0.0.1
 * ------------------------------------------------------------------ */

const ICS_BODY = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'X-WR-CALNAME:Mock Calendar',
  'BEGIN:VEVENT', 'UID:evt-1@test', 'DTSTAMP:20260801T120000Z',
  'DTSTART:20260811T180000Z', 'DTEND:20260811T190000Z', 'SUMMARY:Budget review',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

/** Speaks just enough of the openai wire protocol, and serves an .ics too. */
async function startMockUpstream(t, { jsonReply, finishReason } = {}) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    received.push({ method: req.method, url: req.url, headers: req.headers, body, raw });

    if (req.url.startsWith('/calendar.ics')) {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.end(ICS_BODY);
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-mini' }] }));
      return;
    }
    if (req.url.startsWith('/chat/completions')) {
      if (jsonReply !== undefined) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonReply));
        return;
      }
      if (body?.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: { content: 'Budget review ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'is on Tuesday.' }, ...(finishReason ? { finish_reason: finishReason } : {}) }], usage: { prompt_tokens: 41, completion_tokens: 6 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock-model',
        choices: [{ message: { content: 'ready' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { port, baseUrl: `http://127.0.0.1:${port}`, received };
}

/** A port nothing will ever answer on — for the "connection refused" paths. */
async function closedPort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/* ================================================================== *
 * The session token
 * ================================================================== */

test('every /api route requires the session token', async (t) => {
  const ctx = await startServer(t);

  const missing = await call(ctx, 'GET', '/api/health', { token: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error, 'unauthorized');

  const wrong = await call(ctx, 'GET', '/api/health', { token: 'f'.repeat(64) });
  assert.equal(wrong.status, 401);

  const short = await call(ctx, 'GET', '/api/health', { token: 'nope' });
  assert.equal(short.status, 401);

  const right = await call(ctx, 'GET', '/api/health');
  assert.equal(right.status, 200);
  assert.equal(right.json.ok, true);
});

test('the token is not accepted in the query string, only in the header', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'GET', `/api/state?t=${ctx.token}`, { token: null });
  assert.equal(res.status, 401);
});

test('an unauthenticated caller cannot even tell which routes exist', async (t) => {
  const ctx = await startServer(t);
  const real = await call(ctx, 'GET', '/api/state', { token: null });
  const fake = await call(ctx, 'GET', '/api/there-is-no-such-route', { token: null });
  assert.equal(real.status, 401);
  assert.equal(fake.status, 401);
  assert.equal(real.text, fake.text);
});

test('the session token is 32 bytes of hex and differs between servers', async (t) => {
  const a = await startServer(t);
  const b = await startServer(t);
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
  // A token minted for one server is worthless at the other.
  assert.equal((await call(b, 'GET', '/api/health', { token: a.token })).status, 401);
});

/* ================================================================== *
 * Origin, Host, CORS
 * ================================================================== */

test('a foreign Origin is refused even with a valid token', async (t) => {
  const ctx = await startServer(t);
  for (const origin of [
    'http://evil.example',
    'https://evil.example',
    'http://127.0.0.1.evil.example',
    'http://localhost:1234',
    'null',
  ]) {
    const res = await call(ctx, 'GET', '/api/health', { headers: { Origin: origin } });
    assert.equal(res.status, 403, `Origin ${origin} should have been refused`);
  }
});

test("the server's own Origin is accepted, and an absent one is too", async (t) => {
  const ctx = await startServer(t);
  for (const origin of [`http://127.0.0.1:${ctx.port}`, `http://localhost:${ctx.port}`]) {
    const res = await call(ctx, 'GET', '/api/health', { headers: { Origin: origin } });
    assert.equal(res.status, 200, `Origin ${origin} should have been accepted`);
  }
  assert.equal((await call(ctx, 'GET', '/api/health')).status, 200);
});

test('a foreign Origin is refused on static files as well as the API', async (t) => {
  const ctx = await startServer(t);
  const res = await fetch(`${ctx.base}/index.html`, { headers: { Origin: 'http://evil.example' } });
  assert.equal(res.status, 403);
});

test('a rebound hostname in Host is refused', async (t) => {
  const ctx = await startServer(t);
  const raw = await rawRequest(ctx.port, 'GET /api/health HTTP/1.1', [
    'Host: attacker.example',
    `X-Zelos-Token: ${ctx.token}`,
  ]);
  assert.equal(statusOf(raw), 403);
  const ok = await rawRequest(ctx.port, 'GET /api/health HTTP/1.1', [
    `Host: 127.0.0.1:${ctx.port}`,
    `X-Zelos-Token: ${ctx.token}`,
  ]);
  assert.equal(statusOf(ok), 200);
});

test('no response carries a CORS header, ever', async (t) => {
  const ctx = await startServer(t);
  const responses = [
    await call(ctx, 'GET', '/api/health'),
    await call(ctx, 'GET', '/api/health', { token: null }),
    await call(ctx, 'GET', '/api/health', { headers: { Origin: 'http://evil.example' } }),
    await call(ctx, 'GET', '/index.html'),
    await call(ctx, 'GET', '/does-not-exist'),
    await call(ctx, 'OPTIONS', '/api/health'),
  ];
  for (const res of responses) {
    for (const name of res.headers.keys()) {
      assert.ok(!name.toLowerCase().startsWith('access-control-'), `leaked ${name}`);
    }
  }
});

test('the spec security headers are on every response', async (t) => {
  const ctx = await startServer(t);
  for (const route of ['/api/health', '/index.html', '/nope']) {
    const res = await call(ctx, 'GET', route);
    assert.equal(
      res.headers.get('content-security-policy'),
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    );
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  }
});

/* ================================================================== *
 * Static serving and path traversal
 * ================================================================== */

test('static files inside the web root are served', async (t) => {
  const ctx = await startServer(t);

  const index = await call(ctx, 'GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.text, /<title>board<\/title>/);

  const css = await call(ctx, 'GET', '/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  const deep = await call(ctx, 'GET', '/sub/deep.txt');
  assert.equal(deep.status, 200);
  assert.equal(deep.text.trim(), 'deep');

  const asset = await call(ctx, 'GET', '/assets/icon.txt');
  assert.equal(asset.status, 200);
  assert.equal(asset.text.trim(), 'icon');
});

test('a matching ETag gets a 304', async (t) => {
  const ctx = await startServer(t);
  const first = await call(ctx, 'GET', '/index.html');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const second = await call(ctx, 'GET', '/index.html', { headers: { 'If-None-Match': etag } });
  assert.equal(second.status, 304);
  assert.equal(second.text, '');
});

test('path traversal fails in every encoding', async (t) => {
  const ctx = await startServer(t);

  const targets = [
    '/../outside/outside.txt',
    '/sub/../../outside/outside.txt',
    '/%2e%2e/outside/outside.txt',
    '/%2E%2E/outside/outside.txt',
    '/..%2foutside%2foutside.txt',
    '/%2e%2e%2foutside%2foutside.txt',
    '/%252e%252e/outside/outside.txt',
    '/..%5coutside%5coutside.txt',
    '/..\\outside\\outside.txt',
    '/....//outside/outside.txt',
    '/%c0%ae%c0%ae/outside/outside.txt',
    '/%uff0e%uff0e/outside/outside.txt',
    '/．．/outside/outside.txt',
    '/assets/../../outside/outside.txt',
    '/assets/%2e%2e/%2e%2e/outside/outside.txt',
    '/%00../outside/outside.txt',
    // The symlink is inside the root but its target is not.
    '/escape.txt',
  ];

  for (const target of targets) {
    // Raw sockets: a client library would normalise several of these away.
    const raw = await rawRequest(ctx.port, `GET ${target} HTTP/1.1`);
    const status = statusOf(raw);
    assert.ok(status === 404 || status === 400, `${target} answered ${status}`);
    assert.ok(!raw.includes(OUTSIDE_MARKER), `${target} leaked a file outside the web root`);
  }
});

test('a directory is not listed', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'GET', '/sub');
  assert.equal(res.status, 404);
  assert.ok(!res.text.includes('deep.txt'));
});

test('static serving only answers GET and HEAD', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'POST', '/index.html', { body: {} });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');

  const head = await call(ctx, 'HEAD', '/index.html');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

/* ================================================================== *
 * Secrets are write-only
 * ================================================================== */

test('no route returns a stored secret', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });

  const write = await call(ctx, 'POST', '/api/secrets', {
    body: { ref: 'model.default', value: SECRET_VALUE },
  });
  assert.equal(write.status, 200);
  assert.equal(write.json.ok, true);
  assert.ok(!write.text.includes(SECRET_VALUE));

  await call(ctx, 'POST', '/api/secrets', { body: { ref: 'mail.m_test', value: SECRET_VALUE } });
  t.after(async () => {
    await deleteSecret('model.default').catch(() => {});
    await deleteSecret('mail.m_test').catch(() => {});
  });

  const dead = await closedPort();
  // The two model probes name the mock upstream explicitly, and that is not
  // decoration. `PUT /api/config` merges over what is on DISK — not over the
  // config this server was handed — and then adopts the result, so the identity
  // patch above silently moves the model back to the packaged default,
  // `https://api.anthropic.com`. Left alone, the next two lines dialled
  // Anthropic for real and posted SECRET_VALUE to them on every run of the
  // suite. Both routes take an explicit target, so pin them to loopback.
  const target = `protocol=openai&baseUrl=${encodeURIComponent(upstream.baseUrl)}&keyRef=model.default`;
  const probes = [
    await call(ctx, 'GET', '/api/health'),
    await call(ctx, 'GET', '/api/state'),
    await call(ctx, 'GET', '/api/config'),
    await call(ctx, 'PUT', '/api/config', { body: { identity: { name: 'Nemo' } } }),
    await call(ctx, 'GET', '/api/model/presets'),
    await call(ctx, 'GET', `/api/model/list?${target}`),
    await call(ctx, 'POST', '/api/model/test', {
      body: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
    await call(ctx, 'GET', '/api/search?q=secret'),
    await call(ctx, 'POST', '/api/mail/test', {
      body: { host: '127.0.0.1', port: dead, secure: false, user: 'someone', keyRef: 'mail.m_test' },
    }),
  ];
  for (const probe of probes) {
    assert.ok(!probe.text.includes(SECRET_VALUE), `a route leaked the secret: ${probe.text.slice(0, 200)}`);
  }

  // There is no read route, by design: the only verbs those paths answer to
  // are the ones that write and the one that deletes.
  const collection = await call(ctx, 'GET', '/api/secrets');
  assert.equal(collection.status, 405);
  assert.deepEqual(collection.json.allowed, ['POST']);
  const one = await call(ctx, 'GET', '/api/secrets/model.default');
  assert.equal(one.status, 405);
  assert.deepEqual(one.json.allowed, ['DELETE']);

  // The config knows WHICH refs exist — never what is behind them.
  const cfg = await call(ctx, 'GET', '/api/config');
  assert.ok(cfg.json.secretRefs.includes('model.default'));
  assert.ok(!cfg.text.includes(SECRET_VALUE));
});

test('a credential-shaped field never reaches config.json or a response', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'PUT', '/api/config', {
    body: { identity: { name: 'Nemo' }, model: { apiKey: 'LEAKED-KEY-VALUE', password: 'LEAKED-PASS' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.config.identity.name, 'Nemo');
  assert.equal(res.json.config.model.apiKey, undefined);
  assert.ok(!res.text.includes('LEAKED-KEY-VALUE'));
  assert.ok(!fs.readFileSync(path.join(HOME, 'config.json'), 'utf8').includes('LEAKED-KEY-VALUE'));
});

test('DELETE /api/secrets/:ref removes it, and a bad ref is refused', async (t) => {
  const ctx = await startServer(t);
  await setSecret('model.doomed', SECRET_VALUE);
  const gone = await call(ctx, 'DELETE', '/api/secrets/model.doomed');
  assert.equal(gone.status, 200);
  assert.equal(gone.json.deleted, true);
  const listed = await call(ctx, 'GET', '/api/config');
  assert.ok(!listed.json.secretRefs.includes('model.doomed'));

  const bad = await call(ctx, 'DELETE', '/api/secrets/..');
  assert.ok(bad.status === 400 || bad.status === 404);
});

/* ================================================================== *
 * Request body cap
 * ================================================================== */

test('an oversized body is refused on Content-Length', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'POST', '/api/capture', { body: { text: 'x'.repeat(2 * 1024 * 1024) } });
  assert.equal(res.status, 413);
});

test('an oversized chunked body is refused while it streams', async (t) => {
  const ctx = await startServer(t);
  const answer = await new Promise((resolve, reject) => {
    const socket = net.connect(ctx.port, '127.0.0.1');
    let buf = '';
    socket.setTimeout(8_000, () => { socket.destroy(); reject(new Error('timed out')); });
    socket.on('connect', () => {
      socket.write([
        'POST /api/capture HTTP/1.1',
        `Host: 127.0.0.1:${ctx.port}`,
        `X-Zelos-Token: ${ctx.token}`,
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        '', '',
      ].join('\r\n'));
      const chunk = 'y'.repeat(65_536);
      // Deliberately never terminated: the server must not wait for the end.
      for (let i = 0; i < 48 && socket.writable; i++) {
        socket.write(`${(65_536).toString(16)}\r\n${chunk}\r\n`);
      }
    });
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      // The answer arrives while the upload is still going; there is no reason
      // to wait for a client that was never going to finish.
      if (buf.includes('\r\n\r\n')) { socket.destroy(); resolve(buf); }
    });
    socket.on('error', () => resolve(buf));
    socket.on('close', () => resolve(buf));
  });
  assert.equal(statusOf(answer), 413);
});

/* ================================================================== *
 * SSE
 * ================================================================== */

test('/api/sweep/stream frames are well formed from hello to done', async (t) => {
  const progress = [
    { phase: 'mail', message: 'fetching mail', done: 1, total: 3 },
    { phase: 'calendar', message: 'fetching events\nand invitations', done: 2, total: 3 },
    { phase: 'model', message: 'thinking', done: 3, total: 3 },
  ];
  const ctx = await startServer(t, {
    async runSweep({ onProgress, mode }) {
      for (const step of progress) {
        onProgress(step);
        await delay(2);
      }
      return { runId: 'run_test0001', ok: true, stats: { messages: 4, events: 1, items: 2, now: 1, mode } };
    },
  });

  const response = await fetch(`${ctx.base}/api/sweep/stream`, {
    headers: { 'X-Zelos-Token': ctx.token },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');

  const collected = [];
  const reading = readStream(response, (frame) => collected.push(frame), {
    until: (frame) => frame.startsWith('event: done'),
  });

  // Give the stream a moment to be subscribed before the sweep starts.
  await delay(30);
  const started = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'full' } });
  assert.equal(started.status, 202);
  assert.equal(started.json.started, true);

  await reading;

  // Framing: every frame is either a comment or `event:` + one or more `data:`.
  for (const frame of collected) {
    const lines = frame.split('\n');
    assert.ok(lines.length > 0);
    if (lines[0].startsWith(':')) {
      assert.ok(lines.every((l) => l.startsWith(':')), `mixed comment frame: ${frame}`);
      continue;
    }
    assert.match(lines[0], /^event: [a-z]+$/);
    assert.ok(lines.slice(1).every((l) => l.startsWith('data: ')), `bad data lines: ${frame}`);
  }

  const parsed = collected.map(parseFrame).filter((f) => f.event);
  assert.equal(parsed[0].event, 'hello');
  assert.equal(parsed[0].data.running, false);
  assert.equal(parsed[1].event, 'started');
  assert.equal(parsed[1].data.mode, 'full');

  const progressFrames = parsed.filter((f) => f.event === 'progress');
  assert.equal(progressFrames.length, 3);
  assert.deepEqual(progressFrames.map((f) => f.data.phase), ['mail', 'calendar', 'model']);
  // A payload containing a newline must survive the framing intact.
  assert.equal(progressFrames[1].data.message, 'fetching events\nand invitations');

  const done = parsed.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.data.ok, true);
  assert.equal(done.data.runId, 'run_test0001');
  assert.equal(done.data.stats.items, 2);
});

test('the stream sends heartbeats and survives the client walking away', async (t) => {
  let sweeps = 0;
  const ctx = await startServer(t, {
    heartbeatMs: 25,
    async runSweep({ onProgress }) {
      sweeps += 1;
      onProgress({ phase: 'mail', message: 'fetching', done: 1, total: 1 });
      await delay(40);
      return { runId: `run_${sweeps}`, ok: true, stats: {} };
    },
  });

  const controller = new AbortController();
  const response = await fetch(`${ctx.base}/api/sweep/stream`, {
    headers: { 'X-Zelos-Token': ctx.token },
    signal: controller.signal,
  });
  const frames = await readStream(response, null, { until: (f) => f === ': ping' });
  assert.ok(frames.includes(': ping'), 'expected a heartbeat comment frame');

  // Walk away mid-sweep: the server must clean up and carry on.
  await call(ctx, 'POST', '/api/sweep', { body: { mode: 'light' } });
  controller.abort();
  await delay(80);

  assert.equal((await call(ctx, 'GET', '/api/health')).status, 200);
  const second = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'light' } });
  assert.equal(second.status, 202);
  await delay(80);
  assert.equal(sweeps, 2);
});

test('two sweeps cannot run at once', async (t) => {
  const ctx = await startServer(t, {
    async runSweep() {
      await delay(120);
      return { runId: 'run_slow', ok: true, stats: {} };
    },
  });
  const first = await call(ctx, 'POST', '/api/sweep', { body: {} });
  assert.equal(first.status, 202);
  const second = await call(ctx, 'POST', '/api/sweep', { body: {} });
  assert.equal(second.status, 409);
  assert.equal(second.json.detail.running, true);
});

test('the real sweep engine is wired up and reports its run id', async (t) => {
  // No mail, no calendar, no model — a light run touches nothing off this
  // machine, which is exactly what makes it safe to run here.
  const ctx = await startServer(t);
  const response = await fetch(`${ctx.base}/api/sweep/stream`, {
    headers: { 'X-Zelos-Token': ctx.token },
  });
  const reading = readStream(response, null, { until: (f) => f.startsWith('event: done') || f.startsWith('event: failed') });
  await delay(30);

  const started = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'light' } });
  assert.equal(started.status, 202);
  assert.match(started.json.runId, /^run_[0-9a-f]+$/, 'the run id must come back with the 202');

  const frames = (await reading).map(parseFrame).filter((f) => f.event);
  const done = frames.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.data.runId, started.json.runId);

  const state = await call(ctx, 'GET', '/api/state');
  assert.equal(state.json.runs.last.id, started.json.runId);
  assert.equal(state.json.runs.last.kind, 'light');
});

test('a sweep is run through the scheduler when there is one', async (t) => {
  let busy = false;
  const asked = [];
  const scheduler = {
    status: () => ({ running: true, busy, runs: asked.length }),
    async runNow(mode) {
      asked.push(mode);
      return { runId: 'run_via_scheduler', ok: true, stats: { items: 0 } };
    },
  };
  const ctx = await startServer(t, {
    scheduler,
    runSweep: async () => assert.fail('the scheduler should have owned this sweep'),
  });

  const res = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'full' } });
  assert.equal(res.status, 202);
  await delay(20);
  assert.deepEqual(asked, ['full']);

  const health = await call(ctx, 'GET', '/api/health');
  assert.equal(health.json.scheduler.running, true);

  // A scheduled sweep already in flight is a reason to say no, not to start a second.
  busy = true;
  const clash = await call(ctx, 'POST', '/api/sweep', { body: {} });
  assert.equal(clash.status, 409);
  assert.deepEqual(asked, ['full']);
});

/**
 * REGRESSION. The Scheduler calls `onRun` for every run it finishes, and both
 * launchers (zelos.mjs, desktop/runtime.js) relay that onto the stream as a
 * `done`/`failed`. SweepSupervisor.start() ALSO emitted one when the run it had
 * asked the Scheduler for resolved. So every sweep put two completion frames on
 * /api/sweep/stream, in two shapes: the relayed one carrying the engine's
 * counts, notes and repairs and no `mode`; the supervisor's carrying `mode` and
 * none of those. The board refreshed twice per sweep and kept the poorer frame
 * as lastResult. Nothing here saw it, because nothing here wired the relay.
 */
test('a sweep through the scheduler finishes with exactly one frame, carrying both halves', async (t) => {
  const { Scheduler } = await import('../core/sweep.mjs');
  const ctx = await startServer(t);
  const results = [
    { runId: 'run_one', ok: true, stats: { items: 2 }, counts: { now: 1 }, repairs: [] },
    { runId: 'run_two', ok: false, stats: null, error: 'No API key configured' },
  ];
  const scheduler = new Scheduler({
    db: ctx.db,
    config: baseConfig(),
    run: async () => results.shift(),
    // Exactly what zelos.mjs and desktop/runtime.js wire.
    onRun: (result) => ctx.server.zelos.sweeps.relay(result?.ok === false ? 'failed' : 'done', result),
  });
  ctx.server.zelos.useScheduler(scheduler);

  const controller = new AbortController();
  const response = await fetch(`${ctx.base}/api/sweep/stream`, {
    headers: { 'X-Zelos-Token': ctx.token },
    signal: controller.signal,
  });
  const frames = [];
  const reading = readStream(response, (frame) => frames.push(frame)).catch(() => frames);
  await delay(30);

  const isCompletion = (f) => f.startsWith('event: done') || f.startsWith('event: failed');
  const completions = () => frames.filter(isCompletion).length;
  const untilAnother = async (seen) => {
    for (let i = 0; i < 400 && completions() === seen; i++) await delay(5);
    // A second frame, had one been coming, was emitted in the same tick as the
    // first — this is generous.
    await delay(60);
  };

  for (const mode of ['full', 'light']) {
    const seen = completions();
    assert.equal((await call(ctx, 'POST', '/api/sweep', { body: { mode } })).status, 202);
    await untilAnother(seen);
  }

  // The Scheduler's own tick has no sweep of ours in flight, and its
  // completion must still reach the stream — it is the only one it gets.
  const seen = completions();
  ctx.server.zelos.sweeps.relay('done', { runId: 'run_tick', ok: true, stats: {} });
  await untilAnother(seen);

  controller.abort();
  await reading;

  const parsed = frames.filter(isCompletion).map(parseFrame);
  assert.equal(parsed.length, 3, `one frame per sweep, got: ${parsed.map((c) => `${c.event}/${c.data?.runId}`).join(', ')}`);

  const [done, failed, tick] = parsed;
  assert.equal(done.event, 'done');
  assert.equal(done.data.runId, 'run_one');
  assert.equal(done.data.mode, 'full', 'the supervisor knows the mode; the scheduler result does not');
  assert.equal(done.data.ok, true);
  assert.equal(done.data.stats.items, 2);
  assert.deepEqual(done.data.counts, { now: 1 }, 'the engine\'s richer fields survive the merge');
  assert.deepEqual(done.data.repairs, []);

  assert.equal(failed.event, 'failed');
  assert.equal(failed.data.runId, 'run_two');
  assert.equal(failed.data.mode, 'light');
  assert.equal(failed.data.ok, false);
  assert.equal(failed.data.error, 'No API key configured');

  assert.equal(tick.event, 'done');
  assert.equal(tick.data.runId, 'run_tick');
});

test('an unknown sweep mode is refused', async (t) => {
  const ctx = await startServer(t, { runSweep: async () => ({ runId: 'x', ok: true, stats: {} }) });
  const res = await call(ctx, 'POST', '/api/sweep', { body: { mode: 'everything' } });
  assert.equal(res.status, 400);
});

/* ================================================================== *
 * /api/ask
 * ================================================================== */

test('/api/ask streams a grounded answer and names its sources', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });

  db.upsertMessage(ctx.db, {
    sourceId: 'm_1',
    uid: 7,
    messageId: '<budget@test>',
    from: { name: 'Ada', email: 'ada@example.com' },
    subject: 'Budget review on Tuesday',
    date: '2026-08-10T09:00:00-04:00',
    snippet: 'Can we do the budget review on Tuesday at 2?',
    text: 'Can we do the budget review on Tuesday at 2? — Ada',
    folder: 'INBOX',
  });

  const response = await fetch(`${ctx.base}/api/ask`, {
    method: 'POST',
    headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'When is the budget review?' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);

  const frames = (await readStream(response, null, { until: (f) => f.startsWith('event: done') }))
    .map(parseFrame)
    .filter((f) => f.event);

  const sources = frames.find((f) => f.event === 'sources');
  assert.ok(sources, 'expected a sources frame');
  assert.ok(sources.data.length >= 1);
  assert.equal(sources.data[0].kind, 'message');
  assert.match(sources.data[0].ref, /^msg:[0-9a-f]{16}$/);
  assert.match(sources.data[0].title, /Budget review/);

  const answer = frames.filter((f) => f.event === 'delta').map((f) => f.data.text).join('');
  assert.equal(answer, 'Budget review is on Tuesday.');

  const done = frames.at(-1);
  assert.equal(done.event, 'done');
  assert.equal(done.data.grounded, true);
  assert.equal(done.data.usage.input, 41);

  // What actually hit the socket: a streamed chat completion whose prompt
  // carries the mail quoted inside the untrusted-data fence.
  const sent = upstream.received.find((r) => r.url.startsWith('/chat/completions'));
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.model, 'mock-model');
  const prompt = sent.body.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /ZELOS-UNTRUSTED/);
  assert.match(prompt, /budget review on Tuesday/i);
  assert.match(prompt, /Question: When is the budget review\?/);
});

test('/api/ask says so plainly when nothing is indexed', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });
  const response = await fetch(`${ctx.base}/api/ask`, {
    method: 'POST',
    headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'anything at all' }),
  });
  const frames = (await readStream(response, null, { until: (f) => f.startsWith('event: done') }))
    .map(parseFrame)
    .filter((f) => f.event);
  assert.deepEqual(frames.find((f) => f.event === 'sources').data, []);
  assert.equal(frames.at(-1).data.grounded, false);
  // Nothing was asked of the model, because there was nothing to ground on.
  assert.equal(upstream.received.length, 0);
});

test('inactive task history is opt-in for Search and explicitly historical in Ask', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, { config: baseConfig({
    model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model' },
  }) });
  const task = db.upsertMessage(ctx.db, {
    sourceId: 'todoist', messageId: 'todoist:task:budget',
    subject: 'Budget review obligation', text: 'Still open; budget review due tomorrow.',
    date: '2026-09-01T12:00:00Z',
  });
  db.reconcileTaskActivity(ctx.db, { sourceId: 'todoist', prefix: 'todoist:task:', selection: 'all', complete: true, rows: [] });
  const active = await call(ctx, 'GET', '/api/search?q=Budget');
  assert.equal(active.status, 200);
  assert.equal(active.json.results.length, 0);
  const historical = await call(ctx, 'GET', '/api/search?q=Budget&includeHistory=1');
  assert.equal(historical.json.results[0].ref, `msg:${task.id}`);
  assert.equal(historical.json.results[0].sourceInactive, true);

  const response = await fetch(`${ctx.base}/api/ask`, {
    method: 'POST', headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What was the budget review obligation?' }),
  });
  assert.equal(response.status, 200);
  const frames = (await readStream(response, null, { until: (f) => f.startsWith('event: done') })).map(parseFrame);
  assert.equal(frames.find((f) => f.event === 'sources').data[0].sourceInactive, true);
  const prompt = upstream.received.find((r) => r.url.startsWith('/chat/completions')).body.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /Historical task evidence/);
  assert.match(prompt, /Absence does not prove completion/);
});

test('/api/state exposes durable source health without losing the last successful read', async (t) => {
  const { recordSourceResults } = await import('../core/source-status.mjs');
  const ctx = await startServer(t, { config: baseConfig({
    sources: [{ id: 'tasks', type: 'todoist', enabled: true, keyRef: 'tasks.key', settings: {} }],
  }) });
  recordSourceResults(ctx.db, [{ id: 'tasks', kind: 'task', ok: true }], '2026-09-01T12:00:00Z');
  recordSourceResults(ctx.db, [{ id: 'tasks', kind: 'task', ok: false, error: 'Could not connect' }], '2026-09-02T12:00:00Z');
  const response = await call(ctx, 'GET', '/api/state');
  assert.equal(response.status, 200);
  const status = response.json.sourceStatus.find((s) => s.id === 'tasks');
  assert.equal(status.ok, false);
  assert.equal(status.lastSuccessAt, '2026-09-01T12:00:00.000Z');
  assert.equal(status.lastAttemptAt, '2026-09-02T12:00:00.000Z');
  assert.match(status.error, /Could not connect/);
  assert.equal(status.keyRef, undefined);
});

test('/api/ask preserves non-streamed answers and records their usage', async (t) => {
  const upstream = await startMockUpstream(t, { jsonReply: {
    model: 'fallback-model', choices: [{ message: { content: 'Budget review is on Tuesday.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 41, completion_tokens: 6 },
  } });
  const ctx = await startServer(t, { config: baseConfig({
    model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: '' },
  }) });
  db.insertCapture(ctx.db, 'Budget review is on Tuesday.');
  const response = await fetch(`${ctx.base}/api/ask`, {
    method: 'POST', headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'When is the budget review?' }),
  });
  const frames = (await readStream(response)).map(parseFrame).filter((frame) => frame.event);
  assert.equal(frames.filter((frame) => frame.event === 'delta').map((frame) => frame.data.text).join(''), 'Budget review is on Tuesday.');
  assert.equal(frames.at(-1).event, 'done');
  assert.deepEqual(frames.at(-1).data.usage, { input: 41, output: 6 });
  assert.equal(frames.at(-1).data.model, 'fallback-model');
  const usage = JSON.parse(db.getKV(ctx.db, 'sweep.tokens'));
  assert.equal(usage.tokensIn, 41);
  assert.equal(usage.tokensOut, 6);
});

test('/api/ask exposes a token-limit stop and still records the partial answer usage', async (t) => {
  const upstream = await startMockUpstream(t, { finishReason: 'length' });
  const ctx = await startServer(t, { config: baseConfig({
    model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: '' },
  }) });
  db.insertCapture(ctx.db, 'Budget review is on Tuesday.');
  const response = await fetch(`${ctx.base}/api/ask`, {
    method: 'POST', headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'When is the budget review?' }),
  });
  const frames = (await readStream(response)).map(parseFrame).filter((frame) => frame.event);
  assert.ok(frames.some((frame) => frame.event === 'delta' && frame.data.text));
  assert.equal(frames.at(-1).event, 'done');
  assert.equal(frames.at(-1).data.stopReason, 'length');
  assert.deepEqual(frames.at(-1).data.usage, { input: 41, output: 6 });
  const usage = JSON.parse(db.getKV(ctx.db, 'sweep.tokens'));
  assert.equal(usage.tokensIn, 41);
  assert.equal(usage.tokensOut, 6);
});

test('/api/ask refuses before streaming when no model is configured', async (t) => {
  const ctx = await startServer(t, {
    config: baseConfig({ model: { protocol: 'openai', baseUrl: 'https://api.example.com', model: '' } }),
  });
  const res = await call(ctx, 'POST', '/api/ask', { body: { question: 'hello?' } });
  assert.equal(res.status, 409);
  assert.match(res.headers.get('content-type'), /application\/json/);
});

/**
 * REGRESSION — the zone `recordAskSpend` books in.
 *
 * `recordTokens` carries the running day forward only while
 * `stored.day === dayKey(now)`, and `runSweep` stamps its row with
 * `nowISO(tz)` for the CONFIGURED zone (core/sweep.mjs `endedAt`). A second
 * writer that defaults to `nowISO()` reads the MACHINE zone, so for every hour
 * the two are on different dates the two keys disagree, the day reads as new,
 * and the first question typed into Ask resets the day's token counter to
 * zero. Silently, because a counter going backwards looks like a fresh day.
 *
 * test/sweep.test.mjs pins the mechanism inside `recordTokens`. This pins the
 * CALL SITE, which is the half that can rot on its own: delete the argument
 * from the one line in `handleAsk` that passes it and every assertion about
 * `recordTokens` stays green.
 *
 * Two things about the shape of this test, both of them load-bearing.
 *
 * **The zone is picked at RUN TIME.** A hardcoded one only diverges from the
 * machine for part of the day, which is exactly how the original defect hid:
 * on a machine in EDT with the app configured for UTC it was invisible until
 * 20:00 and present after it. At any instant two calendar dates exist on
 * Earth, so at least one candidate below always disagrees with this machine —
 * `Pacific/Kiritimati` (UTC+14) and `Pacific/Midway` (UTC-11) are 25 hours
 * apart and can never both agree with a third zone.
 *
 * **The zone is handed to `createServer`, never PUT.** Two earlier attempts
 * went through `PUT /api/config` and neither could measure anything, because
 * `saveConfig` merges the patch over what is ON DISK and this harness has
 * never written a config file — so every field a patch omits falls back to
 * DEFAULTS. Measured, both stages: a patch carrying only `identity` came back
 * with `model` reset to `{protocol: "anthropic", baseUrl:
 * "https://api.anthropic.com", model: ""}`, `modelIsConfigured` went false and
 * `/api/ask` answered 409 before it could spend anything. Putting back the
 * three fields `modelIsConfigured` reads (`baseUrl`, `model`, `keyRef`)
 * cleared the 409 and left `protocol` at the DEFAULTS' `anthropic`: the
 * request went to `POST /v1/messages` in Anthropic wire format, the openai
 * mock answered openai-shaped SSE, the Anthropic parser recognised none of it,
 * and the done frame carried `usage: {input: 0, output: 0}` with zero deltas —
 * whereupon `recordAskSpend` returns early on `if (!tokensIn && !tokensOut)`
 * and there is nothing to assert. `handleAsk` reads `ctx.config()`, so handing
 * the zone over at construction exercises the identical line with none of that
 * in the way.
 */
test('an Ask books its spend on the CONFIGURED zone\'s day, not the machine\'s', async (t) => {
  const machineDay = todayKey(); // i.e. `nowISO()` with no zone — the reverted behaviour
  const configuredZone = ['Pacific/Kiritimati', 'Pacific/Midway', 'Asia/Tokyo', 'UTC']
    .find((z) => todayKey(z) !== machineDay);
  assert.ok(configuredZone,
    `no zone disagrees with ${localTimezone()} about today's date, which cannot happen`);

  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, {
    config: baseConfig({
      identity: { name: 'Nemo Hale', email: 'nemo@example.com', timezone: configuredZone },
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });

  // Something to ground on. Without it `handleAsk` short-circuits with a
  // hand-written `usage: {input: 0, output: 0}` and never reaches the model —
  // the other way this test can look like it ran and measure nothing.
  db.upsertMessage(ctx.db, {
    sourceId: 'm_1',
    uid: 7,
    messageId: '<budget@test>',
    from: { name: 'Ada', email: 'ada@example.com' },
    subject: 'Budget review on Tuesday',
    date: '2026-08-10T09:00:00-04:00',
    snippet: 'Can we do the budget review on Tuesday at 2?',
    text: 'Can we do the budget review on Tuesday at 2? — Ada',
    folder: 'INBOX',
  });

  const response = await fetch(`${ctx.base}/api/ask`, {
    method: 'POST',
    headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'When is the budget review?' }),
  });
  assert.equal(response.status, 200);

  /* Read to EOF rather than stopping at the `done` frame. `handleAsk` sends
     `done` and only THEN awaits `recordAskSpend`; `sse.end()` runs in the
     `finally` after it. A reader that returns on `done` is racing the write it
     is about to assert on, and would fail intermittently on a loaded CI box. */
  const frames = (await readStream(response)).map(parseFrame).filter((f) => f.event);
  const done = frames.find((f) => f.event === 'done');
  assert.ok(done, `the answer must terminate, got ${frames.map((f) => f.event).join(',')}`);
  assert.equal(done.data.grounded, true, 'the model was reached, so there is real spend to book');
  assert.ok(done.data.usage.input > 0, 'the mock reports usage, so the counter has something to take');

  const stored = JSON.parse(db.getKV(ctx.db, 'sweep.tokens'));
  assert.ok(stored, 'the Ask must write the counter at all — SWEEP_KV.tokens is where the rail reads it');
  assert.equal(stored.tokensIn, done.data.usage.input, 'and it books what it reported over SSE');
  assert.equal(stored.tokensOut, done.data.usage.output);

  // The assertion the whole test exists for.
  assert.equal(stored.day, todayKey(configuredZone),
    `the row must be stamped in the configured zone ${configuredZone} (${todayKey(configuredZone)}); `
    + `${stored.day} is ${stored.day === machineDay ? `the machine's day in ${localTimezone()}` : 'neither day'}, `
    + 'so a sweep that stamped the configured zone would read as a different day and the counter would reset');
  assert.notEqual(stored.day, machineDay,
    'and the two zones must still disagree, or this test proved nothing');

  /* Corroboration that cannot race a midnight rollover: `recordTokens` keeps
     the ISO string it was handed in `at`, and that string carries the OFFSET of
     whichever zone wrote it. The day above can only be read once; the offset is
     the same fingerprint and is stable except across a DST transition. */
  assert.equal(wallClock(stored.at).offset, offsetFor(configuredZone),
    `the stamp should carry ${configuredZone}'s offset, not ${localTimezone()}'s (${offsetFor(localTimezone())})`);
});

/* ================================================================== *
 * Port selection
 *
 * The promise `listen` makes is "a busy port does not stop the launch: walk up
 * from the port you were given until you find a free one, and give up after
 * `attempts`". It does NOT promise a particular landing port, and it must not be
 * tested as if it did — see holdRunOfPorts below for what asserting `busy + 1`
 * cost this suite.
 * ================================================================== */

/**
 * Hold `count` CONSECUTIVE ports on 127.0.0.1 for the length of the test, and
 * return the first of them.
 *
 * These two tests need a window of ports whose state they control. `listen(0)`
 * hands out one ephemeral port and promises nothing about the next, so: take an
 * ephemeral port as the base, bind the rest of the run explicitly, and if any of
 * them is already taken, drop the whole run and start again from a fresh base.
 * That loop is acquiring a FIXTURE, not re-running an assertion — it either
 * produces the window or throws, so a machine too busy to spare a run of ports
 * says exactly that instead of failing an assertion about the server.
 *
 * Why the window has to be held rather than assumed free: node:test runs the
 * suite's files in parallel and 17 of the 33 bind ephemeral ports
 * (test/connectors.test.mjs carries the same note). The version of this test
 * that asserted the server lands on exactly `busy + 1` was asserting that no
 * neighbouring file bound anything in the gap between this test taking `busy`
 * and the server trying `busy + 1`. That was false about one run in four — a
 * red suite that said nothing about the product, and taught the reader to
 * re-run instead of to read.
 *
 * The 24 ports of headroom above the run are for the walk itself: the server
 * needs somewhere to land, and `candidate + 1` past 65535 is not a port.
 */
async function holdRunOfPorts(t, count) {
  const held = [];
  t.after(() => Promise.all(held.map((s) => new Promise((r) => s.close(r)))));

  for (let tries = 0; tries < 40; tries += 1) {
    const first = net.createServer();
    await new Promise((r) => first.listen(0, '127.0.0.1', r));
    const base = first.address().port;
    const run = [first];

    while (run.length < count && base + count + 24 <= 65_535) {
      const next = net.createServer();
      // listen() reports "taken" as an error event, not a rejection, and the
      // port is only ours once the 'listening' side of that race wins.
      const took = await new Promise((resolve) => {
        next.once('error', () => resolve(false));
        next.listen(base + run.length, '127.0.0.1', () => resolve(true));
      });
      if (!took) break;
      run.push(next);
    }

    if (run.length === count && base + count + 24 <= 65_535) {
      held.push(...run);
      return base;
    }
    await Promise.all(run.map((s) => new Promise((r) => s.close(r))));
  }
  throw new Error(`could not reserve ${count} consecutive free ports on 127.0.0.1`);
}

/** A real server on a real database, closed by the test — but not yet bound. */
function unboundServer(t) {
  const handle = db.open(':memory:');
  db.migrate(handle);
  const server = createServer({ db: handle, uiDir: UI_DIR, assetsDir: ASSETS_DIR });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close(handle);
  });
  return server;
}

test('a busy port makes the server take the next free one', async (t) => {
  const ATTEMPTS = 20;
  const RUN = 3;
  // Three in a row, so the walk has to iterate rather than merely try twice.
  const busy = await holdRunOfPorts(t, RUN);
  const server = unboundServer(t);

  const bound = await listen(server, { port: busy, attempts: ATTEMPTS });

  assert.notEqual(bound.port, busy);
  // Past every port we are holding: it kept walking, it did not stop at the
  // first failure.
  assert.ok(
    bound.port >= busy + RUN,
    `expected a port at or above ${busy + RUN} (${RUN} held from ${busy}), got ${bound.port}`,
  );
  // ...and still inside the window the walk can reach, which is the difference
  // between walking up from the port it was given and quietly asking the OS for
  // any free port at all. WHICH port inside the window is deliberately not
  // asserted: a neighbouring test file taking one of them in the gap is legal
  // and says nothing about this server.
  assert.ok(
    bound.port <= busy + ATTEMPTS,
    `expected a port within ${ATTEMPTS} of ${busy}, got ${bound.port}`,
  );

  assert.equal(server.address().port, bound.port);
  assert.equal(bound.url, `http://127.0.0.1:${bound.port}/`);
  assert.equal(bound.tokenUrl, `http://127.0.0.1:${bound.port}/?t=${server.sessionToken}`);

  // The launch survived, and the reported port is where THIS server answers —
  // a squatter would leave the socket hanging, and 401 is Zelos refusing an
  // untokened /api call rather than some other process being polite.
  assert.equal(statusOf(await rawRequest(bound.port, 'GET /api/health HTTP/1.1')), 401);
});

/**
 * The guard that keeps the range check above honest. A `listen` that ignored the
 * port it was handed and took any free one would satisfy "not busy", "still
 * running" and "answers HTTP" — the only thing it could not do is fail here.
 *
 * Nothing in this test depends on a neighbour: `attempts: 2` lets the walk touch
 * exactly `busy`, `busy + 1` and `busy + 2`, and all three are ports we hold.
 */
test('the walk up is bounded by `attempts`, and gives up rather than landing anywhere', async (t) => {
  const busy = await holdRunOfPorts(t, 3);
  const server = unboundServer(t);

  await assert.rejects(
    listen(server, { port: busy, attempts: 2 }),
    (err) => {
      // Whichever of the two the platform reports for "that port is taken" —
      // core/server.mjs walks on both, so both are a legitimate way for the walk
      // to end. The claim under test is that it ENDED, not which errno said so.
      assert.ok(err instanceof Error, `expected an Error, got ${err}`);
      assert.ok(['EADDRINUSE', 'EACCES'].includes(err.code), `unexpected code ${err.code}`);
      return true;
    },
  );
  assert.equal(server.address(), null, 'it bound something after reporting that it could not');
});

test('the server binds 127.0.0.1, not every interface', async (t) => {
  const ctx = await startServer(t);
  assert.equal(ctx.server.address().address, '127.0.0.1');
});

/* ================================================================== *
 * The board routes
 * ================================================================== */

test('/api/state returns the board', async (t) => {
  const ctx = await startServer(t);
  const runId = db.startRun(ctx.db, { kind: 'full' });
  const item = db.upsertItem(ctx.db, {
    key: 'reply-to-ada',
    bucket: 'now',
    headline: 'Reply to Ada about the budget review',
    why: 'She asked two days ago and has not heard back.',
    person: 'Ada',
    personEmail: 'ada@example.com',
    severity: 3,
  }, { runId });
  db.upsertEvent(ctx.db, {
    calendarId: 'c_1',
    uid: 'evt-1',
    title: 'Budget review',
    startsAt: '2026-08-11T14:00:00-04:00',
    endsAt: '2026-08-11T15:00:00-04:00',
  });
  // The keys core/triage.mjs writes: notes as JSON, first as an item row id.
  db.setKV(ctx.db, 'sweep.notes', JSON.stringify(['Two invoices are past due.']));
  db.setKV(ctx.db, 'sweep.first', item.id);
  db.finishRun(ctx.db, runId, { ok: true, stats: { items: 1 } });

  const res = await call(ctx, 'GET', '/api/state');
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 1);
  assert.equal(res.json.items[0].headline, 'Reply to Ada about the budget review');
  assert.equal(res.json.counts.now, 1);
  assert.equal(res.json.counts.today, 0);
  assert.deepEqual(res.json.notes, ['Two invoices are past due.']);
  assert.equal(res.json.first, res.json.items[0].id);

  // A `first` whose item is gone is cleared, not handed over as a dangling id.
  db.setKV(ctx.db, 'sweep.first', 'deadbeefdeadbeef');
  const stale = await call(ctx, 'GET', '/api/state');
  assert.equal(stale.json.first, null);
  assert.equal(res.json.runs.last.id, runId);
  assert.ok(Array.isArray(res.json.events));
});

test('/api/state carries what was finished recently, newest decision first, at most 20', async (t) => {
  const ctx = await startServer(t);
  const mk = (key, state, at) => {
    const { id } = db.upsertItem(ctx.db, { key, bucket: 'today', headline: key }, { runId: 'r' });
    if (state !== 'open') db.setItemState(ctx.db, id, state, { now: at });
    return id;
  };
  mk('still-open', 'open');
  mk('done-early', 'done', '2026-08-25T09:00:00-04:00');
  // These two disagree lexically and as instants — 09:00-04:00 is 13:00Z, an
  // hour after the Z row, though its digits sort before. The instant must win.
  mk('dismissed-noon-utc', 'dismissed', '2026-08-26T12:00:00Z');
  mk('done-13z', 'done', '2026-08-26T09:00:00-04:00');

  const res = await call(ctx, 'GET', '/api/state');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.finished.map((i) => i.headline),
    ['done-13z', 'dismissed-noon-utc', 'done-early'],
    'done and dismissed only, newest state_at first');
  assert.ok(!res.json.items.some((i) => i.headline === 'done-early'), 'finished rows are not board rows');
  // The same hydrated shape as items[]: decoded columns, never the raw JSON ones.
  assert.ok(Array.isArray(res.json.finished[0].sourceRefs));
  assert.equal(res.json.finished[0].payload_json, undefined);

  for (let i = 0; i < 22; i += 1) mk(`fin-${i}`, 'done', `2026-08-27T10:${String(i).padStart(2, '0')}:00Z`);
  const capped = await call(ctx, 'GET', '/api/state');
  assert.equal(capped.json.finished.length, 20);
  assert.equal(capped.json.finished[0].headline, 'fin-21');
});

// The Finished fold's "put it back": the tick on a done row POSTs state open,
// and the route must accept it — reopening is the user clicking, nothing else.
test('the state route reopens a done item', async (t) => {
  const ctx = await startServer(t);
  const { id } = db.upsertItem(ctx.db, { key: 'k-done', bucket: 'today', headline: 'Pay the invoice' }, { runId: 'r' });
  db.setItemState(ctx.db, id, 'done');
  const res = await call(ctx, 'POST', `/api/items/${id}/state`, { body: { state: 'open' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.state, 'open');
  assert.equal(db.getItem(ctx.db, id).state, 'open');
});

test('/api/data says what Zelos is holding, and only with the token', async (t) => {
  const cfg = baseConfig();
  cfg.mail = [
    { id: 'm_work', label: 'Work', host: 'imap.example', user: 'nemo@example.com' },
    { id: 'm_home', label: '', host: 'mail.home.example', user: 'nemo@home.example' },
    { id: 'm_new', label: '', host: '', user: '' },
  ];
  const ctx = await startServer(t, { config: cfg });
  db.upsertMessages(ctx.db, [
    { sourceId: 'm_work', uid: 1, messageId: '<a@x.example>', subject: 'A', date: '2026-08-05T09:12:00-04:00' },
    { sourceId: 'm_work', uid: 2, messageId: '<b@x.example>', subject: 'B', date: '2026-08-06T10:00:00-04:00' },
    // Sent at 13:00Z — the oldest instant here, though its digits sort last.
    { sourceId: 'm_home', uid: 3, messageId: '<c@x.example>', subject: 'C', date: '2026-08-05T13:00:00Z' },
  ]);
  db.upsertEvent(ctx.db, { calendarId: 'c_1', uid: 'e1', title: 'Budget review', startsAt: '2026-08-11T14:00:00-04:00' });
  db.upsertItem(ctx.db, { key: 'k1', bucket: 'now', headline: 'Reply to Ada' }, { runId: 'r' });

  const res = await call(ctx, 'GET', '/api/data');
  assert.equal(res.status, 200);
  assert.equal(res.json.messageCount, 3);
  assert.equal(res.json.eventCount, 1);
  assert.equal(res.json.itemCount, 1);
  assert.equal(res.json.oldestMessageAt, '2026-08-05T13:00:00Z', 'oldest by instant, not by the digits of the offset');
  assert.equal(typeof res.json.dbBytes, 'number');
  assert.equal(typeof res.json.walBytes, 'number');
  // Every configured account is answered for, labelled the way the doctor
  // labels one, including an account that has fetched nothing yet.
  assert.deepEqual(res.json.accounts, [
    { id: 'm_work', label: 'Work', messages: 2 },
    { id: 'm_home', label: 'mail.home.example', messages: 1 },
    { id: 'm_new', label: 'm_new', messages: 0 },
  ]);

  const denied = await call(ctx, 'GET', '/api/data', { token: null });
  assert.equal(denied.status, 401);
});

/**
 * REGRESSION (#27). `events` is one window around today, and the payload never
 * said so — so ui/views/calendar.js, whose ‹ and › are unclamped and which has
 * no route to fetch another range, drew fully styled empty grids for months it
 * had simply not been sent. The window itself was also too narrow for the view
 * the comment in core/server.mjs named: the month grid runs whole weeks, so the
 * CURRENT month's grid starts on the Sunday on or before the 1st, and measured
 * 2026-08-10 the eight cells 2026-07-26…08-02 fell before `from` — a week of
 * confidently empty days, with no navigation involved at all, for events that
 * were in the events table the whole time.
 *
 * Asserted against the grid the UI actually builds rather than against a number
 * of days, because that is the claim: whatever the calendar draws for the month
 * it opens on, the server has answered for.
 */
test('/api/state declares its event window, and it covers the whole current month grid', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'GET', '/api/state');
  assert.equal(res.status, 200);

  const window = res.json.eventWindow;
  assert.ok(window, '/api/state must say which days its events are an answer about');
  assert.match(window.from, /^\d{4}-\d{2}-\d{2}$/, 'day keys, because every reader compares day keys');
  assert.match(window.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(window.from < window.to);

  // The month grid ui/views/calendar.js builds for today, computed the way it
  // does: whole weeks from the Sunday on or before the 1st.
  const today = todayKey();
  const first = `${today.slice(0, 7)}-01`;
  const gridStart = addDaysToKey(first, -new Date(`${first}T00:00:00Z`).getUTCDay());
  assert.ok(window.from <= gridStart,
    `the served window (${window.from}) must reach the first cell of this month's grid (${gridStart})`);
  assert.ok(window.to >= today);

  // ...and the window is a claim about the events beside it, so it has to be
  // consistent with them: nothing served may fall outside what was declared.
  for (const ev of res.json.events) {
    assert.ok(String(ev.starts_at).slice(0, 10) <= window.to,
      `served an event at ${ev.starts_at} past the declared window end ${window.to}`);
  }
});

/**
 * REGRESSION. core/sweep.mjs wrote the counter, ui/lib/format.js rendered it and
 * ui/app.js read `state.board.tokens` — and nothing ever put it in the payload
 * between them, so a feature that existed at both ends existed nowhere.
 */
test('/api/state carries the token counter once there is one, and omits it cleanly before', async (t) => {
  const ctx = await startServer(t);

  const before = await call(ctx, 'GET', '/api/state');
  assert.equal(before.status, 200);
  assert.ok(!('tokens' in before.json),
    'a machine that has never swept has no spend to report, which is not a spend of zero');

  // Exactly what core/sweep.mjs records under this key after a run.
  db.setKV(ctx.db, 'sweep.tokens', JSON.stringify({
    day: todayKey(), tokensIn: 1234, tokensOut: 567, runs: 1, modelRuns: 1,
    lifetime: { tokensIn: 1234, tokensOut: 567, runs: 1, modelRuns: 1 },
    at: '2026-08-09T09:00:00+00:00',
  }));

  const after = await call(ctx, 'GET', '/api/state');
  assert.equal(after.json.tokens.tokensIn, 1234);
  assert.equal(after.json.tokens.tokensOut, 567);
  assert.equal(after.json.tokens.day, todayKey());

  // Anything unreadable is the same as nothing: the counter is chrome, and
  // chrome does not get to break the board.
  db.setKV(ctx.db, 'sweep.tokens', 'not json at all');
  const junk = await call(ctx, 'GET', '/api/state');
  assert.equal(junk.status, 200);
  assert.ok(!('tokens' in junk.json));
  assert.ok(Array.isArray(junk.json.items));
});

/**
 * REGRESSION. The four-item bar was held by core/sweep.mjs's recomputeDerived,
 * which only ever runs inside a sweep — while a snooze that comes due is woken
 * by *reading* the board. So a fifth `now` item could arrive on a plain GET, and
 * the loudest promise the product makes was false until the next sweep.
 */
test('a snooze waking on a read cannot push the now bar past four', async (t) => {
  const ctx = await startServer(t);
  for (const i of [0, 1, 2, 3]) {
    db.upsertItem(ctx.db, {
      key: `now-${i}`, bucket: 'now', headline: `Urgent thing number ${i}`, severity: 3,
    });
  }
  const fifth = db.upsertItem(ctx.db, {
    key: 'now-5', bucket: 'now', headline: 'The fifth urgent thing', severity: 0,
  });

  const untilMs = Math.ceil((Date.now() + 1_000) / 1000) * 1000;
  const snoozed = await call(ctx, 'POST', `/api/items/${fifth.id}/state`, {
    body: { state: 'snoozed', until: new Date(untilMs).toISOString() },
  });
  assert.equal(snoozed.json.state, 'snoozed');

  const asleep = await call(ctx, 'GET', '/api/state');
  assert.equal(asleep.json.counts.now, 4, 'four while the fifth is away');

  await delay(untilMs - Date.now() + 250);

  const woken = await call(ctx, 'GET', '/api/state');
  assert.equal(woken.status, 200);
  assert.equal(woken.json.counts.now, 4, 'and still four the moment it comes back');
  const open = woken.json.items.filter((i) => i.state === 'open');
  assert.equal(open.filter((i) => i.bucket === 'now').length, 4);

  // Nothing was deleted and nobody's decision was overruled: the one that lost
  // its place is awake, open, and now the user's work for today.
  const demoted = open.find((i) => i.id === fifth.id);
  assert.equal(demoted.bucket, 'today', 'the least urgent lost the place, and only the bucket');
  assert.equal(demoted.state, 'open');
  assert.equal(woken.json.counts.today, 1);

  // A board that is already within the bar is left entirely alone.
  const again = await call(ctx, 'GET', '/api/state');
  assert.equal(again.json.counts.now, 4);
  assert.equal(again.json.counts.today, 1);
});

test('an item state change is recorded, and an illegal one is refused', async (t) => {
  const ctx = await startServer(t);
  const { id } = db.upsertItem(ctx.db, { key: 'pay-the-invoice', bucket: 'money', headline: 'Pay the invoice' });

  const done = await call(ctx, 'POST', `/api/items/${id}/state`, { body: { state: 'done' } });
  assert.equal(done.status, 200);
  assert.equal(done.json.state, 'done');

  const illegal = await call(ctx, 'POST', `/api/items/${id}/state`, { body: { state: 'obliterated' } });
  assert.equal(illegal.status, 400);

  const missing = await call(ctx, 'POST', '/api/items/nosuchitem/state', { body: { state: 'done' } });
  assert.equal(missing.status, 404);
});

test('a snoozed item leaves the counts and /api/state wakes it once the time has passed', async (t) => {
  const ctx = await startServer(t);
  const { id } = db.upsertItem(ctx.db, { key: 'chase-invoice', bucket: 'now', headline: 'Chase the invoice' });

  // Whole seconds, because the stored zoned ISO carries none finer — the
  // round-trip assertion below compares instants, and truncation would skew it.
  const untilMs = Math.ceil((Date.now() + 1_200) / 1000) * 1000;
  const until = new Date(untilMs).toISOString();

  const snoozed = await call(ctx, 'POST', `/api/items/${id}/state`, { body: { state: 'snoozed', until } });
  assert.equal(snoozed.status, 200);
  assert.equal(snoozed.json.state, 'snoozed');
  assert.equal(instant(snoozed.json.snoozed_until), untilMs, 'the stored wake time is the same instant, re-zoned');

  // Asleep: still in the items payload (the rail shows snoozed rows dimmed),
  // carrying snoozed_until, but out of the open counts.
  const before = await call(ctx, 'GET', '/api/state');
  const sleeping = before.json.items.find((i) => i.id === id);
  assert.equal(sleeping.state, 'snoozed');
  assert.equal(instant(sleeping.snoozed_until), untilMs);
  assert.equal(before.json.counts.now, 0);

  await delay(untilMs - Date.now() + 250);

  // Reading the state is what wakes it — no timer, no sweep required.
  const after = await call(ctx, 'GET', '/api/state');
  const woken = after.json.items.find((i) => i.id === id);
  assert.equal(woken.state, 'open');
  assert.equal(woken.snoozed_until, null);
  assert.equal(after.json.counts.now, 1, 'the counts describe the board as returned, wake included');
});

test('snoozing without an until defaults to 09:00 tomorrow in the configured timezone', async (t) => {
  // A fixed-offset zone (UTC+14, no DST) that no test machine runs in, so a
  // pass cannot be the server's own local zone answering by coincidence.
  const tz = 'Pacific/Kiritimati';
  const cfg = baseConfig();
  const ctx = await startServer(t, { config: { ...cfg, identity: { ...cfg.identity, timezone: tz } } });
  const { id } = db.upsertItem(ctx.db, { key: 'later-thing', bucket: 'soon', headline: 'Later' });

  const res = await call(ctx, 'POST', `/api/items/${id}/state`, { body: { state: 'snoozed' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.state, 'snoozed');
  assert.equal(res.json.snoozed_until, `${addDaysToKey(todayKey(tz), 1)}T09:00:00+14:00`);
});

test('an explicit null until is the manual snooze: no deadline, wake by hand', async (t) => {
  const ctx = await startServer(t);
  const { id } = db.upsertItem(ctx.db, { key: 'manual-snooze', bucket: 'now', headline: 'Set aside' });

  // null is not "use the default" — that is what ABSENCE means. null is the
  // legacy manual snooze, and Undo depends on the difference: restoring a
  // snoozed item that never had a deadline must not gift it one.
  const res = await call(ctx, 'POST', `/api/items/${id}/state`, { body: { state: 'snoozed', until: null } });
  assert.equal(res.status, 200);
  assert.equal(res.json.state, 'snoozed');
  assert.equal(res.json.snoozed_until, null);

  // And with no deadline, no amount of reading the board wakes it.
  const later = await call(ctx, 'GET', '/api/state');
  assert.equal(later.status, 200);
  const row = later.json.items.find((i) => i.id === id);
  assert.equal(row.state, 'snoozed');
  assert.equal(row.snoozed_until, null);
});

test('a snooze with an unusable until is refused and changes nothing', async (t) => {
  const ctx = await startServer(t);
  const { id } = db.upsertItem(ctx.db, { key: 'nope-snooze', bucket: 'now', headline: 'Nope' });

  for (const until of ['not-a-date', '2026-13-45T99:00:00Z', '2020-01-01T09:00:00Z', 12345, {}]) {
    const res = await call(ctx, 'POST', `/api/items/${id}/state`, { body: { state: 'snoozed', until } });
    assert.equal(res.status, 400, `until ${JSON.stringify(until)} should have been refused`);
    assert.equal(typeof res.json.error, 'string');
  }
  assert.equal(db.getItem(ctx.db, id).state, 'open', 'a refused snooze leaves the item untouched');
  assert.equal(db.getItem(ctx.db, id).snoozed_until, null);
});

test('a capture is stored and immediately searchable', async (t) => {
  const ctx = await startServer(t);
  const made = await call(ctx, 'POST', '/api/capture', { body: { text: 'Ring the accountant about depreciation' } });
  assert.equal(made.status, 201);
  assert.match(made.json.id, /^cap_/);

  const found = await call(ctx, 'GET', '/api/search?q=accountant');
  assert.equal(found.status, 200);
  assert.equal(found.json.results.length, 1);
  assert.equal(found.json.results[0].ref, `cap:${made.json.id}`);

  const empty = await call(ctx, 'POST', '/api/capture', { body: { text: '   ' } });
  assert.equal(empty.status, 400);
});

test('a draft can be edited, and markup in one is refused', async (t) => {
  const ctx = await startServer(t);
  const { id } = db.upsertDraft(ctx.db, {
    itemId: 'i_1', to: 'ada@example.com', subject: 'Budget review', body: 'Tuesday works.',
  });

  const edited = await call(ctx, 'PUT', `/api/drafts/${id}`, {
    body: { body: 'Tuesday at 2 works for me.', state: 'edited' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.body, 'Tuesday at 2 works for me.');
  assert.equal(edited.json.state, 'edited');

  const hostile = await call(ctx, 'PUT', `/api/drafts/${id}`, {
    body: { body: 'Hi <script>fetch("http://evil.example")</script>' },
  });
  assert.equal(hostile.status, 400);

  const missing = await call(ctx, 'PUT', '/api/drafts/nope', { body: { body: 'hello' } });
  assert.equal(missing.status, 404);
});

test('config round-trips through GET and PUT', async (t) => {
  const ctx = await startServer(t);
  const before = await call(ctx, 'GET', '/api/config');
  assert.equal(before.status, 200);
  assert.ok(Array.isArray(before.json.errors));

  const after = await call(ctx, 'PUT', '/api/config', {
    body: { identity: { name: 'Nemo', email: 'nemo@example.com' }, ui: { theme: 'blackfigure' } },
  });
  assert.equal(after.json.config.identity.name, 'Nemo');
  assert.equal(after.json.config.ui.theme, 'blackfigure');

  // Saved even though it is incomplete, with the reasons attached — setup is
  // progressive, and a form you cannot save is a form you cannot come back to.
  const invalid = await call(ctx, 'PUT', '/api/config', { body: { sweep: { intervalMinutes: 1 } } });
  assert.equal(invalid.status, 200);
  assert.ok(invalid.json.errors.some((e) => e.path === 'sweep.intervalMinutes'));

  const bad = await call(ctx, 'PUT', '/api/config', { body: [] });
  assert.equal(bad.status, 400);
});

/**
 * REGRESSION (#2). The Scheduler holds the config object it was CONSTRUCTED
 * with. `ctx.setConfig` replaced only the route-facing copy, so on a default
 * install — `sweep.auto: true`, which is where the Scheduler exists — nothing a
 * person changed in Settings reached a sweep until the process was restarted.
 * Not the interval, not the active hours, and not "Send message bodies to the
 * model", whose own hint in the UI reads "This setting genuinely changes what is
 * sent — it is not a label."
 *
 * The Scheduler is also what "Sweep now" runs through when there is one
 * (SweepSupervisor prefers it), so the button did not escape it either. Both
 * halves are asserted here: the object handed over, and the fact that the sweep
 * that actually runs is the one carrying it.
 */
test('a config save reaches the scheduler, not just the route', async (t) => {
  const seen = [];
  const sweptWith = [];
  const scheduler = {
    config: null,
    reconfigure(next) { seen.push(next); this.config = next; },
    status: () => ({ running: true, busy: false }),
    runNow() { sweptWith.push(this.config); return Promise.resolve({ ok: true, runId: 'r1', stats: {} }); },
  };
  const ctx = await startServer(t, { scheduler });

  const saved = await call(ctx, 'PUT', '/api/config', {
    body: { privacy: { sendBodies: false }, sweep: { intervalMinutes: 45 } },
  });
  assert.equal(saved.status, 200);

  assert.equal(seen.length, 1, 'PUT /api/config must hand the saved config to the scheduler');
  assert.equal(seen[0].privacy.sendBodies, false,
    'the scheduler must be holding the privacy setting the user just unticked');
  assert.equal(seen[0].sweep.intervalMinutes, 45);
  // The same object the route answered with, so the two can never describe
  // different configs to two different readers.
  assert.deepEqual(seen[0].privacy, saved.json.config.privacy);

  // ...and the sweep that runs is the one holding it.
  assert.equal((await call(ctx, 'POST', '/api/sweep', { body: { mode: 'auto' } })).status, 202);
  await delay(50);
  assert.equal(sweptWith.length, 1);
  assert.equal(sweptWith[0].privacy.sendBodies, false,
    '"Sweep now" goes through the scheduler, so it must sweep with the new config too');
});

/**
 * REGRESSION. core/config.mjs refuses a patch that would write a config
 * `loadConfig()` could not read back, and it refuses it by throwing before the
 * write. That is the caller's mistake, and it came back as a 500 with the reason
 * stripped — the branch that deliberately says nothing about an unexpected
 * error, because an unexpected error's text is not ours to echo. This one IS
 * ours: it names the section the request got wrong.
 */
test('a config patch with a malformed section is a 400 that says which', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'PUT', '/api/config', { body: { identity: 5 } });
  assert.equal(res.status, 400, 'a bad patch is the caller\'s fault, not the server\'s');
  assert.match(res.json.error, /identity/);
  assert.equal(res.json.detail, undefined);
  // Nothing was written, and the server is still serving the config it had.
  assert.equal((await call(ctx, 'GET', '/api/config')).status, 200);
});

/**
 * REGRESSION. A patch whose `mail`, `calendars` or `sources` was not a list —
 * a string, null, an object — came back 200 with `errors: []` and `mail: []`,
 * and config.json on disk had been rewritten to match: every account deleted
 * by a request that was told it succeeded. core/config.mjs refuses those with
 * the same TypeError it uses for `{"identity": 5}`, and this route already
 * turns that into a 400 that names the section.
 */
test('a config patch whose accounts are not a list is a 400, and the accounts on disk survive', async (t) => {
  const ctx = await startServer(t);
  const file = path.join(HOME, 'config.json');
  // Disabled, so no later test that sweeps against this home reaches for it.
  const seeded = await call(ctx, 'PUT', '/api/config', {
    body: {
      mail: [{ id: 'm_keep', enabled: false, host: 'imap.example', user: 'keep@example.com' }],
      calendars: [{ id: 'c_keep', enabled: false, kind: 'ics', url: 'https://cal.example/x.ics' }],
    },
  });
  assert.equal(seeded.status, 200);
  const before = fs.readFileSync(file, 'utf8');

  for (const body of [{ mail: 'nope' }, { mail: null }, { calendars: {} }, { sources: 5 }, { mail: [{ id: 'm_ok' }, 'garbage'] }]) {
    const res = await call(ctx, 'PUT', '/api/config', { body });
    assert.equal(res.status, 400, `${JSON.stringify(body)}: the caller sent nonsense, and must be told`);
    assert.match(res.json.error, new RegExp(`${Object.keys(body)[0]} must be an array of objects`));
    assert.equal(fs.readFileSync(file, 'utf8'), before, `${JSON.stringify(body)}: config.json must be untouched`);
  }
  const after = await call(ctx, 'GET', '/api/config');
  assert.equal(after.json.config.mail[0].id, 'm_keep');
  assert.equal(after.json.config.calendars[0].id, 'c_keep');

  // This home is shared with the rest of the file: leave it as it was found.
  assert.equal((await call(ctx, 'PUT', '/api/config', { body: { mail: [], calendars: [] } })).status, 200);
});

test('saving calendars forgets what CalDAV remembered about them', async (t) => {
  // The CalDAV client keeps the layout it discovered — principal, home set, the
  // URL whose listing produced calendars — so a sweep costs one request instead
  // of four. A calendar the user has just edited is the one case that record
  // must not survive: the password may have been corrected, a collection may
  // have appeared on the server, or the account may be gone entirely.
  const ctx = await startServer(t);
  const cache = path.join(HOME, 'cache', 'caldav');
  const stale = path.join(cache, 'deadbeef.json');
  const plant = () => {
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(stale, '{"schema":1,"listRoot":"http://127.0.0.1:1/dav/","at":9e12}');
  };

  plant();
  const unrelated = await call(ctx, 'PUT', '/api/config', { body: { identity: { name: 'Nemo' } } });
  assert.equal(unrelated.status, 200);
  assert.equal(fs.existsSync(stale), true, 'a save that names no calendar must not throw the cache away');

  const saved = await call(ctx, 'PUT', '/api/config', {
    body: { calendars: [{ id: 'c_dav', kind: 'caldav', url: 'https://dav.example.test/', user: 'nemo' }] },
  });
  assert.equal(saved.status, 200);
  assert.equal(fs.existsSync(stale), false, 'a calendar was written, so the remembered layout is stale by definition');

  // Removing every calendar counts too — it is still a calendars edit.
  plant();
  await call(ctx, 'PUT', '/api/config', { body: { calendars: [] } });
  assert.equal(fs.existsSync(stale), false);
});

test('malformed JSON is a 400, not a 500', async (t) => {
  const ctx = await startServer(t);
  const res = await fetch(`${ctx.base}/api/capture`, {
    method: 'POST',
    headers: { 'X-Zelos-Token': ctx.token, 'Content-Type': 'application/json' },
    body: '{"text": ',
  });
  assert.equal(res.status, 400);
});

test('an unexpected failure is a 500 that says nothing about itself', async (t) => {
  const ctx = await startServer(t);
  db.close(ctx.db); // the database is gone; the next query cannot succeed
  const res = await call(ctx, 'GET', '/api/state');
  assert.equal(res.status, 500);
  assert.equal(res.json.error, 'internal error');
  assert.match(res.json.detail, /terminal/);
  // The server is still standing.
  assert.equal((await call(ctx, 'GET', '/api/model/presets')).status, 200);
});

/**
 * The 500 body used to send everyone to `~/.zelos/logs/zelos.log`, and nothing
 * in the repo writes that file: the default logger is built with `dir: null` and
 * goes to stderr, and the one file logger belongs to the desktop shell and is
 * called `desktop.log`. `paths()` creates and chmods an empty `logs/` on every
 * launch, so the wrong answer even looked plausible when a stuck person went and
 * checked. The previous assertion pinned the wrong name — it matched the string
 * without ever asking whether the file existed — so this one asks.
 */
test('the 500 detail names a log that exists, or no log at all', async (t) => {
  const bare = await startServer(t);
  db.close(bare.db);
  const noFile = await call(bare, 'GET', '/api/state');
  assert.equal(noFile.status, 500);
  assert.doesNotMatch(noFile.json.detail, /\.log\b/,
    'a server whose logger has no file must not send anybody looking for one');
  assert.match(noFile.json.detail, /terminal/);
  assert.deepEqual(fs.readdirSync(path.join(HOME, 'logs')), [],
    'nothing writes into logs/, which is the whole reason the old string was wrong');

  // ...and a launcher that DOES keep a file says which one, because it is the
  // half of this that knows.
  const named = path.join(HOME, 'logs', 'desktop.log');
  const withFile = await startServer(t, { logFile: named });
  db.close(withFile.db);
  const detail = (await call(withFile, 'GET', '/api/state')).json.detail;
  assert.ok(detail.includes(named), `the 500 should name the log the launcher gave it, got: ${detail}`);
});

test('the wrong method on a real route is a 405 with an Allow list', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'DELETE', '/api/state');
  assert.equal(res.status, 405);
  assert.deepEqual(res.json.allowed, ['GET']);
});

/* ================================================================== *
 * Setup routes
 * ================================================================== */

test('/api/health reports what is and is not set up', async (t) => {
  const upstream = await startMockUpstream(t);
  const bare = await startServer(t);
  const bareHealth = await call(bare, 'GET', '/api/health');
  assert.equal(bareHealth.json.model.configured, false);
  assert.equal(bareHealth.json.home, HOME);
  assert.equal(bareHealth.json.backend.name, 'encrypted-file');
  assert.ok(bareHealth.json.backend.note.length > 40);

  const wired = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });
  const wiredHealth = await call(wired, 'GET', '/api/health');
  // A local endpoint needs no key, so it counts as configured on its own.
  assert.equal(wiredHealth.json.model.configured, true);
  assert.equal(wiredHealth.json.model.local, true);
});

test('/api/model/test and /api/model/list talk to the configured endpoint', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: 'model.default' },
    }),
  });

  const tested = await call(ctx, 'POST', '/api/model/test', { body: {} });
  assert.equal(tested.status, 200);
  assert.equal(tested.json.ok, true);
  assert.equal(tested.json.sample, 'ready');
  assert.ok(tested.json.ms >= 0);

  const listed = await call(ctx, 'GET', '/api/model/list');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.map((m) => m.id), ['mock-model', 'mock-model-mini']);

  const chat = upstream.received.find((r) => r.url.startsWith('/chat/completions'));
  assert.equal(chat.headers.authorization, undefined, 'a keyless local endpoint gets no Authorization header');
});

test('a model that is not answering produces a readable failure, not a 500', async (t) => {
  const dead = await closedPort();
  const ctx = await startServer(t, {
    config: baseConfig({
      model: { protocol: 'openai', baseUrl: `http://127.0.0.1:${dead}`, model: 'mock-model', keyRef: 'model.default' },
    }),
  });
  const res = await call(ctx, 'POST', '/api/model/test', { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, new RegExp(String(dead)), 'the error must name the address that failed');
});

test('/api/model/test refuses a success status with a non-completion body', async (t) => {
  const upstream = await startMockUpstream(t, { jsonReply: { status: 'ok' } });
  const ctx = await startServer(t, { config: baseConfig({
    model: { protocol: 'openai', baseUrl: upstream.baseUrl, model: 'mock-model', keyRef: '' },
  }) });
  const result = await call(ctx, 'POST', '/api/model/test', { body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /invalid openai response/i);
});

test('/api/model/presets covers the providers a user might pick', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'GET', '/api/model/presets');
  assert.equal(res.status, 200);
  const ids = res.json.map((p) => p.id);
  for (const wanted of ['anthropic', 'openai', 'ollama', 'lmstudio']) {
    assert.ok(ids.includes(wanted), `missing preset ${wanted}`);
  }
  assert.ok(res.json.every((p) => p.protocol === 'openai' || p.protocol === 'anthropic'));
});

/**
 * The guided setup cards send a person to four pages — Google Calendar's
 * settings, Apple's app-specific passwords and iCloud's CalDAV host, Outlook's
 * calendar, and the Microsoft section of docs/OAUTH.md. They are served from
 * here because ui/ names no remote host at all (test/ui.test.mjs,
 * test/repo.test.mjs and test/security.test.mjs each assert it): the page
 * works offline, and the only addresses it ever links are ones this server
 * handed it — as PRESETS' key pages and the mail guess's app-password pages
 * already were.
 */
test('/api/guides hands the guided cards their pages, every one https, and nothing else', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'GET', '/api/guides');
  assert.equal(res.status, 200);
  const g = res.json;
  assert.match(g.microsoftSetup, /^https:\/\/github\.com\/HoosAI-Platform\/zelos\/blob\/main\/docs\/OAUTH\.md#microsoft/);
  assert.match(g.calendars.google.settings, /^https:\/\/calendar\.google\.com\//);
  assert.match(g.calendars.icloud.caldav, /^https:\/\/caldav\.icloud\.com\//);
  assert.match(g.calendars.icloud.appPasswords, /^https:\/\/account\.apple\.com\//);
  assert.match(g.calendars.outlook.calendar, /^https:\/\/outlook\.live\.com\//);
  const every = (value) => (typeof value === 'string' ? [value] : Object.values(value).flatMap(every));
  for (const url of every(g)) assert.match(url, /^https:\/\/\S+$/, `${url} is not an https page`);
  assert.deepEqual(Object.keys(g).sort(), ['calendars', 'microsoftSetup'], 'the route carries more than the four pages');
  // The anchor is GitHub's slug for the heading docs/OAUTH.md actually has.
  const doc = fs.readFileSync(new URL('../docs/OAUTH.md', import.meta.url), 'utf8');
  const heading = /^## Microsoft — register Zelos's multi-tenant public client$/m.test(doc);
  assert.ok(heading, 'docs/OAUTH.md no longer has the Microsoft heading the link points at');
  assert.match(g.microsoftSetup, /#microsoft--register-zeloss-multi-tenant-public-client$/);
});

/**
 * "Ask Claude to walk me through this." POST /api/help hands the page the
 * message core/help.mjs writes for one setup screen, and the two links that
 * open a chat with it typed in. Three things are the route's own to get
 * right, and are tested here rather than in test/help.test.mjs: the shape on
 * the wire, the platform — this process's, never the body's — and that
 * nothing the body carries beyond a step and a provider's name comes back.
 */
test('POST /api/help answers the message and links for a step, with the platform this server runs on', async (t) => {
  const { platformName, HELP_RULES } = await import('../core/help.mjs');
  const ctx = await startServer(t);
  const res = await call(ctx, 'POST', '/api/help', { body: { step: 'ai' } });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['chatgpt', 'claude', 'platform', 'prompt', 'step', 'title']);
  assert.equal(res.json.step, 'ai');
  assert.equal(res.json.platform, platformName(process.platform), 'the platform is not the one the server is running on');
  assert.match(res.json.claude, /^https:\/\/claude\.ai\/new\?q=/);
  assert.match(res.json.chatgpt, /^https:\/\/chatgpt\.com\/\?q=/);
  assert.equal(new URL(res.json.claude).searchParams.get('q'), res.json.prompt);
  assert.match(res.json.prompt, /Pick the AI that reads your mail/);
  for (const rule of HELP_RULES) assert.ok(res.json.prompt.includes(rule), `the message is missing “${rule}”`);
  assert.ok(res.json.prompt.length < 3500);
  // The step is the only required field, and it has to be a real one.
  const bad = await call(ctx, 'POST', '/api/help', { body: { step: 'reboot' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /step must be one of/);
  assert.equal((await call(ctx, 'POST', '/api/help', { body: {} })).status, 400);
  // Behind the session token, like every /api route.
  assert.equal((await call(ctx, 'POST', '/api/help', { token: null, body: { step: 'ai' } })).status, 401);
  assert.equal((await call(ctx, 'GET', '/api/help')).status, 405);
});

test('PRIVACY: POST /api/help ignores the body\'s platform and address, and neither comes back', async (t) => {
  const { platformName } = await import('../core/help.mjs');
  const ctx = await startServer(t);
  const address = 'nemo.underwood@marchetti.example';
  const foreign = platformName(process.platform) === 'windows' ? 'mac' : 'windows';
  const res = await call(ctx, 'POST', '/api/help', {
    body: {
      step: 'email',
      provider: 'Gmail',
      signIn: 'google',
      clientReady: false,
      // What a confused or hostile caller might add. None of it is the route's business.
      platform: foreign,
      email: address,
      user: address,
      password: 'hunter2-app-password',
      keyRef: 'mail.m_1',
      home: '/Users/nemo/.zelos',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.platform, platformName(process.platform), 'the body chose the platform');
  assert.ok(!res.json.prompt.includes(`They are on a ${foreign === 'mac' ? 'Mac' : 'Windows PC'}.`), 'the message says it is the body’s platform');
  assert.ok(!res.text.includes(address), 'the address came back');
  assert.ok(!res.text.includes('marchetti'), 'the domain came back');
  assert.ok(!res.text.includes('hunter2'), 'the password came back');
  assert.ok(!res.text.includes('mail.m_1'), 'the secret ref came back');
  assert.ok(!res.text.includes('/Users/'), 'the home path came back');
  assert.ok(!decodeURIComponent(res.json.claude).includes('marchetti'), 'the address is in the link');
  // What it IS allowed to say: the provider's name.
  assert.match(res.json.prompt, /their email is with Gmail/);
  // And an address sent AS the provider is reduced to "unknown", never echoed.
  const asProvider = await call(ctx, 'POST', '/api/help', { body: { step: 'email', provider: address } });
  assert.equal(asProvider.status, 200);
  assert.ok(!asProvider.text.includes('marchetti'));
  assert.match(asProvider.json.prompt, /A provider Zelos does not know/);
  // The calendar pages in the message are the ones /api/guides serves, not a second copy.
  const guides = (await call(ctx, 'GET', '/api/guides')).json;
  const calendar = await call(ctx, 'POST', '/api/help', { body: { step: 'calendar', provider: 'google' } });
  assert.ok(calendar.json.prompt.includes(guides.calendars.google.settings), 'the calendar message does not name the page /api/guides serves');
  const outlook = await call(ctx, 'POST', '/api/help', { body: { step: 'email', provider: 'Outlook / Microsoft', clientReady: false } });
  assert.ok(outlook.json.prompt.includes(guides.microsoftSetup), 'the Outlook message does not name the setup page /api/guides serves');
});

test('/api/mail/test needs the password to have been stored first', async (t) => {
  const ctx = await startServer(t);
  const res = await call(ctx, 'POST', '/api/mail/test', {
    body: { host: 'imap.example.com', port: 993, secure: true, user: 'nemo', keyRef: 'mail.m_absent' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /POST \/api\/secrets/);
});

/**
 * The simple mail form's one question, and the one route whose entire input
 * is somebody's email address. POST so the address is never in a URL — a
 * query string is kept in history and sent as a Referer — and a handler that
 * writes nothing down, checked against the log itself rather than by reading
 * the handler: the logger is the test's, and it is proved to be the one the
 * server writes to before the absence of the address in it means anything.
 */
test('POST /api/mail/guess names the provider, wants the token, and never writes the address down', async (t) => {
  const lines = [];
  const record = (lvl) => (msg, meta) => { lines.push(`${lvl} ${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`); };
  const logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error'), child() { return this; } };
  // The resolver is the test's: an unknown domain would otherwise go to the real one.
  const asked = [];
  const nxdomain = async (name) => { asked.push(name); throw Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' }); };
  const ctx = await startServer(t, { logger, dns: { resolveMx: nxdomain, resolveSrv: nxdomain } });
  const address = 'marcus.aurelius.stoic@gmail.com';

  const gmail = await call(ctx, 'POST', '/api/mail/guess', { body: { email: address } });
  assert.equal(gmail.status, 200);
  assert.equal(gmail.json.label, 'Gmail');
  assert.equal(gmail.json.host, 'imap.gmail.com');
  assert.equal(gmail.json.auth, 'password');
  assert.equal(gmail.json.known, true);
  assert.match(gmail.json.appPasswordUrl, /^https:\/\//);

  const guessed = await call(ctx, 'POST', '/api/mail/guess', { body: { email: 'marcus@deco-associates.example' } });
  assert.equal(guessed.status, 200);
  assert.equal(guessed.json.known, false);
  assert.equal(guessed.json.host, 'imap.deco-associates.example');
  assert.equal(guessed.json.via, 'guess');
  // Only the unknown domain was asked about — MX, then SRV — and never the address.
  assert.deepEqual(asked, ['deco-associates.example', '_imaps._tcp.deco-associates.example']);

  // The same gate as every other route, and only the one verb.
  assert.equal((await call(ctx, 'POST', '/api/mail/guess', { token: null, body: { email: address } })).status, 401);
  const wrongVerb = await call(ctx, 'GET', '/api/mail/guess');
  assert.equal(wrongVerb.status, 405);
  assert.deepEqual(wrongVerb.json.allowed, ['POST']);

  // Blank, absent or not a string: a 400 that names the field and never its value.
  for (const body of [{}, { email: '' }, { email: '   ' }, { email: 42 }, { email: null }, { email: ['a@b.example'] }, { email: `${address}`.padEnd(400, 'x') }]) {
    const res = await call(ctx, 'POST', '/api/mail/guess', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.json.error, /^email /, JSON.stringify(body));
    assert.ok(!res.text.includes(address), 'a 400 echoed the address');
  }

  // The capture is real: a line the server is known to write lands in it.
  await call(ctx, 'GET', '/api/health', { headers: { Origin: 'http://evil.example' } });
  assert.ok(lines.some((l) => l.includes('refused a request from a foreign origin')), 'the test logger is not the one the server writes to');
  // And the address is on none of them, at any level.
  const leaked = lines.filter((l) => l.includes(address) || l.includes('deco-associates'));
  assert.deepEqual(leaked, [], 'the address was written to the log');
});

/**
 * The operator's own mailbox: a custom domain on Google Workspace. The table
 * cannot know it, so the route asks the resolver who hosts the domain's mail
 * — through `createServer({dns})`, the way `deviceAuth` keeps Microsoft out
 * of the test run — and answers with the Gmail row under the Workspace name.
 * The resolver sees the domain; the log sees nothing.
 */
test('POST /api/mail/guess discovers a Workspace domain through its MX, and the address reaches neither DNS nor the log', async (t) => {
  const lines = [];
  const record = (lvl) => (msg, meta) => { lines.push(`${lvl} ${msg} ${meta === undefined ? '' : JSON.stringify(meta)}`); };
  const logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error'), child() { return this; } };
  const asked = [];
  const dns = {
    resolveMx: async (name) => {
      asked.push(name);
      return [{ priority: 20, exchange: 'alt1.aspmx.l.google.com.' }, { priority: 10, exchange: 'aspmx.l.google.com.' }];
    },
    resolveSrv: async (name) => { asked.push(name); return []; },
  };
  const ctx = await startServer(t, { logger, dns });
  const address = 'nemo.the.operator@workspace-shaped.example';

  const res = await call(ctx, 'POST', '/api/mail/guess', { body: { email: address } });
  assert.equal(res.status, 200);
  assert.equal(res.json.known, true);
  assert.equal(res.json.via, 'mx');
  assert.equal(res.json.mx, 'aspmx.l.google.com');
  assert.equal(res.json.label, 'Google Workspace');
  assert.equal(res.json.host, 'imap.gmail.com');
  assert.equal(res.json.port, 993);
  assert.equal(res.json.auth, 'password');
  assert.equal(res.json.appPasswordUrl, 'https://myaccount.google.com/apppasswords');

  assert.deepEqual(asked, ['workspace-shaped.example'], 'the domain, once, and nothing after a hit');
  assert.ok(asked.every((name) => !name.includes('@')), 'the address went to the resolver');

  await call(ctx, 'GET', '/api/health', { headers: { Origin: 'http://evil.example' } });
  assert.ok(lines.some((l) => l.includes('refused a request from a foreign origin')), 'the test logger is not the one the server writes to');
  const leaked = lines.filter((l) => l.includes(address) || l.includes('workspace-shaped') || l.includes('aspmx'));
  assert.deepEqual(leaked, [], 'the address, the domain or the exchange was written to the log');
});

test('/api/calendar/test reads an ics feed and refuses a dangerous url', async (t) => {
  const upstream = await startMockUpstream(t);
  const ctx = await startServer(t);

  const ok = await call(ctx, 'POST', '/api/calendar/test', {
    body: { kind: 'ics', url: `${upstream.baseUrl}/calendar.ics` },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.calendars[0].name, 'Mock Calendar');
  assert.equal(ok.json.events, 1);

  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>']) {
    const refused = await call(ctx, 'POST', '/api/calendar/test', { body: { kind: 'ics', url } });
    assert.equal(refused.status, 400, `${url} should have been refused`);
  }

  const missing = await call(ctx, 'POST', '/api/calendar/test', {
    body: { kind: 'file', url: path.join(STATIC_ROOT, 'no-such-calendar.ics') },
  });
  assert.equal(missing.status, 200);
  assert.equal(missing.json.ok, false);
});

/**
 * A calendar host that redirects, and counts who was asked.
 *
 * Each one is a separate listener on its own port, which makes each a separate
 * ORIGIN — that is the whole point: the rule under test is about origins, and a
 * chain of paths on one host would pass a broken implementation.
 */
async function startRedirectingIcs(t, { to = null } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (to) {
      res.writeHead(302, { Location: typeof to === 'function' ? to() : to });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(ICS_BODY);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { port, baseUrl: `http://127.0.0.1:${port}`, hits };
}

/**
 * REGRESSION (#43). This route and core/doctor.mjs were the only two network
 * readers in the repo that handed redirect policy to `fetch`. `redirect:
 * 'follow'` is not a policy — it is undici's, and undici's is twenty. Measured
 * on Node 26.3.0: a 6-origin chain returned 200 having contacted six hosts, and
 * a 22-origin chain contacted twenty-one before giving up. So pressing "Test" on
 * a calendar address opened connections to up to twenty hosts the user never
 * typed, inside the same passage of docs/SECURITY.md that invites the reader to
 * check with tcpdump and promises "one hop".
 */
test('/api/calendar/test follows one hop, and only one', async (t) => {
  const third = await startRedirectingIcs(t);
  const second = await startRedirectingIcs(t, { to: `${third.baseUrl}/calendar.ics` });
  const first = await startRedirectingIcs(t, { to: `${second.baseUrl}/calendar.ics` });
  const ctx = await startServer(t);

  const res = await call(ctx, 'POST', '/api/calendar/test', {
    body: { kind: 'ics', url: `${first.baseUrl}/calendar.ics` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false, 'a second redirect is not followed, so the read did not succeed');
  assert.equal(first.hits.length, 1);
  assert.equal(second.hits.length, 1);
  assert.equal(third.hits.length, 0,
    'the third host was never typed by anybody and must never be contacted');

  // ...and it says which end of the chain went wrong. Handing the second 3xx
  // back as a response reaches the `!response.ok` arm and prints "<the address
  // you typed> answered 302 Found" — true of nothing that happened, and it
  // sends the reader to inspect the one host in the chain that behaved.
  assert.match(res.json.error, /redirected more than once/);
  assert.ok(res.json.error.includes(second.baseUrl),
    `the hop that redirected again has to be named, got: ${res.json.error}`);
  assert.equal(/answered 30\d/.test(res.json.error), false,
    `"answered 302" describes the first host, which answered exactly one redirect as allowed: ${res.json.error}`);
});

/**
 * REGRESSION (#43, the deadline half). `AbortSignal.timeout` minted inside the
 * per-hop helper reads as harmless and is not: a host that stalls for
 * twenty-nine seconds and then answers 302 hands the redirect target a whole
 * fresh thirty, so "Test it" can hold the panel for a minute on a budget that
 * says thirty seconds — and the stall is the hostile half, freely chosen by the
 * host. core/doctor.mjs holds one signal across both of its hops and says so.
 *
 * Thirty seconds is not a thing a test can sit through, so the pair is compared
 * by identity instead of by the clock: two `AbortSignal.timeout` calls cannot
 * return the same object, and one deadline shared cannot return two.
 */
test('/api/calendar/test spends one deadline on both hops, not one each', async (t) => {
  const target = await startRedirectingIcs(t);
  const entry = await startRedirectingIcs(t, { to: `${target.baseUrl}/calendar.ics` });
  const ctx = await startServer(t);

  // Only the calendar hops are recorded; `call()` below reaches the server under
  // test through this same global, and it must pass through untouched.
  const realFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = (input, init) => {
    const href = typeof input === 'string' ? input : String(input?.url ?? input);
    if (href.includes(`:${entry.port}/`) || href.includes(`:${target.port}/`)) signals.push(init?.signal);
    return realFetch(input, init);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const res = await call(ctx, 'POST', '/api/calendar/test', {
    body: { kind: 'ics', url: `${entry.baseUrl}/calendar.ics` },
  });
  globalThis.fetch = realFetch;

  assert.equal(res.json.ok, true, `the one allowed hop still has to work: ${res.json.error}`);
  assert.equal(signals.length, 2, 'the redirect was followed, so there are two hops to compare');
  assert.ok(signals[0] instanceof AbortSignal, 'a hop with no deadline at all can hang forever');
  assert.equal(signals[0], signals[1],
    'the second hop must inherit the first hop\'s deadline, not open a new one');
});

/**
 * The credential half of the same rule, mirroring test/security.test.mjs against
 * the sweep reader: one hop is allowed, and the stored password crosses it only
 * when the hop stayed on the origin the user typed.
 */
test('/api/calendar/test re-sends the calendar password on a same-origin hop and not across one', async (t) => {
  await setSecret('calendar.c_hop', SECRET_VALUE);
  t.after(() => deleteSecret('calendar.c_hop').catch(() => {}));

  const elsewhere = await startRedirectingIcs(t);
  const home = await startRedirectingIcs(t, { to: `${elsewhere.baseUrl}/calendar.ics` });
  const ctx = await startServer(t);

  const away = await call(ctx, 'POST', '/api/calendar/test', {
    body: { kind: 'ics', url: `${home.baseUrl}/calendar.ics`, user: 'nemo', keyRef: 'calendar.c_hop' },
  });
  assert.equal(away.status, 200);
  assert.equal(away.json.ok, true, 'one hop is still followed — webcal hosts answer 301 to their CDN');
  assert.ok(home.hits[0].authorization?.startsWith('Basic '),
    'the host the user typed is the host they meant to authenticate to');
  assert.equal(elsewhere.hits[0].authorization, null,
    'the password must not cross an origin the user never typed');
  // Belt and braces: the value itself, not merely the header's absence.
  const raw = elsewhere.hits.map((h) => h.authorization ?? '').join('|');
  assert.equal(raw.includes(Buffer.from(`nemo:${SECRET_VALUE}`).toString('base64')), false);

  // ...and a hop that stays put keeps it.
  const samePort = await startSameOriginRedirect(t);
  const stayed = await call(ctx, 'POST', '/api/calendar/test', {
    body: { kind: 'ics', url: `${samePort.baseUrl}/redirect.ics`, user: 'nemo', keyRef: 'calendar.c_hop' },
  });
  assert.equal(stayed.status, 200);
  assert.equal(stayed.json.ok, true);
  assert.equal(samePort.hits.length, 2);
  assert.ok(samePort.hits[1].authorization?.startsWith('Basic '),
    'a redirect that stayed on the same host must still be authenticated, or every webcal CDN hop breaks');
});

/** One host that redirects `/redirect.ics` to `/calendar.ics` on itself. */
async function startSameOriginRedirect(t) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (req.url.startsWith('/redirect.ics')) {
      res.writeHead(302, { Location: '/calendar.ics' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(ICS_BODY);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { port, baseUrl: `http://127.0.0.1:${port}`, hits };
}

/* ================================================================== *
 * The mail test, under the account's own TLS rule
 *
 * REGRESSION. `requireTls` was stored by core/config.mjs and enforced by
 * core/sources/imap.mjs, and this route — the one place a person watches an
 * account connect — never passed it on. So Settings could show a green tick for
 * a configuration the sweep would refuse to run, or refuse one it would.
 * ================================================================== */

/**
 * A cleartext IMAP server that never offers STARTTLS. Enough of the protocol for
 * testConnection: greet, list capabilities, sign in, list one mailbox, leave.
 */
async function startMockImap(t) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK Zelos server-test mock ready\r\n');

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        received.push(line);
        const [tag, rawVerb] = line.split(' ');
        const verb = (rawVerb || '').toUpperCase();
        if (verb === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (verb === 'LOGIN') socket.write(`${tag} OK LOGIN completed\r\n`);
        else if (verb === 'LIST') socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
        else if (verb === 'LOGOUT') socket.write(`* BYE\r\n${tag} OK done\r\n`);
        else socket.write(`${tag} BAD unexpected command in mock\r\n`);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  });
  return {
    port: server.address().port,
    received,
    sawCredentials: () => received.some((l) => /LOGIN|AUTHENTICATE/i.test(l)),
  };
}

test('/api/mail/test connects under the same TLS rule the sweep will', async (t) => {
  const ctx = await startServer(t);
  const imap = await startMockImap(t);
  await setSecret('mail.m_tls', SECRET_VALUE);
  t.after(() => deleteSecret('mail.m_tls').catch(() => {}));

  const body = {
    host: '127.0.0.1', port: imap.port, secure: false, user: 'nemo', keyRef: 'mail.m_tls',
  };

  const refused = await call(ctx, 'POST', '/api/mail/test', { body: { ...body, requireTls: true } });
  assert.equal(refused.status, 200);
  assert.equal(refused.json.ok, false, 'the account required TLS and the server offered none');
  assert.match(refused.json.error, /still in the clear/);
  assert.ok(!imap.sawCredentials(), `credentials went over cleartext: ${imap.received.join(' | ')}`);
  assert.ok(!refused.text.includes(SECRET_VALUE));

  // ...and the setting is honoured in the other direction too: 127.0.0.1 with
  // nothing asked for is the local-bridge case, which has to keep working.
  const allowed = await call(ctx, 'POST', '/api/mail/test', { body });
  assert.equal(allowed.json.ok, true, allowed.json.error);
  assert.ok(imap.sawCredentials());
});

test('/api/mail/test refuses a requireTls that is not a boolean', async (t) => {
  const ctx = await startServer(t);
  for (const junk of ['true', 'false', 0, 1, 'yes', {}]) {
    const res = await call(ctx, 'POST', '/api/mail/test', {
      body: { host: 'imap.example.com', user: 'nemo', keyRef: 'mail.m_absent', requireTls: junk },
    });
    assert.equal(res.status, 400, JSON.stringify(junk));
    assert.match(res.json.error, /requireTls/);
  }
});

/* ================================================================== *
 * The browser handoff
 *
 * REGRESSION. zelos.mjs gated the tokenless browser launch on
 * `server.zelos.mintHandoff`, and no such function existed — so the branch was
 * dead, and every launch went on putting the session token in an argument
 * vector, which is the exact leak the change was written to close.
 * ================================================================== */

const handoffGet = (ctx, at, headers = {}) =>
  fetch(`${ctx.base}${at}`, { redirect: 'manual', headers });

test('a handoff is traded for the session token exactly once', async (t) => {
  const ctx = await startServer(t);
  assert.equal(typeof ctx.server.zelos.mintHandoff, 'function',
    'zelos.mjs gates the whole tokenless launch on this existing');

  const at = ctx.server.zelos.mintHandoff();
  assert.match(at, /^\/h\/[0-9a-f]{64}$/);
  assert.ok(!at.includes(ctx.token), 'the handoff must not be the token wearing a hat');

  const first = await handoffGet(ctx, at);
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), `/?t=${ctx.token}`);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(first.headers.get('access-control-allow-origin'), null, 'no CORS, ever');

  const second = await handoffGet(ctx, at);
  assert.equal(second.status, 404, 'a one-time link that works twice is not one-time');
  assert.ok(!(await second.text()).includes(ctx.token));
});

test('a handoff that was never minted, or has expired, is refused the same way', async (t) => {
  const ctx = await startServer(t, { handoffTtlMs: 40 });

  const wrong = await handoffGet(ctx, `/h/${'a'.repeat(64)}`);
  assert.equal(wrong.status, 404);
  const wrongBody = await wrong.text();

  const stale = ctx.server.zelos.mintHandoff();
  await delay(90);
  const expired = await handoffGet(ctx, stale);
  assert.equal(expired.status, 404, 'a handoff nobody spent has to stop working on its own');
  assert.equal(await expired.text(), wrongBody, 'and must not say which of the two it was');

  // Two live handoffs do not spend each other, and the one minted after the
  // expiry still works — the pad is not simply broken.
  const fresh = ctx.server.zelos.mintHandoff();
  assert.equal((await handoffGet(ctx, fresh)).status, 302);
});

test('a handoff cannot be spent by a page on another origin, or by anything but GET', async (t) => {
  const ctx = await startServer(t);
  const at = ctx.server.zelos.mintHandoff();

  for (const origin of ['http://evil.example', 'https://127.0.0.1:1', 'null']) {
    const res = await handoffGet(ctx, at, { Origin: origin });
    assert.equal(res.status, 403, `${origin} was allowed to reach the handoff`);
    assert.ok(!(await res.text()).includes(ctx.token));
  }

  const posted = await fetch(`${ctx.base}${at}`, { method: 'POST', redirect: 'manual' });
  assert.equal(posted.status, 405);

  const rebind = await rawRequest(ctx.port, `GET ${at} HTTP/1.1`, ['Host: evil.example']);
  assert.equal(statusOf(rebind), 403);
  assert.ok(!rebind.includes(ctx.token));

  // None of that spent it: the person at the keyboard still gets their browser.
  const mine = await handoffGet(ctx, at);
  assert.equal(mine.status, 302);
  assert.equal(mine.headers.get('location'), `/?t=${ctx.token}`);
});

test('handoffs are unique per mint and per server, and never reach the API gate', async (t) => {
  const a = await startServer(t);
  const b = await startServer(t);

  const seen = new Set([...Array(20).keys()].map(() => a.server.zelos.mintHandoff()));
  assert.equal(seen.size, 20, 'every handoff has to be its own value');

  // A handoff minted by one server is worthless at the other, exactly like the
  // session token it stands in for.
  const foreign = b.server.zelos.mintHandoff();
  assert.equal((await handoffGet(a, foreign)).status, 404);

  // And spending one is not a way into anything else: it hands over the token
  // and nothing about the request that spent it is authenticated.
  const res = await fetch(`${a.base}/api/state`, { headers: { 'X-Zelos-Token': foreign.slice(3) } });
  assert.equal(res.status, 401);
});

/* ================================================================== *
 * Cleanup
 * ================================================================== */

test.after(() => {
  try {
    fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    /* A temp directory that Windows still holds a handle on is litter, not a
       test result. The OS clears it; failing the whole run over it reports a
       defect that does not exist and hides the ones that do. */
    if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
  }
  try {
    fs.rmSync(STATIC_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    /* A temp directory that Windows still holds a handle on is litter, not a
       test result. The OS clears it; failing the whole run over it reports a
       defect that does not exist and hides the ones that do. */
    if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'ENOTEMPTY') throw err;
  }
});

/* ================================================================== *
 * "Sign in with Google": POST /api/mail/oauth {provider: 'google'},
 * GET /oauth/callback, and the status the panel polls
 * ================================================================== */

const GOOGLE_CLIENT = '4242-zelos-test.apps.googleusercontent.com';
const GOOGLE_SECRET = 'GOCSPX-fixture-not-a-real-secret';

/**
 * A Google-shaped authorization server on 127.0.0.1. GET /auth records the
 * request and 302s back to its `redirect_uri` with a code bound to the PKCE
 * challenge and the state; POST /token checks the verifier against that
 * challenge, the redirect it came back to, and — when told to expect one —
 * the client secret, then answers with tokens. A refresh answers with a new
 * access token and, as Google does, no refresh token.
 */
async function startMockGoogle(t, { requireSecret = '', expiresIn = 3600, refreshExpiresIn = 3600 } = {}) {
  const seen = [];
  const byCode = new Map();
  let issued = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (req.method === 'GET' && url.pathname === '/auth') {
      const q = Object.fromEntries(url.searchParams.entries());
      seen.push({ kind: 'auth', query: q });
      const code = `4/code-${crypto.randomBytes(6).toString('hex')}`;
      byCode.set(code, { challenge: q.code_challenge, method: q.code_challenge_method, redirectUri: q.redirect_uri, scope: q.scope });
      const back = new URL(q.redirect_uri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.state);
      res.writeHead(302, { Location: back.toString(), 'Content-Length': 0 });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(body).entries());
        seen.push({ kind: 'token', form });
        if (form.client_id !== GOOGLE_CLIENT) { send(401, { error: 'invalid_client' }); return; }
        if (requireSecret && form.client_secret !== requireSecret) {
          send(401, { error: 'invalid_client', error_description: 'client_secret is missing' });
          return;
        }
        if (form.grant_type === 'authorization_code') {
          const record = byCode.get(form.code);
          const derived = crypto.createHash('sha256').update(String(form.code_verifier), 'ascii').digest('base64url');
          if (!record || record.method !== 'S256' || derived !== record.challenge || record.redirectUri !== form.redirect_uri) {
            send(400, { error: 'invalid_grant' });
            return;
          }
          byCode.delete(form.code);
          issued += 1;
          send(200, { access_token: `ya29.access-${issued}`, refresh_token: '1//refresh-fixture', token_type: 'Bearer', expires_in: expiresIn, scope: record.scope });
          return;
        }
        if (form.grant_type === 'refresh_token') {
          if (form.refresh_token !== '1//refresh-fixture') { send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }); return; }
          issued += 1;
          send(200, { access_token: `ya29.access-${issued}`, token_type: 'Bearer', expires_in: refreshExpiresIn, scope: 'https://mail.google.com/' });
          return;
        }
        send(400, { error: 'unsupported_grant_type' });
      });
      return;
    }
    res.writeHead(404, { 'Content-Length': 0 });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise((r) => server.close(() => r())));
  return {
    seen,
    authorizeUrl: `http://127.0.0.1:${port}/auth`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    tokenRequests: () => seen.filter((s) => s.kind === 'token'),
  };
}

/** A server whose Google is the mock: the two seams, and nothing else changed. */
function googleServer(t, google, options = {}) {
  return startServer(t, { browserAuth: { authorizeUrl: google.authorizeUrl, tokenUrl: google.tokenUrl, ...(options.browserAuth || {}) }, ...options });
}

/** Play the browser: open the auth URL, and come back to Zelos with what Google sent. */
async function signInThrough(ctx, authUrl) {
  const hop = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(hop.status, 302, 'the mock authorization server redirects');
  const back = hop.headers.get('location');
  assert.ok(back.startsWith(`${ctx.base}/oauth/callback?`), `the redirect lands on this server: ${back}`);
  const landing = await fetch(back, { redirect: 'manual' });
  return { back, landing, page: await landing.text() };
}

const nxdomain = async () => { throw Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' }); };
const noDns = { resolveMx: nxdomain, resolveSrv: nxdomain };

test('POST /api/mail/guess says which sign-in a provider has, and whether this install can run it', async (t) => {
  const bare = await startServer(t, { dns: noDns });
  const guess = async (ctx, email) => (await call(ctx, 'POST', '/api/mail/guess', { body: { email } })).json;

  const gmail = await guess(bare, 'nemo@gmail.com');
  assert.equal(gmail.signIn, 'google');
  assert.equal(gmail.clientReady, false, 'nothing shipped yet and nothing configured');
  assert.equal(gmail.auth, 'password', 'a password is still a way in for Gmail');
  const outlook = await guess(bare, 'nemo@hotmail.com');
  assert.equal(outlook.signIn, 'microsoft');
  assert.equal(outlook.clientReady, false);
  for (const email of ['nemo@icloud.com', 'nemo@pm.me', 'marcus@deco-associates.example']) {
    const got = await guess(bare, email);
    assert.equal(got.signIn, null, email);
    assert.equal(got.clientReady, false, email);
  }

  // The operator's own registration, from config, is enough for Google and says nothing about Microsoft.
  const ready = await startServer(t, {
    dns: {
      resolveMx: async () => [{ priority: 10, exchange: 'aspmx.l.google.com.' }],
      resolveSrv: async () => [],
    },
    config: baseConfig({ oauth: { clients: { google: { clientId: GOOGLE_CLIENT } } } }),
  });
  assert.equal((await guess(ready, 'nemo@gmail.com')).clientReady, true);
  assert.equal((await guess(ready, 'nemo@hotmail.com')).clientReady, false);
  const workspace = await guess(ready, 'nemo@workspace-shaped.example');
  assert.equal(workspace.via, 'mx');
  assert.equal(workspace.signIn, 'google');
  assert.equal(workspace.clientReady, true);
});

test('POST /api/mail/oauth {provider: "google"} mints a PKCE request back to the port this server bound', async (t) => {
  const google = await startMockGoogle(t);
  const ctx = await googleServer(t, google);
  const began = await call(ctx, 'POST', '/api/mail/oauth', {
    body: { provider: 'google', keyRef: 'mail.m_g1', clientId: GOOGLE_CLIENT, email: 'nemo@gmail.com' },
  });
  assert.equal(began.status, 200, began.text);
  assert.equal(began.json.provider, 'google');
  assert.equal(began.json.status, 'pending');
  assert.equal(began.json.state, 'pending');
  assert.equal(began.json.keyRef, 'mail.m_g1');
  assert.equal(began.json.clientId, GOOGLE_CLIENT);
  assert.match(began.json.id, /^[0-9a-f]{16}$/);
  const untilExpiry = Date.parse(began.json.expiresAt) - Date.now();
  assert.ok(untilExpiry > 9 * 60_000 && untilExpiry <= 10 * 60_000, `ten minutes to come back, got ${untilExpiry}ms`);

  const url = new URL(began.json.authUrl);
  assert.equal(`${url.origin}${url.pathname}`, google.authorizeUrl);
  const q = url.searchParams;
  assert.equal(q.get('redirect_uri'), `http://127.0.0.1:${ctx.port}/oauth/callback`);
  assert.equal(q.get('client_id'), GOOGLE_CLIENT);
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'https://mail.google.com/');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.get('state'), /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.equal(q.get('client_secret'), null);
  assert.equal(q.get('login_hint'), null, 'the address is not put in a URL');
  assert.ok(!began.json.authUrl.includes('nemo'), 'not under any other name either');

  // The status reads the same shape without the URL, and nothing that could
  // complete the flow.
  const status = await call(ctx, 'GET', `/api/mail/oauth/${began.json.id}`);
  assert.equal(status.status, 200);
  assert.equal(status.json.status, 'pending');
  assert.equal(status.json.provider, 'google');
  assert.equal(status.json.keyRef, 'mail.m_g1');
  assert.equal(status.json.authUrl, undefined);
  assert.ok(!status.text.includes(q.get('state')), 'the state is not readable after the fact');
  assert.ok(!status.text.includes(q.get('code_challenge')));

  // Every state and every challenge is its own; a second server names its own port.
  const other = await googleServer(t, google);
  const again = await call(other, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef: 'mail.m_g1', clientId: GOOGLE_CLIENT } });
  const q2 = new URL(again.json.authUrl).searchParams;
  assert.notEqual(q2.get('state'), q.get('state'));
  assert.notEqual(q2.get('code_challenge'), q.get('code_challenge'));
  assert.equal(q2.get('redirect_uri'), `http://127.0.0.1:${other.port}/oauth/callback`);
  assert.notEqual(other.port, ctx.port);

  // Without the seam the URL is Google's own endpoint, over https.
  const real = await startServer(t);
  const live = await call(real, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef: 'mail.m_g1', clientId: GOOGLE_CLIENT } });
  const realUrl = new URL(live.json.authUrl);
  assert.equal(`${realUrl.origin}${realUrl.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');

  // DELETE cancels, and the cancelled flow reads as cancelled afterwards.
  const cancelled = await call(ctx, 'DELETE', `/api/mail/oauth/${began.json.id}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal(cancelled.json.provider, 'google');
  assert.equal((await call(ctx, 'GET', `/api/mail/oauth/${began.json.id}`)).json.status, 'cancelled');
  assert.equal((await call(ctx, 'DELETE', '/api/mail/oauth/0000000000000000')).status, 404);
  assert.equal((await call(ctx, 'GET', '/api/mail/oauth/0000000000000000')).status, 404);
  assert.equal(google.tokenRequests().length, 0, 'nothing was exchanged');
});

test('a Google sign-in without a client id waits for one to be configured, and then uses it', async (t) => {
  const google = await startMockGoogle(t);
  const bare = await googleServer(t, google);
  const refused = await call(bare, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef: 'mail.m_g2' } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /no Google client is configured/);

  const ready = await googleServer(t, google, { config: baseConfig({ oauth: { clients: { google: { clientId: GOOGLE_CLIENT } } } }) });
  const began = await call(ready, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef: 'mail.m_g2' } });
  assert.equal(began.status, 200, began.text);
  assert.equal(began.json.clientId, GOOGLE_CLIENT, 'the page is told which client it ran against, so it can save it on the account');
  assert.equal(new URL(began.json.authUrl).searchParams.get('client_id'), GOOGLE_CLIENT);
  // A client id in the body wins over the configured one.
  const own = await call(ready, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef: 'mail.m_g2', clientId: 'other.apps.googleusercontent.com' } });
  assert.equal(own.json.clientId, 'other.apps.googleusercontent.com');

  // The same gate and the same field rules as the Microsoft flow.
  assert.equal((await call(ready, 'POST', '/api/mail/oauth', { token: null, body: { provider: 'google', keyRef: 'mail.m_g2' } })).status, 401);
  const wrongProvider = await call(ready, 'POST', '/api/mail/oauth', { body: { provider: 'yahoo', keyRef: 'mail.m_g2' } });
  assert.equal(wrongProvider.status, 400);
  assert.match(wrongProvider.json.error, /provider must be "google" or "microsoft"/);
  const wrongRef = await call(ready, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef: 'model.default' } });
  assert.equal(wrongRef.status, 400);
  assert.match(wrongRef.json.error, /keyRef must name a mail account/);
  const badSecret = await call(ready, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef: 'mail.m_g2', clientSecret: 42 } });
  assert.equal(badSecret.status, 400);
  assert.match(badSecret.json.error, /^clientSecret must be a string/);
});

test('the Google callback exchanges the code with the verifier, files the grant under keyRef, and shows a page with nothing in it', async (t) => {
  const google = await startMockGoogle(t, { requireSecret: GOOGLE_SECRET });
  const ctx = await googleServer(t, google);
  const keyRef = 'mail.m_g3';
  /* The pasted client is not the configured one (there is none), so its
     secret is filed under a ref scoped to that client — the shared name
     stays free for the install's own registration, and a second pasted
     project cannot overwrite the first's secret. */
  const secretRef = googleSecretRefFor(oauthClient(null, 'google'), GOOGLE_CLIENT);
  t.after(() => deleteSecret(keyRef).catch(() => {}));
  t.after(() => deleteSecret(secretRef).catch(() => {}));

  const began = await call(ctx, 'POST', '/api/mail/oauth', {
    body: { provider: 'google', keyRef, clientId: GOOGLE_CLIENT, clientSecret: GOOGLE_SECRET },
  });
  assert.equal(began.status, 200, began.text);
  assert.ok(!began.text.includes(GOOGLE_SECRET), 'the secret is never echoed');
  assert.equal(await getSecret(secretRef), GOOGLE_SECRET, 'the secret went to the store under its client\'s own ref');
  assert.equal(await getSecret('oauth.google.clientSecret'), null, 'the install-wide ref is not overwritten by a pasted client');

  const { back, landing, page } = await signInThrough(ctx, began.json.authUrl);
  assert.equal(landing.status, 200, page);
  assert.match(page, /Signed in\./);
  assert.match(page, /You can close this tab and go back to Zelos\./);
  assert.ok(!/<script/i.test(page), 'no script');
  const sent = new URL(back).searchParams;
  for (const secret of [sent.get('state'), sent.get('code'), 'ya29', 'refresh-fixture', GOOGLE_SECRET, '@']) {
    assert.ok(!page.includes(secret), `the page carries ${secret}`);
  }
  assert.match(landing.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(landing.headers.get('cache-control'), 'no-store');
  assert.equal(landing.headers.get('x-frame-options'), 'DENY');

  // The exchange carried the verifier, the redirect it came back to and the
  // secret from the store — and the mock checked all three before answering.
  const exchanges = google.tokenRequests();
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].form.grant_type, 'authorization_code');
  assert.equal(exchanges[0].form.redirect_uri, `http://127.0.0.1:${ctx.port}/oauth/callback`);
  assert.equal(exchanges[0].form.client_secret, GOOGLE_SECRET);
  assert.match(exchanges[0].form.code_verifier, /^[A-Za-z0-9_-]{43}$/);

  const status = await call(ctx, 'GET', `/api/mail/oauth/${began.json.id}`);
  assert.equal(status.json.status, 'connected');
  assert.equal(status.json.state, 'connected');
  assert.equal(status.json.provider, 'google');
  assert.equal(status.json.keyRef, keyRef);
  assert.equal(status.json.scope, 'https://mail.google.com/');
  assert.equal(status.json.error, null);
  assert.ok(!status.text.includes('ya29') && !status.text.includes('refresh-fixture'), 'no token in a status');

  // Filed under the account's own keyRef, in the shape the Microsoft flow
  // files — so removing the account removes it, and doctor and the sweep read
  // it the way they already do.
  const stored = JSON.parse(await getSecret(keyRef));
  assert.equal(stored.v, 1);
  assert.equal(stored.kind, 'xoauth2');
  assert.equal(stored.accessToken, 'ya29.access-1');
  assert.equal(stored.refreshToken, '1//refresh-fixture');
  assert.equal(stored.tokenType, 'Bearer');
  assert.equal(stored.scope, 'https://mail.google.com/');
  assert.ok(Date.parse(stored.expiresAt) > Date.now());
  assert.ok(Date.parse(stored.obtainedAt) <= Date.now());

  // A replay of the same callback is a stranger's: refused, nothing exchanged, nothing changed.
  const replay = await fetch(back, { redirect: 'manual' });
  assert.equal(replay.status, 400);
  assert.equal(google.tokenRequests().length, 1);
  assert.equal((await call(ctx, 'GET', `/api/mail/oauth/${began.json.id}`)).json.status, 'connected');
  assert.equal(JSON.parse(await getSecret(keyRef)).accessToken, 'ya29.access-1');
});

test('the Google callback takes no session token, and takes nothing it did not issue', async (t) => {
  const google = await startMockGoogle(t);
  const ctx = await googleServer(t, google);
  const began = await call(ctx, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef: 'mail.m_g4', clientId: GOOGLE_CLIENT } });
  const state = new URL(began.json.authUrl).searchParams.get('state');
  const pending = async () => (await call(ctx, 'GET', `/api/mail/oauth/${began.json.id}`)).json.status;

  // No state, a wrong state, a near miss: the same generic page, no hint
  // about what was wrong, the flow untouched, and no request to Google.
  for (const query of ['', '?code=4%2Fabc', '?state=&code=4%2Fabc', '?state=nope&code=4%2Fabc', `?state=${state.slice(0, -1)}x&code=4%2Fabc`, `?state=${state.toUpperCase()}&code=4%2Fabc`]) {
    const res = await fetch(`${ctx.base}/oauth/callback${query}`, { redirect: 'manual' });
    const page = await res.text();
    assert.equal(res.status, 400, query);
    assert.match(page, /Zelos refused that callback/, query);
    assert.ok(!page.includes('state') || !page.includes(state), query);
    assert.ok(!/<script/i.test(page));
    assert.equal(await pending(), 'pending', query);
  }
  assert.equal(google.tokenRequests().length, 0);

  // Only a navigation: the wrong verb, a foreign Host, a page's Origin.
  const posted = await fetch(`${ctx.base}/oauth/callback?state=${state}&code=4%2Fabc`, { method: 'POST', redirect: 'manual' });
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get('allow'), 'GET');
  const foreignHost = await rawRequest(ctx.port, `GET /oauth/callback?state=${state}&code=4%2Fabc HTTP/1.1`, ['Host: zelos.example']);
  assert.match(foreignHost, /^HTTP\/1\.1 403/);
  const scripted = await fetch(`${ctx.base}/oauth/callback?state=${state}&code=4%2Fabc`, { redirect: 'manual', headers: { Origin: 'http://evil.example' } });
  assert.equal(scripted.status, 403);
  assert.equal(await pending(), 'pending', 'none of that spent the state');
  assert.equal(google.tokenRequests().length, 0);

  // Google's own refusal: the flow fails with a generic reason, and the state is spent.
  const declined = await fetch(`${ctx.base}/oauth/callback?state=${state}&error=access_denied&error_description=The%20user%20denied%20access`, { redirect: 'manual' });
  assert.equal(declined.status, 400);
  const failed = (await call(ctx, 'GET', `/api/mail/oauth/${began.json.id}`)).json;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /did not complete the sign-in/);
  assert.ok(!failed.error.includes('denied access'), 'Google\'s wording is not echoed');
  const late = await fetch(`${ctx.base}/oauth/callback?state=${state}&code=4%2Fabc`, { redirect: 'manual' });
  assert.equal(late.status, 400);
  assert.equal(google.tokenRequests().length, 0);
});

test('native maintenance cancels an in-flight Google exchange and waits until it can no longer save credentials', async (t) => {
  let entered;
  let release;
  let signal;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const keyRef = 'mail.m_backup_cancel';
  await deleteSecret(keyRef);
  const ctx = await startServer(t, { browserAuth: {
    authorizeUrl: 'http://127.0.0.1:12345/auth', tokenUrl: 'http://127.0.0.1:12345/token',
    fetchImpl: async (_url, options) => {
      signal = options.signal; entered();
      // A transport/credential operation may ignore cancellation until its
      // current await ends. Maintenance must not infer completion from abort.
      await waiting;
      return new Response(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer' }));
    },
  } });
  const began = await call(ctx, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef, clientId: GOOGLE_CLIENT } });
  const state = new URL(began.json.authUrl).searchParams.get('state');
  const callback = fetch(`${ctx.base}/oauth/callback?state=${state}&code=fixture-code`);
  await started;
  let done = false;
  const quiesced = ctx.server.zelos.cancelSignInsAndWait().then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(done, false, 'aborting an exchange is not proof its write work ended');
  release(); await quiesced;
  assert.equal((await callback).status, 400);
  assert.equal(await getSecret(keyRef), null, 'cancelled credentials must not be stored after quiescence');
});

test('native maintenance cancels Microsoft authorization even before its user code arrives', async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const upstream = http.createServer((_req, _res) => { entered(); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const ctx = await startServer(t, { deviceAuth: { endpoint: `http://127.0.0.1:${upstream.address().port}` } });
  const request = call(ctx, 'POST', '/api/mail/oauth', { body: { keyRef: 'mail.m_backup_start', clientId: '11111111-2222-3333-4444-555555555555' } });
  await started;
  await ctx.server.zelos.cancelSignInsAndWait();
  assert.equal((await request).status, 502);
  assert.equal(await getSecret('mail.m_backup_start'), null);
});

test('a Google sign-in nobody comes back to expires, and an exchange Google refuses fails without leaking', async (t) => {
  const google = await startMockGoogle(t, { requireSecret: GOOGLE_SECRET });
  const secretRef = googleSecretRefFor(oauthClient(null, 'google'), GOOGLE_CLIENT);
  t.after(() => deleteSecret('oauth.google.clientSecret').catch(() => {}));
  await deleteSecret('oauth.google.clientSecret').catch(() => {});
  await deleteSecret(secretRef).catch(() => {});

  const short = await googleServer(t, google, { browserAuth: { ttlMs: 60 } });
  const began = await call(short, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef: 'mail.m_g5', clientId: GOOGLE_CLIENT } });
  assert.equal(began.status, 200, began.text);
  await delay(90);
  const expired = (await call(short, 'GET', `/api/mail/oauth/${began.json.id}`)).json;
  assert.equal(expired.status, 'expired');
  assert.match(expired.error, /not finished in time/);
  const state = new URL(began.json.authUrl).searchParams.get('state');
  assert.equal((await fetch(`${short.base}/oauth/callback?state=${state}&code=4%2Fabc`, { redirect: 'manual' })).status, 400,
    'an expired flow takes no callback');
  assert.equal(google.tokenRequests().length, 0);

  // No secret in the store and a client that needs one: Google says no at
  // /token, the browser is told it was refused, and the panel gets the
  // endpoint's words — which can only ever be its `error` and description.
  const ctx = await googleServer(t, google);
  const keyRef = 'mail.m_g6';
  t.after(() => deleteSecret(keyRef).catch(() => {}));
  const second = await call(ctx, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef, clientId: GOOGLE_CLIENT } });
  const { landing, page } = await signInThrough(ctx, second.json.authUrl);
  assert.equal(landing.status, 400);
  assert.match(page, /Zelos refused that callback/);
  const failed = (await call(ctx, 'GET', `/api/mail/oauth/${second.json.id}`)).json;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /invalid_client/);
  assert.equal(failed.reconnect, true);
  assert.equal(await getSecret(keyRef), null, 'no grant was filed');
  assert.equal(google.tokenRequests().length, 1);
  assert.equal(google.tokenRequests()[0].form.client_secret, undefined, 'nothing in the store, nothing sent');
});

test('Sign in with Microsoft answers as it did, now naming its provider and status, and can take its client from config', async (t) => {
  const ENTRA_CLIENT = '11111111-2222-3333-4444-555555555555';
  const seen = [];
  const entra = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      seen.push({ path: url.pathname, form: Object.fromEntries(new URLSearchParams(body).entries()) });
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (/\/oauth2\/v2\.0\/devicecode$/.test(url.pathname)) {
        send(200, {
          device_code: 'device-code-secret-never-shown', user_code: 'HXQR-2K9T',
          verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5,
          message: 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code HXQR-2K9T to authenticate.',
        });
        return;
      }
      send(400, { error: 'authorization_pending' });
    });
  });
  await new Promise((resolve) => entra.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((r) => entra.close(() => r())));
  const endpoint = `http://127.0.0.1:${entra.address().port}`;
  /* The poll sleeps BEFORE its first request, so a cancel sent straight after
     begin lands inside that sleep and the loop reports `cancelled` at its top;
     a shorter sleep would race the cancel against a request in flight, which
     the pad reports as `failed` — over either way, but a different word. */
  const deviceAuth = { endpoint, sleep: () => delay(400) };

  const ctx = await startServer(t, { deviceAuth });
  const began = await call(ctx, 'POST', '/api/mail/oauth', { body: { keyRef: 'mail.m_ms1', clientId: ENTRA_CLIENT, tenantId: 'common' } });
  assert.equal(began.status, 200, began.text);
  assert.equal(began.json.provider, 'microsoft');
  assert.equal(began.json.status, 'pending');
  assert.equal(began.json.state, 'pending', 'the field the first version shipped with is still there');
  assert.equal(began.json.userCode, 'HXQR-2K9T');
  assert.equal(began.json.verificationUri, 'https://microsoft.com/devicelogin');
  assert.equal(began.json.keyRef, 'mail.m_ms1');
  assert.equal(began.json.clientId, ENTRA_CLIENT, 'the page is told which client the flow ran against, so it can save it on the account');
  assert.ok(began.json.expiresAt);
  assert.ok(!began.text.includes('device-code-secret'), 'the device code never crosses to the page');
  const status = await call(ctx, 'GET', `/api/mail/oauth/${began.json.id}`);
  assert.equal(status.json.provider, 'microsoft');
  assert.equal(status.json.status, 'pending');
  const cancelled = await call(ctx, 'DELETE', `/api/mail/oauth/${began.json.id}`);
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal(cancelled.json.provider, 'microsoft');
  for (let i = 0; i < 50 && (await call(ctx, 'GET', `/api/mail/oauth/${began.json.id}`)).json.status === 'pending'; i += 1) await delay(20);
  const ended = (await call(ctx, 'GET', `/api/mail/oauth/${began.json.id}`)).json;
  assert.equal(ended.status, 'cancelled', JSON.stringify(ended));

  // No client id in the body and none configured: the 400 it always was.
  const refused = await call(ctx, 'POST', '/api/mail/oauth', { body: { keyRef: 'mail.m_ms1' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, 'clientId is required');

  // The operator's registration from config, tenant and all.
  const ready = await startServer(t, {
    deviceAuth,
    config: baseConfig({ oauth: { clients: { microsoft: { clientId: ENTRA_CLIENT, tenantId: 'consumers' } } } }),
  });
  const fromConfig = await call(ready, 'POST', '/api/mail/oauth', { body: { provider: 'microsoft', keyRef: 'mail.m_ms2' } });
  assert.equal(fromConfig.status, 200, fromConfig.text);
  assert.equal(fromConfig.json.provider, 'microsoft');
  assert.equal(fromConfig.json.clientId, ENTRA_CLIENT, 'the resolved client rides back to the page here too');
  assert.equal(seen.at(-1).path, '/consumers/oauth2/v2.0/devicecode');
  assert.equal(seen.at(-1).form.client_id, ENTRA_CLIENT);
  await call(ready, 'DELETE', `/api/mail/oauth/${fromConfig.json.id}`);
});

test('POST /api/mail/test takes the Microsoft client from config the way the begin route does', async (t) => {
  const ENTRA_CLIENT = '11111111-2222-3333-4444-555555555555';
  /* The simple card saves `oauth: { provider: 'microsoft', clientId: '' }`
     when the server's own client ran the sign-in. The test button has to
     accept that account the way the begin route did, or a mailbox that just
     signed in is answered with a 400 about a field the user never saw. */
  const ready = await startServer(t, {
    config: baseConfig({ oauth: { clients: { microsoft: { clientId: ENTRA_CLIENT, tenantId: 'consumers' } } } }),
  });
  const res = await call(ready, 'POST', '/api/mail/test', {
    body: { host: '127.0.0.1', port: 993, secure: true, user: 'nemo@hotmail.com', keyRef: 'mail.m_ms9', auth: 'xoauth2', oauth: { provider: 'microsoft' } },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /has not been connected to Microsoft/, 'the refusal is about the missing grant, never about the client id');

  // With nothing configured the refusal names the missing piece, like Google's.
  const bare = await startServer(t);
  const refused = await call(bare, 'POST', '/api/mail/test', {
    body: { host: '127.0.0.1', port: 993, secure: true, user: 'nemo@hotmail.com', keyRef: 'mail.m_ms9', auth: 'xoauth2', oauth: { provider: 'microsoft' } },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /oauth\.clientId is required/);
});

test('POST /api/mail/test on a Google account renews the grant at Google and signs in with the bearer token', async (t) => {
  const google = await startMockGoogle(t);
  const ctx = await googleServer(t, google);
  const keyRef = 'mail.m_g7';
  t.after(() => deleteSecret(keyRef).catch(() => {}));
  const user = 'nemo@gmail.com';
  // Filed where the begin route files a pasted client's secret, so the test
  // button's refresh must read it back from the same scoped ref.
  const secretRef = googleSecretRefFor(oauthClient(null, 'google'), GOOGLE_CLIENT);
  await setSecret(secretRef, GOOGLE_SECRET);
  t.after(() => deleteSecret(secretRef).catch(() => {}));

  // A mail server that speaks AUTH=XOAUTH2 and accepts the token the mock Google hands out.
  const received = [];
  const sasl = [];
  const imap = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=XOAUTH2] mock\r\n');
    let buffer = '';
    let saslTag = null;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        received.push(line);
        if (saslTag) {
          const decoded = Buffer.from(line, 'base64').toString('utf8');
          sasl.push(decoded);
          socket.write(decoded === `user=${user}\x01auth=Bearer ya29.access-2\x01\x01`
            ? `${saslTag} OK AUTHENTICATE completed\r\n`
            : `${saslTag} NO AUTHENTICATE failed.\r\n`);
          saslTag = null;
          continue;
        }
        const [tag, verb = '', ...rest] = line.split(' ');
        switch (verb.toUpperCase()) {
          case 'CAPABILITY': socket.write(`* CAPABILITY IMAP4rev1 AUTH=XOAUTH2\r\n${tag} OK done\r\n`); break;
          case 'AUTHENTICATE': saslTag = tag; socket.write('+ \r\n'); break;
          case 'LOGIN': socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`); break;
          case 'LIST': socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST completed\r\n`); break;
          case 'LOGOUT': socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`); break;
          default: socket.write(`${tag} BAD ${rest.join(' ')}\r\n`);
        }
      }
    });
  });
  await new Promise((resolve) => imap.listen(0, '127.0.0.1', resolve));
  t.after(() => { imap.close(); });
  const imapPort = imap.address().port;

  // Sign in, then spend the grant from the store: the access token Google
  // minted is already expired by the time the test button is pressed.
  const began = await call(ctx, 'POST', '/api/mail/oauth', { body: { provider: 'google', keyRef, clientId: GOOGLE_CLIENT } });
  await signInThrough(ctx, began.json.authUrl);
  const stored = JSON.parse(await getSecret(keyRef));
  await setSecret(keyRef, JSON.stringify({ ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() }));

  const tested = await call(ctx, 'POST', '/api/mail/test', {
    body: { host: '127.0.0.1', port: imapPort, secure: false, user, keyRef, auth: 'xoauth2', oauth: { provider: 'google', clientId: GOOGLE_CLIENT } },
  });
  assert.equal(tested.status, 200, tested.text);
  assert.equal(tested.json.ok, true, tested.json.error);
  assert.ok(tested.json.mailboxes.some((m) => (typeof m === 'string' ? m : m.name) === 'INBOX'));
  assert.deepEqual(google.tokenRequests().map((r) => r.form.grant_type), ['authorization_code', 'refresh_token']);
  assert.equal(google.tokenRequests()[1].form.client_secret, GOOGLE_SECRET, 'the refresh read the secret from the ref the connect filed it under');
  assert.deepEqual(sasl, [`user=${user}\x01auth=Bearer ya29.access-2\x01\x01`], 'the renewed token, not the spent one');
  assert.ok(!received.some((l) => /\bLOGIN\b/i.test(l)), 'no password was tried');
  assert.equal(JSON.parse(await getSecret(keyRef)).accessToken, 'ya29.access-2', 'and the renewal was written back');

  // The block may leave the client id out when config has it.
  const ready = await googleServer(t, google, { config: baseConfig({ oauth: { clients: { google: { clientId: GOOGLE_CLIENT } } } }) });
  const viaConfig = await call(ready, 'POST', '/api/mail/test', {
    body: { host: '127.0.0.1', port: imapPort, secure: false, user, keyRef, auth: 'xoauth2', oauth: { provider: 'google' } },
  });
  assert.equal(viaConfig.json.ok, true, viaConfig.json.error);
  const noClient = await call(ctx, 'POST', '/api/mail/test', {
    body: { host: '127.0.0.1', port: imapPort, secure: false, user, keyRef, auth: 'xoauth2', oauth: { provider: 'google' } },
  });
  assert.equal(noClient.status, 400);
  assert.match(noClient.json.error, /oauth\.clientId is required/);
  const badProvider = await call(ctx, 'POST', '/api/mail/test', {
    body: { host: '127.0.0.1', port: imapPort, secure: false, user, keyRef, auth: 'xoauth2', oauth: { provider: 'gmail', clientId: GOOGLE_CLIENT } },
  });
  assert.equal(badProvider.status, 400);
  assert.match(badProvider.json.error, /oauth\.provider must be/);
});
