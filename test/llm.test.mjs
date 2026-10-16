/**
 * test/llm.test.mjs — the model adapter, against a real socket.
 *
 * Every protocol claim here is proved by what arrives at a node:http server:
 * the request path, the headers, and the parsed body. Nothing is stubbed, so a
 * refactor that quietly stops sending `anthropic-version` fails here.
 *
 * Two testing notes worth knowing before you edit this file:
 *
 * 1. No third-party host is ever contacted. The mock binds 127.0.0.1:0.
 *
 * 2. To exercise the NON-local code paths (key required, `response_format`
 *    sent) we need an address that `isLocalAddress` calls remote but that still
 *    reaches the mock. Every literal that routes to loopback is — correctly —
 *    classified local, and resolving a real hostname would mean a DNS lookup to
 *    a third party. So `pinOrigin` rewrites one fixed origin onto the mock at
 *    the fetch layer: an in-process /etc/hosts entry. The adapter still builds
 *    and sends its own real request, and the mock still records what arrived —
 *    only the connection target is redirected. The fake origin uses the
 *    reserved `.invalid` TLD, which can never resolve, so a pin that failed to
 *    install produces a loud failure instead of a silent real request.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  LLMError,
  PRESETS,
  complete,
  extractJSON,
  isLocalAddress,
  listModels,
  probeLocal,
  stream,
} from '../core/llm.mjs';

// The adapter never touches disk, but no test in this project is allowed near
// the real ~/.zelos, so point HOME at a throwaway directory regardless.
process.env.ZELOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-llm-test-'));

const FAKE_ORIGIN = 'https://api.example.invalid';

/* ------------------------------------------------------------------ *
 * Mock server implementing both wire protocols
 * ------------------------------------------------------------------ */

const OPENAI_COMPLETION = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  model: 'mock-openai-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
};

const ANTHROPIC_MESSAGE = {
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  model: 'mock-anthropic-model',
  content: [
    { type: 'text', text: 'po' },
    { type: 'text', text: 'ng' },
  ],
  usage: { input_tokens: 7, output_tokens: 2 },
};

const OPENAI_MODELS = {
  object: 'list',
  data: [
    { id: 'llama3.2', object: 'model' },
    { id: 'qwen2.5', object: 'model' },
    { id: 'llama3.2', object: 'model' }, // duplicate — must be collapsed
  ],
};

