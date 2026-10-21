/**
 * test/ai-access.test.mjs — the gate in front of AI access.
 *
 * SPEC-v2 §1 makes Zelos connectable by somebody else's assistant. That is the
 * one feature here that can hand a person's mail to a program they did not
 * write, so this file tests it the way it would be attacked rather than the way
 * it is meant to be used: with the wrong credential, with a revoked one, with
 * the *other* valid credential, and with the master switch off.
 *
 * The four properties that must hold, and each has a test that fails loudly if
 * it stops holding:
 *
 *   1. A valid AI token works.
 *   2. A revoked one does not.
 *   3. The browser session token does NOT authorise /api/mcp.
 *   4. An AI token does NOT authorise any other /api route.
 *
 * Plus the switch: `config.ai.enabled === false` means 403 whatever token is
 * presented, and a token value can be read back from nowhere at all.
 *
 * Nothing here touches the real ~/.zelos and nothing here opens a socket to
 * anything but 127.0.0.1. The secret store is forced to the encrypted-file
 * backend in a temp home, so no test can reach the operator's keychain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The environment has to be settled before the modules that read it are
   evaluated, which static imports would not allow. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-ai-home-'));
process.env.ZELOS_HOME = HOME;
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file'; // never the real keychain
process.env.ZELOS_LOG_LEVEL = 'silent';

const ai = await import('../core/ai-access.mjs');
const { createServer, listen } = await import('../core/server.mjs');
const db = await import('../core/db.mjs');
const { loadConfig, saveConfig, paths } = await import('../core/config.mjs');
const { listRefs, getSecret, setSecret, deleteSecret, secretVersion, ensureNamespace, describeCommand, resetBackendCache } = await import('../core/secrets.mjs');

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/** Put the ai block back to "off, nothing minted" between tests. */
async function resetAi() {
  ai.resetVerifiedTokens?.();
  const cfg = loadConfig();
  for (const token of ai.aiConfig(cfg).tokens) {
    await ai.revokeToken(token.id, { config: loadConfig() });
  }
  return saveConfig({
    ai: { enabled: false, scopes: { ...ai.AI_DEFAULTS.scopes }, tokens: [], maxRows: 50 },
  });
}

/**
 * A stand-in for core/mcp.mjs. The tool layer is another module's job; what
 * this file is testing is who gets to reach it, so the seam is filled with
 * something that records exactly what it was handed.
 */
function stubMcp(impl = null) {
  const calls = [];
  return {
    calls,
    handle: async (request, ctx) => {
      calls.push({ request, ctx });
      if (impl) return impl(request, ctx);
      if (request.method === 'ping') return { jsonrpc: '2.0', id: request.id, result: {} };
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: 'ok' }], _meta: { rows: 3 } },
      };
    },
  };
}

/**
 * `real: true` mounts core/mcp.mjs itself, which is what a launch does.
 * Everything else gets the stub, so the gate can be tested without the tools.
 */
async function startServer(t, options = {}) {
  const handle = db.open(':memory:');
  db.migrate(handle);
  const mcp = options.real ? null : (options.mcp ?? stubMcp());
  const server = createServer({
    db: handle,
    config: options.config ?? loadConfig(),
    mcp,
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
    mcp,
    port,
    token: server.sessionToken,
    base: `http://127.0.0.1:${port}`,
  };
}

/** A plain API call carrying the browser session token. */
async function api(ctx, method, route, { token = ctx.token, body, headers = {} } = {}) {
  const sent = { ...headers };
  if (token !== null) sent['X-Zelos-Token'] = token;
  if (body !== undefined) sent['Content-Type'] = 'application/json';
  const res = await fetch(`${ctx.base}${route}`, {
    method,
    headers: sent,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

/** A JSON-RPC call to /api/mcp carrying (or not carrying) an AI token. */
async function mcpCall(ctx, request, { bearer = null, headers = {}, method = 'POST', raw = null } = {}) {
  const sent = { 'Content-Type': 'application/json', ...headers };
  if (bearer !== null) sent.Authorization = `Bearer ${bearer}`;
  const bodyless = method === 'GET' || method === 'HEAD';
  const res = await fetch(`${ctx.base}/api/mcp`, {
    method,
    headers: sent,
    body: bodyless ? undefined : (raw !== null ? raw : (request === undefined ? undefined : JSON.stringify(request))),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 401s and 405s are plain JSON too, but be safe */ }
  return { status: res.status, headers: res.headers, text, json };
}

const RPC = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ================================================================== *
 * The module on its own
 * ================================================================== */

test('the ai block starts off, with mail.bodies off', async () => {
  await resetAi();
  const cfg = loadConfig();
  assert.equal(ai.aiEnabled(cfg), false, 'AI access must be off until a human turns it on');
  assert.equal(ai.AI_DEFAULTS.enabled, false);
  assert.equal(ai.AI_DEFAULTS.scopes['mail.bodies'], false);
  assert.equal(ai.AI_DEFAULTS.scopes['mail.metadata'], false);
  assert.deepEqual(ai.aiConfig(cfg).tokens, []);
});

test('a scope is on only when it is literally true', () => {
  const hand = {
    ai: {
      enabled: 'yes',
      scopes: { 'mail.bodies': 'true', board: 1, calendar: true, nonsense: true },
    },
  };
  const parsed = ai.aiConfig(hand);
  assert.equal(parsed.enabled, false, 'a truthy string is not consent');
  assert.equal(parsed.scopes['mail.bodies'], false);
  assert.equal(parsed.scopes.board, false);
  assert.equal(parsed.scopes.calendar, true);
  assert.equal('nonsense' in parsed.scopes, false, 'the scope set is closed');
  assert.deepEqual(Object.keys(parsed.scopes).sort(), [...ai.SCOPES].sort());
});

test('mail.bodies implies mail.metadata, and never the other way round', () => {
  const bodies = ai.effectiveScopes({ ai: { scopes: { 'mail.bodies': true } } });
  assert.equal(bodies['mail.bodies'], true);
  assert.equal(bodies['mail.metadata'], true, 'reading a body without its sender is a strange half-grant');

  const metadata = ai.effectiveScopes({ ai: { scopes: { 'mail.metadata': true } } });
  assert.equal(metadata['mail.metadata'], true);
  assert.equal(metadata['mail.bodies'], false, 'metadata must never turn bodies on');

  assert.deepEqual(ai.enabledScopes({ ai: { scopes: { 'mail.bodies': true } } }).sort(),
    ['mail.bodies', 'mail.metadata']);
});

test('the scope set is core/mcp.mjs\'s, not a second copy of it', async () => {
  // Two definitions of "what a scope is" would drift, and the one that drifted
  // would be the one a security decision was made against.
  const mcp = await import('../core/mcp.mjs');
  assert.equal(ai.SCOPES, mcp.SCOPES, 'the same frozen array, not an equal one');
  assert.equal(ai.SCOPE_INFO, mcp.SCOPE_INFO);
  assert.equal(ai.AI_DEFAULTS, mcp.AI_DEFAULTS);
  assert.equal(ai.listAccessLog, mcp.listAccessLog, 'one audit log, not two');

  assert.deepEqual(Object.keys(ai.SCOPE_INFO).sort(), [...ai.SCOPES].sort());
  const bodies = ai.SCOPE_INFO['mail.bodies'];
  assert.equal(bodies.sensitive, true, 'mail.bodies must be visibly marked');
  assert.deepEqual(bodies.implies, ['mail.metadata']);
  assert.equal(ai.SCOPES.filter((id) => ai.SCOPE_INFO[id].sensitive).length, 1);
});

test('a minted token verifies, and its value exists in exactly one place', async () => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Claude Desktop', config: cfg });

  assert.match(minted.value, /^zlt_t_[0-9a-f]{6}_[A-Za-z0-9_-]{22,}$/);
  assert.equal(minted.token.label, 'Claude Desktop');
  assert.equal(minted.token.lastUsedAt, null);
  assert.equal('value' in minted.token, false, 'the record must not carry the value');
  assert.equal('ref' in minted.token, false, 'a secret ref is not the panel\'s business');

  const verdict = await ai.verifyToken(minted.value, { config: minted.config });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.token.id, minted.token.id);

  // The only copy is in the secret store, under the ref config points at.
  const record = ai.aiConfig(minted.config).tokens.find((t) => t.id === minted.token.id);
  assert.equal(record.ref, `ai.${minted.token.id}`);
  assert.ok((await listRefs()).includes(record.ref));
  assert.equal(await getSecret(record.ref), minted.value);

  // ...and nowhere on disk in the clear.
  const raw = fs.readFileSync(paths().configFile, 'utf8');
  assert.equal(raw.includes(minted.value), false, 'config.json must never hold a token value');
  assert.ok(raw.includes(minted.token.id), 'but it does hold the id it is filed under');
});

test('listTokens shows labels and times, never values or refs', async () => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'A laptop', config: cfg });
  const listed = ai.listTokens(minted.config);
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['createdAt', 'id', 'label', 'lastUsedAt']);
  assert.equal(JSON.stringify(listed).includes(minted.value), false);
});

