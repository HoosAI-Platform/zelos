/**
 * test/mcp-stdio.test.mjs — core/mcp-stdio.mjs, the stdio MCP server the
 * desktop app's "Ready to paste" block starts in Node mode (TT-3507).
 *
 * Spawned the way a client spawns it, with real pipes: stdout must be
 * JSON-RPC from its first byte, with no empty line, and every word for a
 * person goes to stderr. Each subprocess gets its own home and the
 * encrypted-file secrets backend, never the real keychain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'core', 'mcp-stdio.mjs');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mcp-stdio-'));
process.env.ZELOS_HOME = path.join(SCRATCH, 'default-home');
process.env.ZELOS_SECRETS_BACKEND = 'encrypted-file';
process.env.ZELOS_LOG_LEVEL = 'silent';
test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

let homes = 0;
const freshHome = () => path.join(SCRATCH, `home-${homes += 1}`);

const REQUESTS = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

/** Run the entry as a client would, send `requests`, close stdin, collect everything. */
function client(args, { requests = REQUESTS, nodeArgs = [], env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, ENTRY, ...args], {
      env: { ...process.env, ZELOS_LOG_LEVEL: 'info', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    let stderr = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no exit:\n${stderr}`)); }, 30_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr }); });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    child.stdin.end();
  });
}

test('it answers a client on stdout with JSON-RPC from the first byte, and leaves when stdin closes', async () => {
  const home = freshHome();
  const { code, stdout, stderr } = await client(['--home', home]);
  assert.equal(code, 0, stderr);
  assert.equal(stdout[0], 0x7b, `the first byte on stdout is 0x${stdout[0]?.toString(16)}, not {`);
  const lines = stdout.toString('utf8').split('\n');
  assert.equal(lines.pop(), '', 'the last reply is not ended by a newline');
  assert.ok(lines.every((l) => l.trim() !== ''), 'an empty line on stdout');
  const replies = lines.map((l) => JSON.parse(l));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].result.serverInfo.name, 'zelos');
  assert.deepEqual(replies[1].result.tools, [], 'a fresh home has AI access off, so nothing is exposed');
  // The home is the one --home named, and the person hears why there are no tools.
  assert.ok(fs.existsSync(home), 'the server did not use the home it was given');
  assert.match(stderr, /AI access is switched off/);
});

test('a home in the middle of a restore is refused on stderr, with nothing on stdout', async () => {
  const home = freshHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.restore-journal.json'), '{}');
  const { code, stdout, stderr } = await client([`--home=${home}`]);
  assert.equal(code, 1);
  assert.equal(stdout.length, 0, 'the refusal reached the JSON-RPC stream');
  assert.match(stderr, /zelos mcp: An interrupted restore needs recovery/);
  assert.doesNotMatch(stderr, /\n\s+at /, 'a stack trace instead of the sentence');
});

test('a runtime without FTS5 gets the one sentence on stderr, and no home is made', async () => {
  const home = freshHome();
  const noFts5 = 'data:text/javascript,' + encodeURIComponent(
    "import { DatabaseSync } from 'node:sqlite';"
    + 'const exec = DatabaseSync.prototype.exec;'
    + "DatabaseSync.prototype.exec = function (sql) { if (/using\\s+fts5/i.test(String(sql))) throw new Error('no such module: fts5'); return exec.call(this, sql); };",
  );
  const { code, stdout, stderr } = await client(['--home', home], { nodeArgs: [`--import=${noFts5}`] });
  assert.equal(code, 1);
  assert.equal(stdout.length, 0);
  assert.match(stderr, /built without SQLite's FTS5 extension/);
  assert.equal(fs.existsSync(home), false, 'the home was made before the refusal');
});

test('an argument it does not know is refused, not ignored', async () => {
  const { code, stdout, stderr } = await client(['--port', '7777'], { requests: [] });
  assert.equal(code, 2);
  assert.equal(stdout.length, 0);
  assert.match(stderr, /zelos mcp: unknown argument --port/);
});

test('Node mode is not handed on to anything the server starts', async () => {
  // The keychain and DPAPI helpers are child processes; ELECTRON_RUN_AS_NODE
  // in their environment would be a surprise to anything Electron-based.
  const { runMcpStdio } = await import('../core/mcp-stdio.mjs');
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const input = new PassThrough();
  const output = new PassThrough();
  const running = runMcpStdio(['--home', freshHome()], { input, output });
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
  input.end();
  assert.equal(await running, 0);
});

test('the entry imports nothing from Electron or the shell, only node: and core/', () => {
  // It runs in Node mode, where `electron` is not a module, and it ships in
  // core/ beside the app, where desktop/ is not.
  const src = fs.readFileSync(ENTRY, 'utf8');
  const specifiers = [...src.matchAll(/\bimport\s*(?:[^'"()]*?from\s*)?\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const spec of specifiers) {
    assert.ok(spec.startsWith('node:') || /^\.\/[\w-]+\.mjs$/.test(spec), `core/mcp-stdio.mjs imports ${spec}`);
  }
});
