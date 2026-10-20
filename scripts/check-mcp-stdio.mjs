// Prove, against the real Electron, that `Zelos mcp` serves MCP over stdio.
//
// Spawned the way a desktop AI client spawns it — stdin and stdout as pipes —
// it must answer the handshake and a tool listing, write nothing but JSON-RPC
// to stdout, and exit cleanly when the client hangs up. On Windows it once read
// Electron's empty stand-in stdin and exited before the first request, and the
// unit tests, which hand the server their own streams, could not see it
// (TT-3420).
//
// "Nothing but JSON-RPC" is meant byte for byte: the first byte is `{` and no
// line is empty. Blank lines used to be filtered out before parsing, which hid
// the bare \r\n Electron writes at start-up on Windows (TT-3507). It is run
// twice: spawned by this script, whose console Electron can attach to, and
// spawned by a small Node relay started detached, which has no console, as a
// GUI client such as Claude Desktop has none. Each run says whether stray
// bytes appeared, and which, in hex, and the log says whether this script
// and the relay really have a console, so the CI log shows where they come
// from.
//
// Usage: node scripts/check-mcp-stdio.mjs   (needs `npm ci` in desktop/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(path.join(ROOT, 'desktop', 'package.json'))('electron');
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-mcp-stdio', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

/**
 * Whether this process has a console, as far as can be told cheaply. On
 * Windows CONOUT$ opens only for a process attached to one; elsewhere a TTY is
 * the nearest thing. Its source is also run inside the relay below.
 */
function consoleReport() {
  const ttys = ['stdin', 'stdout', 'stderr'].map((n) => `${n} ${process[n].isTTY ? 'is' : 'is not'} a TTY`).join(', ');
  if (process.platform !== 'win32') return ttys;
  try {
    fs.closeSync(fs.openSync('\\\\.\\CONOUT$', 'r+'));
    return `${ttys}; CONOUT$ opens, so a console is attached`;
  } catch (err) {
    return `${ttys}; CONOUT$ does not open (${err.code}), so no console is attached`;
  }
}

/*
 * The parent with no console. Started detached (DETACHED_PROCESS on Windows),
 * it spawns Electron with pipes and passes the bytes through untouched, so
 * Electron's attempt to attach to its parent's console finds none. It writes
 * nothing to stdout of its own; its console report goes to stderr.
 */