test('a revoked token stops verifying and its secret is gone', async () => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Doomed', config: cfg });
  const ref = `ai.${minted.token.id}`;
  assert.ok((await listRefs()).includes(ref));

  const revoked = await ai.revokeToken(minted.token.id, { config: minted.config });
  assert.equal(revoked.revoked, true);
  assert.deepEqual(ai.listTokens(revoked.config), []);
  assert.equal((await listRefs()).includes(ref), false, 'the value must not linger on disk');

  const verdict = await ai.verifyToken(minted.value, { config: revoked.config });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unknown-token');

  // Revoking something that is not there is not an error, and not a lie either.
  const again = await ai.revokeToken(minted.token.id, { config: revoked.config });
  assert.deepEqual([again.ok, again.revoked], [true, false]);
});

test('verification fails closed on every wrong shape', async () => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Real', config: cfg });
  const config = minted.config;

  for (const [presented, why] of [
    ['', 'empty'],
    ['   ', 'blank'],
    ['not-a-token', 'not ours'],
    [`zlt_${minted.token.id}_${'A'.repeat(43)}`, 'right id, wrong secret'],
    [`${minted.value}x`, 'a trailing character'],
    [minted.value.slice(0, -1), 'a truncated value'],
    [`zlt_t_ffffff_${'B'.repeat(43)}`, 'an id that never existed'],
    [null, 'nothing at all'],
    [undefined, 'undefined'],
  ]) {
    const verdict = await ai.verifyToken(presented, { config });
    assert.equal(verdict.ok, false, `${why} must not verify`);
    assert.equal(verdict.token, null);
  }

  // ...and the real one still does, so the loop above is not vacuous.
  assert.equal((await ai.verifyToken(minted.value, { config })).ok, true);
});

test('a token cannot be used while the master switch is off', async () => {
  await resetAi();
  const on = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Switched off', config: on });
  assert.equal((await ai.verifyToken(minted.value, { config: minted.config })).ok, true);

  const off = ai.setAiSettings({ enabled: false }, { config: minted.config });
  const verdict = await ai.verifyToken(minted.value, { config: off });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'ai-access-disabled');
});

test('setAiSettings refuses anything outside the closed set', async () => {
  await resetAi();
  const cfg = loadConfig();
  assert.throws(() => ai.setAiSettings({ scopes: { 'mail.everything': true } }, { config: cfg }), /unknown scope/);
  assert.throws(() => ai.setAiSettings({ scopes: { board: 'yes' } }, { config: cfg }), /true or false/);
  assert.throws(() => ai.setAiSettings({ scopes: [] }, { config: cfg }), /must be an object/);
  assert.throws(() => ai.setAiSettings({ enabled: 'yes' }, { config: cfg }), /true or false/);
  // Nothing above may have been written.
  assert.equal(ai.aiConfig(loadConfig()).scopes.board, ai.AI_DEFAULTS.scopes.board);
});

test('turning other scopes on never turns mail.bodies on', async () => {
  await resetAi();
  let cfg = loadConfig();
  for (const key of ai.SCOPES.filter((k) => k !== 'mail.bodies')) {
    cfg = ai.setAiSettings({ scopes: { [key]: true } }, { config: cfg });
    assert.equal(ai.aiConfig(cfg).scopes['mail.bodies'], false, `${key} must not drag bodies along`);
  }
  cfg = ai.setAiSettings({ enabled: true }, { config: cfg });
  assert.equal(ai.aiConfig(cfg).scopes['mail.bodies'], false);
});

test('mint rejects a token with no label', async () => {
  await resetAi();
  await assert.rejects(() => ai.mintToken({ label: '', config: loadConfig() }), /needs a label/);
  await assert.rejects(() => ai.mintToken({ label: '   ', config: loadConfig() }), /needs a label/);
  assert.deepEqual(ai.listTokens(loadConfig()), []);
});