const ANTHROPIC_MODELS = {
  data: [
    { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' },
    { type: 'model', id: 'claude-sonnet-5' }, // no display_name — label falls back to id
  ],
  has_more: false,
};

const OPENAI_SSE = [
  'data: {"id":"chatcmpl-mock","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
  'data: {"model":"mock-openai-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],' +
    '"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n',
  'data: [DONE]\n\n',
];

const ANTHROPIC_SSE = [
  'event: message_start\r\n' +
    'data: {"type":"message_start","message":{"id":"msg_mock","model":"mock-anthropic-model",' +
    '"usage":{"input_tokens":12,"output_tokens":1}}}\r\n\r\n',
  'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
  // A non-text delta the reader must ignore rather than concatenate.
  'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}\n\n',
  'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
  'event: ping\ndata: {"type":"ping"}\n\n',
  'event: message_delta\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };

function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendChunks(res, canned, state) {
  res.writeHead(canned.status ?? 200, canned.headers ?? SSE_HEADERS);
  // writeHead only stages the headers — node flushes them with the first body
  // write. A real SSE server sends them straight away, and without this a
  // "headers then silence" plan would be indistinguishable to the client from
  // "no response at all", which is a different bug with a different bound.
  res.flushHeaders();
  const delay = canned.delayMs ?? 0;
  let i = 0;
  const next = () => {
    if (i >= canned.chunks.length) {
      // `thenHang` is the wedged-upstream shape: a healthy 200, optionally some
      // chunks, and then a socket that stays open saying nothing. Ending the
      // response instead would test the happy path.
      if (canned.thenHang) {
        state.hung.add(res);
        res.on('close', () => state.hung.delete(res));
        return;
      }
      res.end();
      return;
    }
    res.write(canned.chunks[i++]);
    setTimeout(next, delay);
  };
  next();
}

async function startMock() {
  const state = { requests: [], plan: [], hung: new Set() };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      state.requests.push({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        raw,
        body,
      });

      const canned = state.plan.shift();
      if (canned) {
        if (canned.hang) {
          state.hung.add(res);
          res.on('close', () => state.hung.delete(res));
          return;
        }
        if (canned.hangBody) {
          // The nastier hang: a healthy 200 with headers and a first chunk,
          // then a body that never completes. This is what a proxy mid-restart
          // or a wedged local runtime actually looks like on the wire.
          state.hung.add(res);
          res.on('close', () => state.hung.delete(res));
          res.writeHead(canned.status ?? 200, { 'content-type': 'application/json' });
          res.write(typeof canned.body === 'string' ? canned.body : '{"choices":[');
          return;
        }
        if (canned.chunks) return sendChunks(res, canned, state);
        const payload = typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body ?? {});
        res.writeHead(canned.status ?? 200, {
          'content-type': 'application/json',
          ...(canned.headers ?? {}),
        });
        res.end(payload);
        return;
      }

      // Default behaviour: act like a correct server for both protocols.
      if (req.method === 'POST' && url.pathname === '/chat/completions') {
        if (body?.stream) return sendChunks(res, { chunks: OPENAI_SSE }, state);
        return sendJson(res, 200, OPENAI_COMPLETION);
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        if (body?.stream) return sendChunks(res, { chunks: ANTHROPIC_SSE }, state);
        return sendJson(res, 200, ANTHROPIC_MESSAGE);
      }
      if (req.method === 'GET' && url.pathname === '/models') return sendJson(res, 200, OPENAI_MODELS);
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return sendJson(res, 200, ANTHROPIC_MODELS);
      }
      return sendJson(res, 404, { error: { message: `no mock route for ${req.method} ${url.pathname}` } });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    requests: state.requests,
    plan: state.plan,
    last() {
      return state.requests[state.requests.length - 1];
    },
    reset() {
      state.requests.length = 0;
      state.plan.length = 0;
    },
    async close() {
      for (const res of state.hung) {
        try {
          res.destroy();
        } catch {
          /* already gone */
        }
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** An in-process hosts entry: `fakeOrigin` connects to `realOrigin`. */
function pinOrigin(fakeOrigin, realOrigin) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.startsWith(fakeOrigin)) {
      return original(realOrigin + url.slice(fakeOrigin.length), init);
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

let mock;
let unpin;

before(async () => {
  mock = await startMock();
  unpin = pinOrigin(FAKE_ORIGIN, mock.origin);
});

after(async () => {
  unpin();
  await mock.close();
  fs.rmSync(process.env.ZELOS_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => mock.reset());

/* ------------------------------------------------------------------ *
 * isLocalAddress
 * ------------------------------------------------------------------ */

test('isLocalAddress recognises this machine and this LAN', () => {
  const local = [
    'http://localhost:11434/v1',
    'http://LOCALHOST:1234',
    'http://127.0.0.1:8080/v1',
    'http://127.1.2.3:8080',
    'http://[::1]:8000/v1',
    'http://[0:0:0:0:0:0:0:1]:8000',
    'http://[::ffff:127.0.0.1]:8000',
    'http://[::ffff:7f00:1]:8000', // the same address, as URL normalises it
    'http://[fe80::1]:8000',
    'http://[fd00::5]:8000',
    'http://studio.local:1234/v1',
    'http://192.168.1.50:11434/v1',
    'http://10.0.0.7:8000',
    'http://172.16.0.1:8000',
    'http://172.31.255.255:8000',
    'http://0.0.0.0:8080',
    'localhost:1234',
    '127.0.0.1:11434',
  ];
  for (const url of local) assert.equal(isLocalAddress(url), true, `${url} should be local`);

  const remote = [
    'https://api.anthropic.com',
    'https://api.openai.com/v1',
    'http://172.15.0.1:8000',
    'http://172.32.0.1:8000',
    'http://11.0.0.1:8000',
    'http://8.8.8.8',
    'http://[::ffff:8.8.8.8]:8000', // a mapped PUBLIC address is not local
    'http://[2606:4700::1111]:8000',
    'https://notlocalhost.com',
    'https://localhost.evil.com',
    'https://api.example.invalid',
    'https://local',
  ];
  for (const url of remote) assert.equal(isLocalAddress(url), false, `${url} should be remote`);

  assert.equal(isLocalAddress(''), false);
  assert.equal(isLocalAddress(null), false);
  assert.equal(isLocalAddress(undefined), false);
  assert.equal(isLocalAddress(42), false);
  assert.equal(isLocalAddress('   '), false);
});

/* ------------------------------------------------------------------ *
 * extractJSON
 * ------------------------------------------------------------------ */

test('extractJSON parses clean output', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJSON('  \n {"a": [1,2,3]} \n '), { a: [1, 2, 3] });
  assert.deepEqual(extractJSON('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
});

test('extractJSON strips markdown fences', () => {
  assert.deepEqual(extractJSON('```json\n{"items":[]}\n```'), { items: [] });
  assert.deepEqual(extractJSON('```\n{"items":[1]}\n```'), { items: [1] });
  assert.deepEqual(extractJSON('```JSON\n{"ok":true}\n```'), { ok: true });
  // Truncated output: the closing fence never arrived.
  assert.deepEqual(extractJSON('```json\n{"ok":true}'), { ok: true });
});

test('extractJSON recovers JSON wrapped in prose', () => {
  const wrapped = 'Sure! Here is the JSON you asked for:\n\n{"bucket":"now"}\n\nLet me know if that helps.';
  assert.deepEqual(extractJSON(wrapped), { bucket: 'now' });
  assert.deepEqual(extractJSON('Result: [1,2,3] — done.'), [1, 2, 3]);
});

test('extractJSON prefers the fenced block over braces in the surrounding prose', () => {
  // The naive "first balanced {...}" scan would return {} from the prose.
  const text = 'Use {} for an empty object. My answer:\n```json\n{"answer":42}\n```\nThanks.';
  assert.deepEqual(extractJSON(text), { answer: 42 });
});

test('extractJSON handles nested braces and braces inside strings', () => {
  const nested = '{"a":{"b":{"c":[{"d":1}]}}}';
  assert.deepEqual(extractJSON(`prefix ${nested} suffix`), { a: { b: { c: [{ d: 1 }] } } });

  const braceInString = '{"headline":"Reply to Bob about the } brace","why":"has { and } in it"}';
  assert.deepEqual(extractJSON(`Here:\n${braceInString}`), {
    headline: 'Reply to Bob about the } brace',
    why: 'has { and } in it',
  });

  const escapedQuote = '{"note":"he said \\"} done\\" loudly"}';
  assert.deepEqual(extractJSON(`text ${escapedQuote} text`), { note: 'he said "} done" loudly' });
});

test('extractJSON skips unparseable candidates and keeps looking', () => {
  // `{not json}` is balanced but invalid; the scan must move to the next opener.
  assert.deepEqual(extractJSON('I would write {not json} normally, but here: {"ok":1}'), { ok: 1 });
});

test('extractJSON returns null when there is nothing to recover', () => {
  assert.equal(extractJSON('I cannot help with that.'), null);
  assert.equal(extractJSON(''), null);
  assert.equal(extractJSON('   '), null);
  assert.equal(extractJSON(null), null);
  assert.equal(extractJSON(undefined), null);
  assert.equal(extractJSON({ a: 1 }), null);
  assert.equal(extractJSON('{"unclosed": 1'), null);
});

/* ------------------------------------------------------------------ *
 * PRESETS
 * ------------------------------------------------------------------ */

test('PRESETS covers every provider the spec names, with a consistent shape', () => {
  const required = [
    'anthropic', 'openai', 'gemini', 'groq', 'mistral', 'deepseek', 'xai',
    'together', 'openrouter', 'fireworks', 'cerebras',
    'ollama', 'lmstudio', 'llamacpp', 'vllm', 'localai',
  ];
  const byId = new Map(PRESETS.map((p) => [p.id, p]));
  for (const id of required) assert.ok(byId.has(id), `missing preset: ${id}`);
  assert.equal(byId.size, PRESETS.length, 'preset ids must be unique');

  for (const preset of PRESETS) {
    assert.equal(typeof preset.label, 'string', `${preset.id}.label`);
    assert.ok(['openai', 'anthropic'].includes(preset.protocol), `${preset.id}.protocol`);
    assert.equal(typeof preset.baseUrl, 'string', `${preset.id}.baseUrl`);
    assert.equal(typeof preset.docsUrl, 'string', `${preset.id}.docsUrl`);
    assert.ok(preset.keyUrl === null || typeof preset.keyUrl === 'string', `${preset.id}.keyUrl`);
    assert.equal(typeof preset.local, 'boolean', `${preset.id}.local`);
    assert.ok(Array.isArray(preset.suggestedModels), `${preset.id}.suggestedModels`);
    assert.equal(typeof preset.keyless, 'boolean', `${preset.id}.keyless`);
    assert.equal(typeof preset.note, 'string', `${preset.id}.note`);
    // The flag and the address must agree, or the UI will demand a key for Ollama.
    assert.equal(isLocalAddress(preset.baseUrl), preset.local, `${preset.id} locality mismatch`);
    if (preset.keyless) assert.equal(preset.local, true, `${preset.id} keyless but remote`);
  }

  assert.equal(byId.get('anthropic').protocol, 'anthropic');
  assert.equal(byId.get('anthropic').baseUrl, 'https://api.anthropic.com');
  assert.equal(byId.get('ollama').protocol, 'openai', 'Ollama speaks the openai protocol');
  assert.equal(byId.get('ollama').keyless, true);
});

/* ------------------------------------------------------------------ *
 * openai protocol — what hits the socket
 * ------------------------------------------------------------------ */

test('openai complete() sends the documented request and parses the reply', async () => {
  const result = await complete({
    protocol: 'openai',
    baseUrl: mock.origin,
    model: 'llama3.2',
    system: 'You are Zelos.',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'second' },
    ],
    maxTokens: 512,
    temperature: 0,
    retries: 0,
  });

  assert.equal(mock.requests.length, 1);
  const req = mock.last();
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/chat/completions');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.body.model, 'llama3.2');
  assert.equal(req.body.max_tokens, 512);
  assert.equal(req.body.temperature, 0);
  assert.equal(req.body.stream, undefined, 'non-streaming requests must not set stream');
  assert.deepEqual(req.body.messages, [
    { role: 'system', content: 'You are Zelos.' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ack' },
    { role: 'user', content: 'second' },
  ]);

  assert.equal(result.text, 'pong');
  assert.deepEqual(result.usage, { input: 11, output: 3 });
  assert.equal(result.model, 'mock-openai-model');
  assert.equal(result.raw.id, 'chatcmpl-mock');
});

test('openai sends Authorization: Bearer when a key is configured', async () => {
  await complete({
    protocol: 'openai',
    baseUrl: mock.origin,
    model: 'llama3.2',
    apiKey: 'sk-test-key-value',
    messages: [{ role: 'user', content: 'hi' }],
    retries: 0,
  });
  const req = mock.last();
  assert.equal(req.headers.authorization, 'Bearer sk-test-key-value');
  assert.equal(req.headers['x-api-key'], undefined, 'openai must not send x-api-key');
});

test('a keyless local endpoint works and sends no Authorization header', async () => {
  const result = await complete({
    protocol: 'openai',
    baseUrl: mock.origin, // 127.0.0.1 — local
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'hi' }],
    retries: 0,
  });
  assert.equal(result.text, 'pong');
  assert.equal(mock.last().headers.authorization, undefined);
});

test('a missing key is an error for a remote address, before any socket is opened', async () => {
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: FAKE_ORIGIN,
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      // The sentence is the one a person reads on the board, so it says
      // where to go and not which host would have been asked; the address
      // rides on the error for the log.
      assert.equal(err.message, 'No key has been saved for this AI service — open Settings → AI and paste one. (An AI program on this computer needs no key.)');
      assert.ok(!/api\.example\.invalid/.test(err.message), 'the message names the address the reader never typed');
      assert.equal(err.address, FAKE_ORIGIN, 'the address must still ride on the error');
      return true;
    },
  );
  assert.equal(mock.requests.length, 0, 'no request should have been attempted');
});

