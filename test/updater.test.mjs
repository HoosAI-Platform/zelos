/**
 * test/updater.test.mjs — the desktop shell's automatic updater.
 *
 * desktop/updater.js takes every effect it has as an argument, so these tests
 * drive the real module through each path — release lookup, the Mac feed
 * check, the Windows download, checksum and signature checks, the install
 * hand-off — with a fake GitHub, a fake Squirrel and a fake PowerShell. No
 * network, no Electron, no signed build.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkMacFeed, createUpdater, downloadToFile, macFeed, openReleaseDownload, parseChecksums,
  PENDING_DIR, readUpdateSettings, signatureMatches, updateAssetNames, writeUpdateSettings,
  CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, RETRY_INTERVAL_MS,
} from '../desktop/updater.js';
import { RELEASE_API, REPOSITORY } from '../core/updates.mjs';

const PUBLISHER = 'Zelos Example Publisher, Ltd';
const TEAM = 'ABCDE12345';
const download = (version, name) => `${REPOSITORY}/releases/download/v${version}/${name}`;
const storage = (name) => `https://release-assets.githubusercontent.com/github-production-release-asset/1/${name}?sig=x`;

/** A small installer and the release that lists it. */
function fixture(version = '1.9.0', { arch = 'x64', installer = crypto.randomBytes(4096) } = {}) {
  const names = {
    installer: `Zelos-${version}-setup-${arch}.exe`,
    zip: `Zelos-${version}-${arch}.zip`,
    feed: `zelos-update-mac-${arch}.json`,
  };
  const feed = Buffer.from(JSON.stringify(macFeed({ version, url: download(version, names.zip), publishedAt: '2026-10-01T00:00:00Z' })));
  const sha = crypto.createHash('sha256').update(installer).digest('hex');
  const sums = Buffer.from(`${sha}  ${names.installer}\n${'0'.repeat(64)}  zelos-source.zip\n`);
  const files = new Map([
    [names.installer, installer],
    [names.zip, Buffer.alloc(2048, 1)],
    [names.feed, feed],
    ['SHA256SUMS.txt', sums],
  ]);
  const release = {
    tag_name: `v${version}`, html_url: `${REPOSITORY}/releases/tag/v${version}`, draft: false, prerelease: false,
    published_at: '2026-10-01T00:00:00Z', body: 'Fixes.',
    assets: [...files].map(([name, bytes]) => ({ name, state: 'uploaded', size: bytes.length, browser_download_url: download(version, name) })),
  };
  return { version, release, files, names, installer, sha };
}

/** GitHub, as far as the updater sees it: the API, then a redirect to storage for each file. */
function fakeGitHub(fx, { override = {} } = {}) {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, options });
    if (override[url]) return override[url](url, options);
    if (url === RELEASE_API) return Response.json(fx.release);
    for (const [name, bytes] of fx.files) {
      if (url === download(fx.version, name)) return new Response(null, { status: 302, headers: { location: storage(name) } });
      if (url === storage(name)) return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, seen };
}

/** Timers that only fire when a test says so. */
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    fire: (ms) => { for (const t of timers.filter((x) => !x.cleared && x.ms === ms)) { t.cleared = true; t.fn(); } },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail(`timed out waiting for ${what}`);
}

let sandbox;
beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-updater-')); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

function windowsUpdater(fx, overrides = {}) {
  const github = fakeGitHub(fx, overrides.github);
  const timers = fakeTimers();
  const launched = [];
  const signatures = [];
  const states = [];
  const updater = createUpdater({
    currentVersion: '1.8.1', platform: 'win32', arch: 'x64', isPackaged: true,
    settingsFile: path.join(sandbox, 'updates.json'),
    downloadDir: path.join(sandbox, PENDING_DIR),
    signing: { windowsPublisher: PUBLISHER },
    windows: {
      verifySignature: async (file) => { signatures.push(file); await overrides.duringVerify?.(); return overrides.signature ?? { status: 'Valid', publisher: PUBLISHER }; },
      launchInstaller: (file, onError) => { launched.push(file); overrides.onLaunch?.(onError); },
    },
    fetchImpl: github.fetchImpl, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    onChange: (state) => states.push(state),
    ...overrides.deps,
  });
  return { updater, github, timers, launched, signatures, states };
}