test('lastUsedAt moves only for a token that exists', async () => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Used', config: cfg });
  assert.equal(ai.listTokens(minted.config)[0].lastUsedAt, null);

  const touched = ai.touchToken(minted.token.id, { config: minted.config, now: '2026-08-09T10:00:00-04:00' });
  assert.equal(ai.listTokens(touched)[0].lastUsedAt, '2026-08-09T10:00:00-04:00');

  const untouched = ai.touchToken('t_000000', { config: touched });
  assert.equal(ai.listTokens(untouched)[0].lastUsedAt, '2026-08-09T10:00:00-04:00');
});

/* ================================================================== *
 * The HTTP surface
 * ================================================================== */

test('a valid AI token reaches /api/mcp', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Claude Desktop', config: cfg });
  const ctx = await startServer(t, { config: minted.config });

  const res = await mcpCall(ctx, RPC, { bearer: minted.value });
  assert.equal(res.status, 200);
  assert.equal(res.json.jsonrpc, '2.0');
  assert.equal(res.json.id, 1);
  assert.deepEqual(res.json.result.content, [{ type: 'text', text: 'ok' }]);

  // The tool layer was handed the db, the token's identity, and the config as a
  // FUNCTION — so a scope switched off in Settings bites on the next call
  // rather than on the next restart.
  assert.equal(ctx.mcp.calls.length, 1);
  const passed = ctx.mcp.calls[0].ctx;
  assert.equal(passed.db, ctx.db);
  assert.equal(passed.transport, 'http');
  assert.equal(passed.tokenId, minted.token.id);
  assert.equal(passed.client, 'Claude Desktop');
  assert.equal(typeof passed.config, 'function');
  assert.equal(ai.aiEnabled(passed.config()), true);
  assert.equal(JSON.stringify(passed).includes(minted.value), false, 'no token value reaches the tool layer');
});

test('a revoked AI token is refused', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Doomed', config: cfg });
  const ctx = await startServer(t, { config: minted.config });

  assert.equal((await mcpCall(ctx, RPC, { bearer: minted.value })).status, 200);

  const gone = await api(ctx, 'DELETE', `/api/ai/tokens/${minted.token.id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.json.revoked, true);
  assert.deepEqual(gone.json.tokens, []);

  const after = await mcpCall(ctx, RPC, { bearer: minted.value });
  assert.equal(after.status, 401);
  assert.equal(after.headers.get('www-authenticate'), 'Bearer realm="zelos"');
  assert.equal(ctx.mcp.calls.length, 1, 'a revoked token must not reach the tool layer');
});

test('revoking a token while its request body is pending prevents tool dispatch', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Pending body', config: cfg });
  const ctx = await startServer(t, { config: minted.config });
  const body = JSON.stringify(RPC);
  // readBody installs its data listener only after authenticating headers.
  // Observe that boundary rather than guessing how long the key store takes.
  const readingBody = new Promise((resolve) => {
    ctx.server.prependOnceListener('request', (req) => {
      const observe = (name) => {
        if (name !== 'data') return;
        req.off('newListener', observe);
        resolve();
      };
      req.on('newListener', observe);
    });
  });
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(`${ctx.base}/api/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.value}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.flushHeaders();
  });
  await readingBody;
  const gone = await api(ctx, 'DELETE', `/api/ai/tokens/${minted.token.id}`);
  assert.equal(gone.json.revoked, true);
  req.end(body);
  assert.equal(await response, 401);
  assert.equal(ctx.mcp.calls.length, 0, 'a formerly valid request must not execute after revocation');
});

test('the session token does NOT authorise /api/mcp', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Real client', config: cfg });
  const ctx = await startServer(t, { config: minted.config });

  // As a bearer...
  assert.equal((await mcpCall(ctx, RPC, { bearer: ctx.token })).status, 401);
  // ...in the header it belongs in on every other route...
  assert.equal((await mcpCall(ctx, RPC, { headers: { 'X-Zelos-Token': ctx.token } })).status, 401);
  // ...and both together, in case one is read as a fallback for the other.
  assert.equal(
    (await mcpCall(ctx, RPC, { bearer: ctx.token, headers: { 'X-Zelos-Token': ctx.token } })).status,
    401,
  );
  assert.equal(ctx.mcp.calls.length, 0);

  // The AI token, which is the credential this route actually takes, works.
  assert.equal((await mcpCall(ctx, RPC, { bearer: minted.value })).status, 200);
});

test('an AI token does NOT authorise any other /api route', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Nosy client', config: cfg });
  const ctx = await startServer(t, { config: minted.config });

  const routes = [
    ['GET', '/api/health'],
    ['GET', '/api/state'],
    ['GET', '/api/config'],
    ['GET', '/api/ai'],
    ['GET', '/api/search?q=x'],
    ['POST', '/api/capture'],
    ['POST', '/api/sweep'],
    ['POST', '/api/ai/tokens'],
    ['DELETE', `/api/ai/tokens/${minted.token.id}`],
  ];

  for (const [method, route] of routes) {
    // In the session header...
    const asSession = await api(ctx, method, route, { token: minted.value });
    assert.equal(asSession.status, 401, `${method} ${route} must refuse an AI token`);
    // ...and as a bearer, with no session token at all.
    const asBearer = await api(ctx, method, route, {
      token: null,
      headers: { Authorization: `Bearer ${minted.value}` },
    });
    assert.equal(asBearer.status, 401, `${method} ${route} must refuse a bearer AI token`);
  }

  // The token is still good for the one route it is for — so the loop above
  // proved a boundary, not a broken token.
  assert.equal((await mcpCall(ctx, RPC, { bearer: minted.value })).status, 200);
});

test('disabled means 403 on /api/mcp, whatever token is presented', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Valid but switched off', config: cfg });
  const off = ai.setAiSettings({ enabled: false }, { config: minted.config });
  const ctx = await startServer(t, { config: off });

  for (const options of [
    { bearer: minted.value },
    { bearer: 'nonsense' },
    { bearer: ctx.token },
    {},
  ]) {
    const res = await mcpCall(ctx, RPC, options);
    assert.equal(res.status, 403, 'off means off');
    assert.match(res.json.error, /AI access is off/);
    // It sends the person to the tab that exists (TT-3431).
    assert.match(res.json.detail, /Settings → Share with another AI \(advanced\)/);
  }
  assert.equal(ctx.mcp.calls.length, 0, 'nothing may reach the tool layer while the switch is off');

  // Turning it back on through the panel makes the same token work again.
  const on = await api(ctx, 'PUT', '/api/ai', { body: { enabled: true } });
  assert.equal(on.status, 200);
  assert.equal(on.json.enabled, true);
  assert.equal((await mcpCall(ctx, RPC, { bearer: minted.value })).status, 200);
});

