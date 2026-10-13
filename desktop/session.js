/**
 * desktop/session.js — what the board's window may put on the network: the
 * board, and nothing else.
 *
 * Four layers, each measured against the pinned Electron rather than assumed:
 *
 *   1. Requests. Every request the window makes that is not the board is
 *      cancelled in `onBeforeRequest`, on every scheme (`<all_urls>`, which
 *      unlike `*://*\/*` includes ws: and wss:).
 *   2. A proxy that goes nowhere. The session's proxy is a listener this
 *      process owns, which accepts a connection and drops it; only the board's
 *      own 127.0.0.1:<port> bypasses it. WebRTC under `disable_non_proxied_udp`
 *      may only use the network through a proxy, so its TCP path — TURN over
 *      TCP or TLS, to any host, loopback included — ends here. So does
 *      WebTransport, which is not a request either and reached the network
 *      past layer 1. Owned rather than a "dead" port because whatever listens
 *      on a proxy port receives everything sent through it.
 *   3. No UDP. `disable_non_proxied_udp` on every webContents (main.js) leaves
 *      WebRTC no UDP, and the proxy above none of anything else.
 *   4. No DNS. RESOLVER_RULES, applied on the command line before the app is
 *      ready, maps every hostname to NOTFOUND: a TURN server's hostname, or a
 *      `<link rel=dns-prefetch>`, was a real lookup — data out through DNS —
 *      under every other layer. The board is an IP literal and never resolves.
 *
 * What this replaced: a `webrtc 'block'` CSP directive appended to the board's
 * responses. Chromium in Electron 43 does not implement it ("Unrecognized
 * Content-Security-Policy directive 'webrtc'") and never did, so TURN over TCP
 * reached any host it was given (QA, 2026-10-10, TT-3418). It comes back only
 * with scripts/check-webrtc.mjs showing that it works.
 *
 * The main process's own networking — the updater, the core — is Node's, not
 * this session's, and none of this touches it.
 */

import net from 'node:net';

import { classifyTarget } from './guard.js';

/** The one permission the board needs: the Owed view copies drafts. */
export const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/** Every hostname is NOTFOUND to Chromium; 127.0.0.1 is kept for the board. */
export const RESOLVER_RULES = 'MAP * ~NOTFOUND , EXCLUDE 127.0.0.1';

/**
 * The proxy the session is pointed at: a loopback listener that drops every
 * connection. Its port is the OS's choice and held for the life of the app, so
 * nothing else can be listening there.
 */
export function startProxySink({ logger = null } = {}) {
  const server = net.createServer((socket) => {
    logger?.warn('desktop: refused a connection the window tried to make past the board');
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      // The app's lifetime is the sink's; it must not keep a quitting process up.
      server.unref();
      resolve({ port: server.address().port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/**
 * Lock `ses` down to the board at `getPort()`. Resolves once the proxy is in
 * place AND has been read back as intended; rejects otherwise, and the shell
 * then opens no window. A malformed rule, or a `direct://` slipped into one,
 * fails open in Chromium without a word — so it is checked, not trusted.
 *
 * `getPort` is read at event time: after shutdown there is no port, and no port
 * means nothing counts as internal.
 */
export async function hardenSession(ses, { getPort, proxyPort, logger = null }) {
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    const granted = ALLOWED_PERMISSIONS.has(permission);
    if (!granted) logger?.warn('desktop: denied a permission request', { permission });
    callback(granted);
  });
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const verdict = classifyTarget(details.url, { port: getPort() });
    if (verdict.action !== 'internal') {
      logger?.warn('desktop: cancelled an outbound request from the board', { url: verdict.url });
    }
    callback({ cancel: verdict.action !== 'internal' });
  });

  /* `<-loopback>` takes away Chromium's implicit "never proxy loopback", which
     otherwise let TURN to 127.0.0.1 and [::1] straight through; the board's own
     address is then the one exception. `localhost` and [::1] go to the sink as
     well, and with RESOLVER_RULES localhost does not resolve at all — the board
     must stay at 127.0.0.1 (core/server.mjs HOST). TURN aimed at the board's
     own port reaches the core's HTTP parser, which is a place the page could
     already talk to. */
  const boardPort = getPort();
  await ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: `http://127.0.0.1:${proxyPort}`,
    proxyBypassRules: `<-loopback>,127.0.0.1:${boardPort}`,
  });
  await verifyProxy(ses, { boardPort, proxyPort });
}

/** Read the proxy back for three addresses; throw unless each is as intended. */
export async function verifyProxy(ses, { boardPort, proxyPort }) {
  const sink = `PROXY 127.0.0.1:${proxyPort}`;
  const expected = [
    ['https://example.invalid/', sink],
    [`http://127.0.0.1:${boardPort === 1 ? 2 : boardPort - 1}/`, sink],
    [`http://127.0.0.1:${boardPort}/`, 'DIRECT'],
  ];
  for (const [url, want] of expected) {
    const got = String(await ses.resolveProxy(url)).trim();
    if (got !== want) {
      throw new Error(`the window's network lock did not take: ${url} resolves to "${got || '(nothing)'}", not "${want}"`);
    }
  }
}
