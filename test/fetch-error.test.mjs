import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

const { fetchFailureReason } = await import('../core/fetch-error.mjs');
const { createHttp } = await import('../core/connectors/http.mjs');
const { fetchIcsText } = await import('../core/connectors/ics.mjs');
const { discover } = await import('../core/sources/caldav.mjs');

/* QA, 2026-10-10 (TT-3514): a refused certificate or connection read only
   "fetch failed" — CalDAV with a host, a feed without even that — so a
   certificate problem could not be told from a dead server. */

/** The shape undici throws: a TypeError "fetch failed" with the reason on `cause`. */
const undici = (code, message) => new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });

test('the reason behind "fetch failed" is said, in words a person can act on', () => {
  assert.match(fetchFailureReason(undici('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5232')), /connection refused/);
  assert.match(fetchFailureReason(undici('ENOTFOUND', 'getaddrinfo ENOTFOUND cal.example.test')), /does not resolve/);
  assert.match(fetchFailureReason(undici('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate')), /self-signed/);
  assert.match(fetchFailureReason(undici('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames")), /different name/);
  assert.match(fetchFailureReason(undici('CERT_HAS_EXPIRED', 'certificate has expired')), /expired/);
  // An unknown code keeps its own words; a nested cause is followed.
  assert.equal(fetchFailureReason(undici('EWHATEVER', 'something odd')), 'EWHATEVER: something odd');
  const nested = new TypeError('fetch failed', { cause: new Error('outer', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }) });
  assert.match(fetchFailureReason(nested), /connection was reset/);
  // https:// on a port that speaks http — the classic local CalDAV case.
  assert.match(fetchFailureReason(undici('ERR_SSL_WRONG_VERSION_NUMBER', 'x')), /does not speak https on that port/);
  // OpenSSL's several lines and its source path are cut to the first line.
  const noisy = undici('ERR_SSL_SOMETHING_NEW', '0A00010B:SSL routines:odd\n../deps/openssl/ssl/x.c:78:\n');
  assert.equal(fetchFailureReason(noisy), 'ERR_SSL_SOMETHING_NEW: 0A00010B:SSL routines:odd');
  // OpenSSL can put its source path on the first line too.
  assert.equal(fetchFailureReason(undici('ERR_SSL_ODD', 'routines:wrong thing:../deps/openssl/ssl/record/x.c:78:')), 'ERR_SSL_ODD: routines:wrong thing');
  // A code with no cause (as some sockets throw) is still mapped.
  assert.match(fetchFailureReason(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), /connection refused/);
  // No cause at all: the error's own message, as before.
  assert.equal(fetchFailureReason(new Error('plain')), 'plain');
  for (const code of ['ECONNREFUSED', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
    assert.doesNotMatch(fetchFailureReason(undici(code, 'm')), /^fetch failed$/);
  }
});

/** A port nothing listens on: bound, read, closed. */
async function deadPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

test('a feed, a .ics link and CalDAV all name the host and the refused connection', async () => {
  const port = await deadPort();
  const origin = `http://127.0.0.1:${port}`;

  await assert.rejects(
    () => createHttp({ origins: [origin], limits: {} }).get(`${origin}/feed.xml`),
    (err) => {
      assert.match(err.message, new RegExp(`127\\.0\\.0\\.1:${port}`), `the feed's error does not name its host: ${err.message}`);
      assert.match(err.message, /connection refused/);
      return true;
    },
  );
  await assert.rejects(() => fetchIcsText(`${origin}/cal.ics`), /127\.0\.0\.1:\d+ could not be reached: nothing is listening there \(connection refused\)/);
  await assert.rejects(() => discover({ url: `${origin}/dav/` }), (err) => {
    assert.doesNotMatch(err.message, /fetch failed/);
    assert.match(err.message, /connection refused/);
    return true;
  });
});

test('a deadline or a cancel is passed through untouched, for the caller to word', async (t) => {
  const port = await deadPort();
  const origin = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => createHttp({ origins: [origin], limits: {}, signal: controller.signal }).get(`${origin}/feed.xml`),
    (err) => {
      assert.doesNotMatch(err.message, /could not reach/, `a cancel was reworded as a connection failure: ${err.message}`);
      return true;
    },
  );
});
