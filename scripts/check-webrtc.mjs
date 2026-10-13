// Prove, against the real Electron, that the board's window cannot get out.
//
// The shell once relied on a `webrtc 'block'` CSP directive that Chromium in
// Electron 43 does not implement, and TURN over TCP reached any host for as long
// as it shipped (TT-3418). A comment said it worked; nothing checked. This runs
// scripts/webrtc-probe — the real desktop/session.js lock — twice:
//
//   control   no lock. Something MUST arrive, and the canary hostname MUST be
//             looked up. If not, the probe is deaf (a firewall, a missing
//             interface) and a pass below would mean nothing, so that fails too.
//   hardened  the lock. NOTHING may arrive at any listener, the canary must
//             never be looked up, and the lock's own read-back must pass.
//
// Usage: node scripts/check-webrtc.mjs   (needs `npm ci` in desktop/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(path.join(ROOT, 'desktop', 'package.json'))('electron');
const probeDir = path.join(ROOT, 'scripts', 'webrtc-probe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-webrtc-check-'));
const canary = `zelos-canary-${crypto.randomBytes(6).toString('hex')}.example.com`;

// A non-loopback address makes the check closer to a real attacker's, but is
// not needed to catch a regression: the broken lock reached loopback too.
const lan = Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '';

function run(mode) {
  const netlog = path.join(scratch, `${mode}.netlog.json`);
  const env = { ...process.env, PROBE_MODE: mode, PROBE_CANARY: canary, PROBE_LAN: lan };
  // Set by VS Code's terminal, and it turns Electron into plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [probeDir, `--log-net-log=${netlog}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('{'));
      if (!line) { reject(new Error(`the ${mode} probe printed no result\n${stderr.slice(-2000)}`)); return; }
      const result = JSON.parse(line);
      const lookups = dnsLookupsIn(netlog);
      result.netlog = lookups !== null;
      result.canaryLookedUp = (lookups ?? []).some((host) => host.includes(canary));
      resolve(result);
    });
  });
}

/*
 * The hostnames Chromium tried to resolve, from its net log, or null with no
 * log. Only host-resolver and DNS events count: the canary is also in the
 * page's own URL, and in the CONNECT a TURN attempt sends to the shell's proxy
 * — which drops it, unresolved.
 */
function dnsLookupsIn(file) {
  if (!fs.existsSync(file)) return null;
  let log;
  try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const names = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  return log.events
    .filter((event) => /HOST_RESOLVER|DNS/.test(names[event.type] ?? ''))
    .map((event) => JSON.stringify(event.params ?? {}));
}

const total = (result) => result.targets.reduce((n, t) => n + t.tcp + t.udp, 0);
const failures = [];

const control = await run('control');
console.log(`control:  ${JSON.stringify(control.targets)} canary looked up: ${control.canaryLookedUp}`);
if (total(control) === 0) failures.push('control: nothing arrived at any listener with the lock off — the probe cannot hear, so a pass would mean nothing');
if (!control.netlog) failures.push('control: Electron wrote no net log, so DNS cannot be checked');
else if (!control.canaryLookedUp) failures.push('control: the canary hostname was never looked up with the lock off — the DNS check cannot see');

const hardened = await run('hardened');
console.log(`hardened: ${JSON.stringify(hardened.targets)} canary looked up: ${hardened.canaryLookedUp} lock: ${hardened.lock}`);
if (hardened.lock !== 'ok') failures.push(`hardened: the lock refused to take: ${hardened.lock}`);
for (const t of hardened.targets) {
  if (t.tcp || t.udp) failures.push(`hardened: ${t.host} received ${t.tcp} TCP and ${t.udp} UDP from the window`);
}
if (hardened.canaryLookedUp) failures.push('hardened: the canary hostname was looked up — data can leave through DNS');
if (!hardened.page || hardened.page.tried === 0) failures.push('hardened: the page never ran its attempts');

fs.rmSync(scratch, { recursive: true, force: true });
if (failures.length) {
  console.error(`\nThe board's window can reach the network:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nOK: ${hardened.page.tried} attempts on ${hardened.targets.length} address(es); nothing left the window.`);