const RELAY = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
${consoleReport.toString()}
process.stderr.write('relay console: ' + consoleReport() + '\\n');
const [electron, argsJson] = process.argv.slice(1);
const child = spawn(electron, JSON.parse(argsJson), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', (err) => { process.stderr.write('relay: spawn failed: ' + err.message + '\\n'); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
`;

/** One client session: spawn, send the requests, hang up once both answers are in. */
function session({ relay = false, args = [path.join(ROOT, 'desktop'), 'mcp'], extraEnv = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mcp-check-'));
  const env = { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' };
  // Set by VS Code's terminal, and it turns Electron into plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    const child = relay
      ? spawn(process.execPath, ['--input-type=module', '-e', RELAY, electron, JSON.stringify(args)], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true })
      : spawn(electron, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    const stdoutText = () => Buffer.concat(chunks).toString('utf8');
    child.stdout.on('data', (d) => { chunks.push(d); });
    child.stderr.on('data', (d) => { stderr += d; });
    // A child that died early makes these writes EPIPE; the result says so.
    child.stdin.on('error', () => {});
    let hangUp = null;
    let timer = null;
    const finish = (result) => {
      clearTimeout(timer);
      clearInterval(hangUp);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      resolve({ ...result, stdout: Buffer.concat(chunks), stderr: result.stderr ?? stderr });
    };
    child.on('error', (err) => finish({ code: null, stderr: `${stderr}\nspawn failed: ${err.message}` }));
    // Sent after a pause, as a client that starts the server and then talks to
    // it would: an input that ended on its own has ended by then.
    setTimeout(() => {
      for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
      // Counted on '{' lines, so a stray blank line does not count as an answer.
      hangUp = setInterval(() => {
        if (stdoutText().split('\n').filter((l) => l.startsWith('{')).length >= 2) { clearInterval(hangUp); child.stdin.end(); }
      }, 100);
    }, 2_000);
    timer = setTimeout(() => { child.kill(); }, 60_000);
    child.on('close', (code) => finish({ code }));
  });
}

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/** What is wrong with one session's output, and the stray bytes, if any. */
function judge({ code, stdout }) {
  const failures = [];
  const stray = [];
  const firstBrace = stdout.indexOf(0x7b);
  if (stdout.length && stdout[0] !== 0x7b) {
    const lead = stdout.subarray(0, firstBrace === -1 ? stdout.length : firstBrace);
    stray.push(`before the first reply: ${hex(lead)}`);
    failures.push('the first byte on stdout is not `{`');
  }
  const text = stdout.toString('utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop(); // the newline that ends the last reply
  const replies = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') {
      stray.push(`line ${i + 1}: ${hex(Buffer.from(`${line}\n`))}`);
      failures.push(`line ${i + 1} of stdout is empty`);
      return;
    }
    try { replies.push(JSON.parse(line)); } catch {
      stray.push(`line ${i + 1}: ${hex(Buffer.from(line).subarray(0, 64))}`);
      failures.push(`line ${i + 1} of stdout is not JSON-RPC: ${line.slice(0, 200)}`);
    }
  });
  if (replies.length !== 2) failures.push(`expected 2 replies (initialize, tools/list), got ${replies.length}`);
  if (replies[0]?.result?.serverInfo?.name !== 'zelos') failures.push('the initialize reply did not come from the Zelos server');
  if (!Array.isArray(replies[1]?.result?.tools)) failures.push('the tools/list reply carried no tool list');
  if (code !== 0) failures.push(`it did not exit cleanly when the client hung up (exit ${code})`);
  return { failures: [...new Set(failures)], stray, replies };
}

console.log(`this script's console: ${consoleReport()}`);
const runs = [
  ['spawned by this script', {}],
  ['spawned by a detached relay with no console', { relay: true }],
];
let failed = false;
for (const [label, options] of runs) {
  const result = await session(options);
  const relayed = /^relay console: .*$/m.exec(result.stderr);
  if (relayed) console.log(relayed[0]);
  const { failures, stray, replies } = judge(result);
  console.log(`${label}: ${stray.length ? `stray bytes on stdout — ${stray.join('; ')}` : 'no stray bytes on stdout'}`);
  if (failures.length) {
    failed = true;
    console.error(`Zelos mcp does not serve MCP over stdio on ${process.platform}, ${label}:\n- ${failures.join('\n- ')}\n\nstderr:\n${result.stderr.slice(-2000)}`);
  } else {
    console.log(`OK: Zelos mcp answered ${replies.length} requests over stdio on ${process.platform}, ${label}, and exited when the client hung up.`);
  }
}

/*
 * Round 2 of TT-3507: where the bytes come from. Measurement only. Each
 * variant runs in the no-console relay, and only its stray bytes are reported;
 * none of them changes the exit code.
 *
 *   1. ELECTRON_NO_ATTACH_CONSOLE=1 — does Electron's console handling write them?
 *   2. A bare Electron app whose main script writes `{}\n` and exits — if the
 *      bytes still come, Electron emits them before any app code runs.
 *   3. ELECTRON_RUN_AS_NODE=1 on zelos.mjs mcp — Electron as plain Node. The
 *      build sets no fuses (no electronFuses in desktop/package.json), so
 *      RunAsNode keeps Electron's default, which is on.
 *   4. Our own mcp entry with ZELOS_MCP_STDIO_MARKER=1, which makes
 *      desktop/main.js write `#` (0x23) as its first statement: `23` before
 *      `0d 0a` means the bytes come after our code starts, `0d 0a` first means
 *      before.
 */
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-bare-electron-'));
fs.writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'bare', main: 'main.cjs' }));
fs.writeFileSync(path.join(bare, 'main.cjs'), "const { app } = require('electron');\nprocess.stdout.write('{}\\n', () => app.exit(0));\n");
const variants = [
  ['1. ELECTRON_NO_ATTACH_CONSOLE=1', { extraEnv: { ELECTRON_NO_ATTACH_CONSOLE: '1' } }],
  ['2. a bare Electron app that writes {} and exits', { args: [bare] }],
  ['3. ELECTRON_RUN_AS_NODE=1 on zelos.mjs mcp', { args: [path.join(ROOT, 'zelos.mjs'), 'mcp'], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }],
  ['4. our mcp entry, marking its first statement with #', { extraEnv: { ZELOS_MCP_STDIO_MARKER: '1' } }],
];
for (const [label, options] of variants) {
  const result = await session({ relay: true, ...options });
  const { stray } = judge(result);
  const head = hex(result.stdout.subarray(0, 16));
  console.log(`variant ${label}: ${stray.length ? `stray bytes — ${stray.join('; ')}` : 'no stray bytes'} (first bytes: ${head || 'none'}; exit ${result.code})`);
  if (!result.stdout.length) console.log(`  stderr: ${result.stderr.slice(-500)}`);
}
fs.rmSync(bare, { recursive: true, force: true });

if (failed) process.exit(1);