test('/api/mcp keeps every other local-security property', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Client', config: cfg });
  const ctx = await startServer(t, { config: minted.config });

  // A page on another origin is refused before the token is even looked at.
  const foreign = await mcpCall(ctx, RPC, {
    bearer: minted.value,
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(foreign.status, 403);
  assert.match(foreign.text, /Cross-origin/);

  // No CORS headers, so a page could not read the answer even if it got one.
  const ok = await mcpCall(ctx, RPC, { bearer: minted.value });
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');

  // JSON-RPC is a POST.
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await mcpCall(ctx, RPC, { bearer: minted.value, method });
    assert.equal(res.status, 405, `${method} /api/mcp`);
  }
});

test('/api/mcp answers a bad envelope in JSON-RPC, and never echoes an internal error', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Client', config: cfg });

  const boom = 'SECRET-DETAIL-FROM-INSIDE-9f3a1c';
  const mcp = stubMcp((request) => {
    if (request.method === 'explode') throw new Error(boom);
    if (request.id === undefined) return null; // a notification
    return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
  });
  const ctx = await startServer(t, { config: minted.config, mcp });

  // A body that is not JSON never reaches the protocol at all.
  const parse = await mcpCall(ctx, undefined, { bearer: minted.value, raw: '{not json' });
  assert.equal(parse.status, 400);
  assert.equal(parse.json.error.code, -32700);

  const thrown = await mcpCall(ctx, { jsonrpc: '2.0', id: 9, method: 'explode' }, { bearer: minted.value });
  assert.equal(thrown.status, 500);
  assert.equal(thrown.json.error.code, -32603);
  assert.equal(thrown.text.includes(boom), false, 'an internal message must not reach the caller');

  // A JSON-RPC error from the tool layer is a normal answer, not an HTTP error.
  const notFound = await mcpCall(ctx, { jsonrpc: '2.0', id: 3, method: 'nope' }, { bearer: minted.value });
  assert.equal(notFound.status, 200);
  assert.equal(notFound.json.error.code, -32601);

  // A notification gets no body.
  const note = await mcpCall(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' }, { bearer: minted.value });
  assert.equal(note.status, 202);
  assert.equal(note.text.trim(), '');
});

/* ------------------------------------------------------- the settings panel */

test('GET /api/ai reports the switch, the scopes, the tokens and the log', async (t) => {
  await resetAi();
  const ctx = await startServer(t);

  const res = await api(ctx, 'GET', '/api/ai');
  assert.equal(res.status, 200);
  assert.equal(res.json.enabled, false);
  assert.deepEqual(Object.keys(res.json.scopes).sort(), [...ai.SCOPES].sort());
  assert.equal(res.json.scopes['mail.bodies'], false);
  assert.deepEqual(res.json.tokens, []);
  assert.deepEqual(res.json.access, []);
  assert.equal(res.json.scopeInfo.length, ai.SCOPES.length);
  // The panel has to print a config block a person can paste, so it needs the
  // real paths and the real port.
  assert.equal(res.json.client.command, process.execPath);
  assert.ok(res.json.client.args[0].endsWith('zelos.mjs'));
  assert.equal(res.json.client.args[1], 'mcp');
  assert.equal(res.json.client.httpUrl, `http://127.0.0.1:${ctx.port}/api/mcp`);

  // Every one of these needs the session token.
  assert.equal((await api(ctx, 'GET', '/api/ai', { token: null })).status, 401);
  assert.equal((await api(ctx, 'PUT', '/api/ai', { token: null, body: { enabled: true } })).status, 401);
  assert.equal((await api(ctx, 'POST', '/api/ai/tokens', { token: null, body: { label: 'x' } })).status, 401);
  assert.equal((await api(ctx, 'DELETE', '/api/ai/tokens/t_aaaaaa', { token: null })).status, 401);
});

