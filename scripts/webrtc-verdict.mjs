// The verdict of scripts/check-webrtc.mjs, apart from the Electron runs that
// feed it, so a test can drive it with made-up results.
//
// One exception to "every loopback route must be heard with the lock off":
// on Windows, the control run never hears WebRTC's UDP routes (TURN over UDP,
// STUN) on 127.0.0.1, while it hears them on the LAN address. A probe on
// windows-latest (run 39526728492) showed why for a Node dgram socket: bound to
// the LAN address it got EADDRNOTAVAIL sending to 127.0.0.1, while unbound,
// 0.0.0.0- and loopback-bound sockets delivered 3/3. WebRTC appears to bind its
// UDP sockets to the LAN address the same way. That is an inference, consistent
// with the Windows LAN counts matching the macOS loopback counts (14 and 7).
// So on win32 a silent loopback turn-udp or stun is reported as untested, and
// only when the same route was heard on the LAN address in the same control
// run. That run proves the window's UDP left over that route unlocked, and the
// locked run proves it did not.
//
// What this no longer proves on Windows: that WebRTC UDP aimed at 127.0.0.1 is
// blocked. If WebRTC does send from a LAN-bound socket, that traffic cannot
// arrive there even with the lock off. macOS delivers it, so there (and
// everywhere but win32) it stays required. With no LAN address, or a silent
// one, the loopback UDP routes still fail the check.

const label = (route) => `${route.key} → ${route.host}`;
const LOOPBACK = '127.0.0.1';
const WINDOWS_UNREACHABLE_LOOPBACK = new Set(['turn-udp', 'stun']);

export function judge({ platform, control, hardened }) {
  const failures = [];
  const untested = [];

  if (!control.netlog) failures.push('control: no readable net log, so DNS cannot be checked');
  else if (!control.canaryLookedUp) failures.push('control: the canary hostname was never looked up with the lock off — the DNS check cannot see');
  const live = new Set();
  const heardOnLan = new Set(control.routes.filter((r) => r.host !== LOOPBACK && r.hits > 0).map((r) => r.key));
  for (const route of control.routes) {
    if (route.hits > 0) live.add(label(route));
    else if (route.required && platform === 'win32' && route.host === LOOPBACK
      && WINDOWS_UNREACHABLE_LOOPBACK.has(route.key) && heardOnLan.has(route.key)) {
      untested.push(`${label(route)} (Windows does not deliver to loopback from a LAN-bound socket; proven on the LAN address)`);
    } else if (route.required) failures.push(`control: nothing arrived on ${label(route)} with the lock off — that route is untested`);
    else untested.push(label(route));
  }
  if (live.size === 0) failures.push('control: no route was heard with the lock off, so no route is proven');

  if (hardened.lock !== 'ok') failures.push(`hardened: the lock refused to take: ${hardened.lock}`);
  for (const route of hardened.routes) {
    if (route.hits) failures.push(`hardened: ${label(route)} received ${route.hits} from the window`);
  }
  if (!hardened.netlog) failures.push('hardened: no readable net log, so DNS was not checked');
  else if (hardened.canaryLookedUp) failures.push('hardened: the canary hostname was looked up — data can leave through DNS');
  if (!hardened.page || hardened.page.tried === 0) failures.push('hardened: the page never ran its attempts');

  return { failures, untested, live };
}