function macUpdater(fx, overrides = {}) {
  const github = fakeGitHub(fx, overrides.github);
  const timers = fakeTimers();
  const squirrel = Object.assign(new EventEmitter(), {
    feeds: [], checks: 0, installs: 0,
    setFeedURL(options) { this.feeds.push(options); },
    checkForUpdates() { this.checks++; },
    quitAndInstall() { this.installs++; },
  });
  const updater = createUpdater({
    currentVersion: '1.8.1', platform: 'darwin', arch: 'arm64', isPackaged: true,
    settingsFile: path.join(sandbox, 'updates.json'),
    signing: { macTeamId: TEAM },
    mac: { autoUpdater: squirrel, readTeamId: async () => overrides.team ?? TEAM },
    fetchImpl: github.fetchImpl, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  return { updater, github, timers, squirrel };
}

describe('update settings', () => {
  it('default to automatic, and survive a missing, broken or hostile file', () => {
    const file = path.join(sandbox, 'updates.json');
    assert.deepEqual(readUpdateSettings(file), { auto: true });
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(readUpdateSettings(file), { auto: true });
    fs.writeFileSync(file, JSON.stringify({ auto: 'false', extra: 'ignored' }));
    assert.deepEqual(readUpdateSettings(file), { auto: true }, 'only a real false turns updates off');
    writeUpdateSettings(file, { auto: false, extra: 'dropped' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { auto: false });
    assert.deepEqual(readUpdateSettings(file), { auto: false });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('release files and their checks', () => {
  it('names one set of update files per platform and architecture', () => {
    assert.deepEqual(updateAssetNames('1.9.0', 'darwin', 'arm64'), { feed: 'zelos-update-mac-arm64.json', zip: 'Zelos-1.9.0-arm64.zip' });
    assert.deepEqual(updateAssetNames('1.9.0', 'win32', 'x64'), { installer: 'Zelos-1.9.0-setup-x64.exe', sums: 'SHA256SUMS.txt' });
    assert.equal(updateAssetNames('1.9.0', 'linux', 'x64'), null);
  });

  it('accept a Mac feed only when it names exactly this version and this release\'s ZIP', () => {
    const zipUrl = download('1.9.0', 'Zelos-1.9.0-arm64.zip');
    const good = macFeed({ version: '1.9.0', url: zipUrl, publishedAt: '2026-10-01T00:00:00Z' });
    assert.equal(checkMacFeed(good, { version: '1.9.0', zipUrl }), true);
    assert.equal(checkMacFeed({ ...good, currentRelease: '1.9.1' }, { version: '1.9.0', zipUrl }), false);
    const elsewhere = structuredClone(good);
    elsewhere.releases[0].updateTo.url = 'https://evil.example/Zelos.zip';
    assert.equal(checkMacFeed(elsewhere, { version: '1.9.0', zipUrl }), false);
    const extra = structuredClone(good);
    extra.releases.push({ version: '0.1.0', updateTo: { version: '0.1.0', url: 'https://evil.example/old.zip' } });
    assert.equal(checkMacFeed(extra, { version: '1.9.0', zipUrl }), false, 'a second entry pointing elsewhere is refused');
    for (const bad of [null, 'text', {}, { currentRelease: '1.9.0' }, { currentRelease: '1.9.0', releases: [] }]) {
      assert.equal(checkMacFeed(bad, { version: '1.9.0', zipUrl }), false);
    }
  });

  it('read checksum lines the way sha256sum writes them, first entry wins', () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64);
    const sums = parseChecksums(`${a}  one.exe\r\n${b} *two.zip\nnot a line\n${b}  one.exe\n${'A'.repeat(64)}  upper.exe\n`);
    assert.equal(sums.get('one.exe'), a);
    assert.equal(sums.get('two.zip'), b);
    assert.equal(sums.has('upper.exe'), false);
    assert.equal(sums.size, 2);
  });

  it('trust only a Valid signature whose publisher name is exactly the configured one', () => {
    assert.equal(signatureMatches({ status: 'Valid', publisher: 'Example, Ltd' }, 'Example, Ltd'), true);
    for (const publisher of ['Example, Ltd Evil', 'example, ltd', ' Example, Ltd', '', undefined]) {
      assert.equal(signatureMatches({ status: 'Valid', publisher }, 'Example, Ltd'), false, String(publisher));
    }
    for (const status of ['NotSigned', 'HashMismatch', 'UnknownError', 'NotTrusted', '']) {
      assert.equal(signatureMatches({ status, publisher: 'Example, Ltd' }, 'Example, Ltd'), false, status);
    }
    assert.equal(signatureMatches({ status: 'Valid', publisher: '' }, ''), false, 'no configured publisher, no match');
    assert.equal(signatureMatches(null, 'Example, Ltd'), false);
  });
});

describe('release downloads', () => {
  it('start only at this repository\'s release downloads and follow redirects only to GitHub', async () => {
    const fx = fixture();
    const { fetchImpl, seen } = fakeGitHub(fx);
    const response = await openReleaseDownload(download(fx.version, 'SHA256SUMS.txt'), { fetchImpl });
    assert.match(await response.text(), /Zelos-1\.9\.0-setup-x64\.exe/);
    assert.equal(seen[0].options.redirect, 'manual');
    assert.equal(seen[1].url, storage('SHA256SUMS.txt'));

    for (const url of ['https://github.com/someone-else/zelos/releases/download/v1.9.0/x.exe',
      'http://github.com/HoosAI-Platform/zelos/releases/download/v1.9.0/x.exe', 'https://evil.example/x', 42]) {
      await assert.rejects(openReleaseDownload(url, { fetchImpl }), /could not be verified/);
    }
    const bounce = (location) => async () => new Response(null, { status: 302, headers: { location } });
    for (const location of ['https://evil.example/x.exe', 'http://objects.githubusercontent.com/x', 'https://user:pw@github.com/x',
      'https://objects.githubusercontent.com.evil.example/x', 'https://github.com:8443/x', 'javascript:alert(1)', '']) {
      const evil = fakeGitHub(fx, { override: { [download(fx.version, 'SHA256SUMS.txt')]: bounce(location) } });
      await assert.rejects(openReleaseDownload(download(fx.version, 'SHA256SUMS.txt'), { fetchImpl: evil.fetchImpl }), /redirected somewhere unexpected/, location);
      assert.equal(evil.seen.length, 1, `${location} must not be contacted`);
    }
    const loop = async () => new Response(null, { status: 302, headers: { location: download(fx.version, 'SHA256SUMS.txt') } });
    await assert.rejects(openReleaseDownload(download(fx.version, 'SHA256SUMS.txt'), { fetchImpl: loop }), /too many times/);
  });

  it('write a file only when it arrives whole, at exactly the listed size', async () => {
    const fx = fixture();
    const { fetchImpl } = fakeGitHub(fx);
    const file = path.join(sandbox, 'dl', 'installer.exe');
    const url = download(fx.version, fx.names.installer);
    const progress = [];
    const digest = await downloadToFile(url, file, { fetchImpl, expectedSize: fx.installer.length, onProgress: (p) => progress.push(p) });
    assert.equal(digest, fx.sha);
    assert.deepEqual(fs.readFileSync(file), fx.installer);
    assert.equal(progress.at(-1), 1);
    assert.equal(fs.existsSync(`${file}.partial`), false);

    fs.rmSync(file);
    await assert.rejects(downloadToFile(url, file, { fetchImpl, expectedSize: fx.installer.length + 1 }), /unexpected size/);
    await assert.rejects(downloadToFile(url, file, { fetchImpl, expectedSize: fx.installer.length - 1 }), /unexpected size/);
    // A body longer than its declared length, and one cut short with no length at all.
    const liar = fakeGitHub(fx, { override: { [storage(fx.names.installer)]: async () => new Response(Buffer.concat([fx.installer, Buffer.alloc(10)])) } });
    await assert.rejects(downloadToFile(url, file, { fetchImpl: liar.fetchImpl, expectedSize: fx.installer.length }), /unexpected size/);
    const short = fakeGitHub(fx, { override: { [storage(fx.names.installer)]: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(fx.installer.subarray(0, 100)); controller.close(); },
    })) } });
    await assert.rejects(downloadToFile(url, file, { fetchImpl: short.fetchImpl, expectedSize: fx.installer.length }), /incomplete/);
    assert.equal(fs.existsSync(file), false, 'nothing that looks finished is left behind');
    assert.equal(fs.existsSync(`${file}.partial`), false);
    for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, undefined]) {
      await assert.rejects(downloadToFile(url, file, { fetchImpl, expectedSize: size }), /unexpected size/);
    }
  });

  it('abandon a download that stops sending', async () => {
    const fx = fixture();
    let stallTimer = null;
    const hung = fakeGitHub(fx, { override: { [storage(fx.names.installer)]: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(10)); signal.addEventListener('abort', () => controller.error(new Error('aborted'))); },
    })) } });
    const file = path.join(sandbox, 'dl', 'installer.exe');
    const pending = downloadToFile(download(fx.version, fx.names.installer), file, {
      fetchImpl: hung.fetchImpl, expectedSize: fx.installer.length,
      setTimer: (fn) => { stallTimer = fn; return {}; }, clearTimer: () => {},
    });
    await until(() => stallTimer && hung.seen.length === 2, 'the body to start');
    await settle();
    stallTimer();
    await assert.rejects(pending, /stopped receiving data/);
    assert.equal(fs.existsSync(`${file}.partial`), false);
  });
});