test('inside the desktop shell, the paste block runs the app itself as Node on the shipped entry', async (t) => {
  await resetAi();
  const ctx = await startServer(t);

  /* `Zelos mcp` started as an Electron app put a bare \r\n on stdout before
     any of Zelos's code ran (QA, 2026-10-10, TT-3507), so the block runs the
     app's binary with ELECTRON_RUN_AS_NODE=1 on core/mcp-stdio.mjs, which the
     build copies beside the app. A dev shell gets the same shape, so a
     checkout on Windows is clean too. Plain Node keeps `zelos.mjs mcp`. */
  process.versions.electron = '43.3.0';
  t.after(() => { delete process.versions.electron; });

  const res = await api(ctx, 'GET', '/api/ai');
  assert.equal(res.json.client.command, process.execPath);
  assert.deepEqual(res.json.client.args, [path.join(ROOT, 'core', 'mcp-stdio.mjs')]);
  assert.ok(fs.existsSync(res.json.client.args[0]), 'the block names an entry this copy does not have');
  assert.deepEqual(res.json.client.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(res.json.client.moveFirst, false);

  process.defaultApp = true;
  t.after(() => { delete process.defaultApp; });
  const dev = await api(ctx, 'GET', '/api/ai');
  assert.deepEqual(dev.json.client.args, res.json.client.args, 'a dev shell gets the same block');
  assert.deepEqual(dev.json.client.env, { ELECTRON_RUN_AS_NODE: '1' });
});

test('a Mac app run from a translocated copy or the disk image is told to move first', async () => {
  // Its path stops existing when it quits, and so would the command pasted
  // into a client's config (QA, 2026-10-10, TT-3507).
  const { stdioLaunch } = await import('../core/mcp-stdio.mjs');
  const asked = [];
  const readOnly = (dir) => { asked.push(dir); return false; };
  const launch = (execPath, canWrite = readOnly) => stdioLaunch({ electron: true, execPath, root: '/r', canWrite });
  assert.equal(launch('/private/var/folders/x/T/AppTranslocation/0A1B/d/Zelos.app/Contents/MacOS/Zelos').moveFirst, true);
  assert.equal(launch('/Volumes/Zelos 1.9.5/Zelos.app/Contents/MacOS/Zelos').moveFirst, true, 'the disk image');
  assert.deepEqual(asked.at(-1), '/Volumes/Zelos 1.9.5', 'it asks about the folder holding the app');
  // An app installed on a writable external drive lives there; nothing to move.
  assert.equal(launch('/Volumes/Work/Applications/Zelos.app/Contents/MacOS/Zelos', () => true).moveFirst, false);
  assert.equal(launch('/Applications/Zelos.app/Contents/MacOS/Zelos').moveFirst, false);
  assert.equal(stdioLaunch({ electron: false, execPath: '/Volumes/x/node', root: '/r', canWrite: readOnly }).moveFirst, false, 'the CLI is not an app to move');
});

test('PUT /api/ai writes only what it is given, and refuses a scope that does not exist', async (t) => {
  await resetAi();
  const ctx = await startServer(t);

  const on = await api(ctx, 'PUT', '/api/ai', { body: { enabled: true, scopes: { calendar: true } } });
  assert.equal(on.status, 200);
  assert.equal(on.json.enabled, true);
  assert.equal(on.json.scopes.calendar, true);
  assert.equal(on.json.scopes['mail.bodies'], false);
  assert.equal(ai.aiConfig(loadConfig()).enabled, true, 'it must reach disk');

  // The effective set is reported alongside the stored one, so the panel can
  // show that bodies grants metadata without pretending the user ticked it.
  const bodies = await api(ctx, 'PUT', '/api/ai', { body: { scopes: { 'mail.bodies': true } } });
  assert.equal(bodies.json.scopes['mail.metadata'], false, 'the stored toggle is untouched');
  assert.equal(bodies.json.effectiveScopes['mail.metadata'], true);

  const bad = await api(ctx, 'PUT', '/api/ai', { body: { scopes: { 'mail.everything': true } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unknown scope/);

  assert.equal((await api(ctx, 'PUT', '/api/ai', { body: {} })).status, 400);
  assert.equal((await api(ctx, 'PUT', '/api/ai', { body: { enabled: 'yes' } })).status, 400);
});

test('a token value is returned once, at creation, and never again', async (t) => {
  await resetAi();
  const ctx = await startServer(t);

  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Claude Desktop' } });
  assert.equal(made.status, 201);
  const value = made.json.value;
  assert.match(value, /^zlt_t_[0-9a-f]{6}_/);
  assert.equal(made.json.token.label, 'Claude Desktop');
  assert.equal(made.json.tokens.length, 1);
  assert.equal(JSON.stringify(made.json.tokens).includes(value), false);

  // Every later read, on every route that could plausibly carry it.
  for (const route of ['/api/ai', '/api/config', '/api/state', '/api/health']) {
    const res = await api(ctx, 'GET', route);
    assert.equal(res.text.includes(value), false, `${route} must not hand the value back`);
  }
  const again = await api(ctx, 'GET', '/api/ai');
  assert.equal(again.json.tokens.length, 1);
  assert.equal('value' in again.json.tokens[0], false);

  // Not on disk in the clear either.
  assert.equal(fs.readFileSync(paths().configFile, 'utf8').includes(value), false);

  assert.equal((await api(ctx, 'POST', '/api/ai/tokens', { body: {} })).status, 400);
  assert.equal((await api(ctx, 'POST', '/api/ai/tokens', { body: { label: '' } })).status, 400);
});

test('a real call updates lastUsedAt and lands in the access log', async (t) => {
  await resetAi();
  // No stub: this one runs against the real core/mcp.mjs, so the contract
  // between the two modules is tested rather than assumed.
  const ctx = await startServer(t, { real: true });

  await api(ctx, 'PUT', '/api/ai', { body: { enabled: true, scopes: { calendar: true } } });
  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Claude Desktop' } });
  const value = made.json.value;
  const id = made.json.token.id;
  assert.equal(made.json.tokens[0].lastUsedAt, null);

  // The handshake, then a real tool call.
  const init = await mcpCall(ctx, {
    jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' },
  }, { bearer: value });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'zelos');

  const call = await mcpCall(ctx, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zelos_calendar', arguments: {} },
  }, { bearer: value });
  assert.equal(call.status, 200);
  assert.ok(call.json.result.content, 'the tool answered');

  const after = await api(ctx, 'GET', '/api/ai');
  assert.equal(after.json.tokens[0].id, id);
  assert.ok(after.json.tokens[0].lastUsedAt, 'a successful call sets lastUsedAt');

  assert.equal(after.json.access.length, 1, 'one call, one row');
  const [row] = after.json.access;
  assert.equal(row.tool, 'zelos_calendar');
  assert.equal(row.scope, 'calendar', 'the log says which scope was spent');
  assert.equal(typeof row.rows, 'number', 'and how many rows came back');
  assert.equal(row.tokenId, id);
  assert.equal(row.client, 'Claude Desktop');
  assert.equal(row.transport, 'http', 'and which door it came in through');
  assert.equal(row.ok, true);
  assert.equal(JSON.stringify(after.json.access).includes(value), false);

  // A scope that is off is refused — and the refusal is logged too, because
  // "what did my AI try to read?" is part of the same question. `zelos_people`
  // and not `zelos_search`: search is reachable from any scope that owns a
  // searchable kind, and the calendar is one, so it would not be refused here.
  const denied = await mcpCall(ctx, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'zelos_people', arguments: {} },
  }, { bearer: value });
  assert.equal(denied.status, 200);
  assert.ok(denied.json.error, 'people is off, so this must not answer');
  const withDenial = await api(ctx, 'GET', '/api/ai');
  assert.equal(withDenial.json.access.length, 2);
  assert.equal(withDenial.json.access[0].ok, false);
  assert.equal(withDenial.json.access[0].scope, 'people');

  // A ping is a keep-alive, not a read.
  await mcpCall(ctx, { jsonrpc: '2.0', id: 3, method: 'ping' }, { bearer: value });
  const pinged = await api(ctx, 'GET', '/api/ai');
  assert.equal(pinged.json.access.length, 2, 'ping is not an access event');

  // A call refused at the gate never reaches the tool layer, so it leaves no
  // row — and must not mark the token as recently used either.
  await mcpCall(ctx, RPC, { bearer: 'zlt_t_ffffff_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  const refused = await api(ctx, 'GET', '/api/ai');
  assert.equal(refused.json.access.length, 2);
  assert.equal(refused.json.tokens[0].lastUsedAt, after.json.tokens[0].lastUsedAt);
});

test('token stamps are written in the configured zone, not the machine\'s', async (t) => {
  await resetAi();
  /* The rule recordAskSpend spells out in core/server.mjs: `nowISO()` with no
     argument reads the MACHINE zone, and for the hours when that zone and the
     configured one sit on different dates, the panel files the stamp under the
     wrong day. Kiritimati (+14:00) is a zone no machine running this suite
     sits in, so the assertion cannot pass by the two zones agreeing. */
  const was = loadConfig().identity?.timezone ?? null;
  saveConfig({ identity: { timezone: 'Pacific/Kiritimati' } });
  t.after(() => { saveConfig({ identity: { timezone: was } }); });

  const ctx = await startServer(t);
  await api(ctx, 'PUT', '/api/ai', { body: { enabled: true } });
  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'zoned' } });
  assert.match(made.json.token.createdAt, /\+14:00$/, 'createdAt was stamped off the machine clock');

  // The first authenticated call stamps lastUsedAt — in the same zone.
  await mcpCall(ctx, RPC, { bearer: made.json.value });
  const token = ai.aiConfig(loadConfig()).tokens.find((tk) => tk.id === made.json.token.id);
  assert.match(token.lastUsedAt, /\+14:00$/, 'lastUsedAt was stamped off the machine clock');
});