test('json:true sets response_format on a remote openai endpoint only', async () => {
  await complete({
    protocol: 'openai',
    baseUrl: FAKE_ORIGIN,
    model: 'gpt-4.1',
    apiKey: 'sk-remote',
    system: 'Be terse.',
    messages: [{ role: 'user', content: 'hi' }],
    json: true,
    retries: 0,
  });
  const remote = mock.last();
  assert.deepEqual(remote.body.response_format, { type: 'json_object' });
  assert.equal(remote.headers.authorization, 'Bearer sk-remote');
  assert.equal(remote.body.messages[0].content, 'Be terse.', 'remote prompt is left alone');
});

test('json:true never sends response_format to a local endpoint; it prompts instead', async () => {
  await complete({
    protocol: 'openai',
    baseUrl: mock.origin,
    model: 'llama3.2',
    system: 'Be terse.',
    messages: [{ role: 'user', content: 'hi' }],
    json: true,
    retries: 0,
  });
  const local = mock.last();
  assert.equal(local.body.response_format, undefined, 'local servers reject response_format');
  assert.match(local.body.messages[0].content, /^Be terse\./);
  assert.match(local.body.messages[0].content, /single JSON object/i);
});

test('json:true on anthropic prompts rather than sending response_format', async () => {
  await complete({
    protocol: 'anthropic',
    baseUrl: FAKE_ORIGIN,
    model: 'claude-opus-5',
    apiKey: 'sk-ant-remote',
    messages: [{ role: 'user', content: 'hi' }],
    json: true,
    retries: 0,
  });
  const req = mock.last();
  assert.equal(req.body.response_format, undefined);
  assert.match(req.body.system, /single JSON object/i);
});

/* ------------------------------------------------------------------ *
 * anthropic protocol — what hits the socket
 * ------------------------------------------------------------------ */

test('anthropic complete() sends the documented request and parses the reply', async () => {
  const result = await complete({
    protocol: 'anthropic',
    baseUrl: mock.origin,
    model: 'claude-opus-5',
    apiKey: 'sk-ant-test-key',
    system: 'You are Zelos.',
    messages: [{ role: 'user', content: 'hi' }],
    retries: 0,
  });

  const req = mock.last();
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-ant-test-key');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers.authorization, undefined, 'anthropic must not send a Bearer token');
  assert.equal(req.body.system, 'You are Zelos.', 'system belongs at the top level');
  assert.deepEqual(req.body.messages, [{ role: 'user', content: 'hi' }]);
  assert.ok(
    req.body.messages.every((m) => m.role !== 'system'),
    'system must not appear as a message',
  );
  assert.equal(typeof req.body.max_tokens, 'number', 'anthropic requires max_tokens');
  assert.ok(req.body.max_tokens > 0);

  assert.equal(result.text, 'pong', 'text blocks are joined');
  assert.deepEqual(result.usage, { input: 7, output: 2 });
  assert.equal(result.model, 'mock-anthropic-model');
});

test('REGRESSION: an anthropic request carries no temperature — Sonnet 5 and Opus 5 refuse it', async () => {
  // The operator's first real sweep after pasting a working key: 400,
  // "`temperature` is deprecated for this model". The config default (0)
  // was on every Anthropic request; the OpenAI protocol keeps it.
  mock.reset?.();
  await complete({
    protocol: 'anthropic',
    baseUrl: mock.origin,
    apiKey: 'sk-ant-test-key',
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
    retries: 0,
  });
  const req = mock.last();
  assert.equal(req.path, '/v1/messages');
  assert.equal(req.body.temperature, undefined, 'anthropic must not be sent temperature');
  assert.ok(!('top_p' in req.body) && !('top_k' in req.body), 'nor any other sampling knob');

  await complete({
    protocol: 'openai',
    baseUrl: mock.origin,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
    retries: 0,
  });
  assert.equal(mock.last().body.temperature, 0, 'the OpenAI protocol still carries it');
});

test('anthropic does not double up /v1 when the base URL already has it', async () => {
  await complete({
    protocol: 'anthropic',
    baseUrl: `${mock.origin}/v1`,
    model: 'claude-opus-5',
    apiKey: 'k',
    messages: [{ role: 'user', content: 'hi' }],
    retries: 0,
  });
  assert.equal(mock.last().path, '/v1/messages');
});

test('system-role messages are folded into the top-level system prompt', async () => {
  await complete({
    protocol: 'anthropic',
    baseUrl: mock.origin,
    model: 'claude-opus-5',
    apiKey: 'k',
    system: 'Base rules.',
    messages: [
      { role: 'system', content: 'Extra rules.' },
      { role: 'user', content: 'hi' },
    ],
    retries: 0,
  });
  const req = mock.last();
  assert.equal(req.body.system, 'Base rules.\n\nExtra rules.');
  assert.deepEqual(req.body.messages, [{ role: 'user', content: 'hi' }]);
});

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

test('complete() refuses a JSON response that is not a completion envelope', async () => {
  for (const [protocol, body] of [
    ['openai', { status: 'ok' }], ['openai', { choices: [] }],
    ['openai', { choices: [{ message: null }] }],
    ['anthropic', { status: 'ok' }], ['anthropic', { content: 'ready' }],
  ]) {
    mock.plan.push({ body });
    await assert.rejects(() => complete({
      protocol, baseUrl: mock.origin, model: 'test', apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }], retries: 0,
    }), /invalid .*response/i, `${protocol}: ${JSON.stringify(body)}`);
  }
});