describe('when a build cannot update itself', () => {
  const cases = [
    ['a source checkout', { platform: 'darwin', arch: 'arm64', isPackaged: false, signing: { macTeamId: TEAM } }, /runs from source/],
    ['Linux', { platform: 'linux', arch: 'x64', isPackaged: true }, /Mac and Windows/],
    ['an unsigned Mac build', { platform: 'darwin', arch: 'arm64', isPackaged: true, signing: {} }, /not signed/],
    ['an ad-hoc Mac build', { platform: 'darwin', arch: 'arm64', isPackaged: true, signing: { macTeamId: TEAM }, team: '' }, /not signed/],
    ['another team\'s Mac build', { platform: 'darwin', arch: 'arm64', isPackaged: true, signing: { macTeamId: TEAM }, team: 'ZZZZZ99999' }, /not signed/],
    ['an unsigned Windows build', { platform: 'win32', arch: 'x64', isPackaged: true, signing: {} }, /not signed/],
    ['32-bit Windows', { platform: 'win32', arch: 'ia32', isPackaged: true, signing: { windowsPublisher: PUBLISHER } }, /processor/],
  ];
  for (const [name, opts, reason] of cases) {
    it(`stays off for ${name}, says why, and contacts nobody`, async () => {
      const seen = [];
      const timers = fakeTimers();
      const updater = createUpdater({
        currentVersion: '1.8.1', settingsFile: path.join(sandbox, 'updates.json'), downloadDir: path.join(sandbox, PENDING_DIR),
        mac: { autoUpdater: new EventEmitter(), readTeamId: async () => opts.team ?? TEAM },
        windows: { verifySignature: async () => ({}), launchInstaller: () => {} },
        fetchImpl: async (...args) => { seen.push(args); return new Response('', { status: 500 }); },
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        ...opts,
      });
      const state = await updater.start();
      assert.equal(state.supported, false);
      assert.match(state.reason, reason);
      assert.equal(timers.timers.length, 0, 'no schedule is armed');
      assert.equal((await updater.checkNow()).status, 'idle');
      assert.equal(seen.length, 0);
      assert.equal(await updater.prepareInstall(), false);
      assert.equal(updater.install(), false);
    });
  }

  it('refuses a Windows download folder it does not own, because it empties it', () => {
    assert.throws(() => createUpdater({ platform: 'win32', arch: 'x64', isPackaged: true, settingsFile: path.join(sandbox, 'u.json'), downloadDir: sandbox }), /dedicated/);
  });
});

