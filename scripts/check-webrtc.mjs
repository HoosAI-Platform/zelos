// Prove, against the real Electron, that the board's window cannot get out.
//
// The shell once relied on a `webrtc 'block'` CSP directive that Chromium in
// Electron 43 does not implement, and TURN over TCP reached any host for as long
// as it shipped (TT-3418). A comment said it worked; nothing checked. This runs
// scripts/webrtc-probe — the real desktop/session.js lock — twice:
//
//   control   no lock. EVERY loopback route (TURN over TCP, TLS and UDP, from
//             the top frame and an iframe and by hostname, STUN, WebTransport)
//             must be heard, and the canary hostname must be looked up. A route
//             that is silent unlocked proves nothing when it is silent locked,
//             so a deaf probe — a firewall, a missing feature — fails too.
//   hardened  the lock. NOTHING may arrive on any route, the canary must never
//             be looked up, and the lock's own read-back must pass.
//
// Routes to a LAN address are tried when the runner has one; on a CI runner it
// may be a link-local stand-in nothing routes to, so one the control run cannot
// hear is reported as untested rather than failed.
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
const canary = `zelos-canary-${crypto.randomBytes(6).toString('hex')}.example.com`;
const lan = Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '';

/*
 * The hostnames Chromium tried to resolve, from its net log, or null with no
 * readable log. Only host-resolver and DNS events count: the canary is also in
 * the page's own URL, and in the CONNECT a TURN attempt sends to the shell's
 * proxy — which drops it, unresolved. A log cut short by the exit is closed
 * off and read anyway.
 */
function dnsLookupsIn(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').trim();
  let log = null;
  for (const candidate of [text, `${text.replace(/,\s*$/, '')}]}`]) {
    try { log = JSON.parse(candidate); break; } catch { /* try the closed-off form */ }
  }
  if (!log?.constants?.logEventTypes || !Array.isArray(log.events)) return null;
  const names = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  return log.events
    .filter((event) => /HOST_RESOLVER|DNS/.test(names[event.type] ?? ''))
    .map((event) => JSON.stringify(event.params ?? {}));
}

function run(mode, scratch) {
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
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('{'));
      if (!line) { reject(new Error(`the ${mode} probe printed no result\n${stderr.slice(-2000)}`)); return; }
      try {
        const result = JSON.parse(line);
        const lookups = dnsLookupsIn(netlog);
        result.netlog = lookups !== null;
        result.canaryLookedUp = (lookups ?? []).some((params) => params.includes(canary));
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

const label = (route) => `${route.key} → ${route.host}`;

async function check(scratch) {
  const failures = [];
  const untested = [];

  const control = await run('control', scratch);
  if (!control.netlog) failures.push('control: no readable net log, so DNS cannot be checked');
  else if (!control.canaryLookedUp) failures.push('control: the canary hostname was never looked up with the lock off — the DNS check cannot see');
  const live = new Set();
  for (const route of control.routes) {
    if (route.hits > 0) live.add(label(route));
    else if (route.required) failures.push(`control: nothing arrived on ${label(route)} with the lock off — that route is untested`);
    else untested.push(label(route));
  }
  console.log(`control:  ${control.routes.map((r) => `${label(r)} ${r.hits}`).join(', ')}; canary looked up: ${control.canaryLookedUp}`);

  const hardened = await run('hardened', scratch);
  console.log(`hardened: ${hardened.routes.map((r) => `${label(r)} ${r.hits}`).join(', ')}; canary looked up: ${hardened.canaryLookedUp}; lock: ${hardened.lock}`);
  if (hardened.lock !== 'ok') failures.push(`hardened: the lock refused to take: ${hardened.lock}`);
  for (const route of hardened.routes) {
    if (route.hits) failures.push(`hardened: ${label(route)} received ${route.hits} from the window`);
  }
  if (!hardened.netlog) failures.push('hardened: no readable net log, so DNS was not checked');
  else if (hardened.canaryLookedUp) failures.push('hardened: the canary hostname was looked up — data can leave through DNS');
  if (!hardened.page || hardened.page.tried === 0) failures.push('hardened: the page never ran its attempts');

  if (untested.length) console.log(`\nUntested on this machine (silent even with the lock off): ${untested.join(', ')}`);
  if (failures.length) {
    console.error(`\nThe board's window can reach the network, or the check cannot tell:\n- ${failures.join('\n- ')}`);
    return false;
  }
  console.log(`\nOK: ${live.size} live routes, ${hardened.page.tried} attempts; nothing left the window.`);
  return true;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-webrtc-check-'));
let ok = false;
try {
  ok = await check(scratch);
} catch (err) {
  console.error(`\nThe check could not run: ${err.stack || err.message}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