test('completion validation accepts empty text, tool calls, and refusals', async () => {
  for (const [protocol, body] of [
    ['openai', { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }],
    ['openai', { choices: [{ message: { content: null, refusal: 'Cannot help.' }, finish_reason: 'stop' }] }],
    ['openai', { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }],
    ['anthropic', { content: [], stop_reason: 'end_turn' }],
    ['anthropic', { content: [{ type: 'tool_use', id: 'tool_1', name: 'lookup', input: {} }], stop_reason: 'tool_use' }],
  ]) {
    mock.plan.push({ body });
    const answer = await complete({
      protocol, baseUrl: mock.origin, model: 'test', apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }], retries: 0,
    });
    assert.equal(answer.text, '');
    assert.deepEqual(answer.raw, body);
  }
});

test('stream() preserves an ordinary JSON completion and its usage', async () => {
  for (const [protocol, body, usage] of [
    ['openai', { model: 'fallback', choices: [{ message: { content: 'Whole answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }, { input: 12, output: 3 }],
    ['anthropic', { model: 'fallback', content: [{ type: 'text', text: 'Whole answer' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } }, { input: 12, output: 3 }],
  ]) {
    mock.plan.push({ body });
    const events = await collect(stream({
      protocol, baseUrl: mock.origin, model: 'test', apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }], retries: 0,
    }));
    assert.deepEqual(events.filter((event) => event.type === 'delta'), [{ type: 'delta', text: 'Whole answer' }]);
    assert.equal(events.at(-1).text, 'Whole answer');
    assert.equal(events.at(-1).model, 'fallback');
    assert.deepEqual(events.at(-1).usage, usage);
  }
  mock.plan.push({ body: { status: 'ok' } });
  await assert.rejects(() => collect(stream({
    protocol: 'openai', baseUrl: mock.origin, model: 'test',
    messages: [{ role: 'user', content: 'hi' }], retries: 0,
  })), /invalid .*response/i);
});

test('stream() parses openai SSE and reports usage on done', async () => {
  const events = await collect(
    stream({
      protocol: 'openai',
      baseUrl: mock.origin,
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      retries: 0,
    }),
  );

  assert.equal(mock.last().body.stream, true, 'streaming requests must set stream:true');
  assert.equal(
    mock.last().body.stream_options,
    undefined,
    'stream_options is provider-only; local servers reject it',
  );

  const deltas = events.filter((e) => e.type === 'delta');
  assert.deepEqual(deltas.map((d) => d.text), ['Hel', 'lo']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, 'Hello');
  assert.deepEqual(done.usage, { input: 9, output: 4 });
  assert.equal(done.model, 'mock-openai-model');
});

test('stream() asks a remote openai endpoint for usage via stream_options', async () => {
  mock.plan.push({ chunks: OPENAI_SSE });
  await collect(
    stream({
      protocol: 'openai',
      baseUrl: FAKE_ORIGIN,
      model: 'gpt-4.1',
      apiKey: 'sk-remote',
      messages: [{ role: 'user', content: 'hi' }],
      retries: 0,
    }),
  );
  assert.deepEqual(mock.last().body.stream_options, { include_usage: true });
});

test('stream() parses anthropic SSE and ignores non-text deltas', async () => {
  const events = await collect(
    stream({
      protocol: 'anthropic',
      baseUrl: mock.origin,
      model: 'claude-opus-5',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
      retries: 0,
    }),
  );

  const req = mock.last();
  assert.equal(req.path, '/v1/messages');
  assert.equal(req.body.stream, true);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');

  const deltas = events.filter((e) => e.type === 'delta');
  assert.deepEqual(deltas.map((d) => d.text), ['Hel', 'lo'], 'input_json_delta must be skipped');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, 'Hello');
  assert.deepEqual(done.usage, { input: 12, output: 5 });
  assert.equal(done.model, 'mock-anthropic-model');
});

test('stream() reassembles events split across packets, including multibyte characters', async () => {
  // "café ☕" — the ☕ is three bytes, deliberately torn across two writes,
  // and one SSE event boundary lands mid-frame.
  const frame = Buffer.from(
    'data: {"choices":[{"delta":{"content":"café ☕"}}]}\n\ndata: [DONE]\n\n',
    'utf8',
  );
  const tearAt = frame.indexOf(Buffer.from('☕', 'utf8')) + 1;
  mock.plan.push({
    chunks: [frame.subarray(0, tearAt), frame.subarray(tearAt)],
    delayMs: 10,
  });

  const events = await collect(
    stream({
      protocol: 'openai',
      baseUrl: mock.origin,
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      retries: 0,
    }),
  );
  const text = events.filter((e) => e.type === 'delta').map((d) => d.text).join('');
  assert.equal(text, 'café ☕');
  assert.equal(events.at(-1).type, 'done');
});

test('stream() refuses EOF before a provider completion marker', async () => {
  for (const [protocol, chunks] of [
    ['openai', ['data: {"choices":[{"delta":{"content":"The appointment is on"}}]}\n\n']],
    ['anthropic', ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The appointment is on"}}\n\n']],
    ['openai', [': ping\n\n']],
  ]) {
    mock.plan.push({ chunks });
    const seen = [];
    await assert.rejects(async () => {
      for await (const event of stream({
        protocol, baseUrl: mock.origin, model: 'test', apiKey: 'k',
        messages: [{ role: 'user', content: 'hi' }], retries: 0,
      })) seen.push(event);
    }, /ended before.*complete/i);
    assert.equal(seen.some((event) => event.type === 'done'), false, protocol);
  }
});

test('stream() accepts provider completion variants and trailing usage', async () => {
  for (const [protocol, chunks, expectedUsage] of [
    ['openai', ['data: {"choices":[{"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'], { input: 5, output: 2 }],
    ['openai', ['data: {"choices":[{"delta":{"content":"Ready"}}]}\n\n', 'data: [DONE]'], { input: 0, output: 0 }],
    ['anthropic', ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Ready"}}\n\n',
      'data: {"type":"message_stop"}\n\n'], { input: 0, output: 0 }],
    ['anthropic', ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Ready"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'], { input: 0, output: 2 }],
  ]) {
    mock.plan.push({ chunks });
    const events = await collect(stream({
      protocol, baseUrl: mock.origin, model: 'test', apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }], retries: 0,
    }));
    assert.equal(events.at(-1).type, 'done', protocol);
    assert.equal(events.at(-1).text, 'Ready', protocol);
    assert.deepEqual(events.at(-1).usage, expectedUsage, protocol);
  }
});

test('stream() reports token-limit stops without losing partial text or usage', async () => {
  for (const [protocol, chunks] of [
    ['openai', [
      'data: {"choices":[{"delta":{"content":"The next step is"},"finish_reason":"length"}],"usage":{"prompt_tokens":12,"completion_tokens":32}}\n\n',
      'data: [DONE]\n\n',
    ]],
    ['anthropic', [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"The next step is"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":32}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]],
  ]) {
    mock.plan.push({ chunks });
    const events = await collect(stream({
      protocol, baseUrl: mock.origin, model: 'test', apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }], retries: 0,
    }));
    assert.equal(events.at(-1).stopReason, 'length', protocol);
    assert.equal(events.at(-1).text, 'The next step is', protocol);
    assert.deepEqual(events.at(-1).usage, { input: 12, output: 32 }, protocol);
  }
});

test('stream() surfaces a mid-stream anthropic error event', async () => {
  mock.plan.push({
    chunks: [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"upstream is busy"}}\n\n',
    ],
  });

  const seen = [];
  await assert.rejects(
    async () => {
      for await (const event of stream({
        protocol: 'anthropic',
        baseUrl: mock.origin,
        model: 'claude-opus-5',
        apiKey: 'k',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 0,
      })) {
        seen.push(event);
      }
    },
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /upstream is busy/);
      assert.match(err.message, /127\.0\.0\.1/, 'the error must name the address');
      return true;
    },
  );
  assert.deepEqual(seen.map((e) => e.text), ['partial'], 'deltas before the error still arrive');
});

