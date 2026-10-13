// Prove, against the real Electron, that `Zelos mcp` serves MCP over stdio.
//
// Spawned the way a desktop AI client spawns it — stdin and stdout as pipes —
// it must answer the handshake and a tool listing, write nothing but JSON-RPC
// to stdout, and exit cleanly when the client hangs up. On Windows it once read
// Electron's empty stand-in stdin and exited before the first request, and the
// unit tests, which hand the server their own streams, could not see it
// (TT-3420).
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-mcp-check-'));
const env = { ...process.env, ZELOS_HOME: home, ZELOS_SECRETS_BACKEND: 'encrypted-file' };
// Set by VS Code's terminal, and it turns Electron into plain Node.
delete env.ELECTRON_RUN_AS_NODE;

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-mcp-stdio', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

const result = await new Promise((resolve) => {
  const child = spawn(electron, [path.join(ROOT, 'desktop'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (err) => resolve({ code: null, stdout, stderr: `${stderr}\nspawn failed: ${err.message}` }));
  // Sent after a pause, as a client that starts the server and then talks to
  // it would: an input that ended on its own has ended by then.
  setTimeout(() => {
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    // Hang up once both answers are in, as a client closing does.
    const hangUp = setInterval(() => {
      if (stdout.split('\n').filter((l) => l.trim()).length >= 2) { clearInterval(hangUp); child.stdin.end(); }
    }, 100);
  }, 2_000);
  const timer = setTimeout(() => { child.kill(); }, 60_000);
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

const failures = [];
const lines = result.stdout.split('\n').filter((l) => l.trim());
let replies = [];
try { replies = lines.map((l) => JSON.parse(l)); } catch { failures.push(`stdout carried something other than JSON-RPC:\n${result.stdout.slice(0, 500)}`); }
if (replies.length !== 2) failures.push(`expected 2 replies (initialize, tools/list), got ${replies.length}`);
if (replies[0]?.result?.serverInfo?.name !== 'zelos') failures.push('the initialize reply did not come from the Zelos server');
if (!Array.isArray(replies[1]?.result?.tools)) failures.push('the tools/list reply carried no tool list');
if (result.code !== 0) failures.push(`it did not exit cleanly when the client hung up (exit ${result.code})`);

if (failures.length) {
  console.error(`Zelos mcp does not serve MCP over stdio on ${process.platform}:\n- ${failures.join('\n- ')}\n\nstderr:\n${result.stderr.slice(-2000)}`);
  process.exit(1);
}
console.log(`OK: Zelos mcp answered ${replies.length} requests over stdio on ${process.platform} and exited when the client hung up.`);