describe('the Windows updater', () => {
  it('downloads, verifies checksum and signature, then hands the exit to the installer', async () => {
    const fx = fixture();
    const h = windowsUpdater(fx);
    await h.updater.start();
    assert.equal(h.github.seen.length, 0, 'starting makes no request');
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    const state = h.updater.state();
    assert.equal(state.latestVersion, '1.9.0');
    assert.equal(state.releaseUrl, `${REPOSITORY}/releases/tag/v1.9.0`);
    assert.ok(h.states.some((s) => s.status === 'downloading'), 'the download reports progress');

    const file = path.join(sandbox, PENDING_DIR, fx.names.installer);
    assert.deepEqual(fs.readFileSync(file), fx.installer);
    assert.deepEqual(h.signatures, [file]);
    assert.deepEqual(h.github.seen.map((s) => s.url).filter((u) => !u.includes('githubusercontent')),
      [RELEASE_API, download('1.9.0', 'SHA256SUMS.txt'), download('1.9.0', fx.names.installer)],
      'only the release record, its checksums and this machine\'s installer are fetched');
    for (const { options } of h.github.seen) assert.equal(options.body, undefined);

    assert.equal(await h.updater.prepareInstall(), true);
    assert.equal(h.signatures.length, 2, 'the signature is checked again before installing');
    assert.equal(h.updater.install(), true);
    assert.deepEqual(h.launched, [file]);
    assert.equal(h.updater.state().status, 'installing');
  });

  it('refuses an installer whose bytes do not match the release checksum', async () => {
    const fx = fixture();
    const tampered = Buffer.from(fx.installer);
    tampered[0] ^= 0xff;
    const h = windowsUpdater(fx, { github: { override: { [storage(fx.names.installer)]: async () => new Response(tampered) } } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'error', 'the refusal');
    assert.match(h.updater.state().error, /checksum/);
    assert.equal(fs.existsSync(path.join(sandbox, PENDING_DIR)), false, 'the refused installer is deleted');
    assert.equal(h.signatures.length, 0);
    assert.equal(h.updater.install(), false);
  });

  for (const [what, signature] of [
    ['an unsigned installer', { status: 'NotSigned', publisher: '' }],
    ['another publisher\'s installer', { status: 'Valid', publisher: 'Someone Else Ltd' }],
    ['a broken signature', { status: 'HashMismatch', publisher: PUBLISHER }],
  ]) {
    it(`refuses ${what}, even when the checksum matches`, async () => {
      const fx = fixture();
      const h = windowsUpdater(fx, { signature });
      await h.updater.start();
      await h.updater.checkNow();
      await until(() => h.updater.state().status === 'error', 'the refusal');
      assert.match(h.updater.state().error, /not signed by the Zelos publisher/);
      assert.equal(fs.existsSync(path.join(sandbox, PENDING_DIR)), false);
      assert.equal(h.updater.install(), false);
      assert.deepEqual(h.launched, []);
    });
  }

  it('refuses an installer the checksum list does not name', async () => {
    const fx = fixture();
    fx.files.set('SHA256SUMS.txt', Buffer.from(`${'1'.repeat(64)}  zelos-source.zip\n`));
    fx.release.assets.find((a) => a.name === 'SHA256SUMS.txt').size = fx.files.get('SHA256SUMS.txt').length;
    const h = windowsUpdater(fx);
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'error', 'the refusal');
    assert.match(h.updater.state().error, /do not list this installer/);
  });

  it('re-checks a waiting installer before restarting, and drops one changed since download', async () => {
    const fx = fixture();
    const h = windowsUpdater(fx);
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    const file = path.join(sandbox, PENDING_DIR, fx.names.installer);
    fs.appendFileSync(file, 'swapped');
    assert.equal(await h.updater.prepareInstall(), false);
    assert.equal(h.updater.state().status, 'error');
    assert.equal(fs.existsSync(file), false);
    assert.equal(h.updater.install(), false);
    assert.deepEqual(h.launched, []);
  });

  it('checks the installer\'s bytes once more in the moment before launching it', async () => {
    const fx = fixture();
    const h = windowsUpdater(fx);
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    assert.equal(await h.updater.prepareInstall(), true);
    // Swapped after the restart was approved, while drafts saved and the core stopped.
    const file = path.join(sandbox, PENDING_DIR, fx.names.installer);
    const swapped = Buffer.from(fx.installer);
    swapped[10] ^= 1;
    fs.writeFileSync(file, swapped);
    const failures = [];
    assert.equal(h.updater.install({ onFailure: (err) => failures.push(err.message) }), false);
    assert.deepEqual(h.launched, []);
    assert.match(failures[0], /changed before it could be installed/);
  });

  it('turning automatic updates off while the signature is being checked drops the download', async () => {
    const fx = fixture();
    let h;
    h = windowsUpdater(fx, { duringVerify: async () => { h.updater.setAuto(false); } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.signatures.length === 1, 'the signature check');
    await settle();
    await settle();
    assert.equal(h.updater.state().status, 'idle', 'never "ready" with nothing behind it');
    assert.equal(fs.existsSync(path.join(sandbox, PENDING_DIR)), false);
    assert.equal(await h.updater.prepareInstall(), false);
  });

  it('gives up on a checksum list that never arrives', async () => {
    const fx = fixture();
    const h = windowsUpdater(fx, { github: { override: { [storage('SHA256SUMS.txt')]: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) } } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.github.seen.some((x) => x.url === storage('SHA256SUMS.txt')), 'the checksum request');
    h.timers.fire(20_000);
    await until(() => h.updater.state().status === 'error', 'the timeout');
    assert.match(h.updater.state().error, /took too long/);
  });

  it('reports an installer that will not start, so the shell can still exit', async () => {
    const fx = fixture();
    const h = windowsUpdater(fx, { onLaunch: (onError) => onError(new Error('spawn EACCES')) });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the download');
    const failures = [];
    assert.equal(h.updater.install({ onFailure: (err) => failures.push(err.message) }), true);
    assert.deepEqual(failures, ['spawn EACCES']);
  });

  it('only offers a stable official release, and never one older or the same', async () => {
    for (const [patch, status] of [[{ prerelease: true }, 'error'], [{ draft: true }, 'error'], [{ html_url: 'https://evil.example/' }, 'error']]) {
      const fx = fixture();
      Object.assign(fx.release, patch);
      const h = windowsUpdater(fx);
      await h.updater.start();
      assert.equal((await h.updater.checkNow()).status, status);
      assert.equal(h.github.seen.length, 1, 'nothing beyond the release record is fetched');
    }
    for (const version of ['1.8.1', '1.8.0']) {
      const h = windowsUpdater(fixture(version));
      await h.updater.start();
      assert.equal((await h.updater.checkNow()).status, 'current');
      assert.equal(h.github.seen.length, 1);
    }
  });

  it('with automatic updates off, a check only reports; a download waits to be asked for', async () => {
    const fx = fixture();
    const h = windowsUpdater(fx);
    await h.updater.start();
    h.updater.setAuto(false);
    assert.deepEqual(readUpdateSettings(path.join(sandbox, 'updates.json')), { auto: false });
    assert.equal((await h.updater.checkNow()).status, 'available');
    assert.equal(h.github.seen.length, 1);
    await h.updater.download();
    await until(() => h.updater.state().status === 'ready', 'the chosen download');
  });

  it('turning automatic updates off stops a download in progress', async () => {
    const fx = fixture();
    let release;
    const h = windowsUpdater(fx, { github: { override: { [storage(fx.names.installer)]: (_url, { signal }) => new Promise((resolve, reject) => {
      release = () => resolve(new Response(fx.installer));
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) } } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => release, 'the installer request');
    h.updater.setAuto(false);
    assert.equal(h.updater.state().status, 'idle');
    await settle();
    assert.notEqual(h.updater.state().status, 'ready');
    assert.equal(h.updater.install(), false);
  });

  it('checks a minute after opening, then on a six-hour clock that survives sleep, backing off after failure', async () => {
    let now = 1_000_000;
    const fx = fixture('1.8.1');
    const h = windowsUpdater(fx, { deps: { now: () => now } });
    await h.updater.start();
    assert.equal(h.github.seen.length, 0);
    h.timers.fire(FIRST_CHECK_DELAY_MS);
    await until(() => h.updater.state().status === 'current', 'the launch check');
    assert.equal(h.github.seen.length, 1);

    const tick = () => h.timers.timers.find((t) => !t.cleared && t.ms !== FIRST_CHECK_DELAY_MS && t.ms > 30_000);
    tick().fn();
    await settle();
    assert.equal(h.github.seen.length, 1, 'not again before six hours');
    now += CHECK_INTERVAL_MS;
    tick().fn();
    await until(() => h.github.seen.length === 2 && h.updater.state().status === 'current', 'the six-hourly check');

    // A failure retries after an hour, not six — and not on every tick.
    fx.release.prerelease = true;
    now += CHECK_INTERVAL_MS;
    tick().fn();
    await until(() => h.updater.state().status === 'error', 'the failed check');
    const failedAt = h.github.seen.length;
    now += RETRY_INTERVAL_MS - 1;
    tick().fn();
    await settle();
    assert.equal(h.github.seen.length, failedAt);
    now += 1;
    tick().fn();
    await until(() => h.github.seen.length === failedAt + 1, 'the retry');

    // Off means the clock never reaches GitHub, however long it runs.
    h.updater.setAuto(false);
    now += CHECK_INTERVAL_MS * 10;
    tick().fn();
    await settle();
    assert.equal(h.github.seen.length, failedAt + 1);
  });

  it('stop() ends the schedule and an in-flight download', async () => {
    const fx = fixture();
    let aborted = false;
    let requested = false;
    const h = windowsUpdater(fx, { github: { override: { [storage(fx.names.installer)]: (_url, { signal }) => new Promise((_resolve, reject) => {
      requested = true;
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }) } } });
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => requested, 'the installer request');
    h.updater.stop();
    await settle();
    assert.equal(aborted, true);
    await until(() => h.timers.timers.every((t) => t.cleared), 'every timer to be cleared');
    assert.notEqual(h.updater.state().status, 'ready');
  });
});

describe('the Mac updater', () => {
  it('verifies the release\'s feed but leaves Squirrel alone until the person chooses to restart', async () => {
    const fx = fixture('1.9.0', { arch: 'arm64' });
    const h = macUpdater(fx);
    assert.equal((await h.updater.start()).supported, true);
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the feed check');
    // Squirrel installs anything it has downloaded at the next quit, so a
    // background check must never reach it.
    assert.equal(h.squirrel.feeds.length, 0);
    assert.equal(h.squirrel.checks, 0);
    assert.ok(!h.github.seen.some((x) => x.url.includes('.zip')), 'the ZIP is Squirrel\'s to download, not ours');

    const preparing = h.updater.prepareInstall();
    await settle();
    assert.deepEqual(h.squirrel.feeds, [{ url: download('1.9.0', 'zelos-update-mac-arm64.json'), serverType: 'json' }]);
    assert.equal(h.squirrel.checks, 1);
    assert.equal(h.updater.state().status, 'downloading');
    h.squirrel.emit('update-downloaded');
    assert.equal(await preparing, true);
    assert.equal(h.updater.state().status, 'ready');
    // The restart was cancelled (drafts would not save) and is asked for again.
    assert.equal(await h.updater.prepareInstall(), true);
    assert.equal(h.squirrel.checks, 1, 'Squirrel already holds the update; it is not asked twice');
    assert.equal(h.updater.install(), true);
    assert.equal(h.squirrel.installs, 1);
  });

  it('a Squirrel refusal at restart is reported, and the exit still happens if it refuses during install', async () => {
    const fx = fixture('1.9.0', { arch: 'arm64' });
    const h = macUpdater(fx);
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the feed check');
    const preparing = h.updater.prepareInstall();
    await settle();
    h.squirrel.emit('error', new Error('Code signature did not pass validation'));
    assert.equal(await preparing, false);
    assert.equal(h.updater.state().status, 'error');
    assert.match(h.updater.state().error, /Code signature did not pass validation/);
    assert.equal(h.updater.install(), false);

    const again = macUpdater(fx);
    await again.updater.start();
    await again.updater.checkNow();
    await until(() => again.updater.state().status === 'ready', 'the feed check');
    const ok = again.updater.prepareInstall();
    await settle();
    again.squirrel.emit('update-downloaded');
    assert.equal(await ok, true);
    const failures = [];
    assert.equal(again.updater.install({ onFailure: (err) => failures.push(err.message) }), true);
    again.squirrel.emit('error', new Error('could not relaunch'));
    assert.deepEqual(failures, ['could not relaunch']);
  });

  it('a chosen restart cannot be called off by the switch, doubled, or timed out while Squirrel downloads', async () => {
    const fx = fixture('1.9.0', { arch: 'arm64' });
    const h = macUpdater(fx);
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'ready', 'the feed check');
    const first = h.updater.prepareInstall();
    await settle();
    h.updater.setAuto(false);
    assert.equal(h.updater.state().status, 'downloading', 'Squirrel is still downloading; the panel must say so');
    assert.equal((await h.updater.checkNow()).status, 'downloading', 'no second feed check while it runs');
    assert.equal(await h.updater.prepareInstall(), false, 'a second restart does not replace the first');
    for (const t of [...h.timers.timers]) if (!t.cleared && t.ms > 60_000) t.fn();
    await settle();
    assert.equal(h.updater.state().status, 'downloading', 'no deadline fires on a download Squirrel will finish anyway');
    h.squirrel.emit('update-downloaded');
    assert.equal(await first, true);
    assert.equal(h.squirrel.checks, 1);
  });

  it('never hands Squirrel a feed that names another file or another version', async () => {
    for (const mutate of [
      (feed) => { feed.releases[0].updateTo.url = 'https://evil.example/Zelos.zip'; },
      (feed) => { feed.currentRelease = '9.9.9'; },
      (feed) => { feed.releases[0].updateTo.url = download('1.9.0', 'Zelos-1.9.0-x64.zip'); },
    ]) {
      const fx = fixture('1.9.0', { arch: 'arm64' });
      const feed = JSON.parse(fx.files.get(fx.names.feed));
      mutate(feed);
      fx.files.set(fx.names.feed, Buffer.from(JSON.stringify(feed)));
      fx.release.assets.find((a) => a.name === fx.names.feed).size = fx.files.get(fx.names.feed).length;
      const h = macUpdater(fx);
      await h.updater.start();
      await h.updater.checkNow();
      await until(() => h.updater.state().status === 'error', 'the refusal');
      assert.match(h.updater.state().error, /feed could not be verified/);
      assert.equal(await h.updater.prepareInstall(), false);
      assert.equal(h.squirrel.feeds.length, 0);
    }
  });

  it('reports a release with no Mac update files instead of guessing', async () => {
    const fx = fixture('1.9.0', { arch: 'arm64' });
    fx.release.assets = fx.release.assets.filter((a) => !a.name.endsWith('.zip'));
    const h = macUpdater(fx);
    await h.updater.start();
    await h.updater.checkNow();
    await until(() => h.updater.state().status === 'error', 'the refusal');
    assert.match(h.updater.state().error, /no automatic update for this Mac/);
    assert.equal(h.squirrel.feeds.length, 0);
  });
});
