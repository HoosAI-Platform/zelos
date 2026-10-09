import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, describeRelease, createUpdateChecker, RELEASE_API } from '../core/updates.mjs';

const BASE = 'https://github.com/HoosAI-Platform/zelos';
function release(version = '1.8.0') {
  return {
    tag_name: `v${version}`, html_url: `${BASE}/releases/tag/v${version}`,
    draft: false, prerelease: false, published_at: '2026-09-10T16:00:00Z', body: 'Changes\n\n- A useful fix.',
    assets: [`Zelos-${version}-arm64.dmg`, `Zelos-${version}-x64.dmg`, `Zelos-${version}-setup-x64.exe`, `Zelos-${version}-setup-arm64.exe`].map(name => ({
      name, state: 'uploaded', size: 10000, browser_download_url: `${BASE}/releases/download/v${version}/${name}`,
    })),
  };
}
const response = (data = release()) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('release versions compare numerically and reject ambiguous or prerelease values', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.8.9', '1.9.0'), -1);
  for (const bad of ['v1.8.0', '1.8', '1.8.0-beta', '01.8.0', '1.8.0/path', '999999999999999999.0.0']) {
    assert.throws(() => compareVersions(bad, '1.8.0'), /version/);
  }
});

test('only stable official releases and exact installer destinations are offered', () => {
  const data = release();
  data.assets[0].browser_download_url = 'https://untrusted.example/Zelos.dmg';
  data.assets.push({ ...data.assets[1] });
  const described = describeRelease(data, '1.7.1', '2026-09-10T16:01:00Z');
  assert.equal(described.updateAvailable, true);
  assert.deepEqual(described.downloads.map(d => d.label), ['Windows · most PCs', 'Windows · Arm']);
  assert.equal(describeRelease(release(), '1.9.0').ahead, true);
  assert.equal(describeRelease(release(), '1.8.0').updateAvailable, false);
  for (const patch of [{ draft: true }, { prerelease: true }, { html_url: `${BASE}.evil.example/releases/tag/v1.8.0` }, { published_at: 'invalid' }, { tag_name: 'v1.8.0-beta' }]) {
    assert.throws(() => describeRelease({ ...release(), ...patch }, '1.7.1'));
  }
});

test('constructing a checker makes no request and checks contain no account information', async () => {
  const seen = [];
  const check = createUpdateChecker({ currentVersion: '1.7.1', fetchImpl: async (...args) => { seen.push(args); return response(); } });
  assert.equal(seen.length, 0);
  assert.equal((await check()).latestVersion, '1.8.0');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], RELEASE_API);
  assert.equal(seen[0][1].redirect, 'error');
  assert.deepEqual(seen[0][1].headers, { Accept: 'application/vnd.github+json', 'User-Agent': 'Zelos-update-check' });
  assert.equal(seen[0][1].body, undefined);
});

test('concurrent clicks coalesce and cached results cannot be mutated by callers', async () => {
  let finish, calls = 0, now = 1_000_000;
  const check = createUpdateChecker({ currentVersion: '1.7.1', now: () => now, cacheMs: 100,
    fetchImpl: () => { calls++; return new Promise(resolve => { finish = () => resolve(response()); }); },
  });
  const a = check(), b = check();
  assert.equal(calls, 1);
  finish();
  const [first, second] = await Promise.all([a, b]);
  first.downloads.length = 0;
  assert.equal(second.downloads.length, 4);
  assert.equal((await check()).downloads.length, 4);
  assert.equal(calls, 1);
  now += 101;
  const newer = check(); finish(); await newer;
  assert.equal(calls, 2);
});

test('failed checks remain retryable and never claim the installed app is current', async () => {
  let calls = 0;
  const check = createUpdateChecker({ currentVersion: '1.7.1', fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429 }) : response() });
  await assert.rejects(check(), /limiting update checks/);
  assert.equal((await check()).updateAvailable, true);
});

test('deadline bounds a hung endpoint even when a transport ignores cancellation', async () => {
  let signal;
  const check = createUpdateChecker({ currentVersion: '1.7.1', timeoutMs: 15, fetchImpl: (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(check(), /timed out/);
  assert.equal(signal.aborted, true);
});

test('release responses are bounded even when the server omits Content-Length', async () => {
  let cancelled = false;
  const oversized = () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
    cancel() { cancelled = true; },
  }));
  const check = createUpdateChecker({ currentVersion: '1.7.1', fetchImpl: async () => oversized() });
  await assert.rejects(check(), /too large/);
  assert.equal(cancelled, true);
});

test('malformed release details and a redirected endpoint cannot yield installer links', async () => {
  const malformed = createUpdateChecker({ currentVersion: '1.7.1', fetchImpl: async () => new Response('<html>offline</html>') });
  await assert.rejects(malformed(), /unreadable release details/);
  const redirect = createUpdateChecker({ currentVersion: '1.7.1', fetchImpl: async () => { throw new Error('unexpected redirect'); } });
  await assert.rejects(redirect(), /Could not reach GitHub/);
});