test('a burst of calls stamps lastUsedAt once a minute, not once a second', async (t) => {
  await resetAi();
  const ctx = await startServer(t, { real: true });
  await api(ctx, 'PUT', '/api/ai', { body: { enabled: true, scopes: { calendar: true } } });
  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Chatty client' } });
  const value = made.json.value;

  // Every successful call used to rewrite config.json — an atomic write with
  // two fsyncs — to move a second-resolution timestamp. The old code skipped a
  // rewrite only when the stamp it was about to write was the one already
  // there, so a burst spread over three seconds bought three rewrites; a client
  // polling all day bought one a second, forever.
  //
  // config.json's mtime is the measurement, because it is the I/O itself rather
  // than a proxy for it: one distinct mtime is one rewrite.
  const writes = new Set();
  const started = Date.now();
  for (let i = 0; i < 8; i += 1) {
    const res = await mcpCall(ctx, RPC, { bearer: value });
    assert.equal(res.status, 200, 'every call in the burst must still be answered');
    writes.add(fs.statSync(paths().configFile).mtimeMs);
    await delay(400);
  }
  assert.ok(Date.now() - started > 2_000, 'the burst has to span more than a second to prove anything');
  assert.equal(writes.size, 1, `the burst rewrote config.json ${writes.size} times`);

  // Throttled, not dropped: the first call still stamps, so a token that has
  // just started working says so on the panel straight away.
  const after = await api(ctx, 'GET', '/api/ai');
  assert.ok(after.json.tokens[0].lastUsedAt, 'the first call in a burst still records that it worked');
});

test('the access log names the token the way its owner named it', async (t) => {
  await resetAi();
  const ctx = await startServer(t, { real: true });
  await api(ctx, 'PUT', '/api/ai', { body: { enabled: true, scopes: { calendar: true } } });
  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Claude on the laptop' } });
  const id = made.json.token.id;

  const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zelos_calendar', arguments: {} } };
  assert.equal((await mcpCall(ctx, CALL, { bearer: made.json.value })).status, 200);

  const [row] = (await api(ctx, 'GET', '/api/ai')).json.access;
  assert.equal(row.tokenId, id, 'the id is still there — it is what identifies a token for ever');
  assert.equal(row.label, 'Claude on the laptop', 'and the panel gets the name the user chose');
  assert.equal(row.tokenRevoked, false);

  // A row outlives its token, and says so rather than going quietly anonymous:
  // "a client you have since cut off read this" is the interesting case.
  await api(ctx, 'DELETE', `/api/ai/tokens/${id}`);
  const [orphan] = (await api(ctx, 'GET', '/api/ai')).json.access;
  assert.equal(orphan.tokenId, id);
  assert.equal(orphan.label, null);
  assert.equal(orphan.tokenRevoked, true);
});

test('the access log comes back in windows, and asking for more is bounded', async (t) => {
  await resetAi();
  const ctx = await startServer(t, { real: true });
  await api(ctx, 'PUT', '/api/ai', { body: { enabled: true, scopes: { calendar: true } } });
  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Busy' } });

  const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zelos_calendar', arguments: {} } };
  for (let i = 0; i < 60; i += 1) await mcpCall(ctx, CALL, { bearer: made.json.value });

  const first = await api(ctx, 'GET', '/api/ai');
  assert.equal(first.json.access.length, 50, 'the default window is fifty rows, not sixty and not six thousand');
  assert.equal(first.json.accessMore, true, 'and the panel is told there are older ones behind it');

  const wider = await api(ctx, 'GET', '/api/ai?log=200');
  assert.equal(wider.json.access.length, 60);
  assert.equal(wider.json.accessMore, false, 'sixty rows in a window of two hundred is the whole log');

  // The window is the panel's to choose and the server's to bound.
  const absurd = await api(ctx, 'GET', '/api/ai?log=999999');
  assert.equal(absurd.json.accessLimit, absurd.json.accessMax);
  assert.equal((await api(ctx, 'GET', '/api/ai?log=0')).json.accessLimit, 1);
  assert.equal((await api(ctx, 'GET', '/api/ai?log=nonsense')).json.accessLimit, 50);
});

/* ================================================================== *
 * POST /api/ai/test — what the client would see
 * ================================================================== */

