/**
 * scripts/webrtc-probe/main.mjs — an Electron app that tries to get out.
 *
 * Run by scripts/check-webrtc.mjs, never on its own. It serves a page from
 * 127.0.0.1 the way the core serves the board, locks its session with the real
 * desktop/session.js (unless PROBE_MODE=control), and has the page try every
 * route off the machine the shell is meant to close: TURN over TCP, TLS and UDP,
 * STUN, WebTransport, a TURN hostname and a dns-prefetch — from the top frame
 * and from an iframe, each route against a listener of its own on loopback
 * (and on a LAN address, when the runner has one). It prints one JSON line and
 * exits.
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

/*
 * Every route, each with a listener of its own, so a control run can show
 * that EACH one is live — a route the probe cannot hear even unlocked proves
 * nothing when it is silent locked. `required` routes must be heard in the
 * control run; the rest (a LAN address that may be a link-local stand-in on a
 * CI runner) are reported as untested when they are not.
 */
const ROUTES = [
  { key: 'turn-tcp', proto: 'tcp' },
  { key: 'turns', proto: 'tcp' },
  { key: 'turn-tcp-iframe', proto: 'tcp' },
  { key: 'turn-localhost', proto: 'tcp', loopbackOnly: true },
  { key: 'turn-udp', proto: 'udp' },
  { key: 'stun', proto: 'udp' },
  { key: 'webtransport', proto: 'udp' },
];

async function listen(host, proto) {
  const counter = { hits: 0 };
  if (proto === 'tcp') {
    const server = net.createServer((socket) => { counter.hits += 1; socket.destroy(); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
    return { port: server.address().port, counter, close: () => server.close() };
  }
  const socket = dgram.createSocket('udp4');
  socket.on('message', () => { counter.hits += 1; });
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, host, resolve); });
  return { port: socket.address().port, counter, close: () => socket.close() };
}

// No CSP on the probe page: the threat is a page that has already got past
// the board's, and `connect-src 'self'` would otherwise block WebTransport in
// both runs, leaving that route untested.
const page = http.createServer((req, res) => {
  const file = { '/': 'page.html', '/frame.html': 'frame.html', '/probe.js': 'probe.js' }[req.url.split('?')[0]];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(path.join(HERE, file)));
});

app.whenReady().then(async () => {
  const routes = [];
  for (const host of ['127.0.0.1', ...(LAN ? [LAN] : [])]) {
    for (const route of ROUTES) {
      if (route.loopbackOnly && host !== '127.0.0.1') continue;
      routes.push({ ...route, host, required: host === '127.0.0.1', ...(await listen(host, route.proto)) });
    }
  }
  await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
  const boardPort = page.address().port;
  const out = { mode: HARDENED ? 'hardened' : 'control', routes: [], lock: null, page: null };

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
  const spec = { canary: CANARY, routes: routes.map(({ key, host, port }) => ({ key, host, port })) };
  await win.loadURL(`http://127.0.0.1:${boardPort}/?spec=${encodeURIComponent(JSON.stringify(spec))}`);

  // Done when the page says every attempt has finished gathering, or at the
  // ceiling. Both runs go to the end: the control run has to hear every route.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript('window.__probeDone === true').catch(() => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // late packets
  out.page = await win.webContents.executeJavaScript('JSON.stringify(window.__probe || null)').then(JSON.parse).catch(() => null);
  out.routes = routes.map(({ key, host, required, counter }) => ({ key, host, required, hits: counter.hits }));
  for (const route of routes) route.close();
  await sink?.close();
  process.stdout.write(`${JSON.stringify(out)}\n`);
  app.exit(0);
});
