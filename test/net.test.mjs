/**
 * test/net.test.mjs — the loopback test and the cleartext rule in core/net.mjs.
 *
 * QA, 2026-10-10, TT-3425: a CalDAV account or a protected .ics link typed as
 * `http://` sent the calendar password as `Authorization: Basic` — readable —
 * on every sweep. Mail had a rule for this (`requireTls`); calendars had none.
 * `assertCleartextAllowed` is that rule, shared, and this file pins every cell
 * of it so a later edit cannot quietly flip one. The readers that call it are
 * tested where they live (caldav, connectors, server, doctor, sweep).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertCleartextAllowed, cleartextRefusal, isLoopbackHost, tlsRequiredByDefault } from '../core/net.mjs';
import * as imap from '../core/sources/imap.mjs';

test('imap.mjs still exports the loopback test, and it is the same function', () => {
  // core/server.mjs and test/imap.test.mjs import both from imap.mjs; moving
  // them must not have left two copies that can drift apart.
  assert.equal(imap.isLoopbackHost, isLoopbackHost);
  assert.equal(imap.tlsRequiredByDefault, tlsRequiredByDefault);
});

test('loopback is recognised through URL.hostname, in the spellings a URL produces', () => {
  // What a caller actually hands over is `new URL(...).hostname`, which
  // normalises some spellings and keeps the brackets on IPv6 — so this is
  // tested through the URL parser rather than on hand-written strings.
  for (const href of [
    'http://localhost:5232/',
    'http://LOCALHOST/',
    'http://cal.localhost/',
    'http://127.0.0.1:5232/',
    'http://127.0.0.2/',
    'http://[::1]:5232/',
    'http://2130706433/', // decimal 127.0.0.1, which WHATWG URL normalises
    'http://0x7f000001/',
  ]) {
    const { hostname } = new URL(href);
    assert.equal(isLoopbackHost(hostname), true, `${href} → ${hostname}`);
    assert.equal(tlsRequiredByDefault(hostname), false, href);
  }
  for (const href of [
    'http://cal.example.test/',
    'http://192.168.1.20/',
    'http://10.0.0.1/',
    'http://128.0.0.1/',
    'http://localhost.example.test/',
    'http://[::2]/',
    // The URL parser rewrites an IPv4-mapped address to hex (`[::ffff:7f00:1]`),
    // a spelling the loopback test does not know. That errs on the safe side —
    // the password is refused, never sent — and is pinned so a change to it is
    // a decision rather than an accident.
    'http://[::ffff:127.0.0.1]/',
  ]) {
    const { hostname } = new URL(href);
    assert.equal(isLoopbackHost(hostname), false, `${href} → ${hostname}`);
    assert.equal(tlsRequiredByDefault(hostname), true, href);
  }
});

/**
 * The whole matrix: username or not, http or https, loopback or remote, and
 * the three stored values. Refused in exactly one shape — a username, on
 * http, where encryption is required — and nowhere else.
 */
test('assertCleartextAllowed refuses only a username on http:// where encryption is required', () => {
  const hosts = { loopback: '127.0.0.1:5232', remote: 'cal.example.test' };
  for (const user of ['', 'nemo']) {
    for (const scheme of ['http', 'https']) {
      for (const [where, host] of Object.entries(hosts)) {
        for (const requireTls of [null, undefined, true, false]) {
          const url = `${scheme}://${host}/dav/`;
          const required = requireTls === null || requireTls === undefined ? where === 'remote' : requireTls;
          const refused = Boolean(user) && scheme === 'http' && required;
          const label = JSON.stringify({ user, url, requireTls });
          if (refused) {
            assert.throws(() => assertCleartextAllowed(url, { user, requireTls }), (err) => {
              assert.equal(err.cleartextRefused, true, label);
              assert.equal(err.host, host, label);
              assert.equal(err.message, cleartextRefusal(host), label);
              return true;
            }, label);
          } else {
            assert.doesNotThrow(() => assertCleartextAllowed(url, { user, requireTls }), label);
          }
        }
      }
    }
  }
});

test('a URL object is read the same as its string, and only a real false excuses a host', () => {
  assert.throws(() => assertCleartextAllowed(new URL('http://cal.example.test/'), { user: 'nemo' }), { cleartextRefused: true });
  // A value that slipped past validation lands on the safe side, never on
  // permission — the IMAP client reads `requireTls` the same way.
  for (const junk of [0, '', 'false', 'no']) {
    assert.throws(() => assertCleartextAllowed('http://cal.example.test/', { user: 'nemo', requireTls: junk }),
      { cleartextRefused: true }, JSON.stringify(junk));
  }
});

test('the refusal names the host and the setting that fixes it, in the words on screen', () => {
  assert.equal(
    cleartextRefusal('cal.example.test'),
    'Zelos stopped before your calendar password left this machine: cal.example.test is a plain http:// address. '
      + 'Use its https:// address — or, if this server is on your own network and has no https, set '
      + '“Sending the password” to “Let this one server take it unencrypted” for this calendar.',
  );
});
