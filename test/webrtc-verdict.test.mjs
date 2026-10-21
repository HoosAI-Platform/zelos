/**
 * test/webrtc-verdict.test.mjs — the verdict scripts/check-webrtc.mjs reaches.
 *
 * The check itself needs a real Electron and runs only in the desktop
 * workflow. Its verdict is what decides whether a lock that stopped working
 * fails the build, so it is pinned here against made-up probe results — the
 * Windows control run (run 39367131957) among them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../scripts/webrtc-verdict.mjs';

const LAN = '10.1.0.9';
const KEYS = ['turn-tcp', 'turns', 'turn-tcp-iframe', 'turn-localhost', 'turn-udp', 'stun', 'webtransport'];

/* A probe result, every route heard unless `hits` says otherwise. */
function result({ hits = {}, lan = true, all = null } = {}) {
  const routes = [];
  for (const host of ['127.0.0.1', ...(lan ? [LAN] : [])]) {
    for (const key of KEYS) {
      if (key === 'turn-localhost' && host !== '127.0.0.1') continue;
      const given = hits[`${key} → ${host}`];
      routes.push({ key, host, required: host === '127.0.0.1', hits: given ?? all ?? 3 });
    }
  }
  return { routes, netlog: true, canaryLookedUp: all === 0 ? false : true, lock: 'ok', page: { tried: 14, errors: [] } };
}

const silentLoopbackUdp = { 'turn-udp → 127.0.0.1': 0, 'stun → 127.0.0.1': 0 };
const locked = () => result({ all: 0 });

test('on Windows, silent loopback UDP passes as untested when the LAN address heard the same routes', () => {
  /* What windows-latest does: a WebRTC UDP socket is bound to the LAN
     address, and Windows refuses to send from it to 127.0.0.1. */
  const verdict = judge({ platform: 'win32', control: result({ hits: silentLoopbackUdp }), hardened: locked() });
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.untested.length, 2);
  for (const key of ['turn-udp', 'stun']) {
    assert.ok(verdict.untested.some((line) => line.startsWith(`${key} → 127.0.0.1`) && /Windows/.test(line)), `${key} is not reported as untested on Windows`);
  }
});

test('on Windows, silent loopback UDP fails when the LAN address did not hear it either', () => {
  const both = { ...silentLoopbackUdp, [`turn-udp → ${LAN}`]: 0, [`stun → ${LAN}`]: 0 };
  for (const control of [result({ hits: both }), result({ hits: silentLoopbackUdp, lan: false })]) {
    const { failures } = judge({ platform: 'win32', control, hardened: locked() });
    assert.ok(failures.some((line) => line.includes('turn-udp → 127.0.0.1')), 'silent turn-udp passed with no LAN proof');
    assert.ok(failures.some((line) => line.includes('stun → 127.0.0.1')), 'silent stun passed with no LAN proof');
  }
});

test('off Windows, silent loopback UDP fails even when the LAN address heard it', () => {
  /* macOS delivers to loopback from a LAN-bound socket, so its loopback
     proof stays required; so does every other platform's. */
  for (const platform of ['darwin', 'linux']) {
    const { failures } = judge({ platform, control: result({ hits: silentLoopbackUdp }), hardened: locked() });
    assert.equal(failures.length, 2, `${platform}: ${failures.join('; ')}`);
    assert.ok(failures.some((line) => line.includes('turn-udp → 127.0.0.1')), `${platform}: silent turn-udp passed`);
    assert.ok(failures.some((line) => line.includes('stun → 127.0.0.1')), `${platform}: silent stun passed`);
  }
});

test('on Windows, the LAN proof must be for the same route, not just any UDP route', () => {
  /* STUN heard on the LAN proves nothing about TURN over UDP. */
  const hits = { ...silentLoopbackUdp, [`turn-udp → ${LAN}`]: 0 };
  const { failures, untested } = judge({ platform: 'win32', control: result({ hits }), hardened: locked() });
  assert.deepEqual(failures, ['control: nothing arrived on turn-udp → 127.0.0.1 with the lock off — that route is untested']);
  assert.ok(untested.some((line) => line.startsWith('stun → 127.0.0.1')), 'stun, proven on the LAN, was not reported as untested');
});

test('on Windows, only TURN over UDP and STUN are excused, whatever the LAN heard', () => {
  /* TCP and WebTransport do reach loopback on Windows (the CI logs show it),
     so a silent one there is a deaf probe, LAN or no LAN. */
  for (const key of ['turn-tcp', 'turns', 'turn-tcp-iframe', 'webtransport']) {
    const { failures } = judge({ platform: 'win32', control: result({ hits: { [`${key} → 127.0.0.1`]: 0 } }), hardened: locked() });
    assert.deepEqual(failures, [`control: nothing arrived on ${key} → 127.0.0.1 with the lock off — that route is untested`], `${key}: a silent loopback route was excused on Windows`);
  }
});

test('any packet in the locked run fails, whatever the platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const route of ['turn-udp → 127.0.0.1', `stun → ${LAN}`, 'turn-tcp → 127.0.0.1']) {
      const { failures } = judge({ platform, control: result({ hits: silentLoopbackUdp }), hardened: result({ all: 0, hits: { [route]: 1 } }) });
      assert.ok(failures.some((line) => line === `hardened: ${route} received 1 from the window`), `${platform}: a packet on ${route} in the locked run passed`);
    }
  }
});

test('a control run that heard nothing at all fails', () => {
  const { failures } = judge({ platform: 'win32', control: result({ all: 0 }), hardened: locked() });
  assert.ok(failures.some((line) => /no route/.test(line)), 'a deaf control run passed without saying no route was proven');
});

test('the lock, the net logs and the canary each fail the check on their own', () => {
  const control = () => result({ hits: silentLoopbackUdp });
  const cases = [
    ['the lock did not take', control(), { ...locked(), lock: 'resolveProxy said DIRECT' }, /^hardened: the lock refused to take: resolveProxy said DIRECT$/],
    ['no control net log', { ...control(), netlog: false }, locked(), /^control: no readable net log/],
    ['no hardened net log', control(), { ...locked(), netlog: false }, /^hardened: no readable net log/],
    ['the canary was not looked up with the lock off', { ...control(), canaryLookedUp: false }, locked(), /^control: the canary hostname was never looked up/],
    ['the canary was looked up with the lock on', control(), { ...locked(), canaryLookedUp: true }, /^hardened: the canary hostname was looked up/],
    ['the locked page never ran', control(), { ...locked(), page: { tried: 0, errors: [] } }, /^hardened: the page never ran its attempts$/],
  ];
  for (const platform of ['win32', 'darwin']) {
    for (const [name, c, h, expected] of cases) {
      const { failures } = judge({ platform, control: c, hardened: h });
      const relevant = platform === 'win32' ? failures : failures.filter((line) => !/(turn-udp|stun) → 127\.0\.0\.1/.test(line));
      assert.equal(relevant.length, 1, `${platform}, ${name}: ${failures.join('; ')}`);
      assert.match(relevant[0], expected, `${platform}, ${name}`);
    }
  }
});
