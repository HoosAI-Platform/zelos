/**
 * scripts/webrtc-probe/main.mjs — an Electron app that tries to get out.
 *
 * Run by scripts/check-webrtc.mjs, never on its own. It serves a page from
 * 127.0.0.1 the way the core serves the board, locks its session with the real
 * desktop/session.js (unless PROBE_MODE=control), and has the page try every
 * route off the machine the shell is meant to close: TURN over TCP, TLS and UDP,
 * STUN, WebTransport, a TURN hostname and a dns-prefetch — from the top frame
 * and from an iframe. Listeners on loopback (and on a LAN address, when the
 * runner has one) count what arrives. It prints one JSON line and exits.
 */

import { app, BrowserWindow, session } from 'electron';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARDENED = process.env.PROBE_MODE !== 'control';
const CANARY = process.env.PROBE_CANARY;
const LAN = process.env.PROBE_LAN || '';
const { hardenSession, RESOLVER_RULES, startProxySink } = await import(new URL('../../desktop/session.js', import.meta.url));

if (HARDENED) app.commandLine.appendSwitch('host-resolver-rules', RESOLVER_RULES);

/** A TCP and a UDP listener on one address and port, counting what arrives. */
async function listenOn(host) {
  const hits = { tcp: 0, udp: 0 };
  const tcp = net.createServer((socket) => { hits.tcp += 1; socket.destroy(); });
  await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, host, resolve); });
  const port = tcp.address().port;
  const udp = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
  udp.on('message', () => { hits.udp += 1; });
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(port, host, resolve); });
  return { host, port, hits, close: () => { tcp.close(); udp.close(); } };
}

async function maybeListen(host) {
  try { return await listenOn(host); } catch { return null; }
}

const page = http.createServer((req, res) => {
  const file = { '/': 'page.html', '/frame.html': 'frame.html', '/probe.js': 'probe.js' }[req.url.split('?')[0]];
  if (!file) { res.writeHead(404); res.end(); return; }
  const type = file.endsWith('.js') ? 'text/javascript' : 'text/html';
  res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "default-src 'self'" });
  res.end(fs.readFileSync(path.join(HERE, file)));
});

app.whenReady().then(async () => {
  const targets = (await Promise.all(['127.0.0.1', '::1', ...(LAN ? [LAN] : [])].map(maybeListen))).filter(Boolean);
  await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
  const boardPort = page.address().port;
  const out = { mode: HARDENED ? 'hardened' : 'control', targets: [], lock: null, page: null };

  let sink = null;
  if (HARDENED) {
    try {
      sink = await startProxySink();
      await hardenSession(session.defaultSession, { getPort: () => boardPort, proxyPort: sink.port });
      out.lock = 'ok';
    } catch (err) {
      out.lock = err.message;
    }
  }
  app.on('web-contents-created', (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy(HARDENED ? 'disable_non_proxied_udp' : 'default');
  });

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const spec = {
    targets: targets.map((t) => ({ host: t.host.includes(':') ? `[${t.host}]` : t.host, port: t.port })),
    canary: CANARY,
    hostnames: ['localhost'],
  };
  await win.loadURL(`http://127.0.0.1:${boardPort}/?spec=${encodeURIComponent(JSON.stringify(spec))}`);

  // Done when the page says so, or at the ceiling. The control run stops as
  // soon as anything arrives: it only has to prove the listeners can hear.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const done = await win.webContents.executeJavaScript('window.__probeDone === true').catch(() => false);
    const heard = targets.some((t) => t.hits.tcp + t.hits.udp > 0);
    if (done || (!HARDENED && heard)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // late packets
  out.page = await win.webContents.executeJavaScript('JSON.stringify(window.__probe || null)').then(JSON.parse).catch(() => null);
  out.targets = targets.map((t) => ({ host: t.host, tcp: t.hits.tcp, udp: t.hits.udp }));
  for (const t of targets) t.close();
  await sink?.close();
  process.stdout.write(`${JSON.stringify(out)}\n`);
  app.exit(0);
});