/* ------------------------------------------------------------------ *
 * Streaming: the idle deadline
 *
 * The bound on a stream cannot be a total one — a long answer is allowed to
 * take a long time — so it is a silence detector instead. These three tests
 * pin the whole contract: silence from the start ends it, silence after
 * keepalives ends it, and keepalives themselves hold it open.
 * ------------------------------------------------------------------ */

test('a stream that never sends a byte is bounded, not waited on forever', { timeout: 8000 }, async () => {
  // 200, SSE headers, then nothing. Clearing the request timer on response
  // headers left this to undici's bodyTimeout, which fired at a measured
  // 301,028 ms — five minutes of "Thinking…" for a wedged proxy.
  mock.plan.push({ chunks: [], thenHang: true });
  const started = Date.now();
  await assert.rejects(
    async () => {
      for await (const _event of stream({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 400,
        retries: 0,
      })) {
        /* nothing should arrive */
      }
    },
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /did not respond in time/);
      assert.match(err.message, /127\.0\.0\.1/, 'the error must name the address');
      return true;
    },
  );
  assert.ok(Date.now() - started < 3000, 'the deadline must cover the first byte too');
});

test('keepalives hold a stream open, and the silence after them ends it', { timeout: 8000 }, async () => {
  // Four SSE comments 250 ms apart under a 400 ms deadline, then silence. Both
  // halves matter. The comments must reset the clock — proxies inject them and
  // anthropic sends {"type":"ping"} by design, so a reader that only counted
  // frames it understood would abort healthy streams. And the silence after
  // them must still bite: this exact server, pinging every 2 s, previously kept
  // stream({timeoutMs:1500}) running past 45 s with no bound at all.
  mock.plan.push({
    chunks: [': ping\n\n', ': ping\n\n', ': ping\n\n', 'data: {"type":"ping"}\n\n'],
    delayMs: 250,
    thenHang: true,
  });
  const started = Date.now();
  await assert.rejects(
    async () => {
      for await (const _event of stream({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 400,
        retries: 0,
      })) {
        /* a ping is not a token; nothing should arrive */
      }
    },
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /did not respond in time/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 700, `the keepalives must reset the deadline (gave up after ${elapsed}ms)`);
  assert.ok(elapsed < 5000, `and the silence after them must end it (took ${elapsed}ms)`);
});

test('a stream that keeps delivering outlives the deadline it keeps resetting', async () => {
  // Ten chunks 100 ms apart: a second of wall clock under a 500 ms deadline. A
  // total timeout would kill this mid-answer, which is why the bound is idle.
  const chunks = [];
  for (let i = 0; i < 4; i++) {
    chunks.push(': ping\n\n', `data: {"choices":[{"delta":{"content":"${i}"}}]}\n\n`);
  }
  chunks.push(': ping\n\n', 'data: [DONE]\n\n');
  mock.plan.push({ chunks, delayMs: 100 });

  const started = Date.now();
  const events = await collect(
    stream({
      protocol: 'openai',
      baseUrl: mock.origin,
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 500,
      retries: 0,
    }),
  );
  const elapsed = Date.now() - started;
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).text, '0123', 'every token survived');
  assert.ok(elapsed > 500, `the stream really did outlast its deadline (${elapsed}ms)`);
});

test('the Stop button still reaches a stream that is mid-flight', async () => {
  // The idle deadline shares one AbortController with the caller's signal, so
  // this is the test that catches a fix that wired the timer and unwired Stop.
  mock.plan.push({ chunks: [': ping\n\n'], delayMs: 50, thenHang: true });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(
    async () => {
      for await (const _event of stream({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 30_000,
        retries: 0,
        signal: controller.signal,
      })) {
        /* nothing to collect */
      }
    },
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /cancelled/i);
      assert.match(err.message, /127\.0\.0\.1/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 3000, 'Stop must not wait out the idle deadline');
});

/* ------------------------------------------------------------------ *
 * Retry policy
 * ------------------------------------------------------------------ */

test('a 500 is retried and the retry succeeds', async () => {
  mock.plan.push({ status: 500, body: { error: { message: 'boom' } } });
  const result = await complete({
    protocol: 'openai',
    baseUrl: mock.origin,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'hi' }],
    retries: 2,
  });
  assert.equal(result.text, 'pong');
  assert.equal(mock.requests.length, 2, 'exactly one retry');
  assert.equal(mock.requests[0].path, '/chat/completions');
});

test('a 429 honours Retry-After', async () => {
  mock.plan.push({ status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'slow down' } } });
  const started = Date.now();
  const result = await complete({
    protocol: 'openai',
    baseUrl: mock.origin,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'hi' }],
    retries: 2,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.text, 'pong');
  assert.equal(mock.requests.length, 2);
  assert.ok(elapsed >= 900, `expected to wait ~1s, waited ${elapsed}ms`);
});

test('a 401 is never retried and the message names the address', async () => {
  mock.plan.push({ status: 401, body: { error: { message: 'invalid x-api-key' } } });
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        apiKey: 'sk-wrong',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 3,
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.status, 401);
      assert.equal(err.retriable, false);
      assert.equal(err.address, mock.origin);
      assert.match(err.message, /127\.0\.0\.1/);
      assert.match(err.message, /check the API key/);
      assert.match(err.message, /invalid x-api-key/, 'the provider detail is preserved');
      return true;
    },
  );
  assert.equal(mock.requests.length, 1, '401 must not be retried');
});

test('a 403 is never retried', async () => {
  mock.plan.push({ status: 403, body: { error: { message: 'no access to this model' } } });
  await assert.rejects(
    () =>
      complete({
        protocol: 'anthropic',
        baseUrl: mock.origin,
        model: 'claude-opus-5',
        apiKey: 'k',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 3,
      }),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.retriable, false);
      return true;
    },
  );
  assert.equal(mock.requests.length, 1, '403 must not be retried');
});

test('retries are bounded — a permanent 429 gives up after `retries` attempts', async () => {
  for (let i = 0; i < 5; i++) {
    mock.plan.push({ status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'nope' } } });
  }
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 2,
      }),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.retriable, true);
      return true;
    },
  );
  assert.equal(mock.requests.length, 3, 'initial attempt plus two retries');
});

test('a Retry-After longer than the retry budget fails fast instead of sleeping', async () => {
  mock.plan.push({ status: 429, headers: { 'retry-after': '3600' }, body: { error: { message: 'come back later' } } });
  const started = Date.now();
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 3,
      }),
    (err) => {
      assert.equal(err.status, 429);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000, 'must not sleep for the requested hour');
  assert.equal(mock.requests.length, 1);
});