test('the connection test shows exactly what a client would be handed', async (t) => {
  await resetAi();
  const ctx = await startServer(t, { real: true });
  await api(ctx, 'PUT', '/api/ai', { body: { enabled: true, scopes: { calendar: true, board: true } } });
  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Claude Desktop' } });
  const value = made.json.value;

  const res = await api(ctx, 'POST', '/api/ai/test', { body: { token: value } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.token.label, 'Claude Desktop');
  assert.equal(res.json.serverInfo.name, 'zelos');
  assert.equal(res.json.protocolVersion, '2025-06-18');
  assert.match(res.json.instructions, /read-only/i);

  // It is a test, not a use: it reads nothing, so it logs nothing and it does
  // not make a token that nobody is using look alive. Asserted before the
  // comparison below, which is a genuine client call and does stamp it.
  const state = await api(ctx, 'GET', '/api/ai');
  assert.deepEqual(state.json.access, [], 'a handshake reads no data, so it leaves no access row');
  assert.equal(state.json.tokens[0].lastUsedAt, null, 'testing a token is not the client using it');

  // The same list, from the same tool layer, as the client itself gets.
  const listed = await mcpCall(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { bearer: value });
  assert.deepEqual(
    res.json.tools.map((tool) => tool.name).sort(),
    listed.json.result.tools.map((tool) => tool.name).sort(),
    'the test must show the real tool list, not a description of it',
  );

  // And it never hands the pasted value back.
  assert.equal(res.text.includes(value), false);
});

test('the connection test says which half of the setup is wrong', async (t) => {
  await resetAi();
  const ctx = await startServer(t, { real: true });
  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Not yet allowed' } });

  // The switch is off, which is what a client would hit first.
  const shut = await api(ctx, 'POST', '/api/ai/test', { body: { token: made.json.value } });
  assert.equal(shut.json.ok, false);
  assert.equal(shut.json.stage, 'switch');
  assert.match(shut.json.detail, /403/);

  // On, with every scope closed — the state where a client connects fine and
  // can read nothing at all.
  await api(ctx, 'PUT', '/api/ai', {
    body: { enabled: true, scopes: { board: false, calendar: false } },
  });

  const junk = await api(ctx, 'POST', '/api/ai/test', { body: { token: 'not-a-token-at-all' } });
  assert.equal(junk.json.ok, false);
  assert.equal(junk.json.stage, 'token');
  assert.match(junk.json.detail, /zlt_/);

  const wrong = await api(ctx, 'POST', '/api/ai/test', {
    body: { token: 'zlt_t_ffffff_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  });
  assert.equal(wrong.json.ok, false);
  assert.equal(wrong.json.stage, 'token');
  assert.match(wrong.json.detail, /401/);

  // A good token with nothing ticked: the handshake works and the client is
  // handed an empty tool list, which is a state worth being able to see.
  const empty = await api(ctx, 'POST', '/api/ai/test', { body: { token: made.json.value } });
  assert.equal(empty.json.ok, true);
  assert.deepEqual(empty.json.tools, []);
  assert.match(empty.json.detail, /no scope is ticked/);

  assert.equal((await api(ctx, 'POST', '/api/ai/test', { body: {} })).status, 400);
});

test('the connection test takes the session token and refuses an AI one', async (t) => {
  await resetAi();
  const ctx = await startServer(t, { real: true });
  await api(ctx, 'PUT', '/api/ai', { body: { enabled: true, scopes: { board: true } } });
  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Curious client' } });

  // Presenting the AI token as the session credential — a client trying to use
  // its own token to walk further into the API than /api/mcp.
  const asSession = await api(ctx, 'POST', '/api/ai/test', {
    token: made.json.value,
    body: { token: made.json.value },
  });
  assert.equal(asSession.status, 401, 'an AI token authorises nothing outside /api/mcp');

  const asBearer = await fetch(`${ctx.base}/api/ai/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${made.json.value}` },
    body: JSON.stringify({ token: made.json.value }),
  });
  assert.equal(asBearer.status, 401, 'and a bearer header is not the session token either');
});

test('the real MCP module is what /api/mcp mounts by default', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true, scopes: { board: true } }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Default wiring', config: cfg });
  // `mcp: null` means "use the module", which is what a real launch does.
  const ctx = await startServer(t, { config: minted.config, real: true });

  const listed = await mcpCall(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { bearer: minted.value });
  assert.equal(listed.status, 200);
  const names = listed.json.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('zelos_board'), 'an enabled scope brings its tools');
  assert.equal(names.some((n) => /send|delete|write|update|config/i.test(n)), false,
    'nothing that writes may ever appear here');

  // A batch is the protocol's business, not this route's: it goes through.
  const batch = await mcpCall(ctx, [
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ], { bearer: minted.value });
  assert.equal(batch.status, 200);
  assert.equal(batch.json.length, 2);
});

test('a token minted through the panel works against /api/mcp end to end', async (t) => {
  await resetAi();
  const ctx = await startServer(t);

  // Off by default: the token exists but the switch has not been thrown.
  const made = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Some client' } });
  assert.equal((await mcpCall(ctx, RPC, { bearer: made.json.value })).status, 403);

  await api(ctx, 'PUT', '/api/ai', { body: { enabled: true } });
  const ok = await mcpCall(ctx, RPC, { bearer: made.json.value });
  assert.equal(ok.status, 200);

  // Two tokens, and revoking one leaves the other alone.
  const second = await api(ctx, 'POST', '/api/ai/tokens', { body: { label: 'Another client' } });
  assert.equal(second.json.tokens.length, 2);
  await api(ctx, 'DELETE', `/api/ai/tokens/${made.json.token.id}`);
  assert.equal((await mcpCall(ctx, RPC, { bearer: made.json.value })).status, 401);
  assert.equal((await mcpCall(ctx, RPC, { bearer: second.json.value })).status, 200);

  // Deleting something that is not there is honest about it rather than a 404
  // that would tell a caller which ids exist.
  const nothing = await api(ctx, 'DELETE', '/api/ai/tokens/t_000000');
  assert.equal(nothing.status, 200);
  assert.equal(nothing.json.revoked, false);
});

test('an oversized JSON-RPC body is refused before it is parsed', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true }, { config: loadConfig() });
  const minted = await ai.mintToken({ label: 'Chatty', config: cfg });
  const ctx = await startServer(t, { config: minted.config });

  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { pad: 'x'.repeat(400_000) } });
  let status = 0;
  try {
    ({ status } = await mcpCall(ctx, undefined, { bearer: minted.value, raw: huge }));
  } catch {
    // A client that is hung up on mid-upload is an acceptable outcome too; what
    // is not acceptable is the body being buffered and handled.
    status = 413;
  }
  assert.ok(status === 413 || status === 400, `expected a refusal, got ${status}`);
  assert.equal(ctx.mcp.calls.length, 0, 'nothing oversized may reach the tool layer');
});

test('the whole feature leaves no trace when nobody turns it on', async (t) => {
  await resetAi();
  const ctx = await startServer(t);
  const res = await api(ctx, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(ai.aiEnabled(loadConfig()), false);
  assert.deepEqual((await api(ctx, 'GET', '/api/ai')).json.tokens, []);
  assert.equal((await listRefs()).some((r) => r.startsWith('ai.')), false);
});

/* ================================================================== *
 * What a token check remembers (TT-3497)
 *
 * Reading a stored token is a spawn on every OS store — PowerShell on Windows,
 * about 180 ms — and it used to happen on every MCP request. The check now
 * remembers a digest of the stored value. These pin both halves: the store is
 * read once, and nothing that should stop a token is slowed down by that.
 * ================================================================== */

/** The real store, with its reads counted. */
function countingStore(read = getSecret) {
  const reads = [];
  return { reads, store: { getSecret: async (ref) => { reads.push(ref); return read(ref); }, secretVersion } };
}

async function warmToken(label) {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true });
  const minted = await ai.mintToken({ label, config: cfg });
  const counted = countingStore();
  assert.equal((await ai.verifyToken(minted.value, { config: minted.config, store: counted.store })).ok, true);
  return { minted, ...counted };
}

test('a token checked twice is read from the store once', async () => {
  const { minted, reads, store } = await warmToken('Twice');
  assert.equal((await ai.verifyToken(minted.value, { config: minted.config, store })).ok, true);
  assert.deepEqual(reads, [`ai.${minted.token.id}`]);
});

