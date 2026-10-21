// Prove, against a real Electron, that the desktop app serves MCP over stdio
// the way the "Ready to paste" block in Settings starts it.
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
// the bare \r\n Electron writes at start-up on Windows (TT-3507). That is why
// the block now runs the app's binary in Node mode on core/mcp-stdio.mjs, and
// this check builds its command from the same function Settings uses
// (stdioLaunch), so it tests the block people paste rather than a copy of it.
//
// The block is run twice: spawned by this script, whose console Electron could
// attach to, and through a detached Node relay with no console, as a GUI
// client such as Claude Desktop has none. The old way in — the app started as
// Electron with `mcp`, which configs pasted before this still use — is checked
// for its answers only, and labelled legacy: it still carries Electron's \r\n.
//
// Usage:
//   node scripts/check-mcp-stdio.mjs                 the checkout, on desktop/'s Electron
//   node scripts/check-mcp-stdio.mjs --app <binary>  a packaged app: win-unpacked/Zelos.exe
//                                                    or Zelos.app/Contents/MacOS/Zelos
//   node scripts/check-mcp-stdio.mjs --packaged      this runner's app in desktop/dist
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stdioLaunch } from '../core/mcp-stdio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-mcp-stdio', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

/**
 * What to run. A packaged app is its own binary, and core/ sits in its
 * resources folder (extraResources): `resources\` beside Zelos.exe, or
 * `Contents/Resources/` in the .app. The checkout runs desktop/'s Electron with
 * this repository as the root, the way a dev shell does.
 */
function target(argv) {
  if (argv.includes('--packaged')) {
    // Where electron-builder leaves this runner's own app, as check-desktop.mjs finds it.
    const dist = path.join(ROOT, 'desktop', 'dist');
    const arm = process.arch === 'arm64';
    argv = ['--app', process.platform === 'darwin'
      ? path.join(dist, arm ? 'mac-arm64' : 'mac', 'Zelos.app', 'Contents', 'MacOS', 'Zelos')
      : path.join(dist, arm ? 'win-arm64-unpacked' : 'win-unpacked', 'Zelos.exe')];
  }
  const at = argv.indexOf('--app');
  if (at === -1) {
    const electron = createRequire(path.join(ROOT, 'desktop', 'package.json'))('electron');
    return { label: 'the checkout', execPath: electron, root: ROOT, legacyArgs: [path.join(ROOT, 'desktop'), 'mcp'] };
  }
  const execPath = path.resolve(argv[at + 1] ?? '');
  if (!fs.existsSync(execPath)) throw new Error(`--app: no such file ${execPath}`);
  const root = process.platform === 'darwin'
    ? path.resolve(path.dirname(execPath), '..', 'Resources')
    : path.join(path.dirname(execPath), 'resources');
  return { label: `the packaged app (${execPath})`, execPath, root, legacyArgs: ['mcp'] };
}

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
 * it spawns the command with pipes and passes the bytes through untouched. It
 * writes nothing to stdout of its own; its console report goes to stderr.
 */
const RELAY = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
${consoleReport.toString()}
process.stderr.write('relay console: ' + consoleReport() + '\\n');
const [command, argsJson] = process.argv.slice(1);
const child = spawn(command, JSON.parse(argsJson), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', (err) => { process.stderr.write('relay: spawn failed: ' + err.message + '\\n'); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
`;

/** One client session: spawn, send the requests, hang up once both answers are in. */
function session({ command, args, env: extraEnv = {}, relay = false }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mcp-check-'));
  const env = { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' };
  // Set by VS Code's terminal; the legacy run must not get it by accident.
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    const child = relay
      ? spawn(process.execPath, ['--input-type=module', '-e', RELAY, command, JSON.stringify(args)], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true })
      : spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

/** The two answers and a clean exit: what any client needs, strict or not. */
function answers(replies, code) {
  const failures = [];
  if (replies.length !== 2) failures.push(`expected 2 replies (initialize, tools/list), got ${replies.length}`);
  if (replies[0]?.result?.serverInfo?.name !== 'zelos') failures.push('the initialize reply did not come from the Zelos server');
  if (!Array.isArray(replies[1]?.result?.tools)) failures.push('the tools/list reply carried no tool list');
  if (code !== 0) failures.push(`it did not exit cleanly when the client hung up (exit ${code})`);
  return failures;
}

/** Strict: the first byte is `{`, no line is empty, every line is JSON-RPC. */
function judge({ code, stdout }) {
  const failures = [];
  const stray = [];
  const firstBrace = stdout.indexOf(0x7b);
  if (stdout.length && stdout[0] !== 0x7b) {
    const lead = stdout.subarray(0, firstBrace === -1 ? stdout.length : firstBrace);
    stray.push(`before the first reply: ${hex(lead)}`);
    failures.push('the first byte on stdout is not `{`');
  }
  const lines = stdout.toString('utf8').split('\n');
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
  return { failures: [...new Set([...failures, ...answers(replies, code)])], stray, replies };
}

/** Lenient, for the legacy path: blank lines are skipped, as clients do; the answers must still come. */
function lenient({ code, stdout }) {
  const replies = [];
  const failures = [];
  for (const line of stdout.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    try { replies.push(JSON.parse(line)); } catch { failures.push(`stdout carried something other than JSON-RPC: ${line.slice(0, 200)}`); }
  }
  const lead = stdout.subarray(0, Math.max(0, stdout.indexOf(0x7b)));
  return { failures: [...failures, ...answers(replies, code)], stray: lead.length ? [`before the first reply: ${hex(lead)}`] : [], replies };
}

const app = target(process.argv.slice(2));
const launch = stdioLaunch({ electron: true, execPath: app.execPath, root: app.root });
console.log(`checking ${app.label}`);
console.log(`the block runs: ${JSON.stringify({ command: launch.command, args: launch.args, env: launch.env })}`);
console.log(`this script's console: ${consoleReport()}`);

const checks = [
  ['spawned by this script', { ...launch, relay: false }, judge],
  ['spawned by a detached relay with no console', { ...launch, relay: true }, judge],
  ['legacy `mcp`, through the relay (answers only)', { command: app.execPath, args: app.legacyArgs, relay: true }, lenient],
];
let failed = false;
for (const [label, options, verdict] of checks) {
  const result = await session(options);
  const relayed = /^relay console: .*$/m.exec(result.stderr);
  if (relayed) console.log(relayed[0]);
  const { failures, stray, replies } = verdict(result);
  console.log(`${label}: ${stray.length ? `stray bytes on stdout — ${stray.join('; ')}` : 'no stray bytes on stdout'}`);
  if (failures.length) {
    failed = true;
    console.error(`Zelos mcp does not serve MCP over stdio on ${process.platform}, ${label}:\n- ${failures.join('\n- ')}\n\nstderr:\n${result.stderr.slice(-2000)}`);
  } else {
    console.log(`OK: ${replies.length} replies over stdio on ${process.platform}, ${label}, and a clean exit when the client hung up.`);
  }
}
if (failed) process.exit(1);