test('an AbortSignal interrupts a backoff sleep promptly', async () => {
  mock.plan.push({ status: 503, headers: { 'retry-after': '5' }, body: { error: { message: 'down' } } });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 80);

  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 3,
        signal: controller.signal,
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /cancelled/i);
      assert.match(err.message, /127\.0\.0\.1/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, 'abort must not wait out the Retry-After');
});

test('an already-aborted signal fails without opening a socket', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
    (err) => {
      assert.match(err.message, /cancelled/i);
      return true;
    },
  );
  assert.equal(mock.requests.length, 0);
});

/* ------------------------------------------------------------------ *
 * Transport failures
 * ------------------------------------------------------------------ */

test('a redirect is refused rather than followed with the key attached', async () => {
  mock.plan.push({ status: 302, headers: { location: 'https://elsewhere.invalid/v1/messages' }, body: '' });
  await assert.rejects(
    () =>
      complete({
        protocol: 'anthropic',
        baseUrl: mock.origin,
        model: 'claude-opus-5',
        apiKey: 'sk-secret',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 2,
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.retriable, false);
      assert.match(err.message, /redirected to https:\/\/elsewhere\.invalid/);
      assert.match(err.message, /127\.0\.0\.1/);
      return true;
    },
  );
  assert.equal(mock.requests.length, 1, 'a redirect must not be retried or followed');
});

test('a request timeout names the address and is marked retriable', async () => {
  mock.plan.push({ hang: true });
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 150,
        retries: 0,
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.retriable, true);
      assert.match(err.message, /did not respond in time/);
      assert.match(err.message, /127\.0\.0\.1/);
      return true;
    },
  );
});

test('complete() reports why generation stopped, in one vocabulary across protocols', async () => {
  // openai already speaks the vocabulary: finish_reason passes through.
  const stopped = await complete({
    protocol: 'openai', baseUrl: mock.origin, model: 'llama3.2',
    messages: [{ role: 'user', content: 'hi' }], retries: 0,
  });
  assert.equal(stopped.stopReason, 'stop');

  mock.plan.push({
    body: {
      ...OPENAI_COMPLETION,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"items":[' }, finish_reason: 'length' }],
    },
  });
  const cutOff = await complete({
    protocol: 'openai', baseUrl: mock.origin, model: 'llama3.2',
    messages: [{ role: 'user', content: 'hi' }], retries: 0,
  });
  assert.equal(cutOff.stopReason, 'length');

  // anthropic spells the same facts differently; the caller must not care.
  mock.plan.push({ body: { ...ANTHROPIC_MESSAGE, stop_reason: 'max_tokens' } });
  const antCutOff = await complete({
    protocol: 'anthropic', baseUrl: mock.origin, model: 'claude-opus-5', apiKey: 'k',
    messages: [{ role: 'user', content: 'hi' }], retries: 0,
  });
  assert.equal(antCutOff.stopReason, 'length');

  mock.plan.push({ body: { ...ANTHROPIC_MESSAGE, stop_reason: 'end_turn' } });
  const antStopped = await complete({
    protocol: 'anthropic', baseUrl: mock.origin, model: 'claude-opus-5', apiKey: 'k',
    messages: [{ role: 'user', content: 'hi' }], retries: 0,
  });
  assert.equal(antStopped.stopReason, 'stop');

  // A response that does not say is null, never a guess.
  const silent = await complete({
    protocol: 'anthropic', baseUrl: mock.origin, model: 'claude-opus-5', apiKey: 'k',
    messages: [{ role: 'user', content: 'hi' }], retries: 0,
  });
  assert.equal(silent.stopReason, null);
});

test('a 200 whose body never finishes is timed out, not waited on forever', async () => {
  mock.plan.push({ hangBody: true });
  const started = Date.now();
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 200,
        retries: 0,
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /127\.0\.0\.1/, 'the error must name the address');
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, 'the timeout must cover the body read, not just the headers');
});

test('the caller can still cancel while a 200 body is trickling in', async () => {
  mock.plan.push({ hangBody: true });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  const started = Date.now();
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 30_000,
        retries: 0,
        signal: controller.signal,
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, 'abort must reach the body read, not just the request');
});

test('a refused connection reads as "is it running?", naming the address', async () => {
  const port = await unusedPort();
  const dead = `http://127.0.0.1:${port}/v1`;
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: dead,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 0,
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.address, dead);
      assert.match(err.message, new RegExp(`Could not reach the model at http://127\\.0\\.0\\.1:${port}`));
      assert.match(err.message, /is it running/);
      return true;
    },
  );
});

test('an HTML response (wrong base URL) produces a legible error', async () => {
  mock.plan.push({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>Not the API</html>' });
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 0,
      }),
    (err) => {
      assert.match(err.message, /non-JSON response/);
      assert.match(err.message, /127\.0\.0\.1/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ *
 * A failure that arrives with a success status
 * ------------------------------------------------------------------ */

test('an endpoint\'s error text is screened before anything can keep it (TT-3453)', async () => {
  /* QA, 2026-10-10: a 400 whose HTML body held <script> reached runs.error,
     /api/state and the log verbatim, though the reply sample was screened. */
  const call = () => complete({
    protocol: 'openai', baseUrl: mock.origin, model: 'llama3.2',
    messages: [{ role: 'user', content: 'hi' }], retries: 0,
  });
  const cases = [
    [{ status: 400, headers: { 'content-type': 'text/html' }, body: '<html><body><script>alert(1)</script>Bad request</body></html>' }, /an HTML page/],
    [{ status: 400, body: { error: { message: 'bad model <img src=x onerror=alert(1)>' } } }, /looked like markup/],
    [{ status: 200, body: { error: { message: '<script>steal()</script>' } } }, /looked like markup/],
  ];
  for (const [reply, said] of cases) {
    mock.plan.push(reply);
    await assert.rejects(call, (err) => {
      assert.doesNotMatch(err.message, /<script|<img|onerror=/i, `markup survived: ${err.message}`);
      assert.match(err.message, said);
      return true;
    });
  }
  // A plain error page is described too, and a redirect's address is screened.
  mock.plan.push({ status: 502, headers: { 'content-type': 'text/html' }, body: '<html><head><title>502 Bad Gateway</title></head></html>' });
  await assert.rejects(call, /an HTML page/);
  mock.plan.push({ status: 302, headers: { location: 'javascript:alert(1)' }, body: '' });
  await assert.rejects(call, (err) => {
    assert.doesNotMatch(err.message, /javascript:/i);
    assert.match(err.message, /redirected to/);
    return true;
  });
  // Plain words still come through as they were.
  mock.plan.push({ status: 400, body: { error: { message: 'model "llama9" not found' } } });
  await assert.rejects(call, /model "llama9" not found/);
});

test('a 200 carrying an error body is a failure, not an empty answer', async () => {
  // OpenRouter's shape for a billing problem: HTTP 200, the refusal inside the
  // envelope, no `choices` at all. Read as a success this is text:'' — which
  // painted Settings' "Test the connection" green on a dead endpoint, and then
  // had the sweep tell the user to buy a larger model to fix an empty account.
  mock.plan.push({ status: 200, body: { error: { message: '402: insufficient credits', code: 402 } } });
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 0,
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /insufficient credits/, 'the provider detail must survive');
      assert.match(err.message, /127\.0\.0\.1/, 'the error must name the address');
      assert.equal(err.retriable, false, 'a rejected request does not get better on a retry');
      return true;
    },
  );
  assert.equal(mock.requests.length, 1, 'and it must not be retried');

  // anthropic's own envelope, which stream() has always thrown on.
  mock.plan.push({
    status: 200,
    body: { type: 'error', error: { type: 'overloaded_error', message: 'upstream is busy' } },
  });
  await assert.rejects(
    () =>
      complete({
        protocol: 'anthropic',
        baseUrl: mock.origin,
        model: 'claude-opus-5',
        apiKey: 'k',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 0,
      }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /upstream is busy/);
      return true;
    },
  );

  // A bare string error, which some aggregators send instead of an object.
  mock.plan.push({ status: 200, body: { error: 'model not found on this account' } });
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 0,
      }),
    (err) => {
      assert.match(err.message, /model not found on this account/);
      return true;
    },
  );
});