test('a wrong secret at a real id is refused without another store read', async () => {
  const { minted, reads, store } = await warmToken('Guessed at');
  const guess = `zlt_${minted.token.id}_${'A'.repeat(43)}`;
  for (let i = 0; i < 3; i++) {
    const verdict = await ai.verifyToken(guess, { config: minted.config, store });
    assert.deepEqual([verdict.ok, verdict.reason], [false, 'mismatch']);
  }
  assert.equal(reads.length, 1, 'a stream of guesses must not become a stream of spawns');
});

test('a revoked token is refused at once, even by a caller holding the old config', async () => {
  const { minted, store } = await warmToken('Revoked warm');
  // The store refuses the delete, which revokeToken tolerates and only warns
  // about: the value is still there, so the record on disk is all that stands
  // in the way, and the caller's snapshot still lists it.
  await ai.revokeToken(minted.token.id, {
    config: minted.config, store: { deleteSecret: async () => { throw new Error('keychain locked'); } },
  });
  const verdict = await ai.verifyToken(minted.value, { config: minted.config, store });
  assert.deepEqual([verdict.ok, verdict.reason], [false, 'unknown-token']);
  // And with nothing remembered, so the refusal does not depend on the cache.
  ai.resetVerifiedTokens?.();
  const cold = await ai.verifyToken(minted.value, { config: minted.config });
  assert.deepEqual([cold.ok, cold.reason], [false, 'unknown-token']);
  await deleteSecret(`ai.${minted.token.id}`);
});

test('a token record removed on disk is refused, whatever config the caller holds', async () => {
  const { minted, store } = await warmToken('Removed elsewhere');
  const live = ai.aiConfig(loadConfig());
  saveConfig({ ai: { ...live, tokens: [] } });
  assert.equal((await ai.verifyToken(minted.value, { config: minted.config, store })).ok, false);
  await deleteSecret(`ai.${minted.token.id}`);
});

test('the master switch turned off on disk is obeyed, whatever config the caller holds', async () => {
  const { minted, store } = await warmToken('Switched off elsewhere');
  // Written straight to config.json, as another process would, so nothing in
  // this one is told.
  saveConfig({ ai: { ...ai.aiConfig(loadConfig()), enabled: false } });
  const verdict = await ai.verifyToken(minted.value, { config: minted.config, store });
  assert.deepEqual([verdict.ok, verdict.reason], [false, 'ai-access-disabled']);
});

test('a remembered check expires after a minute and the store is read again', async () => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true });
  const minted = await ai.mintToken({ label: 'Expiring', config: cfg });
  const { reads, store } = countingStore();
  const start = 1_000_000;
  for (const now of [start, start + 59_000]) {
    assert.equal((await ai.verifyToken(minted.value, { config: minted.config, store, now })).ok, true);
  }
  assert.equal(reads.length, 1);
  assert.equal((await ai.verifyToken(minted.value, { config: minted.config, store, now: start + 60_000 })).ok, true);
  assert.equal(reads.length, 2);
});

test('replacing or deleting a token\'s stored value stops the old value at once', async () => {
  const { minted, reads, store } = await warmToken('Rewritten');
  const ref = `ai.${minted.token.id}`;
  await setSecret(ref, `zlt_${minted.token.id}_${'C'.repeat(43)}`);
  assert.equal((await ai.verifyToken(minted.value, { config: minted.config, store })).ok, false);
  assert.equal(reads.length, 2, 'a save in this process makes the remembered digest stale');
  await deleteSecret(ref);
  const verdict = await ai.verifyToken(`zlt_${minted.token.id}_${'C'.repeat(43)}`, { config: minted.config, store });
  assert.deepEqual([verdict.ok, verdict.reason], [false, 'no-stored-value']);
});

test('on DPAPI, a blob changed by another process stops the remembered check', async (t) => {
  await resetAi();
  const cfg = ai.setAiSettings({ enabled: true });
  const minted = await ai.mintToken({ label: 'DPAPI blob', config: cfg });
  const ref = `ai.${minted.token.id}`;
  // DPAPI is forced only for the version check; the read itself is a stub,
  // because a real one would start PowerShell. The blob stands in for one
  // another Zelos process just rewrote.
  const priorLocal = process.env.LOCALAPPDATA;
  t.after(async () => {
    if (priorLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = priorLocal;
    process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
    resetBackendCache();
    await resetAi();
  });
  process.env.LOCALAPPDATA = path.join(HOME, 'dpapi-localappdata');
  process.env.ZELOS_SECRETS_BACKEND = 'windows-dpapi';
  resetBackendCache();
  ensureNamespace();
  const blob = describeCommand({ name: 'windows-dpapi', action: 'get', ref }).env.ZELOS_SECRET_FILE;
  fs.mkdirSync(path.dirname(blob), { recursive: true });
  fs.writeFileSync(blob, '00');
  const { reads, store } = countingStore(async () => minted.value);
  for (let i = 0; i < 2; i++) {
    assert.equal((await ai.verifyToken(minted.value, { config: minted.config, store })).ok, true);
  }
  assert.equal(reads.length, 1);
  fs.writeFileSync(blob, '0000');
  assert.equal((await ai.verifyToken(minted.value, { config: minted.config, store })).ok, true);
  assert.equal(reads.length, 2, 'a different blob is read again, not trusted from memory');
});

/* ================================================================== *
 * The panel's own source
 *
 * ui/views/ai-access.js cannot be imported here — it reaches for `window` the
 * moment ui/lib/api.js is evaluated — so the few properties of it that a
 * regression could silently take away are asserted against its text. Narrow on
 * purpose: these are the claims, not the rendering.
 * ================================================================== */

const PANEL_SOURCE = fs.readFileSync(path.join(ROOT, 'ui', 'views', 'ai-access.js'), 'utf8');

test('the panel builds its DOM rather than writing markup', () => {
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(PANEL_SOURCE), false,
    'this panel prints a token and an access log — it may never assemble either as markup');
});

test('the minted token is substituted into the config block, not left as a placeholder', () => {
  // The block is built with the value in it, and the placeholder survives only
  // for the copy shown when there is no token to hand.
  assert.match(PANEL_SOURCE, /function httpBlock\(client, token = ''\)/);
  assert.match(PANEL_SOURCE, /Bearer \$\{token \|\| TOKEN_PLACEHOLDER\}/);
  assert.match(PANEL_SOURCE, /httpBlock\(v\.client, revealed\.value\)/);
});

test('the panel asks the routes this file tests', () => {
  assert.match(PANEL_SOURCE, /'\/api\/ai\/test'/);
  assert.match(PANEL_SOURCE, /\/api\/ai\?log=/);
});