test('stream(): a 200 carrying an error body is a failure, not an empty answer', async () => {
  /* The same OpenRouter shape aimed at the streaming half. A plain JSON error
     body has no `data:` frames at all, so the SSE loop used to end cleanly on
     nothing and hand the Ask panel a finished, empty answer with no diagnosis
     — which half of this file you happened to call decided whether you were
     told. */
  mock.plan.push({ status: 200, body: { error: { message: '402: insufficient credits', code: 402 } } });
  await assert.rejects(
    () => collect(stream({
      protocol: 'openai',
      baseUrl: mock.origin,
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      retries: 0,
    })),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /insufficient credits/, 'the provider detail must survive');
      assert.match(err.message, /error body/, 'named the way complete() names it');
      assert.equal(err.retriable, false, 'a rejected request does not get better on a retry');
      return true;
    },
  );

  // anthropic's request-level envelope, arriving as plain JSON rather than as
  // an SSE `error` frame — the only shape stream() already threw on.
  mock.plan.push({
    status: 200,
    body: { type: 'error', error: { type: 'overloaded_error', message: 'upstream is busy' } },
  });
  await assert.rejects(
    () => collect(stream({
      protocol: 'anthropic',
      baseUrl: mock.origin,
      model: 'claude-opus-5',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
      retries: 0,
    })),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /upstream is busy/);
      return true;
    },
  );

  // The scrub complete() applies to provider-written text is applied here too.
  mock.plan.push({
    status: 200,
    body: { error: { message: 'rejected request with Authorization: Bearer sk-live-do-not-log' } },
  });
  await assert.rejects(
    () => collect(stream({
      protocol: 'openai',
      baseUrl: mock.origin,
      model: 'llama3.2',
      apiKey: 'sk-live-do-not-log',
      messages: [{ role: 'user', content: 'hi' }],
      retries: 0,
    })),
    (err) => {
      assert.ok(!err.message.includes('sk-live-do-not-log'), `key leaked: ${err.message}`);
      assert.match(err.message, /key withheld/);
      return true;
    },
  );
});

test('an error body that quotes the request back does not quote the key back', async () => {
  // Same reasoning as readErrorDetail: this text is written by a third party,
  // it is shown in Settings, and a sweep writes it into runs.stats_json on disk.
  mock.plan.push({
    status: 200,
    body: { error: { message: 'rejected request with Authorization: Bearer sk-live-do-not-log' } },
  });
  await assert.rejects(
    () =>
      complete({
        protocol: 'openai',
        baseUrl: mock.origin,
        model: 'llama3.2',
        apiKey: 'sk-live-do-not-log',
        messages: [{ role: 'user', content: 'hi' }],
        retries: 0,
      }),
    (err) => {
      assert.ok(!err.message.includes('sk-live-do-not-log'), `key leaked: ${err.message}`);
      assert.match(err.message, /key withheld/);
      return true;
    },
  );
});

test('a mid-stream error frame that quotes the request back does not quote the key back', async () => {
  /* REGRESSION. `complete()`, `readErrorDetail` and `listModels()` all scrubbed
     the key out of provider-written text; `stream()` was the fourth path and
     did not, and it was the worst one to miss. An Ask failure goes two places
     at once (core/server.mjs): onto the SSE channel, where ui/views/ask.js
     writes it into the answer body a person is reading, and through `log.warn`,
     which appends it to ~/.zelos/logs and leaves it there. Measured against a
     loopback endpoint that echoes the rejected request:

       failed mid-stream: rejected upstream request with
                          Authorization: Bearer sk-live-DO-NOT-LOG-9f3a

     Both protocols are covered because they take different branches — anthropic
     through the `event: error` case, openai through the `event?.error` test. */
  const KEY = 'sk-live-do-not-log-9f3a';
  const cases = [
    {
      protocol: 'openai',
      chunks: [`data: ${JSON.stringify({ error: { message: `rejected with Authorization: Bearer ${KEY}` } })}\n\n`],
    },
    {
      protocol: 'anthropic',
      chunks: [`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: `rejected x-api-key ${KEY}` } })}\n\n`],
    },
  ];
  for (const { protocol, chunks } of cases) {
    mock.plan.push({ status: 200, headers: SSE_HEADERS, chunks });
    await assert.rejects(
      () => collect(stream({
        protocol,
        baseUrl: mock.origin,
        model: 'llama3.2',
        apiKey: KEY,
        messages: [{ role: 'user', content: 'hi' }],
        retries: 0,
      })),
      (err) => {
        assert.ok(!err.message.includes(KEY), `${protocol} leaked the key mid-stream: ${err.message}`);
        assert.match(err.message, /key withheld/, `${protocol} did not scrub`);
        assert.match(err.message, /failed mid-stream/, `${protocol} lost the diagnosis`);
        return true;
      },
    );
  }
});

test('a healthy reply carrying "error": null is still a success', async () => {
  // Several providers include the field on the happy path. Treating a present
  // key as a failure would break every one of them.
  mock.plan.push({ status: 200, body: { ...OPENAI_COMPLETION, error: null } });
  const result = await complete({
    protocol: 'openai',
    baseUrl: mock.origin,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'hi' }],
    retries: 0,
  });
  assert.equal(result.text, 'pong');
});

/* ------------------------------------------------------------------ *
 * Argument validation
 * ------------------------------------------------------------------ */

test('bad options fail with an LLMError that names the address', async () => {
  await assert.rejects(
    () => complete({ protocol: 'ollama', baseUrl: mock.origin, model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /Unknown model protocol "ollama"/);
      return true;
    },
  );

  await assert.rejects(
    () => complete({ protocol: 'openai', baseUrl: mock.origin, model: '', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      // The address rides on the error, not in the sentence: the board shows
      // this one verbatim, and a URL the person never typed read as the
      // program having gone somewhere on its own.
      assert.match(err.message, /No AI has been chosen yet/);
      assert.doesNotMatch(err.message, /127\.0\.0\.1/);
      assert.equal(err.address, mock.origin);
      return true;
    },
  );

  await assert.rejects(
    () => complete({ protocol: 'openai', baseUrl: mock.origin, model: 'llama3.2', messages: [] }),
    (err) => {
      assert.match(err.message, /No messages to send/);
      return true;
    },
  );

  assert.equal(mock.requests.length, 0);
});

test('REGRESSION: a blank install is told to pick a model, not that a key is missing', async () => {
  // core/config.mjs DEFAULTS pre-select a hosted provider with `model: ''`,
  // and requireKey ran before the empty-model check — so on a home nobody has
  // set up, every run row, the SSE relay and the board banner said "No API
  // key configured for https://api.anthropic.com" when the real next step was
  // choosing a model. The existing assertion above uses a loopback base, where
  // requireKey is a no-op and the order never showed.
  await assert.rejects(
    () => complete({ protocol: 'anthropic', baseUrl: FAKE_ORIGIN, model: '', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /No AI has been chosen yet/);
      assert.doesNotMatch(err.message, /API key/, 'a missing key is named before the missing choice that comes first');
      // Never the address. This sentence reaches the board's banner on a
      // fresh install, and "for https://api.anthropic.com" named a place the
      // person had never typed. It rides on the error for the log instead.
      assert.doesNotMatch(err.message, /api\.example\.invalid|https?:/);
      assert.equal(err.address, FAKE_ORIGIN);
      // The tab by the label it wears: the Settings strip says "AI", and the
      // scheduler's stand-down in core/sweep.mjs says the same words.
      assert.match(err.message, /Settings → AI/);
      return true;
    },
  );
  assert.equal(mock.requests.length, 0);
});

test('LLMError is a real Error carrying status, address and retriable', () => {
  const err = new LLMError('nope', { status: 503, address: 'http://x', retriable: true });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'LLMError');
  assert.equal(err.status, 503);
  assert.equal(err.address, 'http://x');
  assert.equal(err.retriable, true);
});

/* ------------------------------------------------------------------ *
 * listModels + probeLocal
 * ------------------------------------------------------------------ */

test('listModels hits GET /models on the openai protocol and dedupes', async () => {
  const models = await listModels({ protocol: 'openai', baseUrl: mock.origin, apiKey: 'sk-list' });
  const req = mock.last();
  assert.equal(req.method, 'GET');
  assert.equal(req.path, '/models');
  assert.equal(req.headers.authorization, 'Bearer sk-list');
  assert.deepEqual(models, [
    { id: 'llama3.2', label: 'llama3.2' },
    { id: 'qwen2.5', label: 'qwen2.5' },
  ]);
});

test('listModels hits GET /v1/models on the anthropic protocol with its own headers', async () => {
  const models = await listModels({
    protocol: 'anthropic',
    baseUrl: mock.origin,
    apiKey: 'sk-ant-list',
  });
  const req = mock.last();
  assert.equal(req.path, '/v1/models');
  assert.equal(req.headers['x-api-key'], 'sk-ant-list');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.query.get('limit'), '1000', 'the default page size is too small');
  assert.deepEqual(models, [
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'claude-sonnet-5' },
  ]);
});

test('listModels refuses a remote address with no key, and reports server errors', async () => {
  await assert.rejects(
    () => listModels({ protocol: 'openai', baseUrl: FAKE_ORIGIN }),
    (err) => {
      assert.match(err.message, /^No key has been saved for this AI service — open Settings → AI and paste one\./);
      assert.equal(err.address, FAKE_ORIGIN);
      return true;
    },
  );

  mock.plan.push({ status: 404, body: { error: { message: 'no such route' } } });
  await assert.rejects(
    () => listModels({ protocol: 'openai', baseUrl: mock.origin, retries: 0 }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.equal(err.status, 404);
      assert.match(err.message, /check the base URL/);
      return true;
    },
  );
});

test('REGRESSION: a 200 catalogue carrying an error body is a failure, not an empty catalogue', async () => {
  // The same blind spot as complete()'s, on the same helper, and it was left
  // behind when that one was fixed. A GET /models answering 200 with the
  // refusal in the envelope has no `data` and no `models`, so modelRows() found
  // nothing and this returned []. Settings then renders "0 models available."
  // beside an empty dropdown (ui/views/settings.js:278) — the endpoint is
  // reported as having no models when what it actually did was refuse to say,
  // and the provider's own sentence, which is the only thing that tells the
  // reader whether to top up an account or fix a key, is thrown away.
  mock.plan.push({ status: 200, body: { error: { message: '402: insufficient credits', code: 402 } } });
  await assert.rejects(
    () => listModels({ protocol: 'openai', baseUrl: mock.origin, apiKey: 'sk-list', retries: 0 }),
    (err) => {
      assert.ok(err instanceof LLMError);
      assert.match(err.message, /insufficient credits/, 'the provider detail must survive');
      assert.match(err.message, /127\.0\.0\.1/, 'the error must name the address');
      assert.equal(err.retriable, false, 'a rejected request does not get better on a retry');
      return true;
    },
  );
  assert.equal(mock.requests.length, 1, 'and it must not be retried');

  // anthropic's envelope, over the anthropic path.
  mock.plan.push({ status: 200, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
  await assert.rejects(
    () => listModels({ protocol: 'anthropic', baseUrl: mock.origin, apiKey: 'sk-ant-list', retries: 0 }),
    (err) => {
      assert.match(err.message, /invalid x-api-key/);
      return true;
    },
  );

  // The key must not come back out in the message, for the same reason it must
  // not in complete()'s: this string reaches Settings and a doctor report.
  mock.plan.push({
    status: 200,
    body: { error: { message: 'rejected: Authorization: Bearer sk-live-do-not-log' } },
  });
  await assert.rejects(
    () => listModels({ protocol: 'openai', baseUrl: mock.origin, apiKey: 'sk-live-do-not-log', retries: 0 }),
    (err) => {
      assert.equal(err.message.includes('sk-live-do-not-log'), false, 'the key came back in the catalogue error');
      return true;
    },
  );

  // And the other direction: `"error": null` is what several providers send on
  // a perfectly good catalogue, and it must not read as a failure.
  mock.plan.push({ status: 200, body: { error: null, data: [{ id: 'llama3.2' }] } });
  assert.deepEqual(
    await listModels({ protocol: 'openai', baseUrl: mock.origin, apiKey: 'sk-list', retries: 0 }),
    [{ id: 'llama3.2', label: 'llama3.2' }],
  );
});

test('probeLocal returns runtimes that answer and stays silent about ones that do not', async () => {
  const deadPort = await unusedPort();
  const found = await probeLocal({
    targets: [
      { label: 'Mock runtime', baseUrl: mock.origin },
      { label: 'Not running', baseUrl: `http://127.0.0.1:${deadPort}/v1` },
    ],
    timeoutMs: 1200,
  });

  assert.equal(found.length, 1, 'the dead port must fail silently');
  assert.equal(found[0].label, 'Mock runtime');
  assert.equal(found[0].baseUrl, mock.origin);
  assert.equal(found[0].protocol, 'openai');
  assert.deepEqual(found[0].models.map((m) => m.id), ['llama3.2', 'qwen2.5']);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].path, '/models');
});

test('probeLocal with no arguments probes the four documented ports and never throws', async () => {
  const started = Date.now();
  const found = await probeLocal();
  assert.ok(Array.isArray(found), 'probeLocal always resolves to an array');
  assert.ok(Date.now() - started < 5000, 'the probe is time-boxed');
  for (const entry of found) {
    assert.equal(entry.protocol, 'openai');
    assert.equal(isLocalAddress(entry.baseUrl), true);
  }
});
